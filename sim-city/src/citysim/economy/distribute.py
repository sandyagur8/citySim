"""Bridge from Python economy → TypeScript token client → Sepolia.

Two top-level entry points:

* ``distribute_initial_savings`` — reads every persona, computes 10% of
  their annual wage, and pays it once. Idempotent via ``persona_balances``
  so a crash mid-run can resume safely.
* ``pay_daily_wages`` — for one sim-day, pays every persona's daily wage.
  Idempotent on ``last_wage_day``.

Both go through the same path:

  1. Build a list of (agent_id, wallet, amount_wei) jobs in Python.
  2. Write to ``$CITYSIM_HOME/jobs_xxx.json`` so the TS helper can read.
  3. Spawn ``tsx axl_integration/simcity_token.ts`` as a subprocess.
  4. Read the results file it writes back.
  5. Record paid rows in ``persona_balances`` keyed by agent_id.

The TS helper signs with the treasury account derived from the same
mnemonic the simulator already uses.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

from citysim.economy.balances import (
    list_for_wage_day,
    list_unpaid_for_initial,
    open_db,
    record_initial_payment,
    record_wage_payment,
)
from citysim.economy.salary import OCCUPATION_BASE_SALARY, daily_wage, initial_savings
from citysim.store import default_home

log = logging.getLogger("citysim.economy")

# Most ERC-20s use 18 decimals, including the live SIMCITY contract.
DEFAULT_TOKEN_DECIMALS = 18


def _to_wei(amount: float, decimals: int = DEFAULT_TOKEN_DECIMALS) -> int:
    """Convert a USD-equivalent float into token base units, integer.

    We round half-down so we never overshoot the treasury balance by a
    rounding fraction across thousands of recipients.
    """
    if amount <= 0:
        return 0
    return int(amount * (10**decimals))


def _persona_lookup(con: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    cur = con.execute(
        """
        SELECT agent_id, age, occupation, wallet_address
          FROM personas
         WHERE wallet_address IS NOT NULL AND wallet_address != ''
        """,
    )
    out: dict[str, Any] = {}
    for row in cur.fetchall():
        agent_id, age, occupation, wallet = row
        out[agent_id] = {
            "agent_id": agent_id,
            "age": int(age),
            "occupation": occupation,
            "wallet_address": wallet,
        }
    return out


def _resolve_repo_root() -> Path:
    """Find the citySim parent directory (the one with axl_integration/).

    We look up from this file until we hit a directory containing
    ``axl_integration``. Falls back to env override.
    """
    override = os.environ.get("CITYSIM_REPO_ROOT")
    if override:
        return Path(override)
    here = Path(__file__).resolve()
    for p in [here, *here.parents]:
        if (p / "axl_integration").is_dir():
            return p
    raise RuntimeError(
        "Could not locate citySim repo root (no axl_integration/ found above this file). "
        "Set CITYSIM_REPO_ROOT to override.",
    )


def _run_token_client(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Hand off a transfer batch to ``axl_integration/simcity_token.ts``.

    Returns the parsed result list. Raises on hard failure (process
    couldn't start, output missing). Per-row failures are reflected in
    the result dicts (status='failed' with an 'error' field).
    """
    if not jobs:
        return []
    repo = _resolve_repo_root()
    helper = repo / "axl_integration" / "simcity_token.ts"
    if not helper.exists():
        raise RuntimeError(f"simcity_token.ts not found at {helper}")

    home = default_home()
    home.mkdir(parents=True, exist_ok=True)
    fd_in = tempfile.NamedTemporaryFile(
        prefix="simcity_jobs_", suffix=".json", dir=str(home), delete=False
    )
    fd_out = tempfile.NamedTemporaryFile(
        prefix="simcity_results_", suffix=".json", dir=str(home), delete=False
    )
    fd_in.write(json.dumps(jobs).encode("utf-8"))
    fd_in.close()
    fd_out.close()

    tsx = shutil.which("tsx") or shutil.which("npx")
    if tsx is None:
        raise RuntimeError(
            "Couldn't find tsx or npx on PATH. Install with `npm i -g tsx` "
            "or run `npm install` inside axl_integration/.",
        )
    cmd = (
        [tsx, "tsx", str(helper), fd_in.name, fd_out.name]
        if tsx.endswith("npx")
        else [tsx, str(helper), fd_in.name, fd_out.name]
    )
    log.info("simcity_token.ts: %d jobs", len(jobs))
    proc = subprocess.run(  # noqa: S603
        cmd,
        cwd=str(repo / "axl_integration"),
        capture_output=False,  # let stderr stream live
        check=False,
    )
    try:
        results = json.loads(Path(fd_out.name).read_text(encoding="utf-8"))
    except Exception as e:
        if proc.returncode != 0:
            raise RuntimeError(
                f"simcity_token.ts exited with code {proc.returncode} and "
                f"no parsable output: {e}",
            ) from e
        raise
    return results


# ---------------------------------------------------------------------------
# Initial savings airdrop
# ---------------------------------------------------------------------------


def distribute_initial_savings(
    *,
    db_path: Path | None = None,
    decimals: int = DEFAULT_TOKEN_DECIMALS,
    dry_run: bool = False,
    batch_size: int = 200,
    progress: Callable[[str], None] | None = None,
) -> dict[str, int]:
    """One-shot: pay every persona 10% of their annual wage in SIMCITY.

    Returns a summary dict::

        {
          "personas_total":         5000,
          "already_paid":            120,
          "queued":                 4880,
          "sent":                   4870,
          "failed":                   10,
          "total_wei":  124500000000000000000000  # base units sent
        }
    """
    con = open_db(db_path)
    personas = _persona_lookup(con)
    unpaid = list_unpaid_for_initial(con)
    paid_count = len(personas) - len(unpaid)

    say = progress or (lambda m: log.info(m))
    say(f"personas={len(personas)} already_paid={paid_count} unpaid={len(unpaid)}")

    jobs: list[dict[str, Any]] = []
    skip_zero = 0
    for agent_id, wallet in unpaid:
        p = personas.get(agent_id)
        if p is None:
            continue

        # Synthesise a Persona-shaped object for the salary helpers.
        class _PStub:
            age = int(p["age"])
            occupation = p["occupation"]

        amount = initial_savings(_PStub())  # type: ignore[arg-type]
        wei = _to_wei(amount, decimals=decimals)
        if wei <= 0:
            skip_zero += 1
            # Still record so we don't keep re-checking them.
            record_initial_payment(
                con,
                agent_id=agent_id,
                wallet_address=wallet,
                amount_wei=0,
                tx_hash=None,
            )
            continue
        jobs.append(
            {
                "to": wallet,
                "amount_wei": str(wei),
                "memo": f"initial_savings agent={agent_id}",
                "agent_id": agent_id,
            }
        )

    say(f"queued={len(jobs)} skipped_zero_wage={skip_zero}")

    summary = {
        "personas_total": len(personas),
        "already_paid": paid_count,
        "queued": len(jobs),
        "sent": 0,
        "failed": 0,
        "total_wei": 0,
    }

    if dry_run or not jobs:
        say("dry_run=True, skipping on-chain transfers" if dry_run else "nothing to send")
        return summary

    # Run in batches so a fatal error mid-airdrop doesn't lose progress.
    for start in range(0, len(jobs), batch_size):
        batch = jobs[start : start + batch_size]
        say(f"sending batch {start // batch_size + 1}: {len(batch)} txs")
        results = _run_token_client(batch)
        for r in results:
            if r.get("status") == "sent":
                record_initial_payment(
                    con,
                    agent_id=r.get("agent_id") or "",
                    wallet_address=r["to"],
                    amount_wei=int(r["amount_wei"]),
                    tx_hash=r.get("tx_hash"),
                )
                summary["sent"] += 1
                summary["total_wei"] += int(r["amount_wei"])
            else:
                summary["failed"] += 1
                log.warning(
                    "transfer failed agent=%s err=%s",
                    r.get("agent_id"),
                    r.get("error"),
                )

    say(
        f"done: sent={summary['sent']} failed={summary['failed']} "
        f"total_wei={summary['total_wei']}"
    )
    return summary


# ---------------------------------------------------------------------------
# Daily wages
# ---------------------------------------------------------------------------


def pay_daily_wages(
    sim_day: int,
    *,
    db_path: Path | None = None,
    decimals: int = DEFAULT_TOKEN_DECIMALS,
    dry_run: bool = False,
    batch_size: int = 200,
    progress: Callable[[str], None] | None = None,
) -> dict[str, int]:
    """Pay every persona 1/365th of their annual wage for ``sim_day``.

    Idempotent on ``last_wage_day``: re-running for the same day is a
    no-op. The daily-wage tick-loop hook calls this from a background
    asyncio task so it never blocks the simulator.
    """
    con = open_db(db_path)
    personas = _persona_lookup(con)
    pending = list_for_wage_day(con, sim_day)

    say = progress or (lambda m: log.info(m))
    say(f"sim_day={sim_day} pending={len(pending)}")

    jobs: list[dict[str, Any]] = []
    skip_zero = 0
    for agent_id, wallet in pending:
        p = personas.get(agent_id)
        if p is None:
            continue

        class _PStub:
            age = int(p["age"])
            occupation = p["occupation"]

        amount = daily_wage(_PStub())  # type: ignore[arg-type]
        wei = _to_wei(amount, decimals=decimals)
        if wei <= 0:
            skip_zero += 1
            record_wage_payment(
                con,
                agent_id=agent_id,
                wallet_address=wallet,
                amount_wei=0,
                sim_day=sim_day,
                tx_hash=None,
            )
            continue
        jobs.append(
            {
                "to": wallet,
                "amount_wei": str(wei),
                "memo": f"daily_wage day={sim_day} agent={agent_id}",
                "agent_id": agent_id,
            }
        )

    summary = {
        "sim_day": sim_day,
        "pending": len(pending),
        "queued": len(jobs),
        "sent": 0,
        "failed": 0,
        "skipped_zero_wage": skip_zero,
        "total_wei": 0,
    }

    if dry_run or not jobs:
        say("dry_run=True, skipping on-chain transfers" if dry_run else "nothing to send")
        return summary

    for start in range(0, len(jobs), batch_size):
        batch = jobs[start : start + batch_size]
        say(f"day={sim_day} batch {start // batch_size + 1}: {len(batch)} txs")
        results = _run_token_client(batch)
        for r in results:
            if r.get("status") == "sent":
                record_wage_payment(
                    con,
                    agent_id=r.get("agent_id") or "",
                    wallet_address=r["to"],
                    amount_wei=int(r["amount_wei"]),
                    sim_day=sim_day,
                    tx_hash=r.get("tx_hash"),
                )
                summary["sent"] += 1
                summary["total_wei"] += int(r["amount_wei"])
            else:
                summary["failed"] += 1
                log.warning(
                    "wage transfer failed agent=%s day=%d err=%s",
                    r.get("agent_id"),
                    sim_day,
                    r.get("error"),
                )

    return summary


__all__ = [
    "DEFAULT_TOKEN_DECIMALS",
    "OCCUPATION_BASE_SALARY",
    "distribute_initial_savings",
    "pay_daily_wages",
]

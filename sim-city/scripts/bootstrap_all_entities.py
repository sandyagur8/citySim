#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
AXL_DIR = ROOT.parent / "axl_integration"
STATE_PATH = Path.home() / ".citysim" / "establishments_ens.json"


def run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print("$", " ".join(cmd), flush=True)
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=merged_env)
    if proc.returncode != 0:
        raise SystemExit(proc.returncode)


def run_capture(cmd: list[str], cwd: Path | None = None) -> str:
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True)
    if proc.returncode != 0:
        if proc.stdout:
            print(proc.stdout)
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        raise SystemExit(proc.returncode)
    return proc.stdout


def check_prereqs() -> None:
    if not (ROOT / ".venv").exists():
        raise SystemExit(f"Missing venv: {ROOT / '.venv'}")
    if not AXL_DIR.exists():
        raise SystemExit(f"Missing axl_integration dir: {AXL_DIR}")
    if not (AXL_DIR / "mint_ens_subnames.ts").exists():
        raise SystemExit("Missing mint_ens_subnames.ts")
    if not (AXL_DIR / "set_ens_text_batch.ts").exists():
        raise SystemExit("Missing set_ens_text_batch.ts")
    if not (AXL_DIR / "probe_ens_records.ts").exists():
        raise SystemExit("Missing probe_ens_records.ts")

    mnemonic = os.environ.get("MNEMONIC") or os.environ.get("CITYSIM_WALLET_MNEMONIC")
    if not mnemonic:
        raise SystemExit("Set MNEMONIC or CITYSIM_WALLET_MNEMONIC")


def generate_establishment_rows(grid_size: int, seed: int, max_est_per_kind: int) -> list[dict[str, Any]]:
    from citysim.world.establishments import cap_establishments_per_kind, place_establishments
    from citysim.world.grid import generate_grid
    from citysim.web3.wallets import derive_wallet_address

    mnemonic = os.environ.get("MNEMONIC") or os.environ.get("CITYSIM_WALLET_MNEMONIC") or ""
    base = os.environ.get("CITYSIM_ENS_BASE_DOMAIN", "simcity.eth").strip(".")
    account_group = int(os.environ.get("CITYSIM_ESTABLISHMENT_ACCOUNT_GROUP", "1"))

    grid = generate_grid(size=grid_size, seed=seed)
    ests = place_establishments(grid, seed=seed)
    ests = cap_establishments_per_kind(ests, max_per_kind=max_est_per_kind, seed=seed)

    rows: list[dict[str, Any]] = []
    for est in ests:
        idx = int(est.id[1:]) if est.id.startswith("e") else len(rows)
        label = f"{est.id}.{base}"
        rows.append(
            {
                "entity_id": est.id,
                "entity_type": "establishment",
                "kind": est.kind.value,
                "name": est.name,
                "cell": [int(est.cell[0]), int(est.cell[1])],
                "ens_name": label,
                "wallet_address": derive_wallet_address(mnemonic, idx, account_group=account_group),
                "axl_key": f"est:{est.id}",
                "ens_status": "pending",
                "ens_tx_hash": None,
            }
        )
    return rows


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def mint_establishments(rows: list[dict[str, Any]], batch: int) -> list[dict[str, Any]]:
    pending_idx = [i for i, r in enumerate(rows) if (r.get("ens_status") or "pending") not in ("minted", "active") and r.get("ens_name")]
    if not pending_idx:
        print("Establishments: nothing to mint")
        return rows

    while pending_idx:
        chunk_idx = pending_idx[:batch]
        jobs = [
            {
                "agent_id": rows[i]["entity_id"],
                "ens_name": rows[i]["ens_name"],
                "text_value": rows[i]["wallet_address"] or rows[i]["entity_id"],
            }
            for i in chunk_idx
        ]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as inf:
            json.dump(jobs, inf)
            in_path = Path(inf.name)
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as outf:
            out_path = Path(outf.name)

        print(f"Establishments mint: pending={len(pending_idx)} batch={len(chunk_idx)}")
        run(
            ["npx", "tsx", "mint_ens_subnames.ts", str(in_path), str(out_path)],
            cwd=AXL_DIR,
            env={"ENS_SKIP_PARENT_CHECK": "1"},
        )
        results = read_json(out_path)
        by_id = {r["entity_id"]: r for r in rows}
        for rec in results:
            tgt = by_id.get(rec.get("agent_id"))
            if not tgt:
                continue
            if rec.get("status") == "minted":
                tgt["ens_status"] = "minted"
                tgt["ens_tx_hash"] = rec.get("tx_hash")
            else:
                tgt["ens_status"] = "failed"

        write_json(STATE_PATH, rows)
        pending_idx = [i for i, r in enumerate(rows) if (r.get("ens_status") or "pending") not in ("minted", "active") and r.get("ens_name")]
        time.sleep(0.5)

    return rows


def push_establishment_axl(rows: list[dict[str, Any]], batch: int) -> list[dict[str, Any]]:
    targets = [r for r in rows if r.get("ens_status") in ("minted", "active") and r.get("ens_name") and r.get("axl_key")]
    if not targets:
        print("Establishments: nothing to push")
        return rows

    for i in range(0, len(targets), batch):
        chunk = targets[i : i + batch]
        jobs = [{"agent_id": r["entity_id"], "ens_name": r["ens_name"], "text_value": r["axl_key"]} for r in chunk]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as inf:
            json.dump(jobs, inf)
            in_path = Path(inf.name)
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as outf:
            out_path = Path(outf.name)

        print(f"Establishments text-push: {i + 1}-{i + len(chunk)} / {len(targets)}")
        run(["npx", "tsx", "set_ens_text_batch.ts", str(in_path), str(out_path)], cwd=AXL_DIR)

    return rows


def sync_establishments(rows: list[dict[str, Any]], concurrency: int) -> list[dict[str, Any]]:
    jobs = [
        {
            "agent_id": r["entity_id"],
            "ens_name": r["ens_name"],
            "expected_axl_key": r.get("axl_key") or "",
        }
        for r in rows
        if r.get("ens_name")
    ]
    if not jobs:
        return rows

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as inf:
        json.dump(jobs, inf)
        in_path = Path(inf.name)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as outf:
        out_path = Path(outf.name)

    run(["npx", "tsx", "probe_ens_records.ts", str(in_path), str(out_path), str(max(1, concurrency))], cwd=AXL_DIR)
    result = read_json(out_path)
    by_id = {r["entity_id"]: r for r in rows}
    for rec in result:
        tgt = by_id.get(rec.get("agent_id"))
        if not tgt:
            continue
        if rec.get("error"):
            tgt["ens_status"] = "failed"
        elif rec.get("minted"):
            if rec.get("axl_key_match"):
                tgt["ens_status"] = "active"
            else:
                tgt["ens_status"] = "minted"
            if rec.get("axl_key"):
                tgt["axl_key_onchain"] = rec.get("axl_key")
        else:
            tgt["ens_status"] = "pending"
    write_json(STATE_PATH, rows)
    return rows


def persona_summary() -> None:
    from citysim.store import PersonaStore

    rows = PersonaStore().all()
    c = Counter((r.ens_status or "pending") for r in rows)
    print("Personas ENS status:", dict(c))


def est_summary(rows: list[dict[str, Any]]) -> None:
    c = Counter((r.get("ens_status") or "pending") for r in rows)
    print("Establishments ENS status:", dict(c), "total=", len(rows))
    print("State file:", STATE_PATH)


def main() -> None:
    parser = argparse.ArgumentParser(description="Master bootstrap for personas + establishments ENS + AXL text")
    parser.add_argument("--n-agents", type=int, default=100)
    parser.add_argument("--grid-size", type=int, default=80)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-establishments-per-kind", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--concurrency", type=int, default=20)
    parser.add_argument("--force-regenerate", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    check_prereqs()

    print("[1/5] Persona pipeline (generate + mint + push + sync)")
    cmd = [
        str(ROOT / ".venv" / "bin" / "citysim"),
        "bootstrap-ens",
        "--n-agents",
        str(args.n_agents),
        "--grid-size",
        str(args.grid_size),
        "--seed",
        str(args.seed),
        "--batch-size",
        str(args.batch_size),
    ]
    if not args.force_regenerate:
        cmd.append("--no-force-regenerate")
    run(cmd, cwd=ROOT)

    print("[2/5] Build establishment ENS manifest")
    rows = generate_establishment_rows(
        grid_size=args.grid_size,
        seed=args.seed,
        max_est_per_kind=args.max_establishments_per_kind,
    )
    write_json(STATE_PATH, rows)
    est_summary(rows)

    print("[3/5] Mint establishment ENS")
    rows = mint_establishments(rows, batch=max(1, args.batch_size))
    est_summary(rows)

    print("[4/5] Push establishment axl_key text")
    rows = push_establishment_axl(rows, batch=max(1, args.batch_size))

    print("[5/5] Sync establishment ENS on-chain state")
    rows = sync_establishments(rows, concurrency=max(1, args.concurrency))

    print("\n=== FINAL STATUS ===")
    persona_summary()
    est_summary(rows)


if __name__ == "__main__":
    main()

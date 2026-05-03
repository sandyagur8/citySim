"""SIMCITY balance ledger.

A small SQLite table that records what we've already paid each persona,
so the initial-savings airdrop is resumable across crashes and the daily
wage hook can't double-pay if the tick loop restarts mid-day.

Schema::

    CREATE TABLE persona_balances (
      agent_id          TEXT PRIMARY KEY,
      wallet_address    TEXT,
      initial_paid_wei  TEXT NOT NULL DEFAULT '0',
      initial_tx_hash   TEXT,
      initial_paid_at   TEXT,
      total_wages_wei   TEXT NOT NULL DEFAULT '0',
      last_wage_day     INTEGER NOT NULL DEFAULT -1,
      last_wage_tx_hash TEXT,
      last_wage_at      TEXT
    );

Amounts are stored as decimal strings to dodge SQLite INTEGER's 64-bit
ceiling — token base units (10**18) overflow long before we hit the
billion-token range we're handing out.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from citysim.store import default_home


def default_db_path() -> Path:
    """Reuse the same SQLite file the persona store writes to."""
    return default_home() / "citysim.db"


@dataclass
class Balance:
    agent_id: str
    wallet_address: str | None
    initial_paid_wei: int
    initial_tx_hash: str | None
    initial_paid_at: str | None
    total_wages_wei: int
    last_wage_day: int
    last_wage_tx_hash: str | None
    last_wage_at: str | None


def ensure_schema(con: sqlite3.Connection) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS persona_balances (
          agent_id          TEXT PRIMARY KEY,
          wallet_address    TEXT,
          initial_paid_wei  TEXT NOT NULL DEFAULT '0',
          initial_tx_hash   TEXT,
          initial_paid_at   TEXT,
          total_wages_wei   TEXT NOT NULL DEFAULT '0',
          last_wage_day     INTEGER NOT NULL DEFAULT -1,
          last_wage_tx_hash TEXT,
          last_wage_at      TEXT
        )
        """
    )
    con.commit()


def open_db(path: Path | None = None) -> sqlite3.Connection:
    p = path or default_db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p)
    ensure_schema(con)
    return con


def get_balance(con: sqlite3.Connection, agent_id: str) -> Balance | None:
    cur = con.execute(
        """
        SELECT agent_id, wallet_address, initial_paid_wei, initial_tx_hash,
               initial_paid_at, total_wages_wei, last_wage_day,
               last_wage_tx_hash, last_wage_at
          FROM persona_balances
         WHERE agent_id = ?
        """,
        (agent_id,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return Balance(
        agent_id=row[0],
        wallet_address=row[1],
        initial_paid_wei=int(row[2] or "0"),
        initial_tx_hash=row[3],
        initial_paid_at=row[4],
        total_wages_wei=int(row[5] or "0"),
        last_wage_day=int(row[6] or -1),
        last_wage_tx_hash=row[7],
        last_wage_at=row[8],
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_initial_payment(
    con: sqlite3.Connection,
    *,
    agent_id: str,
    wallet_address: str,
    amount_wei: int,
    tx_hash: str | None,
) -> None:
    con.execute(
        """
        INSERT INTO persona_balances
          (agent_id, wallet_address, initial_paid_wei, initial_tx_hash, initial_paid_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          wallet_address  = excluded.wallet_address,
          initial_paid_wei = excluded.initial_paid_wei,
          initial_tx_hash  = excluded.initial_tx_hash,
          initial_paid_at  = excluded.initial_paid_at
        """,
        (agent_id, wallet_address, str(amount_wei), tx_hash, _now_iso()),
    )
    con.commit()


def record_wage_payment(
    con: sqlite3.Connection,
    *,
    agent_id: str,
    wallet_address: str,
    amount_wei: int,
    sim_day: int,
    tx_hash: str | None,
) -> None:
    """Atomically bump total_wages and stamp last_wage_day for one persona."""
    cur = con.execute(
        "SELECT total_wages_wei FROM persona_balances WHERE agent_id = ?",
        (agent_id,),
    )
    row = cur.fetchone()
    prev = int(row[0]) if row and row[0] else 0
    new_total = prev + amount_wei
    con.execute(
        """
        INSERT INTO persona_balances
          (agent_id, wallet_address, total_wages_wei,
           last_wage_day, last_wage_tx_hash, last_wage_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          wallet_address     = excluded.wallet_address,
          total_wages_wei    = excluded.total_wages_wei,
          last_wage_day      = excluded.last_wage_day,
          last_wage_tx_hash  = excluded.last_wage_tx_hash,
          last_wage_at       = excluded.last_wage_at
        """,
        (
            agent_id,
            wallet_address,
            str(new_total),
            sim_day,
            tx_hash,
            _now_iso(),
        ),
    )
    con.commit()


def list_unpaid_for_initial(
    con: sqlite3.Connection,
    persona_db_path: Path | None = None,
) -> list[tuple[str, str]]:
    """Return [(agent_id, wallet_address), …] for personas who haven't
    yet received their initial-savings airdrop. Joins against the live
    ``personas`` table to skip anyone without a wallet.
    """
    rows = con.execute(
        """
        SELECT p.agent_id, p.wallet_address
          FROM personas p
          LEFT JOIN persona_balances b ON b.agent_id = p.agent_id
         WHERE p.wallet_address IS NOT NULL
           AND p.wallet_address != ''
           AND COALESCE(b.initial_paid_wei, '0') = '0'
        """,
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def list_for_wage_day(
    con: sqlite3.Connection,
    sim_day: int,
) -> list[tuple[str, str]]:
    """Return [(agent_id, wallet_address), …] for personas who haven't
    yet been paid for ``sim_day``. Allows the daily-wage hook to skip
    re-paying after a restart.
    """
    rows = con.execute(
        """
        SELECT p.agent_id, p.wallet_address
          FROM personas p
          LEFT JOIN persona_balances b ON b.agent_id = p.agent_id
         WHERE p.wallet_address IS NOT NULL
           AND p.wallet_address != ''
           AND COALESCE(b.last_wage_day, -1) < ?
        """,
        (sim_day,),
    ).fetchall()
    return [(r[0], r[1]) for r in rows]

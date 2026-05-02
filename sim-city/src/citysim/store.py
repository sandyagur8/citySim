"""Storage seam for the simulator.

Two stores live here:

* ``PersonaStore`` — SQLite-backed, one row per agent. Persists personas
  across server restarts so we don't regenerate 10k+ agents on every boot,
  and so the simulation can query by segment (occupation, income band,
  household, etc.). At Phase 2+ scale this swaps to Postgres + pgvector
  without changing call-sites.

* ``EventLog`` — append-only JSONL on disk, one file per simulated day.
  Every dialogue turn, exposure, and outcome lands here. DuckDB reads
  JSONL natively so analytics is just ``SELECT … FROM read_json_auto(…)``.
  This file format upgrades to Parquet later by changing the writer only;
  reads stay as DuckDB queries.

Both stores are stdlib-only (sqlite3 + json) so the prototype has zero
extra runtime dependencies.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Location resolution: $CITYSIM_HOME, else ~/.citysim
# ---------------------------------------------------------------------------


def default_home() -> Path:
    home = os.environ.get("CITYSIM_HOME")
    if home:
        return Path(home).expanduser()
    return Path.home() / ".citysim"


def default_db_path() -> Path:
    return default_home() / "citysim.db"


def default_events_dir() -> Path:
    return default_home() / "events"


# ---------------------------------------------------------------------------
# Persona store
# ---------------------------------------------------------------------------

PERSONA_SCHEMA = """
CREATE TABLE IF NOT EXISTS personas (
    agent_id        TEXT PRIMARY KEY,
    seed            INTEGER NOT NULL,
    -- demographics
    age             INTEGER NOT NULL,
    gender          TEXT NOT NULL,
    education       TEXT NOT NULL,
    income_band     TEXT NOT NULL,
    occupation      TEXT NOT NULL,
    employer_id     TEXT,
    -- household
    household_id    TEXT NOT NULL,
    household_role  TEXT NOT NULL,
    -- spatial
    home_x          INTEGER NOT NULL,
    home_y          INTEGER NOT NULL,
    work_x          INTEGER,
    work_y          INTEGER,
    mode            TEXT NOT NULL,
    -- rich fields stored as JSON blobs
    needs_json      TEXT NOT NULL,
    prefs_json      TEXT NOT NULL,
    card_text       TEXT NOT NULL,
    ens_name        TEXT,
    wallet_address  TEXT,
    axl_key         TEXT,
    ens_status      TEXT DEFAULT 'pending',
    ens_tx_hash     TEXT
);

CREATE INDEX IF NOT EXISTS idx_personas_household  ON personas(household_id);
CREATE INDEX IF NOT EXISTS idx_personas_employer   ON personas(employer_id);
CREATE INDEX IF NOT EXISTS idx_personas_occupation ON personas(occupation);
CREATE INDEX IF NOT EXISTS idx_personas_income     ON personas(income_band);

CREATE TABLE IF NOT EXISTS world_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


@dataclass
class PersonaRow:
    """A flat record for round-tripping personas through SQLite.

    Mirrors the columns above. JSON fields (needs, prefs) are dicts
    here and serialised on write / parsed on read.
    """

    agent_id: str
    seed: int
    age: int
    gender: str
    education: str
    income_band: str
    occupation: str
    employer_id: str | None
    household_id: str
    household_role: str
    home_x: int
    home_y: int
    work_x: int | None
    work_y: int | None
    mode: str
    needs: dict[str, float]
    prefs: dict[str, Any]
    card_text: str
    ens_name: str | None = None
    wallet_address: str | None = None
    axl_key: str | None = None
    ens_status: str = "pending"
    ens_tx_hash: str | None = None

    def to_db(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "seed": self.seed,
            "age": self.age,
            "gender": self.gender,
            "education": self.education,
            "income_band": self.income_band,
            "occupation": self.occupation,
            "employer_id": self.employer_id,
            "household_id": self.household_id,
            "household_role": self.household_role,
            "home_x": self.home_x,
            "home_y": self.home_y,
            "work_x": self.work_x,
            "work_y": self.work_y,
            "mode": self.mode,
            "needs_json": json.dumps(self.needs, separators=(",", ":")),
            "prefs_json": json.dumps(self.prefs, separators=(",", ":")),
            "card_text": self.card_text,
            "ens_name": self.ens_name,
            "wallet_address": self.wallet_address,
            "axl_key": self.axl_key,
            "ens_status": self.ens_status,
            "ens_tx_hash": self.ens_tx_hash,
        }

    @classmethod
    def from_db(cls, row: sqlite3.Row) -> PersonaRow:
        return cls(
            agent_id=row["agent_id"],
            seed=row["seed"],
            age=row["age"],
            gender=row["gender"],
            education=row["education"],
            income_band=row["income_band"],
            occupation=row["occupation"],
            employer_id=row["employer_id"],
            household_id=row["household_id"],
            household_role=row["household_role"],
            home_x=row["home_x"],
            home_y=row["home_y"],
            work_x=row["work_x"],
            work_y=row["work_y"],
            mode=row["mode"],
            needs=json.loads(row["needs_json"]),
            prefs=json.loads(row["prefs_json"]),
            card_text=row["card_text"],
            ens_name=row["ens_name"],
            wallet_address=row["wallet_address"],
            axl_key=row["axl_key"],
            ens_status=row["ens_status"] or "pending",
            ens_tx_hash=row["ens_tx_hash"],
        )


class PersonaStore:
    """SQLite wrapper. Threadsafe via a lock; perf is fine up to ~1M rows."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else default_db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as c:
            c.executescript(PERSONA_SCHEMA)
            self._ensure_schema_migrations(c)

    def _ensure_schema_migrations(self, c: sqlite3.Connection) -> None:
        # Backward-compatible local migrations for existing prototype DBs.
        cols = {
            r["name"]
            for r in c.execute("PRAGMA table_info(personas)").fetchall()
        }
        if "ens_name" not in cols:
            c.execute("ALTER TABLE personas ADD COLUMN ens_name TEXT")
        if "wallet_address" not in cols:
            c.execute("ALTER TABLE personas ADD COLUMN wallet_address TEXT")
        if "ens_status" not in cols:
            c.execute("ALTER TABLE personas ADD COLUMN ens_status TEXT DEFAULT 'pending'")
        if "ens_tx_hash" not in cols:
            c.execute("ALTER TABLE personas ADD COLUMN ens_tx_hash TEXT")
        if "axl_key" not in cols:
            c.execute("ALTER TABLE personas ADD COLUMN axl_key TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS idx_personas_ens_name ON personas(ens_name)")

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # check_same_thread=False because the FastAPI worker may hop threads.
        c = sqlite3.connect(self.path, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode = WAL")
        c.execute("PRAGMA synchronous = NORMAL")
        try:
            yield c
            c.commit()
        finally:
            c.close()

    # ----- counts / clears -------------------------------------------------

    def count(self) -> int:
        with self._connect() as c:
            return int(c.execute("SELECT COUNT(*) FROM personas").fetchone()[0])

    def clear(self) -> None:
        with self._connect() as c:
            c.execute("DELETE FROM personas")
            c.execute("DELETE FROM world_meta")

    # ----- writes ----------------------------------------------------------

    def insert_many(self, rows: Iterable[PersonaRow]) -> int:
        payload = [r.to_db() for r in rows]
        if not payload:
            return 0
        sql = """
        INSERT OR REPLACE INTO personas
          (agent_id, seed, age, gender, education, income_band, occupation,
           employer_id, household_id, household_role, home_x, home_y,
           work_x, work_y, mode, needs_json, prefs_json, card_text,
           ens_name, wallet_address, axl_key, ens_status, ens_tx_hash)
        VALUES
           (:agent_id, :seed, :age, :gender, :education, :income_band, :occupation,
           :employer_id, :household_id, :household_role, :home_x, :home_y,
           :work_x, :work_y, :mode, :needs_json, :prefs_json, :card_text,
           :ens_name, :wallet_address, :axl_key, :ens_status, :ens_tx_hash)
        """
        with self._lock, self._connect() as c:
            c.executemany(sql, payload)
        return len(payload)

    # ----- reads -----------------------------------------------------------

    def all(self) -> list[PersonaRow]:
        with self._connect() as c:
            rows = c.execute("SELECT * FROM personas ORDER BY agent_id").fetchall()
        return [PersonaRow.from_db(r) for r in rows]

    def get(self, agent_id: str) -> PersonaRow | None:
        with self._connect() as c:
            r = c.execute("SELECT * FROM personas WHERE agent_id=?", (agent_id,)).fetchone()
        return PersonaRow.from_db(r) if r else None

    def by_segment(
        self,
        *,
        occupation: str | None = None,
        income_band: str | None = None,
        min_age: int | None = None,
        max_age: int | None = None,
        limit: int | None = None,
    ) -> list[PersonaRow]:
        clauses: list[str] = []
        params: list[Any] = []
        if occupation:
            clauses.append("occupation = ?")
            params.append(occupation)
        if income_band:
            clauses.append("income_band = ?")
            params.append(income_band)
        if min_age is not None:
            clauses.append("age >= ?")
            params.append(min_age)
        if max_age is not None:
            clauses.append("age <= ?")
            params.append(max_age)
        sql = "SELECT * FROM personas"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY agent_id"
        if limit:
            sql += f" LIMIT {int(limit)}"
        with self._connect() as c:
            rows = c.execute(sql, params).fetchall()
        return [PersonaRow.from_db(r) for r in rows]

    # ----- meta ------------------------------------------------------------

    def get_meta(self, key: str) -> str | None:
        with self._connect() as c:
            r = c.execute("SELECT value FROM world_meta WHERE key=?", (key,)).fetchone()
        return r["value"] if r else None

    def set_meta(self, key: str, value: str) -> None:
        with self._lock, self._connect() as c:
            c.execute(
                "INSERT OR REPLACE INTO world_meta(key, value) VALUES(?, ?)",
                (key, value),
            )


# ---------------------------------------------------------------------------
# Event log (JSONL → DuckDB-readable)
# ---------------------------------------------------------------------------


class EventLog:
    """Append-only event log, one JSONL file per simulated day.

    Each event is a dict; we add a few standard envelope fields (sim_minute,
    day_of_year, kind) and JSON-serialise the rest.
    """

    def __init__(self, dir_path: str | Path | None = None) -> None:
        self.dir = Path(dir_path) if dir_path else default_events_dir()
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path_for(self, day_of_year: int) -> Path:
        return self.dir / f"events-day{day_of_year:04d}.jsonl"

    def append(
        self,
        *,
        kind: str,
        sim_minute: float,
        day_of_year: int,
        payload: dict[str, Any],
    ) -> None:
        record = {
            "kind": kind,
            "sim_minute": sim_minute,
            "day_of_year": day_of_year,
            **payload,
        }
        line = json.dumps(record, separators=(",", ":")) + "\n"
        path = self._path_for(day_of_year)
        with self._lock, path.open("a", encoding="utf-8") as f:
            f.write(line)

    def read_day(self, day_of_year: int) -> list[dict[str, Any]]:
        path = self._path_for(day_of_year)
        if not path.exists():
            return []
        out: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                out.append(json.loads(line))
        return out


__all__ = [
    "EventLog",
    "PersonaRow",
    "PersonaStore",
    "default_db_path",
    "default_events_dir",
    "default_home",
]

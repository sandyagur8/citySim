from __future__ import annotations

import os
from pathlib import Path


def _candidate_env_paths() -> list[Path]:
    cwd_env = Path.cwd() / ".env"
    repo_env = Path(__file__).resolve().parents[3] / ".env"
    return [cwd_env, repo_env]


def load_env_file(*, override: bool = False) -> Path | None:
    """Load .env into os.environ without extra dependencies.

    Search order:
    1) current working directory `.env`
    2) repository `sim-city/.env`
    """
    for path in _candidate_env_paths():
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            key, raw_val = s.split("=", 1)
            key = key.strip()
            val = raw_val.strip().strip("'\"")
            if not key:
                continue
            if override or key not in os.environ:
                os.environ[key] = val
        return path
    return None


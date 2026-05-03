"""SIMCITY token economy: salary model, balance ledger, distribution.

This package owns three concerns:

* ``salary``     - turn (occupation, age) into a dollar-equivalent annual
                   wage, daily wage, and one-time savings figure. Pure
                   read-only; no DB or chain access.
* ``balances``   - SQLite-backed ledger of who's been paid what. Lets the
                   tick-loop daily-wage hook be idempotent, lets the
                   airdrop be resumable, and gives the UI a fast read.
* ``distribute`` - high-level orchestration: read personas, compute owed
                   amounts, hand off to the TS token client, mark the
                   ledger as paid.
"""

from .salary import (
    OCCUPATION_BASE_SALARY,
    age_factor,
    annual_wage,
    daily_wage,
    initial_savings,
)

__all__ = [
    "OCCUPATION_BASE_SALARY",
    "age_factor",
    "annual_wage",
    "daily_wage",
    "initial_savings",
]

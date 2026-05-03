"""Per-persona earnings model.

Maps the (occupation, age) pair of a persona to a USD-equivalent annual
wage, daily wage, and one-time savings cushion. Pure functions — no DB,
no chain, no I/O. The distribution layer wraps these to issue SIMCITY
tokens (``$1 = 1 SIMCITY``).

Salary numbers are anchored in 2024 US Bureau of Labour Statistics
median annual wages per occupation, smoothed and trimmed for round
numbers because we want demoable figures, not five decimals of accuracy.
Sources used:

* doctors / pharmacists - BLS OEWS 29-1xxx codes
* engineers / analysts / designers - BLS OEWS 15-/17-/27-xxxx
* baristas / cooks / cashiers / servers / hosts / clerks / stockers -
  BLS OEWS 35-/41-xxxx (food prep + retail)
* groundskeepers / dispatchers / officers - BLS OEWS 37-/43-/33-xxxx
* managers - BLS OEWS 11-1xxx (general & operations managers)
* students / retired / unemployed / homemaker - explicitly $0 baseline;
  see HOUSEHOLD_SUPPORT_USD if you want to give dependents a
  household-pooled stipend later.

Age curve (a.k.a. ``age_factor``):

* under 16 → 0 (no income, period — fixes the 3-year-old-paycheck bug)
* 16-17    → 25 % (part-time)
* 18-22    → 40 % (entry-level / first jobs)
* 23-34    → linear ramp 60 % → 100 %
* 35-59    → 100 % (peak career)
* 60-67    → linear taper 100 % → 50 %
* 68+      → 50 % (semi-retired floor; "retired" occupation forces 0)

The curve is multiplicative on top of the occupation baseline.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from citysim.world.personas import Persona


# ---------------------------------------------------------------------------
# Occupation baselines (USD/year, full-time-equivalent)
# ---------------------------------------------------------------------------

# Anchored to BLS OEWS May 2024 median wages. Values rounded to nearest
# $1k for legibility.
OCCUPATION_BASE_SALARY: dict[str, float] = {
    # Knowledge work
    "engineer": 110_000,
    "analyst": 78_000,
    "accountant": 79_000,
    "designer": 62_000,
    "tech": 60_000,
    "pharmacist": 132_000,
    # Management
    "manager": 102_000,
    # Retail / hospitality
    "barista": 32_000,
    "server": 33_000,
    "host": 30_000,
    "cashier": 30_000,
    "cook": 36_000,
    "bartender": 35_000,
    "stocker": 33_000,
    "clerk": 39_000,
    "sales_associate": 36_000,
    "teller": 38_000,
    # Trades / services
    "groundskeeper": 38_000,
    "officer": 65_000,
    "dispatch": 47_000,
    # Domestic / non-employed
    "homemaker": 0,
    "student": 0,
    "retired": 0,
    "unemployed": 0,
}

# Optional small "household support" stipend for dependents who otherwise
# get $0. Exposed as a constant rather than baked into salaries so the
# downstream caller can opt in. Currently unused by daily-wage payouts.
HOUSEHOLD_SUPPORT_USD: float = 0.0


# ---------------------------------------------------------------------------
# Age factor
# ---------------------------------------------------------------------------


def age_factor(age: int) -> float:
    """Return the age-adjustment multiplier in [0, 1]."""
    if age < 16:
        return 0.0
    if age < 18:
        return 0.25
    if age < 23:
        return 0.40
    if age < 35:
        # Ramp 60% (age 23) → 100% (age 35) linearly.
        return 0.60 + (age - 23) * (0.40 / 12)
    if age < 60:
        return 1.00
    if age < 68:
        # Taper 100% → 50% from 60 to 67.
        return 1.00 - (age - 60) * (0.50 / 7)
    return 0.50


# ---------------------------------------------------------------------------
# Per-persona earnings
# ---------------------------------------------------------------------------


def annual_wage(persona: "Persona") -> float:
    """Annual income in USD-equivalent SIMCITY for this persona.

    Returns 0.0 for unemployed/retired/homemaker/student personas
    regardless of age (their occupation baseline is $0). Adults working
    a real occupation get ``baseline × age_factor(age)``.
    """
    base = OCCUPATION_BASE_SALARY.get(persona.occupation, 0.0)
    if base <= 0:
        return 0.0
    return base * age_factor(persona.age)


def daily_wage(persona: "Persona") -> float:
    """One sim-day's wage in USD-equivalent SIMCITY (annual / 365)."""
    return annual_wage(persona) / 365.0


def initial_savings(persona: "Persona") -> float:
    """One-time 'starting cash' airdrop = 10% of annual_wage."""
    return annual_wage(persona) * 0.10

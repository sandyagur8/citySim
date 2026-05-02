"""Persona generator: rich agents sampled from a joint distribution.

Replaces the ``agents.py`` stub with a full schema per ``docs/design.md`` §3.
Critically, fields are sampled *conditionally* so we don't get the design
doc's cautionary nightmare of a 23-year-old retired Hindu cardiac surgeon:

    age           ~ population pyramid
    gender        | age
    education     | age, gender
    income_band   | age, education
    occupation    | income_band, education, employers-available
    household     | age (singles young, couples mid, kids middle, retirees solo)
    transport     | income_band, age
    preferences   | age, income_band, education
    needs vector  | household_role, age, income_band
    persona card  | template synthesis of all of the above

We do not call an LLM here. A 200-word persona card is templated from the
structured fields. The design doc's rule: don't burn N LLM calls to make
N personas. Optionally enrich a sample of cards via the LLM gateway later
(e.g. for the ~5% audit slice), but that's a separate pass.

The generator both returns ``Persona`` objects (used to build the runtime
``Agent`` stubs the simulation loop iterates over) and writes ``PersonaRow``
records into ``PersonaStore`` so the personas survive a server restart and
can be queried by segment.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from citysim.store import PersonaRow, PersonaStore
from citysim.world.agents import (
    Agent,
    TransportMode,
    _OCCUPATIONS_BY_KIND,
    _residential_cells,
)
from citysim.world.establishments import Establishment
from citysim.world.grid import CityGrid


# ---------------------------------------------------------------------------
# Categorical levels
# ---------------------------------------------------------------------------

GENDERS = ["female", "male", "nonbinary"]
EDUCATIONS = ["none", "high_school", "some_college", "bachelors", "graduate"]
INCOME_BANDS = ["very_low", "low", "middle", "upper_middle", "high"]

NEED_CATEGORIES = [
    "food",
    "clothing",
    "healthcare",
    "leisure",
    "transport",
    "household_goods",
    "education",
    "social",
]


@dataclass
class Persona:
    """In-memory persona used by the rest of the simulator.

    The simulator's hot loop iterates ``Agent`` (lightweight); the
    ``Persona`` is what the LLM gateway sees when it needs to roleplay
    this person in a dialogue.
    """

    agent_id: str
    age: int
    gender: str
    education: str
    income_band: str
    occupation: str
    employer_id: str | None
    household_id: str
    household_role: str
    home_cell: tuple[int, int]
    work_cell: tuple[int, int] | None
    mode: TransportMode
    needs: dict[str, float] = field(default_factory=dict)
    prefs: dict[str, float | str] = field(default_factory=dict)
    card_text: str = ""

    # ----- bridges ---------------------------------------------------------

    def to_agent(self) -> Agent:
        """Project down to the lightweight ``Agent`` the runtime uses."""
        return Agent(
            id=self.agent_id,
            age=self.age,
            home_cell=self.home_cell,
            work_cell=self.work_cell,
            employer_id=self.employer_id,
            occupation=self.occupation,
            mode=self.mode,
            extra={
                "gender": self.gender,
                "income_band": self.income_band,
                "household_role": self.household_role,
            },
        )

    def to_row(self, seed: int) -> PersonaRow:
        return PersonaRow(
            agent_id=self.agent_id,
            seed=seed,
            age=self.age,
            gender=self.gender,
            education=self.education,
            income_band=self.income_band,
            occupation=self.occupation,
            employer_id=self.employer_id,
            household_id=self.household_id,
            household_role=self.household_role,
            home_x=self.home_cell[0],
            home_y=self.home_cell[1],
            work_x=self.work_cell[0] if self.work_cell else None,
            work_y=self.work_cell[1] if self.work_cell else None,
            mode=self.mode.value,
            needs=self.needs,
            prefs=self.prefs,
            card_text=self.card_text,
        )

    @classmethod
    def from_row(cls, row: PersonaRow) -> Persona:
        return cls(
            agent_id=row.agent_id,
            age=row.age,
            gender=row.gender,
            education=row.education,
            income_band=row.income_band,
            occupation=row.occupation,
            employer_id=row.employer_id,
            household_id=row.household_id,
            household_role=row.household_role,
            home_cell=(row.home_x, row.home_y),
            work_cell=(row.work_x, row.work_y)
            if row.work_x is not None and row.work_y is not None
            else None,
            mode=TransportMode(row.mode),
            needs=dict(row.needs),
            prefs=dict(row.prefs),
            card_text=row.card_text,
        )


# ---------------------------------------------------------------------------
# Conditional samplers
# ---------------------------------------------------------------------------


def _sample_age(rng: np.random.Generator) -> int:
    """Rough US-ish population pyramid: 0-17 23%, 18-64 60%, 65+ 17%."""
    bucket = rng.choice(3, p=[0.23, 0.60, 0.17])
    if bucket == 0:
        return int(rng.integers(0, 18))
    if bucket == 1:
        return int(rng.integers(18, 65))
    return int(rng.integers(65, 92))


def _sample_gender(rng: np.random.Generator, age: int) -> str:
    # Slight skew female with age (longer life expectancy).
    if age >= 75:
        p = [0.55, 0.43, 0.02]
    else:
        p = [0.49, 0.49, 0.02]
    return GENDERS[int(rng.choice(3, p=p))]


def _sample_education(rng: np.random.Generator, age: int) -> str:
    if age < 16:
        return "none"
    if age < 18:
        return "high_school"
    # Adults: education distribution shifts older = slightly less college.
    if age < 30:
        p = [0.05, 0.30, 0.30, 0.27, 0.08]
    elif age < 60:
        p = [0.07, 0.32, 0.25, 0.25, 0.11]
    else:
        p = [0.12, 0.40, 0.20, 0.20, 0.08]
    return EDUCATIONS[int(rng.choice(5, p=p))]


def _sample_income_band(rng: np.random.Generator, age: int, education: str) -> str:
    if age < 18:
        return "very_low"  # represented through the household head's income later
    edu_to_dist = {
        "none": [0.45, 0.35, 0.15, 0.04, 0.01],
        "high_school": [0.20, 0.35, 0.30, 0.12, 0.03],
        "some_college": [0.12, 0.28, 0.35, 0.20, 0.05],
        "bachelors": [0.05, 0.15, 0.30, 0.35, 0.15],
        "graduate": [0.02, 0.08, 0.20, 0.35, 0.35],
    }
    p = edu_to_dist[education]
    # Retirees compress toward middle/low.
    if age >= 65:
        p = [p[0] * 1.4, p[1] * 1.3, p[2] * 1.0, p[3] * 0.7, p[4] * 0.4]
        s = sum(p)
        p = [v / s for v in p]
    return INCOME_BANDS[int(rng.choice(5, p=p))]


def _sample_household_role(rng: np.random.Generator, age: int) -> str:
    if age < 18:
        return "child"
    if age < 25:
        # young-adult: still at home or living solo with roommates
        return str(rng.choice(["partner", "single", "single"]))  # weighted
    if age < 40:
        return str(rng.choice(["single", "partner", "partner", "head_with_kids"]))
    if age < 65:
        return str(rng.choice(["partner", "head_with_kids", "single"]))
    return str(rng.choice(["single", "partner"]))


def _sample_mode(
    rng: np.random.Generator, age: int, income_band: str, employed: bool
) -> TransportMode:
    if age < 16:
        return TransportMode.WALK
    if not employed:
        return TransportMode.WALK if age >= 65 else TransportMode.TRANSIT
    # Probability of car ownership rises with income.
    by_income = {
        "very_low": [0.30, 0.20, 0.45, 0.05],
        "low": [0.20, 0.20, 0.40, 0.20],
        "middle": [0.10, 0.15, 0.30, 0.45],
        "upper_middle": [0.05, 0.10, 0.20, 0.65],
        "high": [0.03, 0.05, 0.12, 0.80],
    }
    p = by_income[income_band]
    options = [TransportMode.WALK, TransportMode.BIKE, TransportMode.TRANSIT, TransportMode.CAR]
    return options[int(rng.choice(4, p=p))]


def _sample_prefs(
    rng: np.random.Generator, age: int, income_band: str, education: str
) -> dict[str, float | str]:
    # All scalars in [0, 1]. The LLM dialogue prompt reads these as
    # narrative levers ("highly novelty-seeking", "brand-loyal", etc.).
    novelty = float(rng.beta(2.0, 3.0))  # younger biased high via offset below
    if age < 30:
        novelty = min(1.0, novelty + 0.15)
    if age >= 60:
        novelty = max(0.0, novelty - 0.15)

    risk_tol = float(rng.beta(2.5, 3.5))
    if income_band in ("upper_middle", "high"):
        risk_tol = min(1.0, risk_tol + 0.1)

    brand_loyalty = float(rng.beta(3.0, 2.5))
    if education in ("bachelors", "graduate"):
        brand_loyalty = max(0.0, brand_loyalty - 0.1)

    price_sensitivity = float(rng.beta(3.0, 2.5))
    if income_band in ("very_low", "low"):
        price_sensitivity = min(1.0, price_sensitivity + 0.2)
    if income_band == "high":
        price_sensitivity = max(0.0, price_sensitivity - 0.25)

    sustainability = float(rng.beta(2.0, 3.0))
    if education in ("bachelors", "graduate") and age < 50:
        sustainability = min(1.0, sustainability + 0.15)

    # A primary value tag — purely narrative, lets dialogue prompts colour
    # the buyer's voice without overloading numeric fields.
    value_tags = [
        "family",
        "career",
        "community",
        "self_expression",
        "health",
        "frugality",
        "status",
        "exploration",
    ]
    value = value_tags[int(rng.integers(0, len(value_tags)))]

    return {
        "novelty_seeking": round(novelty, 3),
        "risk_tolerance": round(risk_tol, 3),
        "brand_loyalty": round(brand_loyalty, 3),
        "price_sensitivity": round(price_sensitivity, 3),
        "sustainability": round(sustainability, 3),
        "primary_value": value,
    }


def _sample_needs(
    rng: np.random.Generator,
    age: int,
    household_role: str,
    income_band: str,
) -> dict[str, float]:
    # Base urgency 0..1. Conditional bumps reflect life stage.
    base = {k: float(rng.beta(2, 5)) for k in NEED_CATEGORIES}
    if household_role == "head_with_kids":
        base["food"] = min(1.0, base["food"] + 0.2)
        base["education"] = min(1.0, base["education"] + 0.25)
        base["household_goods"] = min(1.0, base["household_goods"] + 0.15)
    if age >= 65:
        base["healthcare"] = min(1.0, base["healthcare"] + 0.3)
        base["leisure"] = min(1.0, base["leisure"] + 0.1)
    if age < 25:
        base["leisure"] = min(1.0, base["leisure"] + 0.2)
        base["social"] = min(1.0, base["social"] + 0.2)
    if income_band in ("very_low", "low"):
        base["food"] = min(1.0, base["food"] + 0.1)
    return {k: round(v, 3) for k, v in base.items()}


# ---------------------------------------------------------------------------
# Persona-card template (no LLM)
# ---------------------------------------------------------------------------

EDUCATION_PHRASE = {
    "none": "no formal schooling",
    "high_school": "a high-school diploma",
    "some_college": "some college",
    "bachelors": "a bachelor's degree",
    "graduate": "a graduate degree",
}

INCOME_PHRASE = {
    "very_low": "lives paycheck to paycheck",
    "low": "watches every dollar",
    "middle": "is comfortable but careful",
    "upper_middle": "has real discretionary income",
    "high": "is wealthy by any measure",
}

ROLE_PHRASE = {
    "child": "is still in school and lives with their family",
    "single": "lives alone",
    "partner": "shares a home with a partner",
    "head_with_kids": "is raising children",
}


def _card_text(p: Persona) -> str:
    top_need = max(p.needs.items(), key=lambda kv: kv[1])[0]
    pronoun = {"female": "She", "male": "He", "nonbinary": "They"}[p.gender]
    poss = {"female": "her", "male": "his", "nonbinary": "their"}[p.gender]
    income_phrase = INCOME_PHRASE.get(p.income_band, "")
    edu_phrase = EDUCATION_PHRASE.get(p.education, "")
    role_phrase = ROLE_PHRASE.get(p.household_role, "")
    novelty = p.prefs.get("novelty_seeking", 0.5)
    novelty_phrase = (
        "loves trying new brands"
        if isinstance(novelty, (int, float)) and novelty > 0.65
        else "tends to stick with what works"
    )
    price = p.prefs.get("price_sensitivity", 0.5)
    price_phrase = (
        "always compares prices"
        if isinstance(price, (int, float)) and price > 0.65
        else "will pay for quality"
    )
    value = p.prefs.get("primary_value", "family")

    occ_phrase = p.occupation.replace("_", " ")
    return (
        f"{pronoun} is a {p.age}-year-old {p.gender} {occ_phrase}. "
        f"{pronoun} has {edu_phrase} and {income_phrase}. "
        f"{pronoun} {role_phrase}. "
        f"At the moment, {top_need.replace('_', ' ')} is the most pressing thing on {poss} mind. "
        f"{pronoun} {novelty_phrase} and {price_phrase}. "
        f"What {pronoun.lower()} cares about most: {str(value).replace('_', ' ')}."
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def generate_personas(
    grid: CityGrid,
    establishments: list[Establishment],
    n: int,
    seed: int = 42,
) -> list[Persona]:
    """Sample ``n`` personas with realistic conditional structure.

    The generator picks homes from residential/mixed cells and assigns
    workers to a random employer that hires their occupation class.
    """
    rng = np.random.default_rng(seed)
    homes = _residential_cells(grid)
    if not homes:
        raise ValueError("No residential cells available for homes")
    employers = [e for e in establishments if e.kind in _OCCUPATIONS_BY_KIND]
    if not employers:
        raise ValueError("No employers placed; check establishments")

    # Households share an address. We generate household *anchors* first and
    # bucket personas into them so members co-locate.
    n_households = max(1, int(n / 2.5))
    household_homes = [homes[int(rng.integers(0, len(homes)))] for _ in range(n_households)]
    household_ids = [f"h{i:06d}" for i in range(n_households)]

    personas: list[Persona] = []
    for i in range(n):
        # Pick a household, then a home.
        h_idx = int(rng.integers(0, n_households))
        home = household_homes[h_idx]
        household_id = household_ids[h_idx]

        age = _sample_age(rng)
        gender = _sample_gender(rng, age)
        education = _sample_education(rng, age)
        income_band = _sample_income_band(rng, age, education)
        role = _sample_household_role(rng, age)

        # Employment: realistic employment rates by age band.
        if 22 <= age < 65:
            employed = bool(rng.random() < 0.85)
        elif 18 <= age < 22:
            employed = bool(rng.random() < 0.55)
        elif age >= 65:
            employed = bool(rng.random() < 0.20)
        else:
            employed = False

        if employed:
            employer = employers[int(rng.integers(0, len(employers)))]
            occ_options = _OCCUPATIONS_BY_KIND[employer.kind]
            occupation = occ_options[int(rng.integers(0, len(occ_options)))]
            work_cell: tuple[int, int] | None = employer.cell
            employer_id: str | None = employer.id
        else:
            occupation = (
                "student"
                if age < 22
                else "retired"
                if age >= 65
                else "homemaker"
                if role == "head_with_kids"
                else "unemployed"
            )
            work_cell = None
            employer_id = None

        mode = _sample_mode(rng, age, income_band, employed)
        prefs = _sample_prefs(rng, age, income_band, education)
        needs = _sample_needs(rng, age, role, income_band)

        persona = Persona(
            agent_id=f"a{i:06d}",
            age=age,
            gender=gender,
            education=education,
            income_band=income_band,
            occupation=occupation,
            employer_id=employer_id,
            household_id=household_id,
            household_role=role,
            home_cell=home,
            work_cell=work_cell,
            mode=mode,
            needs=needs,
            prefs=prefs,
        )
        persona.card_text = _card_text(persona)
        personas.append(persona)

    return personas


def load_or_generate_personas(
    grid: CityGrid,
    establishments: list[Establishment],
    n: int,
    seed: int,
    store: PersonaStore,
    *,
    force_regenerate: bool = False,
) -> list[Persona]:
    """Read personas from the store; if missing or stale, regenerate + persist."""
    sig = f"n={n};seed={seed};grid={grid.size}"
    if not force_regenerate:
        existing_sig = store.get_meta("world_signature")
        if existing_sig == sig and store.count() == n:
            return [Persona.from_row(r) for r in store.all()]

    # Wipe and regenerate.
    store.clear()
    personas = generate_personas(grid, establishments, n=n, seed=seed)
    store.insert_many(p.to_row(seed) for p in personas)
    store.set_meta("world_signature", sig)
    store.set_meta("n_agents", str(n))
    return personas


__all__ = [
    "EDUCATIONS",
    "GENDERS",
    "INCOME_BANDS",
    "NEED_CATEGORIES",
    "Persona",
    "generate_personas",
    "load_or_generate_personas",
]

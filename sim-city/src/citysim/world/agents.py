"""Agent generation (mock).

A stub agent has only what the visual layer needs: an id, a home cell, a work
cell (if any), a small set of demographics for display, and a transport mode.
The full persona schema in `docs/design.md` §3 will replace this in the
persona-generator phase.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from citysim.world.establishments import Establishment, EstablishmentKind
from citysim.world.grid import CityGrid, Zoning


class TransportMode(str, Enum):
    WALK = "walk"
    BIKE = "bike"
    TRANSIT = "transit"
    CAR = "car"


# Speed in cells per simulated minute. Tuned so commutes look right at city scale.
MODE_SPEED: dict[TransportMode, float] = {
    TransportMode.WALK: 0.08,
    TransportMode.BIKE: 0.20,
    TransportMode.TRANSIT: 0.35,
    TransportMode.CAR: 0.50,
}


@dataclass
class Agent:
    id: str
    age: int
    home_cell: tuple[int, int]
    work_cell: tuple[int, int] | None
    employer_id: str | None
    occupation: str
    mode: TransportMode
    extra: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "age": self.age,
            "home_cell": list(self.home_cell),
            "work_cell": list(self.work_cell) if self.work_cell else None,
            "employer_id": self.employer_id,
            "occupation": self.occupation,
            "mode": self.mode.value,
        }


_OCCUPATIONS_BY_KIND: dict[EstablishmentKind, list[str]] = {
    EstablishmentKind.OFFICE: ["analyst", "engineer", "designer", "manager", "accountant"],
    EstablishmentKind.SUPERMARKET: ["cashier", "stocker", "manager"],
    EstablishmentKind.COFFEE_SHOP: ["barista", "manager"],
    EstablishmentKind.RESTAURANT: ["server", "cook", "host"],
    EstablishmentKind.PUB: ["bartender", "server"],
    EstablishmentKind.HARDWARE: ["clerk", "manager"],
    EstablishmentKind.PHARMACY: ["pharmacist", "tech", "cashier"],
    EstablishmentKind.CLOTHING: ["sales_associate", "manager"],
    EstablishmentKind.BANK: ["teller", "officer"],
    EstablishmentKind.HOSPITAL: ["nurse", "doctor", "admin", "tech"],
    EstablishmentKind.SCHOOL: ["teacher", "admin", "janitor"],
    EstablishmentKind.POLICE: ["officer", "dispatch"],
    EstablishmentKind.PARK: ["groundskeeper"],
}


def _residential_cells(grid: CityGrid) -> list[tuple[int, int]]:
    res_mask = (grid.zoning == int(Zoning.RESIDENTIAL)) | (grid.zoning == int(Zoning.MIXED))
    ys, xs = np.where(res_mask)
    return list(zip(xs.tolist(), ys.tolist(), strict=False))


def generate_agents(
    grid: CityGrid,
    establishments: list[Establishment],
    n: int = 1000,
    seed: int = 42,
) -> list[Agent]:
    """Generate `n` mock agents with home and (optionally) work cells.

    Workers are assigned to a random establishment that employs their occupation
    class. Non-workers (retirees, dependents) get None for `work_cell` and are
    home-bound for now.
    """
    rng = np.random.default_rng(seed + 2)
    homes = _residential_cells(grid)
    if not homes:
        raise ValueError("No residential cells in grid")

    employers = [e for e in establishments if e.kind in _OCCUPATIONS_BY_KIND]
    if not employers:
        raise ValueError("No employers placed; check establishments")

    agents: list[Agent] = []
    for i in range(n):
        age = int(rng.integers(6, 86))
        home = homes[int(rng.integers(0, len(homes)))]
        # Employment rate by age band
        if 22 <= age < 65:
            employed = rng.random() < 0.85
        elif 18 <= age < 22:
            employed = rng.random() < 0.40
        else:
            employed = False

        if employed:
            employer = employers[int(rng.integers(0, len(employers)))]
            occupations = _OCCUPATIONS_BY_KIND[employer.kind]
            occupation = occupations[int(rng.integers(0, len(occupations)))]
            work_cell = employer.cell
            employer_id = employer.id
        else:
            occupation = "student" if age < 18 else "retired" if age >= 65 else "unemployed"
            work_cell = None
            employer_id = None

        # Mode mix; numpy.choice on enum members is fiddly so we choose by index.
        mode_options = [
            TransportMode.WALK,
            TransportMode.BIKE,
            TransportMode.TRANSIT,
            TransportMode.CAR,
        ]
        mode_idx = int(rng.choice(len(mode_options), p=[0.20, 0.15, 0.35, 0.30]))
        agents.append(
            Agent(
                id=f"a{i:06d}",
                age=age,
                home_cell=home,
                work_cell=work_cell,
                employer_id=employer_id,
                occupation=occupation,
                mode=mode_options[mode_idx],
            )
        )
    return agents

"""Establishment placement.

Establishments are placed onto the grid based on zoning. This is a placeholder
for what will eventually be a richer model with brand templates, hours,
inventory and pricing. For now we emit just enough structure to render meaningful
icons and accept clicks in the viewer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from citysim.world.grid import CityGrid, Zoning


class EstablishmentKind(str, Enum):
    SUPERMARKET = "supermarket"
    COFFEE_SHOP = "coffee_shop"
    RESTAURANT = "restaurant"
    PUB = "pub"
    HARDWARE = "hardware"
    PHARMACY = "pharmacy"
    CLOTHING = "clothing"
    BANK = "bank"
    OFFICE = "office"
    HOSPITAL = "hospital"
    SCHOOL = "school"
    POLICE = "police"
    PARK = "park"
    HOME = "home"  # dummy for residential households


# Open hours are (open_minute, close_minute) where minutes are clock-of-day.
# Close < open means it crosses midnight.
DEFAULT_HOURS: dict[EstablishmentKind, tuple[int, int]] = {
    EstablishmentKind.SUPERMARKET: (7 * 60, 23 * 60),
    EstablishmentKind.COFFEE_SHOP: (6 * 60, 21 * 60),
    EstablishmentKind.RESTAURANT: (11 * 60, 23 * 60),
    EstablishmentKind.PUB: (16 * 60, 27 * 60),  # closes at 03:00 = 27:00
    EstablishmentKind.HARDWARE: (9 * 60, 19 * 60),
    EstablishmentKind.PHARMACY: (0, 24 * 60),  # 24/7
    EstablishmentKind.CLOTHING: (10 * 60, 21 * 60),
    EstablishmentKind.BANK: (9 * 60, 17 * 60),
    EstablishmentKind.OFFICE: (9 * 60, 18 * 60),
    EstablishmentKind.HOSPITAL: (0, 24 * 60),
    EstablishmentKind.SCHOOL: (8 * 60, 16 * 60),
    EstablishmentKind.POLICE: (0, 24 * 60),
    EstablishmentKind.PARK: (5 * 60, 22 * 60),
    EstablishmentKind.HOME: (0, 24 * 60),
}


@dataclass(frozen=True)
class Establishment:
    id: str
    kind: EstablishmentKind
    cell: tuple[int, int]
    hours: tuple[int, int]
    name: str = ""
    capacity: int = 50
    extra: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "kind": self.kind.value,
            "cell": list(self.cell),
            "hours": list(self.hours),
            "name": self.name,
            "capacity": self.capacity,
        }


def _density_for(kind: EstablishmentKind, zoning: Zoning) -> float:
    """Probability that a cell of given zoning hosts an establishment of this kind."""
    table: dict[tuple[EstablishmentKind, Zoning], float] = {
        (EstablishmentKind.SUPERMARKET, Zoning.COMMERCIAL): 0.18,
        (EstablishmentKind.SUPERMARKET, Zoning.MIXED): 0.05,
        (EstablishmentKind.COFFEE_SHOP, Zoning.COMMERCIAL): 0.45,
        (EstablishmentKind.COFFEE_SHOP, Zoning.MIXED): 0.25,
        (EstablishmentKind.RESTAURANT, Zoning.COMMERCIAL): 0.40,
        (EstablishmentKind.RESTAURANT, Zoning.MIXED): 0.20,
        (EstablishmentKind.PUB, Zoning.COMMERCIAL): 0.20,
        (EstablishmentKind.PUB, Zoning.MIXED): 0.05,
        (EstablishmentKind.HARDWARE, Zoning.COMMERCIAL): 0.08,
        (EstablishmentKind.HARDWARE, Zoning.INDUSTRIAL): 0.12,
        (EstablishmentKind.PHARMACY, Zoning.COMMERCIAL): 0.10,
        (EstablishmentKind.PHARMACY, Zoning.MIXED): 0.06,
        (EstablishmentKind.CLOTHING, Zoning.COMMERCIAL): 0.20,
        (EstablishmentKind.BANK, Zoning.COMMERCIAL): 0.10,
        (EstablishmentKind.OFFICE, Zoning.COMMERCIAL): 0.55,
        (EstablishmentKind.OFFICE, Zoning.MIXED): 0.20,
        (EstablishmentKind.HOSPITAL, Zoning.CIVIC): 0.40,
        (EstablishmentKind.SCHOOL, Zoning.CIVIC): 0.30,
        (EstablishmentKind.POLICE, Zoning.CIVIC): 0.20,
        (EstablishmentKind.PARK, Zoning.PARKS): 1.0,
    }
    return table.get((kind, zoning), 0.0)


def place_establishments(grid: CityGrid, seed: int = 42) -> list[Establishment]:
    """Place establishments procedurally on the grid using density tables."""
    rng = np.random.default_rng(seed + 1)
    establishments: list[Establishment] = []
    next_id = 0

    for y in range(grid.size):
        for x in range(grid.size):
            zoning = Zoning(int(grid.zoning[y, x]))
            for kind in EstablishmentKind:
                if kind is EstablishmentKind.HOME:
                    continue
                p = _density_for(kind, zoning)
                if p <= 0:
                    continue
                if rng.random() < p:
                    eid = f"e{next_id:05d}"
                    next_id += 1
                    establishments.append(
                        Establishment(
                            id=eid,
                            kind=kind,
                            cell=(x, y),
                            hours=DEFAULT_HOURS[kind],
                            name=f"{kind.value}_{eid}",
                        )
                    )
    return establishments

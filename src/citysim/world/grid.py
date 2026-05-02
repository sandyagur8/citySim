"""Procedural city grid with zoning.

The city is a square grid of cells. Each cell has a zoning class derived from
its distance to the city centre and a small amount of noise. Commercial dense
in the centre, mixed-use ring, residential further out, with industrial wedges
on the periphery and parks scattered through.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

import numpy as np


class Zoning(IntEnum):
    """Zoning class per cell."""

    PARKS = 0
    RESIDENTIAL = 1
    MIXED = 2
    COMMERCIAL = 3
    INDUSTRIAL = 4
    CIVIC = 5


@dataclass(frozen=True)
class CityGrid:
    """A city as a 2D zoning grid."""

    size: int
    """Cells per side. Total cells = size * size."""
    cell_metres: float
    """Real-world metres per cell, for scale (display only)."""
    latitude: float
    """City latitude in degrees, used for solar calc."""
    zoning: np.ndarray
    """(size, size) int array of Zoning values."""

    def to_dict(self) -> dict[str, object]:
        return {
            "size": self.size,
            "cell_metres": self.cell_metres,
            "latitude": self.latitude,
            "zoning": self.zoning.astype(np.uint8).tolist(),
        }


def generate_grid(
    size: int = 60,
    cell_metres: float = 200.0,
    latitude: float = 12.97,  # Bengaluru by default; change in profile
    seed: int = 42,
) -> CityGrid:
    """Generate a stylised city grid.

    The radial profile produces a recognisable city shape: dense commercial core,
    mixed-use ring, suburban residential, industrial wedges, civic landmarks, and
    parks dotted throughout.
    """
    rng = np.random.default_rng(seed)
    centre = (size - 1) / 2.0
    yy, xx = np.mgrid[0:size, 0:size]
    # Normalised radius from centre, 0..~1
    dx = (xx - centre) / centre
    dy = (yy - centre) / centre
    radius = np.sqrt(dx * dx + dy * dy)
    angle = np.arctan2(dy, dx)

    # Base zoning by radius
    zoning = np.full((size, size), Zoning.RESIDENTIAL, dtype=np.int8)
    zoning[radius < 0.18] = Zoning.COMMERCIAL
    zoning[(radius >= 0.18) & (radius < 0.40)] = Zoning.MIXED
    zoning[radius >= 0.85] = Zoning.RESIDENTIAL  # outer ring stays residential

    # Industrial wedges in two opposite quadrants on the periphery
    industrial_mask = (radius > 0.7) & (
        ((angle > 0.6) & (angle < 1.4)) | ((angle < -1.7) & (angle > -2.5))
    )
    zoning[industrial_mask] = Zoning.INDUSTRIAL

    # Sprinkle parks in low-density areas
    park_noise = rng.random((size, size))
    parks_mask = (zoning == Zoning.RESIDENTIAL) & (park_noise > 0.95)
    zoning[parks_mask] = Zoning.PARKS

    # A handful of civic landmarks near centre
    civic_count = max(2, size // 20)
    for _ in range(civic_count):
        cy, cx = rng.integers(int(centre - 5), int(centre + 5), size=2)
        zoning[int(cy), int(cx)] = Zoning.CIVIC

    return CityGrid(
        size=size,
        cell_metres=cell_metres,
        latitude=latitude,
        zoning=zoning.astype(np.uint8),
    )

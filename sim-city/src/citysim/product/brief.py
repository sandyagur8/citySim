"""ProductBrief data model + JSON persistence.

A brief is intentionally small and human-editable. The free-text fields
(``short_description``, ``detailed_description``, ``target_audience``)
flow into LLM prompts; the structured fields (``category``, ``price``,
``target.age_bands``, ``target.income_bands``) drive cheap, deterministic
filtering and reporting buckets.

A persona "matches the target audience" when **all** of the following
hold (any unset field is a wildcard):

* age falls inside one of ``target.age_bands``
* income_band is in ``target.income_bands``
* if ``target.occupation_regex`` is set, the persona's occupation
  matches it (case-insensitive ``re.search``)

That keeps targeting deterministic and free of extra LLM spend.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from citysim.store import default_home
from citysim.world.establishments import EstablishmentKind

if TYPE_CHECKING:
    from citysim.world.personas import Persona


# Canonical reference lists. Kept here so the CLI and the summary
# renderer can both pull from one place.
AGE_BANDS: list[tuple[str, int, int]] = [
    ("18-29", 18, 29),
    ("30-44", 30, 44),
    ("45-59", 45, 59),
    ("60+", 60, 120),
]

INCOME_BANDS: list[str] = ["very_low", "low", "middle", "upper_middle", "high"]

POSITIONING_OPTIONS: list[str] = ["premium", "value", "niche", "mainstream"]


def default_product_path() -> Path:
    return default_home() / "product.json"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class TargetFilter:
    """Structured slice of personas considered 'in the target audience'."""

    age_bands: list[str] = field(default_factory=list)  # e.g. ["18-29", "30-44"]
    income_bands: list[str] = field(default_factory=list)  # e.g. ["middle", "upper_middle"]
    occupation_regex: str | None = None  # case-insensitive search

    def to_dict(self) -> dict[str, object]:
        return {
            "age_bands": list(self.age_bands),
            "income_bands": list(self.income_bands),
            "occupation_regex": self.occupation_regex,
        }

    @classmethod
    def from_dict(cls, d: dict[str, object]) -> TargetFilter:
        return cls(
            age_bands=list(d.get("age_bands") or []),  # type: ignore[arg-type]
            income_bands=list(d.get("income_bands") or []),  # type: ignore[arg-type]
            occupation_regex=d.get("occupation_regex") or None,  # type: ignore[arg-type]
        )


@dataclass
class ProductBrief:
    """The full product-under-test definition."""

    name: str
    category: str  # must be a valid EstablishmentKind value (e.g. "coffee_shop")
    price: float
    short_description: str
    detailed_description: str
    target_audience: str  # free-text — flows into LLM prompts
    target: TargetFilter = field(default_factory=TargetFilter)
    key_features: list[str] = field(default_factory=list)
    positioning: str = "mainstream"  # one of POSITIONING_OPTIONS
    currency: str = "USD"

    # --- helpers ---------------------------------------------------------

    def category_kind(self) -> EstablishmentKind:
        """Return the EstablishmentKind enum value for ``category``."""
        return EstablishmentKind(self.category)

    def to_dict(self) -> dict[str, object]:
        d = asdict(self)
        d["target"] = self.target.to_dict()
        return d

    @classmethod
    def from_dict(cls, d: dict[str, object]) -> ProductBrief:
        target_raw = d.get("target") or {}
        target = TargetFilter.from_dict(target_raw)  # type: ignore[arg-type]
        return cls(
            name=str(d["name"]),
            category=str(d["category"]),
            price=float(d["price"]),  # type: ignore[arg-type]
            short_description=str(d.get("short_description", "")),
            detailed_description=str(d.get("detailed_description", "")),
            target_audience=str(d.get("target_audience", "")),
            target=target,
            key_features=list(d.get("key_features") or []),  # type: ignore[arg-type]
            positioning=str(d.get("positioning", "mainstream")),
            currency=str(d.get("currency", "USD")),
        )


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------


def load_product(path: Path | None = None) -> ProductBrief | None:
    """Return the saved product brief, or None if no file exists."""
    p = path or default_product_path()
    if not p.exists():
        return None
    raw = json.loads(p.read_text(encoding="utf-8"))
    return ProductBrief.from_dict(raw)


def save_product(brief: ProductBrief, path: Path | None = None) -> Path:
    """Atomically write a product brief to disk."""
    p = path or default_product_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(brief.to_dict(), indent=2), encoding="utf-8")
    tmp.replace(p)
    return p


def clear_product(path: Path | None = None) -> bool:
    """Delete the saved product brief. Returns True if a file was removed."""
    p = path or default_product_path()
    if p.exists():
        p.unlink()
        return True
    return False


# ---------------------------------------------------------------------------
# Targeting
# ---------------------------------------------------------------------------


def matches_target(persona: Persona, brief: ProductBrief) -> bool:
    """Return True if this persona matches the brief's structured target.

    An empty target (no filters set) matches everyone — that's intentional,
    so an unspecified target_audience means 'whole population'.
    """
    t = brief.target

    if t.age_bands:
        in_band = False
        for band in t.age_bands:
            for label, lo, hi in AGE_BANDS:
                if label == band and lo <= persona.age <= hi:
                    in_band = True
                    break
            if in_band:
                break
        if not in_band:
            return False

    if t.income_bands and persona.income_band not in t.income_bands:
        return False

    if t.occupation_regex:
        try:
            if not re.search(t.occupation_regex, persona.occupation, re.IGNORECASE):
                return False
        except re.error:
            # Malformed regex in user-edited JSON — fail open (don't filter).
            pass

    return True

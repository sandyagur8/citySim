"""Per-day activity summarizer.

Reads the JSONL event log for one simulated day and aggregates the
dialogues into a structured report — counts, conversion rate, breakdowns
by establishment kind and buyer income band, top decisive factors, top
establishments by traffic.

The summarizer is the read side of the event log. Anything that wants
to produce a different rendering (markdown, JSON, on-chain receipt) can
feed off the same ``DaySummary`` dataclass.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from citysim.store import EventLog, PersonaStore


# Approximate age bands for buyer demographic breakdowns. Mirrors the
# bands used in citysim.product.brief so reports line up with target
# filters configured in the brief.
_AGE_BANDS: list[tuple[str, int, int]] = [
    ("18-29", 18, 29),
    ("30-44", 30, 44),
    ("45-59", 45, 59),
    ("60+", 60, 120),
]


def _age_band_for(age: int) -> str:
    for label, lo, hi in _AGE_BANDS:
        if lo <= age <= hi:
            return label
    return "other"


def _normalise_phrase(s: str) -> str:
    """Cheap normalisation for grouping near-identical seller phrases.

    Lowercases, strips punctuation/whitespace, collapses runs of spaces.
    """
    out = s.lower().strip()
    out = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in out)
    out = " ".join(out.split())
    return out


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class SegmentStats:
    """Counts + conversion for one slice of the day (a kind, an income band, etc)."""

    label: str
    count: int = 0
    purchases: int = 0

    @property
    def conversion(self) -> float:
        return self.purchases / self.count if self.count else 0.0


@dataclass
class RelevantPersona:
    """One row of the 'most relevant personas' section in a product report."""

    buyer_id: str
    age: int | None
    gender: str | None
    occupation: str | None
    income_band: str | None
    purchased: bool
    motivator: str
    targeted: bool


@dataclass
class DaySummary:
    day: int
    n_dialogues: int = 0
    n_purchases: int = 0
    by_kind: dict[str, SegmentStats] = field(default_factory=dict)
    by_income_band: dict[str, SegmentStats] = field(default_factory=dict)
    top_decisive_factors: list[tuple[str, int]] = field(default_factory=list)
    top_establishments: list[tuple[str, int]] = field(default_factory=list)
    avg_price_paid: float | None = None
    total_spend: float = 0.0
    fallback_extractions: int = 0

    # ----- Product-test fields (populated only when product dialogues exist) -----
    product_name: str | None = None
    n_product_dialogues: int = 0
    n_units_sold: int = 0
    product_revenue: float = 0.0
    avg_product_price: float | None = None
    top_intrinsic_motivators: list[tuple[str, int]] = field(default_factory=list)
    top_winning_phrases: list[tuple[str, int]] = field(default_factory=list)
    top_objections: list[tuple[str, int]] = field(default_factory=list)
    by_age_band: dict[str, SegmentStats] = field(default_factory=dict)
    arm_random: SegmentStats = field(default_factory=lambda: SegmentStats(label="random"))
    arm_targeted: SegmentStats = field(default_factory=lambda: SegmentStats(label="targeted"))
    relevant_personas: list[RelevantPersona] = field(default_factory=list)

    @property
    def conversion(self) -> float:
        return self.n_purchases / self.n_dialogues if self.n_dialogues else 0.0

    @property
    def product_conversion(self) -> float:
        return self.n_units_sold / self.n_product_dialogues if self.n_product_dialogues else 0.0

    @property
    def has_product(self) -> bool:
        return self.n_product_dialogues > 0


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def summarize_day(
    day: int,
    *,
    event_log: EventLog | None = None,
    persona_store: PersonaStore | None = None,
) -> DaySummary:
    """Read the JSONL log for ``day`` and return a structured summary.

    If ``persona_store`` is provided, dialogues are also bucketed by buyer
    income band — looked up by ``buyer_id``. Otherwise that section is
    omitted.
    """
    log_ = event_log or EventLog()
    events = log_.read_day(day)

    summary = DaySummary(day=day)
    decisive_counter: Counter[str] = Counter()
    establishment_counter: Counter[str] = Counter()
    prices: list[float] = []

    # Product-specific accumulators
    motivator_counter: Counter[str] = Counter()
    objection_counter: Counter[str] = Counter()
    phrase_counter: Counter[str] = Counter()
    phrase_examples: dict[str, str] = {}  # normalised -> first verbatim seen
    product_prices: list[float] = []
    relevant_rows: list[RelevantPersona] = []

    income_cache: dict[str, str | None] = {}
    persona_cache: dict[str, object] = {}

    def buyer_income(buyer_id: str) -> str | None:
        if buyer_id in income_cache:
            return income_cache[buyer_id]
        if persona_store is None or not buyer_id:
            income_cache[buyer_id] = None
            return None
        row = persona_store.get(buyer_id)
        income_cache[buyer_id] = row.income_band if row else None
        if row:
            persona_cache[buyer_id] = row
        return income_cache[buyer_id]

    def buyer_row(buyer_id: str) -> object | None:
        if buyer_id in persona_cache:
            return persona_cache[buyer_id]
        if persona_store is None or not buyer_id:
            return None
        row = persona_store.get(buyer_id)
        if row:
            persona_cache[buyer_id] = row
        return row

    for ev in events:
        if ev.get("kind") != "dialogue":
            continue

        summary.n_dialogues += 1
        end_reason = str(ev.get("end_reason", ""))
        outcome = ev.get("outcome") or {}
        purchased = bool(outcome.get("purchased") or end_reason == "buy")
        if purchased:
            summary.n_purchases += 1

        if outcome.get("_fallback"):
            summary.fallback_extractions += 1

        # by establishment kind
        kind = str(ev.get("establishment_kind", "unknown"))
        bucket = summary.by_kind.setdefault(kind, SegmentStats(label=kind))
        bucket.count += 1
        if purchased:
            bucket.purchases += 1

        # by buyer income band
        buyer_id = str(ev.get("buyer_id", ""))
        income = buyer_income(buyer_id)
        if income:
            ibucket = summary.by_income_band.setdefault(income, SegmentStats(label=income))
            ibucket.count += 1
            if purchased:
                ibucket.purchases += 1

        # decisive factors
        factor = outcome.get("decisive_factor")
        if factor and factor != "none":
            decisive_counter[str(factor)] += 1

        # establishment frequency
        est_id = ev.get("establishment_id")
        if est_id:
            establishment_counter[str(est_id)] += 1

        # price paid (any dialogue)
        price = outcome.get("price_paid")
        if isinstance(price, (int, float)):
            prices.append(float(price))

        # ----- Product-specific aggregation -----
        dialogue_kind = str(ev.get("dialogue_kind", "generic"))
        if dialogue_kind == "product":
            summary.n_product_dialogues += 1
            product_id = ev.get("product_id")
            if product_id and not summary.product_name:
                summary.product_name = str(product_id)

            arm = str(ev.get("arm", "random"))
            arm_bucket = summary.arm_targeted if arm == "targeted" else summary.arm_random
            arm_bucket.count += 1
            if purchased:
                arm_bucket.purchases += 1

            if purchased:
                units = outcome.get("units")
                u = int(units) if isinstance(units, (int, float)) else 1
                summary.n_units_sold += max(1, u)
                if isinstance(price, (int, float)):
                    product_prices.append(float(price) * max(1, u))

            motivator = outcome.get("intrinsic_motivator")
            if motivator and motivator != "none":
                motivator_counter[str(motivator)] += 1

            for obj in outcome.get("objections_raised") or []:
                if isinstance(obj, str) and obj:
                    objection_counter[obj] += 1

            phrase = outcome.get("seller_winning_phrase")
            if isinstance(phrase, str) and phrase.strip() and phrase.strip().lower() != "none":
                key = _normalise_phrase(phrase)
                if key:
                    phrase_counter[key] += 1
                    phrase_examples.setdefault(key, phrase.strip())

            # By buyer age band
            row = buyer_row(buyer_id)
            age = getattr(row, "age", None)
            if isinstance(age, int):
                band = _age_band_for(age)
                ab = summary.by_age_band.setdefault(band, SegmentStats(label=band))
                ab.count += 1
                if purchased:
                    ab.purchases += 1

            # Relevant-personas roster (cap collected; we trim later)
            if len(relevant_rows) < 200:
                relevant_rows.append(
                    RelevantPersona(
                        buyer_id=buyer_id,
                        age=getattr(row, "age", None),
                        gender=getattr(row, "gender", None),
                        occupation=getattr(row, "occupation", None),
                        income_band=getattr(row, "income_band", None),
                        purchased=purchased,
                        motivator=str(motivator or "none"),
                        targeted=bool(ev.get("targeted", False)),
                    )
                )

    summary.top_decisive_factors = decisive_counter.most_common(5)
    summary.top_establishments = establishment_counter.most_common(5)
    if prices:
        summary.avg_price_paid = sum(prices) / len(prices)
        summary.total_spend = sum(prices)

    # Product post-processing
    summary.top_intrinsic_motivators = motivator_counter.most_common(5)
    summary.top_objections = objection_counter.most_common(5)
    summary.top_winning_phrases = [
        (phrase_examples[key], count) for key, count in phrase_counter.most_common(5)
    ]
    if product_prices:
        summary.product_revenue = sum(product_prices)
        summary.avg_product_price = sum(product_prices) / len(product_prices)
    # Most relevant: buyers ranked by (purchased, targeted) then keep up to 10
    relevant_rows.sort(key=lambda r: (not r.purchased, not r.targeted))
    summary.relevant_personas = relevant_rows[:10]

    return summary


# ---------------------------------------------------------------------------
# Terminal rendering
# ---------------------------------------------------------------------------


_INCOME_ORDER = ["very_low", "low", "middle", "upper_middle", "high"]


def format_summary(summary: DaySummary) -> str:
    """Multi-line, terminal-friendly rendering of a ``DaySummary``."""
    lines: list[str] = []
    bar = "=" * 70
    lines.append(bar)
    if summary.has_product and summary.product_name:
        lines.append(f"Day {summary.day:>4}  -  '{summary.product_name}' product test")
    else:
        lines.append(f"Day {summary.day:>4}  -  daily activity summary")
    lines.append(bar)

    # ---------- Product section first (most relevant when present) ----------
    if summary.has_product:
        lines.append("PRODUCT TEST")
        lines.append("-" * 70)
        lines.append(
            f"Units sold              : {summary.n_units_sold} "
            f"/ {summary.n_product_dialogues} product interactions"
        )
        lines.append(f"Conversion (product)    : {summary.product_conversion * 100:.1f}%")
        if summary.product_revenue:
            lines.append(f"Revenue                 : {summary.product_revenue:.2f}")
        if summary.avg_product_price is not None:
            lines.append(f"Avg price paid          : {summary.avg_product_price:.2f}")
        lines.append("")

        # A/B comparison
        if summary.arm_random.count or summary.arm_targeted.count:
            lines.append("A/B sampling (random vs targeted buyers):")
            for stats in (summary.arm_random, summary.arm_targeted):
                lines.append(
                    f"  {stats.label:<10}  n={stats.count:<4}  "
                    f"buy_rate={stats.conversion * 100:>5.1f}%"
                )
            lines.append("")

        # Top intrinsic motivators
        if summary.top_intrinsic_motivators:
            lines.append("Top intrinsic motivators (in conversions):")
            for motivator, count in summary.top_intrinsic_motivators:
                label = motivator.replace("_", " ")
                lines.append(f"  {label:<24}  {count}")
            lines.append("")

        # Top winning phrases
        if summary.top_winning_phrases:
            lines.append("Top seller phrases that converted:")
            for phrase, count in summary.top_winning_phrases:
                trimmed = phrase if len(phrase) <= 60 else phrase[:57] + "..."
                lines.append(f'  ({count}x)  "{trimmed}"')
            lines.append("")

        # Top objections
        if summary.top_objections:
            lines.append("Top objections (in non-conversions):")
            for obj, count in summary.top_objections:
                label = obj.replace("_", " ")
                lines.append(f"  {label:<24}  {count}")
            lines.append("")

        # By age band
        if summary.by_age_band:
            lines.append("Buyer demographics by age band:")
            for label, _, _ in _AGE_BANDS:
                stats = summary.by_age_band.get(label)
                if not stats:
                    continue
                lines.append(
                    f"  {stats.label:<10}  n={stats.count:<4}  "
                    f"buy_rate={stats.conversion * 100:>5.1f}%"
                )
            lines.append("")

        # Most relevant personas
        if summary.relevant_personas:
            lines.append("Most relevant personas (top 10):")
            for r in summary.relevant_personas:
                tag = "BUY" if r.purchased else "no "
                star = "*" if r.targeted else " "
                age = r.age if r.age is not None else "?"
                gender = (r.gender or "?")[:1].upper()
                occ = (r.occupation or "?").replace("_", " ")
                inc = (r.income_band or "?").replace("_", " ")
                motiv = r.motivator.replace("_", " ")
                lines.append(
                    f"  {star}[{tag}] {r.buyer_id}  {age}{gender} {occ} ({inc})  -> {motiv}"
                )
            lines.append("  (* = matched target audience filter)")
            lines.append("")

        lines.append("-" * 70)
        lines.append("ALL ACTIVITY (product + baseline)")
        lines.append("-" * 70)

    lines.append(f"Dialogues run        : {summary.n_dialogues}")
    lines.append(f"Purchases committed  : {summary.n_purchases}")
    lines.append(f"Conversion rate      : {summary.conversion * 100:.1f}%")
    if summary.avg_price_paid is not None:
        lines.append(f"Avg price paid       : {summary.avg_price_paid:.2f}")
        lines.append(f"Total spend          : {summary.total_spend:.2f}")
    if summary.fallback_extractions:
        lines.append(
            f"Note: {summary.fallback_extractions} outcome(s) used the rule-based "
            f"fallback (no audit-tier key configured or call failed)"
        )
    lines.append("")

    if summary.by_kind:
        lines.append("By establishment kind:")
        ranked = sorted(summary.by_kind.values(), key=lambda s: -s.count)
        for stats in ranked:
            lines.append(
                f"  {stats.label:<14}  n={stats.count:<4}  buy_rate={stats.conversion * 100:>5.1f}%"
            )
        lines.append("")

    if summary.by_income_band:
        lines.append("By buyer income band:")
        for band in _INCOME_ORDER:
            stats = summary.by_income_band.get(band)
            if not stats:
                continue
            lines.append(
                f"  {stats.label:<14}  n={stats.count:<4}  buy_rate={stats.conversion * 100:>5.1f}%"
            )
        lines.append("")

    if summary.top_decisive_factors:
        lines.append("Top decisive factors (in completed purchases):")
        for factor, count in summary.top_decisive_factors:
            lines.append(f"  {factor:<24}  {count}")
        lines.append("")

    if summary.top_establishments:
        lines.append("Top establishments by traffic:")
        for est_id, count in summary.top_establishments:
            lines.append(f"  {est_id:<10}  visits={count}")
        lines.append("")

    if summary.n_dialogues == 0:
        lines.append("(No dialogues recorded for this day.)")
        lines.append("")

    lines.append(bar)
    return "\n".join(lines)


__all__ = [
    "DaySummary",
    "RelevantPersona",
    "SegmentStats",
    "format_summary",
    "summarize_day",
]

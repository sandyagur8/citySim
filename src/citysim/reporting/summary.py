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

    @property
    def conversion(self) -> float:
        return self.n_purchases / self.n_dialogues if self.n_dialogues else 0.0


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

    income_cache: dict[str, str | None] = {}

    def buyer_income(buyer_id: str) -> str | None:
        if buyer_id in income_cache:
            return income_cache[buyer_id]
        if persona_store is None or not buyer_id:
            income_cache[buyer_id] = None
            return None
        row = persona_store.get(buyer_id)
        income_cache[buyer_id] = row.income_band if row else None
        return income_cache[buyer_id]

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
        income = buyer_income(str(ev.get("buyer_id", "")))
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

        # price paid
        price = outcome.get("price_paid")
        if isinstance(price, (int, float)):
            prices.append(float(price))

    summary.top_decisive_factors = decisive_counter.most_common(5)
    summary.top_establishments = establishment_counter.most_common(5)
    if prices:
        summary.avg_price_paid = sum(prices) / len(prices)
        summary.total_spend = sum(prices)

    return summary


# ---------------------------------------------------------------------------
# Terminal rendering
# ---------------------------------------------------------------------------


_INCOME_ORDER = ["very_low", "low", "middle", "upper_middle", "high"]


def format_summary(summary: DaySummary) -> str:
    """Multi-line, terminal-friendly rendering of a ``DaySummary``."""
    lines: list[str] = []
    bar = "=" * 60
    lines.append(bar)
    lines.append(f"Day {summary.day:>4}  -  daily activity summary")
    lines.append(bar)
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
    "SegmentStats",
    "format_summary",
    "summarize_day",
]

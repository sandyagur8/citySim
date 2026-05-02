"""Reporting layer: per-day activity summaries.

Aggregates the JSONL event log into structured ``DaySummary`` objects
plus a terminal-friendly text rendering. Pure read-side — never writes
anything except via the caller's stdout.
"""

from .summary import DaySummary, SegmentStats, format_summary, summarize_day

__all__ = [
    "DaySummary",
    "SegmentStats",
    "format_summary",
    "summarize_day",
]

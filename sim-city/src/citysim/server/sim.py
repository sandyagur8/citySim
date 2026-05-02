"""Singleton simulation state and tick loop.

Holds the world (grid, establishments, agents, schedules) and a clock that
advances at a user-controlled speed. Clients subscribe via asyncio queues to
receive broadcast position deltas. The same sim is shared across all WebSocket
connections — opening multiple browser tabs all watch the same world at the
same time.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from citysim.reporting import format_summary, summarize_day
from citysim.store import EventLog, PersonaStore
from citysim.world.agents import MODE_SPEED, Agent
from citysim.world.establishments import (
    Establishment,
    cap_establishments_per_kind,
    place_establishments,
)
from citysim.world.grid import CityGrid, generate_grid
from citysim.world.personas import Persona, load_or_generate_personas
from citysim.world.schedule import ACTIVITY_CODES, Activity, Intention, plan_day

# How often (in sim minutes) to broadcast position deltas.
# Lower = smoother animation at high speed multipliers (e.g. 1440x / 1-min days).
BROADCAST_EVERY_SIM_MIN = 2

# Real-second cadence of the tick loop. We advance sim_time by speed * dt
# each iteration; smaller dt = smoother, larger dt = cheaper. 0.1s is plenty.
TICK_INTERVAL_S = 0.1


@dataclass
class SimState:
    grid: CityGrid
    establishments: list[Establishment]
    agents: list[Agent]
    personas: list[Persona] = field(default_factory=list)
    plans: dict[str, list[Intention]] = field(default_factory=dict)

    # Clock (minute-of-day, float)
    sim_minute: float = 6 * 60.0  # start at 06:00
    day_of_year: int = 120
    day_of_week: int = 1  # Tuesday

    # Controls
    speed_multiplier: float = 60.0  # 60 = one sim minute per real second
    paused: bool = False

    # Subscribers (asyncio queues of dict messages)
    subscribers: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)

    # Bookkeeping
    last_broadcast_min: float = -10.0

    # Lookups for the interaction runner / API
    persona_by_id: dict[str, Persona] = field(default_factory=dict)

    # Storage handles (set by build_sim) — used by the dialogue scheduler
    # and the day-rollover summary hook in tick_loop.
    persona_store: PersonaStore | None = None
    event_log: EventLog | None = None

    # Latest computed day summary (set after each day rollover). Used by
    # /api/summary/latest and shipped on /ws init so a late connector still
    # sees the most recent end-of-day modal.
    last_day_summary: dict[str, Any] | None = None

    # A small ring of recent dialogue events. Lets the viewer's "Recent
    # conversations" feed populate immediately on connect, even between ticks.
    recent_dialogues: list[dict[str, Any]] = field(default_factory=list)
    # Live counters shipped on every tick — cheap, scales to millions of
    # dialogues without sending the whole event log.
    stats: dict[str, Any] = field(default_factory=dict)


def build_sim(
    n_agents: int = 10000,
    grid_size: int = 150,
    seed: int = 42,
    max_establishments_per_kind: int | None = None,
    *,
    store: PersonaStore | None = None,
    force_regenerate: bool = False,
) -> SimState:
    """Build the world.

    Personas are loaded from the SQLite store if it already holds a matching
    world (same n / seed / grid). Otherwise we generate fresh and persist.
    Pass ``force_regenerate=True`` to wipe and rebuild on demand.
    """
    grid = generate_grid(size=grid_size, seed=seed)
    establishments = place_establishments(grid, seed=seed)
    if max_establishments_per_kind is not None:
        establishments = cap_establishments_per_kind(
            establishments,
            max_per_kind=max_establishments_per_kind,
            seed=seed,
        )
    if store is None:
        store = PersonaStore()
    personas = load_or_generate_personas(
        grid, establishments, n=n_agents, seed=seed, store=store,
        signature_extra=f"max_est_per_kind={max_establishments_per_kind}",
        force_regenerate=force_regenerate,
    )
    agents = [p.to_agent() for p in personas]
    sim = SimState(
        grid=grid,
        establishments=establishments,
        agents=agents,
        personas=personas,
        persona_by_id={p.agent_id: p for p in personas},
        persona_store=store,
        event_log=EventLog(),
    )
    sim.stats = _empty_stats()
    for a in agents:
        sim.plans[a.id] = plan_day(a, establishments, day_of_week=sim.day_of_week, seed=seed)
    return sim


def position_for(
    agent: Agent,
    plan: list[Intention],
    sim_minute: float,
) -> tuple[float, float, Activity]:
    """Return (x, y, activity) for an agent at the given sim time.

    Cells are positions in the grid. We interpolate during COMMUTE intentions so
    movement looks smooth in the viewer; for all other activities the agent
    sits at the intention's cell.
    """
    if not plan:
        return float(agent.home_cell[0]), float(agent.home_cell[1]), Activity.SLEEP

    # Find the active intention: the last whose start_minute <= sim_minute.
    idx = 0
    for i, intent in enumerate(plan):
        if intent.start_minute <= sim_minute:
            idx = i
        else:
            break
    current = plan[idx]
    next_intent = plan[idx + 1] if idx + 1 < len(plan) else None

    if current.activity == Activity.COMMUTE and next_intent is not None:
        # Interpolate between previous-cell and target cell
        prev_cell = plan[idx - 1].cell if idx > 0 else agent.home_cell
        target = current.cell
        elapsed = sim_minute - current.start_minute
        # Travel time based on transport mode and Manhattan distance
        dist = abs(target[0] - prev_cell[0]) + abs(target[1] - prev_cell[1])
        travel_time = max(1.0, dist / max(MODE_SPEED[agent.mode], 0.01))
        t = max(0.0, min(1.0, elapsed / travel_time))
        x = prev_cell[0] + (target[0] - prev_cell[0]) * t
        y = prev_cell[1] + (target[1] - prev_cell[1]) * t
        return x, y, Activity.COMMUTE

    return float(current.cell[0]), float(current.cell[1]), current.activity


def snapshot_positions(sim: SimState) -> list[list[float | int]]:
    """Return a compact list of [x*1000, y*1000, activity_code] (one row per agent).

    Multiplied by 1000 so we can transmit ints (smaller JSON than floats with
    plenty of precision for visuals). The agent index in the list matches the
    index in `sim.agents`.
    """
    out: list[list[float | int]] = []
    for agent in sim.agents:
        plan = sim.plans.get(agent.id, [])
        x, y, act = position_for(agent, plan, sim.sim_minute)
        out.append([int(x * 1000), int(y * 1000), ACTIVITY_CODES[act]])
    return out


async def broadcast(sim: SimState, message: dict[str, Any]) -> None:
    dead: list[asyncio.Queue[dict[str, Any]]] = []
    for q in sim.subscribers:
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        sim.subscribers.discard(q)


# ---------------------------------------------------------------------------
# Live dialogue feed + stats helpers
# ---------------------------------------------------------------------------

# Cap on the rolling feed shown by the viewer's right-rail.
_RECENT_DIALOGUES_MAX = 30


def _empty_stats() -> dict[str, Any]:
    return {
        "n_dialogues": 0,
        "n_purchases": 0,
        "n_dialogue_errors": 0,
        "n_transport_errors": 0,
        "n_llm_errors": 0,
        "n_product_dialogues": 0,
        "n_units_sold": 0,
        "product_revenue": 0.0,
        "arm_random": {"count": 0, "purchases": 0},
        "arm_targeted": {"count": 0, "purchases": 0},
    }


def record_dialogue_error(sim: SimState, *, kind: str = "unknown") -> None:
    if not sim.stats:
        sim.stats = _empty_stats()
    sim.stats["n_dialogue_errors"] = int(sim.stats.get("n_dialogue_errors", 0)) + 1
    if kind == "transport":
        sim.stats["n_transport_errors"] = int(sim.stats.get("n_transport_errors", 0)) + 1
    elif kind == "llm":
        sim.stats["n_llm_errors"] = int(sim.stats.get("n_llm_errors", 0)) + 1


def record_dialogue_event(sim: SimState, event: dict[str, Any]) -> None:
    """Update in-memory stats / recent-dialogue ring from a streaming event.

    Called by the dialogue scheduler's ``on_event`` hook. Pure in-process
    bookkeeping — actual broadcast is fire-and-forget via ``broadcast()``.
    """
    if not sim.stats:
        sim.stats = _empty_stats()

    et = event.get("type")
    if et == "dialogue_started":
        # Push a partial card to the feed; we'll mutate it on dialogue_ended.
        card = {
            "dialogue_id": event.get("dialogue_id"),
            "buyer_id": event.get("buyer_id"),
            "buyer_age": event.get("buyer_age"),
            "buyer_occupation": event.get("buyer_occupation"),
            "establishment_id": event.get("establishment_id"),
            "establishment_kind": event.get("establishment_kind"),
            "product_id": event.get("product_id"),
            "dialogue_kind": event.get("dialogue_kind"),
            "arm": event.get("arm"),
            "targeted": event.get("targeted"),
            "sim_minute": event.get("sim_minute"),
            "status": "live",
            "outcome": None,
        }
        sim.recent_dialogues.insert(0, card)
        del sim.recent_dialogues[_RECENT_DIALOGUES_MAX:]
    elif et == "dialogue_ended":
        did = event.get("dialogue_id")
        outcome = event.get("outcome") or {}
        purchased = bool(outcome.get("purchased") or event.get("end_reason") == "buy")
        # Update the matching card if still in the ring.
        for c in sim.recent_dialogues:
            if c.get("dialogue_id") == did:
                c["status"] = "ended"
                c["end_reason"] = event.get("end_reason")
                c["outcome"] = outcome
                c["purchased"] = purchased
                break
        # Update live stats
        s = sim.stats
        s["n_dialogues"] = int(s.get("n_dialogues", 0)) + 1
        if purchased:
            s["n_purchases"] = int(s.get("n_purchases", 0)) + 1
        if event.get("dialogue_kind") == "product":
            s["n_product_dialogues"] = int(s.get("n_product_dialogues", 0)) + 1
            if purchased:
                units = outcome.get("units")
                u = int(units) if isinstance(units, (int, float)) else 1
                s["n_units_sold"] = int(s.get("n_units_sold", 0)) + max(1, u)
                price = outcome.get("price_paid")
                if isinstance(price, (int, float)):
                    s["product_revenue"] = float(s.get("product_revenue", 0.0)) + float(
                        price
                    ) * max(1, u)
            arm = "arm_targeted" if event.get("arm") == "targeted" else "arm_random"
            bucket = s.setdefault(arm, {"count": 0, "purchases": 0})
            bucket["count"] = int(bucket.get("count", 0)) + 1
            if purchased:
                bucket["purchases"] = int(bucket.get("purchases", 0)) + 1


async def _emit_day_summary(sim: SimState, day: int) -> None:
    """Aggregate the day's events from the log, print to stdout, and
    broadcast a ``day_summary`` WebSocket message so the viewer can show
    its end-of-day modal without a separate REST poll.

    Best-effort — never raises into the tick loop. If the event log isn't
    wired up (e.g. tests), or the day file is empty, we just skip.
    """
    if sim.event_log is None:
        return
    try:
        summary = summarize_day(
            day,
            event_log=sim.event_log,
            persona_store=sim.persona_store,
        )
        print(format_summary(summary), flush=True)
        await broadcast(
            sim,
            {
                "type": "day_summary",
                "day": day,
                "summary": summary.to_dict(),
            },
        )
        # Also stash on sim so a fresh /ws connection can fetch it.
        sim.last_day_summary = summary.to_dict()
    except Exception:  # noqa: BLE001 - best-effort, don't crash the tick loop
        import traceback

        traceback.print_exc()


async def tick_loop(sim: SimState) -> None:
    """Advance the clock and broadcast position deltas to all subscribers."""
    last = time.monotonic()
    while True:
        await asyncio.sleep(TICK_INTERVAL_S)
        now = time.monotonic()
        dt_real = now - last
        last = now
        if sim.paused:
            continue
        # speed_multiplier is a real-time multiplier (1x = real-time, 60x = one
        # sim-minute per real-second). dt_real is in seconds.
        sim.sim_minute += dt_real * sim.speed_multiplier / 60.0

        # Wrap day
        if sim.sim_minute >= 1440:
            ended_day = sim.day_of_year
            sim.sim_minute -= 1440
            sim.day_of_year += 1
            sim.day_of_week = (sim.day_of_week + 1) % 7
            # Re-plan everyone for the new day
            for a in sim.agents:
                sim.plans[a.id] = plan_day(
                    a, sim.establishments, day_of_week=sim.day_of_week, seed=sim.day_of_year
                )
            # Reset live stats for the new day before broadcasting summary.
            await _emit_day_summary(sim, ended_day)
            sim.stats = _empty_stats()

        # Broadcast every BROADCAST_EVERY_SIM_MIN sim minutes
        if sim.sim_minute - sim.last_broadcast_min >= BROADCAST_EVERY_SIM_MIN:
            sim.last_broadcast_min = sim.sim_minute
            await broadcast(
                sim,
                {
                    "type": "tick",
                    "sim_minute": sim.sim_minute,
                    "day_of_year": sim.day_of_year,
                    "day_of_week": sim.day_of_week,
                    "positions": snapshot_positions(sim),
                    "stats": sim.stats or _empty_stats(),
                },
            )


def init_payload(sim: SimState) -> dict[str, Any]:
    """Initial message sent on a new WebSocket connection."""
    # Lazy import to avoid an import cycle at module-load (citysim.product
    # pulls in citysim.world.establishments).
    from citysim.product import load_product, load_products

    brief = load_product()
    products = load_products()
    return {
        "type": "init",
        "world": {
            "grid": sim.grid.to_dict(),
            "establishments": [e.to_dict() for e in sim.establishments],
            "agents": [a.to_dict() for a in sim.agents],
        },
        "clock": {
            "sim_minute": sim.sim_minute,
            "day_of_year": sim.day_of_year,
            "day_of_week": sim.day_of_week,
            "speed_multiplier": sim.speed_multiplier,
            "paused": sim.paused,
        },
        "product": brief.to_dict() if brief is not None else None,
        "products": [b.to_dict() for b in products],
        "stats": sim.stats or _empty_stats(),
        "recent_dialogues": list(sim.recent_dialogues),
        "last_day_summary": sim.last_day_summary,
    }


def apply_control(sim: SimState, message: dict[str, Any]) -> None:
    """Apply a client-sent control message in-place."""
    kind = message.get("type")
    if kind == "set_speed":
        v = float(message.get("value", 60.0))
        sim.speed_multiplier = max(0.0, min(3600.0, v))
    elif kind == "set_paused":
        sim.paused = bool(message.get("value", False))
    elif kind == "jump_to_minute":
        target = float(message.get("value", 0.0)) % 1440.0
        sim.sim_minute = target
        sim.last_broadcast_min = -10.0  # force a broadcast soon
    elif kind == "ping":
        pass


def iter_subscribers(sim: SimState) -> Iterable[asyncio.Queue[dict[str, Any]]]:
    return list(sim.subscribers)

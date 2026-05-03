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

from citysim.reporting import format_summary, summarize_day, summarize_run
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
class SimulationConfig:
    """User-supplied parameters for a simulation run.

    Captured by the frontend wizard (or the CLI) and pinned to the
    ``SimRun`` for the duration. After the run completes, the user can
    pre-fill the wizard from this and tweak.
    """

    product_name: str | None = None  # selects which brief from the library to test
    total_days: int = 1  # run for this many sim days then complete
    agent_cap: int | None = None  # limit how many bootstrapped personas participate
    baseline_ratio: float = 0.25  # fraction of dialogues fired at non-product shops
    model: str | None = None  # Ollama model id; None = leave env-default in place
    dialogue_workers: int = 1  # initial concurrent worker count
    target_dialogues_per_day: int = 60  # used by tick-loop pacing
    # Hard cap on buyer<->seller turns per dialogue. Lower = snappier
    # demos and cheaper LLM bills; higher = richer conversations with
    # more chance to surface objections and motivators.
    max_turns: int = 6

    def to_dict(self) -> dict[str, Any]:
        return {
            "product_name": self.product_name,
            "total_days": self.total_days,
            "agent_cap": self.agent_cap,
            "baseline_ratio": self.baseline_ratio,
            "model": self.model,
            "dialogue_workers": self.dialogue_workers,
            "target_dialogues_per_day": self.target_dialogues_per_day,
            "max_turns": self.max_turns,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SimulationConfig:
        return cls(
            product_name=(d.get("product_name") or None),
            total_days=int(d.get("total_days", 1) or 1),
            agent_cap=(int(d["agent_cap"]) if d.get("agent_cap") not in (None, "") else None),
            baseline_ratio=max(0.0, min(1.0, float(d.get("baseline_ratio", 0.25) or 0.0))),
            model=(d.get("model") or None),
            dialogue_workers=max(1, int(d.get("dialogue_workers", 1) or 1)),
            target_dialogues_per_day=max(
                1, int(d.get("target_dialogues_per_day", 60) or 60)
            ),
            max_turns=max(1, min(50, int(d.get("max_turns", 6) or 6))),
        )


@dataclass
class SimRun:
    """Runtime status of the simulation.

    The lifespan no longer auto-starts a run — the server boots in
    ``idle`` and waits for ``POST /api/simulation/start``. Once running,
    the tick loop advances the clock until ``current_day - start_day >=
    config.total_days``, then transitions to ``completed`` and emits
    a cumulative ``simulation_completed`` WS message.
    """

    status: str = "idle"  # "idle" | "running" | "completed"
    config: SimulationConfig = field(default_factory=SimulationConfig)
    start_day: int = 0  # day_of_year captured at run start
    # Sim-minute (within start_day) at which the run began. Lets the day
    # summary scope itself to events that happened during THIS run when a
    # previous run wrote events for the same sim-day.
    start_sim_minute: float = 0.0
    started_at_real: float = 0.0  # monotonic wall-clock for diagnostics
    days_completed: int = 0  # incremented at each day-rollover during a run
    # Counter reset at the start of every sim-day; used by tick_loop pacing
    # to slow advancement when dialogue throughput is behind.
    dialogues_today: int = 0
    # Latest cumulative run summary (broadcast at run completion).
    last_run_summary: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "config": self.config.to_dict(),
            "start_day": self.start_day,
            "days_completed": self.days_completed,
            "dialogues_today": self.dialogues_today,
        }


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

    # Run lifecycle. Idle until POST /api/simulation/start fires.
    run: SimRun = field(default_factory=SimRun)
    # Subset of agent IDs participating in the current run (cap from config).
    # Empty = everyone participates. Dialogue scheduler should sample from this.
    active_agent_ids: set[str] = field(default_factory=set)
    # Buyer reroute bookkeeping: dialogue_id -> (agent_id, original_plan_snapshot,
    # restore_after_minute). Lets dialogue_started splice a SHOP intention,
    # and dialogue_ended restore the original plan.
    rerouted: dict[str, dict[str, Any]] = field(default_factory=dict)


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
        # Reroute buyer avatar to the establishment cell so the visual
        # progresses in line with the conversation. Best-effort.
        try:
            est_id = card.get("establishment_id")
            est = next((e for e in sim.establishments if e.id == est_id), None)
            if est is not None and card.get("buyer_id") and card.get("dialogue_id"):
                reroute_buyer_to_establishment(
                    sim,
                    dialogue_id=str(card["dialogue_id"]),
                    buyer_id=str(card["buyer_id"]),
                    est_cell=(int(est.cell[0]), int(est.cell[1])),
                )
        except Exception:  # noqa: BLE001
            pass
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
        # Restore the buyer's plan (was rerouted on dialogue_started).
        if did:
            try:
                restore_buyer_plan(sim, str(did))
            except Exception:  # noqa: BLE001
                pass
        # Update live stats
        s = sim.stats
        s["n_dialogues"] = int(s.get("n_dialogues", 0)) + 1
        # Bump per-day dialogue counter used by tick-loop pacing
        sim.run.dialogues_today = int(sim.run.dialogues_today) + 1
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


async def _pay_daily_wages_async(sim_day: int) -> None:
    """Background task: hand the day's wage payout to the economy module.

    Gated on the env var ``CITYSIM_DAILY_WAGES`` (default ``1``). Best
    effort — never raises into the tick loop. Heavy lifting (hundreds
    of Sepolia transfers via tsx subprocess) happens off the asyncio
    loop in a worker thread so it never blocks dialogue events or
    position broadcasts.
    """
    import os

    raw = os.environ.get("CITYSIM_DAILY_WAGES", "1").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return
    try:
        # Lazy import — economy module pulls in eth_account / sqlite
        # which we don't want at server-cold-boot time.
        from citysim.economy.distribute import pay_daily_wages

        await asyncio.to_thread(pay_daily_wages, sim_day)
    except Exception:  # noqa: BLE001 - the show must go on
        import traceback

        traceback.print_exc()


async def _emit_day_summary(sim: SimState, day: int) -> None:
    """Aggregate the day's events from the log, print to stdout, and
    broadcast a ``day_summary`` WebSocket message so the viewer can show
    its end-of-day modal without a separate REST poll.

    Filters to the active run's product (so a previous run's product
    name can't leak into the headline) and to events that occurred at
    or after the run started (so a previous run's dialogues on the
    same sim-day are excluded).

    Best-effort — never raises into the tick loop. If the event log isn't
    wired up (e.g. tests), or the day file is empty, we just skip.
    """
    if sim.event_log is None:
        return
    try:
        product_filter: str | None = None
        sim_minute_min: float | None = None
        if sim.run.status == "running" and sim.run.config.product_name:
            product_filter = sim.run.config.product_name
        # Scope the FIRST day of a run (start_day) to events that happened
        # at or after the run kicked off. Subsequent days are full days.
        if sim.run.status == "running" and day == sim.run.start_day:
            sim_minute_min = sim.run.start_sim_minute

        summary = summarize_day(
            day,
            event_log=sim.event_log,
            persona_store=sim.persona_store,
            product_filter=product_filter,
            sim_minute_min=sim_minute_min,
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


def _pace_factor(sim: SimState) -> float:
    """Throttle factor in [0, 1] applied to sim-time advancement.

    Returns 1.0 when dialogue throughput is keeping up with the sim day's
    target, smaller when dialogues are lagging. This couples the visual
    progress to the actual conversations so the user can read them as the
    day visibly unfolds.

    Only active during ``running`` runs; ``idle`` and ``completed`` skip
    advancement entirely (handled in the tick loop).
    """
    target = max(1, int(sim.run.config.target_dialogues_per_day))
    fraction_of_day_elapsed = max(0.0, min(1.0, sim.sim_minute / 1440.0))
    expected = fraction_of_day_elapsed * target
    actual = float(sim.run.dialogues_today)
    if expected <= 0.5:
        return 1.0  # don't throttle the very first minute
    if actual >= expected:
        return 1.0
    # Linear ramp: at 50% of expected, we run at 50% speed; at 0%, we crawl.
    ratio = max(0.05, actual / expected)
    return ratio


async def _complete_run(sim: SimState) -> None:
    """Transition to ``completed`` and emit a cumulative run summary."""
    if sim.run.status != "running":
        return
    # Capture the run's window BEFORE flipping status — the summary
    # filters depend on run.status == 'running' if read via the helpers.
    locked_product = sim.run.config.product_name
    locked_start_min = sim.run.start_sim_minute
    sim.run.status = "completed"
    end_day = sim.day_of_year
    try:
        run_summary = summarize_run(
            start_day=sim.run.start_day,
            end_day=end_day,
            event_log=sim.event_log,
            persona_store=sim.persona_store,
            product_filter=locked_product,
            start_sim_minute=locked_start_min,
        )
        d = run_summary.to_dict()
    except Exception:
        import traceback

        traceback.print_exc()
        d = {
            "start_day": sim.run.start_day,
            "end_day": end_day,
            "days": end_day - sim.run.start_day,
            "config": sim.run.config.to_dict(),
            "error": "summary failed",
        }
    sim.run.last_run_summary = d
    await broadcast(
        sim,
        {
            "type": "simulation_completed",
            "run": sim.run.to_dict(),
            "summary": d,
        },
    )
    await broadcast(sim, {"type": "simulation_status", "run": sim.run.to_dict()})


async def tick_loop(sim: SimState) -> None:
    """Advance the clock and broadcast position deltas to all subscribers."""
    last = time.monotonic()
    while True:
        await asyncio.sleep(TICK_INTERVAL_S)
        now = time.monotonic()
        dt_real = now - last
        last = now

        # Always do positional broadcasts so the viewer has a heartbeat,
        # but only advance the clock during a running simulation.
        running = sim.run.status == "running" and not sim.paused
        if running:
            pace = _pace_factor(sim)
            sim.sim_minute += dt_real * sim.speed_multiplier * pace / 60.0

            # Wrap day
            if sim.sim_minute >= 1440:
                ended_day = sim.day_of_year
                sim.sim_minute -= 1440
                sim.day_of_year += 1
                sim.day_of_week = (sim.day_of_week + 1) % 7
                # Re-plan everyone for the new day
                for a in sim.agents:
                    sim.plans[a.id] = plan_day(
                        a,
                        sim.establishments,
                        day_of_week=sim.day_of_week,
                        seed=sim.day_of_year,
                    )
                # Emit per-day summary, then reset live counters.
                await _emit_day_summary(sim, ended_day)
                # Pay daily SIMCITY wages for the day that just ended.
                # Fire-and-forget so the multi-thousand-tx airdrop doesn't
                # block the tick loop. Idempotent on last_wage_day.
                asyncio.create_task(_pay_daily_wages_async(ended_day))
                sim.stats = _empty_stats()
                sim.run.dialogues_today = 0
                sim.run.days_completed += 1

                # Multi-day completion check
                if sim.run.days_completed >= sim.run.config.total_days:
                    await _complete_run(sim)

        # Broadcast every BROADCAST_EVERY_SIM_MIN sim minutes (always, so the
        # viewer's feed/HUD stays responsive even when the run is idle).
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
                    "run": sim.run.to_dict(),
                },
            )


# ---------------------------------------------------------------------------
# Buyer-avatar reroute (visual sync with dialogues)
# ---------------------------------------------------------------------------


def reroute_buyer_to_establishment(
    sim: SimState,
    *,
    dialogue_id: str,
    buyer_id: str,
    est_cell: tuple[int, int],
    duration_sim_min: int = 20,
) -> None:
    """Splice a SHOP intention into the buyer's plan so they visibly
    walk to the establishment for the duration of the dialogue.

    Snapshots the buyer's current plan in ``sim.rerouted[dialogue_id]`` so
    ``restore_buyer_plan`` can put it back when the dialogue ends.

    Cheap: no pathfinding, just a temporary plan rewrite. The position_for
    interpolator already knows how to render a SHOP intention.
    """
    plan = sim.plans.get(buyer_id)
    if plan is None:
        return
    now_min = int(sim.sim_minute) % 1440
    end_min = min(1439, now_min + duration_sim_min)
    # Snapshot for restore
    sim.rerouted[dialogue_id] = {
        "buyer_id": buyer_id,
        "original_plan": list(plan),
        "end_min": end_min,
    }
    # New plan = drop intentions starting now-or-later, prepend a COMMUTE
    # to the establishment, then a SHOP for the dialogue duration, then
    # the rest of the original schedule.
    kept_past = [i for i in plan if i.start_minute <= now_min]
    kept_future = [i for i in plan if i.start_minute > end_min]
    new_plan = list(kept_past)
    new_plan.append(
        Intention(start_minute=now_min, activity=Activity.COMMUTE, cell=est_cell)
    )
    new_plan.append(
        Intention(start_minute=now_min + 1, activity=Activity.SHOP, cell=est_cell)
    )
    new_plan.append(
        Intention(start_minute=end_min, activity=Activity.LEISURE, cell=est_cell)
    )
    new_plan.extend(kept_future)
    new_plan.sort(key=lambda i: i.start_minute)
    sim.plans[buyer_id] = new_plan


def restore_buyer_plan(sim: SimState, dialogue_id: str) -> None:
    """Restore the buyer's original plan after a rerouted dialogue ends."""
    info = sim.rerouted.pop(dialogue_id, None)
    if not info:
        return
    sim.plans[info["buyer_id"]] = info["original_plan"]


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
        "run": sim.run.to_dict(),
        "last_run_summary": sim.run.last_run_summary,
    }


# ---------------------------------------------------------------------------
# Run lifecycle helpers (called by /api/simulation/* endpoints)
# ---------------------------------------------------------------------------


def start_run(sim: SimState, config: SimulationConfig) -> None:
    """Move the sim into ``running`` with the given config.

    Pure state mutation — the worker pool reconcile + WS broadcast is
    handled by the caller (the FastAPI endpoint), since spawning workers
    needs the loop reference and the on_event callback.
    """
    sim.run.config = config
    sim.run.status = "running"
    sim.run.start_day = sim.day_of_year
    sim.run.start_sim_minute = sim.sim_minute
    sim.run.started_at_real = time.monotonic()
    sim.run.days_completed = 0
    sim.run.dialogues_today = 0
    sim.run.last_run_summary = None
    # Reset per-day counters so a rerun starts fresh visually
    sim.stats = _empty_stats()
    sim.recent_dialogues.clear()
    # Apply agent cap if configured
    if config.agent_cap and config.agent_cap < len(sim.agents):
        sim.active_agent_ids = {a.id for a in sim.agents[: config.agent_cap]}
    else:
        sim.active_agent_ids = set()


async def end_run(sim: SimState) -> None:
    """End the current run early and produce its cumulative report.

    Wraps ``_complete_run`` so the same end-of-day completion path runs
    when the user clicks End mid-run as runs at the natural multi-day
    boundary. Always pairs with a worker-pool teardown by the caller.
    """
    if sim.run.status != "running":
        return
    await _complete_run(sim)


def pause_run(sim: SimState, paused: bool) -> None:
    """Toggle pause without changing the run's lifecycle status.

    The tick loop already gates clock advancement on ``sim.paused`` —
    this is just an affordance for the API endpoint and keeps the run
    in ``running`` so resume is one click away.
    """
    sim.paused = bool(paused)


def reset_run(sim: SimState) -> None:
    """Wipe run state, return to idle. Keeps the world (personas, ENS, etc).

    Resets the clock to 06:00 of a fresh day so the wizard's next launch
    starts visually at sunrise. The product library on disk is untouched.
    """
    sim.run = SimRun()
    sim.sim_minute = 6 * 60.0
    sim.last_broadcast_min = -10.0
    sim.stats = _empty_stats()
    sim.recent_dialogues.clear()
    sim.rerouted.clear()
    sim.active_agent_ids = set()


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

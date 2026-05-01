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

from citysim.world.agents import MODE_SPEED, Agent, generate_agents
from citysim.world.establishments import Establishment, place_establishments
from citysim.world.grid import CityGrid, generate_grid
from citysim.world.schedule import ACTIVITY_CODES, Activity, Intention, plan_day

# How often (in sim minutes) to broadcast position deltas
BROADCAST_EVERY_SIM_MIN = 5

# Real-second cadence of the tick loop. We advance sim_time by speed * dt
# each iteration; smaller dt = smoother, larger dt = cheaper. 0.1s is plenty.
TICK_INTERVAL_S = 0.1


@dataclass
class SimState:
    grid: CityGrid
    establishments: list[Establishment]
    agents: list[Agent]
    plans: dict[str, list[Intention]] = field(default_factory=dict)

    # Clock (minute-of-day, float)
    sim_minute: float = 6 * 60.0  # start at 06:00
    day_of_year: int = 120
    day_of_week: int = 1  # Tuesday

    # Controls
    speed_multiplier: float = 60.0  # 60 = one sim minute per real second
    paused: bool = False

    # Subscribers (asyncio queues of dict messages)
    subscribers: set[asyncio.Queue] = field(default_factory=set)

    # Bookkeeping
    last_broadcast_min: float = -10.0


def build_sim(
    n_agents: int = 1000,
    grid_size: int = 60,
    seed: int = 42,
) -> SimState:
    grid = generate_grid(size=grid_size, seed=seed)
    establishments = place_establishments(grid, seed=seed)
    agents = generate_agents(grid, establishments, n=n_agents, seed=seed)
    sim = SimState(grid=grid, establishments=establishments, agents=agents)
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


async def broadcast(sim: SimState, message: dict) -> None:
    dead: list[asyncio.Queue] = []
    for q in sim.subscribers:
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        sim.subscribers.discard(q)


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
            sim.sim_minute -= 1440
            sim.day_of_year += 1
            sim.day_of_week = (sim.day_of_week + 1) % 7
            # Re-plan everyone for the new day
            for a in sim.agents:
                sim.plans[a.id] = plan_day(
                    a, sim.establishments, day_of_week=sim.day_of_week, seed=sim.day_of_year
                )

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
                },
            )


def init_payload(sim: SimState) -> dict:
    """Initial message sent on a new WebSocket connection."""
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
    }


def apply_control(sim: SimState, message: dict) -> None:
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


def iter_subscribers(sim: SimState) -> Iterable[asyncio.Queue]:
    return list(sim.subscribers)

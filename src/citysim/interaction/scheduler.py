"""Background dialogue scheduler.

Runs continuously alongside the FastAPI tick loop. Picks a random
buyer / shoppable-establishment / employee triple from the live
``SimState``, runs a buyer-seller dialogue through the local LLM, and
appends the result to the ``EventLog`` tagged with the current
``sim_minute`` and ``day_of_year``.

Each dialogue is run in a worker thread (``asyncio.to_thread``) so the
LLM call never blocks the asyncio event loop or starves the WebSocket
broadcast.

The scheduler is a *crude* rate-limiter: one dialogue at a time, with a
configurable ``pause_s`` real-second sleep between attempts. The actual
cadence is dominated by how long the local model takes to generate each
turn — typically 3-10 seconds for a 6-turn dialogue on an 8B-class
model. At default settings this produces dozens of dialogues per
simulated day at 60x speed; fewer at higher sim speeds (the LLM, not the
clock, becomes the bottleneck).
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
from typing import TYPE_CHECKING

from citysim.interaction.runner import (
    pick_random_buyer,
    pick_random_store,
    run_dialogue,
)
from citysim.store import EventLog

if TYPE_CHECKING:
    from citysim.server.sim import SimState

log = logging.getLogger("citysim.scheduler")


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


async def dialogue_worker(
    sim: SimState,
    event_log: EventLog,
    *,
    pause_s: float | None = None,
    max_turns: int | None = None,
    extract_outcome: bool = True,
) -> None:
    """Continuously fire one dialogue at a time.

    Tunables (env vars override defaults):

    - ``CITYSIM_DIALOGUE_PAUSE_S`` (default 5.0) — real-second sleep
      between dialogues. Sets the floor on dialogue cadence.
    - ``CITYSIM_DIALOGUE_MAX_TURNS`` (default 6) — hard cap on turn count.
    """
    rng = random.Random()
    actual_pause = pause_s if pause_s is not None else _env_float("CITYSIM_DIALOGUE_PAUSE_S", 5.0)
    actual_turns = max_turns if max_turns is not None else _env_int("CITYSIM_DIALOGUE_MAX_TURNS", 6)

    log.info(
        "dialogue_worker: starting (pause=%.1fs, max_turns=%d, extract=%s)",
        actual_pause,
        actual_turns,
        extract_outcome,
    )

    while True:
        try:
            await asyncio.sleep(actual_pause)

            if not sim.personas or not sim.establishments:
                continue
            if sim.paused:
                continue

            picked = pick_random_store(sim.establishments, sim.personas, rng)
            if picked is None:
                continue
            est, seller = picked
            buyer = pick_random_buyer(sim.personas, rng)
            if buyer.agent_id == seller.agent_id:
                continue

            sim_minute = sim.sim_minute
            day = sim.day_of_year

            await asyncio.to_thread(
                run_dialogue,
                buyer,
                seller,
                est,
                max_turns=actual_turns,
                extract_outcome=extract_outcome,
                log_to=event_log,
                sim_minute=sim_minute,
                day_of_year=day,
            )
            log.debug(
                "dialogue: buyer=%s seller=%s est=%s day=%d",
                buyer.agent_id,
                seller.agent_id,
                est.id,
                day,
            )
        except asyncio.CancelledError:
            log.info("dialogue_worker: cancelled, exiting")
            raise
        except Exception:
            log.exception("dialogue_worker: error in iteration; continuing")


__all__ = ["dialogue_worker"]

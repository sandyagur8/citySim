"""Background dialogue scheduler.

Runs continuously alongside the FastAPI tick loop. Picks a random
buyer / shoppable-establishment / employee triple from the live
``SimState``, runs a buyer-seller dialogue through the local LLM, and
appends the result to the ``EventLog`` tagged with the current
``sim_minute`` and ``day_of_year``.

Each dialogue is run in a worker thread (``asyncio.to_thread``) so the
LLM call never blocks the asyncio event loop or starves the WebSocket
broadcast.

When a ``ProductBrief`` is loaded (``~/.citysim/product.json``) the
scheduler enters **product-test mode**:

* It alternates between two A/B arms — ``random`` (uniform sample of
  the 10k population) and ``targeted`` (only personas matching the
  brief's structured target filter).
* Establishments matching ``product.category`` run **product**
  dialogues — the seller pitches the brief's product, and the audit
  extractor pulls the rich schema (motivator, winning phrase,
  objections, target_fit).
* Other establishments run **generic** baseline dialogues — useful as
  a control to compare against.

Without a brief, the scheduler runs in pure city-sim mode: random
buyer, random shoppable establishment, generic dialogues.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from citysim.interaction.runner import (
    SHOPPABLE_KINDS,
    find_employee,
    pick_random_buyer,
    pick_random_store,
    run_dialogue,
)
from citysim.product import ProductBrief, load_product, matches_target
from citysim.store import EventLog
from citysim.world.establishments import Establishment
from citysim.world.personas import Persona

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


def _pick_targeted_buyer(
    personas: list[Persona],
    brief: ProductBrief,
    rng: random.Random,
) -> Persona | None:
    """Pick a random adult who matches the brief's target filter."""
    pool = [p for p in personas if 18 <= p.age <= 75 and matches_target(p, brief)]
    if not pool:
        return None
    return rng.choice(pool)


def _pick_product_store(
    establishments: list[Establishment],
    personas: list[Persona],
    brief: ProductBrief,
    rng: random.Random,
) -> tuple[Establishment, Persona] | None:
    """Pick a random establishment of the brief's category that has employees."""
    target_kind = brief.category_kind()
    candidates = [e for e in establishments if e.kind == target_kind]
    rng.shuffle(candidates)
    for est in candidates:
        emp = find_employee(est, personas)
        if emp is not None:
            return est, emp
    return None


def _pick_generic_store(
    establishments: list[Establishment],
    personas: list[Persona],
    brief: ProductBrief | None,
    rng: random.Random,
) -> tuple[Establishment, Persona] | None:
    """Pick a random shoppable establishment that is NOT the product's category.

    Used to sample baseline (non-product) dialogues when a brief is set.
    """
    excl = brief.category_kind() if brief is not None else None
    candidates = [e for e in establishments if e.kind in SHOPPABLE_KINDS and e.kind != excl]
    rng.shuffle(candidates)
    for est in candidates:
        emp = find_employee(est, personas)
        if emp is not None:
            return est, emp
    return None


async def dialogue_worker(
    sim: SimState,
    event_log: EventLog,
    *,
    pause_s: float | None = None,
    max_turns: int | None = None,
    extract_outcome: bool = True,
    on_event: Callable[[dict[str, Any]], None] | None = None,
) -> None:
    """Continuously fire one dialogue at a time.

    Tunables (env vars override defaults):

    - ``CITYSIM_DIALOGUE_PAUSE_S`` (default 5.0) — real-second sleep
      between dialogues. Sets the floor on dialogue cadence.
    - ``CITYSIM_DIALOGUE_MAX_TURNS`` (default 6) — hard cap on turn count.
    - ``CITYSIM_BASELINE_RATIO`` (default 0.25) — fraction of dialogues
      that target non-product shops as a baseline. Only matters when a
      product brief is loaded.
    """
    rng = random.Random()
    actual_pause = pause_s if pause_s is not None else _env_float("CITYSIM_DIALOGUE_PAUSE_S", 5.0)
    actual_turns = max_turns if max_turns is not None else _env_int("CITYSIM_DIALOGUE_MAX_TURNS", 6)
    baseline_ratio = max(0.0, min(1.0, _env_float("CITYSIM_BASELINE_RATIO", 0.25)))

    brief = load_product()
    # Note the file's mtime so we can hot-reload when the REST CRUD endpoints
    # rewrite product.json. Avoids restarting the server during a demo.
    from citysim.product import default_product_path

    product_path = default_product_path()
    last_mtime: float = product_path.stat().st_mtime if product_path.exists() else 0.0
    if brief is not None:
        log.info(
            "dialogue_worker: PRODUCT mode - '%s' at %s, $%.2f. Target: ages=%s, income=%s",
            brief.name,
            brief.category,
            brief.price,
            brief.target.age_bands or "any",
            brief.target.income_bands or "any",
        )
    else:
        log.info("dialogue_worker: GENERIC mode (no product brief loaded)")

    log.info(
        "dialogue_worker: pause=%.1fs, max_turns=%d, extract=%s, baseline_ratio=%.2f",
        actual_pause,
        actual_turns,
        extract_outcome,
        baseline_ratio,
    )

    iteration = 0
    while True:
        try:
            await asyncio.sleep(actual_pause)

            if not sim.personas or not sim.establishments:
                continue
            if sim.paused:
                continue

            # Hot-reload the brief if product.json has changed on disk.
            try:
                if product_path.exists():
                    mtime = product_path.stat().st_mtime
                    if mtime != last_mtime:
                        new_brief = load_product()
                        if (new_brief is None) != (brief is None) or (
                            new_brief is not None
                            and brief is not None
                            and new_brief.to_dict() != brief.to_dict()
                        ):
                            brief = new_brief
                            log.info(
                                "dialogue_worker: reloaded product brief (%s)",
                                brief.name if brief else "cleared",
                            )
                        last_mtime = mtime
                elif last_mtime > 0.0:
                    # File deleted -> drop into generic mode
                    if brief is not None:
                        log.info("dialogue_worker: product brief cleared from disk")
                    brief = None
                    last_mtime = 0.0
            except Exception:
                log.debug("dialogue_worker: brief reload check failed", exc_info=True)

            iteration += 1

            # ---------- Decide arm + store + buyer ----------
            if brief is not None:
                # Decide whether THIS dialogue is product or baseline-generic.
                run_baseline = rng.random() < baseline_ratio

                if run_baseline:
                    picked = _pick_generic_store(sim.establishments, sim.personas, brief, rng)
                    arm = "random"
                    targeted = False
                    buyer = pick_random_buyer(sim.personas, rng)
                else:
                    picked = _pick_product_store(sim.establishments, sim.personas, brief, rng)
                    # Alternate A/B arms across product dialogues
                    use_targeted = iteration % 2 == 0
                    if use_targeted:
                        targeted_buyer = _pick_targeted_buyer(sim.personas, brief, rng)
                        if targeted_buyer is None:
                            # Target filter matches no one - fall back to random
                            buyer = pick_random_buyer(sim.personas, rng)
                            arm, targeted = "random", False
                        else:
                            buyer = targeted_buyer
                            arm, targeted = "targeted", True
                    else:
                        buyer = pick_random_buyer(sim.personas, rng)
                        arm = "random"
                        # Even random-arm buyers may incidentally match
                        targeted = matches_target(buyer, brief)
            else:
                # No product brief - pure generic mode
                picked = pick_random_store(sim.establishments, sim.personas, rng)
                buyer = pick_random_buyer(sim.personas, rng)
                arm = "random"
                targeted = False

            if picked is None:
                continue
            est, seller = picked
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
                product=brief,
                arm=arm,
                targeted=targeted,
                on_event=on_event,
            )
            log.debug(
                "dialogue: buyer=%s seller=%s est=%s arm=%s targeted=%s day=%d",
                buyer.agent_id,
                seller.agent_id,
                est.id,
                arm,
                targeted,
                day,
            )
        except asyncio.CancelledError:
            log.info("dialogue_worker: cancelled, exiting")
            raise
        except Exception:
            log.exception("dialogue_worker: error in iteration; continuing")


__all__ = ["dialogue_worker"]

"""FastAPI app exposing the simulator over HTTP and WebSocket.

Endpoints:
- GET    /api/health           liveness probe
- GET    /api/world            one-shot dump of the current world (debug)
- GET    /api/product          current product brief (or 404)
- POST   /api/product          create / replace the product brief
- DELETE /api/product          clear the product brief
- GET    /api/summary/{day}    structured day summary
- GET    /api/summary/latest   most-recently computed day summary
- WS     /ws                   live stream: init + tick deltas + dialogue events + control
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from citysim.interaction import dialogue_worker
from citysim.product import (
    ProductBrief,
    clear_product,
    load_product,
    save_product,
)
from citysim.reporting import format_summary, summarize_day
from citysim.server.sim import (
    SimState,
    apply_control,
    broadcast,
    build_sim,
    init_payload,
    record_dialogue_event,
    tick_loop,
)

log = logging.getLogger("citysim.server")


def create_app(
    n_agents: int = 100,
    grid_size: int = 60,
    seed: int = 42,
    *,
    max_establishments_per_kind: int | None = 5,
    auto_dialogue: bool | None = None,
) -> FastAPI:
    sim_holder: dict[str, SimState] = {}
    tick_task: dict[str, asyncio.Task[Any]] = {}
    dialogue_task: dict[str, asyncio.Task[Any]] = {}

    # Auto-dialogue is on by default; disable with auto_dialogue=False
    # or env var CITYSIM_AUTO_DIALOGUE=0/false.
    if auto_dialogue is None:
        env_val = os.environ.get("CITYSIM_AUTO_DIALOGUE", "1").strip().lower()
        auto_dialogue = env_val not in {"0", "false", "no", "off"}

    @asynccontextmanager
    async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
        log.info("Building sim with n_agents=%d grid_size=%d", n_agents, grid_size)
        sim = build_sim(
            n_agents=n_agents,
            grid_size=grid_size,
            seed=seed,
            max_establishments_per_kind=max_establishments_per_kind,
        )
        sim_holder["sim"] = sim
        tick_task["task"] = asyncio.create_task(tick_loop(sim))
        log.info(
            "Sim ready: %d establishments, %d agents", len(sim.establishments), len(sim.agents)
        )
        if auto_dialogue and sim.event_log is not None:
            loop = asyncio.get_running_loop()

            def _on_event(event: dict[str, Any]) -> None:
                """Bridge from worker thread → asyncio event loop.

                The dialogue runs inside ``asyncio.to_thread``, so we hop
                back to the loop to update sim state and broadcast.
                """

                def _apply() -> None:
                    try:
                        record_dialogue_event(sim, event)
                    except Exception:  # noqa: BLE001
                        log.exception("record_dialogue_event failed")
                    # Schedule the broadcast on the event loop
                    asyncio.create_task(broadcast(sim, event))

                loop.call_soon_threadsafe(_apply)

            dialogue_task["task"] = asyncio.create_task(
                dialogue_worker(sim, sim.event_log, on_event=_on_event)
            )
            log.info("Auto-dialogue worker started (live event stream enabled)")
        else:
            log.info("Auto-dialogue worker disabled")
        try:
            yield
        finally:
            tick_task["task"].cancel()
            try:
                await tick_task["task"]
            except (asyncio.CancelledError, Exception):
                pass
            if "task" in dialogue_task:
                dialogue_task["task"].cancel()
                try:
                    await dialogue_task["task"]
                except (asyncio.CancelledError, Exception):
                    pass

    app = FastAPI(title="Sim-city", lifespan=lifespan)

    # CORS for local dev: Vite serves the viewer on :5173, server runs on :8000.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/world")
    async def world() -> dict[str, Any]:
        sim = sim_holder["sim"]
        return init_payload(sim)

    # ---------- Product brief CRUD ----------

    @app.get("/api/product")
    async def get_product() -> dict[str, Any]:
        brief = load_product()
        if brief is None:
            raise HTTPException(status_code=404, detail="No product brief loaded")
        return brief.to_dict()

    @app.post("/api/product")
    async def post_product(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            brief = ProductBrief.from_dict(payload)
        except (KeyError, ValueError, TypeError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid product brief: {e}") from e
        # Validate category against EstablishmentKind
        try:
            brief.category_kind()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        save_product(brief)
        # Tell every connected viewer the product changed.
        sim = sim_holder.get("sim")
        if sim is not None:
            await broadcast(sim, {"type": "product_updated", "product": brief.to_dict()})
        return brief.to_dict()

    @app.delete("/api/product")
    async def delete_product() -> dict[str, bool]:
        removed = clear_product()
        sim = sim_holder.get("sim")
        if sim is not None:
            await broadcast(sim, {"type": "product_updated", "product": None})
        return {"removed": removed}

    # ---------- Day summaries ----------

    @app.get("/api/summary/latest")
    async def latest_summary() -> dict[str, Any]:
        sim = sim_holder.get("sim")
        if sim is None or sim.last_day_summary is None:
            raise HTTPException(status_code=404, detail="No summary available yet")
        return sim.last_day_summary

    @app.get("/api/summary/{day}")
    async def get_summary(day: int) -> dict[str, Any]:
        sim = sim_holder.get("sim")
        if sim is None or sim.event_log is None:
            raise HTTPException(status_code=503, detail="Sim not ready")
        summary = summarize_day(
            day,
            event_log=sim.event_log,
            persona_store=sim.persona_store,
        )
        d = summary.to_dict()
        d["text"] = format_summary(summary)
        return d

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        sim = sim_holder["sim"]
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
        sim.subscribers.add(queue)

        # Send init
        await websocket.send_text(json.dumps(init_payload(sim)))

        # Concurrent send + receive
        async def sender() -> None:
            while True:
                msg = await queue.get()
                await websocket.send_text(json.dumps(msg))

        async def receiver() -> None:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                apply_control(sim, msg)

        tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
        try:
            await asyncio.gather(*tasks)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.warning("ws error: %s", e)
        finally:
            for t in tasks:
                t.cancel()
            sim.subscribers.discard(queue)

    return app


# Module-level app for `uvicorn citysim.server.app:app`
app = create_app()

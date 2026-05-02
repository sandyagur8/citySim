"""FastAPI app exposing the simulator over HTTP and WebSocket.

Endpoints:
- GET /api/health             liveness probe
- GET /api/world              one-shot dump of the current world (debug)
- WS  /ws                     live stream: init payload + tick deltas + control
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from citysim.server.sim import (
    SimState,
    apply_control,
    build_sim,
    init_payload,
    tick_loop,
)

log = logging.getLogger("citysim.server")


def create_app(n_agents: int = 1000, grid_size: int = 60, seed: int = 42) -> FastAPI:
    sim_holder: dict[str, SimState] = {}
    tick_task: dict[str, asyncio.Task[Any]] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
        log.info("Building sim with n_agents=%d grid_size=%d", n_agents, grid_size)
        sim = build_sim(n_agents=n_agents, grid_size=grid_size, seed=seed)
        sim_holder["sim"] = sim
        tick_task["task"] = asyncio.create_task(tick_loop(sim))
        log.info(
            "Sim ready: %d establishments, %d agents", len(sim.establishments), len(sim.agents)
        )
        try:
            yield
        finally:
            tick_task["task"].cancel()
            try:
                await tick_task["task"]
            except (asyncio.CancelledError, Exception):
                pass

    app = FastAPI(title="Sim-city", lifespan=lifespan)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/world")
    async def world() -> dict[str, Any]:
        sim = sim_holder["sim"]
        return init_payload(sim)

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

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
import http
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
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
    dialogue_tasks: list[asyncio.Task[Any]] = []
    axl_node_processes: list[subprocess.Popen[Any]] = []
    on_event_holder: dict[str, Any] = {}
    desired_dialogue_workers = max(
        1,
        int(os.environ.get("CITYSIM_DIALOGUE_WORKERS", "1")),
    )

    async def _reconcile_dialogue_workers(target_count: int) -> None:
        nonlocal desired_dialogue_workers
        desired_dialogue_workers = max(1, target_count)
        sim = sim_holder.get("sim")
        if sim is None or not auto_dialogue or sim.event_log is None:
            return

        current = len(dialogue_tasks)
        on_event_cb = on_event_holder.get("cb")
        if desired_dialogue_workers > current:
            for i in range(current, desired_dialogue_workers):
                task = asyncio.create_task(
                    dialogue_worker(
                        sim,
                        sim.event_log,
                        worker_id=i + 1,
                        initial_jitter_s=float(i) * 0.5,
                        on_event=on_event_cb,
                    )
                )
                dialogue_tasks.append(task)
        elif desired_dialogue_workers < current:
            to_stop = dialogue_tasks[desired_dialogue_workers:]
            del dialogue_tasks[desired_dialogue_workers:]
            for t in to_stop:
                t.cancel()
            for t in to_stop:
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
        log.info("Auto-dialogue workers active=%d", len(dialogue_tasks))

    # Auto-dialogue is on by default; disable with auto_dialogue=False
    # or env var CITYSIM_AUTO_DIALOGUE=0/false.
    if auto_dialogue is None:
        env_val = os.environ.get("CITYSIM_AUTO_DIALOGUE", "1").strip().lower()
        auto_dialogue = env_val not in {"0", "false", "no", "off"}

    autos_spawn_axl = os.environ.get("CITYSIM_AXL_AUTOSPAWN", "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    desired_axl_nodes = max(1, int(os.environ.get("CITYSIM_AXL_NODE_COUNT", "2")))
    repo_root = Path(__file__).resolve().parents[4]
    axl_bin = repo_root / "axl" / "node"
    axl_cfg_dir = repo_root / "axl_integration"

    def _discover_node_configs() -> list[Path]:
        cfgs = sorted(axl_cfg_dir.glob("node*-config.json"))
        return cfgs

    def _config_port(cfg_path: Path) -> int | None:
        try:
            raw = json.loads(cfg_path.read_text(encoding="utf-8"))
            return int(raw.get("api_port"))
        except Exception:
            return None

    async def _reconcile_axl_nodes(target_count: int) -> None:
        nonlocal desired_axl_nodes
        desired_axl_nodes = max(1, target_count)
        os.environ["CITYSIM_AXL_NODE_COUNT"] = str(desired_axl_nodes)
        if not autos_spawn_axl:
            return

        cfgs = _discover_node_configs()
        if not cfgs:
            log.warning("AXL autospawn enabled but no node configs found in %s", axl_cfg_dir)
            return
        target = min(desired_axl_nodes, len(cfgs))
        if desired_axl_nodes > len(cfgs):
            log.warning("Requested %d AXL nodes, only %d configs found", desired_axl_nodes, len(cfgs))

        current = len(axl_node_processes)
        if target > current:
            for i in range(current, target):
                cfg = cfgs[i]
                if not axl_bin.exists():
                    log.warning("AXL binary not found at %s", axl_bin)
                    break
                p = subprocess.Popen(  # noqa: S603
                    [str(axl_bin), "-config", str(cfg)],
                    cwd=str(axl_bin.parent),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                axl_node_processes.append(p)
                log.info("AXL node spawned cfg=%s pid=%s", cfg.name, p.pid)
            await asyncio.sleep(0.4)
        elif target < current:
            to_stop = axl_node_processes[target:]
            del axl_node_processes[target:]
            for p in to_stop:
                try:
                    p.terminate()
                except Exception:
                    pass
            await asyncio.sleep(0.2)
            for p in to_stop:
                try:
                    if p.poll() is None:
                        p.kill()
                except Exception:
                    pass
            log.info("AXL nodes reduced. active=%d", len(axl_node_processes))

        active_cfgs = cfgs[: len(axl_node_processes)]
        ports = [str(p) for p in (_config_port(c) for c in active_cfgs) if p is not None]
        if ports:
            os.environ["CITYSIM_AXL_NODE_PORTS"] = ",".join(ports)

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

            on_event_holder["cb"] = _on_event
            await _reconcile_axl_nodes(desired_axl_nodes)
            await _reconcile_dialogue_workers(desired_dialogue_workers)
            log.info("Auto-dialogue worker pool ready (live event stream enabled)")
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
            for t in dialogue_tasks:
                t.cancel()
            for t in dialogue_tasks:
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
            for p in axl_node_processes:
                try:
                    p.terminate()
                except Exception:
                    pass
            await asyncio.sleep(0.2)
            for p in axl_node_processes:
                try:
                    if p.poll() is None:
                        p.kill()
                except Exception:
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

    @app.get("/api/health/deps")
    async def health_deps() -> dict[str, Any]:
        out: dict[str, Any] = {"status": "ok", "deps": {}}

        llm_provider = os.environ.get("CITYSIM_LLM_PROVIDER", "ollama-openai").strip().lower()
        if llm_provider == "ollama-openai":
            base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1").rstrip("/")
            tags_url = base.removesuffix("/v1") + "/api/tags"
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    resp = await client.get(tags_url)
                ok = resp.status_code == http.HTTPStatus.OK
                out["deps"]["ollama"] = {"ok": ok, "url": tags_url, "status_code": resp.status_code}
                if not ok:
                    out["status"] = "degraded"
            except Exception as e:  # noqa: BLE001
                out["deps"]["ollama"] = {"ok": False, "url": tags_url, "error": str(e)}
                out["status"] = "degraded"

        if os.environ.get("CITYSIM_TRANSPORT", "local").strip().lower() == "axl":
            for node, port_env in (("nodeA", "CITYSIM_AXL_NODE_A_PORT"), ("nodeB", "CITYSIM_AXL_NODE_B_PORT")):
                port = int(os.environ.get(port_env, "9002" if node == "nodeA" else "9012"))
                url = f"http://127.0.0.1:{port}/topology"
                try:
                    async with httpx.AsyncClient(timeout=2.0) as client:
                        resp = await client.get(url)
                    ok = resp.status_code == http.HTTPStatus.OK
                    out["deps"][node] = {"ok": ok, "url": url, "status_code": resp.status_code}
                    if not ok:
                        out["status"] = "degraded"
                except Exception as e:  # noqa: BLE001
                    out["deps"][node] = {"ok": False, "url": url, "error": str(e)}
                    out["status"] = "degraded"
        return out

    @app.get("/api/world")
    async def world() -> dict[str, Any]:
        sim = sim_holder["sim"]
        return init_payload(sim)

    @app.get("/api/agent/by-ens/{ens_name:path}")
    async def agent_by_ens(ens_name: str) -> dict[str, Any]:
        sim = sim_holder.get("sim")
        if sim is None or sim.persona_store is None:
            raise HTTPException(status_code=503, detail="Sim not ready")

        query = ens_name.strip()
        if not query:
            raise HTTPException(status_code=400, detail="ENS name required")

        row = sim.persona_store.get_by_ens_name(query)
        if row is None:
            raise HTTPException(status_code=404, detail=f"No agent found for ENS: {query}")

        est = None
        if row.employer_id:
            est = next((e for e in sim.establishments if e.id == row.employer_id), None)

        return {
            "agent_id": row.agent_id,
            "ens_name": row.ens_name,
            "ens_status": row.ens_status,
            "wallet_address": row.wallet_address,
            "axl_key": row.axl_key,
            "demographics": {
                "age": row.age,
                "gender": row.gender,
                "education": row.education,
                "income_band": row.income_band,
                "occupation": row.occupation,
                "household_role": row.household_role,
            },
            "home_cell": [row.home_x, row.home_y],
            "work_cell": [row.work_x, row.work_y] if row.work_x is not None and row.work_y is not None else None,
            "card_text": row.card_text,
            "prefs": row.prefs,
            "needs": row.needs,
            "establishment": (
                {
                    "id": est.id,
                    "kind": est.kind.value,
                    "cell": [est.cell[0], est.cell[1]],
                    "name": f"{est.kind.value.replace('_', ' ').title()} {est.id}",
                }
                if est is not None
                else None
            ),
        }

    @app.patch("/api/agent/by-ens/{ens_name:path}/persona")
    async def update_agent_persona_by_ens(
        ens_name: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        sim = sim_holder.get("sim")
        if sim is None or sim.persona_store is None:
            raise HTTPException(status_code=503, detail="Sim not ready")

        query = ens_name.strip()
        if not query:
            raise HTTPException(status_code=400, detail="ENS name required")

        row = sim.persona_store.get_by_ens_name(query)
        if row is None:
            raise HTTPException(status_code=404, detail=f"No agent found for ENS: {query}")

        changed = False
        if "occupation" in payload:
            occ = str(payload.get("occupation") or "").strip()
            if not occ:
                raise HTTPException(status_code=400, detail="occupation cannot be empty")
            row.occupation = occ
            changed = True
        if "card_text" in payload:
            card = str(payload.get("card_text") or "").strip()
            if not card:
                raise HTTPException(status_code=400, detail="card_text cannot be empty")
            row.card_text = card
            changed = True

        if not changed:
            raise HTTPException(status_code=400, detail="No editable persona fields provided")

        sim.persona_store.insert_many([row])

        persona = sim.persona_by_id.get(row.agent_id)
        if persona is not None:
            persona.occupation = row.occupation
            persona.card_text = row.card_text
        for agent in sim.agents:
            if agent.id == row.agent_id:
                agent.occupation = row.occupation
                break

        return {"ok": True, "agent_id": row.agent_id, "ens_name": row.ens_name}

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
                if msg.get("type") == "set_dialogue_workers":
                    try:
                        target = int(msg.get("value", desired_dialogue_workers))
                    except (ValueError, TypeError):
                        continue
                    await _reconcile_dialogue_workers(target)
                elif msg.get("type") == "set_axl_node_count":
                    try:
                        target = int(msg.get("value", desired_axl_nodes))
                    except (ValueError, TypeError):
                        continue
                    await _reconcile_axl_nodes(target)
                else:
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

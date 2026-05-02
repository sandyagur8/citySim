#!/usr/bin/env python3
"""Phase 8 baseline benchmark for sim-city dialogue runtime.

Runs N sampled dialogues and reports latency + error rates.

Usage:
  source .venv/bin/activate
  python scripts/phase8_benchmark.py --n-agents 1000 --runs 50
"""

from __future__ import annotations

import argparse
import os
import random
import statistics
import time

from citysim.interaction.runner import find_employee, pick_random_buyer, pick_random_store, run_dialogue
from citysim.interaction.transport import AxlTransport, LocalTransport
from citysim.server.sim import build_sim


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--n-agents", type=int, default=100)
    p.add_argument("--grid-size", type=int, default=80)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--runs", type=int, default=20)
    p.add_argument("--max-turns", type=int, default=6)
    p.add_argument("--transport", choices=["local", "axl"], default=os.environ.get("CITYSIM_TRANSPORT", "local"))
    p.add_argument("--transport-required", action="store_true")
    p.add_argument("--no-extract", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    print(f"[build] n_agents={args.n_agents} grid={args.grid_size} seed={args.seed}")
    sim = build_sim(n_agents=args.n_agents, grid_size=args.grid_size, seed=args.seed)

    rng = random.Random(args.seed)
    transport = AxlTransport.from_env() if args.transport == "axl" else LocalTransport()

    durations: list[float] = []
    failures = 0
    purchases = 0

    for i in range(args.runs):
        picked = pick_random_store(sim.establishments, sim.personas, rng)
        if picked is None:
            print(f"[run {i+1}] skipped: no store with employee")
            continue
        est, seller = picked
        buyer = pick_random_buyer(sim.personas, rng)
        if buyer.agent_id == seller.agent_id:
            seller = find_employee(est, sim.personas) or seller
            if buyer.agent_id == seller.agent_id:
                print(f"[run {i+1}] skipped: buyer==seller")
                continue

        t0 = time.perf_counter()
        try:
            res = run_dialogue(
                buyer,
                seller,
                est,
                max_turns=args.max_turns,
                extract_outcome=not args.no_extract,
                transport=transport,
                transport_required=args.transport_required,
            )
            dt = time.perf_counter() - t0
            durations.append(dt)
            bought = bool((res.outcome or {}).get("purchased") or res.end_reason == "buy")
            purchases += 1 if bought else 0
            print(f"[run {i+1}] ok end={res.end_reason} turns={len(res.turns)} dur={dt:.2f}s")
        except Exception as e:  # noqa: BLE001
            failures += 1
            dt = time.perf_counter() - t0
            print(f"[run {i+1}] fail dur={dt:.2f}s err={e}")

    ok = len(durations)
    print("\n=== Phase 8 Baseline ===")
    print(f"runs={args.runs} ok={ok} failed={failures} purchase_ok={purchases}")
    if durations:
        p50 = statistics.median(durations)
        p95 = sorted(durations)[max(0, int(len(durations) * 0.95) - 1)]
        avg = sum(durations) / len(durations)
        print(f"latency_s avg={avg:.2f} p50={p50:.2f} p95={p95:.2f} max={max(durations):.2f}")

    return 0 if failures == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())

# Sim-city

A synthetic city simulator for product testing. One million LLM-backed agents living recognisable urban lives — they wake, work, parent, gossip, shop, eat, save, splurge, regret — so a product team can drop a new SKU into the world and watch how it spreads, who buys it, what they say to the salesperson, and which personas resist.

The full design is in [`docs/design.md`](docs/design.md). This README covers how to run what's built.

## Status

Phase 0a, "visual interface first" slice. No LLM dialogue yet. The current build shows a procedurally generated city with a day-night cycle and ~1000 agents moving through their schedules. The architecture is set up so the LLM dialogue layer drops in cleanly later without touching the visual.

## Quick start

You need Python 3.10+, Node 20+, and pnpm (or npm).

```bash
# 1. Backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
citysim serve                      # starts FastAPI on :8000

# 2. Frontend (in another terminal)
cd viewer
pnpm install                       # or npm install
pnpm dev                           # opens http://localhost:5173
```

Open http://localhost:5173 in a browser. You'll see a stylised top-down city grid with zoning colours, ~1000 agent dots moving through a simulated day, and a day-night overlay that shifts the lighting from sunrise through midday, sunset, and overnight. Top bar has play/pause and speed controls (1×, 4×, 16×, 60×). Click an agent to see its current intention; click an establishment to see today's footfall.

## What's wired

- Procedural city generator with zoning (residential, commercial, industrial, civic, parks)
- Solar position calculator driving sunrise/sunset based on latitude and date
- Mock daily-schedule planner per agent (sleep, commute, work, lunch, errands, leisure, sleep)
- FastAPI WebSocket server streaming agent position deltas every 5 simulated minutes
- React + deck.gl viewer with three view modes (agent, heatmap, conversion-placeholder)
- Tailwind UI for time controls and side panels

## What's next

In rough order: the local-LLM gateway (Ollama-backed FastAPI shim with tier routing), the persona generator (synthetic population from joint distributions), the interaction runner (buyer/seller dialogue loop), the outcome extractor (structured JSON from dialogues). See `docs/design.md` §17–§18 for the roadmap.

## Repo layout

```
src/citysim/         Python backend
  world/             grid, solar, schedules, agents, establishments
  server/            FastAPI app + WebSocket
viewer/              React + Vite + deck.gl frontend
docs/design.md       Full system design
tests/               Smoke tests
```

## Licence

Private project. Not for redistribution.

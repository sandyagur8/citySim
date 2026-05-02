#!/usr/bin/env bash
#
# One-shot setup script for the Sim-city repo.
#
# What it does, in order:
#   1. Re-initialises git from a clean slate (the previous .git inside the
#      sandbox got into a weird state that I couldn't unlock from there;
#      starting fresh on your Mac avoids that whole mess).
#   2. Creates three logical commits so the history reads as a real project:
#        a. scaffold (README, pyproject, design doc, CI, ignore)
#        b. world + server (grid, establishments, agents, schedule, simulator)
#        c. viewer (deck.gl frontend + day-night overlay + time controls)
#   3. Optionally creates the GitHub repo `melbin/Sim-city` (private) and
#      pushes main to it via the `gh` CLI.
#
# Usage:
#   cd /path/to/Sim-city
#   bash scripts/setup-and-push.sh           # commits only, no push
#   bash scripts/setup-and-push.sh --push    # also `gh repo create … --push`
#
# Requirements for --push: the `gh` CLI installed and authenticated
# (`gh auth login`). Without --push the script just leaves you with three
# clean local commits and you can push manually however you like.

set -euo pipefail

PUSH=false
if [[ "${1:-}" == "--push" ]]; then
  PUSH=true
fi

# ---------------------------------------------------------------------------
# 0. sanity check we are at the repo root
# ---------------------------------------------------------------------------
if [[ ! -f pyproject.toml || ! -d viewer || ! -d src/citysim ]]; then
  echo "Run this from the Sim-city repo root (the folder containing pyproject.toml, src/, and viewer/)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. reset .git
# ---------------------------------------------------------------------------
if [[ -d .git ]]; then
  echo "→ Removing existing .git/"
  rm -rf .git
fi

echo "→ git init (main branch)"
git init -b main >/dev/null

git config user.name  "${GIT_USER_NAME:-$(git config --global user.name 2>/dev/null || echo 'Melbin')}"
git config user.email "${GIT_USER_EMAIL:-$(git config --global user.email 2>/dev/null || echo 'melbin@devdock.ai')}"

# ---------------------------------------------------------------------------
# 2. three logical commits
# ---------------------------------------------------------------------------

echo "→ commit 1/3: scaffold"
git add \
  .gitignore \
  README.md \
  pyproject.toml \
  docs/design.md \
  .github 2>/dev/null || true
git add -A -- .gitignore README.md pyproject.toml docs .github
git commit -m "Scaffold: README, design doc, pyproject, CI workflow

- Project layout: src/citysim, viewer/, tests/, docs/
- pyproject with FastAPI, Pydantic v2, numpy, typer
- Master design doc covering personas, needs, dialogue, scaling, visuals
- Phase 0a: visual interface first (no LLM yet)" >/dev/null

echo "→ commit 2/3: world + server"
git add \
  src/citysim/__init__.py \
  src/citysim/cli.py \
  src/citysim/world \
  src/citysim/server \
  tests
git commit -m "World + server: grid, establishments, agents, schedule, sim loop

World layer:
  - 60×60 grid with radial zoning (commercial core, residential ring,
    industrial wedges, parks, civic landmarks)
  - 14 establishment kinds placed by zoning density (~700 at default size)
  - 1k synthetic agents with home, optional work, transport mode
  - Per-day plan: sleep, commute, work/school, lunch, errand, dinner

Server layer:
  - SimState + tick loop (5-sim-min broadcast, 0.1s real tick)
  - Position interpolation along Manhattan paths during commute
  - WebSocket /ws with init payload + binary-friendly tick payload
  - Typer CLI: \`citysim serve\`

Tests: smoke tests for grid shape, plan ordering, solar math." >/dev/null

echo "→ commit 3/3: viewer"
git add viewer
git commit -m "Viewer: deck.gl city view with day-night cycle and time controls

- React + Vite + TypeScript + Tailwind, deck.gl OrthographicView
- PolygonLayer for zoning tinted by sun altitude
- ScatterplotLayer for establishments and agents (with click-to-pick)
- DayNightOverlay: radial gradient with mixBlendMode multiply,
  shifts from deep navy → amber dawn → bright noon → golden hour
- TimeControls: play/pause, 1×–240× speed, scrubber, live indicator
- SidePanel: agent and establishment detail (placeholder for persona/dialogue)
- WebSocket hook with reconnect + RAF tween between 5-sim-min samples" >/dev/null

# ---------------------------------------------------------------------------
# 3. optional push
# ---------------------------------------------------------------------------
if $PUSH; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI not found. Install it (brew install gh) and run \`gh auth login\` first." >&2
    exit 1
  fi
  echo "→ Creating GitHub repo melbin/Sim-city (private) and pushing main"
  gh repo create "melbin/Sim-city" \
    --private \
    --source=. \
    --remote=origin \
    --push \
    --description "Synthetic city simulator with persona-conditioned LLM dialogue (early scaffold)."
else
  echo
  echo "Done. Three local commits made on main."
  echo "To push to GitHub:"
  echo "    gh repo create melbin/Sim-city --private --source=. --remote=origin --push"
  echo "    # or:"
  echo "    git remote add origin git@github.com:melbin/Sim-city.git && git push -u origin main"
fi

echo
echo "git log --oneline:"
git log --oneline

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d ".venv" ]]; then
  echo "Missing .venv in $ROOT_DIR"
  echo "Run: python -m venv .venv && source .venv/bin/activate && pip install -e ."
  exit 1
fi

source .venv/bin/activate

BATCH_SIZE="${1:-20}"
N_AGENTS="${2:-100}"
MAX_EST_PER_KIND="${3:-5}"
GRID_SIZE="${4:-80}"
SEED="${5:-42}"

python scripts/bootstrap_all_entities.py \
  --batch-size "$BATCH_SIZE" \
  --n-agents "$N_AGENTS" \
  --max-establishments-per-kind "$MAX_EST_PER_KIND" \
  --grid-size "$GRID_SIZE" \
  --seed "$SEED"

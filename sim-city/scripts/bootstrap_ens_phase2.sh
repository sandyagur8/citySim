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

if [[ -z "${MNEMONIC:-}" && -z "${CITYSIM_WALLET_MNEMONIC:-}" ]]; then
  echo "Missing MNEMONIC/CITYSIM_WALLET_MNEMONIC env."
  echo "Tip: export MNEMONIC from axl_integration/.env first."
  exit 1
fi

LIMIT_PER_BATCH="${1:-20}"
if ! [[ "$LIMIT_PER_BATCH" =~ ^[0-9]+$ ]] || [[ "$LIMIT_PER_BATCH" -le 0 ]]; then
  echo "Invalid batch size: $LIMIT_PER_BATCH"
  exit 1
fi

echo "[1/4] Backfill HD wallets..."
citysim backfill-wallets

echo "[2/4] Parent ENS check..."
PARENT="${CITYSIM_ENS_BASE_DOMAIN:-simcity.eth}"
echo "Parent domain configured: $PARENT"
echo "Note: Script mints subnames only. Parent 2LD mint/transfer must already be owned by your wallet."

echo "[3/4] Mint pending subnames in batches of ${LIMIT_PER_BATCH}..."
while true; do
  PENDING="$(python - <<'PY'
from citysim.store import PersonaStore
s=PersonaStore()
rows=s.all()
pending=[r for r in rows if (r.ens_status or "pending") != "minted" and r.ens_name]
print(len(pending))
PY
)"
  if [[ "$PENDING" -le 0 ]]; then
    break
  fi
  echo "Pending: $PENDING -> mint next batch"
  citysim mint-ens-subnames --limit "$LIMIT_PER_BATCH"
  sleep 1
done

echo "[4/4] Final status:"
python - <<'PY'
from collections import Counter
from citysim.store import PersonaStore
s=PersonaStore()
c=Counter((r.ens_status or "pending") for r in s.all())
print("minted =", c.get("minted",0))
print("failed =", c.get("failed",0))
print("pending=", c.get("pending",0))
PY

echo "Done."

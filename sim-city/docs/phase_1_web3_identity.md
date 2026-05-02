# Phase 1 Web3 Identity Integration (sim-city)

## Scope implemented
- Added identity columns to local persona DB schema:
  - `ens_name`, `wallet_address`, `ens_status`, `ens_tx_hash`
- Added backward-compatible local DB migration for existing `~/.citysim/citysim.db`.
- Added deterministic persona ENS naming:
  - `a000000.simcity.eth` pattern (base domain configurable)
- Added deterministic wallet-address derivation for phase-1 mapping stability.
- Added small/friendly simulation profile defaults:
  - `citysim serve` now defaults to `100` agents.
  - Establishments capped to max `5` per kind by default.

## Config
- `CITYSIM_ENS_BASE_DOMAIN` (default: `simcity.eth`)
- `CITYSIM_WALLET_MNEMONIC` (preferred)
- fallback mnemonic lookup order:
  1. `CITYSIM_WALLET_MNEMONIC`
  2. `MNEMONIC`
  3. `../axl_integration/.env` -> `MNEMONIC` (monorepo convenience)

## Notes
- Current wallet derivation is deterministic identity mapping for phase-1 only.
- Real signing/settlement derivation paths integrate in next phase.

## Phase 2 bootstrap

Run one-shot wallet+ENS subname bootstrap:

```bash
cd sim-city
source .venv/bin/activate
export MNEMONIC="..."
./scripts/bootstrap_ens_phase2.sh 20
```

Note: this script mints subnames only. Parent domain (default `simcity.eth`) must already be owned by your wallet.

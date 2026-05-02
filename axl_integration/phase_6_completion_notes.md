# Phase 6 Completion Notes

Date: 2026-05-02

## Scope

Phase 6 focused on observability and reliability hardening for the AXL + sim-city runtime.

## Implemented

1. Transport retry/backoff for AXL sends
- File: `sim-city/src/citysim/interaction/transport.py`
- New env controls:
  - `CITYSIM_AXL_SEND_RETRIES` (default `2`)
  - `CITYSIM_AXL_BACKOFF_S` (default `0.4`)
  - Existing timeout/poll envs still apply.
- Behavior:
  - Retries failed send/poll attempts with linear backoff.
  - Emits warning logs per failed attempt.

2. Dependency health endpoint
- File: `sim-city/src/citysim/server/app.py`
- New endpoint:
  - `GET /api/health/deps`
- Checks:
  - Ollama (`/api/tags`) when provider is `ollama-openai`
  - AXL nodeA/nodeB (`/topology`) when transport mode is `axl`
- Output includes per-dependency `ok`, `status_code`/`error`, and top-level `status` (`ok|degraded`).

3. Runtime dialogue error counters
- Files:
  - `sim-city/src/citysim/server/sim.py`
  - `sim-city/src/citysim/interaction/scheduler.py`
- Added live stats fields:
  - `n_dialogue_errors`
  - `n_transport_errors`
  - `n_llm_errors`
- Scheduler classifies exceptions and increments counters.

## Verification Checklist

1. Start AXL nodes and sim-city in strict AXL mode.
2. Hit health endpoint:
   - `curl http://127.0.0.1:8000/api/health/deps`
3. Confirm all deps `ok=true` and status `ok`.
4. Stop nodeB and re-check:
   - endpoint status should become `degraded` with nodeB error.
5. Trigger dialogues and inspect `/ws` tick payload stats:
   - verify error counters remain stable in healthy runs.
6. Force a failure (e.g., stop Ollama):
   - verify `n_llm_errors` increments over time.

## Notes

- With `CITYSIM_TRANSPORT_REQUIRED=1`, transport faults fail dialogue iteration fast and are now visible in counters + logs.
- With `CITYSIM_TRANSPORT_REQUIRED=0`, transport faults log warning and local fallback can continue.

# Phase 5 Completion Notes

Date: 2026-05-02

## Scope Completed

1. Sim dialogue runtime now routes turns through transport layer (local or AXL).
2. Scheduler selects transport via env:
   - `CITYSIM_TRANSPORT=local|axl`
   - `CITYSIM_TRANSPORT_REQUIRED=0|1`
3. AXL transport has explicit debug logs for send/recv/timeout paths.
4. Dialogue quality hardening for small local models:
   - shorter turns
   - anti-list / anti-template output shaping
   - repetition early-stop
5. ENS lookup API added:
   - `GET /api/agent/by-ens/{ens_name}`
   - returns persona metadata, wallet/axl identity fields, and establishment context.

## Verification Checklist

1. Start AXL nodes:
   - `npm run nodeA`
   - `npm run nodeB`
2. Start sim server with AXL mode:
   - `CITYSIM_TRANSPORT=axl`
   - `CITYSIM_TRANSPORT_REQUIRED=1`
3. Confirm server logs include `axl-send` and `axl-recv` debug events.
4. Open viewer and confirm live dialogue feed continues while transport is AXL-backed.
5. Query ENS endpoint:
   - `curl http://127.0.0.1:8000/api/agent/by-ens/a000000.simcity-7890.eth`
6. Confirm response includes:
   - `agent_id`, `ens_name`, `wallet_address`, `axl_key`, demographics, prefs/needs, establishment.

## Notes

- If AXL nodes are down and `CITYSIM_TRANSPORT_REQUIRED=1`, dialogue iteration fails fast (expected).
- If `CITYSIM_TRANSPORT_REQUIRED=0`, runtime logs warning and continues local dialogue fallback.

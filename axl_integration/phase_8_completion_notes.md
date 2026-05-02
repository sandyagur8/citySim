# Phase 8 Baseline Notes

Date: 2026-05-02

## Scope

Scale/perf baseline tooling added.

## Added

1. Benchmark script
- `sim-city/scripts/phase8_benchmark.py`
- Measures dialogue latency + failures over N runs.
- Supports `local` and `axl` transport.

2. CLI wrapper
- `citysim benchmark`
- File: `sim-city/src/citysim/cli.py`

## Example

```bash
citysim benchmark --n-agents 1000 --runs 50 --transport axl --transport-required
```

## Output

- `runs`, `ok`, `failed`, `purchase_ok`
- `latency_s avg/p50/p95/max`

## Intent

Use this as repeatable baseline before increasing world size or parallelism.

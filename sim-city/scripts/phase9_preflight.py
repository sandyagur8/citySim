#!/usr/bin/env python3
"""Phase 9 preflight validator.

Checks local runtime dependencies + sim API endpoints.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


def _get_json(url: str, timeout: float = 3.0) -> tuple[int, dict | None, str | None]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            body = r.read().decode("utf-8", errors="replace")
            data = json.loads(body) if body.strip() else None
            return r.status, data, None
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", errors="replace")
        return e.code, None, txt[:300]
    except Exception as e:  # noqa: BLE001
        return 0, None, str(e)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8000")
    p.add_argument("--ens", default="a000000.simcity-7890.eth")
    args = p.parse_args()

    ok = True

    status, payload, err = _get_json(f"{args.base}/api/health")
    if status == 200 and payload and payload.get("status") == "ok":
        print("[ok] sim /api/health")
    else:
        ok = False
        print(f"[fail] sim /api/health status={status} err={err}")

    status, payload, err = _get_json(f"{args.base}/api/health/deps")
    if status == 200 and payload:
        print(f"[ok] sim /api/health/deps status={payload.get('status')}")
    else:
        ok = False
        print(f"[fail] sim /api/health/deps status={status} err={err}")

    ens_enc = urllib.parse.quote(args.ens, safe="")
    status, payload, err = _get_json(f"{args.base}/api/agent/by-ens/{ens_enc}")
    if status == 200 and payload and payload.get("agent_id"):
        print(f"[ok] ens lookup {args.ens} -> {payload.get('agent_id')}")
    else:
        ok = False
        print(f"[fail] ens lookup status={status} err={err}")

    print("[done]", "PASS" if ok else "FAIL")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())

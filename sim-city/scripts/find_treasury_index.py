"""Locate the HD-wallet index that derives a target Ethereum address.

Run once after handing the treasury address to the codebase: it walks the
common derivation positions and prints the (account_group, index) that
matches your treasury wallet. Drop the result into ``.env`` as
``CITYSIM_TREASURY_HD_INDEX`` (and ``CITYSIM_TREASURY_ACCOUNT_GROUP`` if
non-zero), and every downstream tool can derive the treasury private
key on demand without ever putting the key on disk.

Usage:
    cd sim-city
    source .venv/bin/activate
    python scripts/find_treasury_index.py 0xFbC93CCc8dA90b5353148A7da4394369f36291DA

If no match falls out of the default search space, pass --max-index
to widen the brute force, or --target-account-group N to scan a
specific account group only.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Allow running from anywhere — find sim-city/src on sys.path.
HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src"
if SRC.exists() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from citysim.env import load_env_file  # noqa: E402

load_env_file(override=False)

from citysim.web3.wallets import derive_wallet  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="The wallet address to locate, 0x-prefixed.")
    parser.add_argument(
        "--mnemonic",
        default=os.environ.get("CITYSIM_WALLET_MNEMONIC")
        or os.environ.get("MNEMONIC"),
        help="BIP-39 mnemonic. Defaults to CITYSIM_WALLET_MNEMONIC / MNEMONIC env.",
    )
    parser.add_argument(
        "--max-index", type=int, default=200_000,
        help="How many indices to scan within each account group (default 200k).",
    )
    parser.add_argument(
        "--max-account-group", type=int, default=10,
        help="Highest account_group to try (default 10).",
    )
    parser.add_argument(
        "--target-account-group", type=int, default=None,
        help="If set, only scan this account_group.",
    )
    args = parser.parse_args()

    if not args.mnemonic:
        print(
            "error: no mnemonic. Set MNEMONIC in .env or pass --mnemonic.",
            file=sys.stderr,
        )
        return 2

    target = args.target.strip().lower()
    if not target.startswith("0x") or len(target) != 42:
        print(f"error: '{args.target}' is not a 0x-prefixed Ethereum address.", file=sys.stderr)
        return 2

    # Search order: prioritise positions a project would realistically
    # park a treasury at — first slot of the next account group is the
    # most common "operational wallet" pattern.
    candidates: list[tuple[int, int]] = []

    if args.target_account_group is not None:
        for i in range(args.max_index):
            candidates.append((args.target_account_group, i))
    else:
        # First: low indices in account group 0 (in case treasury is
        # interleaved with personas)
        for i in range(min(200, args.max_index)):
            candidates.append((0, i))
        # Then: index 0 of every account group (operational pattern)
        for ag in range(1, args.max_account_group + 1):
            candidates.append((ag, 0))
        # Then: a sweep of higher indices in account group 0
        for i in range(200, args.max_index):
            candidates.append((0, i))
        # Then: low indices of other account groups
        for ag in range(1, args.max_account_group + 1):
            for i in range(1, min(200, args.max_index)):
                candidates.append((ag, i))

    print(
        f"Scanning up to {len(candidates):,} HD positions for {args.target}…",
        file=sys.stderr,
    )

    n_checked = 0
    for ag, idx in candidates:
        w = derive_wallet(args.mnemonic, idx, account_group=ag)
        if w.address.lower() == target:
            print()
            print("=" * 60)
            print("MATCH FOUND")
            print("=" * 60)
            print(f"  account_group : {ag}")
            print(f"  index         : {idx}")
            print(f"  path          : {w.path}")
            print(f"  address       : {w.address}")
            print()
            print("Add to your .env:")
            print(f"  CITYSIM_TREASURY_HD_INDEX={idx}")
            if ag != 0:
                print(f"  CITYSIM_TREASURY_ACCOUNT_GROUP={ag}")
            return 0
        n_checked += 1
        if n_checked % 5000 == 0:
            print(f"  {n_checked:,} positions scanned…", file=sys.stderr)

    print(
        f"\nNo match. Scanned {n_checked:,} positions. "
        f"Re-run with --max-index larger or --target-account-group N.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())

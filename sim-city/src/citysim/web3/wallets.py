from __future__ import annotations

from dataclasses import dataclass

from eth_account import Account


@dataclass(frozen=True)
class DerivedWallet:
    address: str
    private_key_hex: str
    path: str


def derive_wallet(mnemonic: str, index: int, *, account_group: int = 0) -> DerivedWallet:
    if not mnemonic or not mnemonic.strip():
        raise ValueError("mnemonic is required")
    if index < 0:
        raise ValueError("index must be >= 0")
    if account_group < 0:
        raise ValueError("account_group must be >= 0")

    Account.enable_unaudited_hdwallet_features()
    path = f"m/44'/60'/{account_group}'/0/{index}"
    acct = Account.from_mnemonic(mnemonic.strip(), account_path=path)
    return DerivedWallet(
        address=acct.address,
        private_key_hex=acct.key.hex(),
        path=path,
    )


def derive_wallet_address(mnemonic: str, index: int, *, account_group: int = 0) -> str:
    return derive_wallet(mnemonic, index, account_group=account_group).address


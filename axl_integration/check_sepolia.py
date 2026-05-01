import os
from web3 import Web3
from eth_account import Account
from dotenv import load_dotenv

def check_connection():
    load_dotenv()
    
    rpc_url = os.getenv("RPC_URL")
    mnemonic = os.getenv("MNEMONIC")
    
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    print(f"Connected to Sepolia: {w3.is_connected()}")
    
    Account.enable_unaudited_hdwallet_features()
    acct = Account.from_mnemonic(mnemonic)
    
    print(f"Account Address: {acct.address}")
    balance = w3.eth.get_balance(acct.address)
    print(f"Balance: {w3.from_wei(balance, 'ether')} ETH")

if __name__ == "__main__":
    check_connection()
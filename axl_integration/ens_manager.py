import json
import os
from web3 import Web3
from web3.providers.eth_tester import EthereumTesterProvider
from ens import ENS

class ENSManager:
    def __init__(self, provider=None, contract_address=None):
        if provider is None:
            self.w3 = Web3(EthereumTesterProvider())
        else:
            self.w3 = Web3(provider)
        
        self.w3.eth.default_account = self.w3.eth.accounts[0]
        
        # Load ABI and Bytecode
        artifact_path = os.path.join(os.path.dirname(__file__), "ens_project/out/CitySimENS.sol/CitySimENS.json")
        with open(artifact_path, "r") as f:
            artifact = json.load(f)
            
        self.abi = artifact["abi"]
        self.bytecode = artifact["bytecode"]["object"]
        
        if contract_address:
            self.contract = self.w3.eth.contract(address=contract_address, abi=self.abi)
        else:
            self._deploy_contract()

    def _deploy_contract(self):
        Contract = self.w3.eth.contract(abi=self.abi, bytecode=self.bytecode)
        tx_hash = Contract.constructor().transact()
        tx_receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        self.contract = self.w3.eth.contract(address=tx_receipt.contractAddress, abi=self.abi)
        print(f"CitySimENS deployed at: {tx_receipt.contractAddress}")

    def register_agent(self, name: str, address: str, axl_key: str):
        node = ENS.namehash(name)
        # Register address
        tx1 = self.contract.functions.setAddr(node, address).transact()
        self.w3.eth.wait_for_transaction_receipt(tx1)
        # Register AXL Key in text record
        tx2 = self.contract.functions.setText(node, "axl_key", axl_key).transact()
        self.w3.eth.wait_for_transaction_receipt(tx2)
        print(f"Registered {name}: address={address[:8]}..., axl_key={axl_key}")

    def resolve_axl_key(self, name: str) -> str:
        node = ENS.namehash(name)
        return self.contract.functions.text(node, "axl_key").call()

if __name__ == "__main__":
    manager = ENSManager()
    manager.register_agent("store42.citysim.eth", manager.w3.eth.accounts[1], "axl_pub_key_001")
    resolved_key = manager.resolve_axl_key("store42.citysim.eth")
    print(f"Resolved store42.citysim.eth AXL Key: {resolved_key}")
    assert resolved_key == "axl_pub_key_001"
    print("ENS integration test passed!")
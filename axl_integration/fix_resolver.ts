import { namehash } from 'viem/ens';
import { createWalletClient, createPublicClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { addEnsContracts } from '@ensdomains/ensjs'
import { setTextRecord } from '@ensdomains/ensjs/wallet'
import * as dotenv from 'dotenv';
dotenv.config();

const account = mnemonicToAccount(process.env.MNEMONIC!);
const publicClient = createPublicClient({ chain: addEnsContracts(sepolia), transport: http(process.env.RPC_URL) });
const walletClient = createWalletClient({ account, chain: addEnsContracts(sepolia), transport: http(process.env.RPC_URL) });

const registryAddress = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const publicResolverAddress = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD';

async function main() {
    const name = 'citysim-agent-4371a.eth';
    const node = namehash(name);
    
    console.log("Setting resolver in registry...");
    const { request: setResolverReq } = await publicClient.simulateContract({
        address: registryAddress,
        abi: [{
            name: 'setResolver', 
            type: 'function', 
            inputs: [{name: 'node', type: 'bytes32'}, {name: 'resolver', type: 'address'}], 
            outputs: []
        }],
        functionName: 'setResolver',
        args: [node, publicResolverAddress],
        account
    });
    const hash1 = await walletClient.writeContract(setResolverReq);
    await publicClient.waitForTransactionReceipt({ hash: hash1 });
    console.log("Resolver set!");

    console.log("Setting text record...");
    const textTx = await setTextRecord(walletClient, {
        name,
        key: 'axl_key',
        value: 'axl_pub_key_node_A_12345',
    });
    await publicClient.waitForTransactionReceipt({ hash: textTx });
    console.log("Text record set!");
}
main().catch(console.error);
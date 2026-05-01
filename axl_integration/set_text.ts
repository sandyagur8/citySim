import { namehash } from 'viem/ens';
import { createWalletClient, createPublicClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const account = mnemonicToAccount(process.env.MNEMONIC!);
const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(process.env.RPC_URL) });

const resolverAddress = '0x60C7C2A24b5e86C38639Fd1586917a8FEF66a56d';

async function setKey(name: string, axlKey: string) {
    const { request } = await publicClient.simulateContract({
        address: resolverAddress,
        abi: [{
            type: 'function',
            name: 'setText',
            inputs: [{name: 'node', type: 'bytes32'}, {name: 'key', type: 'string'}, {name: 'value', type: 'string'}],
            outputs: []
        }],
        functionName: 'setText',
        args: [namehash(name), 'axl_key', axlKey],
        account
    });
    const hash = await walletClient.writeContract(request);
    console.log('Tx hash for', name, ':', hash);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log('Done!');
}

async function main() {
    await setKey('citysim-agent-a.eth', 'axl_pub_key_node_A_12345');
}
main().catch(console.error);

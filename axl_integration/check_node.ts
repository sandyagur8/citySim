import { namehash } from 'viem/ens';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) });

async function main() {
    const node = namehash('citysim-agent-230a.eth');
    
    const owner = await publicClient.readContract({
        address: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
        abi: [{name: 'owner', type: 'function', inputs: [{name: 'node', type: 'bytes32'}], outputs: [{type: 'address'}]}],
        functionName: 'owner',
        args: [node]
    });
    console.log('Registry Owner:', owner);

    const resolver = await publicClient.readContract({
        address: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
        abi: [{name: 'resolver', type: 'function', inputs: [{name: 'node', type: 'bytes32'}], outputs: [{type: 'address'}]}],
        functionName: 'resolver',
        args: [node]
    });
    console.log('Registry Resolver:', resolver);
}
main().catch(console.error);

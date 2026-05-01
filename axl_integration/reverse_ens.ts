import { namehash } from 'viem/ens';
import { createWalletClient, createPublicClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const accountIndex = parseInt(process.argv[2] || '0', 10);
const axlKey = process.argv[3];

if (!axlKey) {
    console.error("Usage: npx tsx reverse_ens.ts <accountIndex> <axlKey>");
    process.exit(1);
}

const account = mnemonicToAccount(process.env.MNEMONIC!, { accountIndex });
const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(process.env.RPC_URL) });

const registryAddress = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const resolver = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD';

async function main() {
    console.log(`Using account[${accountIndex}]:`, account.address);
    console.log(`AXL Key to set:`, axlKey);

    const addrReverseNode = namehash('addr.reverse');
    
    const reverseRegistrar = await publicClient.readContract({
        address: registryAddress,
        abi: [{name: 'owner', type: 'function', inputs: [{name: 'node', type: 'bytes32'}], outputs: [{type: 'address'}]}],
        functionName: 'owner',
        args: [addrReverseNode]
    });

    console.log('Claiming reverse node...');
    const { request: claimReq } = await publicClient.simulateContract({
        address: reverseRegistrar as `0x${string}`,
        abi: [{
            name: 'claimWithResolver', 
            type: 'function', 
            inputs: [{name: 'owner', type: 'address'}, {name: 'resolver', type: 'address'}], 
            outputs: [{type: 'bytes32'}]
        }],
        functionName: 'claimWithResolver',
        args: [account.address, resolver],
        account
    });
    let hash = await walletClient.writeContract(claimReq);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log('Claimed!');

    const reverseNode = namehash(`${account.address.slice(2).toLowerCase()}.addr.reverse`);
    console.log('Setting text record on node', reverseNode);
    
    const { request: setReq } = await publicClient.simulateContract({
        address: resolver,
        abi: [{
            name: 'setText', 
            type: 'function', 
            inputs: [{name: 'node', type: 'bytes32'}, {name: 'key', type: 'string'}, {name: 'value', type: 'string'}], 
            outputs: []
        }],
        functionName: 'setText',
        args: [reverseNode, 'axl_key', axlKey],
        account
    });
    hash = await walletClient.writeContract(setReq);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log('Text record set!');

    const text = await publicClient.readContract({
        address: resolver,
        abi: [{
            name: 'text', 
            type: 'function', 
            inputs: [{name: 'node', type: 'bytes32'}, {name: 'key', type: 'string'}], 
            outputs: [{type: 'string'}]
        }],
        functionName: 'text',
        args: [reverseNode, 'axl_key']
    });
    console.log('Resolved AXL Key:', text);
}
main().catch(console.error);
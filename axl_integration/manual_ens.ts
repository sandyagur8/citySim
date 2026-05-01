import { createWalletClient, createPublicClient, http, parseEther, encodeFunctionData, namehash } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const account = mnemonicToAccount(process.env.MNEMONIC!);
const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(process.env.RPC_URL) });

const controllerAddress = '0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968' as `0x${string}`;
const resolverAddress = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD' as `0x${string}`;

const controllerAbi = [
    {
        name: 'makeCommitment',
        type: 'function',
        inputs: [
            {name: 'name', type: 'string'},
            {name: 'owner', type: 'address'},
            {name: 'duration', type: 'uint256'},
            {name: 'secret', type: 'bytes32'},
            {name: 'resolver', type: 'address'},
            {name: 'data', type: 'bytes[]'},
            {name: 'reverseRecord', type: 'bool'},
            {name: 'ownerControlledFuses', type: 'uint16'}
        ],
        outputs: [{type: 'bytes32'}]
    },
    {
        name: 'commit',
        type: 'function',
        inputs: [{name: 'commitment', type: 'bytes32'}],
        outputs: []
    },
    {
        name: 'register',
        type: 'function',
        inputs: [
            {name: 'name', type: 'string'},
            {name: 'owner', type: 'address'},
            {name: 'duration', type: 'uint256'},
            {name: 'secret', type: 'bytes32'},
            {name: 'resolver', type: 'address'},
            {name: 'data', type: 'bytes[]'},
            {name: 'reverseRecord', type: 'bool'},
            {name: 'ownerControlledFuses', type: 'uint16'}
        ],
        outputs: []
    }
] as const;

async function registerRealName(label: string, axlKey: string) {
    console.log(`Starting manual registration for ${label}.eth...`);
    
    const secret = "0x" + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('') as `0x${string}`;
    const duration = 31536000n; // 1 year
    
    // We will set the text record inside the multicall data during registration
    const setTextData = encodeFunctionData({
        abi: [{name: 'setText', type: 'function', inputs: [{name: 'node', type: 'bytes32'}, {name: 'key', type: 'string'}, {name: 'value', type: 'string'}]}],
        functionName: 'setText',
        args: [namehash(`${label}.eth`), 'axl_key', axlKey]
    });

    const data = [setTextData];
    const reverseRecord = false;
    const fuses = 0;

    // 1. Make commitment locally (via readContract to be 100% sure we match exactly what the contract expects)
    const commitment = await publicClient.readContract({
        address: controllerAddress,
        abi: controllerAbi,
        functionName: 'makeCommitment',
        args: [label, account.address, duration, secret, resolverAddress, data, reverseRecord, fuses]
    });
    console.log(`Commitment generated: ${commitment}`);

    // 2. Commit
    console.log("Submitting commit tx...");
    const { request: commitReq } = await publicClient.simulateContract({
        address: controllerAddress,
        abi: controllerAbi,
        functionName: 'commit',
        args: [commitment],
        account
    });
    const commitHash = await walletClient.writeContract(commitReq);
    console.log(`Commit tx sent: ${commitHash}`);
    await publicClient.waitForTransactionReceipt({ hash: commitHash });
    console.log("Commit tx mined. Waiting 70 seconds...");
    
    await new Promise(r => setTimeout(r, 70000));

    // 3. Register
    console.log("Submitting register tx...");
    const value = parseEther('0.05'); // overpay, contract refunds
    const { request: regReq } = await publicClient.simulateContract({
        address: controllerAddress,
        abi: controllerAbi,
        functionName: 'register',
        args: [label, account.address, duration, secret, resolverAddress, data, reverseRecord, fuses],
        value,
        account
    });
    const regHash = await walletClient.writeContract(regReq);
    console.log(`Register tx sent: ${regHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: regHash });
    
    if (receipt.status === 'success') {
        console.log(`Successfully registered ${label}.eth!`);
        
        // Let's resolve the text record to prove it worked!
        const text = await publicClient.readContract({
            address: resolverAddress,
            abi: [{name: 'text', type: 'function', inputs: [{name: 'node', type: 'bytes32'}, {name: 'key', type: 'string'}], outputs: [{type: 'string'}]}],
            functionName: 'text',
            args: [namehash(`${label}.eth`), 'axl_key']
        });
        console.log(`Proof: Resolved AXL Key from ${label}.eth -> ${text}`);
    } else {
        console.error("Registration transaction reverted on-chain!");
    }
}

async function main() {
    const nonce = Math.floor(Math.random() * 10000);
    await registerRealName(`axl-agent-${nonce}`, `pub_key_test_${nonce}`);
}

main().catch(console.error);
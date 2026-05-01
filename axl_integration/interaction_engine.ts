import { createPublicClient, http, namehash } from 'viem';
import { sepolia } from 'viem/chains';
import { addEnsContracts } from '@ensdomains/ensjs';
import * as dotenv from 'dotenv';
import * as http_module from 'http';

dotenv.config();

const publicClient = createPublicClient({
    chain: addEnsContracts(sepolia),
    transport: http(process.env.RPC_URL)
});

const nodeA_ens = 'citysim-agent-1-7890.eth';
const nodeB_ens = 'citysim-agent-2-7890.eth';

function sendMessage(senderPort: number, destinationKey: string, message: string) {
    return new Promise((resolve, reject) => {
        const req = http_module.request({
            hostname: '127.0.0.1',
            port: senderPort,
            path: '/send',
            method: 'POST',
            headers: {
                'X-Destination-Peer-Id': destinationKey,
                'Content-Type': 'text/plain'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(message);
        req.end();
    });
}

function receiveMessage(receiverPort: number) {
    return new Promise((resolve, reject) => {
        const req = http_module.request({
            hostname: '127.0.0.1',
            port: receiverPort,
            path: '/recv',
            method: 'GET'
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({
                senderKey: res.headers['x-from-peer-id'],
                message: data
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function resolveAXLKey(name: string): Promise<string> {
    const publicResolverAddress = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD';
    const node = namehash(name);
    const text = await publicClient.readContract({
        address: publicResolverAddress,
        abi: [{name: 'text', type: 'function', inputs: [{name: 'node', type: 'bytes32'}, {name: 'key', type: 'string'}], outputs: [{type: 'string'}]}],
        functionName: 'text',
        args: [node, 'axl_key']
    });
    return text as string;
}

async function main() {
    console.log("Interaction Engine Starting...");

    console.log(`Agent A (on Node A) wants to talk to Agent B (on Node B).`);
    console.log(`Resolving ${nodeB_ens} on ENS...`);
    
    let resolvedKeyB = await resolveAXLKey(nodeB_ens);
    console.log(`Resolved AXL Key for Agent B: ${resolvedKeyB}`);

    const message = "Hello from Agent A! Are you selling NewCola Zero?";
    console.log(`\nAgent A sending message over AXL -> Agent B: "${message}"`);
    
    await sendMessage(9002, resolvedKeyB, message);
    console.log(`Message sent successfully via AXL Node A (Port 9002)!`);

    console.log(`\nWaiting for Agent B (AXL Node B on Port 9012) to receive...`);
    
    // Poll for the message on Node B
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const recv: any = await receiveMessage(9012);
        if (recv.message) {
            console.log(`Agent B received message from ${recv.senderKey.substring(0, 8)}...: "${recv.message}"`);
            
            // Agent B replies back
            console.log(`\nAgent B replying over AXL -> Agent A...`);
            await sendMessage(9012, recv.senderKey, "Yes, I am! Would you like to buy some?");
            break;
        }
    }

    console.log(`\nChecking Agent A's inbox (AXL Node A)...`);
    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const recvA: any = await receiveMessage(9002);
        if (recvA.message) {
             console.log(`Agent A received reply from ${recvA.senderKey.substring(0, 8)}...: "${recvA.message}"`);
             break;
        }
    }

    console.log("\nInteraction Loop Complete.");
}

main().catch(console.error);
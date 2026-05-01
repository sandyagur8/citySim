import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) });

async function main() {
    const tx = await publicClient.getTransaction({ hash: '0x08fceab8bc32a8105fac5e65c997de3a4895fcf072c6d79f75013f05e63083fd' });
    console.log(tx);
    const receipt = await publicClient.getTransactionReceipt({ hash: '0x08fceab8bc32a8105fac5e65c997de3a4895fcf072c6d79f75013f05e63083fd' });
    console.log("Status:", receipt.status);
    console.log("Logs:", receipt.logs);
}
main().catch(console.error);

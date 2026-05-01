import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) });

async function main() {
    const receipt = await publicClient.getTransactionReceipt({ hash: '0xa00152249705c068bd9ac889042d0f41a01f85aeec06527b4f05ee93f13c8f91' });
    console.log(receipt.status, receipt.to);
}
main().catch(console.error);

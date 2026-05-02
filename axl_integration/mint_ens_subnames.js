"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const viem_1 = require("viem");
const accounts_1 = require("viem/accounts");
const chains_1 = require("viem/chains");
const ensjs_1 = require("@ensdomains/ensjs");
const wallet_1 = require("@ensdomains/ensjs/wallet");
const public_1 = require("@ensdomains/ensjs/public");
function labelhash(label) {
    return (0, viem_1.keccak256)((0, viem_1.stringToHex)(label));
}
async function main() {
    const inputPath = process.argv[2];
    const outputPath = process.argv[3];
    if (!inputPath) {
        throw new Error('Usage: tsx mint_ens_subnames.ts <input.json> [output.json]');
    }
    const raw = fs_1.default.readFileSync(inputPath, 'utf-8');
    const jobs = JSON.parse(raw);
    const env = loadLocalEnv();
    const mnemonic = process.env.MNEMONIC || env.MNEMONIC;
    const rpc = process.env.RPC_URL || env.RPC_URL;
    if (!mnemonic || !rpc) {
        throw new Error('MNEMONIC and RPC_URL required in env');
    }
    const registryAddress = (process.env.ENS_REGISTRY_ADDRESS || '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e');
    const resolverAddress = (process.env.ENS_PUBLIC_RESOLVER_ADDRESS || '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD');
    const account = (0, accounts_1.mnemonicToAccount)(mnemonic);
    const publicClient = (0, viem_1.createPublicClient)({
        chain: (0, ensjs_1.addEnsContracts)(chains_1.sepolia),
        transport: (0, viem_1.http)(rpc),
    });
    const walletClient = (0, viem_1.createWalletClient)({
        account,
        chain: (0, ensjs_1.addEnsContracts)(chains_1.sepolia),
        transport: (0, viem_1.http)(rpc),
    });
    const results = [];
    if (jobs.length) {
        await ensureParentOwnership(jobs[0].ens_name, publicClient, walletClient, account.address);
    }
    for (const job of jobs) {
        try {
            const parts = job.ens_name.split('.');
            if (parts.length < 3) {
                throw new Error('Expected subname format like a000001.simcity.eth');
            }
            const child = parts[0];
            const parent = parts.slice(1).join('.');
            const parentNode = (0, viem_1.namehash)(parent);
            const childLabelHash = labelhash(child);
            const { request } = await publicClient.simulateContract({
                address: registryAddress,
                abi: [
                    {
                        name: 'setSubnodeRecord',
                        type: 'function',
                        inputs: [
                            { name: 'node', type: 'bytes32' },
                            { name: 'label', type: 'bytes32' },
                            { name: 'owner', type: 'address' },
                            { name: 'resolver', type: 'address' },
                            { name: 'ttl', type: 'uint64' },
                        ],
                        outputs: [],
                    },
                ],
                functionName: 'setSubnodeRecord',
                args: [parentNode, childLabelHash, account.address, resolverAddress, 0n],
                account,
            });
            const subnodeTx = await walletClient.writeContract(request);
            await publicClient.waitForTransactionReceipt({ hash: subnodeTx });
            const textTx = await (0, wallet_1.setTextRecord)(walletClient, {
                name: job.ens_name,
                key: 'axl_key',
                value: job.text_value,
                resolverAddress,
            });
            await publicClient.waitForTransactionReceipt({ hash: textTx });
            results.push({
                agent_id: job.agent_id,
                ens_name: job.ens_name,
                status: 'minted',
                tx_hash: textTx,
            });
        }
        catch (e) {
            results.push({
                agent_id: job.agent_id,
                ens_name: job.ens_name,
                status: 'failed',
                error: String(e),
            });
        }
    }
    const json = JSON.stringify(results);
    if (outputPath) {
        fs_1.default.writeFileSync(outputPath, json, 'utf-8');
    }
    else {
        process.stdout.write(json);
    }
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
function loadLocalEnv() {
    const out = {};
    const p = '.env';
    if (!fs_1.default.existsSync(p))
        return out;
    const raw = fs_1.default.readFileSync(p, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#') || !s.includes('='))
            continue;
        const [k, ...rest] = s.split('=');
        out[k.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
}
async function ensureParentOwnership(subname, publicClient, walletClient, accountAddress) {
    const parts = subname.split('.');
    if (parts.length < 3 || parts[parts.length - 1] !== 'eth')
        return;
    const parent = parts.slice(1).join('.');
    const parentNode = (0, viem_1.namehash)(parent);
    const registryAddress = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
    const owner = (await publicClient.readContract({
        address: registryAddress,
        abi: [{ name: 'owner', type: 'function', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }],
        functionName: 'owner',
        args: [parentNode],
    }));
    if (owner.toLowerCase() === accountAddress.toLowerCase())
        return;
    const available = await (0, public_1.getAvailable)(publicClient, { name: parent });
    if (!available) {
        throw new Error(`Parent ENS name ${parent} not owned by current wallet and not available`);
    }
    const secret = ('0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''));
    const duration = 31536000;
    const price = await (0, public_1.getPrice)(publicClient, { nameOrNames: parent, duration });
    const commitParams = { name: parent, duration, owner: accountAddress, secret };
    const commitTx = await (0, wallet_1.commitName)(walletClient, commitParams);
    await publicClient.waitForTransactionReceipt({ hash: commitTx });
    await new Promise((r) => setTimeout(r, 70000));
    const valueToSend = ((price.base + price.premium) * 110n) / 100n;
    const regTx = await (0, wallet_1.registerName)(walletClient, { ...commitParams, value: valueToSend });
    await publicClient.waitForTransactionReceipt({ hash: regTx });
}

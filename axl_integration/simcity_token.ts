// SIMCITY ERC-20 transfer helper — bridges Python distribute commands
// to the live Sepolia token contract.
//
// Usage (from CLI):
//   tsx simcity_token.ts <input.json> [output.json]
//
// Input JSON shape (one transfer per row):
//   [
//     { "to": "0x…", "amount_wei": "1234567890000000000",
//       "memo": "agent_id=…  reason=initial_savings" },
//     …
//   ]
//
// All transfers are signed by the treasury account derived from
// MNEMONIC at HD path m/44'/60'/{TREASURY_ACCOUNT_GROUP}'/0/{TREASURY_HD_INDEX}.
//
// On success, writes a JSON array of results back to output.json so the
// Python caller can record tx hashes in the persona_balances ledger.

import fs from 'fs';
import path from 'path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Address,
  type Transport,
  type WalletClient,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

type TransferInput = {
  to: string;
  /** Token amount in token base-units (typically 18-decimal wei). */
  amount_wei: string;
  memo?: string;
  agent_id?: string;
};

type TransferResult = {
  to: string;
  amount_wei: string;
  agent_id?: string;
  status: 'sent' | 'failed';
  tx_hash?: string;
  block_number?: string;
  error?: string;
};

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
]);

// Tiny .env loader — same pattern as mint_ens_subnames.ts so the script
// is launchable both from the axl_integration folder and from the
// project root.
function loadLocalEnv(): Record<string, string> {
  const tries = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '../sim-city/.env'),
    path.resolve(process.cwd(), '../sim-city/.env'),
  ];
  for (const p of tries) {
    if (!fs.existsSync(p)) continue;
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
    return out;
  }
  return {};
}

function envInt(name: string, fallback: number, env: Record<string, string>): number {
  const raw = process.env[name] ?? env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath) {
    throw new Error(
      'Usage: tsx simcity_token.ts <input.json> [output.json]\n' +
        '  input.json: array of { to, amount_wei, memo?, agent_id? }',
    );
  }
  const env = loadLocalEnv();
  const mnemonic = process.env.MNEMONIC || env.MNEMONIC;
  const rpc =
    process.env.RPC_URL ||
    env.RPC_URL ||
    'https://sepolia.infura.io/v3/7d057f5911fc425089e1875e10c12554';
  const tokenAddress = (process.env.SIMCITY_TOKEN_ADDRESS ||
    env.SIMCITY_TOKEN_ADDRESS) as Address | undefined;

  const treasuryIdx = envInt('CITYSIM_TREASURY_HD_INDEX', NaN, env);
  const treasuryGroup = envInt('CITYSIM_TREASURY_ACCOUNT_GROUP', 0, env);

  if (!mnemonic) throw new Error('MNEMONIC missing in env');
  if (!tokenAddress) throw new Error('SIMCITY_TOKEN_ADDRESS missing in env');
  if (!Number.isFinite(treasuryIdx)) {
    throw new Error(
      'CITYSIM_TREASURY_HD_INDEX missing in env. Run scripts/find_treasury_index.py first.',
    );
  }

  const account = mnemonicToAccount(mnemonic, {
    accountIndex: treasuryGroup,
    addressIndex: treasuryIdx,
  });
  const transport: Transport = http(rpc);
  const publicClient: PublicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient: WalletClient = createWalletClient({
    chain: sepolia,
    transport,
    account,
  });

  console.error(`SIMCITY token : ${tokenAddress}`);
  console.error(`Treasury addr : ${account.address}`);
  console.error(`RPC           : ${rpc}`);

  // Sanity-check balance before doing 5,000 txs.
  const decimals: number = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
  });
  const treasuryBalance: bigint = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  console.error(
    `Treasury bal  : ${treasuryBalance.toString()} (${(
      Number(treasuryBalance) /
      10 ** decimals
    ).toFixed(2)} SIMCITY)`,
  );

  const jobs = JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as TransferInput[];
  console.error(`Sending ${jobs.length} transfers…`);

  const results: TransferResult[] = [];
  // Sequential nonce management: read once, increment locally so Sepolia
  // doesn't reorder our txs across the airdrop.
  let nonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: 'pending',
  });

  let sumWei = 0n;
  for (const j of jobs) {
    sumWei += BigInt(j.amount_wei);
  }
  if (sumWei > treasuryBalance) {
    throw new Error(
      `Insufficient treasury balance: needed ${sumWei.toString()}, have ${treasuryBalance.toString()}`,
    );
  }

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    try {
      const amount = BigInt(j.amount_wei);
      if (amount <= 0n) {
        results.push({
          to: j.to,
          amount_wei: j.amount_wei,
          agent_id: j.agent_id,
          status: 'sent',
          tx_hash: '0x' + '0'.repeat(64),
        });
        continue;
      }
      const hash = await walletClient.writeContract({
        chain: sepolia,
        account,
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [j.to as Address, amount],
        nonce,
      });
      nonce += 1;
      results.push({
        to: j.to,
        amount_wei: j.amount_wei,
        agent_id: j.agent_id,
        status: 'sent',
        tx_hash: hash,
      });
      if ((i + 1) % 25 === 0) {
        console.error(`  ${i + 1}/${jobs.length}  tx=${hash}`);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({
        to: j.to,
        amount_wei: j.amount_wei,
        agent_id: j.agent_id,
        status: 'failed',
        error: message,
      });
      // On nonce errors, refresh from chain so we can keep going.
      if (/nonce/i.test(message)) {
        nonce = await publicClient.getTransactionCount({
          address: account.address,
          blockTag: 'pending',
        });
      }
    }
  }

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.error(`Wrote results -> ${outputPath}`);
  } else {
    process.stdout.write(JSON.stringify(results, null, 2));
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.length - sent;
  console.error(`Done: ${sent} sent, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('simcity_token.ts: fatal:', e);
  process.exit(1);
});

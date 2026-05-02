import fs from 'fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { addEnsContracts } from '@ensdomains/ensjs';
import { setTextRecord } from '@ensdomains/ensjs/wallet';

type Job = { agent_id: string; ens_name: string; text_value: string };
type Res = { agent_id: string; ens_name: string; status: 'ok' | 'failed'; tx_hash?: string; error?: string };

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync('.env')) return out;
  for (const line of fs.readFileSync('.env', 'utf-8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const [k, ...rest] = s.split('=');
    out[k.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) throw new Error('Usage: tsx set_ens_text_batch.ts <in.json> <out.json>');
  const jobs = JSON.parse(fs.readFileSync(input, 'utf-8')) as Job[];
  const env = loadEnv();
  const mnemonic = process.env.MNEMONIC || env.MNEMONIC;
  const rpc = process.env.RPC_URL || env.RPC_URL;
  if (!mnemonic || !rpc) throw new Error('MNEMONIC and RPC_URL required');

  const resolverAddress = (process.env.ENS_PUBLIC_RESOLVER_ADDRESS || env.ENS_PUBLIC_RESOLVER_ADDRESS || '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD') as `0x${string}`;
  const account = mnemonicToAccount(mnemonic);
  const publicClient = createPublicClient({ chain: addEnsContracts(sepolia), transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: addEnsContracts(sepolia), transport: http(rpc) });
  const out: Res[] = [];
  console.error(`[text-push] jobs=${jobs.length}`);
  for (const job of jobs) {
    try {
      console.error(`[text-push] submit ${job.ens_name}...`);
      const tx = await setTextRecord(walletClient, {
        name: job.ens_name,
        key: 'axl_key',
        value: job.text_value,
        resolverAddress,
      });
      console.error(`[text-push] tx sent ${job.ens_name} ${tx.slice(0, 10)}... waiting receipt`);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.error(`[text-push] confirmed ${job.ens_name}`);
      out.push({ agent_id: job.agent_id, ens_name: job.ens_name, status: 'ok', tx_hash: tx });
    } catch (e) {
      console.error(`[text-push] failed ${job.ens_name}: ${String(e).slice(0, 220)}`);
      out.push({ agent_id: job.agent_id, ens_name: job.ens_name, status: 'failed', error: String(e) });
    }
  }
  fs.writeFileSync(output, JSON.stringify(out), 'utf-8');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

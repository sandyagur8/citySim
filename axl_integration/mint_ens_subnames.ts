import fs from 'fs';
import { createPublicClient, createWalletClient, http, namehash, keccak256, stringToHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { addEnsContracts } from '@ensdomains/ensjs';
import { commitName, registerName, setTextRecord } from '@ensdomains/ensjs/wallet';
import { getAvailable, getPrice } from '@ensdomains/ensjs/public';

type MintInput = {
  agent_id: string;
  ens_name: string;
  text_value: string;
};

type MintResult = {
  agent_id: string;
  ens_name: string;
  status: 'minted' | 'failed';
  tx_hash?: string;
  error?: string;
};

type JobState = {
  job: MintInput;
  subnodeTx?: `0x${string}`;
  textTx?: `0x${string}`;
  error?: string;
};

function labelhash(label: string): `0x${string}` {
  return keccak256(stringToHex(label)) as `0x${string}`;
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath) {
    throw new Error('Usage: tsx mint_ens_subnames.ts <input.json> [output.json]');
  }
  const raw = fs.readFileSync(inputPath, 'utf-8');
  const jobs = JSON.parse(raw) as MintInput[];

  const env = loadLocalEnv();
  const mnemonic = process.env.MNEMONIC || env.MNEMONIC;
  const rpc = process.env.RPC_URL || env.RPC_URL;
  const fallbackRpc =
    process.env.RPC_URL_FALLBACK ||
    env.RPC_URL_FALLBACK ||
    'https://sepolia.infura.io/v3/7d057f5911fc425089e1875e10c12554';
  if (!mnemonic || !rpc) {
    throw new Error('MNEMONIC and RPC_URL required in env');
  }

  const registryAddress = (process.env.ENS_REGISTRY_ADDRESS || '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e') as `0x${string}`;
  const resolverAddress = (process.env.ENS_PUBLIC_RESOLVER_ADDRESS || '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD') as `0x${string}`;

  const account = mnemonicToAccount(mnemonic);
  let activeRpc = rpc;
  let publicClient = createPublicClient({
    chain: addEnsContracts(sepolia),
    transport: http(activeRpc),
  });
  let walletClient = createWalletClient({
    account,
    chain: addEnsContracts(sepolia),
    transport: http(activeRpc),
  });
  console.error(`[mint] rpc=${safeRpcLabel(activeRpc)}`);

  const results: MintResult[] = [];
  const skipParentCheck = process.env.ENS_SKIP_PARENT_CHECK === '1';
  if (jobs.length && !skipParentCheck) {
    console.error(`[mint] checking parent ownership for ${jobs[0].ens_name}`);
    try {
      await withRetry(
        () => ensureParentOwnership(jobs[0].ens_name, publicClient, walletClient, account.address),
        5,
        1200,
        'parent-ownership',
      );
    } catch (e) {
      if (fallbackRpc && fallbackRpc !== activeRpc) {
        console.error(`[mint] switching rpc -> ${safeRpcLabel(fallbackRpc)}`);
        activeRpc = fallbackRpc;
        publicClient = createPublicClient({
          chain: addEnsContracts(sepolia),
          transport: http(activeRpc),
        });
        walletClient = createWalletClient({
          account,
          chain: addEnsContracts(sepolia),
          transport: http(activeRpc),
        });
        await withRetry(
          () => ensureParentOwnership(jobs[0].ens_name, publicClient, walletClient, account.address),
          5,
          1200,
          'parent-ownership-fallback',
        );
      } else {
        throw e;
      }
    }
  } else if (jobs.length && skipParentCheck) {
    console.error('[mint] skipping parent ownership check (ENS_SKIP_PARENT_CHECK=1)');
  }
  console.error(`[mint] processing ${jobs.length} subnames`);
  const states: JobState[] = jobs.map((job) => ({ job }));

  // Phase A: submit all subnode tx quickly.
  for (const s of states) {
    try {
      const parts = s.job.ens_name.split('.');
      if (parts.length < 3) throw new Error('Expected subname format like a000001.simcity.eth');
      const child = parts[0];
      const parent = parts.slice(1).join('.');
      const parentNode = namehash(parent);
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
      s.subnodeTx = await walletClient.writeContract(request);
      console.error(`[mint] submitted subnode ${s.job.ens_name} tx=${s.subnodeTx.slice(0, 10)}...`);
    } catch (e) {
      s.error = String(e);
    }
  }

  await Promise.all(
    states
      .filter((s) => s.subnodeTx && !s.error)
      .map(async (s) => {
        try {
          await publicClient.waitForTransactionReceipt({ hash: s.subnodeTx! });
        } catch (e) {
          s.error = String(e);
        }
      }),
  );

  // Phase B: submit all text-record tx quickly.
  for (const s of states) {
    if (s.error) continue;
    try {
      s.textTx = await setTextRecord(walletClient, {
        name: s.job.ens_name,
        key: 'axl_key',
        value: s.job.text_value,
        resolverAddress,
      });
      console.error(`[mint] submitted text ${s.job.ens_name} tx=${s.textTx.slice(0, 10)}...`);
    } catch (e) {
      s.error = String(e);
    }
  }

  await Promise.all(
    states
      .filter((s) => s.textTx && !s.error)
      .map(async (s) => {
        try {
          await publicClient.waitForTransactionReceipt({ hash: s.textTx! });
        } catch (e) {
          s.error = String(e);
        }
      }),
  );

  for (const s of states) {
    if (s.error || !s.textTx) {
      results.push({
        agent_id: s.job.agent_id,
        ens_name: s.job.ens_name,
        status: 'failed',
        error: s.error || 'unknown_error',
      });
      continue;
    }
    results.push({
      agent_id: s.job.agent_id,
      ens_name: s.job.ens_name,
      status: 'minted',
      tx_hash: s.textTx,
    });
  }

  const json = JSON.stringify(results);
  if (outputPath) {
    fs.writeFileSync(outputPath, json, 'utf-8');
  } else {
    process.stdout.write(json);
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i >= attempts) break;
      const delay = baseDelayMs * i;
      console.error(`[mint] ${label} failed attempt ${i}/${attempts}: ${String(e).slice(0, 220)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

function loadLocalEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const candidates = ['.env', `${__dirname}/.env`];
  let p: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      p = c;
      break;
    }
  }
  if (!p) return out;
  const raw = fs.readFileSync(p, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const [k, ...rest] = s.split('=');
    out[k.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function safeRpcLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

async function ensureParentOwnership(
  subname: string,
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  accountAddress: `0x${string}`,
) {
  const parts = subname.split('.');
  if (parts.length < 3 || parts[parts.length - 1] !== 'eth') return;
  const parent = parts.slice(1).join('.');
  const parentNode = namehash(parent);
  const registryAddress = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as `0x${string}`;
  const owner = (await publicClient.readContract({
    address: registryAddress,
    abi: [{ name: 'owner', type: 'function', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }],
    functionName: 'owner',
    args: [parentNode],
  })) as `0x${string}`;
  if (owner.toLowerCase() === accountAddress.toLowerCase()) return;
  console.error(`[mint] parent not owned by wallet. attempting register ${parent}`);

  const available = await getAvailable(publicClient, { name: parent });
  if (!available) {
    throw new Error(`Parent ENS name ${parent} not owned by current wallet and not available`);
  }

  const secret = ('0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')) as `0x${string}`;
  const duration = 31536000;
  const price = await getPrice(publicClient, { nameOrNames: parent, duration });
  const commitParams = { name: parent, duration, owner: accountAddress, secret };
  const commitTx = await commitName(walletClient, commitParams);
  await publicClient.waitForTransactionReceipt({ hash: commitTx });
  console.error("[mint] parent commit confirmed, waiting 70s maturity...");
  await new Promise((r) => setTimeout(r, 70000));
  const valueToSend = ((price.base + price.premium) * 110n) / 100n;
  const regTx = await registerName(walletClient, { ...commitParams, value: valueToSend });
  await publicClient.waitForTransactionReceipt({ hash: regTx });
  console.error(`[mint] parent registered: ${parent}`);
}

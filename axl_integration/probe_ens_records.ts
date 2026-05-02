import fs from 'fs';
import { createPublicClient, http, namehash } from 'viem';
import { sepolia } from 'viem/chains';
import { addEnsContracts } from '@ensdomains/ensjs';

type Job = { agent_id: string; ens_name: string; expected_axl_key?: string | null };
type Out = {
  agent_id: string;
  ens_name: string;
  owner: string;
  minted: boolean;
  axl_key: string;
  axl_key_match: boolean;
  error?: string;
};

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
  const conc = Number(process.argv[4] || '20');
  if (!input || !output) throw new Error('Usage: tsx probe_ens_records.ts <in.json> <out.json> [concurrency]');

  const jobs = JSON.parse(fs.readFileSync(input, 'utf-8')) as Job[];
  const env = loadEnv();
  const rpc = process.env.RPC_URL || env.RPC_URL;
  if (!rpc) throw new Error('RPC_URL required');

  const registryAddress = (process.env.ENS_REGISTRY_ADDRESS || env.ENS_REGISTRY_ADDRESS || '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e') as `0x${string}`;

  const publicClient = createPublicClient({ chain: addEnsContracts(sepolia), transport: http(rpc) });

  const queue = [...jobs];
  const out: Out[] = [];
  const workers = Array.from({ length: Math.max(1, conc) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      try {
        const node = namehash(job.ens_name);
        const owner = (await publicClient.readContract({
          address: registryAddress,
          abi: [
            {
              name: 'owner',
              type: 'function',
              inputs: [{ name: 'node', type: 'bytes32' }],
              outputs: [{ type: 'address' }],
            },
          ],
          functionName: 'owner',
          args: [node],
        })) as string;

        const minted = owner.toLowerCase() !== '0x0000000000000000000000000000000000000000';
        let axlKey = '';
        let axlMatch = false;

        if (minted) {
          try {
            const resolver = (await publicClient.readContract({
              address: registryAddress,
              abi: [
                {
                  name: 'resolver',
                  type: 'function',
                  inputs: [{ name: 'node', type: 'bytes32' }],
                  outputs: [{ type: 'address' }],
                },
              ],
              functionName: 'resolver',
              args: [node],
            })) as `0x${string}`;

            if (resolver && resolver !== '0x0000000000000000000000000000000000000000') {
              axlKey =
                ((await publicClient.readContract({
                  address: resolver,
                  abi: [
                    {
                      name: 'text',
                      type: 'function',
                      inputs: [
                        { name: 'node', type: 'bytes32' },
                        { name: 'key', type: 'string' },
                      ],
                      outputs: [{ type: 'string' }],
                    },
                  ],
                  functionName: 'text',
                  args: [node, 'axl_key'],
                })) as string) || '';
            }
          } catch {
            // keep going even if text read fails
          }
        }

        if (job.expected_axl_key && axlKey) {
          axlMatch = axlKey.trim() === (job.expected_axl_key || '').trim();
        }

        out.push({
          agent_id: job.agent_id,
          ens_name: job.ens_name,
          owner,
          minted,
          axl_key: axlKey,
          axl_key_match: axlMatch,
        });
      } catch (e) {
        out.push({
          agent_id: job.agent_id,
          ens_name: job.ens_name,
          owner: '0x0000000000000000000000000000000000000000',
          minted: false,
          axl_key: '',
          axl_key_match: false,
          error: String(e),
        });
      }
    }
  });

  await Promise.all(workers);
  fs.writeFileSync(output, JSON.stringify(out), 'utf-8');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

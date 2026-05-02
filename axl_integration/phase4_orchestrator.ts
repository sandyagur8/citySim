import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as http_module from 'http';
import { createPublicClient, http, namehash } from 'viem';
import { sepolia } from 'viem/chains';
import { addEnsContracts } from '@ensdomains/ensjs';

dotenv.config();

type AgentConfig = {
  id: string;
  ens: string;
  nodeApiPort: number;
};

type InteractionConfig = {
  from: string;
  to: string;
  message: string;
  expectReply?: boolean;
  replyMessage?: string;
};

type Phase4Config = {
  agents: AgentConfig[];
  interactions: InteractionConfig[];
  pollRetries?: number;
  pollIntervalMs?: number;
};

const ENS_REGISTRY_DEFAULT = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ENS_PUBLIC_RESOLVER_DEFAULT = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD';

function loadConfig(): Phase4Config {
  const cfgPath = process.argv[2] || path.join(__dirname, 'phase4_config.json');
  const raw = fs.readFileSync(cfgPath, 'utf-8');
  return JSON.parse(raw) as Phase4Config;
}

function sendMessage(senderPort: number, destinationKey: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http_module.request(
      {
        hostname: '127.0.0.1',
        port: senderPort,
        path: '/send',
        method: 'POST',
        headers: {
          'X-Destination-Peer-Id': destinationKey,
          'Content-Type': 'text/plain',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.write(message);
    req.end();
  });
}

function checkTopology(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http_module.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/topology',
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function receiveMessage(receiverPort: number): Promise<{ senderKey?: string; message?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = http_module.request(
      {
        hostname: '127.0.0.1',
        port: receiverPort,
        path: '/recv',
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            senderKey: res.headers['x-from-peer-id'] as string | undefined,
            message: data || undefined,
            status: res.statusCode || 0,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function resolveResolverAddress(publicClient: ReturnType<typeof createPublicClient>, ensName: string): Promise<`0x${string}`> {
  const registryAddress = (process.env.ENS_REGISTRY_ADDRESS || ENS_REGISTRY_DEFAULT) as `0x${string}`;
  const node = namehash(ensName);
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
  return resolver;
}

async function resolveAXLKey(publicClient: ReturnType<typeof createPublicClient>, ensName: string): Promise<string> {
  const node = namehash(ensName);
  const resolverFromRegistry = await resolveResolverAddress(publicClient, ensName);
  const resolverAddress =
    resolverFromRegistry === '0x0000000000000000000000000000000000000000'
      ? (process.env.ENS_PUBLIC_RESOLVER_ADDRESS || ENS_PUBLIC_RESOLVER_DEFAULT)
      : resolverFromRegistry;

  const key = (await publicClient.readContract({
    address: resolverAddress as `0x${string}`,
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
  })) as string;

  if (!key || key.trim().length === 0) {
    throw new Error(`No axl_key text record found for ${ensName}`);
  }
  return key;
}

async function pollInbox(port: number, retries: number, intervalMs: number): Promise<{ senderKey: string; message: string } | null> {
  for (let i = 0; i < retries; i++) {
    const recv = await receiveMessage(port);
    if (recv.status === 200 && recv.senderKey && recv.message) {
      return { senderKey: recv.senderKey, message: recv.message };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function main() {
  const cfg = loadConfig();
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error('RPC_URL missing in environment');
  }

  const publicClient = createPublicClient({
    chain: addEnsContracts(sepolia),
    transport: http(rpcUrl),
  });

  const agentsById = new Map(cfg.agents.map((a) => [a.id, a]));
  const retries = cfg.pollRetries ?? 12;
  const intervalMs = cfg.pollIntervalMs ?? 1000;

  console.log(`Phase 4 orchestrator start. ${cfg.agents.length} agents, ${cfg.interactions.length} interactions.`);

  // Fail fast with actionable info if local AXL APIs are down.
  for (const agent of cfg.agents) {
    try {
      const topo = await checkTopology(agent.nodeApiPort);
      if (topo.status !== 200) {
        throw new Error(`topology status=${topo.status}`);
      }
      console.log(`[node-ok] ${agent.id} api_port=${agent.nodeApiPort}`);
    } catch (err) {
      throw new Error(
        `AXL node for ${agent.id} not reachable at 127.0.0.1:${agent.nodeApiPort}. Start nodes first (example: python3 run_nodes.py). Root error: ${String(
          err,
        )}`,
      );
    }
  }

  for (const step of cfg.interactions) {
    const sender = agentsById.get(step.from);
    const receiver = agentsById.get(step.to);
    if (!sender || !receiver) {
      throw new Error(`Invalid interaction mapping: ${step.from} -> ${step.to}`);
    }

    console.log(`\n[resolve] ${receiver.id} ENS=${receiver.ens}`);
    const destinationKey = await resolveAXLKey(publicClient, receiver.ens);
    console.log(`[send] ${sender.id}(${sender.nodeApiPort}) -> ${receiver.id} key=${destinationKey.slice(0, 12)}...`);
    await sendMessage(sender.nodeApiPort, destinationKey, step.message);
    console.log(`[send] delivered payload="${step.message}"`);

    const recv = await pollInbox(receiver.nodeApiPort, retries, intervalMs);
    if (!recv) {
      throw new Error(`Receiver ${receiver.id} did not receive message in time`);
    }
    console.log(`[recv] ${receiver.id} <- ${recv.senderKey.slice(0, 12)}... : "${recv.message}"`);

    if (step.expectReply) {
      const replyPayload = step.replyMessage || `ACK from ${receiver.id}: received "${step.message}"`;
      await sendMessage(receiver.nodeApiPort, recv.senderKey, replyPayload);
      console.log(`[reply-send] ${receiver.id} -> ${sender.id} payload="${replyPayload}"`);

      const reply = await pollInbox(sender.nodeApiPort, retries, intervalMs);
      if (!reply) {
        throw new Error(`Sender ${sender.id} expected reply but none received`);
      }
      console.log(`[reply] ${sender.id} <- ${reply.senderKey.slice(0, 12)}... : "${reply.message}"`);
    }
  }

  console.log('\nPhase 4 orchestrator complete.');
}

main().catch((err) => {
  console.error('Phase 4 orchestrator failed:', err);
  process.exit(1);
});

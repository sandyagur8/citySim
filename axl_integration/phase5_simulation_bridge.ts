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

type SimInteractionEvent = {
  interaction_id: string;
  tick_minute: number;
  buyer_id: string;
  seller_id: string;
  biz_id: string;
  scene_prompt: string;
  buyer_message: string;
  expect_reply?: boolean;
  seller_reply_template?: string;
};

type Phase5Config = {
  agents: AgentConfig[];
  events_file: string;
  outcomes_file: string;
  start_tick?: number;
  end_tick?: number;
  tick_interval_ms?: number;
  poll_retries?: number;
  poll_interval_ms?: number;
};

const ENS_REGISTRY_DEFAULT = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ENS_PUBLIC_RESOLVER_DEFAULT = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD';

function loadConfig(): Phase5Config {
  const cfgPath = process.argv[2] || path.join(__dirname, 'phase5_config.json');
  const raw = fs.readFileSync(cfgPath, 'utf-8');
  return JSON.parse(raw) as Phase5Config;
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

async function resolveResolverAddress(publicClient: ReturnType<typeof createPublicClient>, ensName: string): Promise<`0x${string}`> {
  const registryAddress = (process.env.ENS_REGISTRY_ADDRESS || ENS_REGISTRY_DEFAULT) as `0x${string}`;
  const node = namehash(ensName);
  return (await publicClient.readContract({
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

function loadEvents(eventsFile: string): SimInteractionEvent[] {
  const raw = fs.readFileSync(eventsFile, 'utf-8');
  const parsed = JSON.parse(raw) as SimInteractionEvent[];
  return parsed.sort((a, b) => a.tick_minute - b.tick_minute);
}

function appendOutcome(outcomesFile: string, payload: Record<string, unknown>): void {
  fs.appendFileSync(outcomesFile, JSON.stringify(payload) + '\n', 'utf-8');
}

async function main() {
  const cfg = loadConfig();
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL missing in environment');

  const publicClient = createPublicClient({
    chain: addEnsContracts(sepolia),
    transport: http(rpcUrl),
  });

  const agentsById = new Map(cfg.agents.map((a) => [a.id, a]));
  const eventsFilePath = path.isAbsolute(cfg.events_file) ? cfg.events_file : path.join(__dirname, cfg.events_file);
  const outcomesFilePath = path.isAbsolute(cfg.outcomes_file) ? cfg.outcomes_file : path.join(__dirname, cfg.outcomes_file);
  const events = loadEvents(eventsFilePath);

  const startTick = cfg.start_tick ?? (events.length ? events[0].tick_minute : 0);
  const endTick = cfg.end_tick ?? (events.length ? events[events.length - 1].tick_minute : 0);
  const tickIntervalMs = cfg.tick_interval_ms ?? 20;
  const pollRetries = cfg.poll_retries ?? 12;
  const pollIntervalMs = cfg.poll_interval_ms ?? 1000;

  for (const agent of cfg.agents) {
    const topo = await checkTopology(agent.nodeApiPort).catch((err) => {
      throw new Error(`AXL node ${agent.id} unreachable at 127.0.0.1:${agent.nodeApiPort}. ${String(err)}`);
    });
    if (topo.status !== 200) throw new Error(`AXL node ${agent.id} bad /topology status=${topo.status}`);
    console.log(`[node-ok] ${agent.id} api_port=${agent.nodeApiPort}`);
  }

  fs.writeFileSync(outcomesFilePath, '', 'utf-8');
  console.log(`Phase 5 sim bridge start. ticks ${startTick}..${endTick}, events=${events.length}`);

  let pointer = 0;
  for (let tick = startTick; tick <= endTick; tick++) {
    while (pointer < events.length && events[pointer].tick_minute === tick) {
      const event = events[pointer];
      pointer += 1;

      const buyer = agentsById.get(event.buyer_id);
      const seller = agentsById.get(event.seller_id);
      if (!buyer || !seller) {
        appendOutcome(outcomesFilePath, {
          interaction_id: event.interaction_id,
          tick_minute: tick,
          status: 'failed',
          reason: 'unknown_agent_mapping',
        });
        continue;
      }

      try {
        const destinationKey = await resolveAXLKey(publicClient, seller.ens);
        const payload = {
          interaction_id: event.interaction_id,
          tick_minute: tick,
          buyer_id: event.buyer_id,
          seller_id: event.seller_id,
          biz_id: event.biz_id,
          scene_prompt: event.scene_prompt,
          buyer_message: event.buyer_message,
        };
        await sendMessage(buyer.nodeApiPort, destinationKey, JSON.stringify(payload));

        const recv = await pollInbox(seller.nodeApiPort, pollRetries, pollIntervalMs);
        if (!recv) throw new Error('seller_did_not_receive');

        let replyText: string | null = null;
        if (event.expect_reply) {
          replyText = event.seller_reply_template || `seller_ack:${event.interaction_id}`;
          await sendMessage(seller.nodeApiPort, recv.senderKey, replyText);
          const replyRecv = await pollInbox(buyer.nodeApiPort, pollRetries, pollIntervalMs);
          if (!replyRecv) throw new Error('buyer_did_not_receive_reply');
        }

        appendOutcome(outcomesFilePath, {
          interaction_id: event.interaction_id,
          tick_minute: tick,
          status: 'ok',
          buyer_id: event.buyer_id,
          seller_id: event.seller_id,
          biz_id: event.biz_id,
          scene_prompt: event.scene_prompt,
          buyer_message: event.buyer_message,
          seller_received_message: recv.message,
          seller_reply: replyText,
        });
        console.log(`[tick ${tick}] ok interaction=${event.interaction_id}`);
      } catch (err) {
        appendOutcome(outcomesFilePath, {
          interaction_id: event.interaction_id,
          tick_minute: tick,
          status: 'failed',
          reason: String(err),
          buyer_id: event.buyer_id,
          seller_id: event.seller_id,
          biz_id: event.biz_id,
        });
        console.log(`[tick ${tick}] failed interaction=${event.interaction_id}`);
      }
    }
    await new Promise((r) => setTimeout(r, tickIntervalMs));
  }

  console.log(`Phase 5 sim bridge complete. outcomes=${outcomesFilePath}`);
}

main().catch((err) => {
  console.error('Phase 5 sim bridge failed:', err);
  process.exit(1);
});

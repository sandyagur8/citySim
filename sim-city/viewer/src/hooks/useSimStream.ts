// WebSocket client for the simulator. Manages the connection lifecycle,
// parses init/tick/dialogue/summary messages, smooths agent positions
// between ticks for glassy visual movement, and exposes a tiny API for
// sending controls.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClockPayload,
  ControlMessage,
  DaySummaryDict,
  DialogueCard,
  LiveStats,
  ProductBriefDict,
  RunSummaryDict,
  ServerMessage,
  SimRunDict,
  WorldPayload,
} from '../lib/types';

// Must match BROADCAST_EVERY_SIM_MIN in src/citysim/server/sim.py.
// Lower = smoother animation at high speed multipliers (e.g. 1440×).
const BROADCAST_EVERY_SIM_MIN = 2;

// Cap matched to backend's _RECENT_DIALOGUES_MAX.
const RECENT_DIALOGUES_MAX = 30;

const EMPTY_STATS: LiveStats = {
  n_dialogues: 0,
  n_purchases: 0,
  n_product_dialogues: 0,
  n_units_sold: 0,
  product_revenue: 0,
  arm_random: { count: 0, purchases: 0 },
  arm_targeted: { count: 0, purchases: 0 },
};

export type SmoothedPositions = {
  // Float32Array length = nAgents * 2, layout [x0, y0, x1, y1, ...]
  positions: Float32Array;
  // Uint8Array length = nAgents, activity code per agent
  activities: Uint8Array;
  simMinute: number;
};

const EMPTY_RUN: SimRunDict = {
  status: 'idle',
  config: {
    product_name: null,
    total_days: 1,
    agent_cap: null,
    baseline_ratio: 0.25,
    model: null,
    dialogue_workers: 1,
    target_dialogues_per_day: 60,
    max_turns: 6,
  },
  start_day: 0,
  days_completed: 0,
  dialogues_today: 0,
};

export type SimStream = {
  connected: boolean;
  world: WorldPayload | null;
  clock: ClockPayload | null;
  smoothed: SmoothedPositions | null;
  product: ProductBriefDict | null;
  products: ProductBriefDict[];
  stats: LiveStats;
  recentDialogues: DialogueCard[];
  daySummary: DaySummaryDict | null;
  /** Most recently surfaced summary (modal-trigger). Null after dismissal. */
  pendingSummary: DaySummaryDict | null;
  dismissSummary: () => void;
  /** Simulation run state (idle / running / completed). */
  run: SimRunDict;
  /** Cumulative report broadcast at end-of-run; null until simulation_completed. */
  runSummary: RunSummaryDict | null;
  /** Same as runSummary, but cleared on dismiss; drives the RunReportModal. */
  pendingRunSummary: RunSummaryDict | null;
  dismissRunSummary: () => void;
  send: (m: ControlMessage) => void;
};

export function useSimStream(url = '/ws'): SimStream {
  const [connected, setConnected] = useState(false);
  const [world, setWorld] = useState<WorldPayload | null>(null);
  const [clock, setClock] = useState<ClockPayload | null>(null);
  const [smoothed, setSmoothed] = useState<SmoothedPositions | null>(null);
  const [product, setProduct] = useState<ProductBriefDict | null>(null);
  const [products, setProducts] = useState<ProductBriefDict[]>([]);
  const [stats, setStats] = useState<LiveStats>(EMPTY_STATS);
  const [recentDialogues, setRecentDialogues] = useState<DialogueCard[]>([]);
  const [daySummary, setDaySummary] = useState<DaySummaryDict | null>(null);
  const [pendingSummary, setPendingSummary] = useState<DaySummaryDict | null>(null);
  const [run, setRun] = useState<SimRunDict>(EMPTY_RUN);
  const [runSummary, setRunSummary] = useState<RunSummaryDict | null>(null);
  const [pendingRunSummary, setPendingRunSummary] = useState<RunSummaryDict | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  // Latest two received tick samples, used for interpolation
  const prevSampleRef = useRef<{
    pos: Float32Array;
    act: Uint8Array;
    min: number;
    t: number;
  } | null>(null);
  const currSampleRef = useRef<{
    pos: Float32Array;
    act: Uint8Array;
    min: number;
    t: number;
  } | null>(null);
  // Cache of speed for tick-interval estimation
  const speedRef = useRef<number>(60);

  const send = useMemo(() => {
    return (m: ControlMessage) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(m));
      }
    };
  }, []);

  const dismissSummary = useCallback(() => setPendingSummary(null), []);
  const dismissRunSummary = useCallback(() => setPendingRunSummary(null), []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const fullUrl = url.startsWith('ws')
        ? url
        : `${wsProto}//${window.location.host}${url}`;
      const ws = new WebSocket(fullUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        // Reconnect with backoff
        reconnectTimeout = setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        // Errors will trigger onclose; nothing to do here.
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (msg.type === 'init') {
          setWorld(msg.world);
          setClock(msg.clock);
          setProduct(msg.product);
          setProducts(msg.products ?? (msg.product ? [msg.product] : []));
          setStats(msg.stats ?? EMPTY_STATS);
          setRecentDialogues(msg.recent_dialogues ?? []);
          setDaySummary(msg.last_day_summary);
          setRun(msg.run ?? EMPTY_RUN);
          setRunSummary(msg.last_run_summary ?? null);
          // Don't auto-pop the modal on connect — the user already saw it.
          speedRef.current = msg.clock.speed_multiplier;
          // Initialise samples from current world (everyone at home)
          const n = msg.world.agents.length;
          const pos = new Float32Array(n * 2);
          const act = new Uint8Array(n);
          for (let i = 0; i < n; i++) {
            const a = msg.world.agents[i];
            pos[i * 2] = a.home_cell[0];
            pos[i * 2 + 1] = a.home_cell[1];
            act[i] = 0; // assume sleep until first tick
          }
          const t = performance.now();
          prevSampleRef.current = { pos, act, min: msg.clock.sim_minute, t };
          currSampleRef.current = { pos, act, min: msg.clock.sim_minute, t };
        } else if (msg.type === 'tick') {
          const n = msg.positions.length;
          const pos = new Float32Array(n * 2);
          const act = new Uint8Array(n);
          for (let i = 0; i < n; i++) {
            const row = msg.positions[i];
            pos[i * 2] = row[0] / 1000;
            pos[i * 2 + 1] = row[1] / 1000;
            act[i] = row[2];
          }
          const t = performance.now();
          prevSampleRef.current =
            currSampleRef.current ?? { pos, act, min: msg.sim_minute, t };
          currSampleRef.current = { pos, act, min: msg.sim_minute, t };
          if (msg.stats) setStats(msg.stats);
          if (msg.run) setRun(msg.run);
          setClock((c) =>
            c
              ? {
                  ...c,
                  sim_minute: msg.sim_minute,
                  day_of_year: msg.day_of_year,
                  day_of_week: msg.day_of_week,
                }
              : c,
          );
        } else if (msg.type === 'dialogue_started') {
          setRecentDialogues((rs) => {
            const card: DialogueCard = {
              dialogue_id: msg.dialogue_id,
              buyer_id: msg.buyer_id,
              buyer_age: msg.buyer_age,
              buyer_occupation: msg.buyer_occupation,
              establishment_id: msg.establishment_id,
              establishment_kind: msg.establishment_kind,
              product_id: msg.product_id,
              dialogue_kind: msg.dialogue_kind,
              arm: msg.arm,
              targeted: msg.targeted,
              sim_minute: msg.sim_minute,
              status: 'live',
              outcome: null,
              turns: [],
            };
            return [card, ...rs].slice(0, RECENT_DIALOGUES_MAX);
          });
        } else if (msg.type === 'dialogue_turn') {
          setRecentDialogues((rs) =>
            rs.map((c) =>
              c.dialogue_id === msg.dialogue_id
                ? {
                    ...c,
                    turns: [
                      ...(c.turns ?? []),
                      { speaker: msg.speaker, text: msg.text },
                    ],
                  }
                : c,
            ),
          );
        } else if (msg.type === 'dialogue_ended') {
          const purchased = !!(
            msg.outcome?.purchased || msg.end_reason === 'buy'
          );
          setRecentDialogues((rs) =>
            rs.map((c) =>
              c.dialogue_id === msg.dialogue_id
                ? {
                    ...c,
                    status: 'ended',
                    end_reason: msg.end_reason,
                    outcome: msg.outcome,
                    purchased,
                  }
                : c,
            ),
          );
        } else if (msg.type === 'day_summary') {
          setDaySummary(msg.summary);
          setPendingSummary(msg.summary);
        } else if (msg.type === 'product_updated') {
          setProduct(msg.product);
          setProducts(msg.product ? [msg.product] : []);
        } else if (msg.type === 'products_updated') {
          // Refresh the library, but DO NOT auto-switch the displayed
          // "product under test". The user explicitly chose one in the
          // wizard (or via the edit modal); adding a new product to the
          // library shouldn't yank that out from under them.
          const list = msg.products ?? [];
          setProducts(list);
          setProduct((current) => {
            // Keep the current selection if it still exists in the list.
            if (current && list.some((p) => p.name === current.name)) {
              return current;
            }
            // If nothing is selected yet, fall back to the first item.
            return list.length > 0 ? list[0] : null;
          });
        } else if (msg.type === 'simulation_status') {
          setRun(msg.run);
          if (typeof msg.paused === 'boolean') {
            setClock((c) => (c ? { ...c, paused: msg.paused as boolean } : c));
          }
        } else if (msg.type === 'simulation_completed') {
          setRun(msg.run);
          setRunSummary(msg.summary);
          setPendingRunSummary(msg.summary);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      wsRef.current?.close();
    };
  }, [url]);

  // Animation frame: interpolate between prev and curr samples.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const prev = prevSampleRef.current;
      const curr = currSampleRef.current;
      if (!prev || !curr) return;
      const speed = speedRef.current;
      // Expected tick interval in real ms:
      // expectedRealMs = BROADCAST_EVERY_SIM_MIN * 60 * 1000 / speed
      const expected = (BROADCAST_EVERY_SIM_MIN * 60 * 1000) / Math.max(speed, 0.001);
      const elapsed = performance.now() - curr.t;
      const t = Math.max(0, Math.min(1, elapsed / Math.max(expected, 1)));
      const n = curr.pos.length / 2;
      const pos = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const px = prev.pos[i * 2];
        const py = prev.pos[i * 2 + 1];
        const cx = curr.pos[i * 2];
        const cy = curr.pos[i * 2 + 1];
        pos[i * 2] = px + (cx - px) * t;
        pos[i * 2 + 1] = py + (cy - py) * t;
      }
      const simMinute = prev.min + (curr.min - prev.min) * t;
      setSmoothed({ positions: pos, activities: curr.act, simMinute });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keep speedRef synced with clock changes
  useEffect(() => {
    if (clock) speedRef.current = clock.speed_multiplier;
  }, [clock?.speed_multiplier]);

  // While a run is active, surface the brief that's locked to the run
  // rather than whatever the user last clicked. Falls back to `product`
  // if the run's product can't be resolved (shouldn't happen in practice).
  const effectiveProduct =
    run.status === 'running' && run.config.product_name
      ? products.find((p) => p.name === run.config.product_name) ?? product
      : product;

  return {
    connected,
    world,
    clock,
    smoothed,
    product: effectiveProduct,
    products,
    stats,
    recentDialogues,
    daySummary,
    pendingSummary,
    dismissSummary,
    run,
    runSummary,
    pendingRunSummary,
    dismissRunSummary,
    send,
  };
}

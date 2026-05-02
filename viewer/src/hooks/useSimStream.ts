// WebSocket client for the simulator. Manages the connection lifecycle,
// parses init/tick messages, smooths agent positions between ticks for
// glassy visual movement, and exposes a tiny API for sending controls.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClockPayload,
  ControlMessage,
  ServerMessage,
  WorldPayload,
} from '../lib/types';

// Must match BROADCAST_EVERY_SIM_MIN in src/citysim/server/sim.py.
// Lower = smoother animation at high speed multipliers (e.g. 1440×).
const BROADCAST_EVERY_SIM_MIN = 2;

export type SmoothedPositions = {
  // Float32Array length = nAgents * 2, layout [x0, y0, x1, y1, ...]
  positions: Float32Array;
  // Uint8Array length = nAgents, activity code per agent
  activities: Uint8Array;
  simMinute: number;
};

export type SimStream = {
  connected: boolean;
  world: WorldPayload | null;
  clock: ClockPayload | null;
  smoothed: SmoothedPositions | null;
  send: (m: ControlMessage) => void;
};

export function useSimStream(url = '/ws'): SimStream {
  const [connected, setConnected] = useState(false);
  const [world, setWorld] = useState<WorldPayload | null>(null);
  const [clock, setClock] = useState<ClockPayload | null>(null);
  const [smoothed, setSmoothed] = useState<SmoothedPositions | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  // Latest two received tick samples, used for interpolation
  const prevSampleRef = useRef<{ pos: Float32Array; act: Uint8Array; min: number; t: number } | null>(null);
  const currSampleRef = useRef<{ pos: Float32Array; act: Uint8Array; min: number; t: number } | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const fullUrl = url.startsWith('ws') ? url : `${wsProto}//${window.location.host}${url}`;
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
          prevSampleRef.current = currSampleRef.current ?? { pos, act, min: msg.sim_minute, t };
          currSampleRef.current = { pos, act, min: msg.sim_minute, t };
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
      // Expected tick interval in real ms: (BROADCAST_EVERY_SIM_MIN sim min) * (60s/min) / (speed sim-min / real-s)
      // Wait — speed = real-time multiplier, where 60x means 60 sim seconds = 1 real second.
      // BROADCAST_EVERY_SIM_MIN is in sim minutes = sim seconds * 60.
      // expectedRealMs = BROADCAST_EVERY_SIM_MIN * 60 * 1000 / speed
      const expected = (BROADCAST_EVERY_SIM_MIN * 60 * 1000) / Math.max(speed, 0.001);
      const elapsed = performance.now() - curr.t;
      const t = Math.max(0, Math.min(1, elapsed / Math.max(expected, 1)));
      const n = curr.pos.length / 2;
      const pos = new Float32Array(n * 2);
      // If activity differs (e.g. arrived), don't interpolate position — snap to curr.
      // For now we always lerp; the backend already interpolates during commute.
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

  return { connected, world, clock, smoothed, send };
}

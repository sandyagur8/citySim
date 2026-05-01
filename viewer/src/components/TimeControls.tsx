// Top-bar control strip. Play/pause, speed selector, current sim time, scrubber,
// connection state. Sends control messages to the backend.

import { useEffect, useState } from 'react';
import type { ClockPayload, ControlMessage } from '../lib/types';

type Props = {
  clock: ClockPayload | null;
  connected: boolean;
  send: (m: ControlMessage) => void;
};

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function TimeControls({ clock, connected, send }: Props) {
  const [scrub, setScrub] = useState<number | null>(null);
  // While dragging the scrubber we hold the slider value locally so the UI
  // doesn't fight the live stream
  useEffect(() => {
    if (scrub === null) return;
    const id = setTimeout(() => setScrub(null), 1500);
    return () => clearTimeout(id);
  }, [clock?.sim_minute]);

  if (!clock) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-neutral-900/85 text-neutral-200 backdrop-blur">
        <span className="text-sm opacity-70">{connected ? 'Loading sim…' : 'Connecting…'}</span>
      </div>
    );
  }

  const minute = scrub !== null ? scrub : clock.sim_minute;
  const hh = Math.floor(minute / 60);
  const mm = Math.floor(minute % 60);
  const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-neutral-900/85 text-neutral-100 backdrop-blur border-b border-neutral-800">
      <button
        className="px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-sm font-medium"
        onClick={() => send({ type: 'set_paused', value: !clock.paused })}
      >
        {clock.paused ? '▶ Play' : '⏸ Pause'}
      </button>

      <div className="flex items-center gap-1 text-sm">
        {[1, 4, 16, 60, 240].map((s) => (
          <button
            key={s}
            className={`px-2 py-0.5 rounded ${
              Math.round(clock.speed_multiplier) === s
                ? 'bg-amber-500 text-neutral-900 font-semibold'
                : 'bg-neutral-800 hover:bg-neutral-700'
            }`}
            onClick={() => send({ type: 'set_speed', value: s })}
          >
            {s}×
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 ml-2 font-mono text-base">
        <span className="text-amber-300 tabular-nums">{timeStr}</span>
        <span className="text-neutral-400 text-sm">
          {DOW[clock.day_of_week % 7]} · day {clock.day_of_year}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={1439}
        value={Math.round(minute)}
        onChange={(e) => setScrub(parseInt(e.target.value, 10))}
        onPointerUp={() => {
          if (scrub !== null) send({ type: 'jump_to_minute', value: scrub });
          setScrub(null);
        }}
        className="flex-1 accent-amber-400"
      />

      <span className={`text-xs ${connected ? 'text-emerald-400' : 'text-rose-400'}`}>
        {connected ? '● live' : '● offline'}
      </span>
    </div>
  );
}

// Stylised "scene view" of a single buyer↔seller conversation.
//
// Click a row in the DialogueFeed → this opens a modal with:
//   • A per-establishment-kind background (pub bar, coffee counter,
//     supermarket aisle, etc.) drawn in inline SVG.
//   • Two stick-figure-style avatars on either side (buyer left, seller right).
//   • Speech bubbles for each turn, revealed sequentially.
//     Live dialogues auto-advance as new turns stream in.
//     Ended dialogues let the user step through with prev/next or play again.
//   • Header showing buyer profile, establishment, product (if any), outcome.
//
// Pure CSS / inline-SVG — no canvas, no extra deps. Designed to read in a
// 5-second glance during a demo.

import { useEffect, useMemo, useState } from 'react';
import type { DialogueCard } from '../lib/types';

type Props = {
  card: DialogueCard;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// Per-establishment scene backgrounds
// ---------------------------------------------------------------------------

type SceneTheme = {
  /** Tailwind gradient classes for the room background. */
  bgClass: string;
  /** Inline SVG drawn behind the avatars to evoke the room. */
  decor: React.ReactNode;
  /** Emoji used as the seller's "uniform" hint. */
  sellerIcon: string;
  /** Friendly title shown in the header. */
  label: string;
};

const SCENES: Record<string, SceneTheme> = {
  coffee_shop: {
    bgClass: 'from-amber-950 via-amber-900 to-stone-900',
    sellerIcon: '☕',
    label: 'Coffee shop',
    decor: (
      <>
        {/* Counter */}
        <rect x="0" y="68%" width="100%" height="32%" fill="#3a1f0c" />
        <rect x="0" y="68%" width="100%" height="3%" fill="#5a3a20" />
        {/* Espresso machine silhouette */}
        <rect x="62%" y="46%" width="24%" height="22%" rx="4" fill="#2a1408" />
        <rect x="64%" y="48%" width="20%" height="6%" rx="2" fill="#7a4a28" />
        <circle cx="68%" cy="58%" r="1.6%" fill="#f0a040" />
        <circle cx="80%" cy="58%" r="1.6%" fill="#f0a040" />
        {/* Hanging menu board */}
        <rect x="10%" y="6%" width="36%" height="20%" rx="2" fill="#0e0a06" />
        <text x="14%" y="14%" fill="#d4a06a" fontSize="3.5" fontFamily="ui-monospace, monospace">
          MENU
        </text>
        <text x="14%" y="20%" fill="#a07840" fontSize="2.6" fontFamily="ui-monospace, monospace">
          espresso · latte · pour-over
        </text>
        {/* Steam */}
        <Steam x="74%" y="46%" />
      </>
    ),
  },
  pub: {
    bgClass: 'from-amber-900 via-orange-950 to-stone-950',
    sellerIcon: '🍺',
    label: 'Pub',
    decor: (
      <>
        <rect x="0" y="70%" width="100%" height="30%" fill="#2a1208" />
        <rect x="0" y="70%" width="100%" height="2%" fill="#6a3a18" />
        {/* Tap lineup */}
        <rect x="55%" y="55%" width="3%" height="15%" fill="#444" />
        <rect x="62%" y="55%" width="3%" height="15%" fill="#444" />
        <rect x="69%" y="55%" width="3%" height="15%" fill="#444" />
        <circle cx="56.5%" cy="54%" r="1.8%" fill="#e0a040" />
        <circle cx="63.5%" cy="54%" r="1.8%" fill="#a04020" />
        <circle cx="70.5%" cy="54%" r="1.8%" fill="#604020" />
        {/* Bottles */}
        <rect x="14%" y="42%" width="2%" height="10%" rx="0.5%" fill="#1a3a2a" />
        <rect x="18%" y="40%" width="2%" height="12%" rx="0.5%" fill="#3a1a1a" />
        <rect x="22%" y="42%" width="2%" height="10%" rx="0.5%" fill="#1a1a3a" />
        <rect x="26%" y="38%" width="2%" height="14%" rx="0.5%" fill="#2a1a3a" />
        {/* Neon sign */}
        <rect x="34%" y="10%" width="32%" height="14%" rx="3" fill="#0a0a0a" />
        <text x="38%" y="20%" fill="#ff5577" fontSize="6" fontFamily="ui-serif, serif">
          OPEN
        </text>
      </>
    ),
  },
  restaurant: {
    bgClass: 'from-rose-950 via-stone-900 to-amber-950',
    sellerIcon: '🍽️',
    label: 'Restaurant',
    decor: (
      <>
        <rect x="0" y="70%" width="100%" height="30%" fill="#3a1814" />
        <rect x="6%" y="65%" width="32%" height="6%" rx="2" fill="#7a3018" />
        {/* Plates */}
        <circle cx="22%" cy="68%" r="3%" fill="#e8e0d0" />
        <circle cx="22%" cy="68%" r="2%" fill="#c0a070" />
        {/* Candle */}
        <rect x="60%" y="58%" width="1.5%" height="10%" fill="#f0e0a0" />
        <ellipse cx="60.75%" cy="56%" rx="1.5%" ry="3%" fill="#ffaa30" opacity="0.9" />
      </>
    ),
  },
  supermarket: {
    bgClass: 'from-sky-950 via-slate-900 to-stone-900',
    sellerIcon: '🛒',
    label: 'Supermarket',
    decor: (
      <>
        {/* Shelves */}
        <rect x="4%" y="22%" width="92%" height="6%" fill="#1c2a3a" />
        <rect x="4%" y="32%" width="92%" height="6%" fill="#1c2a3a" />
        <rect x="4%" y="42%" width="92%" height="6%" fill="#1c2a3a" />
        <rect x="4%" y="52%" width="92%" height="6%" fill="#1c2a3a" />
        {/* Boxes on shelves */}
        {Array.from({ length: 18 }).map((_, i) => (
          <rect
            key={i}
            x={`${6 + (i % 9) * 10}%`}
            y={`${24 + Math.floor(i / 9) * 10}%`}
            width="8%"
            height="3%"
            fill={['#a04848', '#487aa0', '#48a060', '#a08048'][i % 4]}
          />
        ))}
        {/* Floor */}
        <rect x="0" y="72%" width="100%" height="28%" fill="#0e1a26" />
        {/* Tile lines */}
        {Array.from({ length: 8 }).map((_, i) => (
          <line
            key={i}
            x1={`${i * 12.5}%`}
            y1="72%"
            x2={`${i * 12.5}%`}
            y2="100%"
            stroke="#1a2a3a"
            strokeWidth="1"
          />
        ))}
      </>
    ),
  },
  hardware: {
    bgClass: 'from-stone-900 via-amber-950 to-stone-900',
    sellerIcon: '🔧',
    label: 'Hardware store',
    decor: (
      <>
        <rect x="0" y="70%" width="100%" height="30%" fill="#2a1f14" />
        {/* Tool pegboard */}
        <rect x="10%" y="14%" width="80%" height="40%" fill="#1a1208" />
        <rect x="10%" y="14%" width="80%" height="40%" fill="url(#peg)" opacity="0.4" />
        <text x="40%" y="64%" fill="#a08050" fontSize="4" fontFamily="ui-monospace, monospace">
          🔨 🔩 🪛 🪚
        </text>
        <defs>
          <pattern id="peg" patternUnits="userSpaceOnUse" width="6" height="6">
            <circle cx="3" cy="3" r="0.6" fill="#3a2410" />
          </pattern>
        </defs>
      </>
    ),
  },
  pharmacy: {
    bgClass: 'from-emerald-950 via-stone-900 to-emerald-950',
    sellerIcon: '💊',
    label: 'Pharmacy',
    decor: (
      <>
        <rect x="0" y="70%" width="100%" height="30%" fill="#0e2a1c" />
        {/* Cross sign */}
        <rect x="44%" y="14%" width="12%" height="3%" fill="#3aa060" />
        <rect x="48.5%" y="9%" width="3%" height="13%" fill="#3aa060" />
        {/* Shelves */}
        <rect x="6%" y="38%" width="36%" height="22%" fill="#0a1a14" />
        <rect x="58%" y="38%" width="36%" height="22%" fill="#0a1a14" />
        {Array.from({ length: 12 }).map((_, i) => (
          <rect
            key={i}
            x={`${i < 6 ? 8 + i * 6 : 60 + (i - 6) * 6}%`}
            y={`${42 + (i % 2) * 8}%`}
            width="4%"
            height="6%"
            fill={['#f0f0f0', '#e0e0a0', '#a0e0f0'][i % 3]}
          />
        ))}
      </>
    ),
  },
  clothing: {
    bgClass: 'from-fuchsia-950 via-stone-900 to-rose-950',
    sellerIcon: '👕',
    label: 'Clothing store',
    decor: (
      <>
        <rect x="0" y="72%" width="100%" height="28%" fill="#1a0a14" />
        {/* Racks */}
        {Array.from({ length: 10 }).map((_, i) => (
          <g key={i}>
            <line
              x1={`${10 + i * 9}%`}
              y1="35%"
              x2={`${10 + i * 9}%`}
              y2="55%"
              stroke="#7a5a4a"
              strokeWidth="0.8"
            />
            <rect
              x={`${8 + i * 9}%`}
              y="45%"
              width="4%"
              height="10%"
              rx="1"
              fill={['#a04880', '#80a048', '#48a0a0', '#a07048', '#7048a0'][i % 5]}
            />
          </g>
        ))}
      </>
    ),
  },
  bank: {
    bgClass: 'from-slate-950 via-stone-900 to-slate-900',
    sellerIcon: '💼',
    label: 'Bank',
    decor: (
      <>
        <rect x="0" y="70%" width="100%" height="30%" fill="#1a1f2a" />
        {/* Teller windows */}
        <rect x="12%" y="34%" width="22%" height="28%" rx="2" fill="#0a0e1a" />
        <rect x="40%" y="34%" width="22%" height="28%" rx="2" fill="#0a0e1a" />
        <rect x="68%" y="34%" width="22%" height="28%" rx="2" fill="#0a0e1a" />
        {/* Logo */}
        <text
          x="44%"
          y="20%"
          fill="#9ab0d0"
          fontSize="6"
          fontFamily="ui-serif, serif"
          fontWeight="bold"
        >
          BANK
        </text>
      </>
    ),
  },
};

const FALLBACK_SCENE: SceneTheme = {
  bgClass: 'from-stone-900 via-stone-800 to-stone-900',
  sellerIcon: '🏪',
  label: 'Shop',
  decor: <rect x="0" y="70%" width="100%" height="30%" fill="#2a2a2a" />,
};

// ---------------------------------------------------------------------------
// Steam puff helper for the coffee scene
// ---------------------------------------------------------------------------

function Steam({ x, y }: { x: string; y: string }) {
  return (
    <g opacity="0.55">
      <ellipse cx={x} cy={y} rx="2%" ry="3%" fill="#e0d8d0">
        <animate attributeName="cy" values={`${y};${parseInt(y) - 6}%`} dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.6;0" dur="2.4s" repeatCount="indefinite" />
      </ellipse>
      <ellipse cx={x} cy={y} rx="1.6%" ry="2.4%" fill="#e0d8d0">
        <animate attributeName="cy" values={`${y};${parseInt(y) - 9}%`} dur="3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0" dur="3s" repeatCount="indefinite" />
      </ellipse>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Avatar — stylised circle head + body
// ---------------------------------------------------------------------------

function Avatar({
  side,
  hue,
  badge,
  speaking,
}: {
  side: 'left' | 'right';
  hue: number;
  badge: string;
  speaking: boolean;
}) {
  const flip = side === 'right' ? 'scale-x-[-1]' : '';
  const ringCls = speaking
    ? 'ring-2 ring-emerald-400/80 ring-offset-2 ring-offset-transparent'
    : '';
  return (
    <div className={`relative flex flex-col items-center ${flip}`}>
      <div
        className={`h-16 w-16 rounded-full grid place-items-center text-3xl shadow-lg transition-all ${ringCls}`}
        style={{ background: `hsl(${hue}, 55%, 38%)` }}
      >
        <span className={flip}>{badge}</span>
      </div>
      <div
        className="mt-1 h-12 w-10 rounded-t-2xl shadow"
        style={{ background: `hsl(${hue}, 45%, 30%)` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConversationScene({ card, onClose }: Props) {
  const scene = SCENES[card.establishment_kind] ?? FALLBACK_SCENE;
  const turns = card.turns ?? [];
  const live = card.status === 'live';

  // Visible-turn cursor: live dialogues auto-track the latest turn.
  const [cursor, setCursor] = useState<number>(turns.length - 1);
  useEffect(() => {
    if (live) setCursor(turns.length - 1);
  }, [live, turns.length]);

  const visibleTurns = useMemo(
    () => turns.slice(0, Math.min(turns.length, cursor + 1)),
    [turns, cursor],
  );

  const lastSpeaker = visibleTurns.length
    ? visibleTurns[visibleTurns.length - 1].speaker
    : null;

  // Hue per agent — derived from id so it's stable across re-renders.
  const hashHue = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  };
  const buyerHue = hashHue(card.buyer_id);
  const sellerHue = (buyerHue + 180) % 360;

  const outcomeBadge = card.purchased
    ? { text: '✓ Sold', cls: 'bg-emerald-600/30 text-emerald-200 border-emerald-700' }
    : card.end_reason === 'leave'
    ? { text: '✗ Walked out', cls: 'bg-neutral-700/40 text-neutral-300 border-neutral-700' }
    : card.status === 'live'
    ? { text: '● Live', cls: 'bg-amber-500/20 text-amber-300 border-amber-700 animate-pulse' }
    : { text: 'No purchase', cls: 'bg-neutral-700/40 text-neutral-400 border-neutral-700' };

  const motivator = card.outcome?.intrinsic_motivator;
  const winning = card.outcome?.seller_winning_phrase;
  const objections = card.outcome?.objections_raised ?? [];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative w-full max-w-4xl bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl overflow-hidden">
        {/* ---------- Header ---------- */}
        <div className="px-6 py-3 border-b border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{scene.sellerIcon}</span>
            <div>
              <div className="text-xs uppercase tracking-widest text-neutral-400">
                {scene.label}
                {card.product_id && (
                  <span className="ml-2 text-emerald-400">
                    · pitching {card.product_id}
                  </span>
                )}
              </div>
              <div className="text-sm text-neutral-100">
                {card.buyer_age ? `${card.buyer_age}y ` : ''}
                {card.buyer_occupation?.replace(/_/g, ' ') ?? card.buyer_id} →{' '}
                <span className="text-neutral-400">seller</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`text-[11px] font-mono px-2 py-0.5 rounded border ${outcomeBadge.cls}`}
            >
              {outcomeBadge.text}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="text-neutral-400 hover:text-neutral-100 text-xl leading-none ml-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* ---------- Scene stage ---------- */}
        <div
          className={`relative h-72 bg-gradient-to-b ${scene.bgClass} overflow-hidden`}
        >
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {scene.decor}
          </svg>

          {/* Avatars — sit on the floor area */}
          <div className="absolute inset-x-0 bottom-4 flex items-end justify-between px-12">
            <div className="flex flex-col items-center">
              <SpeechBubble
                side="left"
                visible={lastSpeaker === 'buyer'}
                text={
                  visibleTurns.find((t, i, arr) =>
                    arr.length - 1 - i < 6 && t.speaker === 'buyer',
                  )?.text ?? ''
                }
              />
              <Avatar
                side="left"
                hue={buyerHue}
                badge="🧑"
                speaking={lastSpeaker === 'buyer'}
              />
              <div className="mt-1 text-[10px] text-neutral-300 font-mono">buyer</div>
            </div>
            <div className="flex flex-col items-center">
              <SpeechBubble
                side="right"
                visible={lastSpeaker === 'seller'}
                text={
                  visibleTurns.find((t, i, arr) =>
                    arr.length - 1 - i < 6 && t.speaker === 'seller',
                  )?.text ?? ''
                }
              />
              <Avatar
                side="right"
                hue={sellerHue}
                badge={scene.sellerIcon}
                speaking={lastSpeaker === 'seller'}
              />
              <div className="mt-1 text-[10px] text-neutral-300 font-mono">seller</div>
            </div>
          </div>
        </div>

        {/* ---------- Transcript ---------- */}
        <div className="px-6 py-4 max-h-64 overflow-y-auto bg-neutral-950/40">
          {visibleTurns.length === 0 && (
            <div className="text-center text-sm text-neutral-500 italic py-4">
              {live ? 'Listening for the first line…' : 'No transcript captured.'}
            </div>
          )}
          <ol className="space-y-2 text-sm">
            {visibleTurns.map((t, i) => (
              <li
                key={i}
                className={
                  t.speaker === 'seller'
                    ? 'text-right'
                    : 'text-left'
                }
              >
                <div
                  className={`inline-block max-w-[78%] px-3 py-2 rounded-2xl ${
                    t.speaker === 'seller'
                      ? 'bg-sky-900/40 border border-sky-800/60 rounded-br-sm'
                      : 'bg-amber-900/30 border border-amber-800/60 rounded-bl-sm'
                  }`}
                >
                  <div
                    className={`text-[10px] uppercase tracking-widest ${
                      t.speaker === 'seller' ? 'text-sky-300' : 'text-amber-300'
                    }`}
                  >
                    {t.speaker}
                  </div>
                  <div className="text-neutral-100 leading-snug">{t.text}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* ---------- Outcome footer (for ended dialogues) ---------- */}
        {!live && card.outcome && (
          <div className="px-6 py-3 border-t border-neutral-800 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <FooterCell label="Decision" value={card.outcome.decisive_factor ?? '—'} />
            <FooterCell label="Motivator" value={motivator?.replace(/_/g, ' ') ?? '—'} />
            <FooterCell
              label="Target fit"
              value={card.outcome.target_fit ?? '—'}
            />
            <FooterCell
              label="Objections"
              value={objections.length ? objections.join(', ').replace(/_/g, ' ') : '—'}
            />
            {winning && (
              <div className="col-span-full bg-emerald-950/30 border border-emerald-800/60 rounded px-3 py-2">
                <div className="text-[10px] uppercase tracking-widest text-emerald-400 mb-0.5">
                  Winning phrase
                </div>
                <div className="italic text-emerald-100">"{winning}"</div>
              </div>
            )}
          </div>
        )}

        {/* ---------- Step controls (only for ended dialogues with multiple turns) ---------- */}
        {!live && turns.length > 1 && (
          <div className="px-6 py-2 border-t border-neutral-800 flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => setCursor((c) => Math.max(0, c - 1))}
              disabled={cursor <= 0}
              className="px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-30"
            >
              ← Prev
            </button>
            <span className="text-neutral-400 font-mono">
              Turn {Math.min(cursor + 1, turns.length)} / {turns.length}
            </span>
            <button
              type="button"
              onClick={() =>
                setCursor((c) => Math.min(turns.length - 1, c + 1))
              }
              disabled={cursor >= turns.length - 1}
              className="px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-30"
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FooterCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-neutral-800/50 border border-neutral-800 rounded px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-widest text-neutral-500">
        {label}
      </div>
      <div className="text-neutral-200">{value}</div>
    </div>
  );
}

function SpeechBubble({
  side,
  visible,
  text,
}: {
  side: 'left' | 'right';
  visible: boolean;
  text: string;
}) {
  if (!text) return null;
  // Only show the bubble for the latest speaker; older lines are in the
  // transcript below.
  return (
    <div
      className={`mb-2 max-w-[260px] transition-opacity ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div
        className={`relative px-3 py-2 rounded-2xl text-sm shadow-lg ${
          side === 'left'
            ? 'bg-amber-100 text-amber-950 rounded-bl-sm'
            : 'bg-sky-100 text-sky-950 rounded-br-sm'
        }`}
      >
        {text}
        <span
          className={`absolute -bottom-1 ${
            side === 'left' ? 'left-3' : 'right-3'
          } h-0 w-0 border-l-8 border-r-8 border-t-8 border-l-transparent border-r-transparent ${
            side === 'left' ? 'border-t-amber-100' : 'border-t-sky-100'
          }`}
        />
      </div>
    </div>
  );
}

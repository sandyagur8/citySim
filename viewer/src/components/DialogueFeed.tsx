// Bottom-right rolling feed of recent dialogues.
//
// Each row is collapsed by default — header summarises buyer + outcome.
// Click to expand and read the full streamed transcript. Live cards
// animate a typing indicator while turns continue to arrive.

import { useState } from 'react';
import type { DialogueCard } from '../lib/types';

type Props = {
  dialogues: DialogueCard[];
};

function fmtMin(simMinute: number | undefined): string {
  if (simMinute == null) return '';
  const m = Math.floor(simMinute) % 1440;
  const hh = Math.floor(m / 60).toString().padStart(2, '0');
  const mm = (m % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function badgeFor(card: DialogueCard) {
  if (card.status === 'live')
    return { text: 'LIVE', cls: 'bg-amber-500/20 text-amber-300 border-amber-700' };
  if (card.purchased)
    return { text: 'BUY', cls: 'bg-emerald-600/20 text-emerald-300 border-emerald-700' };
  if (card.end_reason === 'leave')
    return { text: 'LEFT', cls: 'bg-neutral-700/40 text-neutral-300 border-neutral-700' };
  return { text: 'PASS', cls: 'bg-neutral-700/40 text-neutral-400 border-neutral-700' };
}

export function DialogueFeed({ dialogues }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="absolute bottom-4 right-4 w-96 max-h-[55vh] z-10 pointer-events-auto flex flex-col">
      <div className="bg-neutral-900/85 backdrop-blur-md border border-neutral-700 rounded-lg shadow-xl overflow-hidden flex flex-col">
        <div className="px-4 py-2.5 border-b border-neutral-800 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-widest text-neutral-400">
            Live conversations
          </div>
          <div className="text-xs text-neutral-500">{dialogues.length} recent</div>
        </div>

        <div className="overflow-y-auto flex-1 divide-y divide-neutral-800">
          {dialogues.length === 0 && (
            <div className="px-4 py-6 text-sm text-neutral-500 text-center">
              Waiting for the first dialogue…
            </div>
          )}

          {dialogues.map((card) => {
            const badge = badgeFor(card);
            const isOpen = expanded === card.dialogue_id;
            const isProduct = card.dialogue_kind === 'product';
            const motiv = card.outcome?.intrinsic_motivator;
            const winning = card.outcome?.seller_winning_phrase;
            return (
              <div key={card.dialogue_id} className="bg-neutral-900">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : card.dialogue_id)}
                  className="w-full text-left px-4 py-2.5 hover:bg-neutral-800/60 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`shrink-0 mt-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded border ${badge.cls}`}
                    >
                      {badge.text}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs text-neutral-300">
                        <span className="font-mono">{fmtMin(card.sim_minute)}</span>
                        <span className="text-neutral-500 truncate">
                          {card.buyer_age ? `${card.buyer_age}y ` : ''}
                          {card.buyer_occupation?.replace('_', ' ') ?? card.buyer_id}
                        </span>
                        {card.targeted && (
                          <span className="shrink-0 text-[10px] text-emerald-400">★</span>
                        )}
                      </div>
                      <div className="text-xs text-neutral-500 truncate">
                        @ {card.establishment_kind.replace('_', ' ')}
                        {isProduct && card.product_id && (
                          <span> · pitching <span className="text-neutral-300">{card.product_id}</span></span>
                        )}
                      </div>
                      {(motiv || winning) && !isOpen && (
                        <div className="text-[11px] text-neutral-400 mt-0.5 truncate">
                          {motiv && motiv !== 'none' && (
                            <span>→ {motiv.replace('_', ' ')}</span>
                          )}
                          {motiv && motiv !== 'none' && winning && <span> · </span>}
                          {winning && (
                            <span className="italic">"{winning}"</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="px-4 pb-3 pt-1 bg-neutral-950/40 border-t border-neutral-800/50">
                    {(card.turns?.length ?? 0) === 0 ? (
                      <div className="text-xs text-neutral-500 italic">
                        {card.status === 'live'
                          ? 'Listening…'
                          : '(no transcript captured)'}
                      </div>
                    ) : (
                      <div className="space-y-1.5 text-xs">
                        {card.turns!.map((t, i) => (
                          <div key={i} className="leading-snug">
                            <span
                              className={
                                t.speaker === 'seller'
                                  ? 'text-sky-400 font-semibold'
                                  : 'text-amber-300 font-semibold'
                              }
                            >
                              {t.speaker === 'seller' ? 'Seller' : 'Buyer'}:
                            </span>{' '}
                            <span className="text-neutral-200">{t.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {card.outcome && card.status === 'ended' && (
                      <div className="mt-2 pt-2 border-t border-neutral-800 text-[11px] text-neutral-400 space-y-0.5">
                        {card.outcome.intrinsic_motivator &&
                          card.outcome.intrinsic_motivator !== 'none' && (
                            <div>
                              <span className="text-neutral-500">Motivator:</span>{' '}
                              {card.outcome.intrinsic_motivator.replace('_', ' ')}
                            </div>
                          )}
                        {card.outcome.objections_raised &&
                          card.outcome.objections_raised.length > 0 && (
                            <div>
                              <span className="text-neutral-500">Objections:</span>{' '}
                              {card.outcome.objections_raised
                                .map((o) => o.replace('_', ' '))
                                .join(', ')}
                            </div>
                          )}
                        {card.outcome.target_fit && (
                          <div>
                            <span className="text-neutral-500">Target fit:</span>{' '}
                            {card.outcome.target_fit}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

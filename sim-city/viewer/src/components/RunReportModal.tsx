// End-of-run cumulative report. Shown when a simulation_completed
// message arrives (after the configured total_days have elapsed).
//
// Mirrors DaySummaryModal's structure but aggregates across the run's
// day range — and adds a day-over-day trend mini-chart plus the
// "Rerun with different parameters" CTA that pre-fills the wizard's
// step 2 with the just-used product locked in.

import type { RunSummaryDict } from '../lib/types';

type Props = {
  summary: RunSummaryDict;
  onClose: () => void;
  onRerun: () => void;
};

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function RunReportModal({ summary, onClose, onRerun }: Props) {
  const hasProduct = summary.has_product;
  const days = summary.days_count;

  return (
    <div className="fixed inset-0 z-40 bg-black/75 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-6 px-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-full max-w-3xl text-neutral-100">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-emerald-400">
              Run complete · {days} day{days === 1 ? '' : 's'}
            </div>
            <h2 className="text-lg font-semibold">
              {hasProduct && summary.product_name
                ? `${summary.product_name} — cumulative report`
                : 'Cumulative activity report'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-200 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-6 max-h-[78vh] overflow-y-auto">
          {hasProduct && (
            <>
              <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat
                  label="Product convos"
                  value={summary.n_product_dialogues.toString()}
                />
                <Stat
                  label="Units sold"
                  value={summary.n_units_sold.toString()}
                  accent
                />
                <Stat
                  label="Conversion"
                  value={fmtPct(summary.product_conversion)}
                />
                <Stat
                  label="Revenue"
                  value={summary.product_revenue.toFixed(2)}
                />
              </section>

              {summary.trend.length > 1 && (
                <section>
                  <h3 className="text-xs uppercase tracking-widest text-neutral-400 mb-2">
                    Day-over-day
                  </h3>
                  <TrendTable summary={summary} />
                </section>
              )}

              {(summary.arm_random.count > 0 || summary.arm_targeted.count > 0) && (
                <section>
                  <h3 className="text-xs uppercase tracking-widest text-neutral-400 mb-2">
                    A/B sample (random vs targeted) — full run
                  </h3>
                  <div className="space-y-2">
                    <ArmBar label="Random" stats={summary.arm_random} />
                    <ArmBar label="Targeted" stats={summary.arm_targeted} accent />
                  </div>
                </section>
              )}

              {summary.top_intrinsic_motivators.length > 0 && (
                <section>
                  <h3 className="text-xs uppercase tracking-widest text-neutral-400 mb-2">
                    Why they bought (cumulative)
                  </h3>
                  <ul className="space-y-1">
                    {summary.top_intrinsic_motivators.map(([k, n]) => (
                      <li
                        key={k}
                        className="flex justify-between text-sm bg-neutral-800/50 rounded px-3 py-1.5"
                      >
                        <span>{k.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-emerald-400">{n}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {summary.top_winning_phrases.length > 0 && (
                <section>
                  <h3 className="text-xs uppercase tracking-widest text-neutral-400 mb-2">
                    Top phrases that converted
                  </h3>
                  <ul className="space-y-1.5">
                    {summary.top_winning_phrases.map(([phrase, n], i) => (
                      <li
                        key={i}
                        className="text-sm bg-neutral-800/50 rounded px-3 py-2"
                      >
                        <div className="text-neutral-100 italic">"{phrase}"</div>
                        <div className="text-xs text-neutral-500 mt-0.5">
                          mentioned in {n} successful dialogues
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {summary.top_objections.length > 0 && (
                <section>
                  <h3 className="text-xs uppercase tracking-widest text-neutral-400 mb-2">
                    Top objections
                  </h3>
                  <ul className="space-y-1">
                    {summary.top_objections.map(([k, n]) => (
                      <li
                        key={k}
                        className="flex justify-between text-sm bg-neutral-800/50 rounded px-3 py-1.5"
                      >
                        <span>{k.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-rose-400">{n}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {Object.keys(summary.by_age_band).length > 0 && (
                <section>
                  <h3 className="text-xs uppercase tracking-widest text-neutral-400 mb-2">
                    By age band
                  </h3>
                  <div className="space-y-2">
                    {['18-29', '30-44', '45-59', '60+']
                      .filter((b) => summary.by_age_band[b])
                      .map((band) => (
                        <ArmBar
                          key={band}
                          label={band}
                          stats={summary.by_age_band[band]}
                        />
                      ))}
                  </div>
                </section>
              )}

              <hr className="border-neutral-800" />
            </>
          )}

          <section>
            <h3 className="text-xs uppercase tracking-widest text-neutral-400 mb-2">
              All activity (product + baseline)
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Stat label="Dialogues" value={summary.n_dialogues.toString()} />
              <Stat label="Purchases" value={summary.n_purchases.toString()} />
              <Stat label="Conversion" value={fmtPct(summary.conversion)} />
            </div>
          </section>

          {Object.keys(summary.by_kind).length > 0 && (
            <section>
              <h3 className="text-xs uppercase tracking-widest text-neutral-400 mb-2">
                By establishment kind
              </h3>
              <div className="space-y-2">
                {Object.values(summary.by_kind)
                  .sort((a, b) => b.count - a.count)
                  .map((s) => (
                    <ArmBar key={s.label} label={s.label} stats={s} />
                  ))}
              </div>
            </section>
          )}
        </div>

        <div className="px-6 py-3 border-t border-neutral-800 flex justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onRerun}
            className="px-4 py-2 text-sm rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
          >
            Rerun with different parameters
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-neutral-800/50 border border-neutral-800 rounded px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-neutral-500">
        {label}
      </div>
      <div
        className={
          accent
            ? 'text-2xl font-mono font-semibold text-emerald-400'
            : 'text-2xl font-mono font-semibold text-neutral-100'
        }
      >
        {value}
      </div>
    </div>
  );
}

function ArmBar({
  label,
  stats,
  accent,
}: {
  label: string;
  stats: { count: number; purchases: number; conversion: number };
  accent?: boolean;
}) {
  const w = stats.count ? Math.min(100, stats.conversion * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-neutral-300">{label}</span>
        <span className="font-mono text-neutral-400">
          {(stats.conversion * 100).toFixed(1)}%{' '}
          <span className="text-neutral-600">
            · {stats.purchases}/{stats.count}
          </span>
        </span>
      </div>
      <div className="h-2 bg-neutral-800 rounded overflow-hidden">
        <div
          className={accent ? 'h-full bg-emerald-500' : 'h-full bg-sky-500'}
          style={{ width: `${w}%` }}
        />
      </div>
    </div>
  );
}

function TrendTable({ summary }: { summary: RunSummaryDict }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-neutral-500 border-b border-neutral-800">
            <th className="py-1 pr-3">Day</th>
            <th className="py-1 pr-3">Convos</th>
            <th className="py-1 pr-3">Product convos</th>
            <th className="py-1 pr-3">Units</th>
            <th className="py-1 pr-3">Conv.</th>
            <th className="py-1">Revenue</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          {summary.trend.map((d) => (
            <tr key={d.day}>
              <td className="py-1 pr-3 font-mono">{d.day}</td>
              <td className="py-1 pr-3">{d.n_dialogues}</td>
              <td className="py-1 pr-3">{d.n_product_dialogues}</td>
              <td className="py-1 pr-3 text-emerald-300 font-mono">{d.n_units_sold}</td>
              <td className="py-1 pr-3">{(d.product_conversion * 100).toFixed(1)}%</td>
              <td className="py-1 font-mono">{d.product_revenue.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

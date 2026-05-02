// Top-right scoreboard. Reads live stats from useSimStream and renders
// the headline metrics for the day-in-progress: dialogues, units sold,
// product conversion, A/B split.

import type { LiveStats, ProductBriefDict } from '../lib/types';

type Props = {
  stats: LiveStats;
  product: ProductBriefDict | null;
  onEditProduct: () => void;
};

function pct(num: number, den: number): string {
  if (!den) return '0.0%';
  return `${((num / den) * 100).toFixed(1)}%`;
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function fmtMoney(n: number, currency: string): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k ${currency}`;
  return `${n.toFixed(2)} ${currency}`;
}

export function StatsHUD({ stats, product, onEditProduct }: Props) {
  const productConversion = pct(stats.n_units_sold, stats.n_product_dialogues);
  const armRandom = pct(stats.arm_random.purchases, stats.arm_random.count);
  const armTargeted = pct(stats.arm_targeted.purchases, stats.arm_targeted.count);

  return (
    <div className="absolute top-14 right-4 w-72 z-10 pointer-events-auto">
      <div className="bg-neutral-900/85 backdrop-blur-md border border-neutral-700 rounded-lg shadow-xl">
        <div className="px-4 py-3 border-b border-neutral-800 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500">
              Product under test
            </div>
            <div className="text-sm font-semibold text-neutral-100 truncate">
              {product?.name ?? 'No product loaded'}
            </div>
            {product && (
              <div className="text-xs text-neutral-400 truncate">
                {product.category.replace('_', ' ')} · {product.price.toFixed(2)}{' '}
                {product.currency} · {product.positioning}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onEditProduct}
            className="shrink-0 text-xs px-2 py-1 rounded bg-emerald-600/30 hover:bg-emerald-600/60 border border-emerald-700 text-emerald-200"
          >
            {product ? 'Edit' : 'Set up'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-px bg-neutral-800">
          <Cell label="Product convos" value={fmt(stats.n_product_dialogues)} />
          <Cell label="Units sold" value={fmt(stats.n_units_sold)} accent />
          <Cell label="Product conv." value={productConversion} />
          <Cell
            label="Revenue"
            value={
              product
                ? fmtMoney(stats.product_revenue, product.currency)
                : fmt(stats.product_revenue)
            }
          />
        </div>

        {product && (
          <div className="px-4 py-3 border-t border-neutral-800">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
              A/B sample
            </div>
            <Bar label="random" stats={stats.arm_random} pct={armRandom} />
            <Bar
              label="targeted"
              stats={stats.arm_targeted}
              pct={armTargeted}
              accent
            />
          </div>
        )}

        <div className="px-4 py-2.5 border-t border-neutral-800 text-xs text-neutral-400 flex items-center justify-between">
          <span>All dialogues</span>
          <span>
            <span className="text-neutral-200 font-mono">
              {fmt(stats.n_purchases)}
            </span>
            <span className="text-neutral-500">
              {' '}
              / {fmt(stats.n_dialogues)}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-neutral-900 px-4 py-2.5">
      <div className="text-[10px] uppercase tracking-widest text-neutral-500">
        {label}
      </div>
      <div
        className={
          accent
            ? 'text-lg font-mono font-semibold text-emerald-400'
            : 'text-lg font-mono font-semibold text-neutral-100'
        }
      >
        {value}
      </div>
    </div>
  );
}

function Bar({
  label,
  stats,
  pct,
  accent,
}: {
  label: string;
  stats: { count: number; purchases: number };
  pct: string;
  accent?: boolean;
}) {
  const w = stats.count
    ? Math.min(100, (stats.purchases / stats.count) * 100)
    : 0;
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="flex items-center justify-between text-xs">
        <span className="text-neutral-300">{label}</span>
        <span className="font-mono text-neutral-400">
          {pct} <span className="text-neutral-600">· n={stats.count}</span>
        </span>
      </div>
      <div className="h-1.5 bg-neutral-800 rounded mt-1 overflow-hidden">
        <div
          className={
            accent ? 'h-full bg-emerald-500' : 'h-full bg-sky-500'
          }
          style={{ width: `${w}%` }}
        />
      </div>
    </div>
  );
}

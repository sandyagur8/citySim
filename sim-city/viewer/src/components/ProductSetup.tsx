// Modal form for defining (or editing) the product under test.
//
// Shown automatically on first load when no brief is loaded — that's the
// "demo flow" the user opens the page to: pick a product, hit Save, and
// watch the conversations roll in. Can be reopened any time via the
// "Edit product" pill in TimeControls.

import { useEffect, useState } from 'react';
import {
  AGE_BAND_OPTIONS,
  INCOME_BAND_OPTIONS,
  POSITIONING_OPTIONS,
  PRODUCT_CATEGORIES,
  deleteProduct,
  emptyProductBrief,
  saveProduct,
} from '../lib/api';
import type { ProductBriefDict } from '../lib/types';

type Props = {
  initial: ProductBriefDict | null;
  onClose: () => void;
  onSaved: (b: ProductBriefDict) => void;
  onSetConcurrentAgents: (n: number) => void;
};

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        className="accent-emerald-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-sm">{label}</span>
    </label>
  );
}

export function ProductSetup({
  initial,
  onClose,
  onSaved,
  onSetConcurrentAgents,
}: Props) {
  const [brief, setBrief] = useState<ProductBriefDict>(
    initial ?? emptyProductBrief(),
  );
  const [keyFeaturesText, setKeyFeaturesText] = useState<string>(
    (initial?.key_features ?? []).join(', '),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [concurrentAgents, setConcurrentAgents] = useState<number>(1);

  useEffect(() => {
    if (initial) {
      setBrief(initial);
      setKeyFeaturesText((initial.key_features ?? []).join(', '));
    }
  }, [initial]);

  const update = <K extends keyof ProductBriefDict>(
    k: K,
    v: ProductBriefDict[K],
  ) => setBrief((b) => ({ ...b, [k]: v }));

  const toggleAgeBand = (band: string) => {
    setBrief((b) => {
      const has = b.target.age_bands.includes(band);
      return {
        ...b,
        target: {
          ...b.target,
          age_bands: has
            ? b.target.age_bands.filter((x) => x !== band)
            : [...b.target.age_bands, band],
        },
      };
    });
  };

  const toggleIncomeBand = (band: string) => {
    setBrief((b) => {
      const has = b.target.income_bands.includes(band);
      return {
        ...b,
        target: {
          ...b.target,
          income_bands: has
            ? b.target.income_bands.filter((x) => x !== band)
            : [...b.target.income_bands, band],
        },
      };
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const features = keyFeaturesText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const payload: ProductBriefDict = {
        ...brief,
        price: Number(brief.price) || 0,
        key_features: features,
      };
      const saved = await saveProduct(payload);
      onSetConcurrentAgents(Math.max(1, Math.floor(concurrentAgents || 1)));
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onClear = async () => {
    if (!confirm('Clear the current product brief? The simulator will go back to generic mode.'))
      return;
    setSubmitting(true);
    try {
      await deleteProduct();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-full max-w-2xl text-neutral-100">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
          <div>
            <h2 className="text-lg font-semibold">
              {initial ? 'Edit product brief' : 'Define a product to test'}
            </h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              The whole sim runs around this brief — sellers pitch it, buyers react, you read the report.
            </p>
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

        <form onSubmit={onSubmit} className="px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-neutral-400">
                Product name
              </span>
              <input
                required
                className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                value={brief.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder="e.g. Cold Brew Tonic"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-neutral-400">
                Sold at (category)
              </span>
              <select
                className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                value={brief.category}
                onChange={(e) => update('category', e.target.value)}
              >
                {PRODUCT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-neutral-400">
                Price
              </span>
              <div className="mt-1 flex gap-2">
                <input
                  required
                  type="number"
                  step="0.01"
                  min="0"
                  className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                  value={brief.price}
                  onChange={(e) =>
                    update('price', parseFloat(e.target.value) || 0)
                  }
                />
                <input
                  className="w-20 bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm uppercase focus:outline-none focus:border-emerald-500"
                  value={brief.currency}
                  onChange={(e) => update('currency', e.target.value.slice(0, 4))}
                />
              </div>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-neutral-400">
                Positioning
              </span>
              <select
                className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                value={brief.positioning}
                onChange={(e) => update('positioning', e.target.value)}
              >
                {POSITIONING_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs uppercase tracking-wider text-neutral-400">
                Concurrent agents (dialogue workers)
              </span>
              <input
                type="number"
                min={1}
                max={32}
                step={1}
                className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                value={concurrentAgents}
                onChange={(e) => setConcurrentAgents(parseInt(e.target.value || '1', 10))}
              />
              <p className="mt-1 text-[11px] text-neutral-500">
                Runtime tuning. Higher value = more parallel conversations.
              </p>
            </label>
          </div>

          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-400">
              Short pitch
            </span>
            <input
              required
              className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
              value={brief.short_description}
              onChange={(e) => update('short_description', e.target.value)}
              placeholder="One-sentence elevator pitch"
            />
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-400">
              Detailed description
            </span>
            <textarea
              required
              rows={3}
              className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
              value={brief.detailed_description}
              onChange={(e) => update('detailed_description', e.target.value)}
              placeholder="What it is, why it matters, what it tastes/looks/feels like."
            />
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-400">
              Target audience (free text — flows into LLM prompts)
            </span>
            <textarea
              rows={2}
              className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
              value={brief.target_audience}
              onChange={(e) => update('target_audience', e.target.value)}
              placeholder="Working professionals 25–40 who already drink iced coffee"
            />
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-400">
              Key features (comma-separated)
            </span>
            <input
              className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
              value={keyFeaturesText}
              onChange={(e) => setKeyFeaturesText(e.target.value)}
              placeholder="Low sugar, locally sourced, 12oz bottle"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-neutral-800">
            <div>
              <span className="text-xs uppercase tracking-wider text-neutral-400 block mb-2">
                Target age bands
              </span>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {AGE_BAND_OPTIONS.map((b) => (
                  <Toggle
                    key={b}
                    label={b}
                    checked={brief.target.age_bands.includes(b)}
                    onChange={() => toggleAgeBand(b)}
                  />
                ))}
              </div>
            </div>
            <div>
              <span className="text-xs uppercase tracking-wider text-neutral-400 block mb-2">
                Target income bands
              </span>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {INCOME_BAND_OPTIONS.map((b) => (
                  <Toggle
                    key={b}
                    label={b.replace('_', ' ')}
                    checked={brief.target.income_bands.includes(b)}
                    onChange={() => toggleIncomeBand(b)}
                  />
                ))}
              </div>
            </div>
          </div>

          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-400">
              Occupation regex (optional)
            </span>
            <input
              className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-emerald-500"
              value={brief.target.occupation_regex ?? ''}
              onChange={(e) =>
                setBrief((b) => ({
                  ...b,
                  target: {
                    ...b.target,
                    occupation_regex: e.target.value || null,
                  },
                }))
              }
              placeholder="(software|engineer|developer)"
            />
          </label>

          {error && (
            <div className="bg-rose-950/50 border border-rose-700 text-rose-200 text-sm rounded px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <div>
              {initial && (
                <button
                  type="button"
                  onClick={onClear}
                  className="text-rose-400 hover:text-rose-300 text-sm"
                  disabled={submitting}
                >
                  Clear brief
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
                disabled={submitting}
              >
                {submitting ? 'Saving…' : initial ? 'Save changes' : 'Start the simulation'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

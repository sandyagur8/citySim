// Multi-step wizard that gates the start of every simulation run.
//
// Step 1 — pick a product (existing one from the library, or "+ New
//          product" which opens the existing ProductSetup form inline).
// Step 2 — simulation parameters: total days, agent cap, baseline ratio,
//          conversation model, dialogue worker count, target dialogues
//          per day (drives tick pacing).
// Step 3 — review + confirm. Hits POST /api/simulation/start.
//
// Shown whenever run.status is "idle" or after a "completed" run when
// the user clicks "Rerun with different parameters" in RunReportModal.
// In the "rerun" case, the product is pre-selected and the user lands
// directly on step 2 (handled by initialStep prop).

import { useEffect, useMemo, useState } from 'react';
import {
  AGE_BAND_OPTIONS,
  INCOME_BAND_OPTIONS,
  POSITIONING_OPTIONS,
  PRODUCT_CATEGORIES,
  defaultSimulationConfig,
  emptyProductBrief,
  fetchModels,
  saveProduct,
  startSimulation,
} from '../lib/api';
import type {
  OllamaModel,
  ProductBriefDict,
  SimulationConfigDict,
} from '../lib/types';

type Props = {
  products: ProductBriefDict[];
  /** Optional: pre-select a product (used by "Rerun" flow). */
  prefillProductName?: string | null;
  /** Optional: jump straight to step 2 (used by "Rerun" flow). */
  initialStep?: 1 | 2 | 3;
  /** Optional: pre-fill the parameters panel. */
  initialConfig?: Partial<SimulationConfigDict>;
  onClose: () => void;
  /** Fired after POST /api/simulation/start succeeds. */
  onStarted: () => void;
};

type Step = 1 | 2 | 3;

function StepHeader({ step }: { step: Step }) {
  const items: { n: Step; label: string }[] = [
    { n: 1, label: 'Product' },
    { n: 2, label: 'Parameters' },
    { n: 3, label: 'Review & start' },
  ];
  return (
    <ol className="flex items-center gap-3 px-6 py-3 border-b border-neutral-800 text-xs">
      {items.map((it, i) => {
        const active = it.n === step;
        const done = it.n < step;
        return (
          <li key={it.n} className="flex items-center gap-2">
            <span
              className={
                active
                  ? 'h-6 w-6 rounded-full grid place-items-center bg-emerald-600 text-white font-mono'
                  : done
                  ? 'h-6 w-6 rounded-full grid place-items-center bg-emerald-700/40 text-emerald-300 font-mono'
                  : 'h-6 w-6 rounded-full grid place-items-center bg-neutral-800 text-neutral-400 font-mono'
              }
            >
              {it.n}
            </span>
            <span
              className={active ? 'text-neutral-100' : done ? 'text-neutral-300' : 'text-neutral-500'}
            >
              {it.label}
            </span>
            {i < items.length - 1 && (
              <span className="mx-1 text-neutral-700">→</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

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

export function SimulationWizard({
  products,
  prefillProductName,
  initialStep = 1,
  initialConfig,
  onClose,
  onStarted,
}: Props) {
  const [step, setStep] = useState<Step>(initialStep);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // -------- Step 1 state: product selection / new-product form --------
  const initialName = prefillProductName ?? products[0]?.name ?? '';
  const [productMode, setProductMode] = useState<'existing' | 'new'>(
    initialName ? 'existing' : 'new',
  );
  const [selectedName, setSelectedName] = useState<string>(initialName);
  const [newBrief, setNewBrief] = useState<ProductBriefDict>(emptyProductBrief());
  const [keyFeaturesText, setKeyFeaturesText] = useState<string>('');

  const selectedProduct = useMemo(
    () => products.find((p) => p.name === selectedName) ?? null,
    [products, selectedName],
  );

  // -------- Step 2 state: simulation parameters --------
  const [config, setConfig] = useState<SimulationConfigDict>({
    ...defaultSimulationConfig(),
    ...(initialConfig ?? {}),
  });
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchModels()
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        setCurrentModel(r.current);
        if (!config.model && r.current) {
          setConfig((c) => ({ ...c, model: r.current }));
        }
      })
      .catch(() => {
        // Ollama might be down — leave the dropdown empty.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateBrief = <K extends keyof ProductBriefDict>(
    k: K,
    v: ProductBriefDict[K],
  ) => setNewBrief((b) => ({ ...b, [k]: v }));

  const toggleAgeBand = (band: string) => {
    setNewBrief((b) => {
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
    setNewBrief((b) => {
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

  const goNext = async () => {
    setError(null);
    if (step === 1) {
      if (productMode === 'existing') {
        if (!selectedName) {
          setError('Pick a product or switch to "New product".');
          return;
        }
        setConfig((c) => ({ ...c, product_name: selectedName }));
        setStep(2);
      } else {
        // Validate + save the new product, then advance with it selected.
        if (!newBrief.name.trim()) {
          setError('Give the product a name.');
          return;
        }
        setSubmitting(true);
        try {
          const features = keyFeaturesText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const payload: ProductBriefDict = {
            ...newBrief,
            price: Number(newBrief.price) || 0,
            key_features: features,
          };
          const saved = await saveProduct(payload);
          setSelectedName(saved.name);
          setConfig((c) => ({ ...c, product_name: saved.name }));
          setProductMode('existing');
          setStep(2);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSubmitting(false);
        }
      }
    } else if (step === 2) {
      setStep(3);
    } else if (step === 3) {
      setSubmitting(true);
      try {
        await startSimulation(config);
        onStarted();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    }
  };

  const goBack = () => {
    setError(null);
    if (step > 1) setStep((s) => (s - 1) as Step);
  };

  return (
    <div className="fixed inset-0 z-30 bg-black/65 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-full max-w-2xl text-neutral-100">
        <div className="px-6 py-4 border-b border-neutral-800 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Set up a simulation run</h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              Pick what you're testing, set the parameters, then start the city.
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

        <StepHeader step={step} />

        <div className="px-6 py-5 space-y-5 max-h-[68vh] overflow-y-auto">
          {step === 1 && (
            <>
              <div className="flex items-center gap-3 text-sm">
                <button
                  type="button"
                  onClick={() => setProductMode('existing')}
                  className={
                    productMode === 'existing'
                      ? 'px-3 py-1.5 rounded bg-emerald-600 text-white'
                      : 'px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
                  }
                  disabled={products.length === 0}
                >
                  Use existing product
                </button>
                <button
                  type="button"
                  onClick={() => setProductMode('new')}
                  className={
                    productMode === 'new'
                      ? 'px-3 py-1.5 rounded bg-emerald-600 text-white'
                      : 'px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
                  }
                >
                  + New product
                </button>
              </div>

              {productMode === 'existing' && products.length > 0 && (
                <div>
                  <label className="block">
                    <span className="text-xs uppercase tracking-wider text-neutral-400">
                      Product
                    </span>
                    <select
                      className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                      value={selectedName}
                      onChange={(e) => setSelectedName(e.target.value)}
                    >
                      {products.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedProduct && (
                    <div className="mt-3 p-3 rounded bg-neutral-800/40 border border-neutral-800 text-xs text-neutral-300 space-y-0.5">
                      <div>
                        <span className="text-neutral-500">Sold at:</span>{' '}
                        {selectedProduct.category.replace('_', ' ')}
                      </div>
                      <div>
                        <span className="text-neutral-500">Price:</span>{' '}
                        {selectedProduct.price.toFixed(2)} {selectedProduct.currency} ·{' '}
                        {selectedProduct.positioning}
                      </div>
                      <div className="text-neutral-200 italic mt-1">
                        "{selectedProduct.short_description}"
                      </div>
                    </div>
                  )}
                </div>
              )}

              {productMode === 'existing' && products.length === 0 && (
                <div className="text-sm text-neutral-400 bg-neutral-800/40 border border-neutral-800 rounded p-3">
                  No products saved yet. Switch to "+ New product" above.
                </div>
              )}

              {productMode === 'new' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <label className="block">
                      <span className="text-xs uppercase tracking-wider text-neutral-400">
                        Name
                      </span>
                      <input
                        className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                        value={newBrief.name}
                        onChange={(e) => updateBrief('name', e.target.value)}
                        placeholder="Cold Brew Tonic"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs uppercase tracking-wider text-neutral-400">
                        Sold at (category)
                      </span>
                      <select
                        className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                        value={newBrief.category}
                        onChange={(e) => updateBrief('category', e.target.value)}
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
                          type="number"
                          step="0.01"
                          min="0"
                          className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                          value={newBrief.price}
                          onChange={(e) =>
                            updateBrief('price', parseFloat(e.target.value) || 0)
                          }
                        />
                        <input
                          className="w-20 bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm uppercase"
                          value={newBrief.currency}
                          onChange={(e) =>
                            updateBrief('currency', e.target.value.slice(0, 4))
                          }
                        />
                      </div>
                    </label>
                    <label className="block">
                      <span className="text-xs uppercase tracking-wider text-neutral-400">
                        Positioning
                      </span>
                      <select
                        className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                        value={newBrief.positioning}
                        onChange={(e) => updateBrief('positioning', e.target.value)}
                      >
                        {POSITIONING_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="block">
                    <span className="text-xs uppercase tracking-wider text-neutral-400">
                      Short pitch
                    </span>
                    <input
                      className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                      value={newBrief.short_description}
                      onChange={(e) => updateBrief('short_description', e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs uppercase tracking-wider text-neutral-400">
                      Detailed description
                    </span>
                    <textarea
                      rows={3}
                      className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                      value={newBrief.detailed_description}
                      onChange={(e) =>
                        updateBrief('detailed_description', e.target.value)
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs uppercase tracking-wider text-neutral-400">
                      Target audience (free text)
                    </span>
                    <textarea
                      rows={2}
                      className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                      value={newBrief.target_audience}
                      onChange={(e) => updateBrief('target_audience', e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs uppercase tracking-wider text-neutral-400">
                      Key features (comma-separated)
                    </span>
                    <input
                      className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                      value={keyFeaturesText}
                      onChange={(e) => setKeyFeaturesText(e.target.value)}
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
                            checked={newBrief.target.age_bands.includes(b)}
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
                            checked={newBrief.target.income_bands.includes(b)}
                            onChange={() => toggleIncomeBand(b)}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-xs uppercase tracking-wider text-neutral-400">
                    Number of days
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                    value={config.total_days}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        total_days: Math.max(1, parseInt(e.target.value || '1', 10)),
                      }))
                    }
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Sim runs for this many sim-days then produces a final report.
                  </p>
                </label>
                <label className="block">
                  <span className="text-xs uppercase tracking-wider text-neutral-400">
                    Conversation model
                  </span>
                  <select
                    className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                    value={config.model ?? ''}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        model: e.target.value || null,
                      }))
                    }
                  >
                    {models.length === 0 && (
                      <option value="">(Ollama unreachable — using current)</option>
                    )}
                    {models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                        {m.name === currentModel ? ' (current)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs uppercase tracking-wider text-neutral-400">
                    Concurrent dialogue workers
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={32}
                    className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                    value={config.dialogue_workers}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        dialogue_workers: Math.max(
                          1,
                          parseInt(e.target.value || '1', 10),
                        ),
                      }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="text-xs uppercase tracking-wider text-neutral-400">
                    Target dialogues / sim-day
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={5000}
                    className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                    value={config.target_dialogues_per_day}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        target_dialogues_per_day: Math.max(
                          1,
                          parseInt(e.target.value || '60', 10),
                        ),
                      }))
                    }
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Tick speed throttles when dialogues lag this rate.
                  </p>
                </label>
                <label className="block">
                  <span className="text-xs uppercase tracking-wider text-neutral-400">
                    Max turns per conversation
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                    value={config.max_turns}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        max_turns: Math.max(
                          1,
                          Math.min(50, parseInt(e.target.value || '6', 10)),
                        ),
                      }))
                    }
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Hard cap on buyer↔seller back-and-forth. Lower = snappier
                    demos and cheaper LLM bills; higher = richer conversations.
                  </p>
                </label>
              </div>

              <div className="border-t border-neutral-800 pt-4">
                <h3 className="text-xs uppercase tracking-wider text-neutral-400 mb-3">
                  Constraints
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-xs text-neutral-300">
                      Number of agents (cap)
                    </span>
                    <input
                      type="number"
                      min={1}
                      placeholder="all"
                      className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
                      value={config.agent_cap ?? ''}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          agent_cap: e.target.value
                            ? Math.max(1, parseInt(e.target.value, 10))
                            : null,
                        }))
                      }
                    />
                    <p className="mt-1 text-[11px] text-neutral-500">
                      Limit how many bootstrapped personas participate. Empty = all.
                    </p>
                  </label>
                  <label className="block">
                    <span className="text-xs text-neutral-300">
                      Baseline ratio: {(config.baseline_ratio * 100).toFixed(0)}%
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      className="mt-2 w-full accent-emerald-500"
                      value={config.baseline_ratio}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          baseline_ratio: parseFloat(e.target.value),
                        }))
                      }
                    />
                    <p className="mt-1 text-[11px] text-neutral-500">
                      Fraction of dialogues fired at non-product shops as control.
                    </p>
                  </label>
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <div className="space-y-3 text-sm">
              <ReviewRow
                label="Product"
                value={config.product_name ?? selectedName ?? '—'}
              />
              <ReviewRow label="Days to run" value={String(config.total_days)} />
              <ReviewRow
                label="Conversation model"
                value={config.model ?? '(env default)'}
              />
              <ReviewRow
                label="Dialogue workers"
                value={String(config.dialogue_workers)}
              />
              <ReviewRow
                label="Target dialogues/day"
                value={String(config.target_dialogues_per_day)}
              />
              <ReviewRow
                label="Max turns / conversation"
                value={String(config.max_turns)}
              />
              <ReviewRow
                label="Agent cap"
                value={config.agent_cap ? String(config.agent_cap) : 'all bootstrapped'}
              />
              <ReviewRow
                label="Baseline ratio"
                value={`${(config.baseline_ratio * 100).toFixed(0)}%`}
              />
              <p className="pt-2 text-xs text-neutral-500">
                Hit Start to begin. The simulation will run for {config.total_days}{' '}
                sim-day{config.total_days > 1 ? 's' : ''} and then surface a
                cumulative report.
              </p>
            </div>
          )}

          {error && (
            <div className="bg-rose-950/50 border border-rose-700 text-rose-200 text-sm rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-neutral-800 flex justify-between">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 1 || submitting}
            className="px-3 py-2 text-sm rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 disabled:opacity-30"
          >
            Back
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={submitting}
            className="px-4 py-2 text-sm rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
          >
            {submitting
              ? 'Working…'
              : step === 3
              ? 'Start simulation'
              : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between bg-neutral-800/40 border border-neutral-800 rounded px-3 py-2">
      <span className="text-neutral-400">{label}</span>
      <span className="font-mono text-neutral-100">{value}</span>
    </div>
  );
}

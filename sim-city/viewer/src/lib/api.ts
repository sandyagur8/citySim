// Thin wrappers around the product / summary REST endpoints.
// The WebSocket already pushes live state — these are only used to
// initialise / mutate the product brief from the GUI.

import type {
  DaySummaryDict,
  EnsAgentLookup,
  OllamaModel,
  ProductBriefDict,
  RunSummaryDict,
  SimRunDict,
  SimulationConfigDict,
} from './types';

// Empty base = relative URLs go through Vite's dev proxy in dev and the
// same-origin FastAPI app in prod. Set window.__CITYSIM_API_BASE__ in
// index.html if you ever need to point the viewer at a remote backend.
declare global {
  interface Window {
    __CITYSIM_API_BASE__?: string;
  }
}

const base =
  (typeof window !== 'undefined' && window.__CITYSIM_API_BASE__) || '';

async function jsonOrNull<T>(res: Response): Promise<T | null> {
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export async function fetchProduct(): Promise<ProductBriefDict | null> {
  const res = await fetch(`${base}/api/product`);
  return jsonOrNull<ProductBriefDict>(res);
}

export async function fetchProducts(): Promise<ProductBriefDict[]> {
  const res = await fetch(`${base}/api/products`);
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return (await res.json()) as ProductBriefDict[];
}

export async function saveProduct(
  brief: ProductBriefDict,
): Promise<ProductBriefDict> {
  const res = await fetch(`${base}/api/product`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brief),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return (await res.json()) as ProductBriefDict;
}

export async function deleteProduct(name?: string): Promise<void> {
  const qp = name ? `?name=${encodeURIComponent(name)}` : '';
  const res = await fetch(`${base}/api/product${qp}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

export async function fetchSummary(day: number): Promise<DaySummaryDict | null> {
  const res = await fetch(`${base}/api/summary/${day}`);
  return jsonOrNull<DaySummaryDict>(res);
}

export async function fetchLatestSummary(): Promise<DaySummaryDict | null> {
  const res = await fetch(`${base}/api/summary/latest`);
  return jsonOrNull<DaySummaryDict>(res);
}

export async function fetchAgentByEns(ensName: string): Promise<EnsAgentLookup | null> {
  const name = ensName.trim();
  if (!name) return null;
  const res = await fetch(`${base}/api/agent/by-ens/${encodeURIComponent(name)}`);
  return jsonOrNull<EnsAgentLookup>(res);
}

export async function updateAgentPersonaByEns(
  ensName: string,
  payload: {
    age?: number;
    gender?: string;
    education?: string;
    income_band?: string;
    occupation?: string;
    household_role?: string;
    household_id?: string;
    mode?: string;
    employer_id?: string | null;
    home_cell?: [number, number];
    work_cell?: [number, number] | null;
    card_text?: string;
    prefs?: Record<string, unknown>;
    needs?: Record<string, unknown>;
    wallet_address?: string | null;
    axl_key?: string | null;
    ens_status?: string;
  },
): Promise<{ ok: boolean; agent_id: string; ens_name: string | null }> {
  const name = ensName.trim();
  const res = await fetch(`${base}/api/agent/by-ens/${encodeURIComponent(name)}/persona`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return (await res.json()) as { ok: boolean; agent_id: string; ens_name: string | null };
}

// Categories that match `EstablishmentKind` values that make sense for a
// shoppable product test. Keep in sync with SHOPPABLE_KINDS in runner.py.
export const PRODUCT_CATEGORIES: { value: string; label: string }[] = [
  { value: 'coffee_shop', label: 'Coffee shop' },
  { value: 'supermarket', label: 'Supermarket' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'pub', label: 'Pub' },
  { value: 'hardware', label: 'Hardware store' },
  { value: 'pharmacy', label: 'Pharmacy' },
  { value: 'clothing', label: 'Clothing store' },
  { value: 'bank', label: 'Bank' },
];

export const AGE_BAND_OPTIONS = ['18-29', '30-44', '45-59', '60+'];
export const INCOME_BAND_OPTIONS = [
  'very_low',
  'low',
  'middle',
  'upper_middle',
  'high',
];
export const POSITIONING_OPTIONS = ['premium', 'value', 'niche', 'mainstream'];

export function emptyProductBrief(): ProductBriefDict {
  return {
    name: '',
    category: 'coffee_shop',
    price: 0,
    short_description: '',
    detailed_description: '',
    target_audience: '',
    target: { age_bands: [], income_bands: [], occupation_regex: null },
    key_features: [],
    positioning: 'mainstream',
    currency: 'USD',
  };
}

// ---------------------------------------------------------------------------
// Simulation lifecycle
// ---------------------------------------------------------------------------

export async function startSimulation(
  config: Partial<SimulationConfigDict>,
): Promise<{ run: SimRunDict; active_workers: number }> {
  const res = await fetch(`${base}/api/simulation/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return (await res.json()) as { run: SimRunDict; active_workers: number };
}

export async function stopSimulation(): Promise<{ run: SimRunDict }> {
  const res = await fetch(`${base}/api/simulation/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { run: SimRunDict };
}

export async function pauseSimulation(): Promise<{ run: SimRunDict; paused: boolean }> {
  const res = await fetch(`${base}/api/simulation/pause`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { run: SimRunDict; paused: boolean };
}

export async function resumeSimulation(): Promise<{ run: SimRunDict; paused: boolean }> {
  const res = await fetch(`${base}/api/simulation/resume`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { run: SimRunDict; paused: boolean };
}

export async function resetSimulation(): Promise<{ run: SimRunDict }> {
  const res = await fetch(`${base}/api/simulation/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { run: SimRunDict };
}

export async function fetchSimulationStatus(): Promise<{
  run: SimRunDict;
  last_run_summary: RunSummaryDict | null;
}> {
  const res = await fetch(`${base}/api/simulation/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as {
    run: SimRunDict;
    last_run_summary: RunSummaryDict | null;
  };
}

export async function fetchRunSummary(): Promise<RunSummaryDict | null> {
  const res = await fetch(`${base}/api/run-summary`);
  return jsonOrNull<RunSummaryDict>(res);
}

export async function fetchModels(): Promise<{
  models: OllamaModel[];
  current: string | null;
}> {
  const res = await fetch(`${base}/api/models`);
  if (!res.ok) {
    return { models: [], current: null };
  }
  return (await res.json()) as { models: OllamaModel[]; current: string | null };
}

export function defaultSimulationConfig(): SimulationConfigDict {
  return {
    product_name: null,
    total_days: 1,
    agent_cap: null,
    baseline_ratio: 0.25,
    model: null,
    dialogue_workers: 1,
    target_dialogues_per_day: 60,
    max_turns: 6,
  };
}

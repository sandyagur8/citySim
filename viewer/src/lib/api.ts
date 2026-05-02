// Thin wrappers around the product / summary REST endpoints.
// The WebSocket already pushes live state — these are only used to
// initialise / mutate the product brief from the GUI.

import type { DaySummaryDict, ProductBriefDict } from './types';

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

export async function deleteProduct(): Promise<void> {
  const res = await fetch(`${base}/api/product`, { method: 'DELETE' });
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

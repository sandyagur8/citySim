// Palette and color helpers for the isometric city.
//
// Buildings are extruded with kind-specific colors; ground tiles use a per-cell
// jitter so the city floor doesn't read as flat.

import { ZONING } from './types';

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

// ---------------------------------------------------------------------------
// Ground (zoning) base colors
// ---------------------------------------------------------------------------

export const ZONING_BASE: Record<number, RGB> = {
  [ZONING.PARKS]: [78, 132, 64],
  [ZONING.RESIDENTIAL]: [188, 174, 142],
  [ZONING.MIXED]: [168, 162, 174],
  [ZONING.COMMERCIAL]: [138, 144, 162],
  [ZONING.INDUSTRIAL]: [108, 102, 96],
  [ZONING.CIVIC]: [202, 174, 104],
};

// Activity colors for agent dots
export const ACTIVITY_COLORS: Record<number, RGB> = {
  0: [80, 110, 200], // SLEEP — dim blue
  1: [255, 150, 60], // COMMUTE — orange
  2: [200, 200, 200], // WORK — gray
  3: [255, 220, 90], // EAT — yellow
  4: [120, 220, 120], // SHOP — green
  5: [220, 100, 220], // LEISURE — magenta
  6: [120, 200, 240], // SCHOOL — light blue
};

// ---------------------------------------------------------------------------
// Building colors by establishment kind
// ---------------------------------------------------------------------------

export const KIND_COLOR: Record<string, RGB> = {
  supermarket: [220, 200, 100],
  coffee_shop: [180, 130, 80],
  restaurant: [200, 110, 90],
  pub: [120, 80, 60],
  hardware: [125, 125, 125],
  pharmacy: [225, 240, 250],
  clothing: [240, 200, 220],
  bank: [205, 205, 225],
  office: [150, 165, 195],
  hospital: [240, 245, 252],
  school: [195, 150, 110],
  police: [85, 110, 150],
  park: [78, 132, 64],
  home: [200, 170, 140],
};

// ---------------------------------------------------------------------------
// Building heights by kind (in cell units; deck.gl extrudes along Z)
// ---------------------------------------------------------------------------

export const KIND_HEIGHT: Record<string, number> = {
  office: 28, // base height; we scale up toward city center
  bank: 18,
  hospital: 14,
  school: 6,
  supermarket: 5,
  coffee_shop: 4,
  restaurant: 4,
  pub: 4,
  hardware: 4,
  pharmacy: 4,
  clothing: 5,
  police: 7,
  home: 8,
  park: 0,
};

// ---------------------------------------------------------------------------
// Filler building palettes (for cells without an establishment)
// ---------------------------------------------------------------------------

// Strong residential vs business color separation.
//   • RESIDENTIAL — warm reds, terracotta, ochre, brick — "houses"
//   • COMMERCIAL  — cool blues, teals, slate — "office / shops"
//   • MIXED       — bridges the two with mauve/dusty-rose — "mid-rise"
//   • INDUSTRIAL  — earthy grays and rust — "factories / warehouses"
//   • CIVIC       — pale gold — "plazas, monuments"
export const FILLER_COLORS: Record<number, RGB[]> = {
  [ZONING.RESIDENTIAL]: [
    [210, 120, 95],   // terracotta
    [195, 95, 80],    // brick red
    [225, 165, 110],  // warm ochre
    [180, 90, 70],    // dark brick
    [240, 195, 140],  // sand
    [205, 140, 95],   // peach
  ],
  [ZONING.COMMERCIAL]: [
    [80, 130, 200],   // glass blue
    [60, 105, 175],   // navy blue
    [110, 165, 215],  // sky blue
    [70, 120, 150],   // slate
    [40, 90, 140],    // deep blue
    [130, 175, 210],  // pale blue
  ],
  [ZONING.MIXED]: [
    [170, 120, 145],  // mauve
    [195, 145, 165],  // dusty rose
    [145, 105, 130],  // plum
    [180, 130, 130],  // muted brick
  ],
  [ZONING.INDUSTRIAL]: [
    [130, 110, 95],   // rust
    [95, 90, 90],     // gunmetal
    [150, 120, 100],  // tan
    [110, 105, 100],  // ash
  ],
  [ZONING.CIVIC]: [[225, 200, 130]],
  [ZONING.PARKS]: [[120, 175, 90]],
};

// Civic / institutional kinds that override their zone color so they read
// as their own identity (hospital, school, police, bank).
export const KIND_OVERRIDE_COLOR: Record<string, RGB> = {
  hospital: [240, 245, 252], // off-white
  school: [180, 70, 65],     // brick red — distinct from residential warmth
  police: [40, 60, 110],     // navy
  bank: [220, 200, 145],     // cream / gold
  park: [80, 140, 70],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Deterministic small hash for cell-position-driven jitter
export function hash2(x: number, y: number, salt = 0): number {
  let h = (x | 0) * 73856093 ^ (y | 0) * 19349663 ^ salt * 83492791;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h & 0xffffff) / 0xffffff; // 0..1
}

export function jitterColor(rgb: RGB, x: number, y: number, amount = 12): RGB {
  const r = (hash2(x, y, 1) - 0.5) * 2 * amount;
  const g = (hash2(x, y, 2) - 0.5) * 2 * amount;
  const b = (hash2(x, y, 3) - 0.5) * 2 * amount;
  return [
    Math.max(0, Math.min(255, rgb[0] + r)),
    Math.max(0, Math.min(255, rgb[1] + g)),
    Math.max(0, Math.min(255, rgb[2] + b)),
  ];
}

// Mix two colors a and b by t ∈ [0,1]
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t,
    a[2] * (1 - t) + b[2] * t,
  ];
}

// ---------------------------------------------------------------------------
// People & vehicle palettes — varied per agent so the city has individuality
// ---------------------------------------------------------------------------

// Two parallel palettes per entity. We pick a slot by hash and then mix
// between the dark (day) and neon (night) entry at that slot based on
// current sun altitude, so each agent / car keeps its own "hue identity"
// across the day-night cycle while flipping from muted to glowing.

export const DARK_PERSON_PALETTE: RGB[] = [
  [25, 30, 55],   // dark navy
  [55, 25, 35],   // wine
  [25, 50, 35],   // forest
  [40, 40, 55],   // slate
  [50, 35, 30],   // dark brown
  [25, 40, 50],   // steel
  [40, 25, 40],   // plum
  [30, 30, 30],   // charcoal
  [50, 50, 30],   // dark olive
  [30, 30, 50],   // midnight
  [50, 30, 50],   // mulberry
  [35, 45, 35],   // moss
];

export const NEON_PERSON_PALETTE: RGB[] = [
  [255, 50, 200],   // hot pink
  [50, 255, 220],   // cyan
  [200, 255, 50],   // lime
  [80, 100, 255],   // electric blue
  [255, 120, 50],   // neon orange
  [255, 240, 60],   // neon yellow
  [200, 50, 255],   // electric purple
  [50, 255, 130],   // mint
  [255, 60, 100],   // hot red
  [100, 255, 255],  // ice
  [255, 220, 100],  // gold neon
  [180, 60, 255],   // violet
];

export const DARK_CAR_PALETTE: RGB[] = [
  [40, 40, 45],    // black
  [25, 35, 60],    // dark navy
  [35, 30, 30],    // dark brown
  [30, 30, 35],    // graphite
  [50, 30, 30],    // wine
  [25, 40, 35],    // dark teal
  [35, 35, 35],    // ash
  [30, 35, 50],    // gunmetal
  [50, 35, 25],    // dark amber
  [40, 50, 40],    // moss
];

export const NEON_CAR_PALETTE: RGB[] = [
  [255, 80, 50],   // ember
  [50, 255, 180],  // mint glow
  [255, 240, 50],  // taxi yellow
  [80, 120, 255],  // ion blue
  [255, 50, 200],  // pink magenta
  [60, 255, 80],   // laser green
  [255, 150, 50],  // amber
  [200, 50, 255],  // ultraviolet
  [255, 80, 130],  // hot coral
  [80, 230, 255],  // arctic
];

// Pick a deterministic palette entry from an agent's array index
export function pickByIndex<T>(palette: T[], index: number, salt = 0): T {
  // Mix the index a bit so neighbouring agents don't share colors
  const h = ((index + salt) * 2654435761) >>> 0;
  return palette[h % palette.length];
}

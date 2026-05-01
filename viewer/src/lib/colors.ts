// Color palettes for zoning (base layer) and activity (agent layer).
// Colors expressed as RGBA arrays for deck.gl.

import { ACTIVITY, ZONING } from './types';

export type RGBA = [number, number, number, number];

// Zoning palette — muted, daytime tone. Day-night overlay does the lighting shift.
export const ZONING_COLORS: Record<number, RGBA> = {
  [ZONING.PARKS]: [120, 170, 100, 255],
  [ZONING.RESIDENTIAL]: [220, 200, 175, 255],
  [ZONING.MIXED]: [200, 180, 200, 255],
  [ZONING.COMMERCIAL]: [180, 200, 230, 255],
  [ZONING.INDUSTRIAL]: [150, 145, 140, 255],
  [ZONING.CIVIC]: [240, 220, 180, 255],
};

// Activity palette for agent dots
export const ACTIVITY_COLORS: Record<number, RGBA> = {
  [ACTIVITY.SLEEP]: [70, 90, 130, 180],
  [ACTIVITY.COMMUTE]: [255, 140, 60, 255],
  [ACTIVITY.WORK]: [120, 120, 125, 230],
  [ACTIVITY.EAT]: [255, 210, 110, 255],
  [ACTIVITY.SHOP]: [80, 200, 130, 255],
  [ACTIVITY.LEISURE]: [220, 130, 220, 255],
  [ACTIVITY.SCHOOL]: [130, 180, 255, 255],
};

// Establishment kind → small icon character + tint
export const ESTABLISHMENT_GLYPH: Record<string, { glyph: string; color: RGBA }> = {
  supermarket: { glyph: 'M', color: [40, 100, 60, 230] },
  coffee_shop: { glyph: 'c', color: [120, 75, 50, 230] },
  restaurant: { glyph: 'R', color: [200, 80, 60, 230] },
  pub: { glyph: 'P', color: [120, 50, 90, 230] },
  hardware: { glyph: 'H', color: [110, 90, 60, 230] },
  pharmacy: { glyph: '+', color: [80, 160, 90, 230] },
  clothing: { glyph: 'T', color: [100, 130, 200, 230] },
  bank: { glyph: '$', color: [60, 100, 80, 230] },
  office: { glyph: 'O', color: [70, 80, 100, 230] },
  hospital: { glyph: '+', color: [200, 60, 60, 230] },
  school: { glyph: 'S', color: [130, 100, 180, 230] },
  police: { glyph: '!', color: [40, 60, 130, 230] },
  park: { glyph: '.', color: [60, 110, 60, 200] },
};

// The deck.gl city canvas. Three layers, drawn from bottom up:
//   1. Zoning grid (base) — one polygon per cell, coloured by zoning class
//   2. Establishments — small fixed dots
//   3. Agents — animated dots coloured by current activity
//
// We use OrthographicView because this is a synthetic city, not a real map.
// The view is centred on the grid at startup; the user can pan and zoom.

import DeckGL from '@deck.gl/react';
import { OrthographicView, type PickingInfo } from '@deck.gl/core';
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { useMemo } from 'react';
import {
  ACTIVITY_COLORS,
  ESTABLISHMENT_GLYPH,
  ZONING_COLORS,
  type RGBA,
} from '../lib/colors';
import type {
  AgentDict,
  EstablishmentDict,
  GridDict,
  SmoothedPositions as SmoothedPositionsType,
} from '../lib/types';

type Props = {
  grid: GridDict;
  establishments: EstablishmentDict[];
  agents: AgentDict[];
  smoothed: SmoothedPositionsType | null;
  sunAltitude: number;
  onPickAgent?: (a: AgentDict | null) => void;
  onPickEstablishment?: (e: EstablishmentDict | null) => void;
};

type ZoningCell = {
  polygon: [number, number][];
  color: RGBA;
};

export function CityView({
  grid,
  establishments,
  agents,
  smoothed,
  sunAltitude,
  onPickAgent,
  onPickEstablishment,
}: Props) {
  // Build the zoning polygons once (memoised by grid identity)
  const zoningCells = useMemo<ZoningCell[]>(() => {
    const cells: ZoningCell[] = [];
    for (let y = 0; y < grid.size; y++) {
      for (let x = 0; x < grid.size; x++) {
        const z = grid.zoning[y][x];
        const color = ZONING_COLORS[z] ?? ([200, 200, 200, 255] as RGBA);
        cells.push({
          polygon: [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
          ],
          color,
        });
      }
    }
    return cells;
  }, [grid]);

  // Tint the zoning by sun altitude — cooler/darker at night, warmer at sunrise/sunset,
  // bright at midday. We apply a simple multiplicative tint here in the data so deck.gl
  // doesn't have to do per-fragment math.
  const tintedZoning = useMemo<ZoningCell[]>(() => {
    const tint = lightingTint(sunAltitude);
    return zoningCells.map((c) => ({
      polygon: c.polygon,
      color: applyTint(c.color, tint),
    }));
  }, [zoningCells, sunAltitude]);

  // Establishment data
  const establishmentData = useMemo(() => {
    return establishments.map((e) => {
      const glyph = ESTABLISHMENT_GLYPH[e.kind] ?? { glyph: '?', color: [120, 120, 120, 200] as RGBA };
      // Slight jitter so dots don't perfectly overlap when many share a cell
      const jx = ((hashStr(e.id) % 7) - 3) * 0.06;
      const jy = ((hashStr(e.id + 'y') % 7) - 3) * 0.06;
      return {
        position: [e.cell[0] + 0.5 + jx, e.cell[1] + 0.5 + jy] as [number, number],
        color: glyph.color,
        kind: e.kind,
        ref: e,
      };
    });
  }, [establishments]);

  // Agent data — derived from smoothed positions
  const agentData = useMemo(() => {
    if (!smoothed) return null;
    const n = smoothed.positions.length / 2;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = {
        position: [
          smoothed.positions[i * 2] + 0.5,
          smoothed.positions[i * 2 + 1] + 0.5,
        ] as [number, number],
        activity: smoothed.activities[i],
        ref: agents[i],
      };
    }
    return out;
  }, [smoothed, agents]);

  const layers = [
    new PolygonLayer<ZoningCell>({
      id: 'zoning',
      data: tintedZoning,
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => d.color,
      stroked: false,
      pickable: false,
      updateTriggers: { getFillColor: sunAltitude },
    }),
    new ScatterplotLayer({
      id: 'establishments',
      data: establishmentData,
      getPosition: (d: { position: [number, number] }) => d.position,
      getFillColor: (d: { color: RGBA }) => d.color,
      getRadius: 0.18,
      pickable: true,
      onClick: (info: PickingInfo) => {
        const obj = info.object as { ref: EstablishmentDict } | null;
        onPickEstablishment?.(obj?.ref ?? null);
      },
    }),
    agentData
      ? new ScatterplotLayer({
          id: 'agents',
          data: agentData,
          getPosition: (d: { position: [number, number] }) => d.position,
          getFillColor: (d: { activity: number }) =>
            ACTIVITY_COLORS[d.activity] ?? [200, 200, 200, 255],
          getRadius: 0.13,
          radiusMinPixels: 1.5,
          radiusMaxPixels: 6,
          pickable: true,
          onClick: (info: PickingInfo) => {
            const obj = info.object as { ref: AgentDict } | null;
            onPickAgent?.(obj?.ref ?? null);
          },
          updateTriggers: { getFillColor: smoothed?.simMinute },
        })
      : null,
  ].filter(Boolean);

  // Default initial view: centred on the grid, zoomed to fit
  const initialViewState = {
    target: [grid.size / 2, grid.size / 2, 0],
    zoom: Math.log2(800 / grid.size),  // empirically tuned for fit
    minZoom: 0,
    maxZoom: 8,
  };

  return (
    <DeckGL
      views={new OrthographicView({ id: 'ortho', flipY: true })}
      initialViewState={initialViewState}
      controller={{ scrollZoom: { speed: 0.01, smooth: true } }}
      layers={layers}
      style={{ position: 'absolute', inset: 0 }}
    />
  );
}

// Lightweight string hash for jitter
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Lighting tint as a multiplicative RGB factor [0..1]^3 + brightness scalar.
// sunAlt 0 = night (cool blue, dim), 1 = noon (full bright). Sunrise/sunset
// is in between with warm bias.
function lightingTint(sunAlt: number): { r: number; g: number; b: number; brightness: number } {
  if (sunAlt <= 0) {
    // night
    return { r: 0.55, g: 0.60, b: 0.85, brightness: 0.42 };
  }
  if (sunAlt < 0.18) {
    // sunrise/sunset
    const t = sunAlt / 0.18;
    return {
      r: 0.80 + 0.20 * t,
      g: 0.55 + 0.45 * t,
      b: 0.45 + 0.55 * t,
      brightness: 0.55 + 0.45 * t,
    };
  }
  // day
  return { r: 1, g: 1, b: 1, brightness: 1 };
}

function applyTint(color: RGBA, tint: { r: number; g: number; b: number; brightness: number }): RGBA {
  return [
    Math.max(0, Math.min(255, color[0] * tint.r * tint.brightness)),
    Math.max(0, Math.min(255, color[1] * tint.g * tint.brightness)),
    Math.max(0, Math.min(255, color[2] * tint.b * tint.brightness)),
    color[3],
  ];
}

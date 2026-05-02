// Pre-computed geometry for the isometric city: ground tiles, buildings,
// roads, and tree positions. Built once when `world` arrives and reused
// across renders.
//
// Coordinate system (deck.gl OrbitView with orbitAxis='Z'):
//   x: east  (cell column)
//   y: north (cell row)
//   z: up    (elevation)
//
// All footprints are 2D polygons in (x, y); deck.gl handles the extrusion
// in z based on the layer's elevation accessor.

import type { GridDict, EstablishmentDict, AgentDict } from './types';
import { ZONING } from './types';
import {
  FILLER_COLORS,
  KIND_OVERRIDE_COLOR,
  hash2,
  jitterColor,
  type RGB,
} from './colors';

export type GroundCell = {
  x: number;
  y: number;
  zoning: number;
  color: RGB;
};

export type Building = {
  x: number;
  y: number;
  footprint: [number, number][];
  height: number;
  color: RGB;
  // For establishments, est is set so the building is pickable
  est: EstablishmentDict | null;
};

export type RoadStrip = {
  poly: [number, number][];
};

export type Tree = {
  x: number;
  y: number;
  height: number;
  trunkColor: RGB;
  canopyColor: RGB;
};

export type CityGeometry = {
  ground: GroundCell[];
  buildings: Building[];
  roads: RoadStrip[];
  trees: Tree[];
  bounds: { width: number; height: number };
};

// ---------------------------------------------------------------------------
// Ground tiles
// ---------------------------------------------------------------------------

export function buildGround(grid: GridDict): GroundCell[] {
  const cells: GroundCell[] = [];
  const size = grid.size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const zoning = grid.zoning[y][x];
      const base = baseGroundColor(zoning);
      const color = jitterColor(base, x, y, 8);
      cells.push({ x, y, zoning, color });
    }
  }
  return cells;
}

function baseGroundColor(zoning: number): RGB {
  switch (zoning) {
    case ZONING.PARKS:
      return [78, 132, 64];
    case ZONING.RESIDENTIAL:
      return [188, 174, 142];
    case ZONING.MIXED:
      return [168, 162, 174];
    case ZONING.COMMERCIAL:
      return [138, 144, 162];
    case ZONING.INDUSTRIAL:
      return [108, 102, 96];
    case ZONING.CIVIC:
      return [202, 174, 104];
    default:
      return [180, 180, 180];
  }
}

// ---------------------------------------------------------------------------
// Buildings: real establishments + procedural filler in zoned cells
// ---------------------------------------------------------------------------

export function buildBuildings(
  grid: GridDict,
  establishments: EstablishmentDict[],
  agents: AgentDict[],
): Building[] {
  const size = grid.size;
  const center = size / 2;
  const maxRadius = Math.SQRT2 * (size / 2);

  // Index of cells with an establishment to skip during filler pass
  const occupied = new Map<string, EstablishmentDict>();
  for (const e of establishments) {
    occupied.set(`${e.cell[0]},${e.cell[1]}`, e);
  }

  // Tally agents per home cell so residential buildings vary by density
  const homeDensity = new Map<string, number>();
  for (const a of agents) {
    const key = `${a.home_cell[0]},${a.home_cell[1]}`;
    homeDensity.set(key, (homeDensity.get(key) ?? 0) + 1);
  }

  const buildings: Building[] = [];

  // Pass 1: real establishments — color by zoning so residential vs business
  // reads at a glance, with a few civic-identity overrides.
  for (const e of establishments) {
    const [x, y] = e.cell;
    const inset = footprintFor(e.kind, x, y);
    const zoning = grid.zoning[y][x];
    const override = KIND_OVERRIDE_COLOR[e.kind];
    const palette = FILLER_COLORS[zoning] ?? [[160, 160, 160] as RGB];
    const colorIdx = Math.floor(hash2(x, y, 5) * palette.length);
    const baseColor = override ?? palette[colorIdx % palette.length];
    const color = jitterColor(baseColor, x, y, 10);
    const height = heightFor(e.kind, x, y, center, maxRadius);
    if (height <= 0) continue;
    buildings.push({
      x,
      y,
      footprint: inset,
      height,
      color,
      est: e,
    });
  }

  // Pass 2: procedural fillers for cells without an establishment
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (occupied.has(`${x},${y}`)) continue;
      const zoning = grid.zoning[y][x];
      if (zoning === ZONING.PARKS || zoning === ZONING.CIVIC) continue;

      // Skip ~20% of cells for breathing space (alleys, small lots)
      if (hash2(x, y, 11) < 0.2) continue;

      const palette = FILLER_COLORS[zoning] ?? [[150, 150, 150]];
      const colorIdx = Math.floor(hash2(x, y, 5) * palette.length);
      const baseColor = palette[colorIdx % palette.length];
      const color = jitterColor(baseColor, x, y, 10);

      const height = fillerHeight(zoning, x, y, center, maxRadius, homeDensity);
      if (height <= 0) continue;

      const inset = fillerFootprint(x, y);
      buildings.push({
        x,
        y,
        footprint: inset,
        height,
        color,
        est: null,
      });
    }
  }

  return buildings;
}

// Real-establishment footprint: shrink slightly toward cell center, with a
// kind-specific size so bigger institutions read bigger.
function footprintFor(kind: string, x: number, y: number): [number, number][] {
  const size = sizeForKind(kind);
  const margin = (1 - size) / 2;
  const off = hash2(x, y, 7) * 0.05; // tiny offset for variety
  return [
    [x + margin + off, y + margin + off],
    [x + 1 - margin + off, y + margin + off],
    [x + 1 - margin + off, y + 1 - margin + off],
    [x + margin + off, y + 1 - margin + off],
  ];
}

function sizeForKind(kind: string): number {
  switch (kind) {
    case 'office':
    case 'bank':
    case 'hospital':
    case 'school':
      return 0.78;
    case 'supermarket':
    case 'hardware':
      return 0.7;
    case 'restaurant':
    case 'pub':
    case 'coffee_shop':
    case 'pharmacy':
    case 'clothing':
      return 0.55;
    case 'police':
      return 0.6;
    case 'home':
      return 0.5;
    default:
      return 0.6;
  }
}

// One story everywhere. Tiny variance so neighboring buildings don't read as
// a perfectly flat checkerboard, but the city stays low-rise overall.
const STORY_HEIGHT = 1.5;

function heightFor(
  kind: string,
  x: number,
  y: number,
  _center: number,
  _maxRadius: number,
): number {
  if (kind === 'park') return 0;
  return STORY_HEIGHT * (0.9 + 0.2 * hash2(x, y, 17));
}

// Filler footprint: similar inset to leave road space around the cell
function fillerFootprint(x: number, y: number): [number, number][] {
  const margin = 0.18 + hash2(x, y, 23) * 0.08; // 0.18..0.26
  return [
    [x + margin, y + margin],
    [x + 1 - margin, y + margin],
    [x + 1 - margin, y + 1 - margin],
    [x + margin, y + 1 - margin],
  ];
}

function fillerHeight(
  zoning: number,
  x: number,
  y: number,
  _center: number,
  _maxRadius: number,
  _homeDensity: Map<string, number>,
): number {
  if (zoning === ZONING.PARKS || zoning === ZONING.CIVIC) return 0;
  // One story for every filler building, with the same small jitter as
  // establishments so neighboring rooftops aren't perfectly identical.
  return STORY_HEIGHT * (0.9 + 0.2 * hash2(x, y, 31));
}

// ---------------------------------------------------------------------------
// Road grid: thin strips along cell boundaries every N cells (major roads).
// Minor roads are implied by the inset between building footprints and
// cell edges, which already reads as street space against ground tiles.
// ---------------------------------------------------------------------------

export function buildRoads(grid: GridDict): RoadStrip[] {
  const size = grid.size;
  const w = 0.18; // road width, in cell units (centered on cell boundary)
  const stride = 5;
  const strips: RoadStrip[] = [];

  // Vertical major roads (running along y-axis), at x = stride, 2*stride, ...
  for (let x = stride; x < size; x += stride) {
    strips.push({
      poly: [
        [x - w / 2, 0],
        [x + w / 2, 0],
        [x + w / 2, size],
        [x - w / 2, size],
      ],
    });
  }
  // Horizontal major roads, at y = stride, 2*stride, ...
  for (let y = stride; y < size; y += stride) {
    strips.push({
      poly: [
        [0, y - w / 2],
        [size, y - w / 2],
        [size, y + w / 2],
        [0, y + w / 2],
      ],
    });
  }
  return strips;
}

// ---------------------------------------------------------------------------
// Trees in PARKS cells, scattered with a per-cell hash
// ---------------------------------------------------------------------------

export function buildTrees(grid: GridDict): Tree[] {
  const trees: Tree[] = [];
  const size = grid.size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid.zoning[y][x] !== ZONING.PARKS) {
        // Sparse street trees on residential blocks too
        if (
          grid.zoning[y][x] === ZONING.RESIDENTIAL &&
          hash2(x, y, 41) > 0.85
        ) {
          trees.push(makeTree(x + 0.5, y + 0.5, x, y, 1));
        }
        continue;
      }
      // Parks: 4–6 trees per cell
      const n = 4 + Math.floor(hash2(x, y, 51) * 3);
      for (let i = 0; i < n; i++) {
        const tx = x + 0.15 + hash2(x, y, 100 + i) * 0.7;
        const ty = y + 0.15 + hash2(x, y, 200 + i) * 0.7;
        trees.push(makeTree(tx, ty, x, y, i));
      }
    }
  }
  return trees;
}

function makeTree(tx: number, ty: number, cx: number, cy: number, i: number): Tree {
  const variant = hash2(cx, cy, 300 + i);
  const height = 0.8 + variant * 1.4;
  const greenShade = 90 + Math.floor(hash2(cx, cy, 400 + i) * 80);
  return {
    x: tx,
    y: ty,
    height,
    trunkColor: [80, 55, 40],
    canopyColor: [40, greenShade, 50],
  };
}

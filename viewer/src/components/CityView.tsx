// Isometric city view. Switched from a flat top-down OrthographicView to
// deck.gl OrbitView so we can render extruded buildings, trees, stick-figure
// people, and cars driving on the streets — a stylised SimCity-3000 take.
//
// Rendering layers, back to front:
//   1. ground tiles (PolygonLayer, flat) — colored by zoning with per-cell jitter
//   2. road strips (PolygonLayer, flat) — dark major-grid avenues
//   3. tree trunks + canopies (ColumnLayer pair) — short brown columns + green caps
//   4. building extrusions (PolygonLayer, extruded) — establishments + procedural fill
//   5. cars (ColumnLayer, square cross-section) — visible only when an agent
//      with mode=car is currently commuting
//   6. stick-figure body (ColumnLayer, square cross-section) — clothing color
//   7. stick-figure head (ScatterplotLayer at body-top elevation) — skin tone
//   8. low-zoom dot (ScatterplotLayer with radiusMinPixels) — keeps people
//      visible when zoomed all the way out

import { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import {
  OrbitView,
  LightingEffect,
  AmbientLight,
  DirectionalLight,
} from '@deck.gl/core';
import { PolygonLayer, ScatterplotLayer, ColumnLayer } from '@deck.gl/layers';

import type { AgentDict, EstablishmentDict, GridDict } from '../lib/types';
import { ACTIVITY } from '../lib/types';
import type { SmoothedPositions } from '../hooks/useSimStream';
import {
  ACTIVITY_COLORS,
  DARK_PERSON_PALETTE,
  NEON_PERSON_PALETTE,
  DARK_CAR_PALETTE,
  NEON_CAR_PALETTE,
  mix,
  pickByIndex,
  type RGB,
} from '../lib/colors';
import {
  buildBuildings,
  buildGround,
  buildRoads,
  buildTrees,
  type Building,
} from '../lib/cityGeometry';

type Props = {
  grid: GridDict;
  establishments: EstablishmentDict[];
  agents: AgentDict[];
  smoothed: SmoothedPositions | null;
  sunAltitude: number;
  onPickAgent: (a: AgentDict | null) => void;
  onPickEstablishment: (e: EstablishmentDict | null) => void;
};

// Center stationary agents on their cell so they read as "inside the building".
// Commuting agents stay on cell-corner gridlines so they walk on the road grid.
function isCommuting(act: number): boolean {
  return act === ACTIVITY.COMMUTE;
}

export function CityView({
  grid,
  establishments,
  agents,
  smoothed,
  sunAltitude,
  onPickAgent,
  onPickEstablishment,
}: Props) {
  // -------------------------------------------------------------------------
  // Static geometry — built once per world
  // -------------------------------------------------------------------------
  const ground = useMemo(() => buildGround(grid), [grid]);
  const buildings = useMemo(
    () => buildBuildings(grid, establishments, agents),
    [grid, establishments, agents],
  );
  const roads = useMemo(() => buildRoads(grid), [grid]);
  const trees = useMemo(() => buildTrees(grid), [grid]);

  // Cache per-agent palette slot picks so we don't recompute every frame.
  // Each agent has a "dark" identity and a "neon" identity in matching slots;
  // we blend between them based on sun altitude so each agent keeps their
  // hue identity across the day/night cycle.
  const agentVisuals = useMemo(() => {
    const personDark: RGB[] = [];
    const personNeon: RGB[] = [];
    const carDark: RGB[] = [];
    const carNeon: RGB[] = [];
    for (let i = 0; i < agents.length; i++) {
      // Use the same hash salt for the dark/neon pair so the slot index lines up.
      personDark.push(pickByIndex(DARK_PERSON_PALETTE, i, 1));
      personNeon.push(pickByIndex(NEON_PERSON_PALETTE, i, 1));
      carDark.push(pickByIndex(DARK_CAR_PALETTE, i, 3));
      carNeon.push(pickByIndex(NEON_CAR_PALETTE, i, 3));
    }
    return { personDark, personNeon, carDark, carNeon };
  }, [agents]);

  // Blend factor: sunAltitude 1 = full daylight (use dark colors so they
  // stand out against the bright city), sunAltitude 0 = full night (neon).
  // Clamp so deep-night/high-noon both saturate.
  const dayMix = Math.max(0, Math.min(1, sunAltitude));

  const personColorAt = (i: number): [number, number, number, number] => {
    const c = mix(agentVisuals.personNeon[i], agentVisuals.personDark[i], dayMix);
    return [c[0], c[1], c[2], 255];
  };
  const carColorAt = (i: number): [number, number, number, number] => {
    const c = mix(agentVisuals.carNeon[i], agentVisuals.carDark[i], dayMix);
    return [c[0], c[1], c[2], 255];
  };

  // -------------------------------------------------------------------------
  // Camera — auto-fit zoom so the whole city is visible at any grid size
  // -------------------------------------------------------------------------
  const initialViewState = useMemo(() => {
    const zoom = Math.max(1.5, Math.min(4.5, 9 - Math.log2(grid.size)));
    return {
      target: [grid.size / 2, grid.size / 2, 0] as [number, number, number],
      rotationX: 55,
      rotationOrbit: 30,
      zoom,
      minZoom: 0.5,
      maxZoom: 8,
    };
  }, [grid.size]);

  // -------------------------------------------------------------------------
  // Sun-driven lighting
  // -------------------------------------------------------------------------
  const lightingEffect = useMemo(() => {
    const sunAlt = Math.max(0, sunAltitude);
    const ambient = new AmbientLight({
      color: [255, 250, 240],
      intensity: 0.35 + 0.55 * sunAlt,
    });
    const angle = sunAlt * (Math.PI / 2);
    const dir: [number, number, number] = [
      Math.cos(angle) * 0.6,
      Math.cos(angle) * 0.4,
      -Math.sin(angle) - 0.2,
    ];
    const warmth = 1 - sunAlt;
    const sunColor: [number, number, number] = [
      255,
      Math.round(255 - 60 * warmth),
      Math.round(255 - 120 * warmth),
    ];
    const sun = new DirectionalLight({
      color: sunColor,
      intensity: 0.6 + 0.9 * sunAlt,
      direction: dir,
    });
    return new LightingEffect({ ambient, sun });
  }, [sunAltitude]);

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------
  const layers: unknown[] = [
    new PolygonLayer({
      id: 'ground',
      data: ground,
      pickable: false,
      stroked: false,
      filled: true,
      extruded: false,
      getPolygon: (c) => [
        [c.x, c.y],
        [c.x + 1, c.y],
        [c.x + 1, c.y + 1],
        [c.x, c.y + 1],
      ],
      getFillColor: (c) => [c.color[0], c.color[1], c.color[2], 255],
    }),

    new PolygonLayer({
      id: 'roads',
      data: roads,
      pickable: false,
      stroked: false,
      filled: true,
      extruded: false,
      getPolygon: (r) => r.poly,
      getFillColor: [38, 38, 42, 255],
      getElevation: 0.02,
    }),

    new ColumnLayer({
      id: 'tree-trunks',
      data: trees,
      diskResolution: 6,
      radius: 0.06,
      extruded: true,
      pickable: false,
      getPosition: (t) => [t.x, t.y, 0],
      getElevation: (t) => t.height * 0.5,
      getFillColor: (t) => [t.trunkColor[0], t.trunkColor[1], t.trunkColor[2], 255],
      material: { ambient: 0.5, diffuse: 0.6, shininess: 8, specularColor: [40, 30, 20] },
    }),
    new ColumnLayer({
      id: 'tree-canopies',
      data: trees,
      diskResolution: 8,
      radius: 0.22,
      extruded: true,
      pickable: false,
      getPosition: (t) => [t.x, t.y, t.height * 0.5],
      getElevation: (t) => t.height * 0.55,
      getFillColor: (t) => [t.canopyColor[0], t.canopyColor[1], t.canopyColor[2], 255],
      material: { ambient: 0.5, diffuse: 0.7, shininess: 8, specularColor: [40, 60, 40] },
    }),

    new PolygonLayer<Building>({
      id: 'buildings',
      data: buildings,
      pickable: true,
      stroked: true,
      filled: true,
      extruded: true,
      // Glass-box look: low-alpha fill so people inside / behind show through,
      // plus a darker wireframe so each building still reads as its own box.
      wireframe: true,
      getPolygon: (b) => b.footprint,
      getFillColor: (b) => [b.color[0], b.color[1], b.color[2], 80],
      getLineColor: (b) => [
        Math.max(0, b.color[0] - 60),
        Math.max(0, b.color[1] - 60),
        Math.max(0, b.color[2] - 60),
        200,
      ],
      getElevation: (b) => b.height,
      material: { ambient: 0.4, diffuse: 0.7, shininess: 32, specularColor: [120, 120, 120] },
      onClick: (info) => {
        const b = info.object as Building | undefined;
        onPickEstablishment(b?.est ?? null);
      },
    }),
  ];

  // -------------------------------------------------------------------------
  // Per-agent dynamic layers (cars, bodies, heads, low-zoom dots)
  // -------------------------------------------------------------------------
  if (smoothed) {
    const positionFor = (i: number, z: number): [number, number, number] => {
      const act = smoothed.activities[i] ?? 0;
      const offset = isCommuting(act) ? 0 : 0.5; // center on building when stationary
      return [smoothed.positions[i * 2] + offset, smoothed.positions[i * 2 + 1] + offset, z];
    };

    layers.push(
      // Cars: square columns, visible only during car-mode commute. material:false
      // bypasses lighting so neon stays vibrant at night (and dark stays muted by day).
      new ColumnLayer<AgentDict>({
        id: 'cars',
        data: agents,
        diskResolution: 4, // square cross-section
        radius: 0.32, // larger car footprint — visible at city zoom
        angle: 45,
        extruded: true,
        pickable: false,
        getPosition: (_a, info) => positionFor(info.index, 0),
        getElevation: (a, info) => {
          if (a.mode !== 'car') return 0;
          const act = smoothed.activities[info.index] ?? 0;
          return isCommuting(act) ? 0.4 : 0; // taller car body
        },
        getFillColor: (a, info) => {
          if (a.mode !== 'car') return [0, 0, 0, 0];
          const act = smoothed.activities[info.index] ?? 0;
          if (!isCommuting(act)) return [0, 0, 0, 0];
          return carColorAt(info.index);
        },
        updateTriggers: {
          getPosition: smoothed,
          getElevation: smoothed,
          getFillColor: [smoothed, dayMix],
        },
        material: false,
      }),

      // Stick-figure body — dark by day / neon by night. material:false keeps
      // colors at full saturation so neon reads as glowing at night.
      new ColumnLayer<AgentDict>({
        id: 'people-bodies',
        data: agents,
        diskResolution: 4,
        radius: 0.16, // bigger torso so figures read clearly at city zoom
        angle: 0,
        extruded: true,
        pickable: true,
        getPosition: (_a, info) => positionFor(info.index, 0),
        getElevation: 0.95, // taller bodies — closer to a story tall
        getFillColor: (_a, info) => personColorAt(info.index),
        updateTriggers: {
          getPosition: smoothed,
          getFillColor: dayMix,
        },
        material: false,
        onClick: (info) => onPickAgent((info.object as AgentDict | undefined) ?? null),
      }),

      // Stick-figure head — same dark/neon treatment as body so each agent
      // reads as a single hue identity from head to toe.
      new ScatterplotLayer<AgentDict>({
        id: 'people-heads',
        data: agents,
        pickable: false,
        stroked: false,
        filled: true,
        radiusUnits: 'common',
        radiusMinPixels: 3,
        radiusMaxPixels: 10,
        getPosition: (_a, info) => positionFor(info.index, 1.05),
        getRadius: 0.22,
        getFillColor: (_a, info) => personColorAt(info.index),
        updateTriggers: {
          getPosition: smoothed,
          getFillColor: dayMix,
        },
      }),

      // Low-zoom dot — keeps people visible when zoomed all the way out
      new ScatterplotLayer<AgentDict>({
        id: 'people-dots',
        data: agents,
        pickable: false,
        stroked: false,
        filled: true,
        radiusUnits: 'common',
        radiusMinPixels: 3,
        radiusMaxPixels: 5,
        getPosition: (_a, info) => positionFor(info.index, 1.1),
        getRadius: 0.12,
        getFillColor: (_a, info) => {
          const code = smoothed.activities[info.index] ?? 0;
          const c = ACTIVITY_COLORS[code] ?? [200, 200, 200];
          return [c[0], c[1], c[2], 255];
        },
        updateTriggers: {
          getPosition: smoothed,
          getFillColor: smoothed,
        },
      }),
    );
  }

  return (
    <DeckGL
      views={new OrbitView({ id: 'city', orbitAxis: 'Z' })}
      initialViewState={initialViewState}
      controller={true}
      layers={layers as never}
      effects={[lightingEffect]}
      getCursor={({ isDragging, isHovering }) =>
        isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'
      }
      style={{ width: '100%', height: '100%' }}
    />
  );
}

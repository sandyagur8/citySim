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
import { PolygonLayer, ScatterplotLayer, ColumnLayer, TextLayer } from '@deck.gl/layers';

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

// Per-establishment-kind glyph rendered as a floating sign above the building.
// Read at a glance: ☕ marks coffee shops, 🍺 pubs, 🛒 supermarkets, etc.
const KIND_ICON: Record<string, string> = {
  coffee_shop: '☕',
  pub: '🍺',
  restaurant: '🍽️',
  supermarket: '🛒',
  hardware: '🔧',
  pharmacy: '💊',
  clothing: '👕',
  bank: '💼',
  hospital: '🏥',
  school: '🏫',
  police: '🚓',
  office: '🏢',
  park: '🌳',
};

// Kind-specific text colour for the sign so the type is also encoded in hue.
const KIND_SIGN_COLOR: Record<string, [number, number, number]> = {
  coffee_shop: [255, 200, 130],
  pub: [255, 170, 90],
  restaurant: [255, 140, 140],
  supermarket: [120, 220, 160],
  hardware: [220, 180, 120],
  pharmacy: [120, 230, 170],
  clothing: [240, 150, 220],
  bank: [180, 200, 240],
  hospital: [255, 170, 170],
  school: [220, 220, 140],
  police: [150, 180, 255],
  office: [200, 220, 240],
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
    // Pull the camera in tighter so the city fills the viewport and feels
    // dense. The previous formula left a lot of empty viewport at zoom-out.
    const zoom = Math.max(2.4, Math.min(5.2, 10 - Math.log2(grid.size)));
    return {
      target: [grid.size / 2, grid.size / 2, 0] as [number, number, number],
      rotationX: 55,
      rotationOrbit: 30,
      zoom,
      minZoom: 1.2,
      maxZoom: 9,
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
      getFillColor: (r) => {
        // Three-tier palette so the city reads as a real road network:
        // major = dark asphalt, minor = lighter grey, sidewalk = pale.
        if (r.kind === 'major') return [28, 28, 32, 255];
        if (r.kind === 'minor') return [50, 50, 56, 255];
        return [180, 178, 170, 220]; // sidewalk
      },
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

    // Night-time neon glow under each shop sign — hidden during the day,
    // pops at dusk to read as the city "lighting up". Two stacked
    // ScatterplotLayers (a wide soft halo plus a tighter bright core)
    // give a cheap fake-bloom that scales nicely at low zoom.
    new ScatterplotLayer<Building>({
      id: 'shop-glow-halo',
      data: buildings.filter((b) => b.est !== null),
      pickable: false,
      stroked: false,
      filled: true,
      radiusUnits: 'common',
      getPosition: (b) => [b.x + 0.5, b.y + 0.5, b.height + 0.05],
      getRadius: 1.6,
      getFillColor: (b) => {
        const c = KIND_SIGN_COLOR[b.est!.kind] ?? [240, 240, 240];
        // Halo only at night (1 - dayMix). Soft edge.
        const a = Math.round(70 * (1 - dayMix));
        return [c[0], c[1], c[2], a];
      },
      updateTriggers: { getFillColor: dayMix },
    }),
    new ScatterplotLayer<Building>({
      id: 'shop-glow-core',
      data: buildings.filter((b) => b.est !== null),
      pickable: false,
      stroked: false,
      filled: true,
      radiusUnits: 'common',
      getPosition: (b) => [b.x + 0.5, b.y + 0.5, b.height + 0.1],
      getRadius: 0.55,
      getFillColor: (b) => {
        const c = KIND_SIGN_COLOR[b.est!.kind] ?? [240, 240, 240];
        const a = Math.round(160 * (1 - dayMix));
        return [c[0], c[1], c[2], a];
      },
      updateTriggers: { getFillColor: dayMix },
    }),

    // Floating shop signs — emoji + kind name above each establishment.
    // Only real establishments (Building.est != null) get a sign.
    new TextLayer<Building>({
      id: 'shop-signs',
      data: buildings.filter((b) => b.est !== null),
      getPosition: (b) => [b.x + 0.5, b.y + 0.5, b.height + 0.6],
      getText: (b) => KIND_ICON[b.est!.kind] ?? '🏪',
      getSize: 22,
      sizeUnits: 'pixels',
      sizeMinPixels: 14,
      sizeMaxPixels: 30,
      getColor: (b) => {
        const c = KIND_SIGN_COLOR[b.est!.kind] ?? [240, 240, 240];
        return [c[0], c[1], c[2], 235];
      },
      background: true,
      backgroundPadding: [4, 2],
      getBackgroundColor: () => [10, 10, 14, 180],
      getBorderColor: () => [40, 40, 50, 220],
      getBorderWidth: 1,
      billboard: true,
      pickable: true,
      onClick: (info) => {
        const b = info.object as Building | undefined;
        onPickEstablishment(b?.est ?? null);
      },
      // Re-render when sun moves (legibility tuning) — not strictly needed
      // but cheap and keeps the layer responsive to lighting.
      updateTriggers: { getColor: dayMix },
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

      // Low-zoom dot — keeps people visible when zoomed all the way out.
      // Bumped radius + min-pixels so a crowded area reads as a clear smear
      // of bustle from the wide-angle view.
      new ScatterplotLayer<AgentDict>({
        id: 'people-dots',
        data: agents,
        pickable: false,
        stroked: false,
        filled: true,
        radiusUnits: 'common',
        radiusMinPixels: 5,
        radiusMaxPixels: 9,
        getPosition: (_a, info) => positionFor(info.index, 1.1),
        getRadius: 0.18,
        getFillColor: (_a, info) => {
          const code = smoothed.activities[info.index] ?? 0;
          const c = ACTIVITY_COLORS[code] ?? [200, 200, 200];
          // Brighten at night so movement is still legible against the
          // dark ground / glowing shop signs.
          const lift = Math.round(40 * (1 - dayMix));
          return [
            Math.min(255, c[0] + lift),
            Math.min(255, c[1] + lift),
            Math.min(255, c[2] + lift),
            255,
          ];
        },
        updateTriggers: {
          getPosition: smoothed,
          getFillColor: [smoothed, dayMix],
        },
      }),

      // Activity halo — a faint wider disc behind each agent. Soft
      // overlapping discs in busy areas merge into "crowd glow" patches,
      // which is the visual cue for bustle at zoom-out.
      new ScatterplotLayer<AgentDict>({
        id: 'people-halos',
        data: agents,
        pickable: false,
        stroked: false,
        filled: true,
        radiusUnits: 'common',
        radiusMinPixels: 4,
        radiusMaxPixels: 14,
        getPosition: (_a, info) => positionFor(info.index, 0.3),
        getRadius: 0.42,
        getFillColor: (_a, info) => {
          const code = smoothed.activities[info.index] ?? 0;
          const c = ACTIVITY_COLORS[code] ?? [200, 200, 200];
          // Cheap blend toward neon at night, low alpha either way.
          const alpha = 28 + Math.round(36 * (1 - dayMix));
          return [c[0], c[1], c[2], alpha];
        },
        updateTriggers: {
          getPosition: smoothed,
          getFillColor: [smoothed, dayMix],
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

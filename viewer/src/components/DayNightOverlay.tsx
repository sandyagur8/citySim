// A full-screen overlay div whose colour and opacity track the simulated sun.
// We tint the zoning layer in CityView for the *colour* shift; this overlay
// adds a subtle sky-glow vignette that gives a stronger sense of time passing
// (warm pulse at sunrise/sunset, deep blue overnight).

import { useMemo } from 'react';

type Props = {
  sunAltitude: number; // 0..1
};

export function DayNightOverlay({ sunAltitude }: Props) {
  const style = useMemo(() => skyStyle(sunAltitude), [sunAltitude]);
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ ...style, mixBlendMode: 'multiply' }}
    />
  );
}

function skyStyle(sunAlt: number): React.CSSProperties {
  // Map sunAlt to a sky tint
  let r: number, g: number, b: number, opacity: number;
  if (sunAlt <= 0) {
    // night — deep navy
    r = 30; g = 40; b = 90; opacity = 0.55;
  } else if (sunAlt < 0.10) {
    // dawn / pre-sunset
    const t = sunAlt / 0.10;
    r = 30 + (240 - 30) * t;
    g = 40 + (140 - 40) * t;
    b = 90 + (90 - 90) * t;
    opacity = 0.55 - 0.20 * t;
  } else if (sunAlt < 0.25) {
    // golden hour
    const t = (sunAlt - 0.10) / 0.15;
    r = 240 + (255 - 240) * t;
    g = 140 + (220 - 140) * t;
    b = 90 + (180 - 90) * t;
    opacity = 0.35 - 0.30 * t;
  } else {
    // day — almost no overlay
    r = 255; g = 255; b = 255; opacity = 0.05;
  }
  return {
    background: `radial-gradient(ellipse at 50% 30%, rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${opacity * 0.6}) 0%, rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${opacity}) 100%)`,
  };
}

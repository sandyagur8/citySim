// Mirror of the backend solar math. The backend already drives the clock and
// the lighting could be derived from the sun_altitude on each tick, but doing
// it client-side gives us a smoother gradient between ticks (and lets the
// viewer keep a sense of "what's the sun doing?" even when paused or scrubbing).

const TWO_PI = Math.PI * 2;

function declinationRadians(dayOfYear: number): number {
  return (23.45 * Math.PI) / 180 * Math.cos((TWO_PI * (dayOfYear - 172)) / 365);
}

export function sunAltitude(latitudeDeg: number, dayOfYear: number, minuteOfDay: number): number {
  const lat = (latitudeDeg * Math.PI) / 180;
  const decl = declinationRadians(dayOfYear);
  const hoursFromNoon = minuteOfDay / 60 - 12;
  const hourAngle = (15 * hoursFromNoon * Math.PI) / 180;
  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const clamped = Math.max(-1, Math.min(1, sinAlt));
  const altitude = Math.asin(clamped);
  if (altitude <= 0) return 0;
  return altitude / (Math.PI / 2);
}

export function sunriseSunset(latitudeDeg: number, dayOfYear: number): [number, number] {
  const lat = (latitudeDeg * Math.PI) / 180;
  const decl = declinationRadians(dayOfYear);
  const cosH = -Math.tan(lat) * Math.tan(decl);
  if (cosH >= 1) return [12 * 60, 12 * 60];
  if (cosH <= -1) return [0, 24 * 60];
  const h = (Math.acos(cosH) * 180) / Math.PI;
  const halfDay = Math.round(h * 4);
  return [12 * 60 - halfDay, 12 * 60 + halfDay];
}

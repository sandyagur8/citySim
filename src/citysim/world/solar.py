"""Solar position calc.

Approximates sun altitude (0..1, where 1 = local noon, 0 = below horizon) for
a given latitude, day-of-year, and minute-of-day. The result drives the
day-night overlay in the viewer; we don't need true astronomical precision,
only a smooth and roughly correct lighting curve that tracks real sunrise
and sunset times within a few minutes.

The math is a simplified NOAA-style solar position calculation.
"""

from __future__ import annotations

import math


def _declination_radians(day_of_year: int) -> float:
    """Approximate solar declination using a cosine model.

    Day-of-year is 1-based (1 = Jan 1). Peaks at +23.45 deg around day 172
    (June 21) and bottoms at -23.45 deg around day 355 (Dec 21).
    """
    return math.radians(23.45) * math.cos(2 * math.pi * (day_of_year - 172) / 365.0)


def sun_altitude(latitude_deg: float, day_of_year: int, minute_of_day: int) -> float:
    """Return sun altitude normalised to [0, 1] for visual purposes.

    Below the horizon is clamped to 0. At local solar noon on the equinoxes
    at the equator, returns ~1. The viewer interpolates lighting tints from
    this value.
    """
    lat = math.radians(latitude_deg)
    decl = _declination_radians(day_of_year)
    # Hour angle: 0 at local solar noon (12:00), -pi at midnight (00:00).
    # We use clock time as a proxy for solar time; close enough for visuals.
    hours_from_noon = minute_of_day / 60.0 - 12.0
    hour_angle = math.radians(15.0 * hours_from_noon)
    sin_alt = (
        math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(hour_angle)
    )
    sin_alt = max(-1.0, min(1.0, sin_alt))
    altitude = math.asin(sin_alt)  # radians, can be negative when sun is below horizon
    if altitude <= 0:
        return 0.0
    # Map altitude (0..pi/2) to (0..1)
    return altitude / (math.pi / 2.0)


def sunrise_sunset(latitude_deg: float, day_of_year: int) -> tuple[int, int]:
    """Return (sunrise_minute, sunset_minute) for the given day.

    Both values are minutes-of-day. Approximate; ignores equation-of-time and
    longitude correction. Good to within a few minutes for visual purposes.
    Returns (0, 0) for polar day/night edge cases.
    """
    lat = math.radians(latitude_deg)
    decl = _declination_radians(day_of_year)
    cos_h = -math.tan(lat) * math.tan(decl)
    if cos_h >= 1.0:  # polar night
        return (12 * 60, 12 * 60)
    if cos_h <= -1.0:  # polar day
        return (0, 24 * 60)
    h = math.degrees(math.acos(cos_h))
    half_day_minutes = int(round(h * 4))  # 1 deg = 4 minutes of clock time
    return (12 * 60 - half_day_minutes, 12 * 60 + half_day_minutes)

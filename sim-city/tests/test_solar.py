"""Smoke tests for the solar position math."""

from __future__ import annotations

from citysim.world.solar import sun_altitude, sunrise_sunset


def test_noon_high_at_equator_equinox() -> None:
    # Spring equinox is around day 80. At the equator, noon altitude should be near 1.
    altitude = sun_altitude(latitude_deg=0.0, day_of_year=80, minute_of_day=12 * 60)
    assert altitude > 0.95


def test_midnight_dark() -> None:
    altitude = sun_altitude(latitude_deg=12.97, day_of_year=120, minute_of_day=0)
    assert altitude == 0.0


def test_sunrise_before_sunset() -> None:
    rise, set_ = sunrise_sunset(latitude_deg=12.97, day_of_year=120)
    assert rise < set_
    assert 4 * 60 < rise < 8 * 60
    assert 17 * 60 < set_ < 20 * 60


def test_sunrise_sunset_summer_solstice_higher_latitude() -> None:
    # London-ish, around June 21 should have a long day.
    rise, set_ = sunrise_sunset(latitude_deg=51.5, day_of_year=172)
    assert (set_ - rise) > 14 * 60  # > 14 hours of daylight

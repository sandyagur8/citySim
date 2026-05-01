"""Smoke tests for the world layer."""

from __future__ import annotations

from citysim.world import (
    Zoning,
    generate_agents,
    generate_grid,
    place_establishments,
    plan_day,
)


def test_grid_shape_and_zoning_classes() -> None:
    grid = generate_grid(size=40, seed=1)
    assert grid.zoning.shape == (40, 40)
    classes = set(int(z) for z in grid.zoning.flatten().tolist())
    # All zoning values must be valid Zoning enum members
    for c in classes:
        Zoning(c)
    # Centre cells should be commercial
    centre = grid.size // 2
    assert int(grid.zoning[centre, centre]) == int(Zoning.COMMERCIAL)


def test_generate_agents_and_plan() -> None:
    grid = generate_grid(size=40, seed=2)
    establishments = place_establishments(grid, seed=2)
    assert len(establishments) > 10
    agents = generate_agents(grid, establishments, n=200, seed=2)
    assert len(agents) == 200
    # At least some agents have a workplace
    workers = [a for a in agents if a.work_cell is not None]
    assert len(workers) > 50
    # Plans are non-empty and sorted
    plan = plan_day(workers[0], establishments, day_of_week=2, seed=2)
    assert plan
    minutes = [i.start_minute for i in plan]
    assert minutes == sorted(minutes)


def test_position_for_at_sleep() -> None:
    from citysim.server.sim import position_for
    from citysim.world.schedule import Activity

    grid = generate_grid(size=40, seed=3)
    establishments = place_establishments(grid, seed=3)
    agents = generate_agents(grid, establishments, n=10, seed=3)
    plans = {a.id: plan_day(a, establishments, day_of_week=1, seed=3) for a in agents}
    # At 03:00 every agent should be asleep at home
    for a in agents:
        x, y, act = position_for(a, plans[a.id], sim_minute=180.0)
        assert act == Activity.SLEEP
        assert (int(x), int(y)) == a.home_cell

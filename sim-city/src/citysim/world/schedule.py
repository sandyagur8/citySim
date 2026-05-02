"""Daily-schedule planner (mock).

Each agent gets an ordered list of intentions for the day. An intention is
(start_minute, activity, target_cell). The interaction layer will eventually
slot in store visits and persona-driven errands; for now we cover the basic
rhythm so the city visibly comes alive at the right hours of the day.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import numpy as np

from citysim.world.agents import Agent
from citysim.world.establishments import Establishment, EstablishmentKind


class Activity(str, Enum):
    SLEEP = "sleep"
    COMMUTE = "commute"
    WORK = "work"
    EAT = "eat"
    SHOP = "shop"
    LEISURE = "leisure"
    SCHOOL = "school"


# Activity → display colour, used by the viewer (kept here so backend can echo it
# in init payloads if useful later).
ACTIVITY_CODES: dict[Activity, int] = {
    Activity.SLEEP: 0,
    Activity.COMMUTE: 1,
    Activity.WORK: 2,
    Activity.EAT: 3,
    Activity.SHOP: 4,
    Activity.LEISURE: 5,
    Activity.SCHOOL: 6,
}


@dataclass(frozen=True)
class Intention:
    start_minute: int  # 0..1439
    activity: Activity
    cell: tuple[int, int]


def _nearest(cell: tuple[int, int], options: list[Establishment]) -> Establishment | None:
    """Closest establishment by Manhattan distance."""
    if not options:
        return None
    cx, cy = cell
    return min(options, key=lambda e: abs(e.cell[0] - cx) + abs(e.cell[1] - cy))


def plan_day(
    agent: Agent,
    establishments: list[Establishment],
    day_of_week: int = 0,
    seed: int = 42,
) -> list[Intention]:
    """Generate today's intentions for an agent.

    `day_of_week` is 0=Mon..6=Sun; weekend schedules are different.
    """
    rng = np.random.default_rng(seed + hash(agent.id) % (2**32))
    intentions: list[Intention] = []

    is_weekend = day_of_week >= 5
    food_options = [
        e
        for e in establishments
        if e.kind in (EstablishmentKind.RESTAURANT, EstablishmentKind.COFFEE_SHOP)
    ]
    shop_options = [
        e
        for e in establishments
        if e.kind
        in (
            EstablishmentKind.SUPERMARKET,
            EstablishmentKind.CLOTHING,
            EstablishmentKind.HARDWARE,
            EstablishmentKind.PHARMACY,
        )
    ]
    leisure_options = [
        e for e in establishments if e.kind in (EstablishmentKind.PARK, EstablishmentKind.PUB)
    ]
    schools = [e for e in establishments if e.kind == EstablishmentKind.SCHOOL]

    # Wake time scattered around 06:30-08:30 weekdays, later on weekends
    wake = int(rng.integers(390, 510)) if not is_weekend else int(rng.integers(450, 600))

    # Sleep until wake
    intentions.append(Intention(start_minute=0, activity=Activity.SLEEP, cell=agent.home_cell))

    # Determine if agent has a work or school destination today
    work_dest_cell: tuple[int, int] | None = None
    work_activity = Activity.WORK
    if agent.age < 18:
        sch = _nearest(agent.home_cell, schools)
        if sch is not None and not is_weekend:
            work_dest_cell = sch.cell
            work_activity = Activity.SCHOOL
    elif agent.work_cell is not None and not is_weekend:
        work_dest_cell = agent.work_cell

    if work_dest_cell is not None:
        commute_start = wake + int(rng.integers(20, 50))
        intentions.append(
            Intention(start_minute=commute_start, activity=Activity.COMMUTE, cell=work_dest_cell)
        )
        work_start = commute_start + 30
        intentions.append(
            Intention(start_minute=work_start, activity=work_activity, cell=work_dest_cell)
        )

        # Lunch
        lunch_target = _nearest(work_dest_cell, food_options)
        if lunch_target is not None:
            lunch_start = max(work_start + 60, 12 * 60 + int(rng.integers(-20, 30)))
            intentions.append(
                Intention(start_minute=lunch_start, activity=Activity.EAT, cell=lunch_target.cell)
            )
            intentions.append(
                Intention(
                    start_minute=lunch_start + 45, activity=work_activity, cell=work_dest_cell
                )
            )

        # End of day
        end_of_work = 17 * 60 + int(rng.integers(-30, 60))
        # Maybe an errand
        if rng.random() < 0.4 and shop_options:
            shop_target = shop_options[int(rng.integers(0, len(shop_options)))]
            intentions.append(
                Intention(
                    start_minute=end_of_work, activity=Activity.COMMUTE, cell=shop_target.cell
                )
            )
            intentions.append(
                Intention(
                    start_minute=end_of_work + 20, activity=Activity.SHOP, cell=shop_target.cell
                )
            )
            head_home = end_of_work + 50
        else:
            head_home = end_of_work
        intentions.append(
            Intention(start_minute=head_home, activity=Activity.COMMUTE, cell=agent.home_cell)
        )
        intentions.append(
            Intention(start_minute=head_home + 30, activity=Activity.LEISURE, cell=agent.home_cell)
        )
    else:
        # No work; maybe a leisure trip
        if rng.random() < 0.5 and leisure_options:
            target = leisure_options[int(rng.integers(0, len(leisure_options)))]
            t = wake + int(rng.integers(60, 240))
            intentions.append(
                Intention(start_minute=t, activity=Activity.COMMUTE, cell=target.cell)
            )
            intentions.append(
                Intention(start_minute=t + 25, activity=Activity.LEISURE, cell=target.cell)
            )
            intentions.append(
                Intention(start_minute=t + 25 + 90, activity=Activity.COMMUTE, cell=agent.home_cell)
            )

    # Evening: dinner then sleep
    dinner_start = 19 * 60 + int(rng.integers(-30, 60))
    dinner_cell = agent.home_cell
    if rng.random() < 0.25 and food_options:
        dinner_cell = food_options[int(rng.integers(0, len(food_options)))].cell
        intentions.append(
            Intention(start_minute=dinner_start, activity=Activity.COMMUTE, cell=dinner_cell)
        )
        intentions.append(
            Intention(start_minute=dinner_start + 20, activity=Activity.EAT, cell=dinner_cell)
        )
        intentions.append(
            Intention(
                start_minute=dinner_start + 75, activity=Activity.COMMUTE, cell=agent.home_cell
            )
        )
    else:
        intentions.append(
            Intention(start_minute=dinner_start, activity=Activity.EAT, cell=agent.home_cell)
        )

    # Sleep
    sleep_time = 22 * 60 + int(rng.integers(0, 90))
    intentions.append(
        Intention(start_minute=sleep_time, activity=Activity.SLEEP, cell=agent.home_cell)
    )

    intentions.sort(key=lambda x: x.start_minute)
    return intentions

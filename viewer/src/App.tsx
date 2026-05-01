// Top-level layout: time controls strip on top, full-bleed deck.gl canvas below,
// day-night overlay on top of the canvas, side panel on the right when picked.

import { useState } from 'react';
import { CityView } from './components/CityView';
import { DayNightOverlay } from './components/DayNightOverlay';
import { SidePanel } from './components/SidePanel';
import { TimeControls } from './components/TimeControls';
import { useSimStream } from './hooks/useSimStream';
import { sunAltitude } from './lib/solar';
import type { AgentDict, EstablishmentDict } from './lib/types';

export default function App() {
  const { connected, world, clock, smoothed, send } = useSimStream('/ws');
  const [pickedAgent, setPickedAgent] = useState<AgentDict | null>(null);
  const [pickedEst, setPickedEst] = useState<EstablishmentDict | null>(null);

  // sun altitude derived from current sim minute + city latitude
  const sunAlt =
    world && clock
      ? sunAltitude(world.grid.latitude, clock.day_of_year, clock.sim_minute)
      : 0.5;

  // When an agent is picked, find its current activity code from smoothed
  let pickedActivity: number | undefined;
  if (pickedAgent && smoothed && world) {
    const idx = world.agents.findIndex((a) => a.id === pickedAgent.id);
    if (idx >= 0) pickedActivity = smoothed.activities[idx];
  }

  return (
    <div className="fixed inset-0 bg-neutral-950 text-neutral-100 overflow-hidden">
      <div className="absolute top-0 left-0 right-0 z-10">
        <TimeControls clock={clock} connected={connected} send={send} />
      </div>

      <div className="absolute inset-0 top-12">
        {world ? (
          <>
            <CityView
              grid={world.grid}
              establishments={world.establishments}
              agents={world.agents}
              smoothed={smoothed}
              sunAltitude={sunAlt}
              onPickAgent={(a) => {
                setPickedAgent(a);
                if (a) setPickedEst(null);
              }}
              onPickEstablishment={(e) => {
                setPickedEst(e);
                if (e) setPickedAgent(null);
              }}
            />
            <DayNightOverlay sunAltitude={sunAlt} />
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-neutral-500">
            Waiting for the simulator…
          </div>
        )}
      </div>

      <SidePanel
        pickedAgent={pickedAgent}
        pickedEstablishment={pickedEst}
        currentActivityCode={pickedActivity}
        onClose={() => {
          setPickedAgent(null);
          setPickedEst(null);
        }}
      />
    </div>
  );
}

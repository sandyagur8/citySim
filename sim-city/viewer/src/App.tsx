// Top-level layout: time controls strip on top, full-bleed deck.gl canvas
// below, day-night overlay on top of the canvas, side panel on the right
// when picked. The product-test overlays — StatsHUD (top-right),
// DialogueFeed (bottom-right), DaySummaryModal (per-day rollover),
// RunReportModal (final cumulative report), and SimulationWizard (3-step
// kickoff flow) — render on top of the canvas to make the whole
// product-test loop demo-able from the browser without ever touching
// the CLI.
//
// Lifecycle:
//   • run.status === 'idle'      → SimulationWizard (3 steps)
//   • run.status === 'running'   → live HUD + DialogueFeed; per-day modal
//                                  pops on each midnight rollover
//   • run.status === 'completed' → RunReportModal with "Rerun" CTA that
//                                  reopens the wizard pre-filled at step 2

import { useEffect, useState } from 'react';
import { CityView } from './components/CityView';
import { ConversationScene } from './components/ConversationScene';
import { DayNightOverlay } from './components/DayNightOverlay';
import { DaySummaryModal } from './components/DaySummaryModal';
import { DialogueFeed } from './components/DialogueFeed';
import { EnsLookupPanel } from './components/EnsLookupPanel';
import { ProductSetup } from './components/ProductSetup';
import { RunReportModal } from './components/RunReportModal';
import { SidePanel } from './components/SidePanel';
import { SimulationWizard } from './components/SimulationWizard';
import { StatsHUD } from './components/StatsHUD';
import { TimeControls } from './components/TimeControls';
import { useSimStream } from './hooks/useSimStream';
import {
  pauseSimulation,
  resetSimulation,
  resumeSimulation,
  stopSimulation,
} from './lib/api';
import { sunAltitude } from './lib/solar';
import type { AgentDict, DialogueCard, EstablishmentDict } from './lib/types';

export default function App() {
  const {
    connected,
    world,
    clock,
    smoothed,
    product,
    products,
    stats,
    recentDialogues,
    pendingSummary,
    dismissSummary,
    run,
    pendingRunSummary,
    dismissRunSummary,
    send,
  } = useSimStream('/ws');
  const [pickedAgent, setPickedAgent] = useState<AgentDict | null>(null);
  const [pickedEst, setPickedEst] = useState<EstablishmentDict | null>(null);
  // Selected dialogue id for the ConversationScene modal. We keep just
  // the id (not the card object) so the modal stays in sync with the
  // live `recentDialogues` list — turns + outcome update as they stream.
  const [sceneDialogueId, setSceneDialogueId] = useState<string | null>(null);

  // Wizard visibility + rerun pre-fill state.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardInitialStep, setWizardInitialStep] = useState<1 | 2 | 3>(1);
  const [wizardLockedProduct, setWizardLockedProduct] = useState<string | null>(
    null,
  );
  // Captured BEFORE resetSimulation() runs so the rerun wizard pre-fills
  // with the parameters the user actually used last time, not the
  // post-reset defaults (which would silently downgrade total_days to 1).
  const [wizardPrefillConfig, setWizardPrefillConfig] = useState<
    Partial<typeof run.config> | null
  >(null);

  // Edit-product modal still available via StatsHUD pill, but no longer
  // auto-opens (the wizard is now the entry point).
  const [productSetupOpen, setProductSetupOpen] = useState(false);
  const [ensLookupOpen, setEnsLookupOpen] = useState(true);

  // Auto-open the wizard whenever the run is idle and we have a world.
  useEffect(() => {
    if (world && run.status === 'idle') {
      setWizardOpen(true);
      setWizardInitialStep(1);
      setWizardLockedProduct(null);
    }
  }, [world, run.status]);

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

  const onRerun = async () => {
    // Capture the just-finished run's parameters BEFORE we reset, so the
    // wizard's step 2 shows the user's choices (e.g. total_days=3),
    // not the post-reset defaults (total_days=1).
    const previousConfig = { ...run.config };
    const product_name = previousConfig.product_name ?? null;
    try {
      await resetSimulation();
    } catch {
      // best-effort
    }
    setWizardLockedProduct(product_name);
    setWizardPrefillConfig(previousConfig);
    setWizardInitialStep(2);
    setWizardOpen(true);
    dismissRunSummary();
  };

  const onEnd = async () => {
    if (
      !confirm(
        'End the simulation now? You\'ll see the cumulative report and can rerun with new params.',
      )
    )
      return;
    try {
      await stopSimulation();
    } catch {
      // backend will broadcast a status update either way
    }
  };

  const onPauseToggle = async () => {
    try {
      if (clock?.paused) {
        await resumeSimulation();
      } else {
        await pauseSimulation();
      }
    } catch {
      // best-effort; the WS broadcast is the source of truth
    }
  };

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

      {world && (
        <>
          {!ensLookupOpen && (
            <button
              type="button"
              onClick={() => setEnsLookupOpen(true)}
              className="absolute top-14 left-3 z-20 rounded bg-neutral-900/95 border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-500"
            >
              Open ENS Lookup
            </button>
          )}
          {ensLookupOpen && <EnsLookupPanel onClose={() => setEnsLookupOpen(false)} />}
          <StatsHUD
            stats={stats}
            product={product}
            onEditProduct={() => setProductSetupOpen(true)}
          />
          <DialogueFeed
            dialogues={recentDialogues}
            onOpenScene={(card: DialogueCard) => setSceneDialogueId(card.dialogue_id)}
          />

          {/* Run-status badge bottom-left, with pause/resume + end while running. */}
          <RunStatusBadge
            status={run.status}
            paused={!!clock?.paused}
            daysCompleted={run.days_completed}
            totalDays={run.config.total_days}
            onEnd={onEnd}
            onPauseToggle={onPauseToggle}
          />
        </>
      )}

      <SidePanel
        pickedAgent={pickedAgent}
        pickedEstablishment={pickedEst}
        currentActivityCode={pickedActivity}
        onClose={() => {
          setPickedAgent(null);
          setPickedEst(null);
        }}
      />

      {productSetupOpen && (
        <ProductSetup
          initial={product}
          products={products}
          onSetConcurrentAgents={(n) => send({ type: 'set_dialogue_workers', value: n })}
          onSetAxlNodeCount={(n) => send({ type: 'set_axl_node_count', value: n })}
          onClose={() => setProductSetupOpen(false)}
          onSaved={() => {
            // useSimStream will refresh `product` from the WS broadcast.
          }}
        />
      )}

      {wizardOpen && (
        <SimulationWizard
          products={products}
          prefillProductName={wizardLockedProduct}
          initialStep={wizardInitialStep}
          initialConfig={
            wizardPrefillConfig ??
            (wizardInitialStep === 2 ? { ...run.config } : undefined)
          }
          onClose={() => {
            setWizardOpen(false);
            setWizardPrefillConfig(null);
          }}
          onStarted={() => {
            setWizardOpen(false);
            setWizardPrefillConfig(null);
          }}
        />
      )}

      {pendingSummary && run.status === 'running' && (
        <DaySummaryModal summary={pendingSummary} onClose={dismissSummary} />
      )}

      {pendingRunSummary && (
        <RunReportModal
          summary={pendingRunSummary}
          onClose={dismissRunSummary}
          onRerun={onRerun}
        />
      )}

      {/* Conversation scene modal — driven by the live recentDialogues list
          so a clicked card keeps animating in real-time as turns arrive. */}
      {sceneDialogueId &&
        (() => {
          const card = recentDialogues.find(
            (c: DialogueCard) => c.dialogue_id === sceneDialogueId,
          );
          if (!card) {
            // Card aged out of the ring — auto-close.
            return null;
          }
          return (
            <ConversationScene
              card={card}
              onClose={() => setSceneDialogueId(null)}
            />
          );
        })()}
    </div>
  );
}

function RunStatusBadge({
  status,
  paused,
  daysCompleted,
  totalDays,
  onEnd,
  onPauseToggle,
}: {
  status: 'idle' | 'running' | 'completed';
  paused: boolean;
  daysCompleted: number;
  totalDays: number;
  onEnd: () => void;
  onPauseToggle: () => void;
}) {
  const label =
    status === 'running'
      ? paused
        ? `Paused · day ${daysCompleted + 1} / ${totalDays}`
        : `Running · day ${daysCompleted + 1} / ${totalDays}`
      : status === 'completed'
      ? 'Run complete'
      : 'Idle';
  const dotCls =
    status !== 'running'
      ? status === 'completed'
        ? 'bg-sky-500'
        : 'bg-neutral-500'
      : paused
      ? 'bg-amber-400'
      : 'bg-emerald-500 animate-pulse';
  return (
    <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2 bg-neutral-900/85 backdrop-blur-md border border-neutral-700 rounded px-3 py-1.5 text-xs">
      <span className={`h-2 w-2 rounded-full ${dotCls}`} />
      <span className="text-neutral-200">{label}</span>
      {status === 'running' && (
        <>
          <button
            type="button"
            onClick={onPauseToggle}
            className="ml-2 px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[11px]"
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={onEnd}
            className="px-2 py-0.5 rounded bg-rose-900/40 hover:bg-rose-800/60 text-rose-200 text-[11px]"
          >
            End
          </button>
        </>
      )}
    </div>
  );
}

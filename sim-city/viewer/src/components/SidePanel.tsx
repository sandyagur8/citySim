// Right-hand side panel showing details for a clicked agent or establishment.

import type { AgentDict, EstablishmentDict } from '../lib/types';
import { ACTIVITY_NAMES } from '../lib/types';

type Props = {
  pickedAgent: AgentDict | null;
  pickedEstablishment: EstablishmentDict | null;
  currentActivityCode?: number;
  onClose: () => void;
};

export function SidePanel({ pickedAgent, pickedEstablishment, currentActivityCode, onClose }: Props) {
  if (!pickedAgent && !pickedEstablishment) return null;

  return (
    <aside className="absolute top-12 right-0 bottom-0 w-80 bg-neutral-900/95 backdrop-blur text-neutral-100 border-l border-neutral-800 overflow-y-auto p-4 text-sm">
      <button
        onClick={onClose}
        className="absolute top-2 right-3 text-neutral-400 hover:text-white text-lg"
        aria-label="Close"
      >
        ×
      </button>

      {pickedAgent && (
        <>
          <h3 className="font-semibold text-amber-300 text-base mb-1">Agent {pickedAgent.id}</h3>
          <p className="text-neutral-400 mb-3">
            {pickedAgent.age} · {pickedAgent.occupation} · {pickedAgent.mode}
          </p>
          <Field k="Home cell" v={pickedAgent.home_cell.join(', ')} />
          <Field
            k="Work cell"
            v={pickedAgent.work_cell ? pickedAgent.work_cell.join(', ') : '—'}
          />
          <Field k="Employer" v={pickedAgent.employer_id ?? '—'} />
          {currentActivityCode !== undefined && (
            <Field k="Right now" v={ACTIVITY_NAMES[currentActivityCode] ?? '?'} />
          )}
          <p className="mt-4 text-xs text-neutral-500 leading-relaxed">
            Persona, tastes, need-state and dialogue history will appear here once the
            persona generator and interaction runner are wired up.
          </p>
        </>
      )}

      {pickedEstablishment && (
        <>
          <h3 className="font-semibold text-emerald-300 text-base mb-1">
            {pickedEstablishment.kind}
          </h3>
          <p className="text-neutral-400 mb-3">{pickedEstablishment.name}</p>
          <Field k="Cell" v={pickedEstablishment.cell.join(', ')} />
          <Field
            k="Hours"
            v={`${fmtMin(pickedEstablishment.hours[0])} – ${fmtMin(pickedEstablishment.hours[1])}`}
          />
          <Field k="Capacity" v={String(pickedEstablishment.capacity)} />
          <p className="mt-4 text-xs text-neutral-500 leading-relaxed">
            Live footfall, today's revenue, and ongoing buyer/seller dialogues will appear here
            once the interaction runner is wired up.
          </p>
        </>
      )}
    </aside>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-1 border-b border-neutral-800/60">
      <span className="text-neutral-400">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

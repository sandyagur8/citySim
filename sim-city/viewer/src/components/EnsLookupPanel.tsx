import { useState } from 'react';

import { fetchAgentByEns, updateAgentPersonaByEns } from '../lib/api';
import type { EnsAgentLookup } from '../lib/types';

type Props = {
  onClose: () => void;
};

export function EnsLookupPanel({ onClose }: Props) {
  const [ens, setEns] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnsAgentLookup | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editAge, setEditAge] = useState(0);
  const [editGender, setEditGender] = useState('');
  const [editEducation, setEditEducation] = useState('');
  const [editIncomeBand, setEditIncomeBand] = useState('');
  const [editOccupation, setEditOccupation] = useState('');
  const [editHouseholdRole, setEditHouseholdRole] = useState('');
  const [editHouseholdId, setEditHouseholdId] = useState('');
  const [editMode, setEditMode] = useState('');
  const [editEmployerId, setEditEmployerId] = useState('');
  const [editHomeCell, setEditHomeCell] = useState('');
  const [editWorkCell, setEditWorkCell] = useState('');
  const [editCardText, setEditCardText] = useState('');
  const [editPrefsJson, setEditPrefsJson] = useState('{}');
  const [editNeedsJson, setEditNeedsJson] = useState('{}');
  const [editWalletAddress, setEditWalletAddress] = useState('');
  const [editAxlKey, setEditAxlKey] = useState('');
  const [editEnsStatus, setEditEnsStatus] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSearch() {
    setError(null);
    setLoading(true);
    try {
      const r = await fetchAgentByEns(ens);
      if (!r) {
        setResult(null);
        setError('No agent found for this ENS.');
      } else {
        setResult(r);
        setEditAge(r.demographics.age);
        setEditGender(r.demographics.gender);
        setEditEducation(r.demographics.education);
        setEditIncomeBand(r.demographics.income_band);
        setEditOccupation(r.demographics.occupation);
        setEditHouseholdRole(r.demographics.household_role);
        setEditHouseholdId(r.household_id);
        setEditMode(r.mode);
        setEditEmployerId(r.employer_id || '');
        setEditHomeCell(`${r.home_cell[0]},${r.home_cell[1]}`);
        setEditWorkCell(r.work_cell ? `${r.work_cell[0]},${r.work_cell[1]}` : '');
        setEditCardText(r.card_text);
        setEditPrefsJson(JSON.stringify(r.prefs, null, 2));
        setEditNeedsJson(JSON.stringify(r.needs, null, 2));
        setEditWalletAddress(r.wallet_address || '');
        setEditAxlKey(r.axl_key || '');
        setEditEnsStatus(r.ens_status || '');
      }
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onSavePersona() {
    if (!result) return;
    setSaving(true);
    setError(null);
    try {
      const parseCell = (raw: string): [number, number] | null => {
        const t = raw.trim();
        if (!t) return null;
        const parts = t.split(',').map((x) => Number(x.trim()));
        if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) {
          throw new Error('Cell format must be \"x,y\"');
        }
        return [parts[0], parts[1]];
      };
      const homeCell = parseCell(editHomeCell);
      if (!homeCell) throw new Error('home_cell required');
      const workCell = parseCell(editWorkCell);
      const prefs = JSON.parse(editPrefsJson);
      const needs = JSON.parse(editNeedsJson);

      await updateAgentPersonaByEns(result.ens_name || ens, {
        age: editAge,
        gender: editGender,
        education: editEducation,
        income_band: editIncomeBand,
        occupation: editOccupation,
        household_role: editHouseholdRole,
        household_id: editHouseholdId,
        mode: editMode,
        employer_id: editEmployerId || null,
        home_cell: homeCell,
        work_cell: workCell,
        card_text: editCardText,
        prefs,
        needs,
        wallet_address: editWalletAddress || null,
        axl_key: editAxlKey || null,
        ens_status: editEnsStatus,
      });
      const refreshed = await fetchAgentByEns(result.ens_name || ens);
      if (refreshed) {
        setResult(refreshed);
        setEditAge(refreshed.demographics.age);
        setEditGender(refreshed.demographics.gender);
        setEditEducation(refreshed.demographics.education);
        setEditIncomeBand(refreshed.demographics.income_band);
        setEditOccupation(refreshed.demographics.occupation);
        setEditHouseholdRole(refreshed.demographics.household_role);
        setEditHouseholdId(refreshed.household_id);
        setEditMode(refreshed.mode);
        setEditEmployerId(refreshed.employer_id || '');
        setEditHomeCell(`${refreshed.home_cell[0]},${refreshed.home_cell[1]}`);
        setEditWorkCell(refreshed.work_cell ? `${refreshed.work_cell[0]},${refreshed.work_cell[1]}` : '');
        setEditCardText(refreshed.card_text);
        setEditPrefsJson(JSON.stringify(refreshed.prefs, null, 2));
        setEditNeedsJson(JSON.stringify(refreshed.needs, null, 2));
        setEditWalletAddress(refreshed.wallet_address || '');
        setEditAxlKey(refreshed.axl_key || '');
        setEditEnsStatus(refreshed.ens_status || '');
      }
      setEditOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="absolute top-14 left-3 z-20 w-[26rem] max-w-[calc(100vw-1.5rem)] bg-neutral-900/95 border border-neutral-800 rounded-lg p-3 text-xs text-neutral-100 shadow-xl">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wide text-neutral-400">ENS Lookup</div>
        <button
          type="button"
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-100 text-sm leading-none px-1"
          aria-label="Close ENS lookup"
        >
          ×
        </button>
      </div>
      <div className="flex gap-2">
        <input
          value={ens}
          onChange={(e) => setEns(e.target.value)}
          placeholder="a000000.simcity-7890.eth"
          className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-xs outline-none focus:border-amber-400"
        />
        <button
          onClick={onSearch}
          disabled={loading || !ens.trim()}
          className="px-3 py-1.5 rounded bg-amber-500 text-black font-semibold disabled:opacity-50"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && <div className="mt-2 text-rose-300">{error}</div>}

      {result && (
        <div className="mt-3 space-y-1.5">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setEditOpen((v) => !v)}
              className="px-2 py-1 rounded border border-neutral-700 hover:border-neutral-500 text-[11px]"
            >
              {editOpen ? 'Cancel Edit' : 'Modify Persona'}
            </button>
          </div>
          <Row k="Agent" v={result.agent_id} />
          <Row k="ENS" v={result.ens_name ?? '—'} mono />
          <Row k="ENS status" v={result.ens_status} />
          <Row k="Wallet" v={result.wallet_address ?? '—'} mono />
          <Row k="AXL key" v={result.axl_key ?? '—'} mono />
          <Row k="Mode" v={result.mode} />
          <Row k="Employer ID" v={result.employer_id ?? '—'} mono />
          <Row k="Household ID" v={result.household_id} mono />
          <Row k="Home Cell" v={`${result.home_cell[0]},${result.home_cell[1]}`} mono />
          <Row k="Work Cell" v={result.work_cell ? `${result.work_cell[0]},${result.work_cell[1]}` : '—'} mono />
          <Row
            k="Profile"
            v={`${result.demographics.age}, ${result.demographics.gender}, ${result.demographics.occupation}`}
          />
          <Row
            k="Income / Edu"
            v={`${result.demographics.income_band} / ${result.demographics.education}`}
          />
          <Row
            k="Establishment"
            v={result.establishment ? `${result.establishment.name} (${result.establishment.id})` : '—'}
          />
          <div className="pt-2 text-neutral-300 leading-relaxed border-t border-neutral-800">
            {result.card_text}
          </div>

          {editOpen && (
            <div className="mt-2 p-2 border border-neutral-700 rounded bg-neutral-950/60 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <FieldInput label="Age" value={String(editAge)} onChange={(v) => setEditAge(parseInt(v || '0', 10) || 0)} />
                <FieldInput label="Gender" value={editGender} onChange={setEditGender} />
                <FieldInput label="Education" value={editEducation} onChange={setEditEducation} />
                <FieldInput label="Income Band" value={editIncomeBand} onChange={setEditIncomeBand} />
                <FieldInput label="Occupation" value={editOccupation} onChange={setEditOccupation} />
                <FieldInput label="Household Role" value={editHouseholdRole} onChange={setEditHouseholdRole} />
                <FieldInput label="Household ID" value={editHouseholdId} onChange={setEditHouseholdId} />
                <FieldInput label="Mode" value={editMode} onChange={setEditMode} />
                <FieldInput label="Employer ID" value={editEmployerId} onChange={setEditEmployerId} />
                <FieldInput label="Home Cell (x,y)" value={editHomeCell} onChange={setEditHomeCell} />
                <FieldInput label="Work Cell (x,y)" value={editWorkCell} onChange={setEditWorkCell} />
                <FieldInput label="ENS Status" value={editEnsStatus} onChange={setEditEnsStatus} />
                <FieldInput label="Wallet Address" value={editWalletAddress} onChange={setEditWalletAddress} />
                <FieldInput label="AXL Key" value={editAxlKey} onChange={setEditAxlKey} />
              </div>
              <div>
                <div className="text-[11px] text-neutral-400 mb-1">Persona Card</div>
                <textarea
                  rows={4}
                  value={editCardText}
                  onChange={(e) => setEditCardText(e.target.value)}
                  className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-xs outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <div className="text-[11px] text-neutral-400 mb-1">Prefs (JSON)</div>
                <textarea
                  rows={5}
                  value={editPrefsJson}
                  onChange={(e) => setEditPrefsJson(e.target.value)}
                  className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-xs font-mono outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <div className="text-[11px] text-neutral-400 mb-1">Needs (JSON)</div>
                <textarea
                  rows={5}
                  value={editNeedsJson}
                  onChange={(e) => setEditNeedsJson(e.target.value)}
                  className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-xs font-mono outline-none focus:border-amber-400"
                />
              </div>
              <button
                type="button"
                onClick={onSavePersona}
                disabled={saving}
                className="px-3 py-1.5 rounded bg-emerald-500 text-black font-semibold disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Persona'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FieldInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <div className="text-[11px] text-neutral-400 mb-1">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-xs outline-none focus:border-amber-400"
      />
    </label>
  );
}

function Row({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2 border-b border-neutral-800/70 pb-1">
      <div className="w-24 shrink-0 text-neutral-400">{k}</div>
      <div className={mono ? 'font-mono break-all' : 'break-words'}>{v}</div>
    </div>
  );
}

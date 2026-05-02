import { useState } from 'react';

import { fetchAgentByEns } from '../lib/api';
import type { EnsAgentLookup } from '../lib/types';

export function EnsLookupPanel() {
  const [ens, setEns] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnsAgentLookup | null>(null);

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
      }
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="absolute top-14 left-3 z-20 w-[26rem] max-w-[calc(100vw-1.5rem)] bg-neutral-900/95 border border-neutral-800 rounded-lg p-3 text-xs text-neutral-100 shadow-xl">
      <div className="text-[11px] uppercase tracking-wide text-neutral-400 mb-2">ENS Lookup</div>
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
          <Row k="Agent" v={result.agent_id} />
          <Row k="ENS" v={result.ens_name ?? '—'} mono />
          <Row k="ENS status" v={result.ens_status} />
          <Row k="Wallet" v={result.wallet_address ?? '—'} mono />
          <Row k="AXL key" v={result.axl_key ?? '—'} mono />
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
        </div>
      )}
    </section>
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

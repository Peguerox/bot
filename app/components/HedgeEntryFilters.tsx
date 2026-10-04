"use client";

import { useState } from "react";
import { DEFAULT_HEDGE_ENTRY_FILTERS, HedgeEntryFilters as Settings, validateHedgeEntryFilters } from "@/lib/hedge-entry-filters";

export default function HedgeEntryFilters({ settings, reading, onSaved }: {
  settings: Partial<Settings> | null | undefined;
  reading: any;
  onSaved: () => void | Promise<void>;
}) {
  const current = { ...DEFAULT_HEDGE_ENTRY_FILTERS, ...settings };
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const anyOn = current.stochasticEnabled || current.zscoreEnabled;
  const fresh = reading?.checked_at != null && Date.now() / 1000 - reading.checked_at >= 0 && Date.now() / 1000 - reading.checked_at <= 90;
  const matches = reading?.config && Object.keys(current).every((k) => reading.config[k] === current[k as keyof Settings]);
  async function save(patch: Partial<Settings>, applyDraft = true) {
    setError("");
    try {
      const next = { ...current, ...patch };
      for (const [key, value] of Object.entries(applyDraft ? draft : {})) {
        if (value.trim()) Object.assign(next, { [key]: Number(value) });
      }
      validateHedgeEntryFilters(next);
      setSaving(true);
      const response = await fetch("/api/lighter-hedge-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryFilters: next }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save entry filters.");
      if (applyDraft) setDraft({});
      await onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  function field(key: keyof Settings, label: string) {
    return <label className="flex-1 min-w-0">
      <span className="text-gray-500 text-[9px] uppercase">{label} · {String(current[key])}</span>
      <input aria-label={label} value={draft[key] ?? ""} placeholder={String(current[key])}
        inputMode="decimal" disabled={saving}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500" />
    </label>;
  }
  return <div className="bg-gray-800/60 rounded-lg p-2 col-span-2 space-y-2">
    <div className="flex justify-between items-baseline gap-2">
      <p className="text-gray-500 text-[10px] uppercase">Entry filters · both legs</p>
      <span className={`text-[10px] font-bold ${!anyOn ? "text-gray-400" : !fresh || !matches ? "text-gray-500" : reading.allowed ? "text-green-400" : "text-red-400"}`}>
        {!anyOn ? "Both OFF · no signal filter" : !fresh || !matches ? "Updating…" : reading.allowed ? "Signals OK" : "Waiting for signals"}
      </span>
    </div>
    {(["stochastic", "zscore"] as const).map((kind) => {
      const stoch = kind === "stochastic";
      const enabledKey = stoch ? "stochasticEnabled" : "zscoreEnabled";
      const on = current[enabledKey];
      const value = stoch ? reading?.stochastic : reading?.zscore;
      const pass = stoch ? reading?.stochastic_allowed : reading?.zscore_allowed;
      return <div key={kind} className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-300">{stoch ? "Stochastic K" : "Z-score"}
            <span className={`ml-2 tabular-nums ${!on || !fresh || !matches ? "text-gray-500" : pass ? "text-green-400" : "text-red-400"}`}>
              {fresh && matches && value != null ? value.toFixed(2) : "—"}
            </span>
          </p>
          <button onClick={() => save({ [enabledKey]: !on }, false)} disabled={saving}
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${on ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"}`}>
            {on ? "ON" : "OFF"}
          </button>
        </div>
        <div className="flex gap-2">
          {field(stoch ? "stochasticWindow" : "zscoreWindow", stoch ? "Stoch minutes" : "Z minutes")}
          {field(stoch ? "stochasticLow" : "zscoreLow", stoch ? "Stoch low" : "Z low")}
          {field(stoch ? "stochasticHigh" : "zscoreHigh", stoch ? "Stoch high" : "Z high")}
        </div>
      </div>;
    })}
    <div className="flex justify-between items-center gap-2">
      <p className="text-gray-500 text-[10px]">Below Low or above High passes. Both ON need both signals. Closed 1-minute candles.</p>
      <button onClick={() => save({})} disabled={saving || !Object.values(draft).some((v) => v.trim())}
        className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 disabled:opacity-30">{saving ? "…" : "Set"}</button>
    </div>
    {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}
  </div>;
}

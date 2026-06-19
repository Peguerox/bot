"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getSupabase } from "@/lib/supabase";

type Signal = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
type Trade  = { id: string; side: "BUY" | "SELL"; price: number; qty: number; signal: string; pnl_pct?: number; created_at: string };
type Run    = { id: string; run_at: string; data: { actions: any[] } };

type SrcKey = "overall" | "ma" | "osc";
type SignalConfig = {
  sources: SrcKey[];
  combo:   "any" | "all";
  buy:     Partial<Record<SrcKey, "buy" | "strong">>;
  sell:    Partial<Record<SrcKey, "sell" | "strong">>;
};

const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  sources: ["overall"],
  combo:   "all",
  buy:     { overall: "buy" },
  sell:    { overall: "sell" },
};

const SOURCE_LIST: { key: SrcKey; label: string }[] = [
  { key: "overall", label: "Overall" },
  { key: "ma",      label: "MA" },
  { key: "osc",     label: "Oscillators" },
];

const TF_OPTIONS = ["1", "5", "15", "60", "240", "1D", "1W"];
const TF_LABELS: Record<string, string> = {
  "1": "1m", "5": "5m", "15": "15m", "60": "1h", "240": "4h", "1D": "1D", "1W": "1W",
};

const SIGNAL_META: Record<Signal, { label: string; color: string; bg: string }> = {
  STRONG_BUY:  { label: "▲▲ Strong Buy",  color: "text-emerald-400", bg: "bg-emerald-500/15" },
  BUY:         { label: "▲  Buy",          color: "text-green-400",   bg: "bg-green-500/15"   },
  NEUTRAL:     { label: "─  Neutral",      color: "text-gray-400",    bg: "bg-gray-700/40"    },
  SELL:        { label: "▼  Sell",         color: "text-red-400",     bg: "bg-red-500/15"     },
  STRONG_SELL: { label: "▼▼ Strong Sell",  color: "text-rose-500",    bg: "bg-rose-500/15"    },
};

function toSignal(val: number | null): Signal {
  if (val == null) return "NEUTRAL";
  if (val >= 0.5)  return "STRONG_BUY";
  if (val >= 0.1)  return "BUY";
  if (val > -0.1)  return "NEUTRAL";
  if (val > -0.5)  return "SELL";
  return "STRONG_SELL";
}

function fmtPrice(p: number | null | undefined): string {
  const n = Number(p);
  if (!n || isNaN(n)) return "—";
  if (n >= 1000)   return `$${n.toFixed(2)}`;
  if (n >= 1)      return `$${n.toFixed(4)}`;
  if (n >= 0.01)   return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(8)}`;
}

function coinFromSymbol(sym: string): string {
  return sym.replace(/USDT$/, "").replace(/USD$/, "").replace(/BTC$/, "").replace(/ETH$/, "");
}

function SignalBadge({ signal }: { signal: string }) {
  const m = SIGNAL_META[signal as Signal] ?? SIGNAL_META.NEUTRAL;
  return (
    <span className={`inline-block font-semibold px-2 py-0.5 rounded text-xs whitespace-nowrap ${m.color} ${m.bg}`}>
      {m.label}
    </span>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="bg-gray-800/60 rounded-lg p-3">
      <p className="text-gray-500 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color}`}>{value}</p>
      <p className="text-gray-600 text-xs mt-0.5">{sub}</p>
    </div>
  );
}

interface BotState {
  enabled:       boolean;
  mode:          "paper" | "live";
  exchange:      string;
  symbol:        string;
  timeframe:     string;
  capital:       number;
  pos:           "flat" | "long";
  usdt:          number;
  sol_qty:       number;
  entry_price:   number;
  entry_signal:  string;
  round_trips:   number;
  wins:          number;
  peak:          number;
  max_dd:        number;
  signal_config: SignalConfig | null;
}

function formatRunAction(a: any): { text: string; color: string } {
  if (a.action === "CHECK") return {
    text:  `WATCH  signal=${a.signal}  price=${fmtPrice(a.price)}`,
    color: "text-gray-500",
  };
  if (a.action === "BUY") return {
    text:  `BUY  qty=${Number(a.qty).toFixed(2)}  @${fmtPrice(a.price)}  [${a.signal}]`,
    color: "text-green-400",
  };
  if (a.action === "SELL") return {
    text:  `SELL  @${fmtPrice(a.price)}  pnl=${Number(a.pnlPct).toFixed(3)}%  [${a.signal}]`,
    color: "text-red-400",
  };
  if (a.action === "ERROR") return { text: `ERROR (${a.stage}): ${a.error}`, color: "text-red-500" };
  return { text: JSON.stringify(a), color: "text-gray-600" };
}

export default function TvSignalPanel({ id }: { id: number }) {
  const [state,     setState]     = useState<BotState | null>(null);
  const [trades,    setTrades]    = useState<Trade[]>([]);
  const [runs,      setRuns]      = useState<Run[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [toggling,  setToggling]  = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [resetting, setResetting] = useState(false);

  const [raw,      setRaw]      = useState<number | null>(null);
  const [ma,       setMa]       = useState<number | null>(null);
  const [osc,      setOsc]      = useState<number | null>(null);
  const [price,    setPrice]    = useState<number | null>(null);
  const [lastPoll, setLastPoll] = useState<string | null>(null);
  const [polling,  setPolling]  = useState(false);

  const [exchange,     setExchange]     = useState("BINANCEUS");
  const [symbol,       setSymbol]       = useState("SOLUSD");
  const [timeframe,    setTimeframe]    = useState("60");
  const [capital,      setCapital]      = useState(1000);
  const [signalConfig, setSignalConfig] = useState<SignalConfig>(DEFAULT_SIGNAL_CONFIG);

  const configRef     = useRef({ exchange, symbol, timeframe });
  const initialLoaded = useRef(false);

  function clearSignal() {
    setRaw(null); setMa(null); setOsc(null); setPrice(null); setLastPoll(null);
  }

  function toggleSource(src: SrcKey) {
    setSignalConfig(prev => {
      const next = prev.sources.includes(src)
        ? prev.sources.filter(s => s !== src)
        : [...prev.sources, src];
      if (next.length === 0) return prev;
      return { ...prev, sources: next };
    });
  }

  function setThreshold(dir: "buy" | "sell", src: SrcKey, val: string) {
    setSignalConfig(prev => ({ ...prev, [dir]: { ...prev[dir], [src]: val } }));
  }

  async function load() {
    const sb = getSupabase();
    const [{ data: st }, { data: tr }, { data: ru }] = await Promise.all([
      sb.from("tv_bot_state").select("*").eq("id", id).single(),
      sb.from("tv_bot_trades").select("*").eq("bot_id", id).order("created_at", { ascending: false }).limit(50),
      sb.from("tv_bot_runs").select("*").eq("bot_id", id).order("run_at", { ascending: false }).limit(120),
    ]);
    if (st) {
      setState(st as BotState);
      if (!initialLoaded.current) {
        setExchange(st.exchange);
        setSymbol(st.symbol);
        setTimeframe(st.timeframe);
        setCapital(Number(st.capital));
        setSignalConfig(st.signal_config ?? DEFAULT_SIGNAL_CONFIG);
        configRef.current = { exchange: st.exchange, symbol: st.symbol, timeframe: st.timeframe };
        initialLoaded.current = true;
      }
    }
    setTrades((tr ?? []) as Trade[]);
    setRuns((ru ?? []) as Run[]);
    setLoading(false);
  }

  const poll = useCallback(async () => {
    const { exchange: ex, symbol: sym, timeframe: tf } = configRef.current;
    setPolling(true);
    try {
      const res  = await fetch(`/api/tv-signal?exchange=${ex}&symbol=${sym}&timeframe=${tf}`);
      const data = await res.json();
      setRaw(data.raw); setMa(data.ma); setOsc(data.osc); setPrice(data.price);
      setLastPoll(new Date().toLocaleTimeString());
    } catch (e) {
      console.error("tv-signal poll:", e);
    }
    setPolling(false);
  }, []);

  useEffect(() => {
    let active = true;
    load().then(() => { if (active) poll(); });
    const timer = setInterval(poll, 60_000);
    const sb = getSupabase();
    const ch = sb.channel(`tv-bot-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tv_bot_state",  filter: `id=eq.${id}` },     load)
      .on("postgres_changes", { event: "*", schema: "public", table: "tv_bot_trades", filter: `bot_id=eq.${id}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "tv_bot_runs",   filter: `bot_id=eq.${id}` }, load)
      .subscribe();
    return () => { active = false; clearInterval(timer); sb.removeChannel(ch); };
  }, [id, poll]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    configRef.current = { exchange, symbol, timeframe };
  }, [exchange, symbol, timeframe]);

  async function handleToggle() {
    setToggling(true);
    await fetch("/api/tv-bot/toggle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await load();
    setToggling(false);
  }

  async function handleReset() {
    if (!confirm("Reset all paper trading progress for this bot?")) return;
    setResetting(true);
    await fetch("/api/tv-bot/reset", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    clearSignal();
    await load();
    setResetting(false);
  }

  async function handleSaveConfig() {
    setSaving(true);
    clearSignal();
    await fetch("/api/tv-bot/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, exchange, symbol, timeframe, capital, signal_config: signalConfig }),
    });
    configRef.current = { exchange, symbol, timeframe };
    await load();
    poll();
    setSaving(false);
  }

  if (loading || !state) {
    return (
      <div className="bg-gray-900 rounded-xl p-5 animate-pulse space-y-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-gray-800 rounded-lg" />)}
      </div>
    );
  }

  const signal  = toSignal(raw);
  const coin    = coinFromSymbol(state.symbol);
  const solQty  = Number(state.sol_qty);
  const entryP  = Number(state.entry_price);
  const equity  = state.pos === "long" && price ? solQty * price : Number(state.usdt);
  const pnlPct  = (equity / Number(state.capital) - 1) * 100;
  const unreal  = state.pos === "long" && price && entryP ? (price / entryP - 1) * 100 : 0;
  const winRate = Number(state.round_trips) > 0 ? (Number(state.wins) / Number(state.round_trips) * 100).toFixed(1) : "—";

  const activeCfg    = state.signal_config ?? DEFAULT_SIGNAL_CONFIG;
  const srcLabel     = activeCfg.sources.map(s => SOURCE_LIST.find(x => x.key === s)?.label ?? s).join(" + ");
  const comboLabel   = activeCfg.sources.length > 1 ? ` (${activeCfg.combo === "all" ? "all agree" : "any"})` : "";
  const waitingLabel = activeCfg.sources.length === 1
    ? (activeCfg.buy[activeCfg.sources[0]] === "strong" ? "Strong Buy" : "Buy signal")
    : `${activeCfg.combo === "all" ? "all sources agree" : "any source"}`;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">

      {/* Header */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">TV Signal {id}</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">PAPER</span>
            {polling && <span className="text-xs text-gray-600 animate-pulse">fetching…</span>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleReset}
              disabled={resetting || state.enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={state.enabled ? "Pause bot before resetting" : "Reset all trades and portfolio"}
            >
              {resetting ? "Resetting…" : "Reset"}
            </button>
            <button
              onClick={handleToggle}
              disabled={toggling}
              className={`flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                state.enabled
                  ? "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${state.enabled ? "bg-yellow-400" : "bg-gray-600"}`} />
              {toggling ? "…" : state.enabled ? "Running" : "Start"}
            </button>
          </div>
        </div>
        <p className="text-gray-500 text-xs">
          {exchange}:{symbol} · {TF_LABELS[timeframe] ?? timeframe} · {srcLabel}{comboLabel}
          {lastPoll && <span className="ml-2 text-gray-600">polled {lastPoll}</span>}
        </p>
      </div>

      {/* Config */}
      {!state.enabled && (
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-3">
          <p className="text-gray-500 text-xs uppercase tracking-wide">Configuration</p>

          {/* Exchange / Symbol / Timeframe / Capital */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-gray-500 text-xs">Exchange</label>
              <select
                value={exchange}
                onChange={e => setExchange(e.target.value)}
                className="bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600"
              >
                <option value="BINANCEUS">Binance US</option>
                <option value="BINANCE">Binance Global</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-gray-500 text-xs">Symbol</label>
              <input
                value={symbol}
                onChange={e => { setSymbol(e.target.value.toUpperCase()); clearSignal(); }}
                className="bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600 font-mono"
                placeholder="e.g. PEPEUSDT"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-gray-500 text-xs">Timeframe</label>
              <select
                value={timeframe}
                onChange={e => setTimeframe(e.target.value)}
                className="bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600"
              >
                {TF_OPTIONS.map(tf => <option key={tf} value={tf}>{TF_LABELS[tf]}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-gray-500 text-xs">Capital (USDT)</label>
              <input
                type="number"
                value={capital}
                onChange={e => setCapital(Math.max(1, parseFloat(e.target.value) || 1000))}
                className="bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600"
              />
            </div>
          </div>

          {/* Signal Sources */}
          <div className="space-y-2 pt-1 border-t border-gray-700/50">
            <div className="flex items-center justify-between">
              <p className="text-gray-500 text-xs uppercase tracking-wide">Signal Sources</p>
              <div className="flex gap-1 text-gray-600 text-xs pr-0.5">
                <span className="w-[5.5rem] text-center">Enter on</span>
                <span className="w-[5.5rem] text-center">Exit on</span>
              </div>
            </div>
            {SOURCE_LIST.map(({ key, label }) => {
              const enabled = signalConfig.sources.includes(key);
              return (
                <div key={key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`src-${id}-${key}`}
                    checked={enabled}
                    onChange={() => toggleSource(key)}
                    className="accent-blue-500 cursor-pointer shrink-0"
                  />
                  <label htmlFor={`src-${id}-${key}`} className="text-gray-400 text-xs w-20 cursor-pointer shrink-0">
                    {label}
                  </label>
                  {enabled ? (
                    <div className="flex gap-1 flex-1">
                      <select
                        value={signalConfig.buy[key] ?? "buy"}
                        onChange={e => setThreshold("buy", key, e.target.value)}
                        className="bg-gray-700 text-white text-xs rounded px-1 py-1 border border-gray-600 flex-1 min-w-0"
                      >
                        <option value="buy">Buy or Strong</option>
                        <option value="strong">Strong only</option>
                      </select>
                      <select
                        value={signalConfig.sell[key] ?? "sell"}
                        onChange={e => setThreshold("sell", key, e.target.value)}
                        className="bg-gray-700 text-white text-xs rounded px-1 py-1 border border-gray-600 flex-1 min-w-0"
                      >
                        <option value="sell">Sell or Strong</option>
                        <option value="strong">Strong only</option>
                      </select>
                    </div>
                  ) : (
                    <span className="text-gray-700 text-xs">off</span>
                  )}
                </div>
              );
            })}
            {signalConfig.sources.length > 1 && (
              <div className="flex items-center gap-2 pt-1.5 border-t border-gray-700/40">
                <span className="text-gray-500 text-xs w-20 shrink-0">Combo rule</span>
                <select
                  value={signalConfig.combo}
                  onChange={e => setSignalConfig(prev => ({ ...prev, combo: e.target.value as "any" | "all" }))}
                  className="bg-gray-700 text-white text-xs rounded px-2 py-1 border border-gray-600 flex-1"
                >
                  <option value="all">All must agree</option>
                  <option value="any">Any signal triggers</option>
                </select>
              </div>
            )}
          </div>

          <button
            onClick={handleSaveConfig}
            disabled={saving}
            className="w-full text-xs font-semibold py-1.5 rounded-md bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-all disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Config"}
          </button>
        </div>
      )}

      {/* Signal */}
      <div className="space-y-2">
        <p className="text-gray-500 text-xs uppercase tracking-wide">TradingView Signal</p>
        <div className="bg-gray-800/50 rounded-lg divide-y divide-gray-700/50">
          {([["Overall", signal, raw], ["MA", toSignal(ma), ma], ["Oscillators", toSignal(osc), osc]] as [string, Signal, number | null][]).map(([label, sig, val]) => (
            <div key={label} className="flex items-center justify-between px-3 py-2">
              <span className="text-gray-500 text-xs w-20 shrink-0">{label}</span>
              <SignalBadge signal={sig} />
              <span className="text-gray-600 text-xs font-mono w-14 text-right shrink-0">
                {val != null ? `${val >= 0 ? "+" : ""}${val.toFixed(3)}` : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Equity"
          value={`$${equity.toFixed(2)}`}
          sub={`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}% vs $${Number(state.capital)}`}
          color={pnlPct >= 0 ? "text-green-400" : "text-red-400"}
        />
        <Stat
          label="Win Rate"
          value={winRate === "—" ? "—" : `${winRate}%`}
          sub={`${Number(state.wins)}W / ${Number(state.round_trips) - Number(state.wins)}L · maxDD ${Number(state.max_dd).toFixed(2)}%`}
          color="text-blue-400"
        />
      </div>

      {/* Position */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Position</p>
        {state.pos === "long" ? (
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">{coin} held</span>
              <span className="text-white font-mono">{solQty.toFixed(2)} {coin}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Entry price</span>
              <span className="text-white font-mono">{fmtPrice(entryP)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Entry signal</span>
              <SignalBadge signal={state.entry_signal} />
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Current</span>
              <span className="text-white font-mono">{fmtPrice(price)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Unrealized P&L</span>
              <span className={`font-mono font-bold ${unreal >= 0 ? "text-green-400" : "text-red-400"}`}>
                {unreal >= 0 ? "+" : ""}{unreal.toFixed(3)}%
              </span>
            </div>
          </div>
        ) : (
          <div className="bg-gray-800/30 rounded-lg p-3 text-center">
            <p className="text-gray-500 text-sm">
              {state.enabled ? `flat — waiting for ${waitingLabel}` : "not started"}
            </p>
          </div>
        )}
      </div>

      {/* Trade Log */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Trade Log
          {trades.length > 0 && <span className="ml-1 text-gray-600">({trades.length})</span>}
        </p>
        {trades.length === 0 ? (
          <p className="text-gray-600 text-sm">{state.enabled ? "Waiting for signal…" : "Press Start to begin paper trading"}</p>
        ) : (
          <div className="overflow-auto max-h-52">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left pb-1">Time</th>
                  <th className="text-left pb-1">Side</th>
                  <th className="text-right pb-1">Price</th>
                  <th className="text-right pb-1">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {trades.map(t => (
                  <tr key={t.id} className="hover:bg-gray-800/30">
                    <td className="py-1.5 text-gray-500">{new Date(t.created_at).toLocaleTimeString()}</td>
                    <td className={`py-1.5 font-bold ${t.side === "BUY" ? "text-green-400" : "text-red-400"}`}>
                      {t.side}
                      <span className={`ml-1 text-xs font-normal ${SIGNAL_META[t.signal as Signal]?.color ?? "text-gray-500"}`}>
                        [{SIGNAL_META[t.signal as Signal]?.label.trim() ?? t.signal}]
                      </span>
                    </td>
                    <td className="py-1.5 text-right text-gray-300">{fmtPrice(Number(t.price))}</td>
                    <td className={`py-1.5 text-right ${t.pnl_pct == null ? "text-gray-600" : Number(t.pnl_pct) >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {t.pnl_pct != null ? `${Number(t.pnl_pct) >= 0 ? "+" : ""}${Number(t.pnl_pct).toFixed(3)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Activity */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-40 overflow-y-auto space-y-0.5 font-mono text-xs pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map(r => {
            const actions: any[] = r.data?.actions ?? [];
            const time = new Date(r.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
            return (
              <div key={r.id} className="flex gap-2 items-start">
                <span className="text-gray-600 shrink-0">{time}</span>
                <div className="flex flex-col">
                  {actions.map((a, i) => {
                    const { text, color } = formatRunAction(a);
                    return <span key={i} className={color}>{text}</span>;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

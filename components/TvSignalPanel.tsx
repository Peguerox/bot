"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type Signal = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
type Trade  = { time: string; side: "BUY" | "SELL"; price: number; qty: number; signal: Signal; pnlPct?: number };

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
  if (val >=  0.5) return "STRONG_BUY";
  if (val >=  0.1) return "BUY";
  if (val >  -0.1) return "NEUTRAL";
  if (val >  -0.5) return "SELL";
  return "STRONG_SELL";
}

function SignalBadge({ signal }: { signal: Signal }) {
  const m = SIGNAL_META[signal];
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
  pos:        "flat" | "long";
  usdt:       number;
  solQty:     number;
  entryPrice: number;
  entrySignal: Signal;
  roundTrips: number;
  wins:       number;
  peak:       number;
  maxDD:      number;
  tradeLog:   Trade[];
}

export default function TvSignalPanel() {
  // ── Config ──────────────────────────────────────────────────────────────
  const [exchange,  setExchange]  = useState("BINANCEUS");
  const [symbol,    setSymbol]    = useState("SOLUSD");
  const [timeframe, setTimeframe] = useState("60");
  const [buyOn,     setBuyOn]     = useState<"buy" | "strong">("buy");
  const [sellOn,    setSellOn]    = useState<"sell" | "strong">("sell");
  const [capital,   setCapital]   = useState(1000);

  // ── UI state ─────────────────────────────────────────────────────────────
  const [running,  setRunning]  = useState(false);
  const [raw,      setRaw]      = useState<number | null>(null);
  const [ma,       setMa]       = useState<number | null>(null);
  const [osc,      setOsc]      = useState<number | null>(null);
  const [price,    setPrice]    = useState<number | null>(null);
  const [lastPoll, setLastPoll] = useState<string | null>(null);
  const [polling,  setPolling]  = useState(false);
  const [bot,      setBot]      = useState<BotState>({
    pos: "flat", usdt: capital, solQty: 0, entryPrice: 0,
    entrySignal: "NEUTRAL", roundTrips: 0, wins: 0, peak: capital, maxDD: 0, tradeLog: [],
  });

  // Mutable refs for interval callbacks (avoid stale closures)
  const runningRef  = useRef(false);
  const buyOnRef    = useRef(buyOn);
  const sellOnRef   = useRef(sellOn);
  const configRef   = useRef({ exchange, symbol, timeframe });
  const botRef      = useRef(bot);

  useEffect(() => { runningRef.current  = running; },  [running]);
  useEffect(() => { buyOnRef.current    = buyOn; },    [buyOn]);
  useEffect(() => { sellOnRef.current   = sellOn; },   [sellOn]);
  useEffect(() => { configRef.current   = { exchange, symbol, timeframe }; }, [exchange, symbol, timeframe]);
  useEffect(() => { botRef.current      = bot; },      [bot]);

  const isBuy  = (s: Signal) => buyOnRef.current  === "strong" ? s === "STRONG_BUY"  : s === "STRONG_BUY"  || s === "BUY";
  const isSell = (s: Signal) => sellOnRef.current === "strong" ? s === "STRONG_SELL" : s === "STRONG_SELL" || s === "SELL";

  const poll = useCallback(async () => {
    const { exchange: ex, symbol: sym, timeframe: tf } = configRef.current;
    setPolling(true);
    try {
      const res  = await fetch(`/api/tv-signal?exchange=${ex}&symbol=${sym}&timeframe=${tf}`);
      const data = await res.json();
      const { raw: r, ma: m, osc: o, price: p } = data;
      setRaw(r); setMa(m); setOsc(o); setPrice(p);
      setLastPoll(new Date().toLocaleTimeString());

      if (!runningRef.current || !p) return;

      const signal = toSignal(r);
      const state  = botRef.current;
      const now    = new Date().toLocaleTimeString();

      if (state.pos === "flat" && isBuy(signal)) {
        const qty = state.usdt / p;
        const next: BotState = {
          ...state, pos: "long", usdt: 0, solQty: qty,
          entryPrice: p, entrySignal: signal,
          tradeLog: [{ time: now, side: "BUY" as const, price: p, qty, signal }, ...state.tradeLog].slice(0, 50),
        };
        botRef.current = next;
        setBot(next);
      } else if (state.pos === "long" && isSell(signal)) {
        const out    = state.solQty * p;
        const pnlPct = (out / (state.entryPrice * state.solQty) - 1) * 100;
        const isWin  = pnlPct > 0;
        const newRoundTrips = state.roundTrips + 1;
        const newWins       = state.wins + (isWin ? 1 : 0);
        const newPeak       = Math.max(state.peak, out);
        const dd            = (newPeak - out) / newPeak * 100;
        const newMaxDD      = Math.max(state.maxDD, dd);
        const next: BotState = {
          ...state, pos: "flat", usdt: out, solQty: 0,
          roundTrips: newRoundTrips, wins: newWins, peak: newPeak, maxDD: newMaxDD,
          tradeLog: [{ time: now, side: "SELL" as const, price: p, qty: state.solQty, signal, pnlPct }, ...state.tradeLog].slice(0, 50),
        };
        botRef.current = next;
        setBot(next);
      }
    } catch (e) {
      console.error("tv-signal poll:", e);
    }
    setPolling(false);
  }, []);

  // Always poll every 60s (for signal display). Trading logic fires only when running.
  useEffect(() => {
    poll();
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, [exchange, symbol, timeframe, poll]);

  function handleStart() {
    const initialState: BotState = {
      pos: "flat", usdt: capital, solQty: 0, entryPrice: 0,
      entrySignal: "NEUTRAL", roundTrips: 0, wins: 0, peak: capital, maxDD: 0, tradeLog: [],
    };
    botRef.current = initialState;
    setBot(initialState);
    runningRef.current = true;
    setRunning(true);
    poll();
  }

  function handlePause() {
    runningRef.current = false;
    setRunning(false);
  }

  function handleReset() {
    if (!confirm("Reset all paper trading progress?")) return;
    handlePause();
    const fresh: BotState = {
      pos: "flat", usdt: capital, solQty: 0, entryPrice: 0,
      entrySignal: "NEUTRAL", roundTrips: 0, wins: 0, peak: capital, maxDD: 0, tradeLog: [],
    };
    botRef.current = fresh;
    setBot(fresh);
  }

  // ── Derived display values ───────────────────────────────────────────────
  const signal   = toSignal(raw);
  const equity   = bot.pos === "long" && price ? bot.solQty * price : bot.usdt;
  const pnlPct   = (equity / capital - 1) * 100;
  const unreal   = bot.pos === "long" && price && bot.entryPrice ? (price / bot.entryPrice - 1) * 100 : 0;
  const winRate  = bot.roundTrips > 0 ? (bot.wins / bot.roundTrips * 100).toFixed(1) : "—";
  const buyLabel  = buyOn  === "strong" ? "Strong Buy only"  : "Buy or Strong Buy";
  const sellLabel = sellOn === "strong" ? "Strong Sell only" : "Sell or Strong Sell";

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">TV Signal</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">PAPER</span>
            {polling && <span className="text-xs text-gray-600 animate-pulse">fetching…</span>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleReset}
              disabled={running}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Reset
            </button>
            {running ? (
              <button onClick={handlePause} className="flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-md bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-all">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
                Running
              </button>
            ) : (
              <button onClick={handleStart} className="flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
                Start
              </button>
            )}
          </div>
        </div>
        <p className="text-gray-500 text-xs">
          {exchange}:{symbol} · {TF_LABELS[timeframe] ?? timeframe} · {buyLabel} → {sellLabel}
          {lastPoll && <span className="ml-2 text-gray-600">polled {lastPoll}</span>}
        </p>
      </div>

      {/* ── Config (only when stopped) ───────────────────────────────────── */}
      {!running && (
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-3">
          <p className="text-gray-500 text-xs uppercase tracking-wide">Configuration</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-gray-500 text-xs">Exchange</label>
              <select
                value={exchange}
                onChange={e => {
                  const ex = e.target.value;
                  setExchange(ex);
                  setSymbol(ex === "BINANCE" ? "SOLUSDT" : "SOLUSD");
                }}
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
                onChange={e => setSymbol(e.target.value.toUpperCase())}
                className="bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600 font-mono"
                placeholder="SOLUSD"
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
            <div className="flex flex-col gap-1">
              <label className="text-gray-500 text-xs">Enter on</label>
              <select
                value={buyOn}
                onChange={e => setBuyOn(e.target.value as "buy" | "strong")}
                className="bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600"
              >
                <option value="buy">Buy or Strong Buy</option>
                <option value="strong">Strong Buy only</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-gray-500 text-xs">Exit on</label>
              <select
                value={sellOn}
                onChange={e => setSellOn(e.target.value as "sell" | "strong")}
                className="bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600"
              >
                <option value="sell">Sell or Strong Sell</option>
                <option value="strong">Strong Sell only</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* ── Signal ──────────────────────────────────────────────────────── */}
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

      {/* ── Stats ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Equity"
          value={`$${equity.toFixed(2)}`}
          sub={`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}% vs $${capital}`}
          color={pnlPct >= 0 ? "text-green-400" : "text-red-400"}
        />
        <Stat
          label="Win Rate"
          value={winRate === "—" ? "—" : `${winRate}%`}
          sub={`${bot.wins}W / ${bot.roundTrips - bot.wins}L · maxDD ${bot.maxDD.toFixed(2)}%`}
          color="text-blue-400"
        />
      </div>

      {/* ── Position ────────────────────────────────────────────────────── */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Position</p>
        {bot.pos === "long" ? (
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">SOL held</span>
              <span className="text-white font-mono">{bot.solQty.toFixed(4)} SOL</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Entry price</span>
              <span className="text-white font-mono">${bot.entryPrice.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Entry signal</span>
              <SignalBadge signal={bot.entrySignal} />
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Current</span>
              <span className="text-white font-mono">${price?.toFixed(2) ?? "—"}</span>
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
              {running ? `flat — waiting for ${buyLabel}` : "not started"}
            </p>
          </div>
        )}
      </div>

      {/* ── Trade Log ───────────────────────────────────────────────────── */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Trade Log
          {bot.tradeLog.length > 0 && <span className="ml-1 text-gray-600">({bot.tradeLog.length})</span>}
        </p>
        {bot.tradeLog.length === 0 ? (
          <p className="text-gray-600 text-sm">{running ? "Waiting for signal…" : "Press Start to begin paper trading"}</p>
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
                {bot.tradeLog.map((t, i) => (
                  <tr key={i} className="hover:bg-gray-800/30">
                    <td className="py-1.5 text-gray-500">{t.time}</td>
                    <td className={`py-1.5 font-bold ${t.side === "BUY" ? "text-green-400" : "text-red-400"}`}>
                      {t.side}
                      <span className={`ml-1 text-xs font-normal ${SIGNAL_META[t.signal].color}`}>
                        [{SIGNAL_META[t.signal].label.trim()}]
                      </span>
                    </td>
                    <td className="py-1.5 text-right text-gray-300">${t.price.toFixed(2)}</td>
                    <td className={`py-1.5 text-right ${t.pnlPct == null ? "text-gray-600" : t.pnlPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {t.pnlPct != null ? `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(3)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

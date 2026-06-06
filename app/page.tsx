"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import TradeHistory from "@/components/TradeHistory";
import OpenPositions from "@/components/OpenPositions";

const PAPER_INITIAL = 2000;
const LIVE_INITIAL  = 50;

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="bg-gray-800/60 rounded-lg p-3">
      <p className="text-gray-500 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color}`}>{value}</p>
      <p className="text-gray-600 text-xs mt-0.5">{sub}</p>
    </div>
  );
}

function actionColor(action: string) {
  if (action === "OPEN")         return "text-green-400";
  if (action === "TP")           return "text-green-400";
  if (action === "SL")           return "text-red-400";
  if (action === "CHASE_EXIT")   return "text-yellow-400";
  if (action === "START_CHASE")  return "text-yellow-400";
  if (action === "CHASE_UP")     return "text-yellow-400";
  if (action === "CHASE_HOLD")   return "text-gray-500";
  if (action === "HOLD")         return "text-gray-500";
  if (action === "SKIP_NO_FUNDS") return "text-orange-400";
  if (action === "WATCH")        return "text-gray-500";
  if (action === "ERROR")        return "text-red-400";
  return "text-gray-400";
}

function formatAction(a: any): string {
  if (a.action === "WATCH")        return `WATCH  z=${parseFloat(a.z).toFixed(2)}  $${a.price}`;
  if (a.action === "OPEN")         return `OPEN  entry=$${a.entry}  tp=$${a.tp}  sl=$${a.sl}  z=${parseFloat(a.z).toFixed(2)}`;
  if (a.action === "HOLD")         return `HOLD  [${a.hold}/${6}]  $${a.price}  tp=$${a.tp}  sl=$${a.sl}`;
  if (a.action === "TP")           return `TP HIT  exit=$${a.exit}  pnl=+$${parseFloat(a.pnl).toFixed(2)}`;
  if (a.action === "SL")           return `SL HIT  exit=$${a.exit}  pnl=$${parseFloat(a.pnl).toFixed(2)}`;
  if (a.action === "START_CHASE")  return `CHASE START  price=$${a.price}  floor=$${a.chaseFloor}`;
  if (a.action === "CHASE_UP")     return `CHASE UP  $${a.price}  floor=$${a.newFloor}`;
  if (a.action === "CHASE_HOLD")   return `CHASE HOLD  $${a.price}  floor=$${a.chaseFloor}`;
  if (a.action === "CHASE_EXIT")   return `CHASE EXIT  exit=$${a.exit}  pnl=$${parseFloat(a.pnl).toFixed(2)}`;
  if (a.action === "SKIP_NO_FUNDS") return `NO FUNDS  $${parseFloat(a.balance).toFixed(2)} USDT`;
  if (a.action === "ERROR")        return `ERROR (${a.stage}): ${a.error}`;
  return a.action;
}

// ── Paper bot panel (read-only) ─────────────────────────────────────────────

function PaperPanel({ trades, openPositions, loading }: {
  trades: any[]; openPositions: any[]; loading: boolean;
}) {
  const totalPnL  = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const decided   = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins      = decided.filter(t => t.pnl > 0);
  const losses    = decided.filter(t => t.pnl < 0);
  const winRate   = decided.length > 0 ? (wins.length / decided.length * 100).toFixed(1) : "—";
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf        = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  let peak = PAPER_INITIAL, maxDD = 0, runBal = PAPER_INITIAL;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });
  const balance = PAPER_INITIAL + totalPnL;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Lag Bot</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">PAPER</span>
          </div>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-400 text-xs font-medium">Running</span>
          </span>
        </div>
        <p className="text-gray-500 text-xs">BNB + ATOM · $2,000 · 1m · Z=2.0 · TP 0.8% · SL 0.3%</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Balance"       value={`$${balance.toFixed(2)}`}   sub={`${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} paper PnL`} color={balance >= PAPER_INITIAL ? "text-green-400" : "text-red-400"} />
          <Stat label="Win Rate"      value={`${winRate}%`}              sub={`${wins.length}W / ${losses.length}L of ${decided.length}`}       color="text-blue-400" />
          <Stat label="Profit Factor" value={pf}                         sub={openPositions.length > 0 ? `${openPositions.length} open` : "No open positions"} color="text-purple-400" />
          <Stat label="Max Drawdown"  value={`${maxDD.toFixed(1)}%`}     sub={`${trades.length} total trades`}                                  color={maxDD < -10 ? "text-red-400" : "text-yellow-400"} />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL</p>
        <PnLChart trades={trades} initial={PAPER_INITIAL} />
      </div>
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Open Positions
          {openPositions.length > 0 && <span className="ml-1 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full text-xs">{openPositions.length}</span>}
        </p>
        <OpenPositions positions={openPositions} loading={loading} />
      </div>
      <div className="flex-1">
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        <TradeHistory trades={trades.slice(0, 10)} loading={loading} />
      </div>
    </div>
  );
}

// ── Live bot panel ──────────────────────────────────────────────────────────

function LivePanel({
  trades, openPositions, loading, botUsdt,
  enabled, onToggle, toggling, onReset, resetting,
  onClearHistory, clearingHistory, runs,
}: {
  trades:          any[];
  openPositions:   any[];
  loading:         boolean;
  botUsdt:         number;
  enabled:         boolean;
  onToggle:        () => void;
  toggling:        boolean;
  onReset:         () => void;
  resetting:       boolean;
  onClearHistory:  () => void;
  clearingHistory: boolean;
  runs:            any[];
}) {
  const totalPnL  = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const decided   = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins      = decided.filter(t => t.pnl > 0);
  const losses    = decided.filter(t => t.pnl < 0);
  const winRate   = decided.length > 0 ? (wins.length / decided.length * 100).toFixed(1) : "—";
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf        = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  let peak = LIVE_INITIAL, maxDD = 0, runBal = LIVE_INITIAL;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });
  const balance = LIVE_INITIAL + totalPnL;

  const latestPrice: number | null = (() => {
    const actions: any[] = runs[0]?.data?.actions ?? [];
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].price != null) return parseFloat(actions[i].price);
    }
    return null;
  })();

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      {/* Header */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Lag Bot</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">LIVE</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              title={enabled ? "Pause bot before clearing" : "Delete all closed trades and run logs"}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onReset}
              disabled={resetting || enabled}
              title={enabled ? "Pause bot before selling" : "Market sell all ATOM & clear position"}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {resetting ? "Selling…" : "Sell All"}
            </button>
            <button
              onClick={onToggle}
              disabled={toggling}
              className={`flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                enabled
                  ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-green-400" : "bg-gray-600"}`} />
              {toggling ? "…" : enabled ? "Running" : "Paused"}
            </button>
          </div>
        </div>
        <p className="text-gray-500 text-xs">ATOM/USDT · $50 · 1m · Z=2.0 · TP 0.8% · SL 0.3% · market orders only</p>
      </div>

      {/* Stats */}
      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="PnL"           value={`${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`} sub={`balance $${balance.toFixed(2)}`}              color={totalPnL >= 0 ? "text-green-400" : "text-red-400"} />
          <Stat label="Win Rate"      value={`${winRate}%`}                                        sub={`${wins.length}W / ${losses.length}L of ${decided.length}`} color="text-blue-400" />
          <Stat label="Profit Factor" value={pf}                                                    sub={openPositions.length > 0 ? `${openPositions.length} open` : "No open positions"} color="text-purple-400" />
          <Stat label="Max Drawdown"  value={`${maxDD.toFixed(1)}%`}                               sub={`${trades.length} total trades`}                  color={maxDD < -10 ? "text-red-400" : "text-yellow-400"} />
        </div>
      )}

      {/* PnL Chart */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL</p>
        <PnLChart trades={trades} initial={LIVE_INITIAL} />
      </div>

      {/* Bot allocation */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Allocation</p>
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left pb-1 font-medium">Asset</th>
              <th className="text-right pb-1 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">USDT</td>
              <td className="py-1.5 text-right text-white">${(botUsdt ?? 0).toFixed(2)}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">ATOM</td>
              <td className="py-1.5 text-right text-white">
                {openPositions[0]?.quantity?.toFixed(4) ?? "0.0000"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">ATOM price</td>
              <td className="py-1.5 text-right text-yellow-400">
                {latestPrice != null ? `$${latestPrice.toFixed(4)}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Open Positions */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Open Positions
          {openPositions.length > 0 && <span className="ml-1 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full text-xs">{openPositions.length}</span>}
        </p>
        <OpenPositions positions={openPositions} loading={loading} />
      </div>

      {/* Trade History */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        <TradeHistory trades={trades.slice(0, 10)} loading={loading} />
      </div>

      {/* Live Activity Log */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Live Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions = r.data?.actions ?? [];
            const time = r.run_at
              ? new Date(r.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
              : "";
            return (
              <div key={r.id} className="flex gap-2 items-start">
                <span className="text-gray-600 shrink-0">{time}</span>
                <div className="flex flex-col gap-0">
                  {actions.map((a: any, i: number) => (
                    <span key={i} className={actionColor(a.action)}>
                      {formatAction(a)}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [trades, setTrades]           = useState<any[]>([]);
  const [open, setOpen]               = useState<any[]>([]);
  const [liveSettings, setLiveSettings] = useState<any>(null);
  const [liveOpen, setLiveOpen]       = useState<any[]>([]);
  const [liveTrades, setLiveTrades]   = useState<any[]>([]);
  const [liveRuns, setLiveRuns]       = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);
  const [toggling, setToggling]         = useState(false);
  const [resetting, setResetting]       = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  async function load() {
    const [
      { data: closed },
      { data: openPos },
      { data: liveSt },
      { data: liveOp },
      { data: liveCl },
      { data: liveRs },
    ] = await Promise.all([
      getSupabase().from("positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }),
      getSupabase().from("positions").select("*").in("status", ["open", "chasing"]),
      getSupabase().from("live_settings").select("*").single(),
      getSupabase().from("live_positions").select("*").in("status", ["open", "chasing"]),
      getSupabase().from("live_positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }).limit(20),
      getSupabase().from("live_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
    ]);
    setTrades(closed ?? []);
    setOpen(openPos ?? []);
    setLiveSettings(liveSt ?? null);
    setLiveOpen((liveOp ?? []).map((p: any) => ({ ...p, pair: "ATOM" })));
    setLiveTrades(liveCl ?? []);
    setLiveRuns(liveRs ?? []);
    setLoading(false);
  }

  async function handleToggle() {
    setToggling(true);
    await fetch("/api/live/toggle", { method: "POST" });
    await load();
    setToggling(false);
  }

  async function handleReset() {
    if (!confirm("Market sell all ATOM and clear position?")) return;
    setResetting(true);
    await fetch("/api/live/reset", { method: "POST" });
    await load();
    setResetting(false);
  }

  async function handleClearHistory() {
    if (!confirm("Delete all closed trade history and run logs?")) return;
    setClearingHistory(true);
    await fetch("/api/live/clear-history", { method: "POST" });
    await load();
    setClearingHistory(false);
  }

  useEffect(() => {
    load();
    const sb = getSupabase();
    const ch1 = sb.channel("positions")
      .on("postgres_changes", { event: "*", schema: "public", table: "positions" }, load)
      .subscribe();
    const ch2 = sb.channel("live")
      .on("postgres_changes", { event: "*", schema: "public", table: "live_positions" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "live_settings" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "live_runs" }, load)
      .subscribe();
    return () => { sb.removeChannel(ch1); sb.removeChannel(ch2); };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-white">TradeBot Dashboard</h1>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <PaperPanel
            trades={trades}
            openPositions={open}
            loading={loading}
          />
          <LivePanel
            trades={liveTrades}
            openPositions={liveOpen}
            loading={loading}
            botUsdt={liveSettings?.usdt_balance ?? 0}
            enabled={liveSettings?.enabled ?? false}
            onToggle={handleToggle}
            toggling={toggling}
            onReset={handleReset}
            resetting={resetting}
            onClearHistory={handleClearHistory}
            clearingHistory={clearingHistory}
            runs={liveRuns}
          />
        </div>
      </div>
    </main>
  );
}

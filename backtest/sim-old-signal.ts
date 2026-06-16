// Replay the OLD lag signal (last-price spread >= 0.10%) against today's logged bid/ask data.
// Entry = market buy at the real US ask. TP/SL = 0.10% OCO, MAX_HOLD 6 min, exits at the real US bid.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getSupabaseAdmin } from "../lib/supabase-admin";

const GL_THRESH = 0.001, TP_PCT = 0.001, SL_PCT = 0.001, MAX_HOLD_MS = 6 * 60000;

type Row = { t: number; us: number; gl: number; bid: number | null; ask: number | null; askQty: number | null };

(async () => {
  const sb = getSupabaseAdmin();
  const rows: Row[] = [];
  let from = 0;
  for (;;) {
    const { data } = await sb.from("btc_price_log")
      .select("logged_at, us_price, gl_price, us_bid, us_ask, us_ask_qty")
      .not("us_ask", "is", null)
      .order("logged_at", { ascending: true })
      .range(from, from + 999);
    if (!data?.length) break;
    for (const r of data) rows.push({
      t: new Date(r.logged_at).getTime(), us: r.us_price, gl: r.gl_price,
      bid: r.us_bid, ask: r.us_ask, askQty: r.us_ask_qty,
    });
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`\nRows with ask data: ${rows.length} | ${new Date(rows[0].t).toISOString().slice(11, 19)} → ${new Date(rows[rows.length - 1].t).toISOString().slice(11, 19)} UTC\n`);

  type Trade = {
    time: string; entryAsk: number; lastSpread: number; askSpread: number;
    askDepth: number; result: string; exit: number; pnlPct: number;
  };
  const trades: Trade[] = [];

  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    // old signal: last-price spread + global rising over ~1m (approx glRet>0 && usRet<glRet)
    const back = rows.filter(x => x.t >= r.t - 70000 && x.t < r.t - 20000).pop();
    const lastSpread = (r.gl - r.us) / r.us;
    const glRet = back ? (r.gl - back.gl) / back.gl : 0;
    const usRet = back ? (r.us - back.us) / back.us : 0;
    if (!(lastSpread >= GL_THRESH && glRet > 0 && usRet < glRet) || r.ask == null) { i++; continue; }

    const entry = r.ask;                       // market buy pays the ask
    const tp = entry * (1 + TP_PCT), sl = entry * (1 - SL_PCT);
    let result = "EXPIRE", exit = entry, j = i + 1;
    for (; j < rows.length; j++) {
      const x = rows[j];
      const px = x.bid ?? x.us;                // exits happen at the bid (fall back to last if bid not logged yet)
      if (px <= sl) { result = "SL"; exit = sl; break; }
      if (px >= tp) { result = "TP"; exit = tp; break; }
      if (x.t - r.t >= MAX_HOLD_MS) { result = "EXPIRE"; exit = px; break; }
    }
    trades.push({
      time: new Date(r.t).toISOString().slice(11, 19),
      entryAsk: entry, lastSpread: lastSpread * 100,
      askSpread: (r.gl - r.ask) / r.ask * 100,
      askDepth: r.ask * (r.askQty ?? 0),
      result, exit, pnlPct: (exit - entry) / entry * 100,
    });
    i = j + 1;                                 // one position at a time
  }

  console.log("time      entry(ask)  lastSprd  askSprd   depth$   result   pnl%");
  console.log("─".repeat(72));
  for (const t of trades) {
    console.log(
      `${t.time}  ${t.entryAsk.toFixed(2)}  ${t.lastSpread.toFixed(3).padStart(7)}%  ${t.askSpread.toFixed(3).padStart(7)}%  ${t.askDepth.toFixed(0).padStart(7)}  ${t.result.padEnd(7)}  ${(t.pnlPct >= 0 ? "+" : "") + t.pnlPct.toFixed(3)}%`
    );
  }

  const g = (res: string) => trades.filter(t => t.result === res);
  const tot = trades.reduce((a, t) => a + t.pnlPct, 0);
  console.log(`\nTrades: ${trades.length} | TP: ${g("TP").length} | SL: ${g("SL").length} | EXPIRE: ${g("EXPIRE").length}`);
  console.log(`Net: ${(tot >= 0 ? "+" : "")}${tot.toFixed(3)}% on $25 = ${(tot >= 0 ? "+" : "")}$${(tot / 100 * 25).toFixed(3)}`);

  // TP vs SL signature: was anything different at signal time?
  const avg = (a: Trade[], f: (t: Trade) => number) => a.length ? a.reduce((s, t) => s + f(t), 0) / a.length : NaN;
  console.log("\n── SIGNAL DIFFERENCES at entry (TP vs SL) ──");
  console.log(`avg last-spread:  TP ${avg(g("TP"), t => t.lastSpread).toFixed(3)}%  |  SL ${avg(g("SL"), t => t.lastSpread).toFixed(3)}%  |  EXPIRE ${avg(g("EXPIRE"), t => t.lastSpread).toFixed(3)}%`);
  console.log(`avg ask-spread:   TP ${avg(g("TP"), t => t.askSpread).toFixed(3)}%  |  SL ${avg(g("SL"), t => t.askSpread).toFixed(3)}%  |  EXPIRE ${avg(g("EXPIRE"), t => t.askSpread).toFixed(3)}%`);
  console.log(`avg ask depth $:  TP ${avg(g("TP"), t => t.askDepth).toFixed(0)}  |  SL ${avg(g("SL"), t => t.askDepth).toFixed(0)}  |  EXPIRE ${avg(g("EXPIRE"), t => t.askDepth).toFixed(0)}`);
  console.log();
})();

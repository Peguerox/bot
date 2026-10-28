"""The basic moves, on the REAL books (2026-10-23, direct request).

Starts from a copy of each live bot's ledger (research/lit-simple-grid-2026-10-23/live_*.json,
made by snapshot_live.py there -- read-only copies) and runs only the simple moves: price up slow,
up in one jump, up fast, down slow, down in one jump, wiggle. The check that matters, on every tick
where price has held still for a few seconds (time for fill -> reconcile -> batch):

  - the line right below price that holds no lot HAS its buy on the exchange (funds permitting);
  - the nearest sell the rules allow (each lot's line+1, never below its cost) IS on the exchange.

Plus: no sale below cost, ledger LIT = exchange LIT, no orphan / ghost orders, and the request
budget. Run: python3 test_simple_grid.py
"""
import asyncio, json, math, os, random, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
import test_engine_sim as S  # noqa: E402  (fake clock, db, exchange, feed)

core = S.core
SNAP_DIR = os.path.join(os.path.dirname(__file__), "..", "research", "lit-simple-grid-2026-10-23")
PASS, FAIL = S.PASS, S.FAIL
check = S.check


def load(name):
    snap = json.load(open(os.path.join(SNAP_DIR, f"live_{name}.json")))
    st = dict(snap["state"])
    st.update({"engine_v2_enabled": True, "flatten_requested": False, "grid_reset_requested": False,
               "reanchor_journal": None})
    return st, snap["orders"]


def start(name, seed, curve=False):
    st, orders = load(name)
    if curve:
        # Curve sizing switched on from this real book (2026-10-25): plans at the current price.
        st.update({"curve_enabled": True, "dynamic_dd_enabled": False, "curve_n": 10,
                   "curve_floor_lit": 1, "curve_top": None, "curve_cash_usd": None,
                   "curve_profit_base_usd": None, "curve_state": None})
    if curve == "mirror":
        # Mirror (peak -10%) + crash reserve (2026-10-27), deploy set to -2% so a short run reaches
        # it, with $200 already saved in the reserve.
        comp = float(st.get("profit_bucket_compound_usd") or 0)
        st.update({"curve_peak_pct": 10, "reserve_enabled": True, "reserve_deploy_pct": 2,
                   "reserve_share_pct": 100, "reserve_profit_base_usd": comp - 200.0,
                   "reserve_deploys": 0})
    t_snap = datetime.fromisoformat(st["updated_at"].replace("Z", "+00:00"))
    S.Clock.t = S.T0 + (t_snap - S.BASE_DT).total_seconds()
    rng = random.Random(seed)
    price = float(st["live_price"])
    ex = S.SimExchange(price, float(st["usdc_balance"]), float(st["lit_balance"]), rng)
    db = S.SimDb(st)
    db.orders = [dict(r) for r in orders]
    db._next = max(r["id"] for r in orders) + 1
    for r in db.orders:
        if r["status"] in ("open", "pending", "cancel_requested") and r.get("order_kind") != "market":
            oi = ex.next_oi
            ex.next_oi += 1
            # A partly filled order keeps its fill on the exchange (Lighter reports the cumulative
            # fill), or cancelling it would lose that LIT from the ledger -- a copy-only artifact.
            done = float(r.get("filled_qty") or 0)
            ex.orders[oi] = {"oi": oi, "co": int(r["client_order_index"]), "side": r["side"],
                             "price": float(r["limit_price"]), "size": float(r["size"]),
                             "remaining": float(r["size"]) - done, "filled": done,
                             "quote": done * float(r["limit_price"]), "status": "open", "created": S.Clock.t - 600}
            r["exchange_order_id"] = oi
            r["status"] = "open"
    limiter = core.ExchangeLimiter()
    bot = S.make_sim_bot(db, ex, limiter)
    feed = core.OrdersFeed()
    bot._orders_feed = feed
    return st, db, ex, bot, feed, rng


def path(kind, p0, step):
    """Prices per 2s tick, in grid lines from the start price."""
    line = lambda k: p0 * math.exp(k * step)
    hold = lambda k, n: [line(k)] * n
    if kind == "up slow":          # one line every 5 ticks (10s), 15 lines
        return hold(0, 10) + sum((hold(k, 5) for k in range(1, 16)), []) + hold(15, 20)
    if kind == "up jump":          # 6 lines in one tick
        return hold(0, 10) + hold(6.3, 30)
    if kind == "up fast":          # one line every tick for 20 ticks
        return hold(0, 10) + [line(k) for k in range(1, 21)] + hold(20.3, 75)
    if kind == "down slow":
        return hold(0, 10) + sum((hold(-k, 5) for k in range(1, 16)), []) + hold(-15, 20)
    if kind == "down jump":
        return hold(0, 10) + hold(-6.3, 30)
    if kind == "down fast":
        return hold(0, 10) + [line(-k) for k in range(1, 21)] + hold(-20.3, 75)
    if kind == "flick":            # up past a line for ONE tick (2s) and straight back (live 01:22)
        # up 1.5 lines for one tick, then back to 0.7 below the start (below the buy-back line
        # whichever way the start sits between lines)
        return hold(0, 10) + sum(([line(1.5)] + hold(-0.7, 6) for _ in range(6)), []) + hold(-0.7, 10)
    if kind == "wiggle":           # across a line up and back down, every 4 ticks
        return hold(0, 10) + sum((hold(1.3 if i % 2 else -0.7, 4) for i in range(24)), []) + hold(0.3, 10)
    raise ValueError(kind)


def near_orders(db, ex, bot, p, step, sp):
    state = db.state
    anchor = bot._anchor_log(state)
    lots = lots_of(db)
    book = [o for o in ex.orders.values() if o["status"] == "open"]
    buys = {round(o["price"], 4) for o in book if o["side"] == "buy"}
    sells = {round(o["price"], 4) for o in book if o["side"] == "sell"}
    cur = core.grid_engine.line_at_or_below(p, anchor, step)
    ln = cur if core.grid_engine.line_price(anchor, cur, step) < p else cur - 1
    while ln in lots:
        ln -= 1
    want_buy = core.round_price(core.grid_engine.line_price(anchor, ln, step))
    size = float(state.get("order_size_lit") or 0)
    free_usdc = ex.usdc - ex._locked_usdc()
    buy_ok = want_buy in buys or want_buy in sells or free_usdc <= want_buy * max(size, 1.0) * 1.01
    targets = [core.grid_engine.sell_target(l, h["cost"], anchor, step, sp / 100, core.round_price)
               for l, h in lots.items()]
    above = [x for x in targets if x > p]
    sell_ok = not above or min(above) in sells
    return buy_ok, sell_ok, want_buy, buys, (min(above) if above else None), sells


def ok_now(db, ex, bot, p, step, sp):
    b, s, *_ = near_orders(db, ex, bot, p, step, sp)
    return b and s


def lots_of(db):
    return {ln: h for ln, h in S.lot_costs(db).items() if h["qty"] >= 1.0}


async def run(name, kind, seed=1, shared_budget=False, react=False, curve=False):
    st, db, ex, bot, feed, rng = start(name, seed, curve=curve)
    if shared_budget:
        # Live, both bots draw on one wallet limit, and on a fast move both are busy at once:
        # each gets about half.
        bot._limiter = core.ExchangeLimiter(per_minute=core.REQUEST_BUDGET_PER_MIN // 2)
    sp = float(st["internal_spacing_pct"] or st["spacing_pct"])
    step = math.log(1 + sp / 100)
    prices = path(kind, float(st["live_price"]), step)
    label = (f"{name} {kind}" + (" shared budget" if shared_budget else "") + (" fast-react" if react else "")
             + (" MIRROR+RESERVE" if curve == "mirror" else " CURVE" if curve else ""))
    held_for = 0
    catch_up = None   # fast moves: seconds after the run stops until both near orders are back for good
    last_bad = 29
    bad_buy, bad_sell, checked = [], [], 0
    worst_profit = 0.0
    t_start = S.Clock.t
    prev = None
    seen_seq = -1
    for i, p in enumerate(prices):
        held_for = held_for + 1 if p == prev else 0
        prev = p
        if react:
            # The live loop with event-driven reactions: woken whenever the websocket reports an
            # order change (here: checked every 0.5s), otherwise every 2s.
            for sub in range(4):
                S.Clock.t += 0.5
                ex.set_price(p)
                S.push_feed(feed, ex, rng, 0.0)
                if feed.seq != seen_seq or sub == 3:
                    seen_seq = feed.seq
                    bot._v2_active = True
                    await bot.tick()
        else:
            S.Clock.t += 2.0
            ex.set_price(p)
            S.push_feed(feed, ex, rng, 0.0)
            await bot.tick()
        for r in db.orders:
            if r["side"] == "sell" and r.get("realized_profit_usd") is not None and r["id"] > 0:
                worst_profit = min(worst_profit, float(r["realized_profit_usd"]))
        if held_for < 3 or i < 6:
            continue
        if "fast" in kind and i >= 30:
            # Fast runs: measured as the time until the book is right AND stays right.
            if not ok_now(db, ex, bot, p, step, sp):
                last_bad = i
            continue
        checked += 1
        state = db.state
        anchor = bot._anchor_log(state)
        lots = lots_of(db)
        book = [o for o in ex.orders.values() if o["status"] == "open"]
        buys = {round(o["price"], 4) for o in book if o["side"] == "buy"}
        sells = {round(o["price"], 4) for o in book if o["side"] == "sell"}
        cur = core.grid_engine.line_at_or_below(p, anchor, step)
        ln = cur if core.grid_engine.line_price(anchor, cur, step) < p else cur - 1
        while ln in lots:
            ln -= 1
        want_buy = core.round_price(core.grid_engine.line_price(anchor, ln, step))
        size = float(state.get("order_size_lit") or 0)
        free_usdc = ex.usdc - ex._locked_usdc()
        if want_buy not in buys and want_buy not in sells and free_usdc > want_buy * max(size, 1.0) * 1.01:
            bad_buy.append((i, round(p, 4), want_buy, sorted(buys, reverse=True)[:2]))
        targets = [core.grid_engine.sell_target(l, h["cost"], anchor, step, sp / 100, core.round_price)
                   for l, h in lots.items()]
        above = [x for x in targets if x > p]
        if above and min(above) not in sells:
            bad_sell.append((i, round(p, 4), min(above), sorted(sells)[:2]))
    # settle, then the end-of-run truths
    for _ in range(10):
        S.Clock.t += 2.0
        S.push_feed(feed, ex, rng, 0.0)
        await bot.tick()
    if "fast" in kind:
        catch_up = (last_bad + 1 - 30) * 2
        limit = 120 if shared_budget else 60
        stays = last_bad < len(prices) - 1
        check(f"[{label}] both orders next to price are back for good within {limit}s after the run (took {catch_up}s)",
              stays and catch_up <= limit, catch_up)
    check(f"[{label}] the buy right below price is always there ({checked - len(bad_buy)}/{checked})",
          not bad_buy, bad_buy[:4])
    check(f"[{label}] the nearest allowed sell above price is always there ({checked - len(bad_sell)}/{checked})",
          not bad_sell, bad_sell[:4])
    check(f"[{label}] nothing sold below cost (worst {worst_profit:.6f})", worst_profit >= -1e-6, worst_profit)
    cached = core.holdings_from_rows(*(await bot._holdings_rows()))
    bot._rows_cache = None
    fresh = core.holdings_from_rows(*(await bot._holdings_rows()))
    same = set(cached) == set(fresh) and all(
        abs(cached[k]["qty"] - fresh[k]["qty"]) < 1e-9 and abs(cached[k]["cost"] - fresh[k]["cost"]) < 1e-9
        for k in fresh)
    check(f"[{label}] the bot's in-memory lots match a fresh read of the ledger", same,
          (len(cached), len(fresh)))
    ledger_lit = sum(h["qty"] for h in S.lot_costs(db).values())
    check(f"[{label}] ledger LIT = exchange LIT ({ledger_lit:.2f} vs {ex.lit:.2f})",
          abs(ledger_lit - ex.lit) < 0.05, (ledger_lit, ex.lit))
    open_ledger = {int(r["client_order_index"]) for r in db.orders if r["status"] in ("open", "pending", "cancel_requested")}
    open_ex = {o["co"] for o in ex.orders.values() if o["status"] == "open"}
    check(f"[{label}] no orphan / ghost orders", open_ledger == open_ex,
          (sorted(open_ex - open_ledger)[:5], sorted(open_ledger - open_ex)[:5]))
    per_min = {}
    for t in ex.requests:
        per_min[int((t - t_start) // 60)] = per_min.get(int((t - t_start) // 60), 0) + 1
    worst = max(per_min.values()) if per_min else 0
    check(f"[{label}] requests per minute within budget (worst {worst})", worst <= core.REQUEST_BUDGET_PER_MIN + 1, worst)
    if curve:
        state = db.state
        anchor = bot._anchor_log(state)
        plan = bot._curve_plan_cached(state, anchor, step)
        budget = bot._curve_budget(state)
        buys = [o for o in ex.orders.values() if o["status"] == "open" and o["side"] == "buy"]
        off = [(round(o["price"], 4), o["size"], round(core.curve_size(o["price"], plan, budget), 2))
               for o in buys if o["filled"] == 0 and abs(o["size"] - core.curve_size(o["price"], plan, budget))
               > core.CURVE_REPLACE_FRAC * core.curve_size(o["price"], plan, budget)]
        check(f"[{label}] every resting buy is on its curve size ({len(buys) - len(off)}/{len(buys)})",
              buys and not off, off[:4])
        if curve == "mirror":
            deployed = [r for r in db.runs if (r or {}).get("action") == "reserve_deployed"]
            if kind == "down fast":                # 20 lines = 2.5%; the others stay above -2%
                check(f"[{label}] the reserve deployed once past -2% and the curve re-planned there",
                      len(deployed) == 1 and abs(state["curve_top"] / float(st["live_price"]) - 1) > 0.019, deployed)
            else:
                check(f"[{label}] no deploy without a 2% fall", not deployed, deployed)
            _, _, avail = bot._funding(state, lots_of(db), await bot.resting_orders_by_level())
            free = ex.usdc - ex._locked_usdc()
            check(f"[{label}] the reserve's cash is never spent (free {free:,.2f} >= reserve {bot._reserve_usd(state):,.2f})",
                  free + 1e-6 >= bot._reserve_usd(state), (free, bot._reserve_usd(state)))
        print(f"  {label}: top ${plan['P']:.4f} budget ${budget:,.0f} sizes {[round(o['size'], 2) for o in sorted(buys, key=lambda o: -o['price'])][:5]}")
    fills = len(ex.fills)
    if kind == "flick":
        rebuys = sum(1 for side, px, q, co in ex.fills if side == "buy")
        if react:
            check(f"[{label}] a 2-second flick is caught: the buy-back fills on the way down ({rebuys} re-buys)",
                  rebuys >= 3, rebuys)
        print(f"  {label}: re-buys after flicks = {rebuys}")
    print(f"  {label}: fills={fills} catch_up_s={catch_up} checked_ticks={checked} worst_req/min={worst}")


async def run_respace(name, new_sp, curve=False, seed=3):
    """Spacing change on the real book (2026-10-26): the clean reset (one cancel-all, empty book,
    lots merged next to their cost), then normal trading at the new spacing."""
    st, db, ex, bot, feed, rng = start(name, seed, curve=curve)
    label = f"{name} respace {st.get('internal_spacing_pct')}% -> {new_sp}%" + (" CURVE" if curve else "")
    p0 = float(st["live_price"])
    worst_profit = 0.0
    for i in range(160):
        if i == 10:
            db.state["spacing_pct"] = new_sp
        p = p0 * (1 + 0.004 * math.sin(i / 9.0)) if i > 60 else p0
        S.Clock.t += 2.0
        ex.set_price(p)
        S.push_feed(feed, ex, rng, 0.0)
        await bot.tick()
        for r in db.orders:
            if r["side"] == "sell" and r.get("realized_profit_usd") is not None:
                worst_profit = min(worst_profit, float(r["realized_profit_usd"]))
    for _ in range(10):
        S.Clock.t += 2.0
        S.push_feed(feed, ex, rng, 0.0)
        await bot.tick()
    state = db.state
    check(f"[{label}] reset finished at the new spacing",
          float(state.get("internal_spacing_pct") or 0) == new_sp and not state.get("grid_reset_requested"),
          (state.get("internal_spacing_pct"), state.get("grid_reset_requested")))
    check(f"[{label}] nothing sold below cost (worst {worst_profit:.6f})", worst_profit >= -1e-6, worst_profit)
    ledger_lit = sum(h["qty"] for h in S.lot_costs(db).values())
    check(f"[{label}] ledger LIT = exchange LIT ({ledger_lit:.2f} vs {ex.lit:.2f})", abs(ledger_lit - ex.lit) < 0.05)
    step = math.log(1 + new_sp / 100)
    anchor = bot._anchor_log(state)
    lots = lots_of(db)
    gaps = sorted(core.grid_engine.sell_target(l, h["cost"], anchor, step, new_sp / 100, core.round_price) / h["cost"] - 1
                  for l, h in lots.items())
    far = [g for g in gaps if g > 4 * new_sp / 100]
    check(f"[{label}] lots sit next to their cost: worst sell {gaps[-1] * 100 / new_sp:.1f} spacings above cost",
          gaps and not far, far[:5])
    ok = ok_now(db, ex, bot, ex.price, step, new_sp)
    check(f"[{label}] buy below and sell above price are on the book after the change", ok)
    open_ledger = {int(r["client_order_index"]) for r in db.orders if r["status"] in ("open", "pending", "cancel_requested")}
    open_ex = {o["co"] for o in ex.orders.values() if o["status"] == "open"}
    check(f"[{label}] no orphan / ghost orders", open_ledger == open_ex)
    print(f"  {label}: {len(lots)} lots, median sell {gaps[len(gaps)//2] * 100 / new_sp:.2f} spacings above cost")


async def main():
    for name in ("worker4", "worker3"):
        for kind in ("up slow", "up jump", "up fast", "down slow", "down jump", "down fast", "wiggle"):
            await run(name, kind)
        # The same fast runs with the budget the live bots really have when both are busy.
        for kind in ("up fast", "down fast"):
            await run(name, kind, shared_budget=True)
        # Event-driven reactions (woken by the websocket): the 2-second flick, and every basic
        # move again, all with the shared budget.
        await run(name, "flick")
        for kind in ("flick", "up slow", "up fast", "down slow", "down fast", "wiggle"):
            await run(name, kind, shared_budget=True, react=True)
    # Curve sizing from the live Worker 3 book: the one-time swap of the old gate-sized buys, then
    # every basic move (same checks: no gap next to price, nothing below cost, ledger = exchange).
    for kind in ("up slow", "up fast", "down slow", "down jump", "down fast", "wiggle", "flick"):
        await run("worker3", kind, curve=True)
    for kind in ("up fast", "down fast"):
        await run("worker3", kind, shared_budget=True, react=True, curve=True)
    for kind in ("up fast", "down slow", "down jump", "down fast", "wiggle"):
        await run("worker3", kind, curve="mirror")
    for sp in (0.25, 0.5):
        await run_respace("worker3", sp)
        await run_respace("worker3", sp, curve=True)
    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        for f in FAIL:
            print("  FAILED:", f)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

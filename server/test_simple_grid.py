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


def start(name, seed):
    st, orders = load(name)
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
            size = float(r["size"]) - float(r.get("filled_qty") or 0)
            ex.orders[oi] = {"oi": oi, "co": int(r["client_order_index"]), "side": r["side"],
                             "price": float(r["limit_price"]), "size": size, "remaining": size,
                             "filled": 0.0, "quote": 0.0, "status": "open", "created": S.Clock.t - 600}
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


async def run(name, kind, seed=1, shared_budget=False):
    st, db, ex, bot, feed, rng = start(name, seed)
    if shared_budget:
        # Live, both bots draw on one wallet limit, and on a fast move both are busy at once:
        # each gets about half.
        bot._limiter = core.ExchangeLimiter(per_minute=core.REQUEST_BUDGET_PER_MIN // 2)
    sp = float(st["internal_spacing_pct"] or st["spacing_pct"])
    step = math.log(1 + sp / 100)
    prices = path(kind, float(st["live_price"]), step)
    label = f"{name} {kind}" + (" shared budget" if shared_budget else "")
    held_for = 0
    catch_up = None   # fast moves: seconds after the run stops until both near orders are back for good
    last_bad = 29
    bad_buy, bad_sell, checked = [], [], 0
    worst_profit = 0.0
    t_start = S.Clock.t
    prev = None
    for i, p in enumerate(prices):
        S.Clock.t += 2.0
        held_for = held_for + 1 if p == prev else 0
        prev = p
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
    fills = len(ex.fills)
    print(f"  {label}: fills={fills} catch_up_s={catch_up} checked_ticks={checked} worst_req/min={worst}")


async def main():
    for name in ("worker4", "worker3"):
        for kind in ("up slow", "up jump", "up fast", "down slow", "down jump", "down fast", "wiggle"):
            await run(name, kind)
        # The same fast runs with the budget the live bots really have when both are busy.
        for kind in ("up fast", "down fast"):
            await run(name, kind, shared_budget=True)
    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        for f in FAIL:
            print("  FAILED:", f)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

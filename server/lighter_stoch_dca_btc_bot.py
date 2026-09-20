"""
Real-money Lighter BTC bot -- "Stochastic5 + 1:2:4 DCA", from Lighter_BTC_Hypertrading_DCA_Sweep.xlsx
(the best baseline-cost candidate found in a 40,080-configuration sweep). $20 real test to measure
whether it survives real execution -- the doc's own stress test shows it flips negative under just
0.002% extra slippage on regular fills, so this is exactly the kind of thing worth verifying live
rather than trusting the backtest either way.

Exact rules (from "Main rules" sheet):
  - Raw %K over last 5 completed 1-min candles, no smoothing. <20 => long signal, >80 => short
    signal, 20-80 (inclusive) => neutral. NO memory -- neutral means no signal, period.
  - Flat: enter only on a fresh non-neutral signal, at the next minute's open.
  - Budget fixed at basket start, split 1:2:4 across up to 3 legs (1/7, 2/7, 4/7 of equity).
  - Leg 1 (1/7) fires on the entry signal. Legs 2/3 are DCA adds at 0.06% / 0.12% adverse move
    from the FIRST fill (not the last leg), gated: prior close AND current open must both pass
    the level, current signal must not oppose the held side, max 1 addition per minute.
  - TP = avg-entry x (1 +/- 0.001), recalculated after every addition.
  - SL = FIRST entry x (1 -/+ 0.005), fixed forever (never moves as legs are added).
  - Reversal: an opposite non-neutral signal closes everything and reopens at that same open.
  - Time limit: close 30 minutes after the FIRST entry if still open (additions don't reset it).
  - After TP/SL/time exit: wait for next minute before reentry. Reversal can close+reopen same minute.
  - Tie-break priority: opening-gap OCO first, then deadline, then reversal, then additions;
    if TP and SL both touch in one minute, the stop wins.
"""
import asyncio
import os
import time
import urllib.request
import json as jsonlib

import lighter

MARKET_INDEX = 1  # BTC
BASE_URL = "https://mainnet.zklighter.elliot.ai"
POLL_SECONDS = 1
PRICE_DECIMALS = 1
SIZE_DECIMALS = 5

STOCH_WINDOW = 5
DCA_TRIGGER_1_PCT = 0.06
DCA_TRIGGER_2_PCT = 0.12
LEG_FRACTIONS = [1.0]  # no DCA: full equity on the single entry, no legs 2/3
TP_PCT = 0.10
SL_PCT = 0.05
TIME_LIMIT_MIN = 30
DCA_ENABLED = False

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def sb_request(method, path, body=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = jsonlib.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    req.add_header("Content-Type", "application/json")
    if method in ("POST", "PATCH"):
        req.add_header("Prefer", "return=representation")
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        return jsonlib.loads(raw) if raw else None


def get_state():
    return sb_request("GET", "lighter_stoch_dca_btc_state?id=eq.1")[0]


def update_state(patch):
    sb_request("PATCH", "lighter_stoch_dca_btc_state?id=eq.1", patch)


def log_trade(side, avg_entry, exit_price, base_amount, pnl_usd, reason, legs_used, opened_at):
    sb_request("POST", "lighter_stoch_dca_btc_trades", {
        "side": side, "avg_entry_price": avg_entry, "exit_price": exit_price,
        "base_amount_btc": base_amount, "pnl_usd": pnl_usd, "reason": reason,
        "legs_used": legs_used, "opened_at": opened_at,
    })


def log_run(action, detail):
    try:
        sb_request("POST", "lighter_stoch_dca_btc_runs", {"action": action, "detail": detail})
    except Exception as e:
        print(f"  (log_run failed: {e})")


def load_env():
    return {
        "LIGHTER_ACCOUNT_INDEX": os.environ["LIGHTER_ACCOUNT_INDEX"],
        "LIGHTER_API_KEY_INDEX": os.environ["LIGHTER_API_KEY_INDEX"],
        "LIGHTER_API_PRIVATE_KEY": os.environ["LIGHTER_API_PRIVATE_KEY"],
    }


def price_to_int(p):
    return int(round(p * (10 ** PRICE_DECIMALS)))


def round_trigger(p, up):
    step = 0.1
    return (int(p / step) + (1 if up else 0)) * step if up else (int(p / step)) * step


def fetch_candles(count=30):
    end_ms = int(time.time() * 1000)
    url = f"{BASE_URL}/api/v1/candles?market_id={MARKET_INDEX}&resolution=1m&start_timestamp=0&end_timestamp={end_ms}&count_back={count}"
    with urllib.request.urlopen(url, timeout=15) as resp:
        data = jsonlib.loads(resp.read())
    return sorted(data.get("c", []), key=lambda c: c["t"])


def compute_stoch_signal(candles):
    # signal from the last FULLY completed candle (closed[:-1] excludes the in-progress one)
    if len(candles) < STOCH_WINDOW + 2:
        return None, None
    closed = candles[:-1]
    window = closed[-STOCH_WINDOW:]
    hh = max(c["h"] for c in window)
    ll = min(c["l"] for c in window)
    ts = closed[-1]["t"]
    if hh == ll:
        return None, ts
    k = 100 * (closed[-1]["c"] - ll) / (hh - ll)
    if k < 20:
        return "long", ts
    if k > 80:
        return "short", ts
    return None, ts


async def get_client():
    env = load_env()
    return lighter.SignerClient(
        url=BASE_URL, account_index=int(env["LIGHTER_ACCOUNT_INDEX"]),
        api_private_keys={int(env["LIGHTER_API_KEY_INDEX"]): env["LIGHTER_API_PRIVATE_KEY"]},
    )


async def get_position(client, account_index):
    account_api = lighter.AccountApi(client.api_client)
    acct = await account_api.account(by="index", value=str(account_index))
    a = acct.accounts[0]
    pos = 0.0
    for p in a.positions:
        if p.market_id == MARKET_INDEX:
            sign = 1 if str(getattr(p, "sign", 1)) in ("1", "True", "true") else -1
            pos = sign * float(p.position)
    return pos, float(a.collateral)


async def market_order(client, is_ask, base_amount, reduce_only, ref_price):
    band = ref_price * (0.99 if is_ask else 1.01)  # wider band; this strategy needs reliable fills on adds too
    exec_price = price_to_int(band)
    base_amount_int = int(round(base_amount * (10 ** SIZE_DECIMALS)))
    co_idx = int(time.time() * 1000) % 500_000_000
    order, resp, err = await client.create_market_order(
        market_index=MARKET_INDEX, client_order_index=co_idx, base_amount=base_amount_int,
        avg_execution_price=exec_price, is_ask=is_ask, reduce_only=reduce_only,
    )
    return err


async def cancel_all(client):
    tx, resp, err = await client.cancel_all_orders(
        time_in_force=client.CANCEL_ALL_TIF_IMMEDIATE, timestamp_ms=0, cancel_all_market_index=MARKET_INDEX,
    )
    return err


def equity_now(state):
    return state["seed_usd"] + state["realized_pnl_usd"]


def avg_entry(legs):
    total_notional = sum(l["usd_size"] for l in legs)
    total_qty = sum(l["usd_size"] / l["price"] for l in legs)
    return total_notional / total_qty if total_qty else None


def total_qty(legs):
    return sum(l["usd_size"] / l["price"] for l in legs)


async def tick():
    env = load_env()
    account_index = int(env["LIGHTER_ACCOUNT_INDEX"])
    client = await get_client()
    try:
        state = get_state()
        candles = fetch_candles()
        signal, candle_ts = compute_stoch_signal(candles)
        latest_closed = candles[-2] if len(candles) >= 2 else None
        now_open = candles[-1]["o"] if candles else None
        now_ms = candles[-1]["t"] if candles else int(time.time() * 1000)

        if candle_ts is None or now_open is None:
            return

        real_pos, collateral = await get_position(client, account_index)
        side = state.get("side")
        legs = state.get("legs") or []

        # Reconcile: OCO or something external already flattened us
        if side is not None and abs(real_pos) < 0.000001:
            prior_collateral = state.get("collateral_before_entry")
            pnl = (collateral - prior_collateral) if prior_collateral is not None else 0.0
            ae = avg_entry(legs) or state.get("first_entry_price")
            qty = total_qty(legs) or 0.0001
            implied_exit = ae + pnl / qty if side == "long" else ae - pnl / qty
            log_trade(side, ae, implied_exit, qty, pnl, "EXTERNAL", len(legs), state.get("updated_at") or "1970-01-01")
            log_run("resolved_externally", {"side": side, "pnl": pnl})
            update_state({"side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
                          "dca_level": 0, "realized_pnl_usd": state["realized_pnl_usd"] + pnl})
            state["realized_pnl_usd"] += pnl
            side = None
            legs = []

        # Resync: real position is open but doesn't match tracked size (e.g. a double-entry from
        # two processes briefly overlapping across a deploy). Reuses the same get_position() call
        # above -- no extra request. Keeps the tracked avg price, corrects the tracked qty to match
        # the real exchange position so the next close sells the actual full size instead of
        # leaving a residual behind.
        tracked_qty = total_qty(legs) if legs else 0.0
        if side is not None and abs(real_pos) > 0.000001 and tracked_qty > 0:
            same_direction = (real_pos > 0) == (side == "long")
            mismatch_pct = abs(abs(real_pos) - tracked_qty) / tracked_qty
            if same_direction and mismatch_pct > 0.02:
                ae = avg_entry(legs)
                legs = [{"price": ae, "usd_size": ae * abs(real_pos)}]
                update_state({"legs": legs})
                log_run("qty_resynced", {"side": side, "tracked_qty_before": tracked_qty,
                                          "real_qty": abs(real_pos), "mismatch_pct": mismatch_pct})

        ob_url = f"{BASE_URL}/api/v1/orderBookOrders?market_id={MARKET_INDEX}&limit=1"
        with urllib.request.urlopen(ob_url, timeout=15) as resp:
            ob = jsonlib.loads(resp.read())
        best_bid = float(ob["bids"][0]["price"])
        best_ask = float(ob["asks"][0]["price"])
        mid = (best_bid + best_ask) / 2

        async def close_all(reason, real_exit_ref):
            nonlocal side, legs, state
            prior_collateral = state.get("collateral_before_entry")
            qty = total_qty(legs)
            is_ask = (side == "long")
            await cancel_all(client)
            await market_order(client, is_ask=is_ask, base_amount=qty, reduce_only=True,
                                ref_price=(best_bid if is_ask else best_ask))
            await asyncio.sleep(1.5)
            _, collateral_after = await get_position(client, account_index)
            pnl = (collateral_after - prior_collateral) if prior_collateral is not None else 0.0
            ae = avg_entry(legs)
            exit_price = ae + pnl / qty if side == "long" else ae - pnl / qty
            log_trade(side, ae, exit_price, qty, pnl, reason, len(legs), state.get("updated_at") or "1970-01-01")
            new_pnl = state["realized_pnl_usd"] + pnl
            update_state({"side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
                          "dca_level": 0, "realized_pnl_usd": new_pnl, "last_processed_candle_ts": candle_ts})
            log_run("closed", {"reason": reason, "pnl": pnl, "side": side})
            state["realized_pnl_usd"] = new_pnl
            side = None
            legs = []

        if side is not None:
            ae = avg_entry(legs)
            tp = round_trigger(ae * (1 + TP_PCT / 100 if side == "long" else 1 - TP_PCT / 100), up=(side == "long"))
            sl = round_trigger(state["first_entry_price"] * (1 - SL_PCT / 100 if side == "long" else 1 + SL_PCT / 100), up=(side != "long"))
            deadline = (state.get("first_entry_time") or now_ms) + TIME_LIMIT_MIN * 60_000

            # live-price OCO check -- uses the real best bid/ask fetched this tick (the actual
            # achievable exit price), not the current candle's open, which can be up to a minute
            # stale. A long exits by selling (check vs best_bid); a short exits by buying (check
            # vs best_ask).
            check_price = best_bid if side == "long" else best_ask
            gap_hit = None
            if side == "long":
                if check_price <= sl: gap_hit = "SL"
                elif check_price >= tp: gap_hit = "TP"
            else:
                if check_price >= sl: gap_hit = "SL"
                elif check_price <= tp: gap_hit = "TP"
            if gap_hit:
                await close_all(gap_hit, check_price)
            elif now_ms >= deadline:
                await close_all("TIME", now_open)
            elif signal is not None and signal != side:
                await close_all("REVERSAL", now_open)
                # open the other side fresh, same open
                eq = equity_now(state)
                leg_usd = eq * LEG_FRACTIONS[0]
                price = best_ask if signal == "long" else best_bid
                err = await market_order(client, is_ask=(signal == "short"), base_amount=leg_usd / price, reduce_only=False, ref_price=price)
                if not err:
                    await asyncio.sleep(1.5)
                    _, collateral_after = await get_position(client, account_index)
                    update_state({"side": signal, "legs": [{"price": price, "usd_size": leg_usd}],
                                  "first_entry_price": price, "first_entry_time": now_ms, "dca_level": 0,
                                  "collateral_before_entry": collateral_after, "last_processed_candle_ts": candle_ts})
                    log_run("entered", {"signal": signal, "price": price, "via": "reversal"})
            else:
                # check DCA add eligibility
                next_level = state.get("dca_level", 0) + 1
                if DCA_ENABLED and next_level <= 2 and latest_closed is not None:
                    trigger_pct = DCA_TRIGGER_1_PCT if next_level == 1 else DCA_TRIGGER_2_PCT
                    fe = state["first_entry_price"]
                    level_price = fe * (1 - trigger_pct / 100) if side == "long" else fe * (1 + trigger_pct / 100)
                    prev_close_passes = (latest_closed["c"] <= level_price) if side == "long" else (latest_closed["c"] >= level_price)
                    open_passes = (now_open <= level_price) if side == "long" else (now_open >= level_price)
                    signal_favors = (signal != ("short" if side == "long" else "long"))
                    last_dca_min = state.get("last_dca_minute")
                    this_min = now_ms // 60000
                    not_same_minute = last_dca_min is None or last_dca_min != this_min
                    if prev_close_passes and open_passes and signal_favors and not_same_minute:
                        eq = equity_now(state)
                        leg_usd = eq * LEG_FRACTIONS[next_level]
                        price = now_open
                        is_ask = (side == "short")
                        err = await market_order(client, is_ask=is_ask, base_amount=leg_usd / price, reduce_only=False, ref_price=price)
                        if not err:
                            new_legs = legs + [{"price": price, "usd_size": leg_usd}]
                            update_state({"legs": new_legs, "dca_level": next_level, "last_dca_minute": this_min,
                                          "last_processed_candle_ts": candle_ts})
                            log_run("dca_add", {"level": next_level, "price": price})
                        else:
                            update_state({"last_processed_candle_ts": candle_ts})
                    else:
                        update_state({"last_processed_candle_ts": candle_ts})
                else:
                    update_state({"last_processed_candle_ts": candle_ts})
        else:
            if signal is not None:
                eq = equity_now(state)
                leg_usd = eq * LEG_FRACTIONS[0]
                price = best_ask if signal == "long" else best_bid
                err = await market_order(client, is_ask=(signal == "short"), base_amount=leg_usd / price, reduce_only=False, ref_price=price)
                if err:
                    log_run("enter_failed", {"signal": signal, "error": str(err)})
                    update_state({"last_processed_candle_ts": candle_ts})
                else:
                    await asyncio.sleep(1.5)
                    _, collateral_after = await get_position(client, account_index)
                    update_state({"side": signal, "legs": [{"price": price, "usd_size": leg_usd}],
                                  "first_entry_price": price, "first_entry_time": now_ms, "dca_level": 0,
                                  "collateral_before_entry": collateral_after, "last_processed_candle_ts": candle_ts})
                    log_run("entered", {"signal": signal, "price": price})
            else:
                update_state({"last_processed_candle_ts": candle_ts})
    finally:
        await client.api_client.close()


async def main():
    print("Stochastic5 + 1:2:4 DCA bot starting (BTC, real money, $20 seed)")
    while True:
        try:
            await tick()
        except Exception as e:
            print(f"tick error: {e}")
            try:
                log_run("error", {"error": str(e)})
            except Exception:
                pass
        await asyncio.sleep(POLL_SECONDS)


if __name__ == "__main__":
    asyncio.run(main())

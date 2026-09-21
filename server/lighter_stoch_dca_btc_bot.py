"""
Lighter BTC Worker 3 -- stochastic + actual-price confirmation.

SETTINGS
  Completed 1-minute candles, raw stochastic K(5).
  Long: K < 25, K rising, close >= previous close * 1.00006.
  Short: K > 75, K falling, close <= previous close * 0.99994.
  TP 0.10%, SL 0.11%, no DCA. Reversal exits remain 20/80.
  Both flat entries and entries after reversals must pass confirmation.

USAGE
  Uses this worker's Lighter/Supabase environment variables and tables.
  Run: python lighter_stoch_dca_btc_bot.py

EXECUTION CHANGES (2026-09-21, from external source-code review)
  Confirm the exchange position is flat before logging a close or reversing.
  Keep a close request in legs JSON so partial/rejected closes are retried.
  Check observed position after entry; disable new entries if unconfirmed.
  Refresh quotes and signals before reversal entries; record wall-clock times.
  Re-entry on a still-valid completed-bar signal remains allowed.

RECORDING LIMIT
  PnL uses collateral changes and exit price is inferred, not matched to exchange
  fills. Order/position confirmation does not independently reconcile fill-level PnL.
"""
import asyncio
import os
import time
import math
import urllib.parse
import urllib.request
import json as jsonlib
from datetime import datetime, timezone

import lighter

MARKET_INDEX = 1  # BTC
BASE_URL = "https://mainnet.zklighter.elliot.ai"
POLL_SECONDS = 0.5
PRICE_DECIMALS = 1
SIZE_DECIMALS = 5

STOCH_WINDOW = 5
PRICE_CONFIRM_PCT = 0.006
POSITION_EPSILON = 0.000001
DCA_TRIGGER_1_PCT = 0.06
DCA_TRIGGER_2_PCT = 0.12
LEG_FRACTIONS = [1.0]
TP_PCT = 0.10
SL_PCT = 0.11
DCA_ENABLED = False

ENTRY_LO, ENTRY_HI = 25, 75
REVERSAL_LO, REVERSAL_HI = 20, 80

TABLE_STATE = "lighter_stoch_dca_btc_state"
TABLE_TRADES = "lighter_stoch_dca_btc_trades"
TABLE_RUNS = "lighter_stoch_dca_btc_runs"

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
    return sb_request("GET", f"{TABLE_STATE}?id=eq.1")[0]


def update_state(patch):
    sb_request("PATCH", f"{TABLE_STATE}?id=eq.1", patch)


def ms_to_iso(ms):
    if ms is None:
        return "1970-01-01T00:00:00+00:00"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def log_trade(side, avg_entry, exit_price, base_amount, pnl_usd, reason, legs_used, opened_at):
    sb_request("POST", TABLE_TRADES, {
        "side": side, "avg_entry_price": avg_entry, "exit_price": exit_price,
        "base_amount_btc": base_amount, "pnl_usd": pnl_usd, "reason": reason,
        "legs_used": legs_used, "opened_at": opened_at,
    })


def log_run(action, detail):
    try:
        sb_request("POST", TABLE_RUNS, {"action": action, "detail": detail})
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


def _sig(k, lo, hi):
    if k is None:
        return None
    if k < lo:
        return "long"
    if k > hi:
        return "short"
    return None


def compute_signal_details(candles, as_of_ms=None):
    if as_of_ms is None:
        as_of_ms = int(time.time() * 1000)
    # Never use a forming candle, including when an API response omits that candle.
    closed = sorted((c for c in candles if int(c["t"]) + 60000 <= as_of_ms),
                    key=lambda c: int(c["t"]))
    result = {"entry": None, "reversal": None, "candle_ts": None,
              "k": None, "previous_k": None, "price_change_pct": None}
    if len(closed) < STOCH_WINDOW + 1:
        return result
    recent = closed[-STOCH_WINDOW-1:]
    if any(int(b["t"]) - int(a["t"]) != 60000 for a, b in zip(recent, recent[1:])):
        return result
    def raw_k(window):
        hh = max(float(c["h"]) for c in window)
        ll = min(float(c["l"]) for c in window)
        return None if hh <= ll else 100 * (float(window[-1]["c"]) - ll) / (hh - ll)
    k = raw_k(closed[-STOCH_WINDOW:])
    previous_k = raw_k(closed[-STOCH_WINDOW-1:-1])
    previous_close = float(closed[-2]["c"])
    change = 100 * (float(closed[-1]["c"]) / previous_close - 1) if previous_close > 0 else None
    entry = _sig(k, ENTRY_LO, ENTRY_HI)
    if previous_k is None or change is None:
        entry = None
    elif entry == "long" and not (k > previous_k and change >= PRICE_CONFIRM_PCT - 1e-10):
        entry = None
    elif entry == "short" and not (k < previous_k and change <= -PRICE_CONFIRM_PCT + 1e-10):
        entry = None
    result.update(entry=entry, reversal=_sig(k, REVERSAL_LO, REVERSAL_HI),
                  candle_ts=int(closed[-1]["t"]), k=k, previous_k=previous_k,
                  price_change_pct=change)
    return result


def compute_stoch_signal(candles):
    signal = compute_signal_details(candles)
    return signal["entry"], signal["reversal"], signal["candle_ts"]


def fetch_bid_ask():
    url = f"{BASE_URL}/api/v1/orderBookOrders?market_id={MARKET_INDEX}&limit=1"
    with urllib.request.urlopen(url, timeout=15) as resp:
        ob = jsonlib.loads(resp.read())
    bid, ask = float(ob["bids"][0]["price"]), float(ob["asks"][0]["price"])
    if not (0 < bid <= ask and math.isfinite(bid) and math.isfinite(ask)):
        raise ValueError("Invalid executable bid/ask")
    return bid, ask


async def confirmed_flat(client, account_index):
    # Require two successive flat observations; a submitted order alone is insufficient.
    flat_reads = 0
    last = None
    for attempt in range(5):
        last = await get_position(client, account_index)
        flat_reads = flat_reads + 1 if abs(last[0]) < POSITION_EPSILON else 0
        if flat_reads >= 2:
            return True, last
        if attempt < 4:
            await asyncio.sleep(0.5)
    return False, last


def existing_closed_trade(side, opened_at):
    # Retry protection for a trade POST that succeeded before a state PATCH failed.
    # One writer is required; full multi-writer atomicity needs a database constraint.
    query = urllib.parse.urlencode({"select": "pnl_usd", "side": "eq." + side,
                                   "opened_at": "eq." + opened_at, "limit": "1"})
    rows = sb_request("GET", f"{TABLE_TRADES}?{query}")
    return rows[0] if rows else None


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
    band = ref_price * (0.9995 if is_ask else 1.0005)  # tight band -- prefer no fill over a bad fill
    exec_price = price_to_int(band)
    base_amount_int = int(round(base_amount * (10 ** SIZE_DECIMALS)))
    co_idx = int(time.time() * 1000) % 500_000_000
    order, resp, err = await client.create_market_order(
        market_index=MARKET_INDEX, client_order_index=co_idx, base_amount=base_amount_int,
        avg_execution_price=exec_price, is_ask=is_ask, reduce_only=reduce_only,
    )
    log_run("order_submitted", {"client_order_index": co_idx, "is_ask": is_ask,
                                "reduce_only": reduce_only, "base_amount_int": base_amount_int,
                                "reference_price": ref_price, "error": str(err) if err else None,
                                "tx_hash": getattr(resp, "tx_hash", None)})
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
        entry_signal, reversal_signal, candle_ts = compute_stoch_signal(candles)
        latest_closed = candles[-2] if len(candles) >= 2 else None
        now_open = candles[-1]["o"] if candles else None
        now_ms = int(time.time() * 1000)

        if candle_ts is None or now_open is None:
            return

        real_pos, collateral = await get_position(client, account_index)
        side = state.get("side")
        legs = state.get("legs") or []

        if side is not None and abs(real_pos) >= POSITION_EPSILON and ((real_pos > 0) != (side == "long")):
            update_state({"enabled": False})
            log_run("position_direction_mismatch", {"tracked_side": side, "real_position": real_pos})
            return

        if side is not None and abs(real_pos) < POSITION_EPSILON:
            flat, observed = await confirmed_flat(client, account_index)
            if not flat:
                return
            real_pos, collateral = observed
            prior_collateral = state.get("collateral_before_entry")
            pnl = (collateral - prior_collateral) if prior_collateral is not None else 0.0
            ae = avg_entry(legs) or state.get("first_entry_price")
            qty = total_qty(legs) or 0.0001
            implied_exit = ae + pnl / qty if side == "long" else ae - pnl / qty
            opened_at = ms_to_iso(state.get("first_entry_time"))
            existing = existing_closed_trade(side, opened_at)
            if existing is not None:
                pnl = float(existing["pnl_usd"])
            else:
                reason = legs[0].get("close_requested_reason", "EXTERNAL") if legs else "EXTERNAL"
                log_trade(side, ae, implied_exit, qty, pnl, reason, len(legs), opened_at)
            log_run("resolved_externally", {"side": side, "pnl": pnl})
            update_state({"side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
                          "dca_level": 0, "realized_pnl_usd": state["realized_pnl_usd"] + pnl})
            state["realized_pnl_usd"] += pnl
            side = None
            legs = []

        tracked_qty = total_qty(legs) if legs else 0.0
        if side is not None and abs(real_pos) > 0.000001 and tracked_qty > 0:
            same_direction = (real_pos > 0) == (side == "long")
            mismatch_pct = abs(abs(real_pos) - tracked_qty) / tracked_qty
            if same_direction and mismatch_pct > 0.02 and not legs[0].get("close_requested_reason"):
                ae = avg_entry(legs)
                legs = [{"price": ae, "usd_size": ae * abs(real_pos)}]
                update_state({"legs": legs})
                log_run("qty_resynced", {"side": side, "tracked_qty_before": tracked_qty,
                                          "real_qty": abs(real_pos), "mismatch_pct": mismatch_pct})

        best_bid, best_ask = fetch_bid_ask()

        async def close_all(reason, real_exit_ref):
            nonlocal side, legs, state
            closing_side = side
            if not legs or avg_entry(legs) is None:
                update_state({"enabled": False})
                log_run("close_missing_entry_state", {"side": side})
                return False
            # Persist an exit request inside the existing legs JSON. Do not cancel it
            # merely because price bounces while an exit order is rejected/partial.
            if not legs[0].get("close_requested_reason"):
                legs = [dict(leg) for leg in legs]
                legs[0]["close_requested_reason"] = reason
                update_state({"legs": legs})
            reason = legs[0]["close_requested_reason"]
            prior_collateral = state.get("collateral_before_entry")
            qty = total_qty(legs)
            real_remaining, _ = await get_position(client, account_index)
            if abs(real_remaining) >= POSITION_EPSILON:
                if (real_remaining > 0) != (side == "long"):
                    update_state({"enabled": False})
                    log_run("close_direction_mismatch", {"side": side, "real_position": real_remaining})
                    return False
                cancel_error = await cancel_all(client)
                if cancel_error:
                    log_run("close_cancel_failed", {"error": str(cancel_error)})
                    return False
                bid, ask = fetch_bid_ask()
                err = await market_order(client, is_ask=(side == "long"),
                                         base_amount=abs(real_remaining), reduce_only=True,
                                         ref_price=bid if side == "long" else ask)
                if err:
                    log_run("close_order_error", {"error": str(err), "reason": reason})
                await asyncio.sleep(1.5)
            flat, observed = await confirmed_flat(client, account_index)
            if not flat:
                log_run("close_pending", {"reason": reason, "remaining_position": observed[0]})
                return False
            collateral_after = observed[1]
            pnl = collateral_after - prior_collateral if prior_collateral is not None else 0.0
            ae = avg_entry(legs)
            exit_price = ae + pnl / qty if side == "long" else ae - pnl / qty
            opened_at = ms_to_iso(state.get("first_entry_time"))
            existing = existing_closed_trade(side, opened_at)
            if existing is not None:
                pnl = float(existing["pnl_usd"])
            else:
                log_trade(side, ae, exit_price, qty, pnl, reason, len(legs), opened_at)
            new_pnl = state["realized_pnl_usd"] + pnl
            update_state({"side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
                          "dca_level": 0, "realized_pnl_usd": new_pnl, "last_processed_candle_ts": candle_ts})
            log_run("closed", {"reason": reason, "pnl": pnl, "side": closing_side,
                               "position_confirmed_flat": True, "pnl_basis": "collateral_delta",
                               "exit_price_basis": "collateral_delta_estimate"})
            state["realized_pnl_usd"] = new_pnl
            side = None
            legs = []
            return True

        async def enter_confirmed(desired, via):
            # Shared gate: a reversal can close a trade without authorizing a new one.
            latest_state = get_state()
            if not latest_state.get("enabled"):
                return False
            latest_signal = compute_signal_details(fetch_candles())
            if desired is None or latest_signal["entry"] != desired:
                log_run("entry_not_confirmed", {"via": via, "desired": desired, **latest_signal})
                return False
            real_before, collateral_before = await get_position(client, account_index)
            if abs(real_before) >= POSITION_EPSILON:
                log_run("entry_blocked_position_not_flat", {"position": real_before, "via": via})
                return False
            eq = equity_now(latest_state)
            if not math.isfinite(eq) or eq <= 0:
                return False
            bid, ask = fetch_bid_ask()
            price = ask if desired == "long" else bid
            leg_usd = eq * LEG_FRACTIONS[0]
            submitted_ms = int(time.time() * 1000)
            # Disable new entries BEFORE submission. A crash or uncertain response must
            # not lead to a second order. Confirmed entries restore the previous flag.
            update_state({"enabled": False})
            err = await market_order(client, is_ask=(desired == "short"),
                                     base_amount=leg_usd / price, reduce_only=False, ref_price=price)
            await asyncio.sleep(1.5)
            actual_pos, collateral_after = await get_position(client, account_index)
            matches = abs(actual_pos) >= POSITION_EPSILON and ((actual_pos > 0) == (desired == "long"))
            if not matches:
                log_run("entry_unconfirmed", {"signal": desired, "error": str(err) if err else None,
                                               "observed_position": actual_pos, "via": via,
                                               "new_entries_disabled": True, **latest_signal})
                return False
            actual_usd_at_quote = price * abs(actual_pos)
            update_state({"side": desired, "legs": [{"price": price, "usd_size": actual_usd_at_quote}],
                          "first_entry_price": price, "first_entry_time": submitted_ms, "dca_level": 0,
                          "collateral_before_entry": collateral_before,
                          "last_processed_candle_ts": latest_signal["candle_ts"], "enabled": True})
            log_run("entered", {"signal": desired, "price": price, "via": via,
                                "position_observed": actual_pos, "submitted_at": ms_to_iso(submitted_ms),
                                "price_basis": "quote_reference", "error": str(err) if err else None,
                                **latest_signal})
            return True

        if side is not None and legs and legs[0].get("close_requested_reason"):
            await close_all(legs[0]["close_requested_reason"], best_bid if side == "long" else best_ask)
            return

        if side is not None:
            ae = avg_entry(legs)
            tp = round_trigger(ae * (1 + TP_PCT / 100 if side == "long" else 1 - TP_PCT / 100), up=(side == "long"))
            sl = round_trigger(state["first_entry_price"] * (1 - SL_PCT / 100 if side == "long" else 1 + SL_PCT / 100), up=(side != "long"))

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
            elif reversal_signal is not None and reversal_signal != side:
                closed_ok = await close_all("REVERSAL", now_open)
                if closed_ok:
                    await enter_confirmed(reversal_signal, "reversal")
            else:
                update_state({"last_processed_candle_ts": candle_ts})
        else:
            if abs(real_pos) > 0.000001:
                # A previous attempt's order reported an error (e.g. a nonce race) but actually
                # filled on-chain anyway -- adopt the real position instead of firing another
                # entry order on top of it, which is what tripled position sizes on 2026-09-20.
                adopted_side = "long" if real_pos > 0 else "short"
                price = best_ask if adopted_side == "long" else best_bid
                update_state({"side": adopted_side, "legs": [{"price": price, "usd_size": price * abs(real_pos)}],
                              "first_entry_price": price, "first_entry_time": now_ms, "dca_level": 0,
                              "collateral_before_entry": collateral, "last_processed_candle_ts": candle_ts})
                log_run("adopted_orphan_position", {"side": adopted_side, "qty": abs(real_pos)})
            elif entry_signal is not None and state.get("enabled"):
                await enter_confirmed(entry_signal, "flat")
            else:
                update_state({"last_processed_candle_ts": candle_ts})
    finally:
        await client.api_client.close()


async def main():
    print("Worker 3: BTC K5 + 0.006% price confirmation; TP 0.10%, SL 0.11%, DCA off")
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

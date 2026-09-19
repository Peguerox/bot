"""
Real-money Lighter SOL bot -- "OCO". Runs continuously as a dedicated Render worker (Worker 3).

Strategy (from Lighter_SOL_Signal_Comparison.xlsx, "VWAP 15m mean_reversion band 0.00%", the
strongest performer in that sheet's May-Sep 2026 comparison window):
  - VWAP = rolling 15-minute HLC3 price weighted by base volume, on 1-min candles.
  - Signal: long when close < VWAP, short when close > VWAP (band=0%, no deadband).
  - Causality: signal computed from the last FULLY COMPLETED candle, acted on at the next minute.
  - Entry: real market order. Exit: a real OCO bracket (TP=1.5%, SL=0.03%) placed on Lighter's own
    book -- the exchange's matching engine handles the trigger/fill, this bot does not poll for it.
  - Reversal: if held and the signal flips, cancel the resting OCO, market-close, market-enter the
    opposite side, place a new OCO. Matches "Exit old and enter opposite at next minute open."

Position sizing: SEED_USD=20 (real, user-specified cap), compounding via realized_pnl_usd (matches
this project's SEED_USD convention for every other live bot). All order logic reuses the exact
calls already validated this session with real fills (open + real OCO + real close, several times).

State persists in Supabase (lighter_oco_state) so a worker restart doesn't lose track of an open
position or double-enter. last_processed_candle_ts guards against reprocessing the same candle.
"""
import asyncio
import os
import time
import urllib.request
import json as jsonlib

import lighter

MARKET_INDEX = 2  # SOL
BASE_URL = "https://mainnet.zklighter.elliot.ai"
VWAP_WINDOW = 15
TP_PCT = 1.5
SL_PCT = 0.03
POLL_SECONDS = 15  # how often the loop wakes up to check for a newly-completed candle

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
    rows = sb_request("GET", "lighter_oco_state?id=eq.1")
    return rows[0]


def update_state(patch):
    sb_request("PATCH", "lighter_oco_state?id=eq.1", patch)


def log_trade(side, entry_price, exit_price, base_amount_sol, pnl_usd, reason, opened_at):
    sb_request("POST", "lighter_oco_trades", {
        "side": side, "entry_price": entry_price, "exit_price": exit_price,
        "base_amount_sol": base_amount_sol, "pnl_usd": pnl_usd, "reason": reason,
        "opened_at": opened_at,
    })


def log_run(action, detail):
    try:
        sb_request("POST", "lighter_oco_runs", {"action": action, "detail": detail})
    except Exception as e:
        print(f"  (log_run failed: {e})")


def load_env():
    # Reads from real process env vars (set directly on the Render service), not the local
    # .env.lighter file -- that file is gitignored and never reaches the deployed worker.
    return {
        "LIGHTER_ACCOUNT_INDEX": os.environ["LIGHTER_ACCOUNT_INDEX"],
        "LIGHTER_API_KEY_INDEX": os.environ["LIGHTER_API_KEY_INDEX"],
        "LIGHTER_API_PRIVATE_KEY": os.environ["LIGHTER_API_PRIVATE_KEY"],
    }


def price_to_int(p):
    return int(round(p * 1000))


def fetch_candles(count=60):
    end_ms = int(time.time() * 1000)
    url = f"{BASE_URL}/api/v1/candles?market_id={MARKET_INDEX}&resolution=1m&start_timestamp=0&end_timestamp={end_ms}&count_back={count}"
    with urllib.request.urlopen(url, timeout=15) as resp:
        data = jsonlib.loads(resp.read())
    candles = sorted(data.get("c", []), key=lambda c: c["t"])
    return candles


def compute_vwap_signal(candles):
    # signal uses the second-to-last candle (the last FULLY completed one -- the most recent
    # entry from fetch_candles may still be the in-progress current minute).
    if len(candles) < VWAP_WINDOW + 2:
        return None, None
    closed = candles[:-1]
    window = closed[-VWAP_WINDOW:]
    num = sum(((c["h"] + c["l"] + c["c"]) / 3) * c["v"] for c in window)
    den = sum(c["v"] for c in window)
    if den <= 0:
        return None, closed[-1]["t"]
    vwap = num / den
    close = closed[-1]["c"]
    if close < vwap:
        return "long", closed[-1]["t"]
    if close > vwap:
        return "short", closed[-1]["t"]
    return None, closed[-1]["t"]


async def get_client():
    env = load_env()
    client = lighter.SignerClient(
        url=BASE_URL, account_index=int(env["LIGHTER_ACCOUNT_INDEX"]),
        api_private_keys={int(env["LIGHTER_API_KEY_INDEX"]): env["LIGHTER_API_PRIVATE_KEY"]},
    )
    return client


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


async def market_order(client, is_ask, base_amount_sol, reduce_only, ref_price):
    band = ref_price * (0.995 if is_ask else 1.005)
    exec_price = price_to_int(band)
    base_amount_int = int(round(base_amount_sol * 1000))
    co_idx = int(time.time() * 1000) % 500_000_000
    order, resp, err = await client.create_market_order(
        market_index=MARKET_INDEX, client_order_index=co_idx, base_amount=base_amount_int,
        avg_execution_price=exec_price, is_ask=is_ask, reduce_only=reduce_only,
    )
    return err


async def place_oco(client, side, base_amount_sol, entry_price):
    is_ask = 1 if side == "long" else 0
    base_amount_int = int(round(base_amount_sol * 1000))
    co_base = int(time.time() * 1000) % 500_000_000
    if side == "long":
        tp_trigger = price_to_int(entry_price * (1 + TP_PCT / 100))
        tp_exec = price_to_int(entry_price * (1 + TP_PCT / 100 * 0.98))
        sl_trigger = price_to_int(entry_price * (1 - SL_PCT / 100))
        sl_exec = price_to_int(entry_price * (1 - SL_PCT / 100 - 0.0005))
    else:
        tp_trigger = price_to_int(entry_price * (1 - TP_PCT / 100))
        tp_exec = price_to_int(entry_price * (1 - TP_PCT / 100 * 0.98))
        sl_trigger = price_to_int(entry_price * (1 + SL_PCT / 100))
        sl_exec = price_to_int(entry_price * (1 + SL_PCT / 100 + 0.0005))
    tp_leg = lighter.signer_client.CreateOrderTxReq(
        MarketIndex=MARKET_INDEX, ClientOrderIndex=co_base + 1, BaseAmount=base_amount_int,
        Price=tp_exec, IsAsk=is_ask, Type=client.ORDER_TYPE_TAKE_PROFIT,
        TimeInForce=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL, ReduceOnly=1,
        TriggerPrice=tp_trigger, OrderExpiry=client.DEFAULT_28_DAY_ORDER_EXPIRY,
    )
    sl_leg = lighter.signer_client.CreateOrderTxReq(
        MarketIndex=MARKET_INDEX, ClientOrderIndex=co_base + 2, BaseAmount=base_amount_int,
        Price=sl_exec, IsAsk=is_ask, Type=client.ORDER_TYPE_STOP_LOSS,
        TimeInForce=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL, ReduceOnly=1,
        TriggerPrice=sl_trigger, OrderExpiry=client.DEFAULT_28_DAY_ORDER_EXPIRY,
    )
    group, resp, err = await client.create_grouped_orders(
        grouping_type=client.GROUPING_TYPE_ONE_CANCELS_THE_OTHER, orders=[tp_leg, sl_leg],
    )
    return err


async def cancel_all(client):
    tx, resp, err = await client.cancel_all_orders(
        time_in_force=client.CANCEL_ALL_TIF_IMMEDIATE, timestamp_ms=0, cancel_all_market_index=MARKET_INDEX,
    )
    return err


def current_base_size(state, best_price):
    equity = state["seed_usd"] + state["realized_pnl_usd"]
    return round(equity / best_price, 3)


async def tick():
    env = load_env()
    account_index = int(env["LIGHTER_ACCOUNT_INDEX"])
    client = await get_client()
    try:
        state = get_state()
        candles = fetch_candles()
        signal, candle_ts = compute_vwap_signal(candles)
        if candle_ts is None or candle_ts == state.get("last_processed_candle_ts"):
            return  # nothing new to act on

        real_pos, collateral = await get_position(client, account_index)
        held_side = state.get("side")

        # Reconcile: if we think we're holding but the real position is flat, the OCO already
        # fired since our last check. Real PnL = current collateral minus the collateral snapshot
        # taken right before this entry -- exact, since Lighter's own ledger already reflects the
        # real fill price/slippage on both legs, no need to estimate from best_bid/ask.
        if held_side is not None and abs(real_pos) < 0.01:
            prior_collateral = state.get("collateral_before_entry")
            pnl = (collateral - prior_collateral) if prior_collateral is not None else 0.0
            entry_price = state["entry_price"]
            base_amount = state["base_amount_sol"]
            implied_exit = entry_price + pnl / base_amount if held_side == "long" else entry_price - pnl / base_amount
            log_trade(held_side, entry_price, implied_exit, base_amount, pnl, "OCO", state.get("updated_at") or "1970-01-01")
            log_run("oco_resolved_externally", {"held_side": held_side, "real_pos": real_pos, "pnl": pnl})
            update_state({
                "side": None, "entry_price": None, "base_amount_sol": None,
                "realized_pnl_usd": state["realized_pnl_usd"] + pnl,
            })
            state["realized_pnl_usd"] += pnl
            held_side = None

        ob_url = f"{BASE_URL}/api/v1/orderBookOrders?market_id={MARKET_INDEX}&limit=1"
        with urllib.request.urlopen(ob_url, timeout=15) as resp:
            ob = jsonlib.loads(resp.read())
        best_bid = float(ob["bids"][0]["price"])
        best_ask = float(ob["asks"][0]["price"])
        mid = (best_bid + best_ask) / 2

        if held_side is None:
            if signal is not None:
                base_amount = current_base_size(state, mid)
                err = await market_order(client, is_ask=(signal == "short"), base_amount_sol=base_amount, reduce_only=False, ref_price=(best_ask if signal == "long" else best_bid))
                if err:
                    log_run("enter_failed", {"signal": signal, "error": str(err)})
                else:
                    await asyncio.sleep(1.5)
                    _, collateral_after_entry = await get_position(client, account_index)
                    entry_price = best_ask if signal == "long" else best_bid
                    err2 = await place_oco(client, signal, base_amount, entry_price)
                    update_state({
                        "side": signal, "entry_price": entry_price, "base_amount_sol": base_amount,
                        "collateral_before_entry": collateral_after_entry, "last_processed_candle_ts": candle_ts,
                    })
                    log_run("entered", {"signal": signal, "entry_price": entry_price, "base_amount": base_amount, "oco_error": str(err2) if err2 else None})
        elif signal is not None and signal != held_side:
            entry_price = state["entry_price"]
            base_amount = state["base_amount_sol"]
            prior_collateral = state.get("collateral_before_entry")
            await cancel_all(client)
            close_is_ask = (held_side == "long")
            await market_order(client, is_ask=close_is_ask, base_amount_sol=base_amount, reduce_only=True, ref_price=(best_bid if close_is_ask else best_ask))
            await asyncio.sleep(1.5)
            _, collateral_after_close = await get_position(client, account_index)
            pnl = (collateral_after_close - prior_collateral) if prior_collateral is not None else 0.0
            exit_price = entry_price + pnl / base_amount if held_side == "long" else entry_price - pnl / base_amount
            log_trade(held_side, entry_price, exit_price, base_amount, pnl, "REVERSAL", state.get("updated_at") or "1970-01-01")

            new_realized_pnl = state["realized_pnl_usd"] + pnl
            new_base_amount = current_base_size({"seed_usd": state["seed_usd"], "realized_pnl_usd": new_realized_pnl}, mid)
            new_entry_price = best_ask if signal == "long" else best_bid
            await market_order(client, is_ask=(signal == "short"), base_amount_sol=new_base_amount, reduce_only=False, ref_price=new_entry_price)
            await asyncio.sleep(1.5)
            _, collateral_after_new_entry = await get_position(client, account_index)
            await place_oco(client, signal, new_base_amount, new_entry_price)
            update_state({
                "side": signal, "entry_price": new_entry_price, "base_amount_sol": new_base_amount,
                "collateral_before_entry": collateral_after_new_entry,
                "realized_pnl_usd": new_realized_pnl, "last_processed_candle_ts": candle_ts,
            })
            log_run("reversed", {"from": held_side, "to": signal, "pnl": pnl})
        else:
            update_state({"last_processed_candle_ts": candle_ts})
    finally:
        await client.api_client.close()


async def main():
    print("Lighter OCO bot starting (SOL, VWAP15 mean-reversion, TP=1.5%/SL=0.03%, real money, $20 seed)")
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

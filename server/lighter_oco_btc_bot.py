"""
Real-money Lighter BTC bot -- "OCO BTC". Same strategy/mechanics as lighter_oco_bot.py (SOL),
pointed at BTC instead: VWAP 15m mean-reversion, band=0%, TP=1.5%/SL=0.03%, real OCO bracket
exits. Moved to BTC after the SOL version's real stop-outs showed ~0.01pp of slippage beyond the
0.03% trigger -- BTC's quoted spread is ~50x tighter (0.00014% vs SOL's 0.006-0.008%), so this is
the empirical test of whether that liquidity advantage actually holds up in real execution.

Only difference from the SOL bot: MARKET_INDEX=1 (BTC), and price/size integer scaling matches
BTC's own market spec (price_decimals=1 -> x10, size_decimals=5 -> x100000, vs SOL's x1000/x1000).
Separate Supabase tables (lighter_oco_btc_*) so this doesn't touch the paused SOL bot's state.
"""
import asyncio
import os
import time
import urllib.request
import json as jsonlib

import lighter

MARKET_INDEX = 1  # BTC
BASE_URL = "https://mainnet.zklighter.elliot.ai"
VWAP_WINDOW = 15
TP_PCT = 1.5
SL_PCT = 0.03
POLL_SECONDS = 15
PRICE_DECIMALS = 1   # BTC market spec: supported_price_decimals
SIZE_DECIMALS = 5    # BTC market spec: supported_size_decimals

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
    rows = sb_request("GET", "lighter_oco_btc_state?id=eq.1")
    return rows[0]


def update_state(patch):
    sb_request("PATCH", "lighter_oco_btc_state?id=eq.1", patch)


def log_trade(side, entry_price, exit_price, base_amount_btc, pnl_usd, reason, opened_at):
    sb_request("POST", "lighter_oco_btc_trades", {
        "side": side, "entry_price": entry_price, "exit_price": exit_price,
        "base_amount_btc": base_amount_btc, "pnl_usd": pnl_usd, "reason": reason,
        "opened_at": opened_at,
    })


def log_run(action, detail):
    try:
        sb_request("POST", "lighter_oco_btc_runs", {"action": action, "detail": detail})
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


def fetch_candles(count=60):
    end_ms = int(time.time() * 1000)
    url = f"{BASE_URL}/api/v1/candles?market_id={MARKET_INDEX}&resolution=1m&start_timestamp=0&end_timestamp={end_ms}&count_back={count}"
    with urllib.request.urlopen(url, timeout=15) as resp:
        data = jsonlib.loads(resp.read())
    candles = sorted(data.get("c", []), key=lambda c: c["t"])
    return candles


def compute_vwap_signal(candles):
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


async def market_order(client, is_ask, base_amount, reduce_only, ref_price):
    band = ref_price * (0.995 if is_ask else 1.005)
    exec_price = price_to_int(band)
    base_amount_int = int(round(base_amount * (10 ** SIZE_DECIMALS)))
    co_idx = int(time.time() * 1000) % 500_000_000
    order, resp, err = await client.create_market_order(
        market_index=MARKET_INDEX, client_order_index=co_idx, base_amount=base_amount_int,
        avg_execution_price=exec_price, is_ask=is_ask, reduce_only=reduce_only,
    )
    return err


async def place_oco(client, side, base_amount, entry_price):
    is_ask = 1 if side == "long" else 0
    base_amount_int = int(round(base_amount * (10 ** SIZE_DECIMALS)))
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
    return round(equity / best_price, SIZE_DECIMALS)


async def tick():
    env = load_env()
    account_index = int(env["LIGHTER_ACCOUNT_INDEX"])
    client = await get_client()
    try:
        state = get_state()
        candles = fetch_candles()
        signal, candle_ts = compute_vwap_signal(candles)
        if candle_ts is None or candle_ts == state.get("last_processed_candle_ts"):
            return

        real_pos, collateral = await get_position(client, account_index)
        held_side = state.get("side")

        if held_side is not None and abs(real_pos) < 0.000001:
            prior_collateral = state.get("collateral_before_entry")
            pnl = (collateral - prior_collateral) if prior_collateral is not None else 0.0
            entry_price = state["entry_price"]
            base_amount = state["base_amount_btc"]
            implied_exit = entry_price + pnl / base_amount if held_side == "long" else entry_price - pnl / base_amount
            log_trade(held_side, entry_price, implied_exit, base_amount, pnl, "OCO", state.get("updated_at") or "1970-01-01")
            log_run("oco_resolved_externally", {"held_side": held_side, "real_pos": real_pos, "pnl": pnl})
            update_state({
                "side": None, "entry_price": None, "base_amount_btc": None,
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
                err = await market_order(client, is_ask=(signal == "short"), base_amount=base_amount, reduce_only=False, ref_price=(best_ask if signal == "long" else best_bid))
                if err:
                    log_run("enter_failed", {"signal": signal, "error": str(err)})
                else:
                    await asyncio.sleep(1.5)
                    _, collateral_after_entry = await get_position(client, account_index)
                    entry_price = best_ask if signal == "long" else best_bid
                    err2 = await place_oco(client, signal, base_amount, entry_price)
                    update_state({
                        "side": signal, "entry_price": entry_price, "base_amount_btc": base_amount,
                        "collateral_before_entry": collateral_after_entry, "last_processed_candle_ts": candle_ts,
                    })
                    log_run("entered", {"signal": signal, "entry_price": entry_price, "base_amount": base_amount, "oco_error": str(err2) if err2 else None})
        elif signal is not None and signal != held_side:
            entry_price = state["entry_price"]
            base_amount = state["base_amount_btc"]
            prior_collateral = state.get("collateral_before_entry")
            await cancel_all(client)
            close_is_ask = (held_side == "long")
            await market_order(client, is_ask=close_is_ask, base_amount=base_amount, reduce_only=True, ref_price=(best_bid if close_is_ask else best_ask))
            await asyncio.sleep(1.5)
            _, collateral_after_close = await get_position(client, account_index)
            pnl = (collateral_after_close - prior_collateral) if prior_collateral is not None else 0.0
            exit_price = entry_price + pnl / base_amount if held_side == "long" else entry_price - pnl / base_amount
            log_trade(held_side, entry_price, exit_price, base_amount, pnl, "REVERSAL", state.get("updated_at") or "1970-01-01")

            new_realized_pnl = state["realized_pnl_usd"] + pnl
            new_base_amount = current_base_size({"seed_usd": state["seed_usd"], "realized_pnl_usd": new_realized_pnl}, mid)
            new_entry_price = best_ask if signal == "long" else best_bid
            await market_order(client, is_ask=(signal == "short"), base_amount=new_base_amount, reduce_only=False, ref_price=new_entry_price)
            await asyncio.sleep(1.5)
            _, collateral_after_new_entry = await get_position(client, account_index)
            await place_oco(client, signal, new_base_amount, new_entry_price)
            update_state({
                "side": signal, "entry_price": new_entry_price, "base_amount_btc": new_base_amount,
                "collateral_before_entry": collateral_after_new_entry,
                "realized_pnl_usd": new_realized_pnl, "last_processed_candle_ts": candle_ts,
            })
            log_run("reversed", {"from": held_side, "to": signal, "pnl": pnl})
        else:
            update_state({"last_processed_candle_ts": candle_ts})
    finally:
        await client.api_client.close()


async def main():
    print("Lighter OCO bot starting (BTC, VWAP15 mean-reversion, TP=1.5%/SL=0.03%, real money, $20 seed)")
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

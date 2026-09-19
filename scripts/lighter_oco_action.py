"""
Lighter SOL order-execution helper for the OCO bot -- invoked as a subprocess from the
trigger.dev job (trigger/live-bot-oco-sol.ts), which does signal computation and scheduling in TS
and shells out here only for actual order placement/account queries. Uses the official Python
lighter-sdk (already validated this session with real orders: real open + real OCO exit,
confirmed working end to end) rather than the third-party TS SDK, whose createGroupedOrders() hit
an unresolved native-binding bug ("Unexpected Object value, expected array").

Usage: python3 scripts/lighter_oco_action.py <action> [args as JSON on argv[2]]
Actions:
  get_state                                  -> {pos, collateral, best_bid, best_ask}
  enter <side> <base_amount_sol>             -> market order, side="long"|"short"
  close <base_amount_sol> <side>             -> market order closing an existing position (side = side being closed)
  place_oco <base_amount_sol> <side> <tp_pct> <sl_pct>  -> real OCO bracket to close a position
All output is a single JSON line on stdout. Errors go to stdout too as {"error": "..."} (exit code 1).
"""
import asyncio
import json
import sys

import lighter

MARKET_INDEX = 2  # SOL
BASE_URL = "https://mainnet.zklighter.elliot.ai"


def load_env():
    env = {}
    with open(".env.lighter") as f:
        for line in f:
            line = line.strip()
            if not line or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k] = v
    return env


def price_to_int(p):
    return int(round(p * 1000))


async def get_client():
    env = load_env()
    account_index = int(env["LIGHTER_ACCOUNT_INDEX"])
    api_key_index = int(env["LIGHTER_API_KEY_INDEX"])
    api_private_key = env["LIGHTER_API_PRIVATE_KEY"]
    client = lighter.SignerClient(url=BASE_URL, account_index=account_index, api_private_keys={api_key_index: api_private_key})
    return client, account_index


async def get_position(client, account_index):
    acct = await client.account_api.account(by="index", value=str(account_index)) if hasattr(client, "account_api") else None
    return acct


async def fetch_position_and_book():
    client, account_index = await get_client()
    account_api = lighter.AccountApi(client.api_client)
    acct = await account_api.account(by="index", value=str(account_index))
    a = acct.accounts[0]
    pos = 0.0
    for p in a.positions:
        if p.market_id == MARKET_INDEX:
            sign = 1 if str(getattr(p, "sign", 1)) in ("1", "True", "true") else -1
            pos = sign * float(p.position)
    ob = await client.order_api.order_book_orders(MARKET_INDEX, 1)
    result = {
        "pos": pos,
        "collateral": float(a.collateral),
        "best_bid": float(ob.bids[0].price),
        "best_ask": float(ob.asks[0].price),
    }
    await client.api_client.close()
    return result


async def do_enter(side, base_amount_sol):
    client, account_index = await get_client()
    is_ask = 0 if side == "long" else 1
    ob = await client.order_api.order_book_orders(MARKET_INDEX, 1)
    best_ask = float(ob.asks[0].price)
    best_bid = float(ob.bids[0].price)
    ref_price = best_ask if side == "long" else best_bid
    band = ref_price * (1.005 if side == "long" else 0.995)
    exec_price = price_to_int(band)
    base_amount_int = int(round(base_amount_sol * 1000))
    co_idx = int(__import__("time").time() * 1000) % 500_000_000
    order, resp, err = await client.create_market_order(
        market_index=MARKET_INDEX, client_order_index=co_idx, base_amount=base_amount_int,
        avg_execution_price=exec_price, is_ask=is_ask, reduce_only=False,
    )
    await client.api_client.close()
    if err:
        return {"error": str(err)}
    return {"ok": True, "tx_hash": str(resp)}


async def do_close(base_amount_sol, side):
    # side = the side currently held (being closed) -- so a close on a long is a sell (is_ask=1)
    client, account_index = await get_client()
    is_ask = 1 if side == "long" else 0
    ob = await client.order_api.order_book_orders(MARKET_INDEX, 1)
    best_bid = float(ob.bids[0].price)
    best_ask = float(ob.asks[0].price)
    ref_price = best_bid if side == "long" else best_ask
    band = ref_price * (0.995 if side == "long" else 1.005)
    exec_price = price_to_int(band)
    base_amount_int = int(round(base_amount_sol * 1000))
    co_idx = int(__import__("time").time() * 1000) % 500_000_000
    order, resp, err = await client.create_market_order(
        market_index=MARKET_INDEX, client_order_index=co_idx, base_amount=base_amount_int,
        avg_execution_price=exec_price, is_ask=is_ask, reduce_only=True,
    )
    await client.api_client.close()
    if err:
        return {"error": str(err)}
    return {"ok": True, "tx_hash": str(resp)}


async def do_place_oco(base_amount_sol, side, tp_pct, sl_pct, entry_price):
    # side = side currently held; the OCO closes it, so is_ask is opposite of entry direction
    client, account_index = await get_client()
    is_ask = 1 if side == "long" else 0
    base_amount_int = int(round(base_amount_sol * 1000))
    co_base = int(__import__("time").time() * 1000) % 500_000_000

    if side == "long":
        tp_trigger = price_to_int(entry_price * (1 + tp_pct / 100))
        tp_exec = price_to_int(entry_price * (1 + tp_pct / 100 * 0.98))
        sl_trigger = price_to_int(entry_price * (1 - sl_pct / 100))
        sl_exec = price_to_int(entry_price * (1 - sl_pct / 100 - 0.0005))
    else:
        tp_trigger = price_to_int(entry_price * (1 - tp_pct / 100))
        tp_exec = price_to_int(entry_price * (1 - tp_pct / 100 * 0.98))
        sl_trigger = price_to_int(entry_price * (1 + sl_pct / 100))
        sl_exec = price_to_int(entry_price * (1 + sl_pct / 100 + 0.0005))

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
    await client.api_client.close()
    if err:
        return {"error": str(err)}
    return {"ok": True, "tx_hash": str(resp), "tp_trigger": tp_trigger / 1000, "sl_trigger": sl_trigger / 1000}


async def do_cancel_all():
    client, account_index = await get_client()
    tx, resp, err = await client.cancel_all_orders(
        time_in_force=client.CANCEL_ALL_TIF_IMMEDIATE, timestamp_ms=0, cancel_all_market_index=MARKET_INDEX,
    )
    await client.api_client.close()
    if err:
        return {"error": str(err)}
    return {"ok": True}


async def main():
    action = sys.argv[1]
    if action == "get_state":
        result = await fetch_position_and_book()
    elif action == "enter":
        result = await do_enter(sys.argv[2], float(sys.argv[3]))
    elif action == "close":
        result = await do_close(float(sys.argv[2]), sys.argv[3])
    elif action == "place_oco":
        result = await do_place_oco(float(sys.argv[2]), sys.argv[3], float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6]))
    elif action == "cancel_all":
        result = await do_cancel_all()
    else:
        result = {"error": f"unknown action {action}"}
    print(json.dumps(result))
    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

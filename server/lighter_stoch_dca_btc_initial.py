"""
Real-money Lighter BTC bot -- "Stochastic5 + 1:2:4 DCA", INITIAL settings variant.

WebSocket-based (2026-09-21): order book + account/position come from a persistent WS
subscription instead of REST polling every tick, which was hitting Lighter's rate limit.
Candles remain on REST (no WS candle stream exists) but are fetched once per minute, aligned
just after each minute boundary, since candle data can't change faster than that. Adapted
from Worker 2's fixed WS architecture (2026-09-21) -- INITIAL keeps its own settings
(entry 20/80, reversal 20/80, TP 0.10%, SL 0.10% off first entry (fixed), DCA off).
"""
import asyncio
import os
import time
import urllib.request
import json as jsonlib
from datetime import datetime, timezone

import lighter

MARKET_INDEX = 1  # BTC
BASE_URL = "https://mainnet.zklighter.elliot.ai"
TICK_SECONDS = 0.5   # decision loop cadence -- cheap now, reads cache only, no REST per tick
PRICE_DECIMALS = 1
SIZE_DECIMALS = 5

STOCH_WINDOW = 9
DCA_TRIGGER_1_PCT = 0.06
DCA_TRIGGER_2_PCT = 0.12
LEG_FRACTIONS = [1.0]
TP_PCT = 0.10
SL_PCT = 0.11
DCA_ENABLED = False

ENTRY_LO, ENTRY_HI = 25, 75
REVERSAL_LO, REVERSAL_HI = 20, 80

TABLE_STATE = "lighter_btc_initial_state"
TABLE_TRADES = "lighter_btc_initial_trades"
TABLE_RUNS = "lighter_btc_initial_runs"

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


def compute_stoch_signal(candles):
    if len(candles) < STOCH_WINDOW + 2:
        return None, None, None
    closed = candles[:-1]
    window = closed[-STOCH_WINDOW:]
    hh = max(c["h"] for c in window)
    ll = min(c["l"] for c in window)
    ts = closed[-1]["t"]
    if hh == ll:
        return None, None, ts
    k = 100 * (closed[-1]["c"] - ll) / (hh - ll)
    return _sig(k, ENTRY_LO, ENTRY_HI), _sig(k, REVERSAL_LO, REVERSAL_HI), ts


# ── Live state cache, fed by the WebSocket ──────────────────────────────────────────────────
class LiveState:
    def __init__(self, account_index):
        self.account_key = str(account_index)
        self.market_key = str(MARKET_INDEX)
        self.order_book = {}   # {"bids": [{"price":..,"size":..}], "asks": [...]}
        self.account = {}      # raw account_all message
        self.ob_updated_at = 0.0
        self.acct_updated_at = 0.0

    def on_order_book(self, market_id, state):
        if str(market_id) == self.market_key:
            self.order_book = state
            self.ob_updated_at = time.time()

    def on_account(self, account_id, state):
        if str(account_id) != self.account_key:
            return
        # Merge, don't replace: a message that carries a field as an explicit null must not
        # wipe out previously-known-good data for that field (this produced a corrupted
        # collateral reading -> a fake ~$100 "loss" logged, fixed 2026-09-21). Only overwrite
        # keys the message actually provides a non-null value for.
        for k, v in state.items():
            if v is not None:
                self.account[k] = v
        self.acct_updated_at = time.time()

    def best_bid_ask(self):
        bids = self.order_book.get("bids") or []
        asks = self.order_book.get("asks") or []
        if not bids or not asks:
            return None, None
        return max(float(b["price"]) for b in bids), min(float(a["price"]) for a in asks)

    def position_collateral(self):
        if not self.account:
            return None, None
        # NOTE: use `or {}`, not `.get(key, {})` -- some WS messages carry these keys as an
        # explicit null rather than omitting them, and dict.get()'s default only applies when
        # the key is *absent*, not when its value is None. This caused a crash mid-tick that
        # left state in limbo, later misread as an "EXTERNAL" close (fixed 2026-09-21).
        positions = self.account.get("positions") or {}
        pos_raw = positions.get(self.market_key) or {}
        sign = 1 if str(pos_raw.get("sign", 1)) in ("1", "True", "true") else -1
        pos = sign * float(pos_raw.get("position", 0) or 0)
        collateral = None  # None (not 0.0) if we never actually found a USDC entry -- a
        # fabricated 0.0 here previously got treated as "account emptied", wiping out the
        # tracked realized PnL on the next close (fixed 2026-09-21).
        assets = self.account.get("assets") or {}
        for asset in assets.values():
            if asset.get("symbol") == "USDC":
                collateral = float(asset.get("margin_balance", 0) or 0)
                break
        return pos, collateral

    def is_fresh(self, max_age=10.0):
        now = time.time()
        return (now - self.ob_updated_at < max_age) and (now - self.acct_updated_at < max_age)


async def run_ws_forever(live, account_index):
    # Reconnects automatically if the connection drops; runs for the life of the process.
    while True:
        try:
            ws = lighter.WsClient(
                order_book_ids=[MARKET_INDEX], account_ids=[account_index],
                on_order_book_update=live.on_order_book, on_account_update=live.on_account,
            )
            await ws.run_async()
        except Exception as e:
            log_run("ws_disconnected", {"error": str(e)})
            await asyncio.sleep(2)


candles_cache = {"data": [], "updated_at": 0}


async def run_candle_refresh_forever():
    try:
        candles_cache["data"] = fetch_candles()
        candles_cache["updated_at"] = time.time()
    except Exception as e:
        log_run("candle_fetch_failed", {"error": str(e)})
    while True:
        now = time.time()
        next_boundary = (int(now // 60) + 1) * 60 + 1.5  # 1.5s after the minute rolls over
        await asyncio.sleep(max(1.0, next_boundary - now))
        try:
            candles_cache["data"] = fetch_candles()
            candles_cache["updated_at"] = time.time()
        except Exception as e:
            log_run("candle_fetch_failed", {"error": str(e)})


async def get_client():
    env = load_env()
    return lighter.SignerClient(
        url=BASE_URL, account_index=int(env["LIGHTER_ACCOUNT_INDEX"]),
        api_private_keys={int(env["LIGHTER_API_KEY_INDEX"]): env["LIGHTER_API_PRIVATE_KEY"]},
    )


async def get_position_rest(client, account_index):
    # Fallback only -- used if the WS cache isn't fresh (startup grace period or a disconnect).
    account_api = lighter.AccountApi(client.api_client)
    acct = await account_api.account(by="index", value=str(account_index))
    a = acct.accounts[0]
    pos = 0.0
    for p in a.positions:
        if p.market_id == MARKET_INDEX:
            sign = 1 if str(getattr(p, "sign", 1)) in ("1", "True", "true") else -1
            pos = sign * float(p.position)
    return pos, float(a.collateral)


async def read_position(client, live, account_index):
    if live.is_fresh():
        pos, collateral = live.position_collateral()
        if pos is not None and collateral is not None:
            return pos, collateral
    return await get_position_rest(client, account_index)


async def confirm_fill(client, account_index, want_nonzero, tries=4, delay=1.5):
    # Safety-critical check: did an order we just placed actually change the real position?
    # Always uses a direct REST read (authoritative, synchronous) rather than the WS cache --
    # the WS account broadcast lagging behind a real fill by more than one check window is
    # exactly what caused 19 real entries to stack into one ~$1900 position on 2026-09-21,
    # because each attempt wrongly concluded "didn't fill" and retried. Polls a few times
    # before giving up, instead of trusting a single read.
    for attempt in range(tries):
        pos, collateral = await get_position_rest(client, account_index)
        is_nonzero = abs(pos) > 0.000001
        if is_nonzero == want_nonzero:
            return pos, collateral, True
        if attempt < tries - 1:
            await asyncio.sleep(delay)
    return pos, collateral, False


async def market_order(client, is_ask, base_amount, reduce_only, ref_price):
    band = ref_price * (0.9995 if is_ask else 1.0005)  # tight band -- prefer no fill over a bad fill
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


async def tick(client, live, account_index):
    state = get_state()
    candles = candles_cache["data"]
    entry_signal, reversal_signal, candle_ts = compute_stoch_signal(candles)
    latest_closed = candles[-2] if len(candles) >= 2 else None
    now_open = candles[-1]["o"] if candles else None
    now_ms = candles[-1]["t"] if candles else int(time.time() * 1000)

    if candle_ts is None or now_open is None:
        return

    real_pos, collateral = await read_position(client, live, account_index)
    if real_pos is None:
        return  # no position/account data yet, skip this tick

    side = state.get("side")
    legs = state.get("legs") or []

    # Reconcile: OCO or something external already flattened us. Re-verify with a real REST
    # read before trusting this -- the top-of-tick read above can be WS-stale, and this exact
    # single-read pattern is what corrupted state before (2026-09-21). This fires on every tick,
    # not just after our own orders, so it needs the same authoritative check.
    if side is not None and abs(real_pos) < 0.000001:
        real_pos, collateral, confirmed_flat = await confirm_fill(client, account_index, want_nonzero=False, tries=2, delay=1.0)
        if not confirmed_flat:
            return  # actually still open (was a stale read) -- try again next tick
        prior_collateral = state.get("collateral_before_entry")
        pnl = (collateral - prior_collateral) if prior_collateral is not None else 0.0
        ae = avg_entry(legs) or state.get("first_entry_price")
        qty = total_qty(legs) or 0.0001
        implied_exit = ae + pnl / qty if side == "long" else ae - pnl / qty
        update_state({"side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
                      "dca_level": 0, "realized_pnl_usd": state["realized_pnl_usd"] + pnl})
        log_trade(side, ae, implied_exit, qty, pnl, "EXTERNAL", len(legs), ms_to_iso(state.get("first_entry_time")))
        log_run("resolved_externally", {"side": side, "pnl": pnl})
        state["realized_pnl_usd"] += pnl
        side = None
        legs = []

    # Resync: real position open but doesn't match tracked size
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

    best_bid, best_ask = live.best_bid_ask()
    if best_bid is None or best_ask is None:
        return  # order book not ready yet, skip this tick

    async def close_all(reason, real_exit_ref):
        nonlocal side, legs, state
        prior_collateral = state.get("collateral_before_entry")
        qty = total_qty(legs)
        is_ask = (side == "long")
        await cancel_all(client)
        err = await market_order(client, is_ask=is_ask, base_amount=qty, reduce_only=True,
                                  ref_price=(best_bid if is_ask else best_ask))
        if err:
            log_run("close_failed", {"reason": reason, "error": str(err)})
            return False
        real_pos_after, collateral_after, confirmed = await confirm_fill(client, account_index, want_nonzero=False)
        if not confirmed:
            log_run("close_incomplete", {"reason": reason, "remaining_qty": real_pos_after})
            return False
        pnl = (collateral_after - prior_collateral) if prior_collateral is not None else 0.0
        ae = avg_entry(legs)
        exit_price = ae + pnl / qty if side == "long" else ae - pnl / qty
        new_pnl = state["realized_pnl_usd"] + pnl
        update_state({"side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
                      "dca_level": 0, "realized_pnl_usd": new_pnl, "last_processed_candle_ts": candle_ts})
        log_trade(side, ae, exit_price, qty, pnl, reason, len(legs), ms_to_iso(state.get("first_entry_time")))
        log_run("closed", {"reason": reason, "pnl": pnl, "side": side})
        state["realized_pnl_usd"] = new_pnl
        side = None
        legs = []
        return True

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
            fail_count = state.get("consecutive_entry_failures", 0) or 0
            eq = equity_now(state)
            if closed_ok and state.get("enabled") and fail_count < 3 and eq > 0:
                leg_usd = eq * LEG_FRACTIONS[0]
                price = best_ask if reversal_signal == "long" else best_bid
                err = await market_order(client, is_ask=(reversal_signal == "short"), base_amount=leg_usd / price, reduce_only=False, ref_price=price)
                if err:
                    log_run("reversal_enter_failed", {"signal": reversal_signal, "error": str(err)})
                    update_state({"consecutive_entry_failures": fail_count + 1})
                else:
                    real_pos_after, collateral_after, confirmed = await confirm_fill(client, account_index, want_nonzero=True)
                    if not confirmed:
                        log_run("reversal_enter_no_fill", {"signal": reversal_signal, "fail_count": fail_count + 1})
                        update_state({"consecutive_entry_failures": fail_count + 1})
                    else:
                        update_state({"side": reversal_signal, "legs": [{"price": price, "usd_size": leg_usd}],
                                      "consecutive_entry_failures": 0,
                                      "first_entry_price": price, "first_entry_time": now_ms, "dca_level": 0,
                                      "collateral_before_entry": collateral_after, "last_processed_candle_ts": candle_ts})
                        log_run("entered", {"signal": reversal_signal, "price": price, "via": "reversal"})
            elif closed_ok and fail_count >= 3:
                log_run("entry_circuit_breaker", {"signal": reversal_signal, "fail_count": fail_count, "via": "reversal"})
                update_state({"enabled": False})
            elif closed_ok and eq <= 0:
                log_run("equity_non_positive", {"eq": eq, "via": "reversal"})
                update_state({"enabled": False})
        else:
            next_level = state.get("dca_level", 0) + 1
            if DCA_ENABLED and next_level <= 2 and latest_closed is not None:
                trigger_pct = DCA_TRIGGER_1_PCT if next_level == 1 else DCA_TRIGGER_2_PCT
                fe = state["first_entry_price"]
                level_price = fe * (1 - trigger_pct / 100) if side == "long" else fe * (1 + trigger_pct / 100)
                prev_close_passes = (latest_closed["c"] <= level_price) if side == "long" else (latest_closed["c"] >= level_price)
                open_passes = (now_open <= level_price) if side == "long" else (now_open >= level_price)
                signal_favors = (reversal_signal != ("short" if side == "long" else "long"))
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
        if abs(real_pos) > 0.000001:
            adopted_side = "long" if real_pos > 0 else "short"
            price = best_ask if adopted_side == "long" else best_bid
            update_state({"side": adopted_side, "legs": [{"price": price, "usd_size": price * abs(real_pos)}],
                          "first_entry_price": price, "first_entry_time": now_ms, "dca_level": 0,
                          "collateral_before_entry": collateral, "last_processed_candle_ts": candle_ts})
            log_run("adopted_orphan_position", {"side": adopted_side, "qty": abs(real_pos)})
        elif entry_signal is not None and state.get("enabled"):
            fail_count = state.get("consecutive_entry_failures", 0) or 0
            if fail_count >= 3:
                # Hard stop: something is wrong (this is exactly the pattern that stacked 19
                # real entries into one ~$1900 position on 2026-09-21) -- disable rather than
                # keep retrying, and require a human to look before it trades again.
                log_run("entry_circuit_breaker", {"signal": entry_signal, "fail_count": fail_count})
                update_state({"enabled": False, "last_processed_candle_ts": candle_ts})
                return
            eq = equity_now(state)
            if eq <= 0:
                log_run("equity_non_positive", {"eq": eq})
                update_state({"enabled": False, "last_processed_candle_ts": candle_ts})
                return
            leg_usd = eq * LEG_FRACTIONS[0]
            price = best_ask if entry_signal == "long" else best_bid
            err = await market_order(client, is_ask=(entry_signal == "short"), base_amount=leg_usd / price, reduce_only=False, ref_price=price)
            if err:
                log_run("enter_failed", {"signal": entry_signal, "error": str(err)})
                update_state({"last_processed_candle_ts": candle_ts, "consecutive_entry_failures": fail_count + 1})
            else:
                real_pos_after, collateral_after, confirmed = await confirm_fill(client, account_index, want_nonzero=True)
                if not confirmed:
                    log_run("enter_no_fill", {"signal": entry_signal, "fail_count": fail_count + 1})
                    update_state({"last_processed_candle_ts": candle_ts, "consecutive_entry_failures": fail_count + 1})
                else:
                    update_state({"side": entry_signal, "legs": [{"price": price, "usd_size": leg_usd}],
                                  "consecutive_entry_failures": 0,
                                  "first_entry_price": price, "first_entry_time": now_ms, "dca_level": 0,
                                  "collateral_before_entry": collateral_after, "last_processed_candle_ts": candle_ts})
                    log_run("entered", {"signal": entry_signal, "price": price})
        else:
            update_state({"last_processed_candle_ts": candle_ts})


async def main():
    print("Stochastic5 DCA bot (INITIAL settings) starting (BTC, real money) [WebSocket-based]")
    env = load_env()
    account_index = int(env["LIGHTER_ACCOUNT_INDEX"])
    client = await get_client()
    live = LiveState(account_index)

    ws_task = asyncio.create_task(run_ws_forever(live, account_index))
    candle_task = asyncio.create_task(run_candle_refresh_forever())

    print("Waiting for initial WebSocket data...")
    for _ in range(20):
        if live.is_fresh():
            break
        await asyncio.sleep(0.5)
    print(f"WS ready: {live.is_fresh()}")
    log_run("started", {"ws_ready": live.is_fresh(), "mode": "websocket"})

    try:
        while True:
            try:
                await tick(client, live, account_index)
            except Exception as e:
                print(f"tick error: {e}")
                try:
                    log_run("error", {"error": str(e)})
                except Exception:
                    pass
            await asyncio.sleep(TICK_SECONDS)
    finally:
        ws_task.cancel()
        candle_task.cancel()
        await client.api_client.close()


if __name__ == "__main__":
    asyncio.run(main())

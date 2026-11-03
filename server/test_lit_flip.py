"""Tests for lit_flip_core (plain script: python3 test_lit_flip.py)."""
import lit_flip_core as F

PASS, FAIL = [], []


def check(name, ok, detail=None):
    (PASS if ok else FAIL).append(name)
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok or detail is None else f"   -> {detail}"))


def candles(closes, spread=0.5):
    return [{"h": c + spread, "l": c - spread, "c": c} for c in closes] + [{"h": 0, "l": 0, "c": 0}]   # last = forming


P = F.Params()


def t_signal():
    print("\n[range signal: top 30% -> long, bottom 30% -> short, middle -> none, short history -> none]")
    up = candles([100 + i for i in range(30)])
    check("price at the top of a rising range -> LONG", F.range_signal(up, 30, 0.30) == F.LONG)
    down = candles([100 - i for i in range(30)])
    check("price at the bottom -> SHORT", F.range_signal(down, 30, 0.30) == F.SHORT)
    mid = candles([100 + (10 if i % 2 else -10) for i in range(29)] + [100])
    check("price mid-range -> no trade", F.range_signal(mid, 30, 0.30) == 0)
    check("not enough history -> no trade", F.range_signal(candles([100] * 10), 30, 0.30) == 0)
    check("the forming candle is ignored", F.range_signal(up[:-1] + [{"h": 1, "l": 1, "c": 1}], 30, 0.30) == F.LONG)


def t_ladder():
    print("\n[ladder: $200 -> 5% x1.5 up to 3x equity = 11 trades starting at $10]")
    lad = F.ladder(200, P)
    check("first trade $10", abs(lad[0] - 10) < 1e-9, lad[:2])
    check("11 steps", len(lad) == 11, len(lad))
    check("last step <= 3x equity", lad[-1] <= 600 + 1e-9 and lad[-1] * 1.5 > 600, lad[-1])
    check("$100 -> first trade $5 is under the $10 minimum -> no trading", F.ladder(100, P) == [])


def t_orders_and_flip():
    print("\n[orders: long at $3.00 -> target sell @3.06 (reduce-only), flip SELL qty+next @2.985 (NOT reduce-only)]")
    pos = F.start(F.LONG, 3.0, 200, P)
    o = {x.kind: x for x in F.resting_orders(pos, P)}
    check("target is a reduce-only sell at +2%", o["target"].is_ask and o["target"].reduce_only and abs(o["target"].price - 3.06) < 1e-9, o["target"])
    nq = 15 / 2.985
    check("flip is ONE sell for current + next size", o["flip"].is_ask and not o["flip"].reduce_only
          and abs(o["flip"].qty - (pos.qty + nq)) < 1e-9 and abs(o["flip"].price - 2.985) < 1e-9, o["flip"])
    after = F.after_flip(pos, 2.985, P)
    check("after the flip: SHORT, next size, level 1", after.side == F.SHORT and abs(after.qty - nq) < 1e-9 and after.level == 1, after)
    o2 = {x.kind: x for x in F.resting_orders(after, P)}
    check("short's target is a BUY 2% lower", (not o2["target"].is_ask) and abs(o2["target"].price - 2.985 * 0.98) < 1e-9)
    check("short's flip is a BUY 0.5% higher", (not o2["flip"].is_ask) and abs(o2["flip"].price - 2.985 * 1.005) < 1e-9)


def t_cap_becomes_plain_stop():
    print("\n[cap: at the last ladder step the -0.5% order is a plain reduce-only stop (bust), not a flip]")
    pos = F.start(F.SHORT, 3.0, 200, P)
    for _ in range(10):
        pos = F.after_flip(pos, F.stop_price(pos, P), P)
    o = {x.kind: x for x in F.resting_orders(pos, P)}
    check("level 10 = last step", pos.level == 10, pos.level)
    check("no flip, only a reduce-only stop for the position", "flip" not in o and o["stop"].reduce_only and abs(o["stop"].qty - pos.qty) < 1e-9)


def t_no_signal_no_start():
    print("\n[start: no signal or too little money -> nothing opens]")
    check("signal 0 -> None", F.start(0, 3.0, 200, P) is None)
    check("$100 -> None", F.start(F.LONG, 3.0, 100, P) is None)


def t_sequence_math_matches_research():
    print("\n[money math: a win after k flips nets positive for every k up to the cap (target 4x the stop, x1.5)]")
    lad = F.ladder(200, P)
    for k in range(len(lad)):
        loss = sum(lad[:k]) * P.sl_pct / 100
        win = lad[k] * P.tp_pct / 100
        if not win > loss:
            check(f"win after {k} flips covers the losses", False, (win, loss)); return
    check("every rung's win covers all earlier stops", True)


for t in (t_signal, t_ladder, t_orders_and_flip, t_cap_becomes_plain_stop, t_no_signal_no_start, t_sequence_math_matches_research):
    t()
print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")
raise SystemExit(1 if FAIL else 0)

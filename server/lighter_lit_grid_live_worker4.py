"""
Worker 4 entrypoint, repurposed for the real-money LIT/USDC grid bot (2026-10-18, direct
request). Worker 4's BTC stochastic clone (lighter_stoch_dca_btc_worker4.py) had a bad weekend
and the user wants to stop trying to make it work -- this replaces it entirely on the same
Render service and the SAME Lighter sub-account (account index 281474976476916, same
LIGHTER_ACCOUNT_INDEX/LIGHTER_API_KEY_INDEX/LIGHTER_API_PRIVATE_KEY env vars already configured
on that service, reused as-is -- no new API key setup).

lighter_stoch_dca_btc_worker4.py is left in the repo untouched as the revert path, same
"Dead code" convention as every other retired bot config in this project -- if the grid bot ever
needs to be abandoned, re-point the Start Command back to it.

All the real trading logic lives in server/lit_grid_live.py -- see its module docstring for the
durable-ledger safety design. This file only wires the entrypoint, same minimal pattern as
lighter_stoch_dca_btc_worker4.py's own _main().

The bot starts disabled (lighter_lit_grid_live_state.enabled defaults to false) -- nothing here
places a real order until the user explicitly flips it on from the dashboard.
"""
import asyncio

from lit_grid_live import run_lit_grid_live

if __name__ == "__main__":
    asyncio.run(run_lit_grid_live())

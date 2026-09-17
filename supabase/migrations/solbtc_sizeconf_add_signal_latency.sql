-- Records the exact signal-to-fill latency for every trade -- lets us directly verify the
-- strategy's 1-second-minimum-delay rule on real live trades instead of only trusting the code.
alter table public.solbtc_sizeconf_trades add column if not exists signal_time timestamptz;
alter table public.solbtc_sizeconf_trades add column if not exists latency_s double precision;

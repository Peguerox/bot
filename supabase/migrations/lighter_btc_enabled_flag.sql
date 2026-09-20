-- ON/OFF control for the 3 Lighter BTC Stoch5 bots, defaulting OFF so nothing trades until
-- explicitly toggled on from the dashboard.
alter table lighter_stoch_dca_btc_state add column if not exists enabled boolean not null default false;
alter table lighter_btc_initial_state   add column if not exists enabled boolean not null default false;
alter table lighter_btc_optimal_state   add column if not exists enabled boolean not null default false;

update lighter_stoch_dca_btc_state set enabled = false where id = 1;
update lighter_btc_initial_state   set enabled = false where id = 1;
update lighter_btc_optimal_state   set enabled = false where id = 1;

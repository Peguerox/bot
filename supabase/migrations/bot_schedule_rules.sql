-- Master schedule panel -- 2026-10-04. Run in the Supabase SQL Editor.
-- One shared row drives both Worker 1 and the hedge, by hour and/or live ER/volume/wiggle/rate/
-- volume-wiggle-ratio conditions. `rules` is an ORDERED JSONB array; the first rule whose hour
-- range (if set) AND every set min/max condition both hold wins. A match turns that bot ON and
-- applies its settings; no match turns it OFF -- re-checked every ~30s, overriding manual ON/OFF
-- clicks for as long as this row's own `enabled` stays true. Never closes an open position, only
-- blocks/allows new entries, same as every other ON/OFF switch in this project.
-- hour_start/hour_end are MIAMI LOCAL TIME (America/New_York, DST-aware), 0-23 -- not UTC,
-- direct request. Each rule shape:
--   { "hour_start": 0-23 | null, "hour_end": 0-23 | null,
--     "er_min": number | null, "er_max": number | null,
--     "volume_min": number | null, "volume_max": number | null,
--     "wiggle_min": number | null, "wiggle_max": number | null,
--     "rate_min": number | null, "rate_max": number | null,
--     "vol_wiggle_ratio_min": number | null, "vol_wiggle_ratio_max": number | null,
--     "worker1": { "sl_pct", "trigger_pct", "trail_pct", "tp_pct", "dwell_seconds",
--                  "band_lo", "band_hi", "reversal_lo", "reversal_hi", "window" },
--     "hedge": { "sl_pct", "trigger_pct", "trail_pct", "tp_pct", "dwell_seconds" } }
-- See StochBot._apply_schedule_rules / StochBot._rule_matches / StochBot._schedule_current_hour
-- in server/stoch_bot_core.py.
CREATE TABLE IF NOT EXISTS public.bot_schedule_rules (
  id BIGINT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.bot_schedule_rules (id, enabled, rules)
VALUES (1, false, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.bot_schedule_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read" ON public.bot_schedule_rules FOR SELECT TO anon USING (true);

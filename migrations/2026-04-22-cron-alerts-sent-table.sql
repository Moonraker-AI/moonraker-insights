-- 2026-04-22: cron_alerts_sent — suppression ledger for alert-class crons
--
-- Purpose: record every alert an alert-emitting cron fires so it can check
-- "did I already alert on this in the last N hours?" on subsequent runs.
-- First consumer: 3/72h agent_error alerter (api/cron/agent-error-alerter.js).
--
-- Schema is intentionally generic. Each cron owns its own alert_source
-- namespace; future alert-class crons (GBP quota warnings, payment failure
-- summaries, etc.) can share the table without new migrations.
--
-- Retention: no automatic expiry. Rows are small, growth is bounded (a few
-- per alert event). If the table ever gets large, extend cleanup-rate-limits.js
-- to prune rows older than 90d.

CREATE TABLE IF NOT EXISTS public.cron_alerts_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_source text NOT NULL,
  alert_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb
);

CREATE INDEX IF NOT EXISTS cron_alerts_sent_source_key_sent_at
  ON public.cron_alerts_sent (alert_source, alert_key, sent_at DESC);

-- Service role bypasses RLS; handler uses SUPABASE_SERVICE_ROLE_KEY so
-- reads/writes work. No anon policies: admin-internal only.
ALTER TABLE public.cron_alerts_sent ENABLE ROW LEVEL SECURITY;

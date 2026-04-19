-- 2026-04-19 — Cron observability (audit Decision #4).
--
-- Adds a cron_runs audit table so every cron invocation has a queryable
-- start/finish record. A daily cron-heartbeat-check queries this for
-- missing runs per cron_name and fires monitor.critical when a cron has
-- gone dark past its expected interval. Replaces the previous "hope and
-- vibes" model where the only signal of a dead cron was a client complaint.
--
-- Retention: pruned by cleanup-rate-limits after 30 days. Long enough for
-- retro investigation, short enough that the table stays small (11 crons
-- × up to 288 runs/day each × 30 days ≈ 95k rows max).
--
-- Applied via MCP apply_migration: cron_runs_observability

CREATE TABLE IF NOT EXISTS cron_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name            text NOT NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  status               text NOT NULL DEFAULT 'running',
  queue_depth          integer,
  oldest_item_age_sec  integer,
  error                text,
  detail               jsonb
);

CREATE INDEX IF NOT EXISTS cron_runs_name_started_idx
  ON cron_runs (cron_name, started_at DESC);

CREATE INDEX IF NOT EXISTS cron_runs_running_idx
  ON cron_runs (started_at DESC)
  WHERE status = 'running';

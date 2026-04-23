-- 2026-04-23 — proposal_followups send retry tracking (cron audit H, Batch 1 Part B).
--
-- process-followups previously flipped rows to status='failed' with no retry,
-- no backoff, no error detail. Transient Resend failures (429, 5xx, network)
-- became permanent losses — identical defect to the one fixed on newsletters
-- on 2026-04-19.
--
-- Strategy mirrors migrations/2026-04-19-newsletter-send-retry.sql exactly,
-- with column names prefixed followup_ per the canonical pattern:
--   - Transient errors (Resend 429/5xx, timeouts) leave followup_retriable=true
--     with a backed-off followup_next_attempt_at.
--   - Max 3 attempts. On 3rd failure, followup_retriable=false and
--     monitor.critical fires to alert the team.
--   - Permanent errors (400/401/403/404) short-circuit to
--     followup_retriable=false immediately.
--
-- Partial index stays tiny because only failed+retriable rows are queried
-- during each cron pass; sent/cancelled rows accumulate indefinitely.
--
-- Applied via MCP apply_migration: proposal_followups_retry_columns

ALTER TABLE public.proposal_followups
  ADD COLUMN IF NOT EXISTS followup_attempt_count   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_followup_error      TEXT,
  ADD COLUMN IF NOT EXISTS followup_retriable       BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS followup_next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS proposal_followups_retry_idx
  ON public.proposal_followups (followup_next_attempt_at)
  WHERE status = 'failed'
    AND followup_retriable = true;

-- 2026-04-23 — audit_followups send retry tracking (cron audit H, Batch 1 Part B).
--
-- Same defect + same fix as proposal_followups (sibling migration dated
-- 2026-04-23-proposal-followups-retry.sql). Columns + partial index mirror
-- the canonical newsletter pattern from 2026-04-19-newsletter-send-retry.sql
-- with a followup_ prefix.
--
-- Applied via MCP apply_migration: audit_followups_retry_columns

ALTER TABLE public.audit_followups
  ADD COLUMN IF NOT EXISTS followup_attempt_count   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_followup_error      TEXT,
  ADD COLUMN IF NOT EXISTS followup_retriable       BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS followup_next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS audit_followups_retry_idx
  ON public.audit_followups (followup_next_attempt_at)
  WHERE status = 'failed'
    AND followup_retriable = true;

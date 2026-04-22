-- 2026-04-22: dispatch_attempts counter for process-audit-queue loop protection.
--
-- Problem: when the agent rejects a dispatch with a 4xx response, the handler in
-- api/cron/process-audit-queue.js sets status=agent_error and last_agent_error_at
-- but leaves agent_error_retriable untouched. If the row had retriable=true on
-- entry, Step 0.5 requeues it every cron tick, re-dispatches, gets the same
-- rejection, loops forever. Angela-gwak hit this class of bug on 2026-04-22 with
-- a 422 (NULL client_slug); resolved by schema fix.
--
-- This column is a schema-level backstop: regardless of HTTP error class, once
-- dispatch_attempts >= MAX_DISPATCH_ATTEMPTS (hardcoded in the cron handler at 5),
-- the row is forced to retriable=false and stops looping.
--
-- Semantics:
--   +1 on every dispatch attempt that fails (any non-2xx from agent POST)
--   reset to 0 on successful dispatch (agent returns 2xx with task_id)
--   NOT auto-reset when operator re-releases a row — operators who fix a
--     root cause and release a capped row must also set dispatch_attempts=0
--     in the same UPDATE. This forces an explicit "I think this will work now"
--     decision on release.

ALTER TABLE public.entity_audits
  ADD COLUMN IF NOT EXISTS dispatch_attempts int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.entity_audits.dispatch_attempts IS
  'Monotonic counter of consecutive failed dispatch attempts. Incremented by process-audit-queue on each non-2xx agent response; reset to 0 on successful dispatch. When >= 5, forces agent_error_retriable=false regardless of HTTP class. Operator-reset required on manual re-release of capped rows.';

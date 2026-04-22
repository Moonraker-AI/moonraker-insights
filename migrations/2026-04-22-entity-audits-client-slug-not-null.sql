-- 2026-04-22: enforce client_slug NOT NULL on entity_audits
--
-- The agent service's dispatch endpoint requires client_slug as a
-- non-null string (422 response otherwise). Two legacy rows had NULL
-- client_slug — angela-gwak (5e56c0c7, created 2026-04-08 predating current
-- instrumentation) and danielle-madonna (368b8948, 2026-04-20). Both were
-- backfilled inline from contacts.slug immediately before this migration;
-- all 94 rows have a non-null value at apply time.
--
-- All three creation paths (submit-entity-audit, setup-audit-schedule,
-- seed-batch-audits) already set client_slug, so this constraint
-- codifies an invariant the code already respects. Any future bypass
-- (direct DB insert, or a new route that forgets the field) fails
-- loud at insert time instead of silently breaking dispatch.

ALTER TABLE public.entity_audits
  ALTER COLUMN client_slug SET NOT NULL;

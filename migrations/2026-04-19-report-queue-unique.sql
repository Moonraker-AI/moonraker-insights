-- 2026-04-19 — Prevent duplicate report_queue rows for same (client_slug, report_month).
-- Cron audit H7: enqueue-reports SELECT-then-INSERT has a race window on the 1st
-- of the month. Two concurrent Vercel cron invocations could both see empty
-- existingMap and both insert a full set of rows → duplicate compiles → wasted
-- Anthropic/API cost. This constraint makes the race impossible at the DB level.
-- Combined with Prefer: resolution=ignore-duplicates in the cron code, duplicate
-- POSTs are silently dropped instead of throwing.
--
-- Applied via MCP apply_migration: report_queue_unique_client_month

ALTER TABLE report_queue
  ADD CONSTRAINT report_queue_client_month_uq UNIQUE (client_slug, report_month);

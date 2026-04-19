-- 2026-04-19 — Atomic queue claim RPCs (cron audit H1, H2).
--
-- Context: TOCTOU race in process-queue and process-batch-pages crons. Each
-- ran SELECT-then-PATCH to claim the next pending row. Two overlapping cron
-- invocations could both SELECT the same row and both PATCH to 'processing',
-- causing duplicate work — duplicate Anthropic compile for report_queue,
-- duplicate surge_raw_data parse for content_pages.
--
-- Fix: two SECURITY DEFINER RPCs that do UPDATE … WHERE id=(SELECT … FOR
-- UPDATE SKIP LOCKED LIMIT 1) RETURNING. SKIP LOCKED means concurrent
-- callers get different rows (or empty) rather than blocking. Service role
-- is the only caller (via PostgREST /rpc/<name>).
--
-- Applied via MCP apply_migration: queue_claim_rpcs

CREATE OR REPLACE FUNCTION claim_next_report_queue()
RETURNS SETOF report_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE report_queue
  SET status = 'processing',
      started_at = now(),
      attempt = attempt + 1
  WHERE id = (
    SELECT id
    FROM report_queue
    WHERE status = 'pending'
      AND scheduled_for <= now()
    ORDER BY scheduled_for ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION claim_next_content_page(p_batch_id uuid)
RETURNS SETOF content_pages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE content_pages
  SET surge_status = 'processing',
      updated_at = now()
  WHERE id = (
    SELECT id
    FROM content_pages
    WHERE batch_id = p_batch_id
      AND surge_status = 'raw_stored'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

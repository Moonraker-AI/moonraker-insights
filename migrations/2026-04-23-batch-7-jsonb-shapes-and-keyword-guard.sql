-- 2026-04-23 — Batch 7 DB hardening: JSONB shape CHECKs + keyword delete guard.
--
-- Decision 3 (recommended A): add jsonb_typeof shape CHECKs on JSONB
-- columns whose consumers assume a specific container type. Cheap
-- guardrail against code writing "a string" or "42" into a field the
-- renderer expects to be an object. Soft checks (IS NULL OR typeof =
-- expected) so nullable columns stay nullable.
--
-- Note: report_snapshots.ga4_detail has 1 legacy row stored as a string
-- (vs 30 stored as objects). Skipped here; flag for a follow-up: inspect
-- + fix the outlier row, then add the same CHECK.
--
-- Decision 4 (recommended B): protect tracked_keywords.DELETE at the
-- schema layer. Protocol says never DELETE keywords (only retire via
-- retired_at + retired_reason), but the only current enforcement is
-- action-schema.js delete allowlist — a direct service-role PATCH or a
-- future admin who bypasses action.js can still wipe history.
--
-- Applied via MCP apply_migration: batch_7_jsonb_shapes_and_keyword_guard

-- JSONB shape checks ---------------------------------------------------

ALTER TABLE public.newsletters
  DROP CONSTRAINT IF EXISTS newsletters_content_shape;
ALTER TABLE public.newsletters
  ADD CONSTRAINT newsletters_content_shape
  CHECK (content IS NULL OR jsonb_typeof(content) = 'object');

ALTER TABLE public.report_snapshots
  DROP CONSTRAINT IF EXISTS report_snapshots_ai_visibility_shape;
ALTER TABLE public.report_snapshots
  ADD CONSTRAINT report_snapshots_ai_visibility_shape
  CHECK (ai_visibility IS NULL OR jsonb_typeof(ai_visibility) = 'object');

ALTER TABLE public.report_snapshots
  DROP CONSTRAINT IF EXISTS report_snapshots_gbp_detail_shape;
ALTER TABLE public.report_snapshots
  ADD CONSTRAINT report_snapshots_gbp_detail_shape
  CHECK (gbp_detail IS NULL OR jsonb_typeof(gbp_detail) = 'object');

ALTER TABLE public.report_snapshots
  DROP CONSTRAINT IF EXISTS report_snapshots_gsc_detail_shape;
ALTER TABLE public.report_snapshots
  ADD CONSTRAINT report_snapshots_gsc_detail_shape
  CHECK (gsc_detail IS NULL OR jsonb_typeof(gsc_detail) = 'object');

ALTER TABLE public.report_snapshots
  DROP CONSTRAINT IF EXISTS report_snapshots_neo_data_shape;
ALTER TABLE public.report_snapshots
  ADD CONSTRAINT report_snapshots_neo_data_shape
  CHECK (neo_data IS NULL OR jsonb_typeof(neo_data) = 'object');

ALTER TABLE public.report_snapshots
  DROP CONSTRAINT IF EXISTS report_snapshots_deliverables_shape;
ALTER TABLE public.report_snapshots
  ADD CONSTRAINT report_snapshots_deliverables_shape
  CHECK (deliverables IS NULL OR jsonb_typeof(deliverables) = 'array');

-- Keyword delete protection ---------------------------------------------

CREATE OR REPLACE FUNCTION public.tracked_keywords_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'tracked_keywords rows cannot be deleted; set retired_at + retired_reason instead (see docs/keyword-change-protocol.md)';
END;
$$;

DROP TRIGGER IF EXISTS tracked_keywords_forbid_delete_trg ON public.tracked_keywords;
CREATE TRIGGER tracked_keywords_forbid_delete_trg
  BEFORE DELETE ON public.tracked_keywords
  FOR EACH ROW
  EXECUTE FUNCTION public.tracked_keywords_forbid_delete();

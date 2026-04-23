-- 2026-04-23 — Fix ga4_detail legacy double-encoding + add shape CHECK.
--
-- Batch 7 added jsonb_typeof='object' CHECKs to 5 report_snapshots JSONB
-- columns but skipped ga4_detail because 1 of 31 rows had the JSON stored
-- as a quoted string (double-encoded: a JSON.stringify result stored as
-- text, then re-stringified into JSONB). Every other row is stored
-- correctly as an object.
--
-- Fix: for the one offending row (`anna-skomorovskaia` / `2026-03-01`),
-- extract the contained text via jsonb `#>> '{}'` (strips the outer
-- quote/escape) and re-cast to jsonb so it parses as the intended object.
-- After that, all rows satisfy jsonb_typeof='object' and the CHECK lands.
--
-- Applied via MCP apply_migration: report_snapshots_ga4_detail_unstringify_and_check

UPDATE public.report_snapshots
SET ga4_detail = (ga4_detail #>> '{}')::jsonb
WHERE jsonb_typeof(ga4_detail) = 'string';

ALTER TABLE public.report_snapshots
  DROP CONSTRAINT IF EXISTS report_snapshots_ga4_detail_shape;
ALTER TABLE public.report_snapshots
  ADD CONSTRAINT report_snapshots_ga4_detail_shape
  CHECK (ga4_detail IS NULL OR jsonb_typeof(ga4_detail) = 'object');

-- Drop legacy proposals.accepted_at column.
--
-- Applied via Supabase MCP: migration "drop_legacy_proposals_accepted_at_column"
--
-- Background: accepted_at was a timestamp intended to record when a client
-- accepted a proposal, under an earlier acceptance flow that never shipped.
-- Current acceptance is tracked on proposal_versions (per-version state) and
-- on contact status transitions (lead -> prospect -> onboarding), not on a
-- single timestamp column on the proposals parent row. The Phase 1 audit on
-- 2026-04-21 found zero readers or writers repo-wide.
--
-- Pre-flight sanity check run before this migration:
--   SELECT COUNT(*) FILTER (WHERE accepted_at IS NOT NULL) FROM proposals -> 0
--   Full repo grep for "accepted_at" across api/, admin/, shared/,
--     _templates/, migrations/ -> 0 hits
-- All 22 rows had NULL; no code path read or wrote the column. No Phase 2
-- code migration was required.

ALTER TABLE proposals DROP COLUMN IF EXISTS accepted_at;

-- Backfill: every existing proposals row with proposal_content becomes v1.
-- Idempotent: no-op if active_version_id is already set.
--
-- Timestamp strategy: we trust proposals.created_at as the original generation
-- time and proposals.updated_at as the most recent regeneration. Since we have
-- no prior history, we collapse to a single v1 whose generated_at = created_at
-- and which stays active. Future regenerations will create v2, v3, etc.

INSERT INTO proposal_versions (
  id, proposal_id, contact_id, version_number, proposal_content,
  campaign_lengths, billing_options, custom_pricing,
  enrichment_sources, enrichment_data,
  generated_at, generated_by
)
SELECT
  gen_random_uuid(),
  p.id,
  p.contact_id,
  1,
  p.proposal_content,
  COALESCE(p.campaign_lengths, '{}'::text[]),
  COALESCE(p.billing_options, '{}'::text[]),
  p.custom_pricing,
  p.enrichment_sources,
  p.enrichment_data,
  COALESCE(p.created_at, now()),
  p.created_by
FROM proposals p
WHERE p.proposal_content IS NOT NULL
  AND p.active_version_id IS NULL;

-- Point proposals.active_version_id at the v1 we just inserted for each row.
UPDATE proposals p
SET
  active_version_id = pv.id,
  version_count = 1
FROM proposal_versions pv
WHERE pv.proposal_id = p.id
  AND pv.version_number = 1
  AND p.active_version_id IS NULL;

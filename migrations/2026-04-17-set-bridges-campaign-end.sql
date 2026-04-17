-- migrations/2026-04-17-set-bridges-campaign-end.sql
--
-- Sets campaign_end for Bridges of The Mind to the actual year-1 contract
-- end (12 months after campaign_start = 2025-03-12). The campaign-summary
-- page uses this to cap the reporting window and billed_months correctly.
--
-- Without this, the API falls back to "elapsed since start" which for
-- Bridges is already 14 months (13 billed would roll up as $19,500 not $18,000),
-- which no longer matches the $36K performance guarantee threshold.

UPDATE contacts
SET campaign_end = '2026-03-12'
WHERE slug = 'erika-frieze'
  AND campaign_end IS NULL;

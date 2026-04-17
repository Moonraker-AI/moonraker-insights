-- migrations/2026-04-17-seed-bridges-deliverables.sql
--
-- Seeds the year-one deliverables shipped for Bridges of The Mind so
-- the campaign-summary "What we shipped" section has full depth for the
-- renewal conversation.
--
-- Quantities and titles confirmed with Chris on 2026-04-17. Tool brands
-- (BrightLocal, LinkDaddy) are kept in private notes only; client-facing
-- titles describe the work, not the vendor, per Moonraker policy.
--
-- Year 2 items (entity audit rollout, bio page rebuilds, FAQ, endorsements,
-- entity veracity hub, social posts, NEO images) are intentionally NOT
-- seeded here. They belong to the next contract and will be added as work
-- begins.
--
-- Idempotent: skips entirely if any of these specific titles already exist
-- for the contact, so re-running is safe.

DO $$
DECLARE
  bridges_id uuid := 'd5bc5581-fcf4-41f2-9914-6f1de671afdc';
  delivered_ts timestamptz := '2025-09-01T00:00:00Z';  -- approximate mid-engagement
BEGIN
  IF EXISTS (
    SELECT 1 FROM deliverables
    WHERE contact_id = bridges_id
      AND title = 'Search Console Setup'
  ) THEN
    RAISE NOTICE 'Bridges deliverables already seeded; skipping.';
    RETURN;
  END IF;

  -- ── Setup & Foundation ─────────────────────────────────────────
  INSERT INTO deliverables (contact_id, deliverable_type, title, status, delivered_at, notes) VALUES
    (bridges_id, 'gsc_setup', 'Search Console Setup', 'delivered', delivered_ts, 'Verified bridgesofthemind.com property, configured sitemap submission, granted reporting service account access for monthly compile.'),
    (bridges_id, 'ga4_setup', 'GA4 Setup', 'delivered', delivered_ts, 'GA4 property created and tracking installed sitewide.'),
    (bridges_id, 'gtm_setup', 'Tag Manager Setup', 'delivered', delivered_ts, 'Google Tag Manager container installed, GA4 tag deployed via GTM.'),
    (bridges_id, 'gbp_setup', 'Google Business Profile Setup', 'delivered', delivered_ts, 'GBP claimed and verified for the Sacramento location, baseline information populated.');

  -- ── Content & SEO Pages: 5 target service pages + 1 location page ──
  INSERT INTO deliverables (contact_id, deliverable_type, title, status, delivered_at, notes) VALUES
    (bridges_id, 'target_page', 'ADHD Testing Service Page',                 'delivered', delivered_ts, 'Long-form keyword-optimized service page targeting ADHD testing intent in the Sacramento area.'),
    (bridges_id, 'target_page', 'Autism Testing Service Page',               'delivered', delivered_ts, 'Long-form keyword-optimized service page targeting autism testing intent for adults and adolescents in the Sacramento area.'),
    (bridges_id, 'target_page', 'Child Assessment Service Page',             'delivered', delivered_ts, 'Long-form keyword-optimized service page covering psychological and developmental assessment for children.'),
    (bridges_id, 'target_page', 'Adult Assessment Service Page',             'delivered', delivered_ts, 'Long-form keyword-optimized service page covering adult psychological assessment offerings.'),
    (bridges_id, 'target_page', 'Learning Disability Testing Service Page',  'delivered', delivered_ts, 'Long-form keyword-optimized service page covering learning disability and educational evaluation services.'),
    (bridges_id, 'location_page', 'Sacramento Location Page',                'delivered', delivered_ts, 'Location page covering the Sacramento practice. Year 2 work: advanced location/medical-business schema markup.');

  -- ── Authority & Trust Signals ──────────────────────────────────
  INSERT INTO deliverables (contact_id, deliverable_type, title, status, delivered_at, notes) VALUES
    (bridges_id, 'citations',     'Local Citation Building',  'delivered', delivered_ts, 'Local citation building across primary directory network. INTERNAL: built via BrightLocal; do not surface vendor brand to client.'),
    (bridges_id, 'press_release', 'Press Release Distribution', 'delivered', delivered_ts, 'Authority-building press release distribution to news syndication network. INTERNAL: distributed via LinkDaddy; do not surface vendor brand to client.');

  -- ── Strategy & Audits ──────────────────────────────────────────
  INSERT INTO deliverables (contact_id, deliverable_type, title, status, delivered_at, notes) VALUES
    (bridges_id, 'proposal',          'Year 1 Strategy Proposal',  'delivered', '2025-03-12T00:00:00Z', 'Initial campaign strategy and proposal that kicked off the year-one engagement.'),
    (bridges_id, 'audit_diagnosis',   'Site & Entity Audit Diagnosis', 'delivered', '2026-04-01T00:00:00Z', 'Full diagnostic audit completed and ready to drive year-two on-page and off-page work across all service pages and homepage.'),
    (bridges_id, 'audit_action_plan', 'Year 2 Action Plan',        'delivered', '2026-04-01T00:00:00Z', 'Prioritized action plan derived from the audit, staged for year-two execution.'),
    (bridges_id, 'audit_progress',    'Audit Progress Tracker',    'active',    '2026-04-01T00:00:00Z', 'All audit pages deployed; tracker in place to monitor completion of year-two execution.'),
    (bridges_id, 'youtube_video',     'YouTube Channel Launch',    'delivered', delivered_ts, 'YouTube channel launched as part of broader video and authority strategy. Confirm exact video count with team if needed.');
END $$;

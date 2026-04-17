-- migrations/2026-04-17-attribution-tables.sql
--
-- Adds formal storage for client-reported attribution data (year-over-year
-- comparisons in campaign summaries) and the performance-guarantee threshold
-- on report_configs.
--
-- Schema rationale:
--   - One row per attribution period in client_attribution_periods (e.g.
--     "baseline year" and "year 1 of campaign"). Periods have absolute date
--     ranges so they can describe pre-campaign baselines and any future
--     window we want to compare against.
--   - One row per source within a period in client_attribution_sources
--     (Google, ChatGPT, Referral, Direct, etc). Source rows hold both
--     appointment counts and revenue in cents.
--   - Reporting metadata (data_source, reported_by, reported_at) is on the
--     period, not the source, since attribution typically arrives as a
--     batch from the client's admin team.
--   - performance_guarantee_cents lives on report_configs since it's a
--     campaign-level commitment (typically 2x the contract investment).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS client_attribution_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  period_label    text NOT NULL,
  is_baseline     boolean NOT NULL DEFAULT false,
  data_source     text,             -- 'client_reported', 'calculated', 'estimated'
  reported_by     text,             -- name of person who provided the data
  reported_at     timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_dates_valid CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS client_attribution_periods_contact_idx
  ON client_attribution_periods(contact_id, period_start);

CREATE TABLE IF NOT EXISTS client_attribution_sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id         uuid NOT NULL REFERENCES client_attribution_periods(id) ON DELETE CASCADE,
  source_name       text NOT NULL,
  source_category   text,           -- 'organic_search', 'ai_search', 'paid_search', 'social', 'referral', 'direct', 'other'
  appointment_count integer NOT NULL DEFAULT 0,
  revenue_cents     bigint NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_attribution_sources_period_idx
  ON client_attribution_sources(period_id);

-- Trigger to keep updated_at fresh on periods
CREATE OR REPLACE FUNCTION update_attribution_periods_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attribution_periods_updated_at ON client_attribution_periods;
CREATE TRIGGER attribution_periods_updated_at
  BEFORE UPDATE ON client_attribution_periods
  FOR EACH ROW
  EXECUTE FUNCTION update_attribution_periods_updated_at();

-- Performance guarantee column on report_configs
ALTER TABLE report_configs
  ADD COLUMN IF NOT EXISTS performance_guarantee_cents bigint;

COMMENT ON TABLE client_attribution_periods
  IS 'Multi-source attribution periods for YoY campaign comparisons. Each period has multiple source rows (Google, ChatGPT, etc.) in client_attribution_sources.';
COMMENT ON TABLE client_attribution_sources
  IS 'Per-source breakdown of appointments and revenue within an attribution period.';
COMMENT ON COLUMN report_configs.performance_guarantee_cents
  IS 'Performance guarantee revenue threshold for this engagement. Typically 2x the contract investment.';

-- ─────────────────────────────────────────────────────────────────────────
-- Seed: Bridges of The Mind (erika-frieze)
-- Source: Email from Justina Erpelding (justina@bridgesofthemind.com)
-- to Scott Pope on April 16, 2026, subject "Admin Search for Appts Booked".
-- Numbers reflect appointments where the referral source was tagged in
-- their Simple Practice / ClickUp tracking. Likely undercount; admin
-- relies on patient self-report at intake.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  bridges_id uuid := 'd5bc5581-fcf4-41f2-9914-6f1de671afdc';
  baseline_period_id uuid;
  year1_period_id uuid;
BEGIN
  -- Skip seed if Bridges baseline already exists (idempotency)
  IF EXISTS (
    SELECT 1 FROM client_attribution_periods
    WHERE contact_id = bridges_id AND is_baseline = true
  ) THEN
    RAISE NOTICE 'Bridges attribution data already seeded; skipping.';
    RETURN;
  END IF;

  -- Insert baseline period (Mar 2024 - Mar 2025, pre-campaign)
  INSERT INTO client_attribution_periods
    (contact_id, period_start, period_end, period_label, is_baseline, data_source, reported_by, reported_at, notes)
  VALUES (
    bridges_id,
    '2024-03-01', '2025-03-01',
    'Pre-campaign baseline (Mar 2024 - Mar 2025)',
    true,
    'client_reported',
    'Justina Erpelding',
    '2026-04-16T11:37:00Z',
    'Reported via email, source: their Simple Practice / ClickUp admin tracking. Includes only appointments where patient self-reported finding them via Google. Likely an undercount.'
  )
  RETURNING id INTO baseline_period_id;

  -- Insert year 1 period (Mar 2025 - Mar 2026, full campaign year)
  INSERT INTO client_attribution_periods
    (contact_id, period_start, period_end, period_label, is_baseline, data_source, reported_by, reported_at, notes)
  VALUES (
    bridges_id,
    '2025-03-01', '2026-03-01',
    'Campaign Year 1 (Mar 2025 - Mar 2026)',
    false,
    'client_reported',
    'Justina Erpelding',
    '2026-04-16T11:37:00Z',
    'Reported via email, source: their Simple Practice / ClickUp admin tracking. Includes only appointments where patient self-reported the channel. Likely an undercount.'
  )
  RETURNING id INTO year1_period_id;

  -- Baseline sources: only Google was tracked pre-campaign
  INSERT INTO client_attribution_sources
    (period_id, source_name, source_category, appointment_count, revenue_cents)
  VALUES
    (baseline_period_id, 'Google', 'organic_search', 7, 1815000);

  -- Year 1 sources: Google, generic Online, ChatGPT
  INSERT INTO client_attribution_sources
    (period_id, source_name, source_category, appointment_count, revenue_cents)
  VALUES
    (year1_period_id, 'Google',           'organic_search', 9, 3720000),
    (year1_period_id, 'Online (generic)', 'organic_search', 2, 1273332),
    (year1_period_id, 'ChatGPT',          'ai_search',      1,  380000);
END $$;

-- Set performance guarantee for Bridges: 2x $18K investment = $36K
UPDATE report_configs
  SET performance_guarantee_cents = 3600000
  WHERE client_slug = 'erika-frieze' AND performance_guarantee_cents IS NULL;

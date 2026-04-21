-- ---------------------------------------------------------------------------
-- proposal_versioning
-- ---------------------------------------------------------------------------
-- Adds a proposal_versions child table so a contact's proposal history is
-- preserved across regenerations. The parent proposals row becomes a pointer
-- to the active version, not a single mutable record.
--
-- Read path (anon-facing): /api/public-proposal reads server-side with the
-- service role key and returns ONLY the active version. No anon RLS policy
-- exists on proposal_versions. This is intentionally stricter than the
-- report_snapshots pattern because proposals contain financial data.
--
-- Read path (admin): JWT -> is_admin() policy allows full history access
-- for internal "here's what I sent on April 3rd" references.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS proposal_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id        uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  version_number     int  NOT NULL,
  proposal_content   jsonb NOT NULL,
  campaign_lengths   text[] NOT NULL DEFAULT '{}',
  billing_options    text[] NOT NULL DEFAULT '{}',
  custom_pricing     jsonb,
  enrichment_sources jsonb,
  enrichment_data    jsonb,
  generated_at       timestamptz NOT NULL DEFAULT now(),
  generated_by       text,
  retired_at         timestamptz,
  retired_reason     text,
  CONSTRAINT proposal_versions_unique_version UNIQUE (proposal_id, version_number),
  CONSTRAINT proposal_versions_version_positive CHECK (version_number >= 1)
);

CREATE INDEX IF NOT EXISTS ix_proposal_versions_contact_generated
  ON proposal_versions (contact_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS ix_proposal_versions_proposal
  ON proposal_versions (proposal_id, version_number DESC);

-- Pointer to the currently-active version on the parent proposal row.
-- Nullable so we can stage data-migration (create versions, then point).
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS active_version_id uuid
    REFERENCES proposal_versions(id) ON DELETE SET NULL;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS version_count int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ix_proposals_active_version
  ON proposals (active_version_id) WHERE active_version_id IS NOT NULL;

-- RLS: zero anon policies. Only service_role (api/*) and authenticated admins.
ALTER TABLE proposal_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_full_proposal_versions ON proposal_versions;
CREATE POLICY service_full_proposal_versions
  ON proposal_versions
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_admin_full_proposal_versions ON proposal_versions;
CREATE POLICY authenticated_admin_full_proposal_versions
  ON proposal_versions
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

COMMENT ON TABLE proposal_versions IS
  'Immutable history of every proposal generation. The active row is indicated by proposals.active_version_id. Never delete a version; use retired_at + retired_reason instead (keyword-change-protocol pattern).';
COMMENT ON COLUMN proposals.active_version_id IS
  'Points at the proposal_versions row currently served by /api/public-proposal. NULL means no version has been generated yet.';
COMMENT ON COLUMN proposals.version_count IS
  'Monotonic counter used to assign version_number on the next INSERT into proposal_versions. Incremented atomically by /api/generate-proposal.';

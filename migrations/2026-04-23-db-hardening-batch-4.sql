-- 2026-04-23 — DB hardening (audit batch 4). Consolidates seven safe items
-- surfaced by the MCP-enabled re-run of the DB audit:
--   1. report_configs anon read had qual=true (wide open). No client-side
--      code actually reads it through the anon key; drop the policy.
--   2. admin_profiles authenticated self-UPDATE allowed self-promotion via
--      the role column. Add a BEFORE UPDATE trigger that rejects role,
--      email, or id mutation unless the caller is service_role.
--   3. REVOKE EXECUTE on claim_next_audit / claim_next_content_page /
--      claim_next_report_queue from anon, authenticated, and PUBLIC.
--      These are queue-mutating SECURITY DEFINER RPCs; only cron / admin /
--      service paths need them.
--   4. client_attribution_insights + pending_checkout_sessions had RLS
--      enabled with zero policies (advisor INFO). Add explicit service-only
--      policies so posture is intentional.
--   5. Pin search_path on site_maps_touch_updated_at +
--      touch_client_attribution_insights_updated_at (advisor WARN).
--   6. Add index on signed_performance_guarantees.superseded_by (advisor
--      INFO unindexed_foreign_keys).
--   7. Drop duplicate index workspace_credentials_contact_id_idx (advisor
--      WARN duplicate_index).
--   8. Add 'lost' to contacts_status_check — code in content-chat.js
--      already compares contact.status === 'lost', but the CHECK rejected
--      the write path. All current rows satisfy the new allowlist.
--
-- Applied via MCP apply_migration: db_hardening_batch_4

-- 1. report_configs: drop wide-open anon read.
DROP POLICY IF EXISTS anon_read_report_configs ON public.report_configs;

-- 2. admin_profiles self-UPDATE: block role / email / id mutation.
CREATE OR REPLACE FUNCTION public.admin_profiles_reject_privileged_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF current_user <> 'service_role' THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'admin role changes must go through the service role';
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'admin email changes must go through the service role';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'admin id cannot be changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_profiles_reject_privileged_updates_trg
  ON public.admin_profiles;
CREATE TRIGGER admin_profiles_reject_privileged_updates_trg
  BEFORE UPDATE ON public.admin_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.admin_profiles_reject_privileged_updates();

-- 3. Revoke queue RPC execute from anon / authenticated / PUBLIC.
REVOKE EXECUTE ON FUNCTION public.claim_next_audit()             FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_next_content_page(uuid)  FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_next_report_queue()      FROM anon, authenticated, PUBLIC;

-- 4. RLS-enabled-no-policy cleanup.
DROP POLICY IF EXISTS service_full_client_attribution_insights
  ON public.client_attribution_insights;
CREATE POLICY service_full_client_attribution_insights
  ON public.client_attribution_insights
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_full_pending_checkout_sessions
  ON public.pending_checkout_sessions;
CREATE POLICY service_full_pending_checkout_sessions
  ON public.pending_checkout_sessions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 5. Pin search_path on two lingering mutable-search_path functions.
ALTER FUNCTION public.site_maps_touch_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.touch_client_attribution_insights_updated_at()
  SET search_path = public, pg_catalog;

-- 6. Add missing FK index.
CREATE INDEX IF NOT EXISTS signed_performance_guarantees_superseded_by_idx
  ON public.signed_performance_guarantees (superseded_by);

-- 7. Drop duplicate index (workspace_credentials_contact_id_unique is the
--    keeper — it is the UNIQUE constraint; _idx is the redundant one).
DROP INDEX IF EXISTS public.workspace_credentials_contact_id_idx;

-- 8. Align contacts.status CHECK with code (allow 'lost').
ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_status_check;
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_status_check
  CHECK (status = ANY (ARRAY['lead','prospect','onboarding','active','inactive','lost']));

-- 9. Tie contacts.lost to contacts.status='lost' (Decision 2 = C).
--    lost boolean and status='lost' must agree. Existing rows (all lost=false,
--    no status='lost') satisfy this constraint trivially.
ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_lost_status_coherent;
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_lost_status_coherent
  CHECK ((lost = false AND status <> 'lost') OR (lost = true AND status = 'lost'));

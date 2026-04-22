-- Fix: the 2026-04-22 06:02 UTC grant-hygiene sweep
-- (grant_hygiene_revoke_dead_anon_grants_2026_04_22) did REVOKE ALL ON
-- contacts FROM anon. Every anon RLS policy that evaluates
-- "EXISTS (SELECT 1 FROM contacts c WHERE ...)" began failing with
-- "permission denied for table contacts" (42501 -> 401 at PostgREST).
-- Observed impact: /<slug>/onboarding 401s on bio_materials,
-- onboarding_steps, practice_details, signed_agreements for every client
-- visiting the page. (Silently returned empty rows from 2026-04-20 when
-- anon_read_contacts was dropped; today's REVOKE ALL turned silent empty
-- into hard 401.)
--
-- Fix: SECURITY DEFINER helper contact_has_status() bypasses the grant
-- requirement without re-exposing contacts to anon. Mirrors existing
-- is_admin() / get_*_summary() pattern (already SECURITY DEFINER for the
-- same structural reason).
--
-- No behavior change beyond removing the grant dependency: each policy's
-- status scope is preserved exactly.

CREATE OR REPLACE FUNCTION public.contact_has_status(p_contact_id uuid, p_statuses text[])
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE id = p_contact_id
      AND status = ANY (p_statuses)
  );
$fn$;

COMMENT ON FUNCTION public.contact_has_status(uuid, text[]) IS
  'SECURITY DEFINER helper for anon-facing RLS policies that need to scope by contacts.status. Anon does not hold SELECT on contacts (intentionally — grant-hygiene 2026-04-22), so RLS subqueries against contacts 401. This function runs as owner, checks existence + status, returns a boolean. Callers reveal only whether a specific contact_id exists with a status in the provided set.';

GRANT EXECUTE ON FUNCTION public.contact_has_status(uuid, text[]) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Rewrite all 9 anon policies that subselect contacts. Preserve each
-- policy's existing status scope.
-- ─────────────────────────────────────────────────────────────────────

-- bio_materials
DROP POLICY IF EXISTS anon_read_bio_scoped ON public.bio_materials;
CREATE POLICY anon_read_bio_scoped ON public.bio_materials FOR SELECT TO anon
USING (public.contact_has_status(contact_id, ARRAY['prospect','onboarding','active']));

DROP POLICY IF EXISTS anon_update_bio_onboarding ON public.bio_materials;
CREATE POLICY anon_update_bio_onboarding ON public.bio_materials FOR UPDATE TO anon
USING (public.contact_has_status(contact_id, ARRAY['prospect','onboarding']))
WITH CHECK (public.contact_has_status(contact_id, ARRAY['prospect','onboarding']));

-- onboarding_steps
DROP POLICY IF EXISTS anon_read_onboarding_scoped ON public.onboarding_steps;
CREATE POLICY anon_read_onboarding_scoped ON public.onboarding_steps FOR SELECT TO anon
USING (public.contact_has_status(contact_id, ARRAY['prospect','onboarding','active']));

DROP POLICY IF EXISTS anon_update_onboarding_scoped ON public.onboarding_steps;
CREATE POLICY anon_update_onboarding_scoped ON public.onboarding_steps FOR UPDATE TO anon
USING (public.contact_has_status(contact_id, ARRAY['prospect','onboarding','active']))
WITH CHECK (public.contact_has_status(contact_id, ARRAY['prospect','onboarding','active']));

-- practice_details
DROP POLICY IF EXISTS anon_read_practice_scoped ON public.practice_details;
CREATE POLICY anon_read_practice_scoped ON public.practice_details FOR SELECT TO anon
USING (public.contact_has_status(contact_id, ARRAY['prospect','onboarding','active']));

DROP POLICY IF EXISTS anon_insert_practice_scoped ON public.practice_details;
CREATE POLICY anon_insert_practice_scoped ON public.practice_details FOR INSERT TO anon
WITH CHECK (public.contact_has_status(contact_id, ARRAY['prospect','onboarding']));

DROP POLICY IF EXISTS anon_update_practice_scoped ON public.practice_details;
CREATE POLICY anon_update_practice_scoped ON public.practice_details FOR UPDATE TO anon
USING (public.contact_has_status(contact_id, ARRAY['prospect','onboarding']))
WITH CHECK (public.contact_has_status(contact_id, ARRAY['prospect','onboarding']));

-- signed_agreements
DROP POLICY IF EXISTS anon_read_agreements_scoped ON public.signed_agreements;
CREATE POLICY anon_read_agreements_scoped ON public.signed_agreements FOR SELECT TO anon
USING (public.contact_has_status(contact_id, ARRAY['prospect','onboarding','active']));

-- signed_performance_guarantees
DROP POLICY IF EXISTS anon_read_spg_scoped ON public.signed_performance_guarantees;
CREATE POLICY anon_read_spg_scoped ON public.signed_performance_guarantees FOR SELECT TO anon
USING (public.contact_has_status(contact_id, ARRAY['onboarding','active']));

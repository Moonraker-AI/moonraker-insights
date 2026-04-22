-- Grant-hygiene sweep: align anon table grants with anon RLS policies.
-- Applied via Supabase MCP: grant_hygiene_revoke_dead_anon_grants_2026_04_22
--
-- Principle: for every table exposed to anon, the only grants that should
-- exist are those matching an actual anon-facing RLS policy. Everything
-- else is a silent-failure trap (anon can call the endpoint, PostgREST
-- returns an empty array without raising, bugs hide).
--
-- Three categories identified in the survey:
--   A. Tables with anon write policies — match grants to policy cmds.
--   B. Tables with SELECT-only anon policy — REVOKE all writes.
--   C. Tables with no anon policy — REVOKE ALL including SELECT.
--
-- RLS is already ENABLED on all public tables. Revoking grants changes
-- the failure mode from "silent empty array" to "clear permission
-- error" for any accidental future anon call. For Category C in
-- particular, this hides the table from PostgREST OPTIONS and reduces
-- discoverability.
--
-- Extends: revoke_anon_update_on_contacts_2026_04_22 and
-- revoke_anon_writes_on_entity_audits_2026_04_22 (both same-day).
-- Consolidates the remaining 48 tables.
--
-- Rollback: single GRANT <privs> ON <table> TO anon per table.

-- ─────────────────────────────────────────────────────────────────────
-- Category A: tables with anon write policies
--   Policies scoped to contacts.status IN ('prospect','onboarding').
--   Keep only grants that match a policy cmd.
-- ─────────────────────────────────────────────────────────────────────

-- bio_materials: anon_read_bio_scoped (r) + anon_update_bio_onboarding (w)
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.bio_materials FROM anon;

-- content_chat_messages: anon_insert_content_chat_scoped (a) + anon_read_content_chat (r)
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.content_chat_messages FROM anon;

-- onboarding_steps: anon_read_onboarding_scoped (r) + anon_update_onboarding_scoped (w)
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.onboarding_steps FROM anon;

-- practice_details: anon_insert_practice_scoped (a) + anon_read_practice_scoped (r) + anon_update_practice_scoped (w)
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.practice_details FROM anon;


-- ─────────────────────────────────────────────────────────────────────
-- Category B: tables with SELECT-only anon policy
--   Keep SELECT, revoke all writes.
-- ─────────────────────────────────────────────────────────────────────

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.audit_followups FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.checklist_items FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.client_sites FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cms_scouts FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.content_audit_batches FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.content_page_images FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.content_page_versions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.content_pages FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.deliverables FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.design_specs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.directory_listings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.endorsements FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.intro_call_steps FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.neo_images FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.newsletter_sends FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.newsletter_stories FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.newsletters FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.performance_guarantees FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.pricing_tiers FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.proposal_followups FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.report_configs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.report_highlights FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.report_queue FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.report_snapshots FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.signed_agreements FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.signed_performance_guarantees FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.site_deployments FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.social_platforms FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.stock_image_keywords FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.stock_images FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.tracked_keywords FROM anon;


-- ─────────────────────────────────────────────────────────────────────
-- Category C: tables with no anon policy
--   RLS blocks everything for anon already. Revoke ALL to hide from
--   PostgREST discovery and fail-loud on any accidental call.
-- ─────────────────────────────────────────────────────────────────────

REVOKE ALL ON public.activity_log FROM anon;
REVOKE ALL ON public.addon_orders FROM anon;
REVOKE ALL ON public.admin_profiles FROM anon;
REVOKE ALL ON public.contacts FROM anon;
REVOKE ALL ON public.cron_alerts_sent FROM anon;
REVOKE ALL ON public.cron_runs FROM anon;
REVOKE ALL ON public.error_log FROM anon;
REVOKE ALL ON public.newsletter_subscribers FROM anon;
REVOKE ALL ON public.payments FROM anon;
REVOKE ALL ON public.pricing_products FROM anon;
REVOKE ALL ON public.proposal_versions FROM anon;
REVOKE ALL ON public.proposals FROM anon;
REVOKE ALL ON public.settings FROM anon;
REVOKE ALL ON public.webhook_log FROM anon;
REVOKE ALL ON public.workspace_credentials FROM anon;

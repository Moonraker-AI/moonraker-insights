-- Revoke UPDATE on public.contacts from anon.
--
-- Applied via Supabase MCP: revoke_anon_update_on_contacts_2026_04_22
--
-- Context: RLS was already blocking anon UPDATEs (only policies are
-- authenticated_admin_full and service_full_contacts), so this is
-- defense-in-depth, not a functional change. Before this migration the
-- only known client-side writer was checkout/success/index.html flipping
-- contacts.audit_tier='premium' — that call was silently failing (RLS
-- returns empty array without raising). That writer was removed in the
-- commits that pair with this migration (dea709f0 + f4472180).
--
-- After this migration, any anon UPDATE attempt on contacts fails at the
-- grant layer with a clear permission error instead of a silent no-op.
-- If future code ever accidentally re-introduces an anon UPDATE path, it
-- will surface immediately.
--
-- Rollback: GRANT UPDATE ON public.contacts TO anon;

REVOKE UPDATE ON public.contacts FROM anon;

-- Keep SELECT/INSERT/DELETE grants as-is for now. Those are similarly
-- blocked by RLS for anon (no matching policies), but a broader grant-
-- hygiene pass is out of scope for this migration.

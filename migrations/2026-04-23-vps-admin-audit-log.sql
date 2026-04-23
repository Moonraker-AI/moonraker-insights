-- 2026-04-23 — Off-host audit log for Moonraker Agent VPS /admin/exec (VPS-H4).
--
-- Batch 6a hardened the agent VPS admin service but its local log
-- (/var/log/moonraker-admin/app.log) is writable by the same mradmin user
-- that a successful /admin/exec call would drop shell as. A key-leak
-- scenario could overwrite the local log to cover tracks.
--
-- admin_service.py v1.1.0 now fires a fire-and-forget insert into this
-- table on every /admin/exec invocation using the Supabase service_role
-- key stored in /opt/moonraker-admin/.env. Admin UI can read via the
-- is_admin() RLS policy.
--
-- Applied via MCP apply_migration: vps_admin_audit_log

CREATE TABLE IF NOT EXISTS public.vps_admin_audit_log (
  id                bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  client_ip         text        NOT NULL,
  command_truncated text        NOT NULL,
  exit_code         integer     NOT NULL,
  duration_ms       integer     NOT NULL
);

CREATE INDEX IF NOT EXISTS vps_admin_audit_log_created_at_idx
  ON public.vps_admin_audit_log (created_at DESC);

ALTER TABLE public.vps_admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_full_vps_admin_audit_log ON public.vps_admin_audit_log;
CREATE POLICY service_full_vps_admin_audit_log
  ON public.vps_admin_audit_log
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_admin_read_vps_admin_audit_log ON public.vps_admin_audit_log;
CREATE POLICY authenticated_admin_read_vps_admin_audit_log
  ON public.vps_admin_audit_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

COMMENT ON TABLE public.vps_admin_audit_log IS
  'Off-host audit log for Moonraker Agent VPS /admin/exec (audit batch 6a VPS-H4). Written fire-and-forget by admin_service.py using service_role key. Admin UI reads via is_admin() policy.';

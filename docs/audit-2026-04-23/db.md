# Database Audit — 2026-04-23

## Summary

Read-only schema audit of the Moonraker Client HQ Postgres (Supabase) database, scoped to the DB slice of a five-agent parallel audit.

**IMPORTANT — advisor data not available this session.** The Supabase MCP tools (`mcp__supabase__list_tables`, `get_advisors`, `execute_sql`, etc.) were **not exposed as callable functions** in this agent session. `.mcp.json` is absent from the repo; `.claude/settings.local.json` only enables the Supabase MCP server at the IDE level, but the server’s tools are not registered in this sub-agent. This audit therefore relies on **static analysis** of:

- The 41-file `migrations/` history (which contains complete DDL text, RLS policy definitions, function bodies, and policy-tightening narrative from the 2026-04-17 → 2026-04-22 hardening sweep).
- The API code (`api/`, `api/_lib/`) as an oracle for which tables, columns, statuses, and JSONB shapes are actually consumed.
- Repo docs (`CLAUDE.md`, `docs/post-phase-4-status.md`, `docs/keyword-change-protocol.md`, `docs/2fa-storage-decision.md`).

Findings below flag where the *shipped migration history* shows a defect or where *code expects a shape* the schema cannot enforce. Severities are conservative — for live-DB confirmation, the follow-up session needs `get_advisors(security,performance)` + the RLS/policy/CHECK/FK/index queries from the discovery workflow. Every finding below includes a verification query the next MCP-enabled session can run in under a minute.

**Severity counts**
- CRITICAL: 0
- HIGH: 4
- MEDIUM: 7
- LOW: 6
- NIT: 4

The 2026-04-22 sweep (entity-audits agent-task uniqueness, grant-hygiene revoke, advisor cleanup policy + `pricing_tiers_touch_updated_at` search_path pin, `auto_promote_to_active` counting skipped steps) cleared the C/H-tier defects this static audit would otherwise have raised. Remaining risks are structural / coverage gaps the advisor alone cannot see.

## Supabase Advisors (raw)

**Not captured — MCP `get_advisors` unavailable in this session.** The next audit session MUST run:

```
mcp__supabase__get_advisors(project_id=<ref>, type='security')
mcp__supabase__get_advisors(project_id=<ref>, type='performance')
```

Based on migration narrative, advisor state at 2026-04-22 close-of-business was:

- `rls_enabled_no_policy` on `cron_alerts_sent` — closed by `2026-04-22-advisor-cleanup-cron-alerts-sent-policy-and-fn-search-path.sql`.
- `function_search_path_mutable` on `pricing_tiers_touch_updated_at` — closed in same migration.
- `duplicate_index` on `report_queue(client_slug, report_month)` — closed by `2026-04-22-drop-duplicate-report-queue-unique-constraint.sql`.
- Advisor cache lags up to several hours; warnings may still appear until next cache cycle. Any advisor output that persists beyond 2026-04-23 AM PT is new drift and should be added as findings.

## Findings

### HIGH

**[H1] No live confirmation of RLS state on 50+ public tables** — whole public schema. The audit brief requires verifying `pg_class.relrowsecurity` + anon/authenticated/service_role policy coverage per table. Without MCP `execute_sql` this session could not prove the 2026-04-22 grant-hygiene sweep’s claim that *"RLS is already ENABLED on all public tables."* Blast radius: any table where RLS is off and anon still holds SELECT would leak data via PostgREST. Migration `2026-04-22-grant-hygiene-revoke-dead-anon-grants.sql` REVOKEs grants from 48 tables but does not itself re-enable RLS; if any of those tables had RLS disabled, a REVOKE-only posture still leaves service-role readable but anon is now blocked at the grant layer — that is safe, but not confirmed. **Fix sketch:**
```sql
SELECT c.relname,
       c.relrowsecurity    AS rls_on,
       c.relforcerowsecurity AS rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r'
 ORDER BY c.relrowsecurity, c.relname;
```
Any `rls_on=false` with SELECT grants to `anon` or `authenticated` is a finding.

**[H2] Anon policies on proposal/report-style sensitive tables not verified — financial + PII blast radius.** `proposal_versions` explicitly documents *"zero anon policies — financial data"*; `report_snapshots` docstring (from chat.js) says it contains client KPIs + JSONB details. The migrations show policy creation for `proposal_versions` (service_role + authenticated admin only — good) but do not show analogous coverage text for `report_snapshots`, `report_configs`, `campaign_summaries`, `signed_agreements`. If any of these still carry a legacy `FOR SELECT TO anon USING (true)` policy from pre-audit days, the anon key leaks financial data. **Fix sketch (verify first, then tighten):**
```sql
SELECT tablename, policyname, roles, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname='public'
   AND tablename IN ('report_snapshots','report_configs','campaign_summaries',
                     'signed_agreements','proposals','stripe_audit','webhook_log');
```
Any row with `'anon'=ANY(roles)` and `qual='true'` needs scoping to `contact_has_status(contact_id, ARRAY[...])` (follow the pattern in migration 18 for bio_materials / onboarding_steps / practice_details).

**[H3] `contacts.status` + `contacts.lost` have no schema-level consistency.** API code checks `contact.status === 'active' && !contact.lost` (process-entity-audit.js:199, 557, 641, 668; admin directories; stripe-webhook). A row with `status='lost'` AND `lost=false`, or `status='active'` AND `lost=true` AND `lost_reason IS NULL`, are all representable and the advisor does not flag it. CLAUDE.md already calls this out as a known pitfall. **Fix sketch:**
```sql
-- Step 1: see drift today
SELECT status, lost, COUNT(*) FROM contacts GROUP BY 1,2 ORDER BY 3 DESC;

-- Step 2: once code invariants are audited, add a check (probably):
ALTER TABLE contacts ADD CONSTRAINT contacts_lost_coherent CHECK (
  (lost = false) OR
  (lost = true AND lost_at IS NOT NULL)
);
-- Note: whether status='lost' should equal lost=true is an architectural
-- question — flag for user; don't assume.
```

**[H4] Orphan-row spot-checks not executed.** Anti-join queries against known parent/child pairs (`deliverables.contact_id` → `contacts.id`, `onboarding_steps.contact_id` → `contacts.id`, `proposal_versions.proposal_id` → `proposals.id`, `client_attribution_sources.period_id` → `client_attribution_periods.id`) are in the audit brief but cannot run without MCP SQL. Most child tables declared `ON DELETE CASCADE` at creation (verified in migrations), but `delete-client.js` may bypass cascade or partially delete. **Fix sketch (run in next session):**
```sql
-- Deliverables without a live contact
SELECT d.id FROM deliverables d
 LEFT JOIN contacts c ON c.id = d.contact_id
 WHERE c.id IS NULL LIMIT 100;
-- Repeat for: onboarding_steps, intro_call_steps, checklist_items,
-- practice_details, bio_materials, site_map, proposal_versions,
-- proposals, signed_agreements, report_snapshots, report_configs,
-- client_attribution_periods (FK to contacts),
-- client_attribution_sources (FK to client_attribution_periods).
```

### MEDIUM

**[M1] `contacts.status` CHECK constraint coverage unverified.** Code references values `lead | prospect | onboarding | active | lost` (CLAUDE.md lists 4, chat.js Supabase Schema comment lists 4 without `lost`, but `lost` appears as a status in stripe-webhook logic). The *state* of the CHECK is not visible in any migration; no constraint add/drop appears in the 41-file history touching `contacts_status_check`. **Fix sketch:**
```sql
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid='public.contacts'::regclass AND contype='c';

SELECT DISTINCT status FROM contacts;
-- If DISTINCT returns a superset of the CHECK allowlist, either the
-- check is missing or dead rows exist.
```

**[M2] `deliverables.status` enum drift vs. CHECK.** CLAUDE.md chat.js schema lists: `not_started | in_progress | internal_review | waiting_on_client | delivered`. `approved_at` column exists, implying an `approved` status may also be valid. No CHECK visible in migrations. **Fix sketch:** same pg_constraint query scoped to deliverables.

**[M3] `newsletters.content` JSONB is free-form; code assumes structure.** `CLAUDE.md` pitfall #2 warns about double-encoding; `sb.js` helpers pass JS objects. Nothing in the schema prevents `content = "a string"` or `content = 42`. Blast radius: a bad publish breaks rendering silently. **Fix sketch:**
```sql
ALTER TABLE newsletters
 ADD CONSTRAINT newsletters_content_shape CHECK (
   jsonb_typeof(content) = 'object'
   AND content ? 'blocks'
   -- plus whatever the renderer requires
 );
```
Confirm shape before adding — read `api/_lib/newsletter-template.js` for the contract.

**[M4] `site_map.data` JSONB — same class of drift.** Shipped schema not inspected this session; recent commits (`site-map-action`, `site-map-get`) show active writes. Verify presence, then add a `jsonb_typeof = 'object'` guard.

**[M5] `report_snapshots` JSONB details (`gsc_detail`, `ga4_detail`, `gbp_detail`, `ai_visibility`) have no schema shape.** Reports silently render wrong if a cron writes a malformed payload. Candidate for a soft `jsonb_typeof = 'object'` check; full schema would be heavy.

**[M6] `auto_promote_to_active` trigger does not gate on contact status other than `onboarding`.** The 2026-04-22 rewrite fires on step transitions into `complete|skipped` when `contact_status='onboarding'`. Correct today — but the function body does the transition check inside PL/pgSQL instead of a `WHEN (NEW.status IN ('complete','skipped') AND ...)` trigger clause. Per gotcha #8 this still fires the function call per row even when nothing will change. Performance only, not correctness. **Fix sketch:** wrap the `IF NEW.status IN (...) AND (OLD.status IS NULL OR ...)` logic as a trigger `WHEN` clause so PG skips the function entirely on non-terminal transitions.

**[M7] FK-covering index audit not performed.** Gotcha #9 requires `CREATE INDEX IF NOT EXISTS` on every FK column. Several migrations add them (client_attribution_periods_contact_idx, ix_proposals_active_version, cron_runs_name_started_idx, report_queue_client_month_uq, etc.) but there is no session-level proof that every FK is covered. **Fix sketch:**
```sql
-- Unindexed FKs (advisor category: unindexed_foreign_keys)
SELECT c.conrelid::regclass AS table_name, a.attname AS column_name
  FROM pg_constraint c
  JOIN pg_attribute  a
    ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
 WHERE c.contype = 'f'
   AND NOT EXISTS (
     SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND a.attnum = ANY(i.indkey)
   );
```

### LOW

**[L1] `claim_next_audit()` is `SECURITY DEFINER` — grant surface not verified.** Migration `2026-04-19-audit-queue-claim-rpc.sql` correctly sets `SET search_path = public`, but does not document who may `EXECUTE` the function. If `anon` or `authenticated` can call it, they can flip queued → dispatching on any audit. **Fix sketch:**
```sql
SELECT p.proname, p.prosecdef, p.proconfig,
       array_agg(r.grantee) FILTER (WHERE r.grantee IS NOT NULL) AS granted_to
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN information_schema.role_routine_grants r
         ON r.routine_name = p.proname AND r.routine_schema='public'
 WHERE n.nspname='public' AND p.prosecdef
 GROUP BY 1,2,3;
```
If granted to anon/authenticated, `REVOKE EXECUTE ... FROM anon, authenticated;`.

**[L2] Bulk-seeded `onboarding_steps` as `complete` will not fire `auto_promote_to_active`.** This is CLAUDE.md pitfall territory — known gotcha; no schema fix, but the discovery-audit should run a reconciliation query for contacts with all-complete onboarding steps AND `status='onboarding'`:
```sql
SELECT c.id, c.slug, c.status,
       COUNT(s.*) FILTER (WHERE s.status IN ('complete','skipped')) AS done,
       COUNT(s.*) AS total
  FROM contacts c JOIN onboarding_steps s ON s.contact_id = c.id
 WHERE c.status='onboarding'
 GROUP BY 1,2,3
HAVING COUNT(s.*) = COUNT(s.*) FILTER (WHERE s.status IN ('complete','skipped'));
```
Any rows → manual promote or trigger a no-op UPDATE to fire the trigger.

**[L3] `keywords` table retire-semantics not verified by schema.** `docs/keyword-change-protocol.md` says never delete, only retire via `retired_at` / `retired_reason`. `proposal_versions` enforces the same pattern by convention but has no CHECK. Nothing prevents a DELETE from the admin UI. **Fix sketch:** grep `action-schema.js` for `keywords` allowlist entry (agent brief is read-only — flag, don’t apply). Consider `delete: false` in action-schema and/or a trigger `BEFORE DELETE` that raises.

**[L4] Attribution tables lack `created_by` / `updated_by`.** `client_attribution_periods` tracks `reported_by` but no admin audit column. Low impact — nit-tier really; promote if compliance ever matters.

**[L5] `webhook_log`, `stripe_audit` retention not documented.** These tables grow monotonically; a 30-day prune lives for `cron_runs` but not webhooks. Space not correctness risk; flag for the next performance cycle.

**[L6] Unused-index scan not executed.** Advisor `unused_index` catches these. Cannot run without `pg_stat_user_indexes` access.

### NIT

**[N1] No live migration-drift check against `supabase_migrations.schema_migrations`.** The 41 files in `migrations/` are applied via `mcp.apply_migration` per the comment headers (each names its Supabase MCP migration name). DR parity is implicit. The next session should run:
```sql
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 80;
```
and diff against `ls migrations/*.sql` to catch any dashboard-applied drift.

**[N2] Table and index sizes not captured.** `pg_total_relation_size` + `pg_relation_size(reltoastrelid)` sweep pending. Relevant for `report_snapshots`, `webhook_log`, `stripe_audit`, `cron_runs`, `entity_audits`.

**[N3] No JSONB-typeof lint across all jsonb columns.** Simple survey:
```sql
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema='public' AND data_type IN ('jsonb','json');
```
Then sample each column for `jsonb_typeof`:
```sql
SELECT jsonb_typeof(content), COUNT(*) FROM newsletters GROUP BY 1;
```

**[N4] `contacts.status = 'lost'` vs. `contacts.lost = true` vocabulary ambiguity.** Code uses both, sometimes interchangeably, sometimes combined (`!contact.lost` plus `status='lead'`). A doc note in `CLAUDE.md` clarifies; a constraint does not. Decide: is `status='lost'` a thing at all, or is `lost=true` the only representation? If the former is dead, drop from any enum CHECK.

---

## Systemic patterns

1. The 2026-04-22 sweep closed grant hygiene and search_path hygiene thoroughly; the residual risk is **shape-enforcement for JSONB columns** and **CHECK-constraint completeness for status enums**. Both are code-side invariants the schema does not defend.
2. The `lost` flag vs. `status='lost'` ambiguity is a recurring authorial inconsistency. Pin semantics in schema.
3. Heavy reliance on `ON DELETE CASCADE` (attribution, proposal_versions, etc.) is correct, but orphan-scan has not been run.
4. Trigger functions use PL/pgSQL IF-guards instead of trigger `WHEN` clauses — costs per-row function calls.

## Requires architectural decision

- **Lost semantics.** Unify on boolean or enum, retire the other.
- **JSONB shape enforcement cost.** Add structural checks now (cheap on today's row counts) or defer.
- **Retire vs delete** enforcement for `keywords` and `proposal_versions` — schema-side or code-side only?

## Discrepancies with prior assumptions

- CLAUDE.md pitfall #3: *"CHECK constraints return empty arrays (not errors)"* — confirmed still active pattern (`entity_audits_status_check` was silently blocking RPC claim for days per migration `2026-04-21-entity-audits-add-dispatching-status.sql`). No migration has changed the behavior; it remains the operator's responsibility to verify writes.
- CLAUDE.md: *"RLS pattern: FOR SELECT TO anon USING (true) per table"* — this is OUT OF DATE. The 2026-04-22 sweep + migration 18 (`anon_read_*_scoped` policies for bio_materials, onboarding_steps, practice_details) replaced `USING (true)` with `USING (public.contact_has_status(contact_id, ARRAY[...]))`. Update CLAUDE.md so future contributors do not regress to the old pattern.
- Chat.js Supabase Schema comment omits `lost` from the status enum list — inconsistent with CLAUDE.md + code.

## Follow-up required

Next session MUST be MCP-enabled and run, at minimum:
1. `get_advisors` security + performance.
2. RLS state sweep (H1 query above).
3. Anon-policy scope sweep (H2 query).
4. Contacts status/lost drift sweep (H3 + M1 queries).
5. Orphan anti-joins (H4).
6. Unindexed-FK sweep (M7 query).
7. SECURITY DEFINER execute-grant sweep (L1 query).
8. Migration-drift vs `supabase_migrations.schema_migrations` (N1).

All are SELECT-only and complete in under 10 seconds combined.

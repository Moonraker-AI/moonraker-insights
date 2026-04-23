# Consolidated Remediation Plan — 2026-04-23

Synthesis across 5 parallel read-only audits: API, frontend, cron, DB, VPS.

## Cross-domain severity totals

| Domain | C | H | M | L | N |
|---|---|---|---|---|---|
| API      | 0 | 5 | 11 | 15 | 10 |
| Frontend | 3 | 5 | 11 |  8 |  4 |
| Cron     | 1 | 3 |  6 |  4 |  3 |
| DB       | 0 | 4 |  7 |  6 |  4 |
| VPS      | 0 | 4 |  5 |  6 |  4 |
| **Total**| **4** | **21** | **40** | **39** | **25** |

DB "0 Critical" is conservative — the MCP Supabase tools were not exposed to that sub-agent session, so all DB HIGHs are static-analysis projections awaiting live-DB confirmation. A re-run with MCP access may elevate some HIGHs to CRITICAL.

---

## Top CRITICAL items (all frontend + 1 cron)

| ID | One-liner | File |
|---|---|---|
| FE-C1 | `iframe.contentDocument.write(body_html)` no sandbox — DB-controlled HTML executes in admin origin (3 sites) | `admin/clients/index.html:4819, 7604, 9213` |
| FE-C2 | Same pattern, AI-generated audit-followup HTML | `admin/clients/index.html:4820` |
| FE-C3 | `SB_SVC` var misleadingly named (actually anon JWT) — future-dev landmine | `admin/proposals/index.html:338` |
| CR-C1 | `process-followups` no retry; one Resend hiccup = permanent `status='failed'` | `api/cron/process-followups.js:58-65, 96-103` |

Layman: three admin screens can be tricked into running attacker-supplied JavaScript while you're logged in as admin — full session takeover. And the proposal-followup / audit-followup email queue silently gives up forever after one failed Resend call.

---

## Proposed remediation batches (ordered)

Each batch is self-contained: one set of changes, one review, one deploy, verify before next.

### Batch 0 — Safe quick wins (no decisions, no migrations)
Small diffs, additive filters, timeouts, doc fixes. Low risk. Ship first to clear noise.

| ID | Action | File |
|---|---|---|
| CR-L4 | Fix comment schedule drift | `api/cron/cleanup-rate-limits.js:8` |
| CR-M4 | `fetch` → `fetchT` 15s timeout on Resend | `api/cron/process-followups.js:119-130` |
| CR-M5 | Same, daily digest path | `api/cron/trigger-quarterly-audits.js:121-143` |
| CR-M6a | Add `AbortSignal.timeout(30000)` to agent dispatch | `api/cron/process-audit-queue.js:372` |
| CR-M6b | Add `"api/cron/process-audit-queue.js": { "maxDuration": 60 }` | `vercel.json` |
| CR-H2 | Add `&status=eq.agent_running` / `&status=eq.dispatching` guards to PATCH URLs (3 sites) | `api/cron/process-audit-queue.js:160, 183, 193` |
| API-L3 | Add method guard to health.js | `api/health.js` |
| FE-M4 | `String(data.body_html \|\| '').replace(…)` nullish guard (5 sites) | `admin/clients/index.html:3197, 4299, 4943, 8954, 9250, 9334`, `admin/audits/index.html:768` |
| FE-L1/L2/L3/L8 | Add `alt` / `title` attributes to images + iframes | multiple admin + template files |
| API-L11 | Replace raw `Authorization` compare with `requireAdminOrInternal` | `admin/attribution-sync.js:35` |

Risk: near-zero. Deploys in one PR. No schema changes. No behavior changes beyond added safety.

---

### Batch 1 — CRITICAL security fixes (frontend XSS + cron retry)
Two independent efforts.

**Part A (frontend XSS):**
- FE-C1 + FE-C2 + FE-H4: migrate all 4 `contentDocument.write` sites to sandboxed srcdoc pattern already used at L4299/4943/8954/9250. Complete escape: `&`, `"`, `<`, `'`.
- FE-C3: rename `SB_SVC` → `SB_ANON` at `admin/proposals/index.html:338`. Doc the trust boundary in a header comment. No behavior change.

**Part B (cron retry — requires migration):**
- CR-C1: mirror `newsletters.send_*` pattern onto `proposal_followups` + `audit_followups`. New columns: `followup_attempt_count`, `followup_retriable`, `followup_next_attempt_at`, `last_followup_error`. Classify HTTP status, 5/15/60-min backoff, `monitor.critical` at exhaustion. Extend SELECT to include retriable failed rows.

Decision needed for Part B: **see Decision 1 below.**

Risk Part A: medium — admin UI email preview changes need visual QA. Risk Part B: medium — migration + handler rewrite, but pattern is already proven on newsletters.

---

### Batch 2 — HIGH: API hardening (mostly systemic sweeps)

| ID | Action | Scope |
|---|---|---|
| API-H1 | Sweep ~25 handlers; replace `err.message` in response body with generic domain string; route detail through `monitor.logError(route, err, { detail })` | 25+ files, all under `api/` |
| API-H2 | Add per-admin rate limit on Claude passthrough | `api/chat.js` |
| API-H3 | Wrap every body-derived ID in `encodeURIComponent`; validate `keyword_ids` array elements against UUID regex before `.join(',')`; migrate to `pgFilter.buildFilter` where practical | `api/trigger-*.js`, `api/ingest-*.js`, `api/process-batch-synthesis.js`, `api/generate-neo-image.js`, `api/send-newsletter.js`, `api/trigger-batch-audit.js` |
| API-M8a | Add rate limit to `checkout/create-session` | `api/checkout/create-session.js` |
| API-M10 | Wrap `metadata.slug` in `encodeURIComponent` | `api/stripe-webhook.js:153` |
| API-M5 | Strip `svix-signature` from `headers_snapshot` before log write | `api/newsletter-webhook.js:42-48` |

Risk: low. Mostly defense-in-depth and error-message cleanup. API-H1 touches many files but is mechanical.

---

### Batch 3 — HIGH: Frontend admin-auth tightening

| ID | Action | Scope |
|---|---|---|
| FE-H1 | Drop `allow-same-origin` on newsletter preview iframe OR sanitize `/api/newsletter-preview` through `html-sanitizer.js` allowlist | `admin/newsletter/index.html:725, 2058` |
| FE-H2 | Migrate admin directory pages from direct anon PostgREST reads to `/api/admin/*-directory` endpoints | `admin/onboarding`, `admin/reports`, `admin/audits`, `admin/deliverables`, `admin/clients` |
| FE-H3 | Route password-change + must-change-password clearing through server-side `/api/auth/change-password` with role-change validation | `admin/login/index.html:196, 247, 340` |
| FE-H5 | Sanitize endorsement HTML through `html-sanitizer.js` before concat; use function replacer to kill regex backref interpretation | `_templates/content-preview.html:168-185` |

Risk: medium. Touches admin surfaces used daily. Visual + functional QA needed per page.

---

### Batch 4 — HIGH: DB verification + remediation (requires MCP re-run)
The DB agent ran static-only. Before migrating anything, re-run with MCP exposed:
- `get_advisors(security, performance)` raw output
- RLS state sweep (DB-H1 query)
- Anon-policy scope on financial tables (DB-H2 query)
- `contacts.status` + `contacts.lost` drift (DB-H3, DB-M1)
- Orphan anti-joins (DB-H4)
- Unindexed-FK sweep (DB-M7)
- SECURITY DEFINER execute-grant sweep (DB-L1)
- Migration-drift vs `supabase_migrations.schema_migrations` (DB-N1)

All SELECT-only, under 10s combined. Output drives a new migration batch.

Likely outputs:
- RLS re-enable on any table where it's off
- Anon-policy tightening on `report_snapshots`, `report_configs`, `campaign_summaries`, `signed_agreements`, `stripe_audit`, `webhook_log`
- `contacts` coherence constraint (see Decision 2)
- CHECK constraints on `contacts.status`, `deliverables.status`
- Index creation for uncovered FKs
- REVOKE EXECUTE on SECURITY DEFINER functions from anon/authenticated

Risk: depends on findings. Will propose a fresh batch plan after the re-run produces concrete state.

---

### Batch 5 — HIGH: Cron concurrency-safety (after DB retry-state migration)

| ID | Action |
|---|---|
| CR-H1 | Fold Step 0.5 (agent_error requeue) into SECURITY DEFINER RPC `requeue_retriable_agent_errors(...)` using `UPDATE ... RETURNING` + `FOR UPDATE SKIP LOCKED` |
| CR-H3 | Add retry state to `report_queue` (mirrors C1 pattern); extend `claim_next_report_queue` RPC to include retriable rows |

Also Batch 5: address Cron M1, M2 (error classification), M3 (async telemetry snapshot), M6 route config correctness.

Depends on Decision 1. Risk: medium — RPC changes need careful migration + rollback.

---

### Batch 6 — HIGH: VPS hardening + token rotation

Order matters inside this batch.

| Step | Action | Depends |
|---|---|---|
| 6.1 | Widen `caddy-admin-401` fail2ban regex to match `(401\|403\|422)` (VPS-H3) | none |
| 6.2 | Decide on `/admin/exec` posture (VPS-H2) — see Decision 5 | none |
| 6.3 | Ship `/admin/exec` hardening per 6.2 | 6.2 |
| 6.4 | Stand up off-host admin audit log (VPS-H4) | none |
| 6.5 | Coordinate bearer-token rotation window; rotate `AGENT_API_KEY` in Vercel + `/opt/moonraker-agent/.env` + `/opt/moonraker-admin/.env`, recreate container (VPS-H1) | 6.1, 6.3, 6.4 |
| 6.6 | `docker builder prune`, enable docker.com unattended-upgrades, add `no-new-privileges` + cap-drops (VPS-M1/M2/L3), systemd sandboxing (VPS-M4) | 6.5 |
| 6.7 | Optional: move SSH to non-standard port (VPS-M3) | 6.5 |

Risk: 6.5 is the dangerous one — mis-rotation breaks every Surge + content audit cron. Pre-flight checklist required.

---

### Batch 7 — MEDIUM / LOW / NIT sweep

Remaining ~90 findings. Suggest grouping by file rather than severity at this point (cheaper to edit one file once). Will produce a list when earlier batches ship.

Notable items worth surfacing:
- API-M3 audit/contact mismatch validation (data-integrity)
- API-L6 CSP-report rate limit + size cap (log flooding)
- API-L7 `action-schema.js` tightening when non-Chris admins exist
- FE-M5 explicit `credentials: 'same-origin'` on client-template fetches
- FE-M7 vendor the Supabase SDK, remove external CDN grant (`cdn.jsdelivr.net` CSP)
- FE-M1/M2 add `offline-banner.js` to `add-ons.html` + all admin pages

---

## Architectural decisions blocking remediation

These need your input before I can dispatch the corresponding batch. Each has a recommended default.

### Decision 1 — Cron retry state rollout (blocks CR-C1, CR-H3)
**Question:** How should we store retry metadata for `proposal_followups`, `audit_followups`, `report_queue`?

- **A (recommended):** Add 4 columns per table, mirror proven newsletter pattern. Uniform, already understood by team. Cost: 3 migrations, 3 handler rewrites. ~1 day.
- **B:** Single `queue_retry_state` table, keyed by `(queue_name, row_id)`. DRY but adds join on every claim. Less idiomatic.
- **C:** Shove into `cron_runs.detail` jsonb. Don't recommend.

**Laymen:** Currently a newsletter send failure auto-retries with backoff. A proposal-followup or monthly-report failure does NOT retry. We need to give the other queues the same behavior. Option A = copy-paste the newsletter approach onto each queue. Option B = build a shared table. A is faster and simpler, B is prettier long-term. I recommend A.

### Decision 2 — `contacts.status` vs `contacts.lost` semantics (blocks DB-H3)
**Question:** Is `lost` a boolean flag that overlays any status, or is `status='lost'` the canonical representation?

Today the code checks both inconsistently. CLAUDE.md already flags this as a pitfall.

- **A:** `lost` boolean only; remove `'lost'` from status enum; `lost=true` can coexist with any `status`. Best when lost clients still need pipeline-stage context (e.g. a `status='active'` client who churns).
- **B:** `status='lost'` only; drop `lost` column. Best when "lost" is terminal and no other status matters after.
- **C (recommended):** Keep both but add CHECK: `lost=true IFF status='lost'`. Preserves both shapes; schema enforces coherence.

**Laymen:** We have two fields saying whether a client churned. They can disagree silently today. Decision is: do you want to be able to say "this client is active but we're treating them as lost for reporting purposes"? If yes → A. If no → B or C. I lean C because it fixes the bug without rewriting existing logic.

### Decision 3 — JSONB shape enforcement (blocks DB-M3, M4, M5)
**Question:** Add structural CHECK constraints to `newsletters.content`, `site_map.data`, `report_snapshots.*_detail` now, or defer?

- **A (recommended):** Add soft `jsonb_typeof = 'object'` checks now. Cheap, catches gross corruption (the CLAUDE.md double-encoding pitfall would have been caught).
- **B:** Full shape schemas (JSON schema extension or custom CHECK functions). Catches more, maintenance burden.
- **C:** Defer; rely on code-side validation.

**Laymen:** Right now if a cron writes garbage into a JSONB column, the database accepts it and only the rendered page breaks. A is a cheap guardrail. B is overkill. C is fine if you trust the code. I recommend A.

### Decision 4 — `keywords` retire-only enforcement (blocks DB-L3)
**Question:** Current protocol says never DELETE keywords — only retire. Today it's honored by convention, not schema.

- **A:** Set `delete: false` in `action-schema.js` (code-side).
- **B (recommended):** A + add `BEFORE DELETE` trigger that RAISES. Belt + suspenders.
- **C:** Status quo; rely on protocol.

**Laymen:** Deleted keywords break historical report comparisons. Today nothing stops an admin from deleting one. I recommend B because deletions are rare and a loud error is better than silent history loss.

### Decision 5 — `/admin/exec` on VPS (blocks VPS-H2)
**Question:** Agent VPS exposes arbitrary shell behind a bearer token (runs as user with docker group = effective root).

- **A:** Add per-IP rate limit (fail2ban is regex-based + narrow; this adds in-process throttle). Quick fix, still arbitrary shell.
- **B (recommended long-term):** Replace with named RPC endpoints (`/admin/docker/restart`, `/admin/logs/tail`, `/admin/deploy`). Each narrow, each validated, no arbitrary shell.
- **C:** Nonce-per-command — require a fresh nonce minted from a harder-to-steal source (e.g. SSH-signed challenge).

**Laymen:** Today if the bearer token leaks, an attacker can run any shell command on the VPS (which reaches root via docker). A is a band-aid. B is the real fix — replace the "run whatever" endpoint with a menu of specific actions. C is heavy infra. I recommend A now (quick-win in Batch 6), B as a separate effort after rotation.

### Decision 6 — Token rotation window (blocks VPS-H1)
**Question:** When to coordinate rotation of `AGENT_API_KEY` across Vercel + VPS?

- Need ~30 min low-traffic window.
- Should follow VPS-H3 fail2ban widen, VPS-H2 hardening, VPS-H4 off-host log.
- Rollback: revert Vercel env, ssh to VPS and revert `.env`, restart container.

**Laymen:** Tell me a date/time. Ideally weekend morning after the hardening batches ship. No functional change visible to users if done right.

### Decision 7 — `action-schema.js` tightening (blocks API-L7, N5)
**Question:** `workspace_credentials` currently admin-writable by any admin. Only you and Scott are admins today, both trusted.

- **A (recommended):** Defer until a 3rd admin is added.
- **B:** Add `require_role: 'owner'` now, populate `admin_profiles.role`.

**Laymen:** Field-level encryption is the only protection on stored Gmail passwords if an admin JWT leaks. Doesn't matter at 2 admins. Matters when you add a 3rd. I recommend A — revisit when hiring.

### Decision 8 — Email enumeration oracle (blocks API-M9, L8)
**Question:** `submit-entity-audit.js` returns 409 with "We already have a record with this email address." Confirms email existence.

- **A:** Return generic success regardless; surface duplicate in server log only.
- **B (recommended):** Status quo. UX tradeoff wins — legit users need to know.

**Laymen:** Today an attacker can check whether a given email is in our system by trying to submit a form with it. A rate limit of 3/hour caps this. Fixing it makes the form worse for real users who legitimately re-submit. I recommend B.

### Decision 9 — Stripe amount-fallback product detection (API-M6)
**Question:** If `metadata.product` is empty on a Stripe checkout, we route by amount ($2000/$2070 → entity-audit). A new tier priced at $2000 without metadata routes wrong.

- **A (recommended):** Status quo — documented belt-and-suspenders. Add a PR-comment header reminding every new payment link to include `metadata.product`.
- **B:** Remove fallback, reject checkouts without metadata.

I recommend A because fallback is safer than dropping a real payment.

---

## Suggested path forward

1. **You pick defaults for Decisions 1-9** (or override). Laymen recommendations above. Fastest: reply "accept all recommendations" + answer Decision 6 (rotation date).
2. **I ship Batch 0** first. Near-zero risk. Gets the noisy stuff out of the way.
3. **Re-run DB agent with MCP exposed** to resolve DB HIGH projections into concrete findings. Parallel with Batch 1.
4. **Batch 1** (CRITICALs — frontend XSS + cron retry). Biggest impact.
5. **Batches 2-3** (API + frontend HIGHs). Serialized since both touch admin surface.
6. **Batch 4** after DB re-run.
7. **Batches 5-6** (cron concurrency + VPS + token rotation) — require a coordinated window.
8. **Batch 7** (sweep of remaining M/L/N).

Each batch = one PR / one deploy / verify / proceed.

---

## Open cross-agent correlations worth flagging

1. **Surge audit pipeline status (VPS says "unknown"):** The VPS agent can't confirm Surge is working because its log window is only 8h post-rebuild. A SELECT against Supabase `entity_audits WHERE agent_dispatched_at > now() - '7 days'` GROUP BY status answers it. Worth including in the DB re-run as a named query.

2. **Token rotation (VPS-H1) + cron auth (multiple):** `AGENT_API_KEY` gates both CHQ → agent and agent → CHQ. Rotation requires updating Vercel env, `.env` on VPS, recreating container, and verifying `check-surge-blocks` + `process-audit-queue` still succeed post-rotation.

3. **Anon RLS posture on sensitive tables (DB-H2) + frontend anon reads (FE-H2):** Frontend admin pages read `contacts.*` directly with anon key. If DB-H2 reveals a loose anon policy, those admin reads are leaking to unauthenticated users too. Fix order: DB-H2 first (tighten policy), then FE-H2 (migrate reads to `/api/admin/*-directory`).

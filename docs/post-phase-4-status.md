# Post-Phase-4 Status Report

**Date:** 2026-04-17 (late session — Group A fully complete)
**Purpose:** Reconcile what's actually closed, group the ~87 remaining findings, and recommend a path forward that matches the value-per-session curve we've been on.

---

## Where the audit stands

All 9 Criticals closed. **Fifteen Highs closed** (H5, H7, H8, H9, H10, H11, H14, H18, H19, H20, H22, H28, H33, H34, H35). M6, M8, M13, M22, M38 closed; M26 err-leak half closed, prompt-injection half deferred to Group D. **L8**, L14, L26, L27 closed. H21 has scaffolding landed (`api/_lib/google-delegated.js`) but 5 duplicate sites still need migration. `authenticator_secret_key` null-on-all-rows investigation resolved: `SENSITIVE_FIELDS` includes it; the null state just means no 2FA setup has been saved yet through the admin UI. Not a bug.

~82 findings remain. None of them are attack chains of the same severity as C1-C9. Most are hardening, consistency, and observability work. Ordering them linearly doesn't match their actual value; grouping them does.

---

## Grouping of remaining work

### Group A — Secret & config hygiene ✅ COMPLETE

| ID | Issue | Status |
|---|---|---|
| H10 | `api/admin/manage-site.js:15,18` — hardcoded CF account/zone IDs | ✅ closed `e772fa9` |
| H7 | `api/_lib/supabase.js:15` — hardcoded Supabase URL fallback | ✅ closed `330e6da` |
| H28 | `bootstrap-access.js` leaks provider error detail in response body | ✅ closed `0c9bc85` |
| H33 | `newsletter-generate.js` raw Claude output in error responses | ✅ closed `a8155dc` |
| H34 | `send-audit-email.js` Resend response + err.message in 5xx | ✅ closed `225d5a0` + `19b9199` |
| H35 | `generate-content-page.js` NDJSON stream error detail leaks | ✅ closed `b17c790` |
| M13 | `newsletter-webhook.js` e.message in response body | ✅ closed `3a9019d` |
| M26 (err-leak half) | `chat.js` err.message in outer catch | ✅ closed `9dc8c7b` (prompt-injection half → Group D) |
| L15 | Onboarding template anon key exp 2089 | Design question (deferred) |

**Group A done.** 8 findings closed (6 Highs + 1 Medium + 1 Medium-partial). Pattern established: `monitor.logError(route, err, { client_slug, detail: { stage, ... } })` server-side + generic user-facing response. Replicated cleanly across 6 files in two sessions.

### Group B — Shared library extraction (2-3 sessions, mechanical)

| ID | Issue | Status |
|---|---|---|
| H21 + N6 | 7 copies of `getDelegatedToken` → extract `_lib/google-auth.js` with caching | 🔶 helper landed in `7adedb6` (`api/_lib/google-delegated.js` with token caching); 5 duplicate sites still pending migration |
| H4, H24, M10, M16 | `fetch()` without AbortController — extract `fetchWithTimeout` helper | 1 session |
| Pattern 12 | Migrate ~30 inline Supabase fetches in 5 big files to `sb.query`/`sb.mutate` | 1-2 sessions |
| H30, L7, L8, L22 | Duplicated helpers (Fathom dedup, Resend events, sbGet) | L8 ✅ closed; rest open |

**Recommendation:** H21 migration session is cheaper than originally scoped — the helper is already live in `api/_lib/google-delegated.js` with working token caching. Migration reduces to: delete 5 local copies, add require, rename call sites. Then AbortController. Then the Supabase helper migration.

### Group C — Template/email escape defaults ✅ COMPLETE

| ID | Issue | Status |
|---|---|---|
| H18 | Newsletter story fields rendered unescaped | ✅ closed `0cd0670` |
| H19 | Image URL not scheme-validated | ✅ closed `0cd0670` |
| H20 | `p()` + `footerNote` accept raw HTML | ✅ closed `d024b84` (atomic 9-file rename + migration) |
| H22 | Proposal `next_steps` rendered unescaped | ✅ closed `aabdac1` |
| M6 | Monitor alert HTML unescaped | ✅ closed `1147a19` |
| M22 | Unsub subscriberId not URL-encoded | ✅ closed `0cd0670` |

**Group C done.** 6 findings closed in one session across 4 commits. Escape-by-default pattern now in place for `_lib/email-template.js` (both `p` and `footerNote`), `_lib/newsletter-template.js` (all plain-text interpolations + URL scheme validation), `_lib/monitor.js` critical-alert HTML, and `generate-proposal.js` deployed HTML. Future callers get safety by default; 82+ existing email call sites were migrated to explicit `pRaw` to preserve byte-identical output.

**Opportunistic follow-up** (not blocking): audit the 82+ `email.pRaw()` call sites in the 8 migrated files. Sites that pass plain text (no concatenated HTML fragments, no `email.esc()` wrapping) can be upgraded to `email.p()` for belt-and-suspenders safety. Not urgent — the security surface is closed because admin JWTs are the only write path into those templates.

### Group D — AI prompt injection hardening (1 session)

| ID | Issue | Effort |
|---|---|---|
| H25 | `practiceName` raw-interpolated into Claude prompt (compile-report) | Included |
| H31 | 25K chars of RTPBA to Claude verbatim (generate-content-page) | Included |
| M15 | Therapist name unsanitized in content-chat prompt | Included |
| M26 | `page`, `tab`, `clientSlug` in chat.js prompt | Included |

**Recommendation:** One session. Standardize the "untrusted input in Claude prompt" pattern: structured delimiters (`<user_data>` tags), the same kind of treatment C9's endorsement sanitization gave but applied consistently everywhere user input reaches a prompt.

### Group E — Non-transactional state & idempotency (1 session)

| ID | Issue | Effort |
|---|---|---|
| H26 | onboarding seed DELETE+INSERT non-transactional | One session |
| H27 | compile-report highlights DELETE+INSERT non-transactional | Included |
| M11 | deploy-to-r2 DELETE+INSERT not idempotent | Included |
| M30 | generate-proposal fire-and-forget PATCHes swallow errors | Included |

**Recommendation:** One session. All four are the same class of bug — crash between DELETE and INSERT leaves zero rows. Standard fix is upsert or wrap in RPC. Pattern is clear; applying it takes an hour.

### Group F — Public endpoint hardening beyond rate limits (1 session)

| ID | Issue | Effort |
|---|---|---|
| H15 | submit-entity-audit empty-Origin bypass | One session |
| H32 | digest.js recipients from request body, no allowlist | Included |
| M9 | submit-entity-audit slug race condition | Included |
| M12 | manage-site domain "normalization" too permissive | Included |
| M14 | content-chat silently returns nulls on Supabase error | Included |
| M20 | newsletter-unsubscribe UUID-probing oracle | Included |

**Recommendation:** One session. All input-validation/boundary-check fixes on public-ish endpoints.

### Group G — Operational resilience (1 session)

| ID | Issue | Effort |
|---|---|---|
| H1 | `_profileCache` no TTL | 15 min |
| H2 | Still listed as open — but H2 is just "same bug in two files" and the helper is extracted; verify and close | 5 min |
| H3 | `rawToDer` dead code — delete | 5 min |
| H6 | Stripe webhook fire-and-forget to `/api/notify-team` with no retry | 30 min (queue table or inline) |
| H13 | Agreement-chat 8K CSA on every prompt — add Anthropic prompt caching | 30 min |
| H17 | process-entity-audit internal auth fallback empty-string | 15 min |
| H29 | enrich-proposal encrypt `enrichment_data` at rest | 30 min |
| M2 | `last_login_at` updated every request — throttle | 15 min |
| M18 | checklist_items composite ID 8-hex-char collision | 10 min |
| M19 | Webhook race with auto-send audit email | Needs design |

**Recommendation:** Two short sessions, cherry-pick the 15-30 min items into groups of 4-5.

### Group H — M1 Stripe metadata detection (0.5 session)

Documented plan in M1 section. Blocked on you adding `metadata: { product: ... }` to the Stripe payment links dashboard-side. After that's done, code change is 10 minutes + a 30-day observation window before removing the amount fallback.

### Group I — Lows + Nits (1 sweep session)

25 Lows + 6 Nits still listed; several are likely stale after Phase 4. Worth a 1-session sweep: reconcile what's actually still present vs what got closed incidentally, then fix the remaining in-scope items (≤10 lines each).

---

## What's **not** in the groupings

Items I recommend marking "won't fix" or "needs design":

- **L3** (`var` everywhere): cosmetic. Skip.
- **L13** (hardcoded asset URLs): single-domain app. Skip.
- **L15** (anon key exp 2089): RLS is the control. Either leave as-is (accept the risk profile) or plan a migration — not both half-measures.
- **L16** (two Google auth functions in compile-report.js): closes with H21.
- **L19** (personal-email blocklist): add as data, not a code change.
- **M19** (webhook race with auto-send): needs a design — what's the desired behavior when Stripe lands after the free tier email already sent? Hold and refund? Upgrade anyway? Product decision, not a code decision.
- **M37** (auto-schedule doesn't check post-submit status flip): same — is this a bug or intended?

---

## Recommended next session

**Group B.1 — H21 google-auth migration.**

Reasoning:
- Helper (`api/_lib/google-delegated.js`) is already live with working token caching (commit `7adedb6`). Migration reduces to: delete 5 local copies, add require, rename call sites.
- Mechanical — near-free session, zero design questions.
- Closes 2 Highs (H21, H30) plus likely incidental close on L16.
- Good rhythm break after the heavier Group C atomic-rename session.

After that, the recommended sequence is:

1. **Group B.1 — H21 google-auth migration** (1 session, mechanical) — next
2. **Group D — AI prompt injection hardening** (1 session) — closes H25, H31, M15, M26-prompt-half
3. **Group B.2 — AbortController extraction** (1 session) — closes H4, H24 + many Mediums
4. **Group E — non-transactional state** (1 session) — closes H26, H27, M11, M30
5. **Group F — public endpoint hardening** (1 session) — closes H12, H15, H32 + validation Mediums
6. **Group G — operational resilience** (1-2 sessions) — H1, H3, H6, H13, H17, H23, H29 + small Mediums
7. **Group B.3 — Supabase helper migration** (1-2 sessions)
8. **Group I — Lows + Nits sweep** (1 session)
9. **Group H — M1 Stripe metadata** (once dashboard metadata is added)

Approximately 8-10 sessions to clear the remaining open findings, or we stop earlier once diminishing returns kick in. The call on "when to stop" gets clearer around session 5-6 when what's left is mostly Low/Nit polish.

---

## Prompt for next session (Group B.1 — H21 google-auth migration)

```
H21 migration session. The helper `api/_lib/google-delegated.js` has been
live since commit 7adedb6 with working token caching — it's used by
api/campaign-summary.js today. This session replaces 5 local duplicate
implementations with the shared helper.

Read docs/api-audit-2026-04.md sections H21 and H30, and the partial-
progress note under H21 (helper already landed). Then walk through your
plan before touching code.

─────────────────────────────────────────────────────────────────────
Helper signature (pre-verified on main)
─────────────────────────────────────────────────────────────────────

  var google = require('./_lib/google-delegated');

  // Domain-wide delegation (impersonate a Workspace user):
  await google.getDelegatedAccessToken(mailbox, scope);
    // → returns access_token string
    // → THROWS on failure (no more {error} return)
    // → caches by `${mailbox}|${scope}` with 60s pre-expiry buffer

  // Direct SA token (no impersonation):
  await google.getServiceAccountToken(scope);
    // → returns access_token string
    // → THROWS on failure
    // → caches by `sa|${scope}`

  // Try a list of mailboxes, return first that passes testFn:
  await google.getFirstWorkingImpersonation(mailboxes, scope, testFn);
    // Used in campaign-summary.js for GSC property owner variance.

─────────────────────────────────────────────────────────────────────
CRITICAL: return contract differs from the local implementations
─────────────────────────────────────────────────────────────────────

Old local helpers: on failure, return { error: 'msg' }.
Callers check: if (token.error) { ... } or if (!token || token.error)

New helper: THROWS.

Every call site needs a try/catch wrapper OR the call site must live
inside an existing try block with a catch that handles the thrown error.

For each migrated site: preserve behavior precisely. If the old branch
did `results.drive.error = 'Failed to get Drive token: ' + token.error`,
the new try/catch catches and sets the same field with e.message. If it
did `return res.status(500).json({error:'Google auth failed: '+token.error})`,
the catch does the same with e.message.

─────────────────────────────────────────────────────────────────────
Sites to migrate (current line numbers on main)
─────────────────────────────────────────────────────────────────────

Site 1 — api/bootstrap-access.js
  Local impl: `async function getDelegatedToken(saJson, impersonateEmail, scope)` at line 575
  Callers:
    line 121:  var gbpToken = await getDelegatedToken(googleSA, IMPERSONATE_USER, scope)
    line 242:  var ga4Token = await getDelegatedToken(googleSA, IMPERSONATE_USER, scope)
    line 324:  var gtmToken = await getDelegatedToken(googleSA, IMPERSONATE_USER, scope)
  Each caller checks `if (token.error)` on the next line (122, 243, 325).

  Migration:
    - Add `var google = require('./_lib/google-delegated');` at module scope.
    - Each call becomes:
        var token;
        try { token = await google.getDelegatedAccessToken(IMPERSONATE_USER, scope); }
        catch (e) { <same error-handling branch as current>; }
    - Drop the googleSA first arg (helper reads env directly).
    - Delete the local getDelegatedToken function (line 575 onward).
    - The `if (!googleSA) throw` guards (lines 119, 240, 322) become
      redundant (helper checks env) but keeping them is fine for early
      failure — your call.

Site 2 — api/compile-report.js
  TWO local impls (both need migration):
    line 909:  `async function getGoogleAccessToken(saJson, scope)`  — no impersonation
    line 1012: `async function getDelegatedToken(saJson, impersonateEmail, scope)` — with impersonation
  Callers:
    line 182: `if (!token || token.error)` — reviewed as GSC path
    line 257: `if (!gbpToken || gbpToken.error)` — GBP Performance path
    line 942: separate token exchange (NOT the helper — leave alone, it's
              inside the helper's own impl loop)
  Migration:
    - Both get replaced with the new helper:
        getGoogleAccessToken → getServiceAccountToken
        getDelegatedToken    → getDelegatedAccessToken
    - try/catch wrapping as above. Both callers already have `warnings.push`
      error-handling that maps cleanly to catch-block behavior.
    - Delete both local functions.

Site 3 — api/discover-services.js
  Local impl: `async function getGoogleAccessToken(saJson)` at line 281 (no-impersonation variant, no scope arg — scope hardcoded inside)
  Callers:
    line 47: `if (token && token.error) return res.status(500)...`
  Migration:
    - Check line 281 for the hardcoded scope — pass it explicitly to
      google.getServiceAccountToken(scope) at the call site.
    - Wrap in try/catch, preserve the 500 response shape on error.
    - Delete local function.

Site 4 — api/enrich-proposal.js
  Local impl: `async function getDelegatedToken(saJson, impersonateEmail, scope)` at line 414
  Callers: 1 call (line ~92 range — grep to confirm)
  Migration: same try/catch pattern; delete local function.

Site 5 — api/generate-proposal.js
  Local impl: `async function getDelegatedToken(saJson, impersonateEmail, scope)` at line 725
  Callers: 1 call (line ~704 — it branches on `driveToken.error` for
           a results.drive.error field)
  Migration: same try/catch; catch sets results.drive.error with e.message.

─────────────────────────────────────────────────────────────────────
Out of scope for this session
─────────────────────────────────────────────────────────────────────

- api/_lib/google-drive.js: has its own getAccessToken() + module-level
  _cachedToken/_cachedExpiry. Bespoke signature (no-arg — scope hardcoded).
  Separate design concern. Leaving it alone closes H21 as written (5
  route-level duplicates) and doesn't add risk. Fold into a follow-up
  if desired.
- api/campaign-summary.js: already uses the helper, no action.
- H30 (Fathom dedup token caching): partially resolves incidentally —
  enrich-proposal.js's Fathom + Gmail calls now benefit from helper's
  token cache. Mark H30 resolved alongside H21.
- L16 (two Google auth functions in compile-report.js with subtle
  difference): closes incidentally — both are gone after migration.
  Mark L16 resolved.

─────────────────────────────────────────────────────────────────────
Testing
─────────────────────────────────────────────────────────────────────

No new functional behavior — this is a refactor to a pre-existing helper.
Vercel deploy must go READY for each commit.

Smoke tests if desired (not blocking):
- discover-services.js: can exercise via admin UI's "Discover Services"
  button on any onboarding contact.
- bootstrap-access.js: requires a real Leadsie hand-off to exercise
  end-to-end — skip unless you have a test client ready.
- compile-report.js: can exercise via any client's monthly report
  generation.
- enrich-proposal.js: runs during proposal generation; needs a lead
  being promoted to prospect.
- generate-proposal.js: same path as enrich — they run together.

Grep check after each commit:
  grep -rn "function getDelegatedToken\|function getGoogleAccessToken" api/
  — expected: only api/campaign-summary.js (negative) and the helper
    itself have these names after all migrations.

─────────────────────────────────────────────────────────────────────
Deliverables
─────────────────────────────────────────────────────────────────────

5 commits, one per file (in any order — they don't depend on each other):
  - Migrate bootstrap-access.js to google-delegated helper
  - Migrate compile-report.js (both getDelegatedToken and getGoogleAccessToken)
  - Migrate discover-services.js
  - Migrate enrich-proposal.js
  - Migrate generate-proposal.js

Final: doc update to api-audit-2026-04.md:
  - Mark H21 resolved (was partial — now full, all 5 route-level
    duplicates migrated)
  - Mark H30 resolved (incidental)
  - Mark L16 resolved (incidental)
  - Update running tallies: High 15 → 17 resolved, Low 4 → 5 resolved
  - Note google-drive.js helper-integration as candidate follow-up

Also update post-phase-4-status.md: mark Group B.1 complete.
```

## Closing thought on the grouping approach

The original phase-based plan (phases 1-7) was right when the audit was fresh and we needed to prioritize Criticals. Now that Criticals are all closed, continuing phase-by-phase would force awkward sequencing — e.g. doing H9 in "Phase 5" and H18 in "Phase 7" even though they're unrelated.

Grouping by shape (what kind of fix, what files, what skill) means each session has a single theme, one mental model, one commit style. That's a better fit for the current phase of work.

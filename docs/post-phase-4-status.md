# Post-Phase-4 Status Report

**Date:** 2026-04-17 (late session)
**Purpose:** Reconcile what's actually closed, group the ~96 remaining findings, and recommend a path forward that matches the value-per-session curve we've been on.

---

## Where the audit stands

All 9 Criticals closed. Five Highs closed (H5, H8, H9, H11, H14). M8 and L14 closed. `authenticator_secret_key` null-on-all-rows investigation resolved: `SENSITIVE_FIELDS` includes it; the null state just means no 2FA setup has been saved yet through the admin UI. Not a bug.

~96 findings remain. None of them are attack chains of the same severity as C1-C9. Most are hardening, consistency, and observability work. Ordering them linearly doesn't match their actual value; grouping them does.

---

## Grouping of remaining work

### Group A — Secret & config hygiene (2-3 sessions, low risk, high cleanup value)

| ID | Issue | Effort |
|---|---|---|
| H10 | `api/admin/manage-site.js:15,18` — hardcoded CF account/zone IDs | 15 min |
| H7 | `api/_lib/supabase.js:15` — hardcoded Supabase URL fallback | 5 min |
| L15 | Onboarding template anon key exp 2089 | Design question |
| H28 | `bootstrap-access.js` leaks provider error detail in response body | 30 min |
| H33, H34, H35, M13, M26 | `err.message` leaks in various 5xx responses | 1 session (pattern fix) |

**Recommendation:** Do H10 + H7 + H28 in one 30-min session (three small, independent fixes). Then one session on the error-leak pattern across all 20+ instances. L15 needs a design decision (rotate to shorter exp + migrate templates, or keep RLS-only) — defer until we're ready to ship.

### Group B — Shared library extraction (2-3 sessions, mechanical)

| ID | Issue | Effort |
|---|---|---|
| H21 + N6 | 7 copies of `getDelegatedToken` → extract `_lib/google-auth.js` with caching | 1 session |
| H4, H24, M10, M16 | `fetch()` without AbortController — extract `fetchWithTimeout` helper | 1 session |
| Pattern 12 | Migrate ~30 inline Supabase fetches in 5 big files to `sb.query`/`sb.mutate` | 1-2 sessions |
| H30, L7, L8, L22 | Duplicated helpers (Fathom dedup, Resend events, sbGet) | 30 min |

**Recommendation:** H21 first (touches 7 files, but each edit is near-identical — lift one copy, add token caching, replace the other six). Then AbortController. Then the Supabase helper migration — that one's the biggest but also the highest code-quality payoff; splitting across two sessions (compile-report.js + process-entity-audit.js one session, the other 3 files the next) keeps per-session scope manageable.

### Group C — Template/email escape defaults (1 session, template surface)

| ID | Issue | Effort |
|---|---|---|
| H18 | Newsletter story fields rendered unescaped | In one session |
| H19 | Image URL not scheme-validated | Same session |
| H20 | `p()` + `footerNote` accept raw HTML | Same session |
| H22 | Proposal `next_steps` rendered unescaped | Same session |
| M6 | Monitor alert HTML unescaped | Same session |
| M22 | Unsub subscriberId not URL-encoded | Trivial |

**Recommendation:** One session. Goal: make the default behavior of every template helper "escape input," add `.raw()` variants for the rare case when the caller actually has HTML. This pattern lands across all template modules at once.

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

**Group A: H10 + H7 + H28 (30-45 min, three independent fixes).**

Reasoning:
- After the Critical-closing marathon, a short session is a good rhythm break.
- Each fix is under 15 minutes. High ship rate. Good dopamine.
- H10 has the same shape as H9 we just shipped (hardcoded → env var), so it's in context.
- H28 is a straightforward "don't leak provider error detail in response body" — one of ~20 instances of the pattern, so it tees up Group G's broader error-leak cleanup.

After that, the recommended sequence is:

1. **Group A small wins** (30 min) — H10, H7, H28
2. **Group B.1 — H21 google-auth consolidation** (1 session) — touches 7 files, well-defined
3. **Group C — template escape defaults** (1 session) — fixes 6 related findings in one pass
4. **Group B.2 — AbortController extraction** (1 session)
5. **Group D — AI prompt injection hardening** (1 session)
6. **Group E — non-transactional state** (1 session)
7. **Group B.3 — Supabase helper migration** (1-2 sessions)
8. **Group F — public endpoint hardening** (1 session)
9. **Group A.2 — error-leak pattern fix** (1 session)
10. **Group G — operational resilience batched small items** (1-2 sessions)
11. **Group I — Lows + Nits sweep** (1 session)
12. **Group H — M1 Stripe metadata** (once dashboard metadata is added)

Approximately 11-13 sessions to clear the remaining open findings, or we stop earlier once diminishing returns kick in. The call on "when to stop" gets clearer around session 6-7 when what's left is mostly Low/Nit polish.

---

## Prompt for next session (Group A)

```
Small-wins session. Three independent fixes, all in the same class as H9:
find a hardcoded config value that looks like a secret or infra ID,
move it to env, fail closed on missing.

Read docs/api-audit-2026-04.md sections H7, H10, H28 first.

1. H10 — api/admin/manage-site.js:15,18 has hardcoded:
     var CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || 'b0d0e7ccfcabdec0507b4cac779f048a';
     var MOONRAKER_ZONE_ID = '6fc1c4c24d0e13b5cbf044ba73440b85';
   These aren't secrets but they're infrastructure identifiers that don't
   belong in source. Pre-session verification: check Vercel env for
   CF_ACCOUNT_ID (likely already set from other callers) and MOONRAKER_ZONE_ID
   (may or may not exist). Set any missing vars, then remove fallbacks.
   Module-load warning pattern matching H9.

2. H7 — api/_lib/supabase.js:15 has:
     SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
   Remove the fallback; throw at module load if unset. Same pattern.

3. H28 — api/bootstrap-access.js:466-473 returns `results` in the response
   body that may contain raw provider (Google/LocalFalcon) error JSON with
   account IDs, quotas, internal fields. Admin-only endpoint, but any log
   capture exposes provider internals. Sanitize: only return a boolean
   success flag + a brief human-readable summary per provider. Log full
   detail via monitor.js for admin debugging.

Pre-session verification:
- Current Vercel env var state: do CF_ACCOUNT_ID and MOONRAKER_ZONE_ID
  already exist? (If either is set, we only need to remove the fallback.
  If unset, we add it first — mirror the H9 workflow.)
- Grep for 'b0d0e7cc' and '6fc1c4c2' in the repo to find any other hardcoded
  copies of these IDs that might need to move to env at the same time.
- Check NEXT_PUBLIC_SUPABASE_URL is set in Vercel (very likely yes —
  everything else reads from it).

Out of scope: anything else in the audit doc. Three fixes, three commits,
one doc update at the end.

Walk through the plan before touching code.
```

---

## Closing thought on the grouping approach

The original phase-based plan (phases 1-7) was right when the audit was fresh and we needed to prioritize Criticals. Now that Criticals are all closed, continuing phase-by-phase would force awkward sequencing — e.g. doing H9 in "Phase 5" and H18 in "Phase 7" even though they're unrelated.

Grouping by shape (what kind of fix, what files, what skill) means each session has a single theme, one mental model, one commit style. That's a better fit for the current phase of work.

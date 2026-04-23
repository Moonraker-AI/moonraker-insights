# API + Auth Audit — 2026-04-23

## Summary

Overall posture is strong and the code clearly reflects a long remediation history (the 2026-04 audit closed 121 findings, and the patterns survive: shared `_lib/auth`, `_lib/page-token`, `_lib/supabase`, `_lib/rate-limit`, `_lib/postgrest-filter`). Every `api/admin/*` handler gates behind `requireAdmin` or `requireAdminOrInternal`. Every client-facing write (`onboarding-action`, `submit-endorsement`, `progress-update`, `sign-guarantee`, `save-guarantee-draft`, `site-map-action`, `proposal-chat`, `campaign-summary-chat`, `submit-endorsement`) verifies a scoped page-token and enforces slug/contact_id binding server-side. Stripe + Resend/Svix webhooks validate HMAC signatures with `crypto.timingSafeEqual`, using raw body buffers and the standard `bodyParser: false` opt-out. Service-role key is never exposed to the browser; anon reads now flow through `/api/public-*` endpoints with column allowlists and cache-control headers.

Weak spots cluster in **three areas**: (1) unencoded interpolation of admin-controlled `body.id` values into PostgREST filters across ~12 admin/internal routes (works today because PostgREST escapes, but violates the "always encodeURIComponent" defense-in-depth pattern the audit established); (2) pervasive leakage of `err.message` and `e.message` into 500 response bodies across ~25 handlers (violates invariant #3 from SESSION_INSTRUCTIONS); (3) `admin/chat.js` has no rate limit on the Anthropic passthrough — a compromised admin session can burn tokens unbounded. Zero hardcoded secrets, zero SSRF via request-controlled URLs, no eval/new Function/exec, and no CORS wildcards were found.

## Findings

### CRITICAL

(None.)

---

### HIGH

- **[H1] `err.message` in 5xx response bodies — ~25 sites, systemic** — `api/page-token/request.js:63,71`, `api/newsletter-preview.js:48`, `api/notify-team.js:134`, `api/convert-to-prospect.js:57`, `api/generate-followups.js:39,118`, `api/delete-proposal.js:37`, `api/delete-entity-audit.js:55`, `api/approve-followups.js:70`, `api/ingest-surge-content.js:71`, `api/trigger-batch-audit.js:95`, `api/newsletter-research.js:115,378`, `api/newsletter-subscribers-delete.js:75`, `api/newsletter-regenerate-story.js:67`, `api/newsletter-subscribers-import.js:179`, `api/newsletter-verify.js:61,160`, `api/send-proposal-email.js:37,82`, `api/compile-report.js:102`, `api/admin/provision-drive-folder.js:59,149`, `api/admin/backfill-enrichment-encryption.js:155`, `api/pricing.js:75,95`, `api/checkout/create-session.js:26,34`, `api/newsletter-refine-story.js:62`. Violates the SESSION_INSTRUCTIONS invariant #3 "no `err.message` in response bodies" and the L29 resolution from the 2026-04 audit. Leaks schema detail, Stripe/Resend upstream messages, PostgREST error text. Exploit: admin JWT holders and (for pricing.js + checkout/create-session.js, which are unauthenticated) any anon caller can fingerprint backend structure. `page-token/request.js` is especially bad because the endpoint is anonymous and per-IP rate-limited to 5/10s, so repeated probing is cheap. **Fix direction**: route every `catch` block through `monitor.logError('route-name', err, { detail: {...} })` and respond with a generic domain string (`'Operation failed'`, `'Email send failed'`, `'Database write failed'`).

- **[H2] `api/chat.js` — admin Claude passthrough has no rate limit** — `api/chat.js:1-25`. Every other Claude-proxying handler (`agreement-chat`, `report-chat`, `content-chat`, `proposal-chat`, `campaign-summary-chat`) enforces `rateLimit.check('ip:' + ip + ':<route>', 20, 60)`. `admin/chat.js` gates on `auth.requireAdmin(req, res)` only. A compromised or shared admin session (or a buggy admin-UI retry loop) can burn Anthropic credits unbounded, and the system prompt is ~4KB so each request is expensive. Exploit: operator-error or stolen JWT → $1000s in tokens in an hour. **Fix direction**: add `rateLimit.check('admin:' + user.id + ':chat', 60, 60)` (higher ceiling than client-facing chats since admin work is more bursty, but still bounded).

- **[H3] PostgREST ID interpolation without `encodeURIComponent` — 12 admin/internal routes** — `api/trigger-agent.js:41,45,82`, `api/trigger-content-audit.js:39,92`, `api/trigger-cms-scout.js:35`, `api/trigger-sitemap-scout.js:35`, `api/site-map-from-scout.js:59`, `api/ingest-surge-content.js:42,68`, `api/ingest-batch-audit.js:30,106`, `api/ingest-design-assets.js:54`, `api/process-batch-synthesis.js:40,186`, `api/generate-neo-image.js:44`, `api/send-newsletter.js:305`, `api/trigger-batch-audit.js:40,51,72` (uses `body.client_slug` and `body.keyword_ids.join(',')`). Routes are admin- or internal-gated so blast radius is limited; PostgREST parses the filter so the SESSION_INSTRUCTIONS canonical pattern ("wrap slug/id in `encodeURIComponent()` at every concat site") is defense-in-depth. The `trigger-batch-audit.js:56` `body.keyword_ids.join(',')` is the most concerning — no type check that the array elements are UUIDs, so an admin with a compromised session could splice arbitrary PostgREST filter clauses via a crafted array element. **Fix direction**: wrap every body-derived ID in `encodeURIComponent()` and validate array elements against a UUID regex before `.join(',')`; ideally migrate these sites to `pgFilter.buildFilter(...)`.

- **[H4] `api/trigger-content-audit.js`, `trigger-cms-scout.js`, `trigger-sitemap-scout.js`, `trigger-design-capture.js`, `process-batch-synthesis.js` — body-supplied ID with no ownership check before mutation** — admin JWT is required, but the handler fetches `content_pages?id=eq.<body.content_page_id>` and mutates/triggers external work without confirming the admin has any business touching this row. This is a multi-tenant story only if you add non-Chris admin users; today Scott and all admins are equally privileged. **Fix direction**: acceptable under the current trust model; revisit when adding role-scoped admins. Document the assumption in `action-schema.js` header (it already treats all admins as equal, but the action routes do not).

- **[H5] `lf-proxy.js` — untrusted body fields forwarded to LocalFalcon, admin-gated but no allowlist** — `api/lf-proxy.js:35-46,80-92`. The `action='search'` branch forwards `body.name`, `body.city`, `body.state` as URL-encoded form fields to `api.localfalcon.com`. `action='add'` forwards `body.place_id` as a Google Place ID with no regex check. `action='saved'` forwards `body.query`. An admin can paste any string, but combined with H3 this is admin-side output-smuggling surface. Low risk today because the outbound target is fixed; real risk is accidentally using `body.*` to construct the outbound URL in a future refactor. **Fix direction**: add validation: `place_id` must match `/^[A-Za-z0-9_-]{20,100}$/`, `name`/`city`/`state` length-limited via `sanitizer.sanitizeText`.

---

### MEDIUM

- **[M1] `api/generate-neo-image.js` — no length cap on `body.prompt`, fed directly to Gemini** — `api/generate-neo-image.js:41,55`. The admin-supplied prompt (or the auto-built one) is POSTed to Gemini without `sanitizer.sanitizeText` or a length cap. Not a prompt-injection vector in the classic sense because admin is the author, but a runaway build from a bad content_page_name could hit Gemini billing. **Fix direction**: cap at 2000 chars via `sanitizer.sanitizeText(prompt, 2000)`.

- **[M2] `api/newsletter-research.js:241` — `x-api-key` header construction reads like a secret concat** — flagged by grep, but inspection shows it's the Anthropic API key in the correct outbound header. No issue. **Fix direction**: N/A, false positive from grep pattern.

- **[M3] `api/trigger-agent.js` — outbound `AGENT_URL` + Bearer `AGENT_API_KEY` send `audit_id` without checking the audit row belongs to the claimed `contact_id`** — `api/trigger-agent.js:38-70`. Admin can POST `{ audit_id: A, contact_id: B }` where A's real contact_id is C. The handler fetches both rows independently but never asserts `audit.contact_id === body.contact_id`. The VPS agent ends up running a Surge audit with a mismatched (contact, audit) tuple. Data-integrity bug rather than security, but it lands in `entity_audits` and flows to client-facing deliverables. **Fix direction**: add `if (audit.contact_id !== body.contact_id) return res.status(400).json({ error: 'audit/contact mismatch' });` after fetching both rows.

- **[M4] `api/auth/session.js` — verifies JWT signature + exp but does not check `admin_profiles` before minting cookie** — `api/auth/session.js:75-98`. Comment at top says "authorization is still enforced per-route", and that's correct — every admin route re-runs `requireAdmin` which does check `admin_profiles`. But the cookie itself will be issued for any valid Supabase JWT (e.g. a newsletter-subscriber account if one ever existed), even though it can't actually reach admin endpoints. Minor oracle: you can confirm "is this Supabase user active" by whether the cookie is issued. **Fix direction**: add `getAdminProfile(payload.sub)` check before setting cookie; return 403 for valid-but-non-admin JWTs. Low priority.

- **[M5] `api/newsletter-webhook.js` — webhook log writes could leak sensitive headers** — `api/newsletter-webhook.js:42-48`, `logEvent(...)` captures `headers_snapshot` with svix-id, svix-timestamp, svix-signature. Signatures are technically secret-adjacent (anyone with the signature + body can replay). The timestamp + 300s staleness check mitigates replay, but signatures shouldn't be persisted. **Fix direction**: strip `svix-signature` from the headers_snapshot before write. The code comment on line 88 says "Redacted lengths only — never log raw signatures or the secret" referring to the sig-invalid detail branch, but the primary `logEvent` calls at line 59/76/80 pass `hdrs` which includes the full `svix-signature`.

- **[M6] `api/stripe-webhook.js` amount-fallback product detection** — `api/stripe-webhook.js:170+` (continued into file). When `metadataProduct` is empty, falls through to `amountTotal === 200000 || 207000` → entity-audit detection. If a new tier is priced at $2,000 without metadata, it routes to entity-audit flow. Known risk, documented as belt-and-suspenders by process lesson #6. **Fix direction**: keep as-is (aligned with process lesson 6); the amount fallback is safer than silently dropping unlabeled payments. Document in route header comment that every new paymet link MUST carry `metadata.product`.

- **[M7] `admin/provision-drive-folder.js:59,149` and `admin/backfill-enrichment-encryption.js:155`** — leak `err.message` in response bodies. Included in H1 but called out because these routes touch GCP service-account errors (could leak internal project IDs, client_email addresses, or private-key-parse error strings). **Fix direction**: fold into H1 remediation sweep; this is why the invariant exists.

- **[M8] `api/pricing.js` and `api/checkout/create-session.js` — no auth AND leaks `err.message`** — `api/pricing.js:75,95` + `api/checkout/create-session.js:26,34`. These are intentionally anonymous (public pricing + checkout). Combined with H1 this lets anon callers fingerprint Supabase error shapes. Also neither has a rate limit: pricing.js is edge-cached 60s (low cost) but `create-session.js` calls out to Stripe on every request and has no cap. Spam scenario: 1000 req/min creating Checkout Sessions for a real slug floods Stripe's dashboard with junk payment intents. **Fix direction**: (a) strip err.message from the two responses (H1 sweep); (b) add `rateLimit.check('ip:' + ip + ':checkout-create', 20, 60, { failClosed: false })` on create-session.

- **[M9] `api/submit-entity-audit.js:79` — email uniqueness pre-check is an email-enumeration oracle** — The 409 response with `'We already have a record with this email address'` confirms whether a given email exists. Origin check + 3/hour rate limit caps the damage, but it's still a spray-and-confirm vector. **Fix direction**: return a generic success message regardless of duplicate state and surface the duplicate only in the server log. Product tradeoff — might hurt legitimate users who don't know they're already registered. Mark as ACCEPTED if UX wins.

- **[M10] `api/stripe-webhook.js:150` — slug fallback to metadata when contact_id UUID lookup fails** — When metadata.contact_id is missing (legacy buy.stripe.com links), falls back to `contacts?slug=eq.<metadata.slug>`. `metadata.slug` goes into the filter without `encodeURIComponent` wrapping (line ~153 visible via grep earlier). Low exploitability (attacker would need to control Stripe metadata, which requires Stripe dashboard access), but violates the invariant. **Fix direction**: wrap `slug` in `encodeURIComponent` like every other slug site in the codebase.

- **[M11] `chat.js` system prompt leaks SQL schema structure** — The ~4KB system prompt includes full table names and column hints ("contacts.slug", "practice_details.npi_number") for the chat assistant. An admin with a compromised session exfiltrating one chat response can recover the schema. Less of a new attack surface (admin can also just read the schema in Supabase UI) but worth noting. **Fix direction**: acceptable under current trust model; document that admin role == full schema visibility.

---

### LOW

- **[L1] `api/run-migration.js` — requireCronSecret gates correctly, but arbitrary SQL via repo-write** — documented in-code (lines 27-32). The risk is "anyone who can push to main AND knows CRON_SECRET can run arbitrary SQL". Acceptable under the documented trust model. **Fix direction**: N/A; architectural.

- **[L2] `api/newsletter-webhook.js` returns 500 when RESEND_WEBHOOK_SECRET isn't configured** — Svix will retry on 500. Fine for a config-error signal, but 401 would be closer to the actual semantic (the caller provided a signature we can't verify). **Fix direction**: return 503 with Retry-After header, or treat as 401. Low priority.

- **[L3] `api/health.js` — no method check** — Flagged by grep as missing `req.method` guard. Health endpoints accepting any method is conventional but inconsistent with the rest of the codebase. **Fix direction**: add `if (req.method !== 'GET') return res.status(405).json(...)`. Trivial.

- **[L4] `api/strategy-call/create-lead.js` — no honeypot/captcha** — Origin check + 5/hour IP rate limit. Valid website_url + valid email + valid first/last name is the whole bar. A motivated spammer with rotating IPs can pollute the lead table at 5 leads/IP/hour. **Fix direction**: consider adding a hidden honeypot field to the form + server-side check that it's empty; or Cloudflare Turnstile. Product decision.

- **[L5] `api/submit-entity-audit.js` and `submit-entity-audit-premium.js` — same as L4, no honeypot** — Same tradeoff. 3/hour/IP rate limit is tighter, which helps.

- **[L6] `api/csp-report.js` — unauthenticated, no rate limit, unbounded growth** — Fail-open 204 by design. Any attacker can POST garbage CSP reports to fill stdout/Vercel logs. **Fix direction**: add an IP rate limit (e.g. 60/min) and a size cap on the JSON body.

- **[L7] `api/action.js` + action-schema — all listed tables are default `read:true,write:true,delete:true`** — Only `signed_agreements`, `payments` are truly restricted (`write:false, delete:false`). Every other table is wide open to any admin. The comment says "permissive mode — Session 6 tightens the few tables that store money or signed legal artifacts" so this is intentional. Flagged because `workspace_credentials` is still admin-writable, and the field-level encryption at rest is the only backstop against an admin with stolen JWT dumping Gmail passwords. **Fix direction**: tighten `workspace_credentials` to `require_role: 'owner'` when non-trusted admin roles appear; add more granular write allowlists (like `CONTACT_WRITE_ALLOWLIST` in onboarding-action) for `contacts` and `report_configs`.

- **[L8] `api/track-proposal-view.js` — slug is the only argument, 404-oracle for slug existence** — Rate limited per slug, but a caller can enumerate valid slugs by observing HTTP status. Same tradeoff as M9.

- **[L9] `page-token/request.js:52` — rate limit is fail-OPEN** — `{ failClosed: false }` on an endpoint that mints auth tokens. If Supabase goes down during a DDoS, the rate limiter stops but the endpoint keeps minting cookies. Comment says "never fail-closed on rate-limiter errors". Defensible — a rate-limit outage shouldn't break page loads — but during abuse it leaves the door open. **Fix direction**: keep fail-open but monitor via `monitor.logError` when the rate-limit store is down (currently silent catch).

- **[L10] `api/action.js:81,87` — uses raw `fetch(baseUrl, ...)` directly instead of `sb.mutate()`** — Violates invariant #1/project rule "Always use `api/_lib/supabase.js` (sb.query, sb.mutate, sb.one)". Works because `headers` is built from the same env, but bypasses `buildErrorMessage` and the PATCH-returns-0-rows warning. **Fix direction**: migrate to `sb.mutate` at next touch; the audit closed several similar sites already.

- **[L11] `admin/attribution-sync.js:35` — direct string comparison of `Authorization` header with `'Bearer ' + CRON_SECRET`** — Not constant-time. `requireAdminOrInternal` uses `timingSafeEqual` everywhere else. **Fix direction**: replace with `auth.requireAdminOrInternal(req, res)` or at minimum use `nodeCrypto.timingSafeEqual`.

- **[L12] `api/notify-team.js:22-23` — returns 500 with generic configured message on missing env** — Fine. Just noting that the path handles missing env gracefully.

- **[L13] `api/onboarding-action.js` — `contacts` write allowlist doesn't include `lost`, so clients can't accidentally mark themselves lost; good** — Not an issue, positive observation.

- **[L14] `api/page-token.js` — SCOPES list has 7 scopes, `DEFAULT_TTL` covers all of them — but `campaign_summary` TTL is 365 days** — A year-long cookie that can PATCH data (proposal-chat, campaign-summary-chat) is generous. Justified by the commentary ("pages are meant to outlive the active sales / onboarding window") but worth periodic review as the scope of what these tokens can do grows. **Fix direction**: no change today; revisit if a campaign_summary-scoped token ever gains write access beyond chat.

- **[L15] `api/newsletter-webhook.js:96` — `webhookSecret.replace(/^whsec_/, '')` is called INSIDE a `try` that catches base64 decode errors** — If the env var is `whsec_INVALID`, the `Buffer.from(...)` still succeeds (base64 is very forgiving). A malformed secret will produce a valid-but-useless HMAC, and every real webhook will 401 with `sig_invalid`. The failure mode is loud (every event 401s), so it's self-correcting, but worth a startup check. **Fix direction**: validate the decoded secret has length >= 16 bytes at module load.

---

### NIT

- **[N1] `api/auth.js:339` — `Unauthorized` vs the canonical `Authentication required`** — Inconsistent error string between `requireCronSecret` (`'Unauthorized'`) and `requireAdminOrInternal` (`'Authentication required'`). Harmless.

- **[N2] `api/checkout/create-session.js` derives `origin` from `x-forwarded-proto` + `x-forwarded-host` headers** — Relies on Vercel setting these correctly. If headers are spoofable via a misconfigured reverse proxy, the `successUrl` / `cancelUrl` would point to an attacker-controlled host and Stripe would redirect users there. Vercel does set these correctly, so not exploitable today. **Fix direction**: hardcode `https://clients.moonraker.ai` as the allowed origin; the fallback chain is defense-in-depth but adds headers as a trust surface.

- **[N3] `api/digest.js` — `requireAdminOrInternal` accepts `AGENT_API_KEY` but comment at line 42 says "a compromised admin JWT or CRON_SECRET could..."** — Comment is slightly outdated; agent key is the third path. Doc-only.

- **[N4] `api/page-token.js` — `readCookie` doesn't URL-decode** — Correct by comment; b64url-safe tokens don't need it. Noting for future reviewers that this is deliberate.

- **[N5] `api/_lib/action-schema.js` — `workspace_credentials` comment says "tighten to require_role: 'owner' later"** — Tracked as an intentional TODO aligned with L7.

- **[N6] Unused `gmail-delegated-search.js:29-65` — inline `getDelegatedAccessToken`** — The SESSION_INSTRUCTIONS scope fence notes `google-delegated.js` is the canonical helper and this is a "bespoke signature" duplicate. Don't touch unless explicitly asked (matches the documented scope fence).

- **[N7] `api/action.js:81,113` — `fetch(baseUrl, ...)` uses raw headers, not sb.mutate — already cited as L10.**

- **[N8] `api/approve-followups.js:70` — leaks err.message (part of H1).**

- **[N9] `api/_lib/rate-limit.js:73-78` — `store_unavailable` error never bubbles up to the caller in most routes** — `check()` returns `{ allowed: false, error: 'store_unavailable' }` when fail-closed, but callers don't distinguish "rate limited" from "store down". User sees 429 either way. Fine for user-facing, noisy for observability.

- **[N10] `api/strategy-call/create-lead.js` — origin check accepts only `clients.moonraker.ai`** — But the strategy-call landing is served from `moonraker.ai` marketing site. Either the origin check allows the marketing site domain (verify) or the form is actually hosted in `clients.moonraker.ai`. Worth a deployment check.

---

## Cross-cutting observations

1. The page-token cookie design (`_lib/page-token.js` + `page-token/request.js`) is sound. Stateless HMAC, scoped, per-contact, server-side slug-binding enforced at every write endpoint. The 2026-04-20 Path=/slug → Path=/ migration is documented in-code with the RFC 6265 §5.3/§5.4 reasoning.

2. Stripe + Svix signature verification is correct. Both use raw body buffers, `bodyParser: false` opt-out, timestamp staleness check (Svix: 300s), and `crypto.timingSafeEqual` with length-guard.

3. The `sb.js` error contract (invariant #1) is fully respected in the helper itself, but NOT in all callers — several routes catch and re-expose `err.message` (H1).

4. The `CONTACT_WRITE_ALLOWLIST` pattern in `onboarding-action.js` is a great model for how to restrict page-token writes. Similar allowlists should live in other client-facing write endpoints (they already do for `submit-endorsement`, `progress-update`, `sign-guarantee`).

5. No hardcoded secrets found. All sensitive values flow from `process.env`. Module-load warnings for missing critical secrets (`PAGE_TOKEN_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `CF_R2_DEPLOY_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`) are consistently present.

6. No SSRF vectors found. `lf-proxy.js`, `trigger-agent.js`, webhook handlers, and Stripe/Resend callouts all target fixed hostnames. `newsletter-research.js` calls `serpapi.com` with a fixed URL + controlled query params.

7. No eval/Function/exec/child_process usage in `api/`.

8. No CORS wildcards. Every `Access-Control-Allow-Origin` is the explicit `https://clients.moonraker.ai` literal.

9. `action.js` table policy layer is in "permissive mode" by design; all admin-gated tables are fully mutable by any admin. The only non-permissive entries are `signed_agreements` and `payments`. Documented as Session 6 work.

10. Rate limiting is applied consistently on client-facing chat/write endpoints. Gaps: `admin/chat.js` (H2), `checkout/create-session.js` (M8), `csp-report.js` (L6).

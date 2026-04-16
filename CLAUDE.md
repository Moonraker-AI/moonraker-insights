# Moonraker Client HQ

Internal admin platform + client portal for Moonraker AI, a digital marketing agency serving therapy practices. Supabase backend, serverless API on Vercel, static HTML frontend (no build step, no framework).

## Tech Stack

- **Frontend:** Static HTML, vanilla JS, CSS custom properties (dark/light theme)
- **Backend:** Vercel serverless functions (Node.js), Supabase (Postgres + Auth)
- **Fonts:** Outfit (headings) + Inter (body)
- **Brand primary:** `#00D47E`
- **Deploy:** Git push to `main` → Vercel auto-deploy. No build step.

## Key Commands

```bash
# Validate JS before committing (extract script blocks from HTML files)
node --check path/to/file.js

# Check Vercel deployment status after push
vercel deployments --token $VERCEL_TOKEN

# Run API route locally (not typical — we push and test on Vercel)
# There is no local dev server. Test by pushing to main.
```

## Project Structure

```
admin/                  # Admin dashboard pages (HTML)
  clients/              # Client list + 7-tab deep-dive
  onboarding/           # Onboarding pipeline
  deliverables/         # Deliverables pipeline
  audits/               # Audit pipeline
  reports/              # Reports overview
  proposals/            # Proposal pipeline
  newsletter/           # Newsletter composer + subscribers
  design/               # Design system reference
_templates/             # Client-facing page templates (proposal, report, etc.)
shared/                 # Shared JS modules (chat panel, chatbots)
api/                    # Vercel serverless functions
  _lib/                 # Shared helpers (auth, supabase, github, email)
assets/                 # Images, badges, logos
vercel.json             # Routing, crons, function config
```

## Architecture Rules

- **Left nav summary pages** are read-only pipelines. All mutations happen in client deep-dive tabs.
- **Client-facing pages** are data-driven from URL slug (e.g., `/anna-skomorovskaia/report`).
- **Status-aware tabs:** leads/prospects see 3 tabs; onboarding sees 8; active sees 6 + History.
- All functions called from inline `onclick` must be assigned to `window`.
- Event propagation: dropdowns/links/delete buttons use `onclick="event.stopPropagation()"` inside clickable rows.
- Theme: `localStorage.getItem('moonraker-theme')` read before first paint via `document.startViewTransition()`.

## API Patterns

- **Shared helpers:** Always use `api/_lib/supabase.js` (sb.query, sb.mutate, sb.one) and `api/_lib/github.js` for new routes.
- **Auth:** `api/_lib/auth.js` provides `requireAdminOrInternal(req, res)` — dual auth via JWT (admin) or Bearer token (cron/agent).
- **Frontend reads:** `sb()` helper. **Frontend writes:** `apiAction()` — which maintains a table allowlist. New tables must be added to `action.js` or writes silently fail.
- **Email:** `api/_lib/email-template.js` shared template. Send via Resend.
- **Newsletter content:** `newsletters.content` is JSONB. Pass plain JS objects to PostgREST, never `JSON.stringify()` (causes double-encoding).

## Supabase

- Use MCP `apply_migration` for DDL, `execute_sql` for DML/verification.
- CHECK constraints return empty arrays (not errors) when violated — always verify with a follow-up query.
- `auto_promote_to_active` trigger requires a `pending → complete` row-level transition; bulk-seeded-as-complete rows never fire it.
- RLS pattern: `FOR SELECT TO anon USING (true)` per table; all writes via service role through API routes.
- `lost` boolean on `contacts` must be checked alongside `status` — a client can be `status='active'` and `lost=true`.
- Keywords: never delete, only retire (`retired_at`, `retired_reason`). See `docs/keyword-change-protocol.md`.

## Vercel Deployment

- **CRITICAL:** `vercel.json` `functions` has a hard limit of 50 entries. Only add routes needing non-default settings (Pro default: 60s, 1024MB). Exceeding 50 breaks ALL deploys.
- Glob patterns like `api/*.js` cause "unmatched function pattern" errors. Use explicit file paths only.
- `supportsResponseStreaming` key is invalid and breaks builds.
- New env vars require a redeploy to take effect.
- Always check deployment status after pushing. Silent ERROR state means nothing deployed.

## Git Workflow

- Push to `main` triggers Vercel auto-deploy. No PR process.
- After pushing, verify the Vercel deployment succeeded before moving on.
- If deployment fails, check `vercel.json` first (most common cause).

## Content & Copy Rules

- Never use emdashes. Use commas, periods, colons, or restructure.
- Keep copy warm, approachable, and non-technical. Audience is therapists.
- Booking CTAs link to `https://msg.moonraker.ai/widget/bookings/moonraker-free-strategy-call` (never embed GHL widget).

## Team

- **Chris Morin** — Founder, primary developer
- **Scott Pope** — Director of Growth (CC'd on proposal emails)
- **Karen Francisco** — Client Success (`support@moonraker.ai`)
- **Ivhan + Kael** — SEO Technicians (batch deliverable work)

## Related Systems (not in this repo)

- **Moonraker Website** (`moonraker.ai`): Public marketing site, separate repo `Moonraker-AI/moonraker-website`.
- **Moonraker Agent** (`agent.moonraker.ai`): VPS automation (Surge audits, content audits). Separate repo `Moonraker-AI/moonraker-agent`. Auth via Bearer token.
- **Design reference:** Fetch live tokens from `https://clients.moonraker.ai/admin/design`.

## Environment Variables

These must be set in your shell (not in .env files):
`VERCEL_TOKEN`, `RESEND_API_KEY`, `RESEND_API_KEY_NEWSLETTER`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `AGENT_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`

## Common Pitfalls

1. `action.js` table allowlist: new tables need explicit entries or frontend writes silently fail.
2. Newsletter JSONB: `JSON.stringify()` on content field causes double-encoding.
3. CHECK constraints: Supabase returns `[]` not an error when blocked — always verify.
4. Vercel functions limit: 50 entries max in `vercel.json`. Count before adding.
5. Theme toggle: use `document.startViewTransition()` with 0.25s — never the legacy opacity fade.

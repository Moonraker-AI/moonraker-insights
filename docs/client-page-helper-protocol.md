# Client Page Helper Protocol

**Last updated:** April 22, 2026

## What this covers

Every client-facing HTML page in this repo (`_templates/*.html`, `agreement/index.html`, `entity-audit/index.html`) is static HTML with one or more inline `<script>` blocks running an IIFE. Those IIFEs sometimes call into helpers loaded from `/shared/*.js`. When a helper is loaded with `defer`, there is a real load-order trap that has shipped a crash to production twice (2026-04-22 onboarding, fixed in commits `592c9649` and `7ac83d1e`).

This doc is the canonical rule for how to use those helpers so the trap stays closed. The rules are machine-enforced by `scripts/lint-client-page-helpers.js`, which runs on every PR.

## The helpers

| Helper | Global(s) | How it loads | Notes |
|---|---|---|---|
| `/shared/page-token.js` | `window.mrPageToken` | `defer` (required) | Mints the HttpOnly page-token cookie for write endpoints. Scope-aware. |
| `/shared/csa-content.js` | `window.renderCSA`, `window.loadCSAPricing` | sync (no `defer`) | Renders the CSA into the signing block. |
| `/shared/guarantee-content.js` | `window.buildGuaranteeHtml` | sync (no `defer`) | Renders the Performance Guarantee document. |
| `/shared/offline-banner.js` | — (side effects) | `defer` | Shows a banner when navigator.onLine flips. |
| `/shared/*-chatbot.js` | varies | sync | Per-page chat widgets. |

## The trap

Inline `<script>` blocks execute as soon as the parser reaches them. A `<script src="..." defer>` executes **after** the HTML is fully parsed, right before `DOMContentLoaded`. That means an inline script earlier in the page runs before a deferred external script has loaded — even if the external `<script>` tag is physically above the inline script in the source.

```html
<script src="/shared/page-token.js" defer></script>
<script>
  (function() {
    // At this moment, window.mrPageToken is UNDEFINED on a cold load.
    // The defer'd script hasn't executed yet.
    window.mrPageToken.fetch('/api/x');  // TypeError: Cannot read 'fetch' of undefined
  })();
</script>
```

Desktop often masks the bug through timing luck (browser cache warm, CPU fast, CDN fast). Mobile incognito is deterministic — inline scripts consistently execute before deferred externals, and the bug reproduces on every load.

## The canonical pattern

When you need the page-token cookie minted before a write:

```js
(window.mrPageToken && window.mrPageToken.ready ? window.mrPageToken.ready() : Promise.resolve())
  .catch(function() { /* surface as HTTP error below if cookie missing */ })
  .then(function() {
    return fetch('/api/whatever', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  })
  .then(function(r) { ... });
```

What each piece does:

- **The ternary guard** — if `window.mrPageToken` hasn't loaded yet (cold page load on a slow device), fall through to an already-resolved promise instead of crashing. The deferred script will eventually execute, and any *subsequent* writes in the same session will find it.
- **`.catch` on the guard** — if the token mint itself fails (server 500, rate limited, network), don't crash the init chain. The next `fetch` will still go out; it'll just 401 and surface as a clean HTTP error below.
- **Native `fetch` with `credentials: 'same-origin'`** — sends the `mr_pt_<scope>` cookie automatically. Do NOT use `window.mrPageToken.fetch(...)` here; that wrapper re-introduces the exact crash this protocol is guarding against.

## Required on every template that uses page-token

Before the `<script src="/shared/page-token.js" defer>` tag, declare the scope:

```html
<script>window.__MR_PAGE_SCOPE__ = 'onboarding';</script>
<script src="/shared/page-token.js" defer></script>
```

Without the scope declaration the helper's auto-mint becomes a no-op and `.ready()` silently never resolves. Valid scopes live in `api/_lib/page-token.js` under `SCOPES` — see that file for the current list.

## Lint rules

`scripts/lint-client-page-helpers.js` enforces four rules on every PR:

| Rule | Violates | Fix |
|---|---|---|
| R1 | Any active-code `mrPageToken.fetch(` | Use native `fetch` with `credentials: 'same-origin'` instead. |
| R2 | `mrPageToken` used in active code but canonical guard expression not present | Wrap the first access in the guard shown above. |
| R3 | `page-token.js` loaded OR `mrPageToken` used but no `window.__MR_PAGE_SCOPE__` declared | Add `<script>window.__MR_PAGE_SCOPE__ = '<scope>';</script>` above the `<script src=".../page-token.js">` tag. |
| R4 | `page-token.js` loaded without `defer` | Add `defer` to the tag. |

Comments (both `//` and `/* */`) are stripped before matching, so historical notes about deprecated patterns are safe to leave in place.

## Running the lint locally

```bash
node scripts/lint-client-page-helpers.js
```

Zero output + exit 0 = clean. Any violation prints `file:line [rule] message` and exits 1.

No dependencies, no build step. Just Node.

## History

- **2026-04-22** — onboarding page stuck on "Loading…" for Brave mobile incognito users. Root cause: `mrPageToken.fetch()` called in a `.then` after the ready() guard; wrapper needs `mrPageToken` to be defined, which it wasn't on cold load. Fixed by switching to native `fetch` with `credentials: 'same-origin'`. Commits `592c9649` (partial), `7ac83d1e` (complete).
- **2026-04-22** — this protocol and the corresponding lint were added to prevent recurrence.

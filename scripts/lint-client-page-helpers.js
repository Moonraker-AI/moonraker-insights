#!/usr/bin/env node
/*
 * lint-client-page-helpers.js
 *
 * Guards the class of bugs diagnosed 2026-04-22 / 2026-04-23 on client-facing
 * onboarding pages: inline scripts that touch a global exported by
 * /shared/page-token.js before the helper has installed itself OR before the
 * mint POST has completed.
 *
 * Ground truth: docs/client-page-helper-protocol.md
 *
 * History of this file:
 *   - v1 (2026-04-22) — required a ternary ready()-guard in every caller,
 *     and required page-token.js to be loaded with defer.
 *   - v2 (2026-04-23) — page-token.js is now loaded SYNCHRONOUSLY. With that,
 *     window.mrPageToken is guaranteed to exist when any subsequent inline
 *     script runs, and the auto-mint has already kicked off. Callers simply
 *     call window.mrPageToken.ready().then(...). The ternary guard is no
 *     longer the canonical pattern — it was only needed to survive the defer
 *     race, which no longer exists. R4 is inverted: defer is now forbidden
 *     on this script specifically because defer is what caused 401/403s on
 *     every first-visit-to-a-new-client fetch.
 *
 * Scope:
 *   - _templates/*.html  (every client-facing template)
 *   - agreement/*.html, checkout/*.html, entity-audit/*.html (client-facing roots)
 *
 * Rules (each keyed on the shape of a real bug, not vague hygiene):
 *
 *   R1  No active-code `window.mrPageToken.fetch(` or `mrPageToken.fetch(`.
 *       The wrapper does a one-shot 401-retry that can mask genuine auth
 *       regressions. Callers should use native fetch with credentials and
 *       let the page render a real error if the cookie is bad.
 *
 *   R3  If a file loads `/shared/page-token.js` OR uses `mrPageToken` in
 *       active code, it must declare `window.__MR_PAGE_SCOPE__` somewhere
 *       before the helper loads. Without that, the helper's auto-mint no-ops
 *       and ready() silently never resolves.
 *
 *   R4  `/shared/page-token.js` must NOT be loaded with `defer` or `async`.
 *       It needs to install window.mrPageToken synchronously so that any
 *       inline script that follows can await its `.ready()` promise. A
 *       deferred load delays installation until after DOMContentLoaded, by
 *       which time inline init() calls have already fired off API requests
 *       without a valid cookie (401 or 403 depending on prior cookie state).
 *
 *   (R2 retired in v2 — the ternary guard is no longer canonical.)
 *
 * Exit code: 0 = clean, 1 = violations found (prints each with file:line).
 *
 * Runs on plain Node >=14 with zero dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();

function collectTargets() {
  const targets = [];

  const tplDir = path.join(ROOT, '_templates');
  if (fs.existsSync(tplDir)) {
    for (const name of fs.readdirSync(tplDir)) {
      if (name.endsWith('.html')) targets.push(path.join(tplDir, name));
    }
  }

  for (const sub of ['agreement', 'checkout', 'entity-audit']) {
    const p = path.join(ROOT, sub);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) continue;
    for (const name of fs.readdirSync(p)) {
      if (name.endsWith('.html')) targets.push(path.join(p, name));
    }
  }

  return targets;
}

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const a = src[i];
    const b = i + 1 < n ? src[i + 1] : '';
    if (a === '/' && b === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (a === '/' && b === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
      continue;
    }
    out += a;
    i++;
  }
  return out;
}

// R1 — forbidden pattern.
const FORBIDDEN_FETCH_RE = /(?:window\.)?mrPageToken\.fetch\s*\(/;

// Broad sensor — does active code touch mrPageToken at all?
const ANY_MRPT_RE = /(?:window\.)?mrPageToken\b/;

// page-token.js script tag detection.
const PAGE_TOKEN_ANY_TAG_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/shared\/page-token\.js["'][^>]*>/;
const PAGE_TOKEN_DEFER_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/shared\/page-token\.js["'][^>]*\b(?:defer|async)\b[^>]*>/;

// R3 — scope declaration. Helper is inert without it.
const SCOPE_DECL_RE = /window\.__MR_PAGE_SCOPE__\s*=/;

function lintFile(filepath) {
  const violations = [];
  const raw = fs.readFileSync(filepath, 'utf8');
  const stripped = stripComments(raw);
  const rel = path.relative(ROOT, filepath);

  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (FORBIDDEN_FETCH_RE.test(lines[i])) {
      violations.push({
        file: rel,
        line: i + 1,
        rule: 'R1',
        msg: 'mrPageToken.fetch() is forbidden; use native fetch(url, { credentials: "same-origin" }) after window.mrPageToken.ready()',
        snippet: lines[i].trim().slice(0, 140)
      });
    }
  }

  const mentionsMrpt = ANY_MRPT_RE.test(stripped);
  const loadsPageToken = PAGE_TOKEN_ANY_TAG_RE.test(raw);

  if ((loadsPageToken || mentionsMrpt) && !SCOPE_DECL_RE.test(raw)) {
    violations.push({
      file: rel,
      line: 1,
      rule: 'R3',
      msg: 'window.__MR_PAGE_SCOPE__ must be set before page-token.js loads; helper auto-mint is a no-op without it',
      snippet: ''
    });
  }

  if (loadsPageToken && PAGE_TOKEN_DEFER_RE.test(raw)) {
    const rawLines = raw.split('\n');
    let taggedLine = 1;
    for (let i = 0; i < rawLines.length; i++) {
      if (PAGE_TOKEN_DEFER_RE.test(rawLines[i])) { taggedLine = i + 1; break; }
    }
    violations.push({
      file: rel,
      line: taggedLine,
      rule: 'R4',
      msg: 'page-token.js must NOT be loaded with defer or async. Synchronous load is required so window.mrPageToken installs before inline init code runs. See docs/client-page-helper-protocol.md.',
      snippet: ''
    });
  }

  return violations;
}

function main() {
  const targets = collectTargets();
  if (targets.length === 0) {
    console.error('lint-client-page-helpers: no target HTML files found under', ROOT);
    process.exit(2);
  }

  const allViolations = [];
  for (const f of targets) {
    for (const v of lintFile(f)) allViolations.push(v);
  }

  if (allViolations.length === 0) {
    console.log('lint-client-page-helpers: OK (' + targets.length + ' files scanned, 0 violations)');
    process.exit(0);
  }

  console.error('lint-client-page-helpers: ' + allViolations.length + ' violation(s) found:\n');
  for (const v of allViolations) {
    console.error('  ' + v.file + ':' + v.line + '  [' + v.rule + '] ' + v.msg);
    if (v.snippet) console.error('      ' + v.snippet);
  }
  console.error('\nBackground: docs/client-page-helper-protocol.md');
  process.exit(1);
}

main();

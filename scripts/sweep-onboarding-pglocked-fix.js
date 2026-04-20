#!/usr/bin/env node
// scripts/sweep-onboarding-pglocked-fix.js
// -----------------------------------------------------------------------------
// Fixes deployed per-client onboarding pages whose loadGuaranteeData() still
// references the non-existent `pgLocked` element. The template was split into
// `pgLockedUnsigned` + `pgSigned` in an earlier commit but the two bare refs
// at the top of loadGuaranteeData() were missed, causing a TypeError:
//   "Cannot read properties of null (reading 'style')"
// which leaves the page stuck on "Unable to load onboarding data".
//
// Replaces each of the two occurrences of:
//     document.getElementById('pgLocked').style.display = 'none';
// with:
//     document.getElementById('pgLockedUnsigned').style.display = 'none';
//     document.getElementById('pgSigned').style.display = 'none';
//
// Usage:
//   node scripts/sweep-onboarding-pglocked-fix.js --dry-run
//   node scripts/sweep-onboarding-pglocked-fix.js --apply
// -----------------------------------------------------------------------------
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var DRY  = !process.argv.includes('--apply');

var NON_SLUG = new Set([
  'admin', 'api', 'assets', 'shared', 'scripts', 'docs',
  'migrations', 'node_modules', '_templates', 'results', 'public'
]);

// Match the bare `pgLocked` ref (NOT pgLockedUnsigned). We use a negative
// lookahead on the `U` so we never match the valid ID.
// The indent is captured so we can preserve it on the replacement lines.
var SEARCH = /^([ \t]*)document\.getElementById\('pgLocked'\)\.style\.display = 'none';[ \t]*$/gm;

function replaceBlock(match, indent) {
  return indent + "document.getElementById('pgLockedUnsigned').style.display = 'none';\n" +
         indent + "document.getElementById('pgSigned').style.display = 'none';";
}

function listOnboardingPages() {
  var out = [];
  var entries = fs.readdirSync(ROOT, { withFileTypes: true });
  entries.forEach(function(ent) {
    if (!ent.isDirectory()) return;
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) return;
    if (NON_SLUG.has(ent.name)) return;
    var p = path.join(ROOT, ent.name, 'onboarding', 'index.html');
    if (fs.existsSync(p)) out.push(p);
  });
  return out;
}

function run() {
  var files = listOnboardingPages();
  var swept = [];
  var skipped = [];
  var failed = [];

  files.forEach(function(file) {
    var src;
    try { src = fs.readFileSync(file, 'utf8'); }
    catch (e) { failed.push({ file: file, error: e.message }); return; }

    // Count occurrences before replace, excluding pgLockedUnsigned.
    var matches = src.match(SEARCH);
    var hits = matches ? matches.length : 0;

    if (hits === 0) {
      skipped.push({ file: file.replace(ROOT + '/', ''), reason: 'no bare pgLocked ref' });
      return;
    }

    var next = src.replace(SEARCH, replaceBlock);
    if (next === src) {
      skipped.push({ file: file.replace(ROOT + '/', ''), reason: 'replace was a no-op' });
      return;
    }

    if (!DRY) {
      try { fs.writeFileSync(file, next, 'utf8'); }
      catch (e) { failed.push({ file: file, error: e.message }); return; }
    }
    swept.push({ file: file.replace(ROOT + '/', ''), hits: hits });
  });

  console.log(DRY ? '[dry-run] would sweep:' : '[applied] swept:');
  swept.forEach(function(s) { console.log('  - ' + s.file + ' (' + s.hits + ' refs)'); });
  if (skipped.length) {
    console.log('\nSkipped:');
    skipped.forEach(function(s) { console.log('  - ' + s.file + ' (' + s.reason + ')'); });
  }
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach(function(f) { console.log('  - ' + f.file + ' (' + f.error + ')'); });
  }
  console.log('\nTotal onboarding pages inspected: ' + files.length);
  console.log('Swept: ' + swept.length + ' | Skipped: ' + skipped.length + ' | Failed: ' + failed.length);
  if (failed.length) process.exit(1);
}

run();

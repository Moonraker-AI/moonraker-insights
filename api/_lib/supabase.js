// api/_lib/supabase.js
// Shared Supabase PostgREST helpers for all API routes.
// Eliminates duplicated header construction and URL fallback logic.
//
// Usage:
//   var sb = require('./_lib/supabase');
//   var contacts = await sb.query('contacts?slug=eq.anna-skomorovskaia&select=*&limit=1');
//   await sb.mutate('contacts?id=eq.' + id, 'PATCH', { status: 'active' });
//   await sb.mutate('deliverables', 'POST', { contact_id: id, title: 'Setup' }, 'return=representation');
//
// Error contract for thrown Supabase errors (M7, 2026-04-19; expanded 2026-04-21):
//   .status           HTTP status code from PostgREST.
//   .detail           Raw PostgREST response body. Safe for server-side
//                     logging via monitor.logError; NEVER echo to response
//                     bodies (leaks schema info, column names, constraint
//                     names, hint text).
//   .supabaseMessage  The PostgREST `message` field, human-readable but may
//                     still contain column names. Prefer `.detail` for
//                     structured logging; prefer generic strings for
//                     response bodies.
//   .message          Diagnostic string including HTTP status + PostgREST
//                     code/constraint/message (truncated). Format:
//                       'Supabase mutate error (HTTP 400, code=23514, constraint=entity_audits_status_check): new row violates check constraint'
//                     This echoes into 5xx response bodies and into
//                     cron_runs.error via withTracking — both server-side
//                     channels. The Authorization/apikey headers never round-
//                     trip into PostgREST's response body, so detail exposure
//                     is limited to schema/constraint info (same risk surface
//                     .detail already has). Callers that branch on structured
//                     info should use `.detail.code` / `.detail.constraint` /
//                     `.status` — never pattern-match on `.message`.
//                     If the detail leak is a concern for a specific caller's
//                     response body, catch the error and substitute a generic
//                     string before responding.

// Loud warning at module load if NEXT_PUBLIC_SUPABASE_URL is unset, so config
// gaps surface in Vercel logs before any route hits url(). Mirrors the H9/H10
// pattern in api/admin/manage-site.js and api/_lib/crypto.js.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  console.error('[supabase] CRITICAL: NEXT_PUBLIC_SUPABASE_URL is not set. All Supabase calls will throw at url() invocation.');
}

var fetchT = require('./fetch-with-timeout');

var SUPABASE_URL = null;

// Build a diagnostic error message from a PostgREST failure response.
// Format: '<op> error (HTTP <status>[, code=<pg_code>][, constraint=<name>]): <message>'
// Keeps detail compact (<~300 chars) so it survives cron_runs.error's 1000-char
// limit alongside any stack context. Falls back gracefully when body isn't JSON.
function buildErrorMessage(op, resp, data) {
  var parts = ['HTTP ' + resp.status];
  if (data && typeof data === 'object') {
    if (data.code) parts.push('code=' + String(data.code).substring(0, 40));
    if (data.constraint) parts.push('constraint=' + String(data.constraint).substring(0, 80));
  }
  var prefix = 'Supabase ' + op + ' error (' + parts.join(', ') + ')';
  var tail = '';
  if (data && typeof data === 'object' && data.message) {
    tail = String(data.message).substring(0, 240);
  } else if (typeof data === 'string' && data) {
    tail = data.substring(0, 240);
  }
  return tail ? prefix + ': ' + tail : prefix;
}

function url() {
  if (!SUPABASE_URL) {
    SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL not configured');
  }
  return SUPABASE_URL;
}

function key() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function headers(prefer) {
  var k = key();
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  var h = {
    'apikey': k,
    'Authorization': 'Bearer ' + k,
    'Content-Type': 'application/json'
  };
  if (prefer) h['Prefer'] = prefer;
  return h;
}

// GET request to PostgREST. Returns parsed JSON.
// path is everything after /rest/v1/, e.g. 'contacts?slug=eq.foo&select=*&limit=1'
async function query(path, opts) {
  var resp = await fetchT(url() + '/rest/v1/' + path, {
    method: 'GET',
    headers: headers((opts && opts.prefer) || undefined)
  }, (opts && opts.timeoutMs) || 10000);
  // PostgREST errors aren't always JSON (e.g. gateway 502). Parse defensively.
  var data;
  try { data = await resp.json(); }
  catch (e) {
    try { data = await resp.text(); } catch (e2) { data = null; }
  }
  if (!resp.ok) {
    var err = new Error(buildErrorMessage('query', resp, data));
    err.status = resp.status;
    err.detail = data;
    err.supabaseMessage = (data && data.message) || null;
    throw err;
  }
  return data;
}

// POST/PATCH/DELETE to PostgREST. Returns parsed JSON.
// method: 'POST', 'PATCH', or 'DELETE'
// prefer: e.g. 'return=representation' or 'return=minimal'
async function mutate(path, method, body, prefer, timeoutMs) {
  var resp = await fetchT(url() + '/rest/v1/' + path, {
    method: method,
    headers: headers(prefer || 'return=representation'),
    body: body ? JSON.stringify(body) : undefined
  }, timeoutMs || 10000);
  // For DELETE with no content or return=minimal success
  if (resp.status === 204) return null;
  // Parse defensively — PostgREST errors aren't always JSON.
  var data;
  try { data = await resp.json(); }
  catch (e) {
    try { data = await resp.text(); } catch (e2) { data = null; }
  }
  if (!resp.ok) {
    var err = new Error(buildErrorMessage('mutate', resp, data));
    err.status = resp.status;
    err.detail = data;
    err.supabaseMessage = (data && data.message) || null;
    throw err;
  }
  // Warn on PATCH that matched zero rows — likely a CHECK constraint silent failure
  if (method === 'PATCH' && Array.isArray(data) && data.length === 0) {
    console.warn('[sb.mutate] PATCH returned 0 rows (possible CHECK constraint block): ' + path);
  }
  return data;
}

// Convenience: fetch a single row or return null
async function one(path) {
  var rows = await query(path);
  return (Array.isArray(rows) && rows.length > 0) ? rows[0] : null;
}

// Check if SUPABASE_SERVICE_ROLE_KEY is set. Returns true/false.
function isConfigured() {
  return !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

module.exports = { url, key, headers, query, mutate, one, isConfigured };

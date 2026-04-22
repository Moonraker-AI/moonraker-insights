// api/_lib/newsletter-subscribe.js
// Idempotent opt-in writer for the newsletter_subscribers table.
//
// Context: newsletter_subscribers IS the newsletter list. api/send-newsletter.js
// reads directly from it (status=eq.active); no Resend Audiences sync.
// Pre-2026-04-22 the intake forms flipped contacts.marketing_consent=true but
// never wrote a subscriber row, so opt-ins were silently dropped. This helper
// is the canonical subscribe path for both /entity-audit and /strategy-call.
//
// Usage:
//   var newsletter = require('./_lib/newsletter-subscribe');
//   var result = await newsletter.subscribeIfConsenting({
//     email, first_name, last_name,
//     source: 'entity-audit' | 'strategy-call',
//     marketingConsent: true
//   });
//   // result.action: 'skipped_no_consent' | 'skipped_already_active' | 'created'
//
// Design rules:
//  1. Idempotent — safe to call multiple times for the same email.
//  2. Never auto-resurrect rows with status 'unsubscribed', 'bounced', or
//     'complained'. Opt-out is a one-way door; re-entry must be an explicit
//     user action via the subscriber management page. Chris's call on
//     2026-04-22 — conservative default, respects deliverability + CAN-SPAM.
//  3. Never throws. Callers must still wrap in try/catch as a belt-and-braces
//     measure, but subscribe failures must not fail the parent intake flow.
//     Any internal error is captured and returned; caller decides whether
//     to monitor.logError it.
//
// Source values match the newsletter_subscribers.source CHECK constraint:
//   'ghl-import' | 'entity-audit' | 'manual' | 'website' | 'webinar' | 'strategy-call'
// NOTE: these use hyphens (existing schema). Don't pass underscore variants —
// the CHECK will reject and PATCH/POST returns 400.

var sb = require('./supabase');

var ALLOWED_SOURCES = ['ghl-import', 'entity-audit', 'manual', 'website', 'webinar', 'strategy-call'];

async function subscribeIfConsenting(opts) {
  opts = opts || {};
  var email = (opts.email || '').trim().toLowerCase();
  var firstName = (opts.first_name || '').trim() || null;
  var lastName = (opts.last_name || '').trim() || null;
  var source = (opts.source || '').trim();
  var marketingConsent = opts.marketingConsent === true;

  if (!marketingConsent) {
    return { action: 'skipped_no_consent' };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { action: 'skipped_no_consent', reason: 'invalid_email' };
  }
  if (ALLOWED_SOURCES.indexOf(source) === -1) {
    // Fail safe: a caller passing an unknown source value would otherwise
    // 400 the CHECK constraint. Return a skip marker rather than throw —
    // the caller's parent intake must still succeed.
    return { action: 'skipped_no_consent', reason: 'invalid_source' };
  }

  try {
    var existing = await sb.query(
      'newsletter_subscribers?email=eq.' + encodeURIComponent(email) + '&select=id,status&limit=1'
    );
    if (Array.isArray(existing) && existing.length > 0) {
      // Any existing row, regardless of status, is treated as "already
      // handled — do not touch." 'active' and 'pending' are happy paths;
      // 'unsubscribed', 'bounced', and 'complained' are explicit opt-out
      // states that must only be reversed by user action. Returning the
      // same action string for all of them keeps the caller blind to the
      // opt-out state (avoids leaking info via behavior).
      return { action: 'skipped_already_active', subscriber_id: existing[0].id };
    }

    // No existing row — insert a fresh subscriber. The email UNIQUE
    // constraint is the authoritative race backstop: if a concurrent insert
    // beat us to the row, PostgREST returns 409/23505 and we treat that as
    // "already subscribed" rather than an error.
    var rows = await sb.mutate('newsletter_subscribers', 'POST', {
      email: email,
      first_name: firstName,
      last_name: lastName,
      source: source,
      status: 'active',
      engagement_tier: 'warm'
    });
    var row = Array.isArray(rows) ? rows[0] : rows;
    return { action: 'created', subscriber_id: row && row.id };
  } catch (err) {
    // Unique-violation race: a parallel request inserted the same email
    // between our SELECT and our POST. Treat as success.
    var detail = err && err.detail;
    var pgCode = detail && detail.code;
    var msg = (err && err.message) || '';
    if (pgCode === '23505' ||
        msg.indexOf('newsletter_subscribers_email_unique') !== -1 ||
        msg.indexOf('duplicate key') !== -1) {
      return { action: 'skipped_already_active', reason: 'race_unique_violation' };
    }
    // Anything else: return an error marker but do not throw. Caller
    // should log via monitor and move on.
    return {
      action: 'error',
      error: (msg || 'unknown error').substring(0, 200)
    };
  }
}

module.exports = { subscribeIfConsenting };

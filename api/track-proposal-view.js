// /api/track-proposal-view.js
//
// Records a proposal view by calling the track_proposal_view(p_slug) RPC
// server-side with the service role key. Called from the proposal template
// on page load to bump proposals.view_count + transition sent->viewed.
//
// Replaces the legacy client-side call embedded in baked proposal HTML
// which shipped the anon Supabase key inline. The new dynamic template
// calls this endpoint instead, so no secrets (even "public" anon keys)
// need to be embedded in the page HTML.
//
// The RPC itself has a SECURITY DEFINER body with a `status IN ('sent',
// 'viewed')` gate, so calls for proposals in 'ready' state (not yet sent)
// are no-ops. We don't duplicate that logic here.
//
// Rate-limited by slug because view-tracking is genuinely public — we
// don't want an attacker scripting a million requests per minute to
// skew a prospect's view_count.
//
// Request:   POST /api/track-proposal-view  { slug: '<slug>' }
// Response:  202 { ok: true }              fire-and-forget, never blocks
//                                          tracking or leak proposal state

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var rate = require('./_lib/rate-limit');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured()) {
    // Silent-ish: template shouldn't see this as a content error.
    return res.status(500).json({ error: 'config error' });
  }

  var body = req.body || {};
  var slug = String(body.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    // Intentionally vague — don't confirm whether a given slug is valid.
    return res.status(400).json({ error: 'bad request' });
  }

  // Rate limit per-slug: 30 events per 60s is way above any legitimate
  // single-user view pattern but low enough to prevent abuse. Fail-open
  // (failClosed=false) so a rate-store outage doesn't block tracking.
  // If the limit is hit, we silently 202 without calling the RPC — the
  // attacker gets no signal that rate-limiting is the reason.
  var rl;
  try {
    rl = await rate.check('track-proposal-view:' + slug, 30, 60, { failClosed: false });
  } catch (e) {
    monitor.logError('track-proposal-view', e, {
      client_slug: slug, detail: { stage: 'rate_check' }
    });
    rl = { allowed: true };
  }
  if (!rl.allowed) {
    return res.status(202).json({ ok: true });
  }

  // Call the RPC. Non-fatal on failure — the template already treats this
  // as fire-and-forget, so a DB hiccup shouldn't surface to the user.
  try {
    await sb.mutate('rpc/track_proposal_view', 'POST', { p_slug: slug }, 'return=minimal', 5000);
  } catch (e) {
    monitor.logError('track-proposal-view', e, {
      client_slug: slug, detail: { stage: 'rpc_call' }
    });
    // Still return 202 — tracking is best-effort.
  }

  return res.status(202).json({ ok: true });
};

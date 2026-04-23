// /api/submit-entity-audit-premium.js
//
// Public-facing endpoint for the Premium Entity Audit intake form on
// /entity-audit. Creates a lead contact + pending entity_audits row with
// audit_tier='premium' WITHOUT firing the Surge agent. The frontend then
// calls /api/checkout/create-session to open Stripe; the Stripe webhook
// triggers the agent after payment lands so we don't run (and auto-deliver)
// a free scorecard for someone who's about to pay for the premium version.
//
// If the buyer abandons Stripe, we end up with a lead contact + pending
// audit that never runs. That's the same trade-off as /strategy-call —
// volume is low, manual cleanup is easy, and it avoids coupling agent
// work to a payment that may never arrive. Safe by design.
//
// Shared code paths with /api/submit-entity-audit:
//   - origin check, rate limit, dedupe-by-email, slug generation.
// Divergent:
//   - audit_tier defaults to 'premium' on the contact AND audit rows.
//   - No agent trigger (deferred to stripe-webhook).
//   - No newsletter subscribe (the premium flow doesn't show the consent
//     checkbox; can be added later if we choose to collect it).
//
// POST body: {
//   first_name, last_name, practice_name, website_url, email,
//   source, referral_name, city, state, gbp_link
// }
//
// Response: { success: true, slug, contact_id, audit_id }

var sb = require('./_lib/supabase');
var rateLimit = require('./_lib/rate-limit');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var origin = req.headers.origin || '';
  if (!origin || origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Service not configured' });

  // Rate limit: same shape as /api/submit-entity-audit (3 per IP per hour).
  // Shared key name so the two endpoints can't be used to double the
  // effective spam ceiling.
  var ip = rateLimit.getIp(req);
  var rl = await rateLimit.check('ip:' + ip + ':submit-entity-audit', 3, 3600);
  rateLimit.setHeaders(res, rl, 3);
  if (!rl.allowed) {
    if (rl.reset_at) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000))));
    }
    return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  }

  var body = req.body || {};
  var firstName    = (body.first_name    || '').trim();
  var lastName     = (body.last_name     || '').trim();
  var practiceName = (body.practice_name || '').trim();
  var websiteUrl   = (body.website_url   || '').trim();
  var email        = (body.email         || '').trim().toLowerCase();
  var source       = (body.source        || 'entity_audit_premium').trim();
  var referralName = (body.referral_name || '').trim();
  var city         = (body.city          || '').trim();
  var state        = (body.state         || '').trim();
  var gbpLink      = (body.gbp_link      || '').trim();

  if (!firstName || !lastName || !websiteUrl || !email) {
    return res.status(400).json({ error: 'First name, last name, website URL, and email are required.' });
  }
  if (!/^https?:\/\/.+\..+/.test(websiteUrl)) {
    return res.status(400).json({ error: 'Please provide a valid website URL starting with http:// or https://' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  var slug = (firstName + ' ' + lastName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);

  try {
    // Dedupe on email (contacts has no email UNIQUE; pre-check stays —
    // see submit-entity-audit for the full rationale).
    var byEmail = await sb.query('contacts?email=eq.' + encodeURIComponent(email) + '&select=id,slug,status,audit_tier&limit=1');
    if (byEmail && byEmail.length > 0) {
      var existing = byEmail[0];
      // If the existing contact is already a premium lead with a pending
      // audit, let them re-enter the flow without creating a duplicate —
      // re-return the existing slug so the frontend can push them
      // straight to Stripe. This handles "I typed my card wrong, let me
      // try again" without asking the user to contact support.
      if (existing.status === 'lead' && existing.audit_tier === 'premium') {
        var existingAudit = await sb.one(
          'entity_audits?contact_id=eq.' + existing.id +
          '&order=created_at.desc&limit=1&select=id,status'
        );
        if (existingAudit && existingAudit.status === 'pending') {
          return res.status(200).json({
            success: true,
            slug: existing.slug,
            contact_id: existing.id,
            audit_id: existingAudit.id,
            resumed: true
          });
        }
      }
      return res.status(409).json({
        error: 'duplicate',
        message: 'We already have a record with this email address. If you have not received your scorecard yet, please contact support@moonraker.ai.'
      });
    }

    // Create the contact row as a premium-lead. Note audit_tier='premium'
    // on the CONTACT is the signal that payment is (or was) intended; the
    // actual tier of the entity_audits row is also 'premium' from creation
    // so cron/process-audit-queue.js retries land in the same branch.
    var contactRows = await sb.mutate('contacts', 'POST', {
      first_name: firstName,
      last_name: lastName,
      practice_name: practiceName || null,
      website_url: websiteUrl,
      email: email,
      slug: slug,
      status: 'lead',
      source: source,
      referral_code: referralName || null,
      audit_tier: 'premium',
      city: city || null,
      state_province: state || null,
      // marketing_consent left null — not collected on this intake.
    });
    var contact = contactRows[0];

    // Build derived fields the same way entity-audit-trigger does, so the
    // row looks identical to one that flowed through the free path.
    var brandQuery = practiceName || ((firstName + ' ' + lastName).trim());
    var geoTarget  = (city && state) ? (city + ', ' + state) : (city || state || '');

    // Create entity_audits row in status='pending'. NO agent trigger.
    // stripe-webhook's entity_audit_premium branch will fire the agent
    // after checkout.session.completed.
    var auditRows = await sb.mutate('entity_audits', 'POST', {
      contact_id: contact.id,
      client_slug: slug,
      audit_tier: 'premium',
      brand_query: brandQuery,
      homepage_url: websiteUrl,
      status: 'pending',
      geo_target: geoTarget || null,
      gbp_share_link: gbpLink || null
    });
    var audit = Array.isArray(auditRows) ? auditRows[0] : auditRows;

    return res.status(200).json({
      success: true,
      slug: slug,
      contact_id: contact.id,
      audit_id: audit && audit.id
    });

  } catch (err) {
    var detail = err && err.detail;
    var pgCode = detail && detail.code;
    var msg = (err && err.message) || '';
    var isUnique = (pgCode === '23505') ||
                   msg.indexOf('contacts_slug_key') !== -1 ||
                   msg.indexOf('duplicate key') !== -1 ||
                   msg.indexOf('duplicate') !== -1 ||
                   msg.indexOf('unique') !== -1;
    if (isUnique) {
      return res.status(409).json({
        error: 'duplicate',
        message: 'It looks like we already have your information on file. If you have not received your scorecard yet, please contact support@moonraker.ai.'
      });
    }
    try {
      await monitor.logError('submit-entity-audit-premium', err, {
        detail: { stage: 'handler' }
      });
    } catch (_) { /* never mask the response */ }
    return res.status(500).json({ error: msg || 'Something went wrong. Please try again.' });
  }
};

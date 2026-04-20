// /api/lock-guarantee.js
// Admin action: lock in a Performance Guarantee after the intro-call numbers
// are finalized. Flips performance_guarantees.status from 'draft' to 'locked'.
//
// Scope boundary:
//   This endpoint performs the status flip AND sends the "ready to sign"
//   email to the client on the first-time lock (not on already-locked
//   retries — Scott can click Lock In a second time to re-confirm without
//   spamming the client). Clients sign inline at Step 9 of their onboarding
//   (same pattern as the CSA in Step 2). Signing happens through
//   /api/sign-guarantee and writes to signed_performance_guarantees.
//
// Security:
//   - Admin JWT only (auth.requireAdmin — no internal/agent access).
//   - Verified slug lookup; status flip bound to the contact matched by that
//     slug, not by any ID in the body.
//
// Idempotency:
//   - Already-locked guarantees return 200 with { already_locked: true }. No
//     second state change, no follow-on side effects.
//
// Guardrails:
//   - Contact must be annual tier (plan_tier='annual' or legacy
//     plan_type='annual'). 400 on anything else.
//   - Draft must have all benchmark fields populated. 400 with a list of
//     missing fields otherwise.
//   - lost=true contacts are rejected.

var auth    = require('./_lib/auth');
var sb      = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var email   = require('./_lib/email-template');

var BASE_URL = 'https://clients.moonraker.ai';

// Send the "ready to sign" email to the client. Non-fatal: email failures do
// not fail the lock-in, which is an idempotent DB state change.
async function sendReadyToSignEmail(contact) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { sent: false, error: 'RESEND_API_KEY not configured' };
  if (!contact || !contact.email) return { sent: false, error: 'contact has no email' };

  var firstName    = contact.first_name || 'there';
  var practiceName = contact.practice_name ||
    ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim() ||
    'your practice';
  var onboardingUrl = BASE_URL + '/' + encodeURIComponent(contact.slug) + '/onboarding';

  var html = email.wrap({
    headerLabel: 'Your Performance Guarantee is Ready',
    content:
      email.greeting(firstName) +
      email.pRaw('Your Performance Guarantee for ' + email.esc(practiceName) + ' is ready to sign.') +
      email.pRaw('We reviewed your practice metrics together on the intro call and locked in the numbers. The final step is your signature, which activates the 12-month guarantee window.') +
      email.cta(onboardingUrl + '#step-9', 'Review & Sign Your Guarantee') +
      email.pRaw('When you open the link, head to <strong>Step 9</strong> of your onboarding. You will see the full document and a signature block, just like you did for the Client Service Agreement.') +
      email.pRaw('If you have any questions, you can reply to this email and it will go directly to the Moonraker team.')
  });

  try {
    var resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: email.FROM.notifications,
        to: [contact.email],
        cc: ['scott@moonraker.ai', 'support@moonraker.ai'],
        reply_to: 'support@moonraker.ai',
        subject: 'Your Performance Guarantee is ready to sign',
        html: html
      })
    });
    var data = await resp.json();
    if (data && data.id) return { sent: true, id: data.id };
    return { sent: false, error: (data && data.error) || 'resend-error' };
  } catch (e) {
    return { sent: false, error: (e && e.message) || 'fetch-error' };
  }
}

var REQUIRED_FIELDS = [
  'avg_client_ltv_cents',
  'conversion_rate',
  'attendance_rate',
  'investment_cents',
  'value_per_call_cents',
  'guarantee_calls',
  'total_benchmark'
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured())      return res.status(500).json({ error: 'Service not configured' });

  // ── Admin gate ───────────────────────────────────────────────
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var body = req.body || {};
  var slug = String(body.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Valid slug required' });
  }

  try {
    // 1. Load contact
    var contact = await sb.one(
      'contacts?select=id,slug,email,first_name,last_name,plan_tier,plan_type,status,lost' +
      '&slug=eq.' + encodeURIComponent(slug) + '&limit=1'
    );
    if (!contact)                                 return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost)                             return res.status(403).json({ error: 'Contact is no longer active' });

    // 2. Annual-only
    var isAnnual = (contact.plan_tier === 'annual') || (contact.plan_type === 'annual');
    if (!isAnnual) {
      return res.status(400).json({
        error: 'Lock-in is only available for annual plans',
        detail: 'Current plan: ' + (contact.plan_tier || contact.plan_type || 'none')
      });
    }

    // 3. Load the draft
    var pg = await sb.one(
      'performance_guarantees?select=*&contact_id=eq.' +
      encodeURIComponent(contact.id) + '&limit=1'
    );
    if (!pg) {
      return res.status(400).json({
        error: 'No Performance Guarantee draft exists for this client yet.'
      });
    }

    // 4. Idempotent: already locked. Admin can click Lock In safely a second
    //    time; we just return the current state. Signing happens inline at
    //    Step 9 of the client's onboarding page — nothing to re-deploy here.
    if (pg.status === 'locked') {
      return res.status(200).json({
        success: true,
        already_locked: true,
        locked_at: pg.locked_at,
        guarantee_calls: pg.guarantee_calls,
        total_benchmark: pg.total_benchmark,
        slug: slug,
        client_emailed: false   // intentional: don't re-email on retry-lock
      });
    }

    // 5. Draft completeness
    var missing = REQUIRED_FIELDS.filter(function(k) { return pg[k] == null; });
    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Draft is incomplete — client needs to fill in all fields first',
        missing: missing
      });
    }

    // 6. Flip draft → locked
    var patched = await sb.mutate(
      'performance_guarantees?id=eq.' + encodeURIComponent(pg.id),
      'PATCH',
      { status: 'locked', locked_at: new Date().toISOString() }
    );
    var locked = Array.isArray(patched) ? patched[0] : patched;
    if (!locked || locked.status !== 'locked') {
      throw new Error('Lock transition did not apply (PATCH returned no row with status=locked)');
    }

    // 7. Send the "ready to sign" email (first-time lock only). Failure here
    //    is non-fatal — the DB is already locked, admin can manually re-send
    //    by clicking Lock In again which will take the already-locked branch.
    var emailResult = { sent: false };
    try {
      emailResult = await sendReadyToSignEmail(contact);
      if (!emailResult.sent) {
        await monitor.logError('lock-guarantee',
          new Error('ready-to-sign email failed: ' + (emailResult.error || 'unknown')), {
            client_slug: slug,
            detail: { actor: user && user.email, stage: 'send_ready_to_sign' }
          });
      }
    } catch (e) {
      try {
        await monitor.logError('lock-guarantee', e, {
          client_slug: slug,
          detail: { actor: user && user.email, stage: 'send_ready_to_sign_threw' }
        });
      } catch (_) {}
    }

    return res.status(200).json({
      success: true,
      already_locked: false,
      locked_at: locked.locked_at,
      guarantee_calls: locked.guarantee_calls,
      total_benchmark: locked.total_benchmark,
      slug: slug,
      client_emailed: !!emailResult.sent
    });

  } catch (err) {
    await monitor.logError('lock-guarantee', err, {
      client_slug: slug,
      detail: { actor: user && user.email }
    });
    return res.status(500).json({ error: 'Lock-in failed' });
  }
};

// /api/stripe-webhook.js
// Receives Stripe webhook events for payment completions.
// Handles two flows:
//   1. CORE Marketing System purchase: flips contact status to 'onboarding'
//   2. Premium Entity Audit purchase: marks entity audit as 'paid'
//
// This is the server-side backstop for the client-side checkout/success page.
// Even if the browser redirect fails, this ensures status transitions happen.
//
// Setup: In Stripe Dashboard > Webhooks, create an endpoint pointing to
//   https://clients.moonraker.ai/api/stripe-webhook
// Listen for: checkout.session.completed
// Copy the signing secret and add as STRIPE_WEBHOOK_SECRET in Vercel env vars.

var crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  // ── Read raw body for signature verification ──
  var rawBody = '';
  if (typeof req.body === 'string') {
    rawBody = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else if (req.body && typeof req.body === 'object') {
    rawBody = JSON.stringify(req.body);
  }

  // ── Verify Stripe signature (if secret is configured) ──
  if (webhookSecret) {
    var sigHeader = req.headers['stripe-signature'] || '';
    var parts = {};
    sigHeader.split(',').forEach(function(item) {
      var kv = item.split('=');
      if (kv[0]) parts[kv[0].trim()] = kv[1];
    });

    var timestamp = parts['t'];
    var signature = parts['v1'];

    if (!timestamp || !signature) {
      return res.status(400).json({ error: 'Missing Stripe signature components' });
    }

    // Check timestamp freshness (5 min tolerance)
    var age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
    if (age > 300) {
      return res.status(400).json({ error: 'Webhook timestamp too old' });
    }

    var payload = timestamp + '.' + rawBody;
    var expected = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');

    if (expected !== signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  // ── Parse event ──
  var event;
  try {
    event = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!event || !event.type) {
    return res.status(400).json({ error: 'Missing event type' });
  }

  // Only handle checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  var session = event.data && event.data.object;
  if (!session) {
    return res.status(200).json({ received: true, error: 'No session object' });
  }

  var slug = session.client_reference_id || '';
  var customerEmail = (session.customer_details && session.customer_details.email) || session.customer_email || '';
  var amountTotal = session.amount_total || 0;
  var paymentStatus = session.payment_status || '';

  if (!slug) {
    // Try to find slug from metadata
    slug = (session.metadata && session.metadata.slug) || '';
  }

  if (!slug) {
    console.log('Stripe webhook: no slug found in session', session.id);
    return res.status(200).json({ received: true, warning: 'No client_reference_id or slug metadata' });
  }

  function sbHeaders(prefer) {
    var h = { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
    if (prefer) h['Prefer'] = prefer;
    return h;
  }

  try {
    // Look up the contact
    var contactResp = await fetch(
      sbUrl + '/rest/v1/contacts?slug=eq.' + slug + '&select=id,status,email,audit_tier&limit=1',
      { headers: sbHeaders() }
    );
    var contacts = await contactResp.json();

    if (!contacts || contacts.length === 0) {
      console.log('Stripe webhook: contact not found for slug', slug);
      return res.status(200).json({ received: true, warning: 'Contact not found: ' + slug });
    }

    var contact = contacts[0];
    var results = { slug: slug, session_id: session.id };

    // Determine what type of payment this is based on amount
    // Entity Audit: $2,000 (200000 cents) or $2,070 (207000 cents for CC)
    var isEntityAudit = amountTotal === 200000 || amountTotal === 207000;

    if (isEntityAudit) {
      // ── Premium Entity Audit payment ──
      // Update entity audit status to paid
      var eaResp = await fetch(
        sbUrl + '/rest/v1/entity_audits?contact_id=eq.' + contact.id + '&order=created_at.desc&limit=1',
        { headers: sbHeaders() }
      );
      var audits = await eaResp.json();

      if (audits && audits.length > 0) {
        await fetch(
          sbUrl + '/rest/v1/entity_audits?id=eq.' + audits[0].id,
          {
            method: 'PATCH',
            headers: sbHeaders('return=minimal'),
            body: JSON.stringify({
              audit_tier: 'premium',
              stripe_payment_id: session.payment_intent || session.id,
              updated_at: new Date().toISOString()
            })
          }
        );
        results.action = 'entity_audit_upgraded';
        results.audit_id = audits[0].id;
      }
    } else {
      // ── CORE Marketing System payment ──
      // Only flip to onboarding if they're currently a prospect
      if (contact.status === 'prospect') {
        var patchResp = await fetch(
          sbUrl + '/rest/v1/contacts?slug=eq.' + slug,
          {
            method: 'PATCH',
            headers: sbHeaders('return=minimal'),
            body: JSON.stringify({
              status: 'onboarding',
              updated_at: new Date().toISOString()
            })
          }
        );
        results.action = 'status_flipped_to_onboarding';
        results.previous_status = 'prospect';
      } else {
        results.action = 'no_status_change';
        results.reason = 'Contact status is ' + contact.status + ', not prospect';
      }
    }

    // Log the payment
    try {
      await fetch(sbUrl + '/rest/v1/payments', {
        method: 'POST',
        headers: sbHeaders('return=minimal'),
        body: JSON.stringify({
          contact_id: contact.id,
          stripe_session_id: session.id,
          stripe_payment_intent: session.payment_intent || null,
          amount_cents: amountTotal,
          currency: session.currency || 'usd',
          status: paymentStatus,
          metadata: { source: 'webhook', event_id: event.id }
        })
      });
    } catch (logErr) {
      console.log('Failed to log payment:', logErr.message);
    }

    return res.status(200).json({ received: true, results: results });

  } catch (err) {
    console.error('Stripe webhook error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};

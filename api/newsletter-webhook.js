// api/newsletter-webhook.js
// Resend webhook handler for newsletter event tracking.
// Receives: email.delivered, email.opened, email.clicked,
//           email.bounced, email.complained
// Updates newsletter_sends and newsletter_subscribers tables.
// Configure in Resend dashboard: POST https://clients.moonraker.ai/api/newsletter-webhook

var crypto = require('crypto');
var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Resend webhook signature
  var webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (webhookSecret) {
    var svixId = req.headers['svix-id'];
    var svixTimestamp = req.headers['svix-timestamp'];
    var svixSignature = req.headers['svix-signature'];
    if (!svixId || !svixTimestamp || !svixSignature) {
      return res.status(401).json({ error: 'Missing webhook signature headers' });
    }
    var age = Math.abs(Date.now() / 1000 - parseInt(svixTimestamp));
    if (age > 300) {
      return res.status(401).json({ error: 'Webhook timestamp too old' });
    }
    var rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    var toSign = svixId + '.' + svixTimestamp + '.' + rawBody;
    var secretBytes = Buffer.from(webhookSecret.replace(/^whsec_/, ''), 'base64');
    var expected = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64');
    var signatures = svixSignature.split(' ').map(function(s) { return s.replace(/^v1,/, ''); });
    if (signatures.indexOf(expected) === -1) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } else {
    console.warn('RESEND_WEBHOOK_SECRET not configured -- webhook signature verification skipped');
  }

  try {
    var body = req.body;
    if (!body || !body.type) return res.status(400).json({ error: 'Invalid webhook payload' });

    var type = body.type;
    var data = body.data || {};
    var messageId = data.email_id || '';
    var now = new Date().toISOString();

    if (!messageId) return res.status(200).json({ ok: true, skipped: 'no message id' });

    // Find the send record by Resend message ID
    var sends = await sb.query('newsletter_sends', 'resend_message_id=eq.' + messageId + '&select=id,subscriber_id,newsletter_id,status');
    if (!sends.length) return res.status(200).json({ ok: true, skipped: 'send record not found' });

    var send = sends[0];
    var updates = {};
    var subUpdates = {};

    switch (type) {
      case 'email.delivered':
        updates.status = 'delivered';
        updates.delivered_at = now;
        subUpdates.last_engaged_at = now;
        break;

      case 'email.opened':
        updates.status = 'opened';
        updates.opened_at = now;
        subUpdates.last_engaged_at = now;
        // Increment newsletter stats
        await incrementStat(send.newsletter_id, 'stats_opened');
        break;

      case 'email.clicked':
        updates.status = 'clicked';
        updates.clicked_at = now;
        subUpdates.last_engaged_at = now;
        await incrementStat(send.newsletter_id, 'stats_clicked');
        break;

      case 'email.bounced':
        updates.status = 'bounced';
        subUpdates.status = 'bounced';
        subUpdates.bounce_count = (send.bounce_count || 0) + 1;
        await incrementStat(send.newsletter_id, 'stats_bounced');
        break;

      case 'email.complained':
        updates.status = 'complained';
        subUpdates.status = 'complained';
        await incrementStat(send.newsletter_id, 'stats_complained');
        break;

      default:
        return res.status(200).json({ ok: true, skipped: 'unhandled type: ' + type });
    }

    // Update send record
    if (Object.keys(updates).length) {
      await sb.mutate('newsletter_sends', 'id=eq.' + send.id, 'PATCH', updates);
    }

    // Update subscriber record
    if (Object.keys(subUpdates).length) {
      await sb.mutate('newsletter_subscribers', 'id=eq.' + send.subscriber_id, 'PATCH', subUpdates);
    }

    // Auto-upgrade engagement tier on opens/clicks
    if (type === 'email.opened' || type === 'email.clicked') {
      await sb.mutate('newsletter_subscribers', 'id=eq.' + send.subscriber_id + '&engagement_tier=neq.hot', 'PATCH', {
        engagement_tier: 'hot'
      });
    }

    return res.status(200).json({ ok: true, type: type, send_id: send.id });

  } catch (e) {
    console.error('newsletter-webhook error:', e);
    // Always return 200 to prevent Resend retries on our errors
    return res.status(200).json({ ok: false, error: e.message });
  }
};

// Increment a stats column on the newsletters table using RPC
// Since we can't do atomic increments via REST easily, we fetch + update
async function incrementStat(newsletterId, column) {
  try {
    var newsletters = await sb.query('newsletters', 'id=eq.' + newsletterId + '&select=id,' + column);
    if (!newsletters.length) return;
    var current = newsletters[0][column] || 0;
    var patch = {};
    patch[column] = current + 1;
    await sb.mutate('newsletters', 'id=eq.' + newsletterId, 'PATCH', patch);
  } catch (e) {
    console.error('incrementStat error:', e);
  }
}

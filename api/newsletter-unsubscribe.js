// api/newsletter-unsubscribe.js
// Handles newsletter unsubscribe requests.
// GET  ?sid=subscriber_id  -> renders confirmation page
// POST ?sid=subscriber_id  -> processes unsubscribe (also handles List-Unsubscribe-Post)

var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  var sid = (req.query && req.query.sid) || '';

  // POST = one-click unsubscribe (from email header) or form submit
  if (req.method === 'POST') {
    if (!sid) return res.status(400).json({ error: 'Missing subscriber ID' });

    // Validate UUID format (test sends use 'test' or 'preview' which aren't real UUIDs)
    var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(sid)) {
      // Show success page anyway (likely a test email)
      var accept = req.headers && req.headers.accept || '';
      if (accept.indexOf('text/html') >= 0) return res.status(200).send(unsubPage(true));
      return res.status(200).json({ ok: true, message: 'Unsubscribed (test)' });
    }

    try {
      await sb.mutate('newsletter_subscribers?id=eq.' + encodeURIComponent(sid), 'PATCH', {
        status: 'unsubscribed',
        unsubscribed_at: new Date().toISOString()
      });
      // Return simple confirmation for one-click, or redirect for form
      var accept = req.headers && req.headers.accept || '';
      if (accept.indexOf('text/html') >= 0) {
        return res.status(200).send(unsubPage(true));
      }
      return res.status(200).json({ ok: true, message: 'Unsubscribed' });
    } catch (e) {
      console.error('Unsubscribe error:', e);
      return res.status(500).json({ error: 'Failed to unsubscribe' });
    }
  }

  // GET = show confirmation page
  if (req.method === 'GET') {
    if (!sid) return res.status(200).send(unsubPage(false, true));
    return res.status(200).send(unsubPage(false, false, sid));
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

function unsubPage(confirmed, noId, sid) {
  var body = '';

  if (confirmed) {
    body = '<h1>You\'ve been unsubscribed</h1>' +
      '<p>You won\'t receive any more newsletters from Moonraker. If this was a mistake, reply to any previous newsletter or email <a href="mailto:support@moonraker.ai">support@moonraker.ai</a>.</p>';
  } else if (noId) {
    body = '<h1>Unsubscribe</h1>' +
      '<p>It looks like the unsubscribe link is incomplete. Please reply to any previous newsletter or email <a href="mailto:support@moonraker.ai">support@moonraker.ai</a> and we\'ll remove you right away.</p>';
  } else {
    body = '<h1>Unsubscribe from Moonraker Newsletter</h1>' +
      '<p>Click the button below to stop receiving our weekly newsletter.</p>' +
      '<form method="POST" action="/api/newsletter-unsubscribe?sid=' + esc(sid) + '">' +
        '<button type="submit" style="display:inline-block;background:#00D47E;color:#fff;font-family:Inter,sans-serif;font-weight:600;font-size:15px;border:none;padding:14px 32px;border-radius:8px;cursor:pointer;margin-top:16px;">Unsubscribe</button>' +
      '</form>' +
      '<p style="margin-top:24px;font-size:14px;color:#6B7599;">You\'ll miss out on the SEO and compliance updates that keep your practice ahead of the curve, but we understand.</p>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<title>Unsubscribe - Moonraker</title>' +
    '<style>@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@700&family=Inter:wght@400;500;600&display=swap");</style>' +
    '</head><body style="margin:0;padding:0;background:#F7FDFB;font-family:Inter,sans-serif;">' +
    '<div style="max-width:500px;margin:60px auto;padding:40px;background:#fff;border-radius:14px;border:1px solid #E2E8F0;text-align:center;">' +
      '<img src="/assets/logo.png" alt="Moonraker" height="28" style="margin-bottom:24px;opacity:.8;" />' +
      '<div style="text-align:left;">' +
        body.replace(/<h1>/g, '<h1 style="font-family:Outfit,sans-serif;font-size:24px;font-weight:700;color:#1E2A5E;margin:0 0 16px;">') +
        '</div>' +
    '</div></body></html>';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


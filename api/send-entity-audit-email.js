// /api/send-entity-audit-email.js
// Sends the entity audit scorecard email to the lead/prospect via Resend.
// Uses shared email template for consistent branding.
//
// POST { audit_id, subject?, body_html?, preview_only? }
//   - If subject/body_html omitted, generates a default email
//   - If preview_only=true, returns the email without sending
//
// ENV VARS: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

var email = require('./_lib/email-template');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var body = req.body || {};
  var auditId = body.audit_id;
  if (!auditId) return res.status(400).json({ error: 'audit_id required' });

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }

  // Load audit + contact
  var audit, contact;
  try {
    var aResp = await fetch(sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId + '&select=*', { headers: sbHeaders() });
    var audits = await aResp.json();
    if (!audits || audits.length === 0) return res.status(404).json({ error: 'Audit not found' });
    audit = audits[0];

    var cResp = await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + audit.contact_id + '&select=*', { headers: sbHeaders() });
    var contacts = await cResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found' });
    contact = contacts[0];
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load audit: ' + e.message });
  }

  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });

  var firstName = contact.first_name || 'there';
  var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var slug = contact.slug;
  var scorecardUrl = 'https://clients.moonraker.ai/' + slug + '/entity-audit';
  var scores = audit.scores || {};

  // Build default email if not provided
  var subject = body.subject || 'Your CORE Entity Audit Results Are Ready';
  var bodyHtml = body.body_html || buildDefaultEmail(firstName, practiceName, scorecardUrl, scores);

  // Preview mode
  if (body.preview_only) {
    return res.status(200).json({
      ok: true,
      preview: true,
      to: contact.email,
      from: email.FROM.audits,
      reply_to: 'scott@moonraker.ai',
      cc: 'chris@moonraker.ai, scott@moonraker.ai',
      subject: subject,
      body_html: bodyHtml
    });
  }

  // Send via Resend
  try {
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: email.FROM.audits,
        to: [contact.email],
        cc: ['chris@moonraker.ai', 'scott@moonraker.ai'],
        reply_to: 'scott@moonraker.ai',
        subject: subject,
        html: bodyHtml
      })
    });
    var emailData = await emailResp.json();

    if (emailData.id) {
      // Update audit record: flip to delivered + save email metadata
      await fetch(sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId, {
        method: 'PATCH', headers: sbHeaders(),
        body: JSON.stringify({
          status: 'delivered',
          sent_at: new Date().toISOString(),
          sent_to: contact.email,
          email_subject: subject,
          email_body: bodyHtml
        })
      });

      return res.status(200).json({ ok: true, email_id: emailData.id });
    } else {
      return res.status(500).json({ error: 'Resend error', details: emailData });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Email send failed: ' + e.message });
  }
};

function buildDefaultEmail(firstName, practiceName, scorecardUrl, scores) {
  return email.wrap({
    headerLabel: 'CORE Entity Audit',
    content:
      email.greeting(firstName) +
      email.p('Your CORE Entity Audit for <strong>' + email.esc(practiceName) + '</strong> is ready. We analyzed how AI platforms and search engines currently understand and represent your practice online.') +
      email.coreScoreCards(scores) +
      email.p('Your scorecard includes a breakdown of findings across all four pillars, along with the first fix in each area you can implement right away.') +
      email.cta(scorecardUrl, 'View Your Full Scorecard')
  });
}

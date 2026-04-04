// /api/send-proposal-email.js
// Sends a proposal email to the prospect via Resend.
// Uses shared email template for consistent branding.
//
// POST { proposal_id, subject?, body_html?, preview_only? }
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
  var proposalId = body.proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }

  // Load proposal + contact
  var proposal, contact;
  try {
    var pResp = await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId + '&select=*,contacts(*)&limit=1', { headers: sbHeaders() });
    var proposals = await pResp.json();
    if (!proposals || proposals.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    proposal = proposals[0];
    contact = proposal.contacts;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load proposal: ' + e.message });
  }

  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });
  if (!proposal.proposal_url) return res.status(400).json({ error: 'Proposal has not been deployed yet' });

  var firstName = contact.first_name || 'there';
  var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var proposalUrl = proposal.proposal_url;

  // Build default email if not provided
  var subject = body.subject || 'Your Growth Proposal from Moonraker is Ready';
  var bodyHtml = body.body_html || buildDefaultEmail(firstName, practiceName, proposalUrl);

  // Preview mode - return without sending
  if (body.preview_only) {
    return res.status(200).json({
      ok: true,
      preview: true,
      to: contact.email,
      from: email.FROM.proposals,
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
        from: email.FROM.proposals,
        to: [contact.email],
        cc: ['chris@moonraker.ai', 'scott@moonraker.ai'],
        reply_to: 'scott@moonraker.ai',
        subject: subject,
        html: bodyHtml
      })
    });
    var emailData = await emailResp.json();

    if (emailData.id) {
      // Update proposal record
      await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId, {
        method: 'PATCH', headers: sbHeaders(),
        body: JSON.stringify({
          status: 'sent',
          sent_at: new Date().toISOString(),
          sent_from: 'proposals@clients.moonraker.ai',
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

function buildDefaultEmail(firstName, practiceName, proposalUrl) {
  return email.wrap({
    headerLabel: 'Growth Proposal',
    footerNote: 'Questions? Reply to this email or <a href="' + email.CALENDAR_URL + '" style="font-family:Inter,sans-serif;color:#00D47E;text-decoration:none;font-weight:500;">book a call with Scott</a>.',
    content:
      email.greeting(firstName) +
      email.p('Thank you for taking the time to speak with us about ' + email.esc(practiceName) + '. We have put together a personalized growth proposal based on our conversation and analysis of your current digital presence.') +
      email.p('Inside, you will find a detailed assessment of where your practice stands today across the four pillars of our CORE framework, along with a concrete strategy and timeline for growing your visibility in both traditional search and AI-powered platforms.') +
      email.cta(proposalUrl, 'View Your Proposal') +
      email.p('Feel free to take your time reviewing everything. If you have any questions, you can reply to this email and it will go directly to Scott, our Director of Growth, or you can book a follow-up call at a time that works for you.') +
      email.bookingButton() +
      email.p('We are excited about the opportunity to help ' + email.esc(practiceName) + ' grow. Looking forward to hearing your thoughts.')
  });
}

// /api/send-audit-email.js
// Sends a branded entity audit delivery email to the client via Resend.
// Also updates entity_audits status to 'delivered' and records sent_at/sent_to.
//
// POST { audit_id }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var resendKey = process.env.RESEND_API_KEY;

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var auditId = (req.body || {}).audit_id;
  if (!auditId) return res.status(400).json({ error: 'audit_id required' });

  function sbHeaders(prefer) {
    var h = { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
    if (prefer) h['Prefer'] = prefer;
    return h;
  }

  try {
    // Load audit + contact
    var auditResp = await fetch(
      sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId + '&select=*,contacts(id,slug,first_name,last_name,practice_name,email,city,state_province)&limit=1',
      { headers: sbHeaders() }
    );
    var audits = await auditResp.json();
    if (!audits || audits.length === 0) return res.status(404).json({ error: 'Audit not found' });

    var audit = audits[0];
    var contact = audit.contacts;
    if (!contact) return res.status(404).json({ error: 'Contact not found for audit' });
    if (!contact.email) return res.status(400).json({ error: 'No email on file for this contact' });

    var slug = contact.slug;
    var firstName = contact.first_name || '';
    var practiceName = contact.practice_name || '';
    var scorecardUrl = 'https://clients.moonraker.ai/' + slug + '/entity-audit';

    // Build scores summary for the email
    var scores = audit.scores || {};
    var coreScores = [];
    if (scores.credibility !== undefined) coreScores.push({ label: 'Credibility', score: scores.credibility });
    if (scores.optimization !== undefined) coreScores.push({ label: 'Optimization', score: scores.optimization });
    if (scores.reputation !== undefined) coreScores.push({ label: 'Reputation', score: scores.reputation });
    if (scores.engagement !== undefined) coreScores.push({ label: 'Engagement', score: scores.engagement });
    var overallScore = scores.overall || null;

    // Build email HTML
    var scoreCards = '';
    if (coreScores.length > 0) {
      scoreCards = '<div style="display:flex;gap:8px;margin:20px 0;">';
      coreScores.forEach(function(s) {
        var color = s.score >= 80 ? '#00D47E' : s.score >= 50 ? '#F59E0B' : '#EF4444';
        scoreCards += '<div style="flex:1;text-align:center;padding:12px 8px;background:#1a1f2e;border-radius:8px;border:1px solid #2a2f3e;">' +
          '<div style="font-size:22px;font-weight:700;color:' + color + ';">' + Math.round(s.score) + '</div>' +
          '<div style="font-size:11px;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:.04em;">' + s.label + '</div>' +
        '</div>';
      });
      scoreCards += '</div>';
    }

    var overallHtml = '';
    if (overallScore !== null) {
      var oc = overallScore >= 80 ? '#00D47E' : overallScore >= 50 ? '#F59E0B' : '#EF4444';
      overallHtml = '<div style="text-align:center;margin:16px 0 20px;">' +
        '<div style="font-size:13px;color:#888;margin-bottom:4px;">Overall CORE Score</div>' +
        '<div style="font-size:36px;font-weight:700;color:' + oc + ';">' + Math.round(overallScore) + '<span style="font-size:16px;color:#666;">/100</span></div>' +
      '</div>';
    }

    var greeting = firstName ? ('Hi ' + esc(firstName) + ',') : 'Hello,';

    var htmlBody = '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
      '<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">' +
      '<div style="max-width:560px;margin:0 auto;padding:32px 24px;">' +
        '<div style="margin-bottom:24px;">' +
          '<img src="https://clients.moonraker.ai/assets/logo.png" alt="Moonraker AI" style="height:28px;" />' +
        '</div>' +
        '<div style="background:#141922;border-radius:12px;border:1px solid #1e2533;padding:28px;">' +
          '<p style="font-size:15px;color:#e0e0e0;margin:0 0 16px;line-height:1.6;">' + greeting + '</p>' +
          '<p style="font-size:15px;color:#e0e0e0;margin:0 0 16px;line-height:1.6;">' +
            'Your CORE Entity Audit' + (practiceName ? ' for <strong style="color:#fff;">' + esc(practiceName) + '</strong>' : '') + ' is ready. ' +
            'This report evaluates your practice\'s digital presence across four key areas: Credibility, Optimization, Reputation, and Engagement.' +
          '</p>' +
          overallHtml +
          scoreCards +
          '<p style="font-size:14px;color:#ccc;margin:16px 0 24px;line-height:1.6;">' +
            'Your scorecard includes a detailed breakdown of each area with specific findings and recommendations for improvement.' +
          '</p>' +
          '<div style="text-align:center;margin:24px 0 8px;">' +
            '<a href="' + esc(scorecardUrl) + '" style="display:inline-block;padding:12px 28px;background:#00D47E;color:#0d1117;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">View Your Scorecard</a>' +
          '</div>' +
        '</div>' +
        '<p style="font-size:12px;color:#555;margin-top:20px;text-align:center;">Moonraker AI &middot; Digital Marketing for Therapy Practices</p>' +
      '</div>' +
      '</body></html>';

    // Send via Resend
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Moonraker AI <audits@clients.moonraker.ai>',
        to: [contact.email],
        cc: ['scott@moonraker.ai'],
        subject: 'Your CORE Entity Audit is Ready' + (practiceName ? ' - ' + practiceName : ''),
        html: htmlBody
      })
    });

    var emailResult = await emailResp.json();
    if (!emailResp.ok) {
      console.error('Resend error:', emailResult);
      return res.status(500).json({ ok: false, error: 'Email send failed', detail: emailResult });
    }

    // Update audit status
    await fetch(sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId, {
      method: 'PATCH',
      headers: sbHeaders('return=minimal'),
      body: JSON.stringify({
        status: 'delivered',
        sent_at: new Date().toISOString(),
        sent_to: contact.email,
        updated_at: new Date().toISOString()
      })
    });

    return res.status(200).json({ ok: true, email_id: emailResult.id, sent_to: contact.email });

  } catch (err) {
    console.error('send-audit-email error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

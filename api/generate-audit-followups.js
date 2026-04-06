// /api/generate-audit-followups.js
// Generates 3 follow-up email drafts for a delivered entity audit.
// Emails are personalized from the CORE scores and findings data.
// Schedule: Day 2, Day 7, Day 14 after audit delivery.
//
// POST { audit_id }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

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
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Check for existing followups
    var existCheck = await fetch(
      sbUrl + '/rest/v1/audit_followups?audit_id=eq.' + auditId + '&limit=1',
      { headers: sbHeaders() }
    );
    var existing = await existCheck.json();
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Follow-ups already exist for this audit. Delete them first to regenerate.' });
    }

    // Extract scores and findings
    var scores = audit.scores || {};
    var firstName = contact.first_name || '';
    var practiceName = contact.practice_name || '';
    var slug = contact.slug;
    var scorecardUrl = 'https://clients.moonraker.ai/' + slug + '/entity-audit';
    var bookingUrl = 'https://msg.moonraker.ai/widget/bookings/moonraker-free-strategy-call';

    // Find weakest and strongest areas
    var areas = [
      { key: 'credibility', label: 'Credibility', score: scores.credibility || 0 },
      { key: 'optimization', label: 'Optimization', score: scores.optimization || 0 },
      { key: 'reputation', label: 'Reputation', score: scores.reputation || 0 },
      { key: 'engagement', label: 'Engagement', score: scores.engagement || 0 }
    ];
    areas.sort(function(a, b) { return a.score - b.score; });
    var weakest = areas[0];
    var secondWeakest = areas[1];
    var strongest = areas[areas.length - 1];
    var overall = scores.overall || 0;

    // Extract tasks/findings if available
    var tasks = audit.tasks || [];
    var weakestTasks = tasks.filter(function(t) { return t.category && t.category.toLowerCase().indexOf(weakest.key) > -1; }).slice(0, 3);
    var secondTasks = tasks.filter(function(t) { return t.category && t.category.toLowerCase().indexOf(secondWeakest.key) > -1; }).slice(0, 2);

    // Build 3 emails
    var emails = [
      buildEmail1(firstName, practiceName, overall, weakest, scorecardUrl, bookingUrl),
      buildEmail2(firstName, practiceName, weakest, secondWeakest, weakestTasks, secondTasks, scorecardUrl, bookingUrl),
      buildEmail3(firstName, practiceName, overall, strongest, weakest, bookingUrl)
    ];

    // Insert as drafts
    var rows = emails.map(function(email, i) {
      return {
        audit_id: auditId,
        contact_id: contact.id,
        sequence_number: i + 1,
        day_offset: email.dayOffset,
        status: 'draft',
        subject: email.subject,
        body_html: email.html
      };
    });

    var insertResp = await fetch(sbUrl + '/rest/v1/audit_followups', {
      method: 'POST',
      headers: sbHeaders('return=representation'),
      body: JSON.stringify(rows)
    });
    var inserted = await insertResp.json();

    return res.status(200).json({ ok: true, count: rows.length, followups: inserted });

  } catch (err) {
    console.error('generate-audit-followups error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Email Builders ──

function buildEmail1(firstName, practiceName, overall, weakest, scorecardUrl, bookingUrl) {
  var greeting = firstName ? 'Hi ' + esc(firstName) + ',' : 'Hello,';
  var scoreColor = overall >= 80 ? '#00D47E' : overall >= 50 ? '#F59E0B' : '#EF4444';
  var weakColor = weakest.score >= 80 ? '#00D47E' : weakest.score >= 50 ? '#F59E0B' : '#EF4444';

  return {
    dayOffset: 2,
    subject: 'Did you get a chance to review your CORE Score?',
    html: wrap(
      greeting +
      '<br><br>I wanted to follow up on the entity audit we sent over for ' + esc(practiceName || 'your practice') + '.' +
      '<br><br>Your overall CORE Score came in at <strong style="color:' + scoreColor + ';">' + Math.round(overall) + '/100</strong>.' +
      ' The area with the most room for improvement is <strong>' + esc(weakest.label) + '</strong>, which scored <strong style="color:' + weakColor + ';">' + Math.round(weakest.score) + '/100</strong>.' +
      '<br><br>This is actually one of the most common patterns we see with therapy practices. The good news is that ' + esc(weakest.label).toLowerCase() + ' improvements tend to show measurable results within the first 60 to 90 days.' +
      '<br><br>If you have any questions about the scorecard, I am happy to walk through it with you:' +
      '<br><br>' + ctaButton('View Your Scorecard', scorecardUrl) +
      '<br><br>Or if you would prefer to discuss it live:' +
      '<br><br>' + ctaButton('Book a Free Strategy Call', bookingUrl) +
      '<br><br>Talk soon,'
    )
  };
}

function buildEmail2(firstName, practiceName, weakest, secondWeakest, weakTasks, secondTasks, scorecardUrl, bookingUrl) {
  var greeting = firstName ? 'Hi ' + esc(firstName) + ',' : 'Hello,';

  var findingsHtml = '';
  if (weakTasks.length > 0 || secondTasks.length > 0) {
    findingsHtml = '<br><br>Here are a couple of specific things we found:';
    findingsHtml += '<br><br><strong>' + esc(weakest.label) + ' (' + Math.round(weakest.score) + '/100):</strong>';
    if (weakTasks.length > 0) {
      weakTasks.forEach(function(t) {
        findingsHtml += '<br>&bull; ' + esc(t.title || t.description || '');
      });
    } else {
      findingsHtml += '<br>&bull; This area needs attention based on our analysis';
    }
    if (secondTasks.length > 0) {
      findingsHtml += '<br><br><strong>' + esc(secondWeakest.label) + ' (' + Math.round(secondWeakest.score) + '/100):</strong>';
      secondTasks.forEach(function(t) {
        findingsHtml += '<br>&bull; ' + esc(t.title || t.description || '');
      });
    }
  }

  return {
    dayOffset: 7,
    subject: 'What your CORE audit means for ' + (practiceName || 'your practice'),
    html: wrap(
      greeting +
      '<br><br>I wanted to share a bit more context on what we found in your entity audit.' +
      findingsHtml +
      '<br><br>The reason this matters: when AI platforms like Google AI Overviews, ChatGPT, and Gemini recommend therapists, they pull from the same signals we measured in your audit. A lower ' + esc(weakest.label).toLowerCase() + ' score means those platforms have less confidence when deciding whether to recommend your practice.' +
      '<br><br>We have seen practices go from not appearing in AI results at all to being recommended consistently within 3 to 4 months of addressing these areas.' +
      '<br><br>Would it be helpful to walk through exactly what we would prioritize if we were working together?  ' +
      '<br><br>' + ctaButton('Book a Free Strategy Call', bookingUrl) +
      '<br><br>Best,'
    )
  };
}

function buildEmail3(firstName, practiceName, overall, strongest, weakest, bookingUrl) {
  var greeting = firstName ? 'Hi ' + esc(firstName) + ',' : 'Hello,';

  return {
    dayOffset: 14,
    subject: 'A quick roadmap for ' + (practiceName || 'your practice'),
    html: wrap(
      greeting +
      '<br><br>I know things get busy, so I will keep this short.' +
      '<br><br>Based on your audit, here is what the first 90 days would look like if we worked together:' +
      '<br><br><strong>Month 1:</strong> Foundation work. We would address the ' + esc(weakest.label).toLowerCase() + ' gaps that are currently holding back your visibility. This includes the technical setup that tells Google and AI platforms you are a legitimate, qualified practice.' +
      '<br><br><strong>Month 2:</strong> Build authority. We would start creating and distributing content that establishes you as an expert in your specialties. Your ' + esc(strongest.label).toLowerCase() + ' score of ' + Math.round(strongest.score) + ' shows you already have a strong base to build on.' +
      '<br><br><strong>Month 3:</strong> Measure and optimize. By this point, most practices start seeing movement in their local search rankings, AI visibility, and new patient inquiries.' +
      '<br><br>We back this with a performance guarantee for annual clients: if we do not hit our shared goal in 12 months, we continue working for free until you get there.' +
      '<br><br>If you are interested in learning more, I would love to chat:' +
      '<br><br>' + ctaButton('Book a Free Strategy Call', bookingUrl) +
      '<br><br>All the best,'
    )
  };
}

// ── Shared Helpers ──

function wrap(bodyContent) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;">' +
      '<div style="margin-bottom:24px;">' +
        '<img src="https://clients.moonraker.ai/assets/logo.png" alt="Moonraker AI" style="height:24px;" />' +
      '</div>' +
      '<div style="font-size:15px;color:#333;line-height:1.65;">' +
        bodyContent +
        '<br><br><span style="color:#333;">Scott Pope</span>' +
        '<br><span style="font-size:13px;color:#888;">Director of Growth, Moonraker AI</span>' +
      '</div>' +
      '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;">' +
        '<p style="font-size:11px;color:#999;margin:0;">Moonraker AI &middot; Digital Marketing for Therapy Practices</p>' +
      '</div>' +
    '</div>' +
    '</body></html>';
}

function ctaButton(label, url) {
  return '<a href="' + esc(url) + '" style="display:inline-block;padding:10px 20px;background:#00D47E;color:#0d1117;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;">' + esc(label) + '</a>';
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// /api/approve-audit-followups.js
// Approves draft audit follow-up emails by scheduling them relative to now.
// Sets status to 'pending' and calculates scheduled_for from day_offset.
//
// POST { audit_id }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var auditId = (req.body || {}).audit_id;
  if (!auditId) return res.status(400).json({ error: 'audit_id required' });

  try {
    // Load draft followups
    var drafts = await sb.query('audit_followups?audit_id=eq.' + auditId + '&status=eq.draft&order=sequence_number.asc');
    if (!drafts || drafts.length === 0) {
      return res.status(400).json({ error: 'No draft follow-ups to approve' });
    }

    // Schedule each email: now + day_offset days, at 10:00 AM ET (14:00 UTC)
    var now = new Date();
    var scheduled = 0;

    for (var i = 0; i < drafts.length; i++) {
      var fu = drafts[i];
      var sendDate = new Date(now);
      sendDate.setDate(sendDate.getDate() + fu.day_offset);
      sendDate.setUTCHours(14, 0, 0, 0); // 10am ET

      await sb.mutate('audit_followups?id=eq.' + fu.id, 'PATCH', {
        status: 'pending',
        scheduled_for: sendDate.toISOString(),
        updated_at: new Date().toISOString()
      }, 'return=minimal');
      scheduled++;
    }

    return res.status(200).json({ ok: true, scheduled: scheduled });
  } catch (err) {
    console.error('approve-audit-followups error:', err);
    return res.status(500).json({ error: err.message });
  }
};

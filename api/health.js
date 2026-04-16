// /api/health.js - System health check endpoint
// Returns 200 with basic system status. Useful for uptime monitoring.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function handler(req, res) {
  // Require admin or internal auth to prevent info disclosure
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var status = { ok: true, timestamp: new Date().toISOString() };

  // Quick Supabase connectivity check
  if (sb.isConfigured()) {
    try {
      var start = Date.now();
      await sb.query('settings?key=eq.__health_check__&limit=1');
      status.supabase = { ok: true, latency_ms: Date.now() - start };
    } catch (e) {
      status.supabase = { ok: false, error: e.message };
    }
  } else {
    status.supabase = { ok: false, error: 'not configured' };
  }

  return res.status(200).json(status);
};

// /api/health.js - Simple health check endpoint
// Returns 200 with basic system status. Useful for uptime monitoring.

var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
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

  // Check key env vars (existence only, not values)
  status.env = {
    supabase: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    github: !!process.env.GITHUB_PAT,
    resend: !!process.env.RESEND_API_KEY,
    agent: !!process.env.AGENT_SERVICE_URL
  };

  return res.status(200).json(status);
};

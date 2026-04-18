// /api/cron/cleanup-rate-limits.js
// Daily cron: sweeps rate_limits rows whose window_start is older than 1 day.
// Those rows are expired past any reasonable window we'd use (chat windows
// are 60s, endorsement is 1 hour) and serve no purpose. Table would otherwise
// grow unbounded at ~1 row per unique (ip, route) pair that hits any limited
// endpoint.
//
// Scheduled in vercel.json: "0 6 * * *" (06:00 UTC daily).
// Auth: CRON_SECRET / admin JWT / AGENT_API_KEY via requireAdminOrInternal.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  try {
    // PostgREST DELETE with filter; Prefer: return=representation gives us
    // the deleted rows so we can count them. The window_start=lt filter
    // uses the index we added in the migration.
    var cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    var deleted = await sb.mutate(
      'rate_limits?window_start=lt.' + encodeURIComponent(cutoff),
      'DELETE',
      null,
      'return=representation'
    );

    var count = Array.isArray(deleted) ? deleted.length : 0;
    console.log('[cleanup-rate-limits] deleted', count, 'expired rows (cutoff:', cutoff, ')');
    return res.status(200).json({ ok: true, deleted: count, cutoff: cutoff });
  } catch (e) {
    console.error('[cleanup-rate-limits] error:', e.message);
    monitor.logError('cron/cleanup-rate-limits', e, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Rate limit cleanup failed' });
  }
};

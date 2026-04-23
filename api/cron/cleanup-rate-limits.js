// /api/cron/cleanup-rate-limits.js
// Daily cron: sweeps rate_limits rows whose window_start is older than 1 day.
// Those rows are expired past any reasonable window we'd use (chat windows
// are 60s, endorsement is 1 hour) and serve no purpose. Table would otherwise
// grow unbounded at ~1 row per unique (ip, route) pair that hits any limited
// endpoint.
//
// Scheduled in vercel.json: "30 6 * * *" (06:30 UTC daily).
// Auth: CRON_SECRET / admin JWT / AGENT_API_KEY via requireAdminOrInternal.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  try {
    // Rate-limits: window_start < 24h ago.
    var rlCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    var deleted = await sb.mutate(
      'rate_limits?window_start=lt.' + encodeURIComponent(rlCutoff),
      'DELETE',
      null,
      'return=representation'
    );
    var rlCount = Array.isArray(deleted) ? deleted.length : 0;
    console.log('[cleanup-rate-limits] deleted', rlCount, 'rate-limit rows (cutoff:', rlCutoff, ')');

    // cron_runs: 30-day retention (audit Decision #4).
    var crCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    var crCount = 0;
    try {
      var crDeleted = await sb.mutate(
        'cron_runs?started_at=lt.' + encodeURIComponent(crCutoff),
        'DELETE',
        null,
        'return=representation'
      );
      crCount = Array.isArray(crDeleted) ? crDeleted.length : 0;
      console.log('[cleanup-rate-limits] deleted', crCount, 'cron_runs rows (cutoff:', crCutoff, ')');
    } catch (cre) {
      monitor.logError('cron/cleanup-rate-limits', cre, {
        detail: { stage: 'cron_runs_prune', cutoff: crCutoff }
      });
    }

    return res.status(200).json({
      ok: true,
      rate_limits_deleted: rlCount,
      cron_runs_deleted: crCount,
      rate_limits_cutoff: rlCutoff,
      cron_runs_cutoff: crCutoff
    });
  } catch (e) {
    console.error('[cleanup-rate-limits] error:', e.message);
    monitor.logError('cron/cleanup-rate-limits', e, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Rate limit cleanup failed' });
  }
}

module.exports = cronRuns.withTracking('cleanup-rate-limits', handler);

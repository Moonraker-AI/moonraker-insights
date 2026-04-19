// /api/cron/cron-heartbeat-check.js
// Runs daily. For each known cron, queries cron_runs for the latest
// successful completion and alerts via monitor.critical if the gap exceeds
// the expected interval × a tolerance multiplier. Closes the visibility
// gap where a silently-dead cron used to go unnoticed until a client
// complaint (cron audit Decision #4).
//
// Vercel cron: daily at 08:00 UTC. Runs once ahead of the heavy daily work
// so failures from the previous 24h surface before the next batch kicks off.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');

// Expected window per cron. If last_success_at is older than
// intervalSec + toleranceSec, we alert. Tolerance covers one normal
// interval slip (Vercel delay, clock skew) without false positives.
var EXPECTED = {
  'enqueue-reports':         { intervalSec: 30 * 86400, toleranceSec: 5 * 86400 },
  'process-queue':           { intervalSec: 300,         toleranceSec: 60 * 60 },
  'process-followups':       { intervalSec: 86400,       toleranceSec: 12 * 3600 },
  'trigger-quarterly-audits':{ intervalSec: 86400,       toleranceSec: 12 * 3600 },
  'process-audit-queue':     { intervalSec: 1800,        toleranceSec: 3 * 3600 },
  'check-surge-blocks':      { intervalSec: 3600,        toleranceSec: 3 * 3600 },
  'process-scheduled-sends': { intervalSec: 300,         toleranceSec: 60 * 60 },
  'process-batch-pages':     { intervalSec: 300,         toleranceSec: 60 * 60 },
  'cleanup-rate-limits':     { intervalSec: 86400,       toleranceSec: 12 * 3600 },
  'sync-attribution-sheets': { intervalSec: 30 * 86400,  toleranceSec: 5 * 86400 },
  'backfill-gbp-daily':      { intervalSec: 86400,       toleranceSec: 12 * 3600 }
};

module.exports = async function handler(req, res) {
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var runId = await cronRuns.start('cron-heartbeat-check');

  try {
    var cronNames = Object.keys(EXPECTED);
    var now = Date.now();
    var report = { healthy: 0, stale: 0, never_run: 0, details: [] };

    for (var i = 0; i < cronNames.length; i++) {
      var name = cronNames[i];
      var cfg = EXPECTED[name];

      // Fetch most recent successful completion for this cron.
      var lastRuns = await sb.query(
        'cron_runs?cron_name=eq.' + encodeURIComponent(name) +
        '&status=eq.success&order=completed_at.desc&limit=1' +
        '&select=completed_at,started_at'
      );
      var last = (lastRuns && lastRuns[0]) || null;

      if (!last) {
        // No successful run ever recorded. Could be brand-new cron or a
        // systemic failure. Alert once, but don't spam — the alert happens
        // every time this heartbeat fires until a success lands.
        report.never_run++;
        report.details.push({ cron: name, status: 'never_run' });
        await monitor.critical('cron-heartbeat-check', new Error(
          'Cron has never completed successfully: ' + name
        ), {
          detail: { cron: name, expected_interval_sec: cfg.intervalSec }
        });
        continue;
      }

      var lastCompletedMs = new Date(last.completed_at).getTime();
      var gapSec = Math.floor((now - lastCompletedMs) / 1000);
      var allowedSec = cfg.intervalSec + cfg.toleranceSec;

      if (gapSec > allowedSec) {
        report.stale++;
        report.details.push({
          cron: name,
          status: 'stale',
          gap_sec: gapSec,
          allowed_sec: allowedSec,
          last_completed_at: last.completed_at
        });
        await monitor.critical('cron-heartbeat-check', new Error(
          'Cron is stale: ' + name + ' last succeeded ' + Math.floor(gapSec / 3600) + 'h ago (allowed ' + Math.floor(allowedSec / 3600) + 'h)'
        ), {
          detail: {
            cron: name,
            gap_sec: gapSec,
            allowed_sec: allowedSec,
            last_completed_at: last.completed_at,
            expected_interval_sec: cfg.intervalSec
          }
        });
      } else {
        report.healthy++;
        report.details.push({
          cron: name,
          status: 'healthy',
          gap_sec: gapSec
        });
      }
    }

    await cronRuns.finish(runId, 'success', { detail: report });
    return res.status(200).json(report);
  } catch (err) {
    await cronRuns.finish(runId, 'error', { error: err });
    monitor.logError('cron/cron-heartbeat-check', err, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Heartbeat check failed' });
  }
};

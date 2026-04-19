// api/_lib/cron-runs.js
// Helpers for cron observability (audit Decision #4). Each cron handler
// calls startRun at the top and finishRun before every return path.
//
// Usage:
//   var cronRuns = require('./_lib/cron-runs');
//   module.exports = async function handler(req, res) {
//     var user = await auth.requireAdminOrInternal(req, res);
//     if (!user) return;
//
//     var runId = await cronRuns.start('process-queue');
//     try {
//       ... work ...
//       await cronRuns.finish(runId, 'success', { detail: { processed: n } });
//       return res.status(200).json({...});
//     } catch (err) {
//       await cronRuns.finish(runId, 'error', { error: err });
//       throw err;
//     }
//   };
//
// Both helpers are fault-tolerant: a Supabase outage that prevents logging
// never blocks the cron itself. They log to Vercel stdout on failure so the
// outage surfaces in logs.

var sb = require('./supabase');

async function start(cronName, snapshot) {
  try {
    var row = {
      cron_name: cronName,
      status: 'running'
    };
    if (snapshot && typeof snapshot === 'object') {
      if (snapshot.queue_depth != null) row.queue_depth = snapshot.queue_depth;
      if (snapshot.oldest_item_age_sec != null) row.oldest_item_age_sec = snapshot.oldest_item_age_sec;
    }
    var rows = await sb.mutate('cron_runs', 'POST', row);
    return (Array.isArray(rows) && rows[0] && rows[0].id) ? rows[0].id : null;
  } catch (e) {
    console.error('cron-runs.start failed for ' + cronName + ': ' + (e && e.message ? e.message : ''));
    return null;
  }
}

async function finish(runId, status, opts) {
  if (!runId) return;
  opts = opts || {};
  try {
    var patch = {
      completed_at: new Date().toISOString(),
      status: status || 'success'
    };
    if (opts.error) {
      var msg = opts.error instanceof Error ? opts.error.message : String(opts.error);
      patch.error = msg.substring(0, 1000);
    }
    if (opts.queue_depth != null) patch.queue_depth = opts.queue_depth;
    if (opts.oldest_item_age_sec != null) patch.oldest_item_age_sec = opts.oldest_item_age_sec;
    if (opts.detail) patch.detail = opts.detail;
    await sb.mutate('cron_runs?id=eq.' + runId, 'PATCH', patch, 'return=minimal');
  } catch (e) {
    console.error('cron-runs.finish failed: ' + (e && e.message ? e.message : ''));
  }
}

// Wrap a cron handler so that every invocation is automatically tracked.
// Writes a cron_runs row at start and updates it in a finally block,
// regardless of which path the handler returned through. Failures from
// cron_runs itself never propagate — observability should not block work.
//
// Auth-failure invocations (401) are logged as 'error' runs. In practice
// Vercel's signed CRON_SECRET header means that only occurs for an
// adversary, which is data worth having anyway.
function withTracking(name, innerHandler) {
  return async function wrapped(req, res) {
    var runId = await start(name);
    var capturedErr = null;
    try {
      return await innerHandler(req, res);
    } catch (e) {
      capturedErr = e;
      throw e;
    } finally {
      if (runId) {
        var status = capturedErr
          ? 'error'
          : (res.statusCode && res.statusCode >= 400 ? 'error' : 'success');
        await finish(runId, status, { error: capturedErr });
      }
    }
  };
}

module.exports = { start: start, finish: finish, withTracking: withTracking };

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

// Non-terminal PATCH for in-progress telemetry (queue_depth, oldest age).
// Called by a handler before its main work so the cron_runs row reflects
// the queue snapshot at start. Wrapper's finish() does not overwrite these
// fields unless explicitly passed new values, so the snapshot survives.
async function snapshot(runId, opts) {
  if (!runId || !opts) return;
  try {
    var patch = {};
    if (opts.queue_depth != null) patch.queue_depth = opts.queue_depth;
    if (opts.oldest_item_age_sec != null) patch.oldest_item_age_sec = opts.oldest_item_age_sec;
    if (opts.detail) patch.detail = opts.detail;
    if (Object.keys(patch).length === 0) return;
    await sb.mutate('cron_runs?id=eq.' + runId, 'PATCH', patch, 'return=minimal');
  } catch (e) {
    console.error('cron-runs.snapshot failed: ' + (e && e.message ? e.message : ''));
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
    // Expose to the inner handler so it can emit mid-run telemetry via
    // cronRuns.snapshot(req._cronRunId, { queue_depth, oldest_item_age_sec }).
    if (req) req._cronRunId = runId;

    // Capture response body on >=400 so that handlers which catch their own
    // exceptions and return 500 still propagate a useful error string into
    // cron_runs.error (previously this column was null whenever the inner
    // handler swallowed its exception — the common case). The wrapper only
    // intercepts res.json() since every cron's 4xx/5xx path uses it.
    var capturedBody = null;
    if (res && typeof res.json === 'function') {
      var origJson = res.json.bind(res);
      res.json = function(body) {
        try {
          if (res.statusCode >= 400) capturedBody = body;
        } catch (e) { /* never block the response */ }
        return origJson(body);
      };
    }

    var capturedErr = null;
    try {
      return await innerHandler(req, res);
    } catch (e) {
      capturedErr = e;
      throw e;
    } finally {
      if (runId) {
        var isError = !!capturedErr || (res && res.statusCode >= 400);
        var status = isError ? 'error' : 'success';
        var errForFinish = capturedErr;
        // No thrown exception but handler responded with >=400 — synthesize
        // a diagnostic string from the response body so cron_runs.error is
        // populated (matches the prior behavior's intent, fixes null-error
        // rows observed for process-audit-queue on 2026-04-21).
        if (!errForFinish && isError) {
          var summary = 'HTTP ' + (res.statusCode || '?');
          if (capturedBody && typeof capturedBody === 'object') {
            if (capturedBody.error) summary += ': ' + String(capturedBody.error).substring(0, 300);
            else if (capturedBody.message) summary += ': ' + String(capturedBody.message).substring(0, 300);
          } else if (typeof capturedBody === 'string') {
            summary += ': ' + capturedBody.substring(0, 300);
          }
          errForFinish = new Error(summary);
        }
        await finish(runId, status, { error: errForFinish });
      }
    }
  };
}

module.exports = {
  start: start,
  snapshot: snapshot,
  finish: finish,
  withTracking: withTracking
};

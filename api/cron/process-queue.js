// /api/cron/process-queue.js - Process next pending report from queue
// Called every 5 minutes by Vercel Cron, or manually
// Picks ONE pending item where scheduled_for <= now, compiles it

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;


  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  try {
    // Atomic claim via RPC (see migrations/2026-04-19-queue-claim-rpcs.sql).
    // Returns 0 or 1 rows. FOR UPDATE SKIP LOCKED in the RPC prevents two
    // overlapping cron invocations from claiming the same row and doing the
    // same Anthropic compile twice.
    var claimed = await sb.mutate('rpc/claim_next_report_queue', 'POST', {});

    if (!claimed || !Array.isArray(claimed) || claimed.length === 0) {
      return res.status(200).json({ success: true, message: 'No pending items ready to process', processed: 0 });
    }

    var item = claimed[0];

    // Call compile-report via custom domain (VERCEL_URL is behind deployment protection)
    var baseUrl = 'https://clients.moonraker.ai';

    var compileResp = await fetch(baseUrl + '/api/compile-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '') },
      body: JSON.stringify({
        client_slug: item.client_slug,
        report_month: item.report_month
      }),
      signal: AbortSignal.timeout(280000) // 280s timeout (under Vercel's 300s limit)
    });

    var compileText = await compileResp.text();
    var compileResult;
    try {
      compileResult = JSON.parse(compileText);
    } catch (e) {
      // Non-JSON response (HTML error page, timeout, etc.)
      var errorMsg = 'Compile returned non-JSON (HTTP ' + compileResp.status + '): ' + compileText.substring(0, 200);
      await sb.mutate('report_queue?id=eq.' + item.id, 'PATCH', {
        status: 'failed', completed_at: new Date().toISOString(), error_message: errorMsg
      });
      return res.status(200).json({ success: false, processed: 1, client_slug: item.client_slug, error: errorMsg });
    }

    if (compileResult.success) {
      // Mark complete
      await sb.mutate('report_queue?id=eq.' + item.id, 'PATCH', {
        status: 'complete',
        completed_at: new Date().toISOString(),
        snapshot_id: compileResult.snapshot_id || null,
        error_message: null
      });

      return res.status(200).json({
        success: true,
        processed: 1,
        client_slug: item.client_slug,
        report_month: item.report_month,
        snapshot_id: compileResult.snapshot_id,
        compile_time: compileResult.compile_time || null,
        warnings: compileResult.warnings || []
      });
    } else {
      // Mark failed
      var errorMsg = compileResult.error || compileResult.errors?.join('; ') || 'Unknown compile error';
      await sb.mutate('report_queue?id=eq.' + item.id, 'PATCH', {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: errorMsg
      });

      return res.status(200).json({
        success: false,
        processed: 1,
        client_slug: item.client_slug,
        report_month: item.report_month,
        error: errorMsg,
        warnings: compileResult.warnings || []
      });
    }

  } catch (err) {
    monitor.logError('cron/process-queue', err, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Queue processing failed' });
  }
}

module.exports = cronRuns.withTracking('process-queue', handler);

// /api/cron/enqueue-reports.js - Enqueue monthly report compilations
// Called by Vercel Cron on 1st of month, or manually from admin
// Staggers compilations 3 minutes apart to avoid API rate limits

var sb = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Vercel cron sends CRON_SECRET, manual calls use same secret
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    var auth = req.headers['authorization'];
    var querySecret = req.query && req.query.secret;
    if (auth !== 'Bearer ' + cronSecret && querySecret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }


  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var headers = sb.headers('return=representation');

  try {
    // Determine report month (default: PREVIOUS month since cron runs on the 1st)
    var now = new Date();
    var reportMonth;
    if (req.query && req.query.month) {
      reportMonth = req.query.month;
    } else {
      var prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      reportMonth = prev.getUTCFullYear() + '-' + String(prev.getUTCMonth() + 1).padStart(2, '0') + '-01';
    }

    var dryRun = req.query && req.query.dry_run === 'true';

    // Fetch all active report configs
    var configResp = await fetch(sb.url() + '/rest/v1/report_configs?active=eq.true&select=client_slug,gsc_property', {
      headers: sb.headers()
    });
    var configs = await configResp.json();

    if (!configs || configs.length === 0) {
      return res.status(200).json({ success: true, message: 'No active report configs found', queued: 0 });
    }

    // Check which clients already have a queue entry for this month
    var existingResp = await fetch(sb.url() + '/rest/v1/report_queue?report_month=eq.' + reportMonth + '&select=client_slug,status', {
      headers: sb.headers()
    });
    var existing = await existingResp.json();
    var existingMap = {};
    if (existing && Array.isArray(existing)) {
      existing.forEach(function(e) { existingMap[e.client_slug] = e.status; });
    }

    // Build queue entries, staggered 3 minutes apart
    var baseTime = new Date();
    var queued = [];
    var skipped = [];
    var staggerMinutes = 3;

    configs.forEach(function(cfg, idx) {
      if (existingMap[cfg.client_slug]) {
        skipped.push({ slug: cfg.client_slug, reason: 'already queued (' + existingMap[cfg.client_slug] + ')' });
        return;
      }
      var scheduledFor = new Date(baseTime.getTime() + idx * staggerMinutes * 60 * 1000);
      queued.push({
        client_slug: cfg.client_slug,
        report_month: reportMonth,
        status: 'pending',
        scheduled_for: scheduledFor.toISOString(),
        attempt: 0
      });
    });

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dry_run: true,
        report_month: reportMonth,
        total_configs: configs.length,
        would_queue: queued.length,
        would_skip: skipped.length,
        queue_preview: queued.map(function(q) { return { slug: q.client_slug, scheduled_for: q.scheduled_for }; }),
        skipped: skipped
      });
    }

    // Insert queue entries
    var inserted = 0;
    if (queued.length > 0) {
      var insertResp = await fetch(sb.url() + '/rest/v1/report_queue', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(queued)
      });
      if (insertResp.ok) {
        var result = await insertResp.json();
        inserted = Array.isArray(result) ? result.length : queued.length;
      } else {
        var errText = await insertResp.text();
        return res.status(500).json({ error: 'Failed to insert queue entries', detail: errText });
      }
    }

    return res.status(200).json({
      success: true,
      report_month: reportMonth,
      total_configs: configs.length,
      queued: inserted,
      skipped: skipped.length,
      skipped_details: skipped,
      first_scheduled: queued.length > 0 ? queued[0].scheduled_for : null,
      last_scheduled: queued.length > 0 ? queued[queued.length - 1].scheduled_for : null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


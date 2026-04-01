// /api/cron/enqueue-reports.js - Enqueue monthly report compilations
// Called by Vercel Cron on 1st of month, or manually from admin
// Staggers compilations 3 minutes apart to avoid API rate limits

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

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var headers = {
    'apikey': serviceKey,
    'Authorization': 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    // Determine report month (default: current month's 1st)
    var now = new Date();
    var reportMonth = req.query && req.query.month
      ? req.query.month
      : now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';

    var dryRun = req.query && req.query.dry_run === 'true';

    // Fetch all active report configs
    var configResp = await fetch(sbUrl + '/rest/v1/report_configs?active=eq.true&select=client_slug,gsc_property', {
      headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey }
    });
    var configs = await configResp.json();

    if (!configs || configs.length === 0) {
      return res.status(200).json({ success: true, message: 'No active report configs found', queued: 0 });
    }

    // Check which clients already have a queue entry for this month
    var existingResp = await fetch(sbUrl + '/rest/v1/report_queue?report_month=eq.' + reportMonth + '&select=client_slug,status', {
      headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey }
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
      var insertResp = await fetch(sbUrl + '/rest/v1/report_queue', {
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

// /api/seed-batch-audits.js
// One-time admin route to seed entity audits for all active clients.
// - Clients WITH a recent initial audit (within 30 days): adopts as baseline
// - Clients WITHOUT an audit: creates a new entity_audit row with status 'queued'
// - Sets next_audit_due for everyone (3 months out)
// - The process-audit-queue cron will pick up queued audits every 15 min
//
// POST { dry_run: true|false }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var dryRun = (req.body || {}).dry_run !== false;

  try {
    // Get all active clients without a next_audit_due (not yet scheduled)
    var clients = await sb.query(
      'contacts?status=eq.active&next_audit_due=is.null' +
      '&select=id,slug,first_name,last_name,practice_name,website_url,city,state_province,campaign_type' +
      '&order=slug.asc'
    );

    if (!clients || clients.length === 0) {
      return res.status(200).json({ message: 'No unscheduled active clients found.', count: 0 });
    }

    var threeMothsOut = new Date();
    threeMothsOut.setMonth(threeMothsOut.getMonth() + 3);
    var nextDue = threeMothsOut.toISOString().split('T')[0];

    var thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    var cutoff = thirtyDaysAgo.toISOString().split('T')[0];

    var adopted = [];
    var queued = [];
    var errors = [];

    for (var i = 0; i < clients.length; i++) {
      var c = clients[i];
      var brandQuery = c.practice_name || (c.first_name + ' ' + c.last_name);
      var geoTarget = '';
      if (c.city || c.state_province) {
        geoTarget = (c.city || '') + (c.city && c.state_province ? ', ' : '') + (c.state_province || '');
      }

      try {
        // Check for recent initial audit
        var recentAudits = await sb.query(
          'entity_audits?contact_id=eq.' + c.id +
          '&audit_period=eq.initial&audit_date=gte.' + cutoff +
          '&status=in.(complete,delivered)' +
          '&select=id,audit_date,cres_score' +
          '&order=audit_date.desc&limit=1'
        );

        if (recentAudits && recentAudits.length > 0) {
          // Adopt as baseline
          if (!dryRun) {
            await sb.mutate('entity_audits?id=eq.' + recentAudits[0].id, 'PATCH', {
              audit_period: 'baseline'
            }, 'return=minimal');
            await sb.mutate('contacts?id=eq.' + c.id, 'PATCH', {
              next_audit_due: nextDue
            }, 'return=minimal');
          }
          adopted.push({ slug: c.slug, audit_id: recentAudits[0].id, cres: recentAudits[0].cres_score });
        } else {
          // Create new queued audit
          if (!dryRun) {
            var auditRows = await sb.mutate('entity_audits', 'POST', {
              contact_id: c.id,
              client_slug: c.slug,
              audit_tier: 'none',
              brand_query: brandQuery,
              homepage_url: c.website_url,
              status: 'queued',
              audit_period: 'baseline',
              audit_scope: 'homepage',
              geo_target: geoTarget || null
            });
            await sb.mutate('contacts?id=eq.' + c.id, 'PATCH', {
              next_audit_due: nextDue
            }, 'return=minimal');
            queued.push({ slug: c.slug, audit_id: auditRows[0].id });
          } else {
            queued.push({ slug: c.slug, audit_id: '(dry_run)' });
          }
        }
      } catch (clientErr) {
        errors.push({ slug: c.slug, error: clientErr.message });
      }
    }

    return res.status(200).json({
      dry_run: dryRun,
      total_clients: clients.length,
      adopted: adopted.length,
      queued: queued.length,
      errors: errors.length,
      next_audit_due: nextDue,
      details: {
        adopted: adopted,
        queued: queued,
        errors: errors
      },
      message: dryRun
        ? 'Dry run complete. POST with { "dry_run": false } to execute.'
        : adopted.length + ' audits adopted as baseline, ' + queued.length + ' queued for processing.'
    });

  } catch (err) {
    console.error('seed-batch-audits error:', err);
    return res.status(500).json({ error: err.message });
  }
};

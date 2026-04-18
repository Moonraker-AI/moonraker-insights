// /api/cron/trigger-quarterly-audits.js
// Runs daily. Finds active clients where next_audit_due <= today,
// creates entity_audit rows in 'queued' status, bumps next_audit_due by 3 months,
// and sends a single consolidated team notification.
//
// NOTE: This cron does NOT dispatch to the agent directly. It only inserts rows
// as 'queued'. The process-audit-queue cron handles dispatch one at a time
// to avoid overwhelming the agent with concurrent browser sessions.
//
// Vercel cron: daily at 7:00 AM ET (11:00 UTC)

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

module.exports = async function handler(req, res) {
  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var resendKey = process.env.RESEND_API_KEY;

  try {
    // Find active clients with audits due today or earlier
    var today = new Date().toISOString().split('T')[0];
    var dueClients = await sb.query(
      'contacts?status=eq.active&next_audit_due=lte.' + today +
      '&quarterly_audits_enabled=eq.true' +
      '&select=id,slug,first_name,last_name,practice_name,website_url,email,city,state_province,next_audit_due' +
      '&order=next_audit_due.asc&limit=20'
    );

    if (!dueClients || dueClients.length === 0) {
      return res.status(200).json({ message: 'No quarterly audits due today.', triggered: 0 });
    }

    var results = [];

    for (var i = 0; i < dueClients.length; i++) {
      var contact = dueClients[i];
      var result = { slug: contact.slug, name: contact.practice_name || (contact.first_name + ' ' + contact.last_name) };

      try {
        // Determine audit_period label based on previous audits
        var prevAudits = await sb.query(
          'entity_audits?contact_id=eq.' + contact.id +
          '&select=id,audit_period,audit_date,cres_score&order=audit_date.desc&limit=1'
        );
        var prevAudit = prevAudits && prevAudits.length > 0 ? prevAudits[0] : null;

        // Calculate period label: months since first audit
        var allAudits = await sb.query(
          'entity_audits?contact_id=eq.' + contact.id +
          '&select=audit_date&order=audit_date.asc&limit=1'
        );
        var firstAuditDate = allAudits && allAudits.length > 0 ? new Date(allAudits[0].audit_date) : new Date();
        var monthsSinceFirst = Math.round((new Date() - firstAuditDate) / (1000 * 60 * 60 * 24 * 30.44));
        var nearestQuarter = Math.max(3, Math.round(monthsSinceFirst / 3) * 3);
        var auditPeriod = 'month_' + nearestQuarter;

        var brandQuery = contact.practice_name || (contact.first_name + ' ' + contact.last_name);
        var geoTarget = '';
        if (contact.city || contact.state_province) {
          geoTarget = (contact.city || '') + (contact.city && contact.state_province ? ', ' : '') + (contact.state_province || '');
        }

        // Create entity_audits row as 'queued' — process-audit-queue will dispatch
        var auditRows = await sb.mutate('entity_audits', 'POST', {
          contact_id: contact.id,
          client_slug: contact.slug,
          audit_tier: 'none',
          brand_query: brandQuery,
          homepage_url: contact.website_url,
          status: 'queued',
          audit_period: auditPeriod,
          audit_scope: 'homepage',
          geo_target: geoTarget || null
        });

        var audit = auditRows[0];
        result.audit_id = audit.id;
        result.period = auditPeriod;
        result.queued = true;

        // Bump next_audit_due by 3 months
        var nextDue = new Date(contact.next_audit_due);
        nextDue.setMonth(nextDue.getMonth() + 3);
        await sb.mutate('contacts?id=eq.' + contact.id, 'PATCH', {
          next_audit_due: nextDue.toISOString().split('T')[0]
        }, 'return=minimal');
        result.next_due = nextDue.toISOString().split('T')[0];
        result.success = true;

      } catch (clientErr) {
        result.success = false;
        result.error = clientErr.message;
      }

      results.push(result);
    }

    // Send consolidated team notification
    var successCount = results.filter(function(r) { return r.success; }).length;
    var failCount = results.length - successCount;

    if (resendKey && results.length > 0) {
      var tableRows = results.map(function(r) {
        var statusBadge = r.success
          ? '<span style="color:#00D47E;">Queued</span>'
          : '<span style="color:#EF4444;">Failed: ' + (r.error || 'Unknown') + '</span>';
        return '<tr><td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">' + r.name + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">' + (r.period || '-') + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">' + statusBadge + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">' + (r.next_due || '-') + '</td></tr>';
      }).join('');

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
          to: ['notifications@clients.moonraker.ai'],
          subject: 'Quarterly Audits Queued: ' + successCount + ' clients',
          html: '<div style="font-family:Inter,sans-serif;max-width:600px;">' +
            '<h2 style="font-family:Outfit,sans-serif;color:#1E2A5E;">Quarterly Entity Audits</h2>' +
            '<p>' + successCount + ' audit' + (successCount !== 1 ? 's' : '') + ' queued for processing' +
            (failCount > 0 ? ', ' + failCount + ' failed' : '') + '.</p>' +
            '<p style="font-size:13px;color:#64748B;">Audits will be processed one at a time by the agent service (approximately 35 minutes each).</p>' +
            '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">' +
            '<thead><tr style="background:#F7FDFB;">' +
            '<th style="padding:8px 12px;text-align:left;font-weight:600;">Client</th>' +
            '<th style="padding:8px 12px;text-align:left;font-weight:600;">Period</th>' +
            '<th style="padding:8px 12px;text-align:left;font-weight:600;">Status</th>' +
            '<th style="padding:8px 12px;text-align:left;font-weight:600;">Next Due</th></tr></thead>' +
            '<tbody>' + tableRows + '</tbody></table>' +
            '<p style="margin-top:16px;"><a href="https://clients.moonraker.ai/admin/audits" style="color:#00D47E;">View in Admin</a></p>' +
            '</div>'
        })
      });
    }

    return res.status(200).json({
      message: successCount + ' quarterly audit(s) queued, ' + failCount + ' failed.',
      queued: successCount,
      failed: failCount,
      results: results
    });

  } catch (err) {
    console.error('trigger-quarterly-audits error:', err);
    monitor.logError('cron/trigger-quarterly-audits', err, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Quarterly audit trigger failed' });
  }
};

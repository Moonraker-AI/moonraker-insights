/**
 * /api/ingest-cms-scout.js
 * 
 * Callback from the Moonraker Agent after a CMS scout completes.
 * Stores the full report in cms_scouts and updates the contact record.
 * 
 * POST body: { task_id, report }
 * Auth: Agent API key (Bearer token)
 */

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: accept agent key or admin JWT
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body;
  if (!body || !body.task_id || !body.report) {
    return res.status(400).json({ error: 'task_id and report required' });
  }

  try {
    var report = body.report;
    var taskId = body.task_id;

    // Find the scout record by agent_task_id
    var scout = await sb.one('cms_scouts?agent_task_id=eq.' + encodeURIComponent(taskId) + '&select=id,contact_id,client_slug,platform');
    if (!scout) {
      console.warn('ingest-cms-scout: no scout record for task_id=' + taskId);
      return res.status(404).json({ error: 'Scout record not found for task_id: ' + taskId });
    }

    // Build summary line
    var summary = _buildSummary(report, scout.platform);

    // Update the scout record
    await sb.mutate('cms_scouts?id=eq.' + scout.id, 'PATCH', {
      status: 'complete',
      report: report,
      summary: summary,
      scanned_at: report.scanned_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, 'return=minimal');

    // Also update the contact if platform needs correction
    if (report.platform && report.platform !== scout.platform) {
      await sb.mutate('contacts?id=eq.' + scout.contact_id, 'PATCH', {
        website_platform: report.platform
      }, 'return=minimal');
    }

    console.log('CMS scout ingested: ' + scout.client_slug + ' (' + scout.platform + ') - ' + summary);

    return res.json({ success: true, scout_id: scout.id, summary: summary });

  } catch (err) {
    console.error('ingest-cms-scout error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


function _buildSummary(report, platform) {
  var parts = [];

  if (platform === 'wordpress') {
    parts.push('WP ' + (report.wordpress && report.wordpress.version || '?'));
    parts.push('Theme: ' + (report.theme && report.theme.name || '?'));
    parts.push('Builder: ' + (report.page_builder && report.page_builder.name || 'none'));
    parts.push(((report.pages || []).length) + ' pages');
    parts.push(((report.plugins || []).length) + ' plugins');
  } else if (platform === 'squarespace') {
    var si = report.site_info || {};
    parts.push('SQ ' + (si.squarespace_version || '?'));
    parts.push('Template: ' + (si.template_family || si.template_name || '?'));
    parts.push(((report.pages || []).length) + ' pages');
    parts.push(((report.navigation && report.navigation.main_nav || []).length) + ' nav items');
  } else if (platform === 'wix') {
    parts.push('Wix');
    parts.push(((report.pages || []).length) + ' pages');
    parts.push(((report.navigation && report.navigation.main_nav || []).length) + ' nav items');
  }

  // Common fields
  var seo = report.seo || {};
  if (seo.has_schema) parts.push('Schema: yes');
  var cs = report.connected_services || {};
  if (cs.google_analytics) parts.push('GA: yes');
  if (cs.google_tag_manager) parts.push('GTM: yes');
  parts.push('via ' + (report.method || '?'));

  return parts.join(' | ');
}

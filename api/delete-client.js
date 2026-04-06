// /api/delete-client.js
// Fully deletes a client: explicitly deletes all 22 child tables in dependency order,
// then deletes the contact, then removes all GitHub files for the slug.
// All FKs are CASCADE, so the contact delete would cascade anyway, but explicit
// deletion gives us per-table success/failure reporting.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var ghToken = process.env.GITHUB_PAT;
  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var slug = body.slug;
  var contactId = body.contact_id;

  if (!slug || !contactId) return res.status(400).json({ error: 'slug and contact_id required' });

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';
  var results = { supabase: [], github: [] };

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
  }

  try {
    // ============================================================
    // STEP 1: Cascade delete Supabase tables
    // ============================================================
    // All child tables in dependency order. Most have CASCADE FKs now,
    // but explicit deletion is belt-and-suspenders for safety.
    // Key ordering: audit_followups before entity_audits,
    //   proposals before contacts (proposal_followups cascade from proposals),
    //   report_queue before report_snapshots.
    var tables = [
      { table: 'activity_log', filter: 'contact_id=eq.' + contactId },
      { table: 'audit_followups', filter: 'contact_id=eq.' + contactId },
      { table: 'entity_audits', filter: 'contact_id=eq.' + contactId },
      { table: 'proposals', filter: 'contact_id=eq.' + contactId },
      { table: 'intro_call_steps', filter: 'contact_id=eq.' + contactId },
      { table: 'onboarding_steps', filter: 'contact_id=eq.' + contactId },
      { table: 'bio_materials', filter: 'contact_id=eq.' + contactId },
      { table: 'social_profiles', filter: 'contact_id=eq.' + contactId },
      { table: 'signed_agreements', filter: 'contact_id=eq.' + contactId },
      { table: 'practice_details', filter: 'contact_id=eq.' + contactId },
      { table: 'account_access', filter: 'contact_id=eq.' + contactId },
      { table: 'scheduled_touchpoints', filter: 'contact_id=eq.' + contactId },
      { table: 'payments', filter: 'contact_id=eq.' + contactId },
      { table: 'performance_guarantees', filter: 'contact_id=eq.' + contactId },
      { table: 'deliverables', filter: 'contact_id=eq.' + contactId },
      { table: 'tracked_keywords', filter: 'contact_id=eq.' + contactId },
      { table: 'checklist_items', filter: 'client_slug=eq.' + slug },
      { table: 'audit_scores', filter: 'client_slug=eq.' + slug },
      { table: 'report_queue', filter: 'client_slug=eq.' + slug },
      { table: 'report_snapshots', filter: 'client_slug=eq.' + slug },
      { table: 'report_highlights', filter: 'client_slug=eq.' + slug },
      { table: 'report_configs', filter: 'client_slug=eq.' + slug }
    ];

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var delResp = await fetch(sbUrl + '/rest/v1/' + t.table + '?' + t.filter, {
        method: 'DELETE',
        headers: sbHeaders()
      });
      results.supabase.push({ table: t.table, ok: delResp.ok });
    }

    // Delete the contact itself
    var contactDel = await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + contactId, {
      method: 'DELETE',
      headers: sbHeaders()
    });
    results.supabase.push({ table: 'contacts', ok: contactDel.ok });

    // ============================================================
    // STEP 2: Delete all GitHub files under the slug directory
    // ============================================================
    var ghHeaders = {
      'Authorization': 'Bearer ' + ghToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // Get the full repo tree to find all files under this slug
    var treeResp = await fetch('https://api.github.com/repos/' + REPO + '/git/trees/' + BRANCH + '?recursive=1', {
      headers: ghHeaders
    });

    if (treeResp.ok) {
      var treeData = await treeResp.json();
      var slugFiles = (treeData.tree || []).filter(function(item) {
        return item.type === 'blob' && item.path.startsWith(slug + '/');
      });

      // Delete each file (requires getting current SHA for each)
      for (var j = 0; j < slugFiles.length; j++) {
        var filePath = slugFiles[j].path;

        // Get current SHA
        var fileResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + filePath + '?ref=' + BRANCH, {
          headers: ghHeaders
        });

        if (fileResp.ok) {
          var fileData = await fileResp.json();
          var deleteResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + filePath, {
            method: 'DELETE',
            headers: ghHeaders,
            body: JSON.stringify({
              message: 'Delete ' + filePath + ' (client removed)',
              sha: fileData.sha,
              branch: BRANCH
            })
          });
          results.github.push({ path: filePath, ok: deleteResp.ok });
        }
      }

      if (slugFiles.length === 0) {
        results.github.push({ path: slug + '/', ok: true, note: 'No files found' });
      }
    } else {
      results.github.push({ error: 'Failed to read repo tree' });
    }

    return res.status(200).json({
      success: true,
      results: results,
      deleted_supabase_tables: results.supabase.filter(function(r) { return r.ok; }).length,
      deleted_github_files: results.github.filter(function(r) { return r.ok; }).length
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, results: results });
  }
};


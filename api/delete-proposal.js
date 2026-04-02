// /api/delete-proposal.js
// Deletes a proposal record and optionally removes deployed pages from GitHub.
//
// POST { proposal_id, delete_pages?: true }
//   - delete_pages: if true, removes /proposal, /checkout, /onboarding, and router pages
//
// ENV VARS: SUPABASE_SERVICE_ROLE_KEY, GITHUB_PAT

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var ghToken = process.env.GITHUB_PAT;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body || {};
  var proposalId = body.proposal_id;
  var deletePages = body.delete_pages !== false; // default true

  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';
  var results = { supabase: null, github: [] };

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
  }
  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + ghToken, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' };
  }

  // Load proposal + contact
  var proposal, contact;
  try {
    var pResp = await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId + '&select=*,contacts(id,slug,status)&limit=1', { headers: sbHeaders() });
    var proposals = await pResp.json();
    if (!proposals || proposals.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    proposal = proposals[0];
    contact = proposal.contacts;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load proposal: ' + e.message });
  }

  var slug = contact.slug;

  // Delete deployed pages from GitHub
  if (deletePages && ghToken && slug) {
    var pagesToDelete = [
      slug + '/proposal/index.html',
      slug + '/checkout/index.html',
      slug + '/onboarding/index.html',
      slug + '/index.html'
    ];

    for (var path of pagesToDelete) {
      try {
        // Get file SHA
        var fileResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + path + '?ref=' + BRANCH, { headers: ghHeaders() });
        if (!fileResp.ok) {
          results.github.push({ path: path, ok: false, error: 'Not found' });
          continue;
        }
        var fileData = await fileResp.json();
        var fileSha = fileData.sha;

        // Delete file
        var delResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + path, {
          method: 'DELETE',
          headers: ghHeaders(),
          body: JSON.stringify({
            message: 'Delete ' + path + ' (proposal deleted)',
            sha: fileSha,
            branch: BRANCH
          })
        });
        results.github.push({ path: path, ok: delResp.ok });
      } catch (e) {
        results.github.push({ path: path, ok: false, error: e.message });
      }
    }
  }

  // Delete proposal from Supabase
  try {
    var delResp = await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId, {
      method: 'DELETE',
      headers: sbHeaders()
    });
    results.supabase = delResp.ok ? 'deleted' : 'failed';
  } catch (e) {
    results.supabase = 'error: ' + e.message;
  }

  // Reset contact status back to lead if they were only a prospect because of this proposal
  // Check if there are other proposals for this contact
  try {
    var otherResp = await fetch(sbUrl + '/rest/v1/proposals?contact_id=eq.' + contact.id + '&select=id&limit=1', { headers: sbHeaders() });
    var others = await otherResp.json();
    if ((!others || others.length === 0) && contact.status === 'prospect') {
      await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + contact.id, {
        method: 'PATCH',
        headers: { ...sbHeaders(), 'Prefer': 'return=representation' },
        body: JSON.stringify({ status: 'lead' })
      });
      results.contact_reset = 'lead';
    }
  } catch (e) { /* optional */ }

  return res.status(200).json({ ok: true, results: results });
};

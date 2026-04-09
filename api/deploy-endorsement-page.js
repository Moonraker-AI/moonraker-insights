// /api/deploy-endorsement-page.js
// Deploys the endorsement collection page for a client.
// The template has no placeholders (reads slug from URL at runtime).
// Simply reads _templates/endorsements.html and pushes to /{slug}/endorsements/index.html

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var ghToken = process.env.GITHUB_PAT;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });

  var slug = req.body && req.body.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';
  function ghHeaders() { return { 'Authorization': 'Bearer ' + ghToken, 'Accept': 'application/vnd.github+json' }; }

  try {
    // Read template
    var tResp = await fetch(
      'https://api.github.com/repos/' + REPO + '/contents/_templates/endorsements.html?ref=' + BRANCH,
      { headers: ghHeaders() }
    );
    if (!tResp.ok) return res.status(500).json({ error: 'Failed to read template: ' + tResp.status });
    var tData = await tResp.json();
    var html = Buffer.from(tData.content, 'base64').toString('utf-8');

    // Check if already deployed
    var destPath = slug + '/endorsements/index.html';
    var existResp = await fetch(
      'https://api.github.com/repos/' + REPO + '/contents/' + destPath + '?ref=' + BRANCH,
      { headers: ghHeaders() }
    );
    var existSha = null;
    if (existResp.ok) {
      existSha = (await existResp.json()).sha;
    }

    // Push
    var pushBody = {
      message: 'Deploy endorsement page for ' + slug,
      content: Buffer.from(html, 'utf-8').toString('base64'),
      branch: BRANCH
    };
    if (existSha) pushBody.sha = existSha;

    var pushResp = await fetch(
      'https://api.github.com/repos/' + REPO + '/contents/' + destPath,
      { method: 'PUT', headers: Object.assign({}, ghHeaders(), { 'Content-Type': 'application/json' }), body: JSON.stringify(pushBody) }
    );

    if (!pushResp.ok) {
      var err = await pushResp.text();
      return res.status(500).json({ error: 'GitHub push failed', detail: err.substring(0, 500) });
    }

    return res.status(200).json({
      success: true,
      url: 'https://clients.moonraker.ai/' + slug + '/endorsements/',
      path: destPath
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// /api/deploy-endorsement-page.js
// Deploys the endorsement collection page for a client.
// The template has no placeholders (reads slug from URL at runtime).
// Simply reads _templates/endorsements.html and pushes to /{slug}/endorsements/index.html

var gh = require('./_lib/github');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!gh.isConfigured()) return res.status(500).json({ error: 'GITHUB_PAT not configured' });

  var slug = req.body && req.body.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  try {
    var html = await gh.readTemplate('endorsements.html');
    var destPath = slug + '/endorsements/index.html';
    await gh.pushFile(destPath, html, 'Deploy endorsement page for ' + slug);

    return res.status(200).json({
      success: true,
      url: 'https://clients.moonraker.ai/' + slug + '/endorsements/',
      path: destPath
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// /api/deploy-endorsement-page.js
// "Activates" the endorsement collection page for a client.
//
// 2026-04-23: This route used to push a per-client copy of
// _templates/endorsements.html to /<slug>/endorsements/index.html. The
// template has hydrated from /api/public-contact + the cookie-based
// page-token flow since C6, so the per-client copy was a byte-for-byte
// shadow of the live template — which beat the Vercel rewrite for
// /:slug/endorsements -> /_templates/endorsements and silently masked
// future template edits.
//
// Now: the page is always live at /<slug>/endorsements via the rewrite.
// This route stays as the admin "activate" button surface (admin/clients/
// index.html L6044) — it validates the contact exists and returns the
// public URL. No file write.
//
// Response shape unchanged: { success, url, path, contact_id }.

var auth    = require('./_lib/auth');
var sb      = require('./_lib/supabase');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  var slug = req.body && req.body.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  try {
    var contact = await sb.one(
      'contacts?slug=eq.' + encodeURIComponent(slug) +
      '&select=id,slug&limit=1'
    );
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found for slug ' + slug });
    }

    return res.status(200).json({
      success: true,
      url:  'https://clients.moonraker.ai/' + slug + '/endorsements/',
      path: slug + '/endorsements/index.html',
      contact_id: contact.id
    });
  } catch (err) {
    monitor.logError('deploy-endorsement-page', err, {
      client_slug: slug,
      detail: { stage: 'activate_endorsement' }
    });
    return res.status(500).json({ error: 'Failed to activate endorsement page' });
  }
};

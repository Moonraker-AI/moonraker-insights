// /api/endorse-init.js
// Public hydrate endpoint for the per-clinician endorsement collection page.
//
// Resolves /endorse/<client-slug>/<clinician-slug> → returns the practice
// name, clinician name, credentials, and headshot URL, so the form can
// render "Endorse Anna Sky" cleanly. Mints a scoped page-token cookie
// (scope='endorsement') so the subsequent submit + headshot-upload calls
// authenticate via cookie. Same flow as /api/page-token/request, but in
// one call so the front-end doesn't need to make two round-trips.
//
// Public, rate-limited per IP to prevent enumeration.

var sb        = require('./_lib/supabase');
var pageToken = require('./_lib/page-token');
var rateLimit = require('./_lib/rate-limit');
var monitor   = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured())        return res.status(500).json({ error: 'Service unavailable' });
  if (!pageToken.isConfigured()) return res.status(500).json({ error: 'Service unavailable' });

  // Accept slug + clinician via query (GET) or body (POST). Front-end will
  // POST so it can read the JSON response without exposing the URL params
  // in browser history.
  var src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  var slug = String(src.slug || '').trim().toLowerCase();
  var clinician = String(src.clinician || '').trim().toLowerCase();

  if (!/^[a-z0-9-]{1,80}$/.test(slug))      return res.status(400).json({ error: 'Invalid slug' });
  if (!/^[a-z0-9-]{1,80}$/.test(clinician)) return res.status(400).json({ error: 'Invalid clinician slug' });

  // Per-IP rate limit: 30 inits/hour. Generous (a curious endorser refreshing
  // the page a few times shouldn't trip this), tight enough to block scripted
  // enumeration of clinician slugs across practices.
  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  try {
    var rl = await rateLimit.check('endorse-init:ip:' + ip, 30, 3600, { failClosed: false });
    if (rl && rl.allowed === false) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many requests' });
    }
  } catch (_) { /* never hard-fail on rate limiter */ }

  var contact;
  try {
    contact = await sb.one(
      'contacts?slug=eq.' + encodeURIComponent(slug) +
      '&select=id,slug,practice_name,status&limit=1'
    );
  } catch (e) {
    monitor.logError('endorse-init', e, { client_slug: slug, detail: { stage: 'contact_lookup' } });
    return res.status(500).json({ error: 'Lookup failed' });
  }
  if (!contact) return res.status(404).json({ error: 'Practice not found' });
  if (['prospect','onboarding','active'].indexOf(contact.status) === -1) {
    return res.status(403).json({ error: 'Endorsements not enabled for this practice' });
  }

  var bio;
  try {
    bio = await sb.one(
      'bio_materials?contact_id=eq.' + encodeURIComponent(contact.id) +
      '&slug=eq.' + encodeURIComponent(clinician) +
      '&select=id,slug,therapist_name,therapist_credentials,headshot_url&limit=1'
    );
  } catch (e) {
    monitor.logError('endorse-init', e, { client_slug: slug, detail: { stage: 'bio_lookup', clinician: clinician } });
    return res.status(500).json({ error: 'Lookup failed' });
  }
  if (!bio) return res.status(404).json({ error: 'Clinician not found at this practice' });

  // Mint endorsement-scoped cookie. Same machinery as /api/page-token/request.
  var token;
  try {
    token = pageToken.sign({ scope: 'endorsement', contact_id: contact.id });
  } catch (e) {
    monitor.logError('endorse-init', e, { client_slug: slug, detail: { stage: 'sign_token' } });
    return res.status(500).json({ error: 'Token signing failed' });
  }

  var legacyClear = pageToken.buildLegacyPathClearCookie('endorsement', slug);
  var freshSet = pageToken.buildSetCookie('endorsement', slug, token);
  res.setHeader('Set-Cookie', legacyClear ? [legacyClear, freshSet] : [freshSet]);
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json({
    ok: true,
    practice: {
      slug: contact.slug,
      name: contact.practice_name || ''
    },
    clinician: {
      bio_material_id: bio.id,
      slug: bio.slug,
      name: bio.therapist_name || '',
      credentials: bio.therapist_credentials || '',
      headshot_url: bio.headshot_url || ''
    }
  });
};

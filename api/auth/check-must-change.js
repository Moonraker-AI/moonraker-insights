// api/auth/check-must-change.js
// Server-side lookup of the authenticated admin's own admin_profiles row.
//
// Why this endpoint exists:
//   Before this migration, admin/login/index.html issued two direct GETs
//   against `admin_profiles` using the user's own Supabase JWT as Bearer,
//   relying on table RLS to scope rows. Routing through the server strips
//   that dependency: we lookup with service-role against a specific id
//   (the JWT's sub claim), and return ONLY a fixed 4-field projection.
//   A future RLS misconfiguration can't leak other admins' rows or surface
//   columns we don't intend to expose.
//
// Method:   GET  (405 otherwise, with Allow header)
// Auth:     requireAdmin — valid admin JWT cookie required
// Body:     none
// Returns:  200 { must_change_password: boolean,
//                 role: string,
//                 display_name: string,
//                 email: string }
//           401/403                       from requireAdmin
//           404 { error: 'Profile not found' }         row missing
//           429 { error: 'Too many requests' }         rate-limit
//           500 { error: 'Profile lookup failed' }     generic
//
// Security posture:
//   - Rate limited to 30/60s per admin user (same-user bucket key via
//     user.id so quota isn't shared across admins behind one NAT).
//   - Response is a fixed projection. Never returns other rows — the
//     select path is `id=eq.<user.id>&limit=1`, bound to the verified
//     JWT subject. The id column itself is not echoed back.
//   - 5xx detail goes to monitor.logError; response body is generic.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var rateLimit = require('../_lib/rate-limit');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return; // requireAdmin already wrote 401/403

  // Per-admin bucket: 30 per 60s. Fail-closed — Supabase outages shouldn't
  // leave this endpoint open to abuse, but the limit is generous enough
  // that legitimate page loads and retries stay well under it.
  var rl = await rateLimit.check('admin:' + user.id + ':check-must-change', 30, 60, { failClosed: true });
  rateLimit.setHeaders(res, rl, 30);
  if (!rl.allowed) {
    if (rl.reset_at) {
      var retryAfter = Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
    }
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Never cache — per-user data, and the must_change_password flag may
  // flip immediately after a password rotation on the same session.
  res.setHeader('Cache-Control', 'no-store');

  var profile;
  try {
    profile = await sb.one(
      'admin_profiles?id=eq.' + encodeURIComponent(user.id) +
      '&select=email,display_name,role,must_change_password&limit=1'
    );
  } catch (err) {
    await monitor.logError('auth-check-must-change', err, {
      detail: { stage: 'profile_lookup', user_id: user.id }
    });
    return res.status(500).json({ error: 'Profile lookup failed' });
  }

  if (!profile) {
    // JWT is valid and requireAdmin passed, so a missing row is unexpected
    // (requireAdmin itself checks membership). Log and return a generic
    // 404 rather than leaking schema detail.
    await monitor.logError('auth-check-must-change', new Error('admin_profiles row missing'), {
      detail: { stage: 'profile_lookup', user_id: user.id }
    });
    return res.status(404).json({ error: 'Profile not found' });
  }

  return res.status(200).json({
    must_change_password: profile.must_change_password === true,
    role: typeof profile.role === 'string' ? profile.role : '',
    display_name: typeof profile.display_name === 'string' ? profile.display_name : '',
    email: typeof profile.email === 'string' ? profile.email : ''
  });
};

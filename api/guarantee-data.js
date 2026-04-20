// /api/guarantee-data.js
// Data-fetch endpoint for the client-facing Performance Guarantee signing page.
// Returns { contact, guarantee } when the request carries a valid
// scope='guarantee' page-token cookie and the PG is in a displayable state.
//
// Security model:
//   1. Page-token (scope='guarantee') is the ONLY accepted credential — read
//      from the HttpOnly cookie `mr_pt_guarantee` via pageToken.getTokenFromRequest.
//   2. Verified contact_id is the sole identifier; nothing in the query string
//      or body is trusted.
//   3. `pg.status === 'locked'` is required — draft guarantees are not
//      displayable (clients shouldn't see or sign numbers the admin hasn't
//      locked in yet).
//   4. The contact's own state_gate matches the rest of the PG flow:
//      `['onboarding','active']` AND `lost=false`. Prospects / leads / lost
//      contacts get a 403.
//
// Also reports already_signed=true if a signed_performance_guarantees row
// already exists for this contact. The signing page uses that flag to skip
// directly to the "signed" confirmation view.

var sb        = require('./_lib/supabase');
var pageToken = require('./_lib/page-token');

var CONTACT_COLUMNS = [
  'id',
  'slug',
  'first_name',
  'last_name',
  'credentials',
  'email',
  'practice_name',
  'legal_business_name',
  'plan_tier',
  'plan_type',
  'status',
  'lost'
].join(',');

var PG_COLUMNS = [
  'id',
  'status',
  'locked_at',
  'avg_client_ltv_cents',
  'conversion_rate',
  'attendance_rate',
  'current_monthly_organic_calls',
  'investment_cents',
  'value_per_call_cents',
  'guarantee_calls',
  'total_benchmark'
].join(',');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured())        return res.status(500).json({ error: 'Service not configured' });
  if (!pageToken.isConfigured()) return res.status(500).json({ error: 'Auth not configured' });

  // 1. Verify page-token cookie (scope='guarantee')
  var submittedToken = pageToken.getTokenFromRequest(req, 'guarantee');
  if (!submittedToken) return res.status(403).json({ error: 'Page token required' });

  var tokenData;
  try {
    tokenData = pageToken.verify(submittedToken, 'guarantee');
  } catch (e) {
    console.error('[guarantee-data] page-token verify threw:', e.message);
    return res.status(500).json({ error: 'Auth system unavailable' });
  }
  if (!tokenData) return res.status(403).json({ error: 'Invalid or expired page token' });
  var verifiedContactId = tokenData.contact_id;

  // 2. Fetch contact + PG
  var contact, pg, signedRow;
  try {
    contact = await sb.one(
      'contacts?select=' + CONTACT_COLUMNS +
      '&id=eq.' + encodeURIComponent(verifiedContactId) + '&limit=1'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost) return res.status(403).json({ error: 'Contact is no longer active' });
    if (['onboarding', 'active'].indexOf(contact.status) === -1) {
      return res.status(403).json({ error: 'Contact not in a valid state to view this guarantee' });
    }

    pg = await sb.one(
      'performance_guarantees?select=' + PG_COLUMNS +
      '&contact_id=eq.' + encodeURIComponent(verifiedContactId) + '&limit=1'
    );
    if (!pg) return res.status(404).json({ error: 'No Performance Guarantee exists for this contact' });
    if (pg.status !== 'locked') {
      return res.status(409).json({ error: 'Performance Guarantee is not locked and not yet ready to sign' });
    }

    // 3. Already signed?
    signedRow = await sb.one(
      'signed_performance_guarantees?select=id,signed_at&contact_id=eq.' +
      encodeURIComponent(verifiedContactId) +
      '&superseded_by=is.null&order=signed_at.desc&limit=1'
    );
  } catch (err) {
    console.error('[guarantee-data] lookup failed:', err && err.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }

  // Contact's own columns in the response are the same safe subset that
  // public-contact.js returns — email, practice_name, first_name, last_name
  // are fine to expose since anyone who got the page-token cookie already
  // proved they legitimately requested this slug's page.
  var safeContact = {
    id:                  contact.id,
    slug:                contact.slug,
    first_name:          contact.first_name,
    last_name:           contact.last_name,
    credentials:         contact.credentials,
    email:               contact.email,
    practice_name:       contact.practice_name,
    legal_business_name: contact.legal_business_name,
    plan_tier:           contact.plan_tier,
    plan_type:           contact.plan_type,
    status:              contact.status
  };

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    contact: safeContact,
    guarantee: pg,
    already_signed: !!signedRow,
    signed_at: signedRow ? signedRow.signed_at : null
  });
};

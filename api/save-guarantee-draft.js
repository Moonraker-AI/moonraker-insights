// /api/save-guarantee-draft.js
// Client-facing endpoint for saving a Performance Guarantee draft from the
// onboarding Step 9 configurator.
//
// Security model:
//   1. Page-token (scope='onboarding') is the ONLY accepted credential;
//      extracted from the HttpOnly cookie `mr_pt_onboarding`. Body never
//      carries a contact_id — the token's verified contact_id is authoritative.
//   2. Service-role writes, but every write is bounded by the verified
//      contact_id (UPSERT keyed on contact_id, step PATCH filtered on
//      contact_id+step_key).
//   3. Refuses to overwrite a guarantee with status='locked' — once locked,
//      the document goes through the signing endpoint (3.5), not here.
//
// Step-status transition:
//   - Annual (plan_tier='annual' or legacy plan_type='annual'):
//       pending | in_progress  ->  in_progress
//     (signing in 3.5 completes the step.)
//   - Flexible / monthly / quarterly / null plan:
//       pending  ->  complete
//     (no signing step — saving the draft fulfills Step 9 for non-annual
//     clients so auto_promote_to_active can still run.)
//
// Rate limit: per-contact, 30 req/60s, fail-open (this is a cheap,
// low-stakes endpoint and bricking Save during a store blip is worse than
// modest abuse risk).

var sb         = require('./_lib/supabase');
var pageToken  = require('./_lib/page-token');
var monitor    = require('./_lib/monitor');
var rateLimit  = require('./_lib/rate-limit');

var LIMITS = {
  ltv_cents_max:    100000000,   // $1,000,000 LTV ceiling
  invest_cents_max: 100000000,   // $1,000,000 annual investment ceiling
  calls_max:        10000        // monthly organic calls ceiling
};

function coerceInt(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  if (!Number.isFinite(n)) return null;
  n = Math.round(n);
  if (n < min || n > max) return null;
  return n;
}

function coerceRate(v) {
  // Expect a decimal in (0, 1]. Frontend converts percent -> decimal before POST.
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > 1) return null;
  return n;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')        return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured())           return res.status(500).json({ error: 'Service not configured' });
  if (!pageToken.isConfigured())    return res.status(500).json({ error: 'Auth not configured' });

  var contact = null;   // populated below; referenced in catch for monitor context
  var stage = 'init';

  try {
    // 1. Page-token → contact_id
    stage = 'verify_token';
    var submittedToken = pageToken.getTokenFromRequest(req, 'onboarding');
    if (!submittedToken) return res.status(403).json({ error: 'Page token required' });

    var tokenData;
    try {
      tokenData = pageToken.verify(submittedToken, 'onboarding');
    } catch (e) {
      console.error('[save-guarantee-draft] page-token verify threw:', e.message);
      return res.status(500).json({ error: 'Auth system unavailable' });
    }
    if (!tokenData) return res.status(403).json({ error: 'Invalid or expired page token' });
    var verifiedContactId = tokenData.contact_id;

    // 2. Rate limit (fail-open)
    stage = 'rate_limit';
    var rl = await rateLimit.check(
      'contact:' + verifiedContactId + ':pg-draft',
      30, 60, { failClosed: false }
    );
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(((rl.reset_at || new Date()) - new Date()) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }

    // 3. Validate inputs
    stage = 'validate_inputs';
    var body = req.body || {};
    var ltv_cents     = coerceInt(body.avg_client_ltv_cents,           1, LIMITS.ltv_cents_max);
    var conv_rate     = coerceRate(body.conversion_rate);
    var att_rate      = coerceRate(body.attendance_rate);
    var current_calls = coerceInt(body.current_monthly_organic_calls,  0, LIMITS.calls_max);
    var invest_cents  = coerceInt(body.investment_cents,               1, LIMITS.invest_cents_max);

    if (ltv_cents == null || conv_rate == null || att_rate == null ||
        current_calls == null || invest_cents == null) {
      return res.status(400).json({
        error: 'Invalid inputs',
        detail: 'All numeric fields required; rates must be decimals in (0, 1].'
      });
    }

    // 4. Load contact (plan branch + monitoring context + state gate)
    stage = 'load_contact';
    contact = await sb.one(
      'contacts?select=id,slug,plan_tier,plan_type,status,lost' +
      '&id=eq.' + encodeURIComponent(verifiedContactId) + '&limit=1'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost) return res.status(403).json({ error: 'Contact is no longer active' });
    // Slug binding — if body supplied a slug, must match the verified contact.
    // Cookie is Path=/ so delivery is cross-subpath; slug enforcement lives here.
    if (body.slug && !pageToken.assertSlugBinding(body.slug, contact.slug)) {
      return res.status(403).json({ error: 'Page token not valid for this client' });
    }
    if (['onboarding', 'active'].indexOf(contact.status) === -1) {
      return res.status(403).json({ error: 'Contact not in a valid state for PG draft' });
    }

    // 5. Refuse to overwrite a LOCKED guarantee (mutations go through 3.5 signing)
    stage = 'check_existing';
    var existing = await sb.one(
      'performance_guarantees?select=id,status&contact_id=eq.' +
      encodeURIComponent(verifiedContactId) + '&limit=1'
    );
    if (existing && existing.status === 'locked') {
      return res.status(409).json({ error: 'Performance Guarantee is locked and cannot be edited as a draft.' });
    }

    // 6. Derive benchmark math server-side (authoritative)
    stage = 'derive';
    var ltv_dollars     = ltv_cents    / 100;
    var invest_dollars  = invest_cents / 100;
    var valuePerCall    = ltv_dollars * conv_rate * att_rate;   // dollars per booked call
    if (!(valuePerCall > 0)) {
      return res.status(400).json({ error: 'Value per call must be positive' });
    }
    var guaranteeCalls    = Math.ceil((invest_dollars * 2) / valuePerCall);
    var totalBenchmark    = (current_calls * 12) + guaranteeCalls;
    var valuePerCallCents = Math.round(valuePerCall * 100);

    var payload = {
      contact_id:                    verifiedContactId,
      avg_client_ltv_cents:          ltv_cents,
      conversion_rate:               conv_rate,
      attendance_rate:               att_rate,
      current_monthly_organic_calls: current_calls,
      investment_cents:              invest_cents,
      value_per_call_cents:          valuePerCallCents,
      guarantee_calls:               guaranteeCalls,
      total_benchmark:               totalBenchmark,
      status:                        'draft',
      updated_at:                    new Date().toISOString()
    };

    // 7. UPSERT performance_guarantees (UNIQUE contact_id → merge-duplicates)
    stage = 'upsert_guarantee';
    var rows = await sb.mutate(
      'performance_guarantees?on_conflict=contact_id',
      'POST',
      payload,
      'resolution=merge-duplicates,return=representation'
    );
    var saved = Array.isArray(rows) ? rows[0] : rows;

    // 8. Step-status transition
    stage = 'patch_step';
    var isAnnual = (contact.plan_tier === 'annual') || (contact.plan_type === 'annual');
    var patch, stepFilter;
    if (isAnnual) {
      patch = {
        status: 'in_progress',
        notes:  'Draft: ' + guaranteeCalls + ' calls / ' + totalBenchmark + ' benchmark'
      };
      // Only transition from pending or refresh an existing in_progress (notes only)
      stepFilter = 'contact_id=eq.' + encodeURIComponent(verifiedContactId) +
                   '&step_key=eq.performance_guarantee' +
                   '&status=in.(pending,in_progress)';
    } else {
      patch = {
        status:       'complete',
        notes:        'Draft saved on flexible plan — guarantee not applicable until upgrade',
        completed_at: new Date().toISOString()
      };
      // Only complete from pending; leave already-complete/in_progress alone
      stepFilter = 'contact_id=eq.' + encodeURIComponent(verifiedContactId) +
                   '&step_key=eq.performance_guarantee' +
                   '&status=eq.pending';
    }

    var stepStatusApplied = null;
    var patched = await sb.mutate('onboarding_steps?' + stepFilter, 'PATCH', patch);
    if (Array.isArray(patched) && patched.length > 0) {
      stepStatusApplied = patched[0].status;
    } else {
      // No rows matched the transition window — read current so client UI can sync.
      var current = await sb.one(
        'onboarding_steps?select=status' +
        '&contact_id=eq.' + encodeURIComponent(verifiedContactId) +
        '&step_key=eq.performance_guarantee&limit=1'
      );
      stepStatusApplied = current ? current.status : null;
    }

    return res.status(200).json({
      success: true,
      guarantee: {
        id:                   saved && saved.id,
        status:               saved && saved.status,
        guarantee_calls:      saved && saved.guarantee_calls,
        total_benchmark:      saved && saved.total_benchmark,
        value_per_call_cents: saved && saved.value_per_call_cents
      },
      step_status:         stepStatusApplied,
      plan_tier_effective: isAnnual ? 'annual' : 'flexible'
    });

  } catch (err) {
    try {
      await monitor.logError('save-guarantee-draft', err, {
        client_slug: contact && contact.slug,
        detail: { stage: stage }
      });
    } catch (_) { /* monitor must not mask the original failure */ }
    return res.status(500).json({ error: 'Save failed' });
  }
};

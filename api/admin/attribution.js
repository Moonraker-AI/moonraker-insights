// api/admin/attribution.js
// CRUD + paste-parse endpoint for the client-deep-dive Attribution tab.
//
// Client-reported attribution data lives in two tables:
//   client_attribution_periods  — one row per reporting period (e.g., baseline,
//                                 Q2 2025, pre-campaign). Has start/end dates,
//                                 label, is_baseline flag, reported_by, notes.
//   client_attribution_sources  — N rows per period, one per source
//                                 (Google, ChatGPT, referral, direct, etc.).
//                                 Has appointment_count, revenue_cents, category.
//
// Downstream consumer: api/campaign-summary.js pullAttribution() reads these
// tables and exposes data.attribution on the campaign-summary response,
// which drives the client-facing page and chatbot.
//
// All actions funnel through a single POST endpoint with an `action` discriminator.
// Admin-JWT gated — no internal/cron access (this is pure admin UI CRUD).

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

// Allowlist of source categories. Used for client-side dropdown + server-side
// validation. Keep in sync with the admin UI select options.
var VALID_CATEGORIES = [
  'organic_search',
  'ai_search',
  'paid_search',
  'social',
  'referral',
  'directory',
  'direct',
  'other'
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var body = req.body || {};
  var action = body.action;
  if (!action) {
    res.status(400).json({ error: 'action is required' });
    return;
  }

  try {
    switch (action) {
      case 'create_period':  return await createPeriod(body, res);
      case 'update_period':  return await updatePeriod(body, res);
      case 'delete_period':  return await deletePeriod(body, res);
      case 'create_source':  return await createSource(body, res);
      case 'update_source':  return await updateSource(body, res);
      case 'delete_source':  return await deleteSource(body, res);
      case 'parse_paste':    return parsePaste(body, res);
      default:
        res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (e) {
    monitor.logError('admin-attribution', e, { detail: { action: action } });
    res.status(500).json({
      error: 'Attribution operation failed',
      detail: e.message || String(e)
    });
  }
};

// ── Period CRUD ───────────────────────────────────────────────────

async function createPeriod(body, res) {
  if (!body.contact_id)    return res.status(400).json({ error: 'contact_id required' });
  if (!body.period_label)  return res.status(400).json({ error: 'period_label required' });
  if (!body.period_start)  return res.status(400).json({ error: 'period_start required' });
  if (!body.period_end)    return res.status(400).json({ error: 'period_end required' });

  var row = {
    contact_id:    body.contact_id,
    period_label:  String(body.period_label).slice(0, 200),
    period_start:  body.period_start,
    period_end:    body.period_end,
    is_baseline:   !!body.is_baseline,
    reported_by:   body.reported_by ? String(body.reported_by).slice(0, 200) : null,
    reported_at:   body.reported_at || null,
    notes:         body.notes ? String(body.notes).slice(0, 2000) : null,
    data_source:   body.data_source ? String(body.data_source).slice(0, 200) : null
  };

  var result = await sb.mutate(
    'client_attribution_periods',
    'POST',
    row,
    'return=representation'
  );
  var created = Array.isArray(result) ? result[0] : result;
  res.status(200).json({ period: created });
}

async function updatePeriod(body, res) {
  if (!body.period_id) return res.status(400).json({ error: 'period_id required' });
  var fields = body.fields || {};
  var allowed = {};
  ['period_label','period_start','period_end','is_baseline',
   'reported_by','reported_at','notes','data_source'].forEach(function(k) {
    if (fields.hasOwnProperty(k)) allowed[k] = fields[k];
  });
  if (Object.keys(allowed).length === 0) {
    return res.status(400).json({ error: 'No updatable fields supplied' });
  }
  // Coerce text fields to safe lengths
  if (allowed.period_label) allowed.period_label = String(allowed.period_label).slice(0, 200);
  if (allowed.notes)        allowed.notes        = String(allowed.notes).slice(0, 2000);
  if (allowed.reported_by)  allowed.reported_by  = String(allowed.reported_by).slice(0, 200);
  allowed.updated_at = new Date().toISOString();

  var result = await sb.mutate(
    'client_attribution_periods?id=eq.' + encodeURIComponent(body.period_id),
    'PATCH',
    allowed,
    'return=representation'
  );
  var updated = Array.isArray(result) ? result[0] : result;
  if (!updated) {
    return res.status(404).json({ error: 'Period not found' });
  }
  res.status(200).json({ period: updated });
}

async function deletePeriod(body, res) {
  if (!body.period_id) return res.status(400).json({ error: 'period_id required' });

  // Delete sources first (no ON DELETE CASCADE enforced on the FK)
  await sb.mutate(
    'client_attribution_sources?period_id=eq.' + encodeURIComponent(body.period_id),
    'DELETE'
  );
  await sb.mutate(
    'client_attribution_periods?id=eq.' + encodeURIComponent(body.period_id),
    'DELETE'
  );
  res.status(200).json({ ok: true });
}

// ── Source CRUD ───────────────────────────────────────────────────

function coerceSourceRow(body) {
  if (!body.period_id)   throw { http: 400, msg: 'period_id required' };
  if (!body.source_name) throw { http: 400, msg: 'source_name required' };
  var cat = body.source_category || 'other';
  if (VALID_CATEGORIES.indexOf(cat) === -1) {
    throw { http: 400, msg: 'Invalid source_category: ' + cat };
  }
  var appts = Number(body.appointment_count || 0);
  if (!isFinite(appts) || appts < 0) appts = 0;
  var dollars = Number(body.revenue_dollars != null ? body.revenue_dollars : 0);
  if (!isFinite(dollars) || dollars < 0) dollars = 0;
  return {
    period_id:         body.period_id,
    source_name:       String(body.source_name).slice(0, 200),
    source_category:   cat,
    appointment_count: Math.round(appts),
    revenue_cents:     Math.round(dollars * 100),
    notes:             body.notes ? String(body.notes).slice(0, 500) : null
  };
}

async function createSource(body, res) {
  var row;
  try { row = coerceSourceRow(body); }
  catch (e) { return res.status(e.http || 400).json({ error: e.msg || 'Bad input' }); }

  var result = await sb.mutate(
    'client_attribution_sources',
    'POST',
    row,
    'return=representation'
  );
  var created = Array.isArray(result) ? result[0] : result;
  res.status(200).json({ source: created });
}

async function updateSource(body, res) {
  if (!body.source_id) return res.status(400).json({ error: 'source_id required' });
  var fields = body.fields || {};
  var allowed = {};
  if (fields.source_name != null)     allowed.source_name     = String(fields.source_name).slice(0, 200);
  if (fields.source_category != null) {
    if (VALID_CATEGORIES.indexOf(fields.source_category) === -1) {
      return res.status(400).json({ error: 'Invalid source_category' });
    }
    allowed.source_category = fields.source_category;
  }
  if (fields.appointment_count != null) {
    var a = Number(fields.appointment_count);
    allowed.appointment_count = isFinite(a) && a >= 0 ? Math.round(a) : 0;
  }
  if (fields.revenue_dollars != null) {
    var d = Number(fields.revenue_dollars);
    allowed.revenue_cents = isFinite(d) && d >= 0 ? Math.round(d * 100) : 0;
  }
  if (fields.notes != null) allowed.notes = String(fields.notes).slice(0, 500);

  if (Object.keys(allowed).length === 0) {
    return res.status(400).json({ error: 'No updatable fields supplied' });
  }

  var result = await sb.mutate(
    'client_attribution_sources?id=eq.' + encodeURIComponent(body.source_id),
    'PATCH',
    allowed,
    'return=representation'
  );
  var updated = Array.isArray(result) ? result[0] : result;
  if (!updated) {
    return res.status(404).json({ error: 'Source not found' });
  }
  res.status(200).json({ source: updated });
}

async function deleteSource(body, res) {
  if (!body.source_id) return res.status(400).json({ error: 'source_id required' });
  await sb.mutate(
    'client_attribution_sources?id=eq.' + encodeURIComponent(body.source_id),
    'DELETE'
  );
  res.status(200).json({ ok: true });
}

// ── Paste parser ──────────────────────────────────────────────────
//
// Best-effort extraction of source/count/revenue triples from loose email
// text. Admin reviews the output in the UI before saving; the parser is
// advisory. Supports shapes like:
//   "Google: 9 appts, $37,200"
//   "ChatGPT - 1 appointment / $3,800"
//   "Online (direct): 2 appts $7,700"
//   "Psychology Today — 4 consults — $18,000"

function classifyCategory(sourceName) {
  var n = (sourceName || '').toLowerCase();
  if (/(google\s*search|^google$|bing|duckduckgo|organic)/.test(n)) return 'organic_search';
  if (/(chatgpt|openai|claude|anthropic|perplexity|gemini|bard|grok|ai(?:\s|$))/.test(n)) return 'ai_search';
  if (/(google\s*ads|ppc|paid|meta\s*ads|facebook\s*ads|instagram\s*ads)/.test(n)) return 'paid_search';
  if (/(facebook|instagram|linkedin|tiktok|twitter|x\.com|pinterest|social)/.test(n)) return 'social';
  if (/(referr|word\s*of\s*mouth|colleague|friend|therapist)/.test(n)) return 'referral';
  if (/(psychology\s*today|therapyden|therapist\s*directory|zencare|mentalhealthmatch|alma|headway|grow\s*therapy)/.test(n)) return 'directory';
  if (/(direct|typed|bookmark|came\s*back|online)/.test(n)) return 'direct';
  return 'other';
}

function parsePaste(body, res) {
  var text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });

  var suggestions = [];
  var lines = text.split(/[\r\n]+/).map(function(l) { return l.trim(); }).filter(Boolean);

  // Primary pattern: "<name> <delim> <N> <appt-word> ... $<revenue>"
  // Flexible on separators (: - — / ,) and capitalization.
  var pat = /^\s*([A-Za-z][A-Za-z0-9 &\(\)\-_/']{1,80}?)\s*(?::|-|—|–|\||,)?\s*(\d+)\s*(?:consult(?:ation)?s?|appt?s?|appointments?|bookings?|sessions?|calls?)\b[^$]*\$\s*([\d,]+(?:\.\d+)?)/i;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m = line.match(pat);
    if (m) {
      var name = m[1].trim().replace(/[:\-—,/]\s*$/, '').trim();
      var appts = parseInt(m[2], 10);
      var rev = parseFloat(m[3].replace(/,/g, ''));
      if (name && isFinite(appts) && isFinite(rev)) {
        suggestions.push({
          source_name: name.slice(0, 80),
          source_category: classifyCategory(name),
          appointment_count: appts,
          revenue_dollars: rev
        });
        continue;
      }
    }
    // Fallback: catch "<name>: $<rev>" or "<name> <N> appts" alone (no dollar)
    var alt = line.match(/^\s*([A-Za-z][A-Za-z0-9 &\(\)\-_/']{1,80}?)\s*(?::|-|—|–)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*$/);
    if (alt) {
      var altName = alt[1].trim();
      var altRev = parseFloat(alt[2].replace(/,/g, ''));
      if (altName && isFinite(altRev)) {
        suggestions.push({
          source_name: altName.slice(0, 80),
          source_category: classifyCategory(altName),
          appointment_count: 0,
          revenue_dollars: altRev
        });
      }
    }
  }

  res.status(200).json({ suggested_sources: suggestions });
}

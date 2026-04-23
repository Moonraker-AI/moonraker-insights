// api/admin/attribution-sync.js
// Admin endpoint for connecting a client's Google Sheet and syncing
// its data into client_attribution_periods + client_attribution_sources.
//
// Storage model: configuration lives in report_configs.attribution_sync (JSONB).
// Periods created by sync are tagged data_source = 'sheet:<sheet_id>:<tab>'.
// On every sync we delete all sources belonging to sheet-sourced periods for
// this client (matching the tag) and re-insert from fresh sheet data.
// Manual periods (data_source != 'sheet:...') are NEVER touched.
//
// Actions:
//   test_connection  — verify service-account access + list tabs
//   sync_now         — run a full sync (manual trigger or called by cron)
//   save_config      — persist sheet config without syncing
//   disconnect       — clear the config (manual periods remain untouched)
//
// V1 scope: lead_tracker format only (Moonraker template). Summary sheet
// formats (long/wide) will be added in a follow-up; the 'format' field in
// the config is already in place to accommodate them.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var sheets = require('../_lib/google-sheets');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // CRON_SECRET path OR admin JWT path — the cron calls sync_now directly.
  // requireAdminOrInternal handles both via constant-time comparison.
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;
  var isCron = user.role === 'internal' || user.role === 'agent';

  var body = req.body || {};
  var action = body.action;
  if (!action) {
    res.status(400).json({ error: 'action is required' });
    return;
  }
  // Non-cron admins cannot trigger cron-only actions; but all four below are
  // fine for either caller, so no gating needed beyond auth.

  try {
    switch (action) {
      case 'test_connection': return await testConnection(body, res);
      case 'save_config':     return await saveConfig(body, res);
      case 'sync_now':        return await syncNow(body, res, isCron);
      case 'disconnect':      return await disconnect(body, res);
      default:
        res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (e) {
    monitor.logError('admin-attribution-sync', e, {
      detail: { action: action, slug: body.client_slug || null }
    });
    res.status(500).json({
      error: 'Attribution sync operation failed',
      detail: e.message || String(e)
    });
  }
};

// ── test_connection ───────────────────────────────────────────────
// Accepts a URL or ID, returns sheet title + list of tabs. Does not persist.

async function testConnection(body, res) {
  var sheetId = sheets.extractSheetId(body.sheet_url);
  if (!sheetId) {
    return res.status(400).json({ error: 'Could not extract a sheet ID from the URL' });
  }
  try {
    var meta = await sheets.fetchSheetMetadata(sheetId);
    return res.status(200).json({
      ok: true,
      sheet_id: sheetId,
      sheet_title: meta.title,
      tabs: meta.tabs
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      sheet_id: sheetId,
      error: e.message,
      status: e.status || 500
    });
  }
}

// ── save_config ───────────────────────────────────────────────────
// Persist the attribution_sync bucket on report_configs. Upserts by slug.

async function saveConfig(body, res) {
  if (!body.client_slug) return res.status(400).json({ error: 'client_slug required' });
  var slug = body.client_slug;

  var cfg = body.config || {};
  var sheetId = sheets.extractSheetId(cfg.sheet_url || cfg.sheet_id);
  if (!sheetId) return res.status(400).json({ error: 'Valid sheet URL or ID required' });

  var sync = {
    enabled: cfg.enabled !== false,
    sheet_id: sheetId,
    sheet_url: cfg.sheet_url || ('https://docs.google.com/spreadsheets/d/' + sheetId + '/edit'),
    tab_name: cfg.tab_name || null,
    format: cfg.format || 'lead_tracker',
    last_synced_at: null,
    last_sync_status: 'never',
    last_sync_error: null,
    last_sync_rows_touched: 0
  };

  // Preserve prior last_synced_* fields if the config already existed (don't
  // reset history on a bare save)
  var existing = await sb.one('report_configs?select=attribution_sync&client_slug=eq.' + encodeURIComponent(slug) + '&limit=1');
  if (existing && existing.attribution_sync) {
    var prev = existing.attribution_sync;
    if (prev.last_synced_at) sync.last_synced_at = prev.last_synced_at;
    if (prev.last_sync_status && prev.last_sync_status !== 'never') sync.last_sync_status = prev.last_sync_status;
    if (prev.last_sync_error) sync.last_sync_error = prev.last_sync_error;
    if (typeof prev.last_sync_rows_touched === 'number') sync.last_sync_rows_touched = prev.last_sync_rows_touched;
  }

  // report_configs uses client_slug as UNIQUE; upsert via Prefer: resolution=merge-duplicates
  var payload = { client_slug: slug, attribution_sync: sync };
  if (existing) {
    await sb.mutate(
      'report_configs?client_slug=eq.' + encodeURIComponent(slug),
      'PATCH',
      { attribution_sync: sync },
      'return=representation'
    );
  } else {
    await sb.mutate('report_configs', 'POST', payload, 'return=representation');
  }

  res.status(200).json({ ok: true, attribution_sync: sync });
}

// ── disconnect ───────────────────────────────────────────────────
// Clear attribution_sync to {}. Manual periods (data_source != 'sheet:...')
// remain. Sheet-sourced periods remain in place too — admin can delete them
// manually if desired — because an accidental disconnect should be reversible.

async function disconnect(body, res) {
  if (!body.client_slug) return res.status(400).json({ error: 'client_slug required' });
  await sb.mutate(
    'report_configs?client_slug=eq.' + encodeURIComponent(body.client_slug),
    'PATCH',
    { attribution_sync: {} },
    'return=representation'
  );
  res.status(200).json({ ok: true });
}

// ── sync_now ─────────────────────────────────────────────────────

async function syncNow(body, res, isCron) {
  if (!body.client_slug) return res.status(400).json({ error: 'client_slug required' });
  var slug = body.client_slug;

  // Load contact + config in parallel
  var pair = await Promise.all([
    sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id,slug&limit=1'),
    sb.one('report_configs?client_slug=eq.' + encodeURIComponent(slug) + '&select=*&limit=1')
  ]);
  var contact = pair[0];
  var config  = pair[1];
  if (!contact) return res.status(404).json({ error: 'Client not found' });
  if (!config || !config.attribution_sync || !config.attribution_sync.sheet_id) {
    return res.status(400).json({ error: 'No attribution sheet configured for this client' });
  }

  var sync = config.attribution_sync;
  var tabName = sync.tab_name;
  if (!tabName) return res.status(400).json({ error: 'Tab name missing from config' });

  var format = sync.format || 'lead_tracker';
  if (format !== 'lead_tracker') {
    return res.status(400).json({ error: 'Only lead_tracker format is supported in v1. Got: ' + format });
  }

  var result;
  try {
    var range = "'" + tabName.replace(/'/g, "''") + "'!A:Z";
    var rows = await sheets.fetchSheetValues(sync.sheet_id, range);
    result = await runLeadTrackerSync({
      contactId: contact.id,
      sheetId: sync.sheet_id,
      tabName: tabName,
      rows: rows
    });

    // Stamp success
    var updated = Object.assign({}, sync, {
      last_synced_at: new Date().toISOString(),
      last_sync_status: 'ok',
      last_sync_error: null,
      last_sync_rows_touched: result.rows_processed
    });
    await sb.mutate(
      'report_configs?client_slug=eq.' + encodeURIComponent(slug),
      'PATCH',
      { attribution_sync: updated },
      'return=representation'
    );
    res.status(200).json({ ok: true, result: result, attribution_sync: updated });
  } catch (e) {
    var errMsg = e.message || String(e);
    monitor.logError('attribution-sync-run', e, {
      client_slug: slug,
      detail: { sheet_id: sync.sheet_id, tab: tabName }
    });
    var failed = Object.assign({}, sync, {
      last_synced_at: new Date().toISOString(),
      last_sync_status: 'error',
      last_sync_error: errMsg.slice(0, 500)
    });
    await sb.mutate(
      'report_configs?client_slug=eq.' + encodeURIComponent(slug),
      'PATCH',
      { attribution_sync: failed },
      'return=representation'
    ).catch(function(){}); // best-effort error stamp
    res.status(500).json({ error: errMsg });
  }
}

// ── Lead-tracker parser + sync core ───────────────────────────────

// Moonraker template column header signals (case-insensitive contains).
// We match headers by LABEL, not by position, so a client can reorder / add
// columns and sync still works.
var HEADER_SIGNALS = {
  inquiry_date: ['inquiry date'],
  source:       ['source'],      // matches "Source" but also "Source Notes" — priority handled below
  source_notes: ['source notes', 'source note'],
  status:       ['status']
};

// Classify a raw Source cell value into our source_category enum.
// Kept in sync with the VALID_CATEGORIES list in api/admin/attribution.js.
function classifyCategory(sourceText) {
  var n = (sourceText || '').toLowerCase();
  if (/(google\s*search|^google$|bing|duckduckgo|organic|search engine|web search)/.test(n)) return 'organic_search';
  if (/(chatgpt|openai|claude|anthropic|perplexity|gemini|bard|grok|ai\s*search|ai(?:\s|$))/.test(n)) return 'ai_search';
  if (/(google\s*ads|ppc|paid|meta\s*ads|facebook\s*ads|instagram\s*ads)/.test(n)) return 'paid_search';
  if (/(facebook|instagram|linkedin|tiktok|twitter|x\.com|pinterest|social)/.test(n)) return 'social';
  if (/(referr|word\s*of\s*mouth|colleague|friend|therapist|networking)/.test(n)) return 'referral';
  if (/(psych\s*today|psychology\s*today|therapyden|therapist\s*directory|zencare|mentalhealthmatch|mental\s*health\s*match|alma|headway|grow\s*therapy|directory)/.test(n)) return 'directory';
  if (/(direct|typed|bookmark|came\s*back|online)/.test(n)) return 'direct';
  return 'other';
}

// Parse a "3/3/2026" / "2026-03-03" / "3/3/26" value into a YYYY-MM month key.
function parseMonthKey(value) {
  if (!value) return null;
  var s = String(value).trim();
  // ISO-ish: YYYY-MM-DD or YYYY/MM/DD
  var iso = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (iso) {
    return iso[1] + '-' + String(iso[2]).padStart(2,'0');
  }
  // US-ish: M/D/YYYY or M/D/YY
  var us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (us) {
    var year = us[3];
    if (year.length === 2) year = (parseInt(year,10) < 50 ? '20' : '19') + year;
    return year + '-' + String(us[1]).padStart(2,'0');
  }
  // Natural language: "March 2026" or "Mar 3 2026"
  var nl = Date.parse(s);
  if (!isNaN(nl)) {
    var d = new Date(nl);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0');
  }
  return null;
}

function monthBounds(key) {
  var parts = key.split('-');
  var y = parseInt(parts[0],10), m = parseInt(parts[1],10);
  var start = y + '-' + String(m).padStart(2,'0') + '-01';
  var lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m here = next month's 0 = last day of m
  var end = y + '-' + String(m).padStart(2,'0') + '-' + String(lastDay).padStart(2,'0');
  return { start: start, end: end };
}

function monthLabel(key) {
  var parts = key.split('-');
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[parseInt(parts[1],10)-1] + ' ' + parts[0];
}

// Find header columns by signal matching. Returns {col_name: index} or
// throws with a descriptive error if required columns are missing.
function detectHeaderColumns(headerRow) {
  if (!headerRow || !headerRow.length) {
    throw new Error('Sheet appears empty (no header row detected)');
  }
  var lower = headerRow.map(function(h) { return (h || '').toString().toLowerCase().trim(); });

  function findCol(signals, excludeIndexes) {
    for (var s = 0; s < signals.length; s++) {
      for (var i = 0; i < lower.length; i++) {
        if (excludeIndexes && excludeIndexes.indexOf(i) !== -1) continue;
        if (lower[i].indexOf(signals[s]) !== -1) return i;
      }
    }
    return -1;
  }

  // Source Notes first — it contains "source" too, so grab it and exclude
  // its index when finding "source" proper.
  var sourceNotesIdx = findCol(HEADER_SIGNALS.source_notes, null);
  var exclude = sourceNotesIdx !== -1 ? [sourceNotesIdx] : [];

  var cols = {
    inquiry_date: findCol(HEADER_SIGNALS.inquiry_date, null),
    source:       findCol(HEADER_SIGNALS.source, exclude),
    source_notes: sourceNotesIdx,
    status:       findCol(HEADER_SIGNALS.status, null)
  };

  var missing = [];
  if (cols.inquiry_date === -1) missing.push('Inquiry Date');
  if (cols.source === -1) missing.push('Source');
  if (cols.status === -1) missing.push('Status');
  if (missing.length) {
    throw new Error('Sheet is missing required column(s): ' + missing.join(', ')
      + '. Header row was: ' + headerRow.join(' | '));
  }
  return cols;
}

async function runLeadTrackerSync(opts) {
  var contactId = opts.contactId;
  var sheetId   = opts.sheetId;
  var tabName   = opts.tabName;
  var rows      = opts.rows;

  if (!rows || !rows.length) {
    return { rows_processed: 0, periods_created: 0, periods_updated: 0, sources_written: 0 };
  }

  var header = rows[0];
  var cols = detectHeaderColumns(header);

  // Aggregate: { monthKey: { sourceKey: { name, category, inquiries, bookings } } }
  var agg = {};
  var rowsProcessed = 0;

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var inquiryDate = (row[cols.inquiry_date] || '').toString().trim();
    if (!inquiryDate) {
      // Stop at first blank — footer/help text shouldn't pollute aggregation
      break;
    }
    var monthKey = parseMonthKey(inquiryDate);
    if (!monthKey) continue; // skip rows with unparseable dates

    var sourceRaw = (row[cols.source] || '').toString().trim();
    var sourceNotes = cols.source_notes !== -1 ? (row[cols.source_notes] || '').toString().trim() : '';
    if (!sourceRaw && !sourceNotes) {
      // No source attribution on this lead — skip (don't guess)
      continue;
    }

    var sourceName = sourceNotes || sourceRaw || 'Unknown';
    var category = classifyCategory(sourceRaw || sourceName);

    var status = (row[cols.status] || '').toString().trim().toLowerCase();
    var isBooking = /^booked\b/.test(status);

    if (!agg[monthKey]) agg[monthKey] = {};
    // Aggregate by (name, category) key — two rows with same name+category roll up
    var srcKey = sourceName + '||' + category;
    if (!agg[monthKey][srcKey]) {
      agg[monthKey][srcKey] = {
        source_name: sourceName,
        source_category: category,
        inquiries: 0,
        bookings: 0
      };
    }
    agg[monthKey][srcKey].inquiries += 1;
    if (isBooking) agg[monthKey][srcKey].bookings += 1;
    rowsProcessed += 1;
  }

  var dataSourceTag = 'sheet:' + sheetId + ':' + tabName;
  var nowIso = new Date().toISOString();

  // Pull existing sheet-sourced periods for this contact so we can decide
  // upsert vs insert. Match by tag to avoid trampling legacy data.
  var existingPeriods = await sb.query(
    'client_attribution_periods?contact_id=eq.' + encodeURIComponent(contactId)
    + '&data_source=eq.' + encodeURIComponent(dataSourceTag)
    + '&select=*'
  );
  var existingByMonth = {};
  existingPeriods.forEach(function(p) {
    // Map (period_start) to period record for fast lookup
    existingByMonth[p.period_start] = p;
  });

  var periodsCreated = 0;
  var periodsUpdated = 0;
  var sourcesWritten = 0;

  var monthKeys = Object.keys(agg).sort();

  for (var k = 0; k < monthKeys.length; k++) {
    var mk = monthKeys[k];
    var bounds = monthBounds(mk);
    var existing = existingByMonth[bounds.start];
    var periodId;

    if (existing) {
      // Refresh the label/notes (cheap), stamp updated_at, and clear its sources
      await sb.mutate(
        'client_attribution_periods?id=eq.' + existing.id,
        'PATCH',
        {
          period_label: monthLabel(mk),
          period_end: bounds.end,
          data_source: dataSourceTag,
          reported_at: nowIso,
          reported_by: 'sheet sync',
          updated_at: nowIso
        },
        'return=representation'
      );
      // Wipe existing sources for this period (safe — this period is sheet-owned)
      await sb.mutate(
        'client_attribution_sources?period_id=eq.' + existing.id,
        'DELETE'
      );
      periodId = existing.id;
      periodsUpdated += 1;
    } else {
      var newPeriod = await sb.mutate(
        'client_attribution_periods',
        'POST',
        {
          contact_id: contactId,
          period_start: bounds.start,
          period_end: bounds.end,
          period_label: monthLabel(mk),
          is_baseline: false,
          data_source: dataSourceTag,
          reported_by: 'sheet sync',
          reported_at: nowIso,
          notes: null
        },
        'return=representation'
      );
      var created = Array.isArray(newPeriod) ? newPeriod[0] : newPeriod;
      periodId = created.id;
      periodsCreated += 1;
    }

    // Insert fresh sources
    var sourcesForPeriod = Object.keys(agg[mk]).map(function(srcKey) {
      var s = agg[mk][srcKey];
      return {
        period_id: periodId,
        source_name: s.source_name.slice(0, 200),
        source_category: s.source_category,
        appointment_count: s.bookings,
        inquiry_count: s.inquiries,
        revenue_cents: 0,   // v1: revenue stays manual
        notes: null
      };
    });

    if (sourcesForPeriod.length) {
      await sb.mutate(
        'client_attribution_sources',
        'POST',
        sourcesForPeriod,
        'return=representation'
      );
      sourcesWritten += sourcesForPeriod.length;
    }
  }

  return {
    rows_processed: rowsProcessed,
    periods_created: periodsCreated,
    periods_updated: periodsUpdated,
    sources_written: sourcesWritten,
    months_touched: monthKeys.length
  };
}

// Export internal fn so the cron can invoke it without an HTTP hop
module.exports.runLeadTrackerSync = runLeadTrackerSync;
module.exports.parseMonthKey = parseMonthKey;
module.exports.detectHeaderColumns = detectHeaderColumns;

// api/probe-gbp.js
// One-shot probe endpoint for the Google Business Profile integration.
//
// Answers three questions in one call:
//   1. Is the Performance API quota actually open now (case 8-326800040416)?
//   2. Which accounts does the service account see via DWD impersonation
//      of support@moonraker.ai?
//   3. What locations are accessible under those accounts (for gbp_location_id
//      backfill)?
//
// CRON_SECRET-gated via requireCronSecret — read-only, no writes, no side
// effects. Kept as a permanent ops tool since gbp_location_id backfill is
// an ongoing need as new clients onboard.
//
// Usage:
//   POST /api/probe-gbp
//   Authorization: Bearer <CRON_SECRET>
//   Body (all optional):
//     {
//       "performance_location_id": "8212621669222797058",   // default: Anna's known id
//       "performance_start_date":  "2026-03-15",            // default: 30 days ago
//       "performance_end_date":    "2026-04-14",            // default: yesterday
//       "skip_accounts":     false,   // skip accounts + locations listing
//       "skip_performance":  false    // skip Performance API test
//     }

var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var google = require('./_lib/google-delegated');
var fetchT = require('./_lib/fetch-with-timeout');

var GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
var IMPERSONATED_MAILBOX = 'support@moonraker.ai';

// Anna Skomorovskaia's known gbp_location_id, from report_configs.
// Used as the default probe target because she's the only client with
// this configured today.
var DEFAULT_PROBE_LOCATION = '8212621669222797058';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Strict CRON auth — admin JWTs cannot invoke
  var user = await auth.requireCronSecret(req, res);
  if (!user) return;

  var body = req.body || {};
  var probeLocationId = String(body.performance_location_id || DEFAULT_PROBE_LOCATION);
  var skipAccounts = !!body.skip_accounts;
  var skipPerformance = !!body.skip_performance;

  // Default date range: last 30 days ending yesterday (Performance API
  // does not accept today as endDate)
  var endDate = body.performance_end_date;
  var startDate = body.performance_start_date;
  if (!endDate) {
    var y = new Date(Date.now() - 86400000);
    endDate = y.toISOString().slice(0, 10);
  }
  if (!startDate) {
    var s = new Date(new Date(endDate + 'T00:00:00Z').getTime() - 30 * 86400000);
    startDate = s.toISOString().slice(0, 10);
  }

  var warnings = [];
  var result = {
    impersonated: IMPERSONATED_MAILBOX,
    accounts: null,
    locations: null,
    locations_count: 0,
    performance_test: null,
    warnings: warnings,
    duration_ms: 0
  };

  var t0 = Date.now();
  var token;
  try {
    token = await google.getDelegatedAccessToken(IMPERSONATED_MAILBOX, GBP_SCOPE);
  } catch (e) {
    monitor.logError('probe-gbp', e, { detail: { stage: 'token' } });
    res.status(500).json({
      error: 'DWD token acquisition failed',
      detail: e.message || String(e)
    });
    return;
  }

  // ── 1. List accounts + locations ───────────────────────────────
  if (!skipAccounts) {
    try {
      var accounts = await listAccounts(token);
      result.accounts = accounts;

      var allLocations = [];
      for (var a = 0; a < accounts.length; a++) {
        try {
          var locs = await listLocations(token, accounts[a].name);
          for (var L = 0; L < locs.length; L++) {
            locs[L]._account = accounts[a].name;
          }
          allLocations = allLocations.concat(locs);
        } catch (locErr) {
          warnings.push('locations.list failed for ' + accounts[a].name + ': ' + (locErr.message || String(locErr)));
        }
      }
      result.locations = allLocations;
      result.locations_count = allLocations.length;
    } catch (acctErr) {
      warnings.push('accounts.list failed: ' + (acctErr.message || String(acctErr)));
      monitor.logError('probe-gbp', acctErr, { detail: { stage: 'list_accounts' } });
    }
  }

  // ── 2. Performance API quota probe ────────────────────────────
  if (!skipPerformance) {
    result.performance_test = await probePerformance(
      token, probeLocationId, startDate, endDate
    );
  }

  result.duration_ms = Date.now() - t0;
  res.status(200).json(result);
};

// ── Account Management API: accounts.list ─────────────────────────
async function listAccounts(token) {
  var all = [];
  var pageToken = null;
  for (var safety = 0; safety < 20; safety++) {
    var url = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=100';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    var resp = await fetchT(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    }, 15000);
    var text = await resp.text();
    var data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('accounts.list: non-JSON (' + resp.status + ')'); }
    if (!resp.ok) {
      var msg = data && data.error && data.error.message ? data.error.message : ('HTTP ' + resp.status);
      throw new Error('accounts.list: ' + msg);
    }
    var list = data.accounts || [];
    for (var i = 0; i < list.length; i++) {
      all.push({
        name: list[i].name,
        accountName: list[i].accountName,
        type: list[i].type,
        role: list[i].role,
        verificationState: list[i].verificationState,
        vettedState: list[i].vettedState
      });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return all;
}

// ── Business Information API: locations.list ────────────────────
// readMask is required — listing the minimal fields we actually need
// for gbp_location_id matching.
async function listLocations(token, accountName) {
  var readMask = 'name,title,storefrontAddress,websiteUri,phoneNumbers,storeCode';
  var all = [];
  var pageToken = null;
  for (var safety = 0; safety < 20; safety++) {
    var url = 'https://mybusinessbusinessinformation.googleapis.com/v1/'
      + accountName + '/locations?pageSize=100&readMask='
      + encodeURIComponent(readMask);
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    var resp = await fetchT(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    }, 15000);
    var text = await resp.text();
    var data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('locations.list: non-JSON (' + resp.status + ')'); }
    if (!resp.ok) {
      var msg = data && data.error && data.error.message ? data.error.message : ('HTTP ' + resp.status);
      throw new Error('locations.list: ' + msg);
    }
    var list = data.locations || [];
    for (var i = 0; i < list.length; i++) {
      var loc = list[i];
      var addr = loc.storefrontAddress || {};
      var addressLines = (addr.addressLines || []).join(', ');
      var locality = [addr.locality, addr.administrativeArea, addr.postalCode].filter(Boolean).join(' ');
      all.push({
        name: loc.name,              // "locations/<id>"
        location_id: (loc.name || '').replace(/^locations\//, ''),
        title: loc.title,
        store_code: loc.storeCode || null,
        website_uri: loc.websiteUri || null,
        address: [addressLines, locality].filter(Boolean).join(', ') || null,
        primary_phone: loc.phoneNumbers && loc.phoneNumbers.primaryPhone || null
      });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return all;
}

// ── Performance API: quota probe ────────────────────────────────
// Ports the exact URL shape from compile-report.js so a positive probe
// proves the production pipeline will work identically once un-gated.
async function probePerformance(token, locationId, startDate, endDate) {
  var s = new Date(startDate + 'T00:00:00Z');
  var e = new Date(endDate + 'T00:00:00Z');
  var url = 'https://businessprofileperformance.googleapis.com/v1/locations/' + locationId
    + ':fetchMultiDailyMetricsTimeSeries'
    + '?dailyMetrics=CALL_CLICKS'
    + '&dailyMetrics=WEBSITE_CLICKS'
    + '&dailyMetrics=BUSINESS_DIRECTION_REQUESTS'
    + '&dailyMetrics=BUSINESS_IMPRESSIONS_DESKTOP_MAPS'
    + '&dailyMetrics=BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'
    + '&dailyMetrics=BUSINESS_IMPRESSIONS_MOBILE_MAPS'
    + '&dailyMetrics=BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
    + '&dailyRange.startDate.year=' + s.getUTCFullYear()
    + '&dailyRange.startDate.month=' + (s.getUTCMonth() + 1)
    + '&dailyRange.startDate.day=' + s.getUTCDate()
    + '&dailyRange.endDate.year=' + e.getUTCFullYear()
    + '&dailyRange.endDate.month=' + (e.getUTCMonth() + 1)
    + '&dailyRange.endDate.day=' + e.getUTCDate();

  var out = {
    location_id: locationId,
    date_range: { start: startDate, end: endDate },
    http_status: null,
    status: null,
    metrics: null,
    error: null
  };

  var resp;
  try {
    resp = await fetchT(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    }, 15000);
  } catch (netErr) {
    out.status = 'error';
    out.error = 'Network/timeout: ' + (netErr.message || String(netErr));
    return out;
  }

  out.http_status = resp.status;
  var text = await resp.text();
  var data;
  try { data = JSON.parse(text); }
  catch (e2) { data = null; }

  if (!resp.ok) {
    var errMsg = data && data.error && data.error.message ? data.error.message : text.slice(0, 300);
    var errStatus = data && data.error && data.error.status ? data.error.status : '';
    if (resp.status === 429 || /quota/i.test(errMsg) || errStatus === 'RESOURCE_EXHAUSTED') {
      out.status = 'quota_exceeded';
    } else if (resp.status === 404 || errStatus === 'NOT_FOUND') {
      out.status = 'not_found';
    } else if (resp.status === 401 || resp.status === 403) {
      out.status = 'auth_error';
    } else {
      out.status = 'error';
    }
    out.error = errMsg;
    return out;
  }

  // Sum up the daily values per metric
  var series = (data && data.multiDailyMetricTimeSeries) || [];
  function sumMetric(metricName) {
    for (var i = 0; i < series.length; i++) {
      var dmt = series[i].dailyMetricTimeSeries || {};
      if (dmt.dailyMetric === metricName) {
        var points = (dmt.timeSeries && dmt.timeSeries.datedValues) || [];
        var total = 0;
        for (var j = 0; j < points.length; j++) {
          total += parseInt(points[j].value || 0, 10);
        }
        return total;
      }
    }
    return 0;
  }
  var imp = {
    desktop_maps:   sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_MAPS'),
    desktop_search: sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'),
    mobile_maps:    sumMetric('BUSINESS_IMPRESSIONS_MOBILE_MAPS'),
    mobile_search:  sumMetric('BUSINESS_IMPRESSIONS_MOBILE_SEARCH')
  };
  out.status = 'ok';
  out.metrics = {
    calls:              sumMetric('CALL_CLICKS'),
    website_clicks:     sumMetric('WEBSITE_CLICKS'),
    direction_requests: sumMetric('BUSINESS_DIRECTION_REQUESTS'),
    impressions_total:  imp.desktop_maps + imp.desktop_search + imp.mobile_maps + imp.mobile_search,
    impressions_breakdown: imp
  };
  return out;
}

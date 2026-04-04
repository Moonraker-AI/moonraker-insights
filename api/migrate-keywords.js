// /api/migrate-keywords.js
// One-time migration: reads client campaign Google Sheets via service account,
// extracts keyword targets and location targets, inserts into tracked_keywords.
// Usage: GET /api/migrate-keywords?key=moonraker2026&dry=true (dry run)
//        GET /api/migrate-keywords?key=moonraker2026&slug=kelly-chisholm (single client)
//        GET /api/migrate-keywords?key=moonraker2026 (all clients, live)

module.exports = async function handler(req, res) {
  if (req.query.key !== 'moonraker2026') return res.status(401).json({ error: 'Unauthorized' });
  var dryRun = req.query.dry === 'true';
  var singleSlug = req.query.slug || null;
  var supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var IMPERSONATE = 'support@moonraker.ai';

  var SHEETS = {"kelly-chisholm":"1YdaVY7RcQbFJGPgYw4eaK1UynavzAyqRMBSFkGXAklA","sara-smith":"1E_sOqF9sUpMFY6A-u5IxnZ9SaMq3d8z8hbc5i7gkgGs","alli-christie-disney":"1WsDbsG3hwawiHFkmlx4CUSp33IPDsSXYYEaoaZjVK-I","amy-hagerstrom":"1tFXMb01ioDu-xx0Qk0ovS9xQWEN2NtJhJLsyYx_tlUU","ross-hackerson":"11M99pUeAaweZW_2cW78A51W0qYUX6UThD6PpdcKR4lo","audrey-schoen":"1aYed38rLzRVVHiJ8gxaI9gBx4bdBIO26hJ6j4DBhSoI","stephanie-crouch":"17lDirkwT3t69X8QKEgMe_kITNeMQPjW492wlX6GnVP0","daniel-arteaga":"1vLn_kGKhzWpHUKFzHg4UAr-tuF_G2FiiyMWdxV6eWY4","erika-frieze":"1mMbMdr_NIPxqlqhaLgdjcf-EcofJnTPpP8sbF15n2NA","amy-castongia":"1kesw8ISLwVEOcqY6bx1lp8Fn3qJy35PhyGrbtIF5qHA","kelly-chisholm-2":"1BxKrLLoP1i1p_BFYxdMCLtBn7LxfMBH7hugwJZC0GjY","joanne-garrow":"1Bqyh6j17upSQ4EHjozHFhKIubCaPFuUIATSOFxteIVE","amber-young":"1aZimbFgRZjz3nUBPTlVwo3ji7QO0F4OJ7426kn7oZLE","natalie-goldberg":"1r1WTzQ279Z_iP5beHzkDJ42JA3s9DkW-2Zj2PYha1F8","erica-aten":"1hjI-PjFCRuqteEhtU9ybTkowfztNPOC_EBm_2Ti2cxE","brooke-brandeberry":"1AL5O1z3p_WG8Cf-CXZSjZr2GGxxyzzPEH_-DA9_NcFs","elizabeth-harding":"1boXBLJaKF-fAAxGZInr5rSxVWLGiY6LRYYtGBVM6vSg","cristina-deneve":"1VCu5tfQGAtxxFs0errly_AYvAyrN2Wd2ECEzUxzbX1s","erika-beck":"1bpe0r28Gb5lwT0NUuxFya691o6nL6JPiTZqeo8MZm0o","erinn-everhart":"1Z3tkTtjb-ykc73XoNvKh8cJT8uKCOp2YR9GQKpRF2Y8","kevin-anderson":"1QDO1XMYUN1eEUgpay8eVIZdMBdEVoqL1DWXp4vYRt8Y","matt-ciaschini":"1q0LeZ-SwQE8n-cPNRPvgrJYRPeSZmjZfwOYnK4dtdo0","viviana-mcgovern":"1KrS4NPrH5CuSe5eK2oQ5P8y5M_ZQzUTfMm2p3eT7cNo","lianna-purjes":"14s22g17_JoU-625gxOq3URhMWI5yPBuE_X67OWcIdWI","gaia-somasca":"14G1Qg-44orMddlPKVSMS8LWCF8z6jbJvLTco3h2X1HE","laura-biron":"14JsJZZRk7V06gMxuCZFvBmoAO8Ra1LTyFWylp0bAvqo","lydia-zygeta":"1_qA7bv3n24FSMbN_e_WGLva3mruNNMGmSuFgWP8W2s4","jon-abelack":"1HDYbcRokE0PLVIu3H0yNlkMMwlYPpqvH7ZBP35iiv9o","katrina-kwan":"1IXOpKbWbXXRO-23WGSZKuZzI97r93hayRfUmSbwnIVk","laura-bai":"1X-L8zmBML6mDIMI2ERO--iwTy2zwTy3OYhw5kETnlI0","kelsey-thompson":"1fI8rOJrRZIuL6OdAObVhUv9AYTuMuSGFHbZ-lbdD0zw","linda-kocieniewski":"1O2CJogiAD9moHo33yOF4GdcNVyMjeMmhxY5iuOwUiZM","kelsey-fyffe":"1UX4EdUkH83Sp37_enzRlDb20zwQpwlvCJgLsE4wefGk","amanda-bumgarner":"1XS5Squ9fYPOn8fVjP9qMB0YWW8OjY0Cu60zzkOgfhkg","lucy-orton":"1UVZvMebcAKXCJqa61A67j6Dkb_R_S_K2GcQ83FWszkY","nicole-mccance":"1vFAIGYN4oewl5mRUsXuIFw4rnURXb_sfJaxL9UdQG-o","isable-smith":"1GbkD2d_jCxEWfBZkAVy7o1-Ia5SYU7-IXqpzJa29NTg","gianna-lalota":"1hCq4qxTlhQb5FC2GWQRq3uQr8kNcWmp9jm61eu-1tTU","emily-newman":"1L9E9esfkBzYz3aAcKAEVWp-Od1Ixw6vXxfvAgtz6R8s","allison-shotwell":"1R3Hhg6iefSqo6xqBxqTuSeEqIaRbH5ATtT4H0xNr0Fg","lauren-hogsett-steele":"1tBSspNeoPn-yLGTV0DhB97iKiUztQe5ofX9WNMV6PJw","jose-de-la-cruz-2":"1USpOjVuFki5DzbrvE77jbvmiqlCukBsMNKW5DjteWuk","vivienne-livingstone":"1UJ_CHSfHU7hs3R6JdE3YD6BGTU8N0SEgqj9MBeAe1R4","robyn-sheiniuk":"1FRpT6Cupep5GcCoO-iNee04qiH7lsadc2K65btBWGm0","jose-de-la-cruz":"1DCX-K5LlCHftqMxi-xpmTJKWM6PYB2d8exAT3NY1xlA","utkala-maringanti":"1AL-n7Z9Jo1ylWlfY3swzYdVENd7f6l2Nojfzv1_aWn8","robyn-sevigny":"1u2ICLV-Q5R3s_fLU0TKxJKIcip0xmbRq_xtfE3kkoh8","mitchel-rosenholtz":"1uI-JnEr90KnGP8CxMuU7qZ_RjKdeGAF50QhDlBNboDA","christine-ruberti-bruning":"1SVI3bJzGCcwSArJuj75sYYqFd5nfRhvdaBhqRMoHdVk","rachelle-ryan":"1kapAqZnvYm6dHubkrCId4j-DlkMnx4n8vsA3OFRfOo8","melinda-schuster":"1T7yehvG_sRnGzvj4_0MOmK_IprTO3nvtRFg7Hs5_-ZI","shabnam-lee":"1i8x8WsyYzfmFUE8pM7l4Gf72RsVrmMcB6FqMx0OeLns","ande-welling":"1AFaeL2aWW9JSLwI-_eYnNpxghOHpvToLLyo1Sy7iSpU","alanna-esquejo":"1e5p5ls_2Bp15ZE3cUNnJA7uMzuHPETA1RJtDOthn5RU","christine-willing":"1A5sqDg8UqbZYCQB0fUJFgimUrxNoZbSFYMOsmjYHvgs","maya-weir":"1q-h01KIOMGFKnxSiQ3GzMzwZnrpS3xvV6iajpkFuwqY","alex-littleton":"1haV-wxhiR8QaUCsgCdlFtOlAkPGw5EfdHL8_k-pso2g","austin-casey":"1S_Ja8JPuLHFQ6nJxpmc2WKHhU-jQ8Ciqejxueglq7C8","erika-doty":"10RM6ioH76A5lr7jPDEOkZtcYJ8EZFi5E0t1wDFIx0yo","anna-skomorovskaia":"1NDQre_9k7BYluHVjbzaubHto4KUlGKvd3wV_iWjAVPM","robert-espiau":"17177oIw3heccaPveXZq5uAy-HGeMDrKG2-Ik7nl5xfE","monique-dunn":"1cUk4RiJL9I4GYjLeaXtER2NzB_D8MIMXFa-ppsAt6S0","atiq-shomar":"1VYQColy_oJ_bXTECNaUA8Mm2qgx5ejh2Tjusa9bMe7c","derek-smith":"1QzkaHhwmd9a4Vh8FgPbJ4iGigcwRQzhnpg0HrRI0WDI"};

  // --- JWT Auth (same as bootstrap-access.js) ---
  async function getGoogleToken(scope) {
    var crypto = require('crypto');
    var sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    var now = Math.floor(Date.now() / 1000);
    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var payload = Buffer.from(JSON.stringify({
      iss: sa.client_email, sub: IMPERSONATE, scope: scope,
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
    })).toString('base64url');
    var signature = crypto.createSign('RSA-SHA256').update(header + '.' + payload).sign(sa.private_key, 'base64url');
    var jwt = header + '.' + payload + '.' + signature;
    var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var td = await tokenResp.json();
    if (!td.access_token) throw new Error('Token error: ' + JSON.stringify(td));
    return td.access_token;
  }

  // --- Supabase REST helpers ---
  var sbHeaders = { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };

  async function sbSelect(table, query) {
    var r = await fetch(supabaseUrl + '/rest/v1/' + table + '?' + query, { headers: sbHeaders });
    return r.json();
  }

  async function sbInsert(table, rows) {
    var r = await fetch(supabaseUrl + '/rest/v1/' + table, {
      method: 'POST', headers: sbHeaders, body: JSON.stringify(rows)
    });
    if (!r.ok) { var e = await r.text(); throw new Error('Insert error: ' + e); }
    return true;
  }

  // --- Google Sheets helpers ---
  async function sheetTabs(token, id) {
    var r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + id + '?fields=sheets.properties.title', { headers: { Authorization: 'Bearer ' + token } });
    var d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return (d.sheets || []).map(function(s) { return s.properties.title; });
  }

  async function sheetValues(token, id, range) {
    var r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/' + encodeURIComponent(range), { headers: { Authorization: 'Bearer ' + token } });
    var d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.values || [];
  }

  // --- Parser ---
  function parseRows(rows) {
    var kws = [], locs = [], section = null, kwRow = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.length === 0) { section = null; continue; }
      var c0 = (row[0] || '').trim();
      if (c0 === 'Service Pages') { section = 'service'; continue; }
      if (c0 === 'Location Pages') { section = 'location'; continue; }
      if (section === 'service') {
        if (c0 === 'Primary Keyword' || c0 === 'Keyword') kwRow = row.slice(1).map(function(v){return (v||'').trim();}).filter(Boolean);
        if (c0 === 'URL' || c0 === 'Optimized Page') {
          var urls = row.slice(1).map(function(v){return (v||'').trim();});
          if (kwRow) { for (var j = 0; j < kwRow.length; j++) { var u = urls[j]||''; if (u.includes('docs.google.com')) u=''; kws.push({keyword:kwRow[j],target_page:u||null,type:'service'}); } }
          kwRow = null; section = null;
        }
      }
      if (section === 'location') {
        if (c0 === 'Location' || c0 === 'Keyword') kwRow = row.slice(1).map(function(v){return (v||'').trim();}).filter(Boolean);
        if (c0 === 'URL' || c0 === 'Optimized Page') {
          var lu = row.slice(1).map(function(v){return (v||'').trim();});
          if (kwRow) { for (var k = 0; k < kwRow.length; k++) { var l = lu[k]||''; if (l.includes('docs.google.com')) l=''; locs.push({keyword:kwRow[k],target_page:l||null,type:'location'}); } }
          kwRow = null; section = null;
        }
      }
    }
    return { keywords: kws, locations: locs };
  }

  try {
    var token = await getGoogleToken('https://www.googleapis.com/auth/spreadsheets.readonly');
    
    // Get contact IDs
    var allSlugs = Object.keys(SHEETS);
    var contacts = await sbSelect('contacts', 'select=id,slug&slug=in.(' + allSlugs.map(function(s){return '"'+s+'"';}).join(',') + ')');
    var slugToId = {}; for (var c of contacts) slugToId[c.slug] = c.id;

    var results = [], errors = [];
    var slugs = singleSlug ? [singleSlug] : allSlugs;

    for (var slug of slugs) {
      var sheetId = SHEETS[slug]; var contactId = slugToId[slug];
      if (!sheetId || !contactId) { errors.push({slug:slug, error:'Missing sheet or contact'}); continue; }
      try {
        var tabs = await sheetTabs(token, sheetId);
        var tabName = tabs.includes('Optimization') ? 'Optimization' : tabs.includes('Technicals') ? 'Technicals' : null;
        if (!tabName) { errors.push({slug:slug, error:'No keyword tab found. Tabs: '+tabs.join(', ')}); continue; }
        var rows = await sheetValues(token, sheetId, "'"+tabName+"'!A1:Z100");
        var parsed = parseRows(rows);
        var all = parsed.keywords.concat(parsed.locations);
        if (all.length === 0) { errors.push({slug:slug, error:'No keywords found'}); continue; }
        var inserts = all.map(function(e){ return {
          contact_id:contactId, client_slug:slug, keyword:e.keyword, keyword_type:e.type,
          target_page:e.target_page, priority:1, source:'migration',
          track_gsc:true, track_geogrid:e.type==='service', track_ai_visibility:e.type==='service', active:true
        };});
        if (!dryRun) await sbInsert('tracked_keywords', inserts);
        results.push({slug:slug, tab:tabName, service:parsed.keywords.map(function(k){return k.keyword;}), locations:parsed.locations.map(function(l){return l.keyword;}), total:inserts.length});
      } catch(se) { errors.push({slug:slug, error:(se.message||'').substring(0,200)}); }
    }

    return res.status(200).json({mode:dryRun?'DRY RUN':'LIVE', processed:results.length, errored:errors.length, total_keywords:results.reduce(function(s,r){return s+r.total;},0), results:results, errors:errors});
  } catch(err) { return res.status(500).json({error:err.message}); }
};

module.exports.config = { maxDuration: 300 };

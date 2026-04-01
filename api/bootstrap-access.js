// /api/bootstrap-access.js
// Automates post-Leadsie access setup for a client.
// Once support@moonraker.ai has been granted access via Leadsie,
// this endpoint uses domain-wide delegation to impersonate support@
// and add the full Moonraker team + service account on each platform.
//
// Supports running ALL services at once, or a SINGLE service for per-button UI.
//
// POST { client_slug, services: ["gbp","ga4","gtm","localfalcon"] }
// POST { client_slug, services: ["gbp"] }  ← single-service mode for admin UI buttons
//
// Team members added per platform:
//   GBP: chris@ + kalyn@ as OWNER, SA as MANAGER
//   GA4: chris@ + kalyn@ as Admin (editor), SA as Viewer
//   GTM: chris@ + kalyn@ as Admin (publish), SA as Read
//   LocalFalcon: search + add location to LF account
//
// ENV: SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, LOCALFALCON_API_KEY

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  var lfKey = process.env.LOCALFALCON_API_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var clientSlug = body.client_slug;
  var services = body.services || ['gbp', 'ga4', 'gtm', 'localfalcon'];

  if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });

  // ─── Team Configuration ────────────────────────────────────────
  var SA_EMAIL = 'reporting@moonraker-client-hq.iam.gserviceaccount.com';
  var IMPERSONATE_USER = 'support@moonraker.ai';
  var TEAM_OWNERS = ['chris@moonraker.ai', 'kalyn@moonraker.ai'];  // Added as owners/admins
  // SA_EMAIL is added separately with lower permissions for automated reads

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }

  var results = {};
  var errors = [];

  // ─── Load contact ──────────────────────────────────────────────
  var contact;
  try {
    var cResp = await fetch(sbUrl + '/rest/v1/contacts?slug=eq.' + clientSlug + '&select=*&limit=1', { headers: sbHeaders() });
    var contacts = await cResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found: ' + clientSlug });
    contact = contacts[0];
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load contact: ' + e.message });
  }

  // ─── Load or create report_configs ─────────────────────────────
  var config;
  try {
    var cfResp = await fetch(sbUrl + '/rest/v1/report_configs?client_slug=eq.' + clientSlug + '&limit=1', { headers: sbHeaders() });
    var configs = await cfResp.json();
    if (configs && configs.length > 0) {
      config = configs[0];
    } else {
      var insertResp = await fetch(sbUrl + '/rest/v1/report_configs', {
        method: 'POST', headers: sbHeaders(),
        body: JSON.stringify({ client_slug: clientSlug, active: true })
      });
      var inserted = await insertResp.json();
      config = Array.isArray(inserted) ? inserted[0] : inserted;
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load/create report_config: ' + e.message });
  }

  var configUpdates = {};
  var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var websiteDomain = (contact.website_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

  // Helper: try an API add, handle ALREADY_EXISTS gracefully
  async function tryAdd(label, fn) {
    try {
      var r = await fn();
      if (r.ok) return { added: true };
      var d = await r.json();
      if (d.error && (d.error.status === 'ALREADY_EXISTS' || (d.error.message || '').toLowerCase().indexOf('already') >= 0)) {
        return { added: true, already_existed: true };
      }
      return { added: false, error: label + ': ' + (d.error ? d.error.message : JSON.stringify(d).substring(0, 200)) };
    } catch (e) {
      return { added: false, error: label + ': ' + e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GBP: Find location, add team as owners + SA as manager
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('gbp')) {
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      var gbpToken = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/business.manage');
      if (gbpToken.error) throw new Error('Token failed: ' + gbpToken.error);

      // Step 1: List all accessible GBP accounts
      var acctResp = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
        headers: { 'Authorization': 'Bearer ' + gbpToken }
      });
      var acctData = await acctResp.json();
      var accounts = acctData.accounts || [];
      if (accounts.length === 0) throw new Error('No GBP accounts accessible by ' + IMPERSONATE_USER + '. Has Leadsie completed?');

      // Step 2: Search for the matching location
      var matchedLocation = null;
      var matchedAccount = null;

      for (var ai = 0; ai < accounts.length && !matchedLocation; ai++) {
        var acct = accounts[ai];
        var locResp = await fetch('https://mybusinessbusinessinformation.googleapis.com/v1/' + acct.name + '/locations?readMask=name,title,websiteUri,storefrontAddress', {
          headers: { 'Authorization': 'Bearer ' + gbpToken }
        });
        var locData = await locResp.json();
        var locations = locData.locations || [];

        for (var li = 0; li < locations.length; li++) {
          var loc = locations[li];
          var locTitle = (loc.title || '').toLowerCase();
          var locWebsite = (loc.websiteUri || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

          if (practiceName && locTitle.indexOf(practiceName.toLowerCase()) >= 0) {
            matchedLocation = loc; matchedAccount = acct; break;
          }
          if (websiteDomain && locWebsite && (locWebsite.indexOf(websiteDomain) >= 0 || websiteDomain.indexOf(locWebsite) >= 0)) {
            matchedLocation = loc; matchedAccount = acct; break;
          }
        }
      }

      if (!matchedLocation) throw new Error('No GBP location matching "' + practiceName + '" found across ' + accounts.length + ' accounts');

      var locName = matchedLocation.name;
      var gbpLocationId = locName.split('/').pop();

      // Step 3: Add team members as OWNER + SA as MANAGER
      var gbpAdds = [];

      for (var oi = 0; oi < TEAM_OWNERS.length; oi++) {
        var ownerResult = await tryAdd('GBP owner ' + TEAM_OWNERS[oi], function() {
          return fetch('https://mybusinessaccountmanagement.googleapis.com/v1/' + locName + '/admins', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + gbpToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin: TEAM_OWNERS[oi], role: 'OWNER' })
          });
        });
        gbpAdds.push({ email: TEAM_OWNERS[oi], role: 'OWNER', result: ownerResult });
      }

      var saResult = await tryAdd('GBP SA', function() {
        return fetch('https://mybusinessaccountmanagement.googleapis.com/v1/' + locName + '/admins', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + gbpToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ admin: SA_EMAIL, role: 'MANAGER' })
        });
      });
      gbpAdds.push({ email: SA_EMAIL, role: 'MANAGER', result: saResult });

      // Step 4: Verify - list current admins
      var verifyResp = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/' + locName + '/admins', {
        headers: { 'Authorization': 'Bearer ' + gbpToken }
      });
      var verifyData = await verifyResp.json();
      var currentAdmins = (verifyData.admins || []).map(function(a) { return { email: a.admin, role: a.role }; });

      var allSucceeded = gbpAdds.every(function(a) { return a.result.added; });
      configUpdates.gbp_location_id = gbpLocationId;

      results.gbp = {
        success: allSucceeded,
        location_title: matchedLocation.title,
        gbp_location_id: gbpLocationId,
        account: matchedAccount.name,
        users_added: gbpAdds,
        current_admins: currentAdmins,
        verified: currentAdmins.some(function(a) { return a.email === SA_EMAIL; })
      };

      // Collect individual add errors
      gbpAdds.forEach(function(a) { if (a.result.error) errors.push(a.result.error); });

    } catch (e) {
      errors.push('GBP: ' + e.message);
      results.gbp = { success: false, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GA4: Find property, add team as editor + SA as viewer
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('ga4')) {
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      var ga4Token = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/analytics.manage.users');
      if (ga4Token.error) throw new Error('Token failed: ' + ga4Token.error);

      // Find matching property
      var summResp = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', {
        headers: { 'Authorization': 'Bearer ' + ga4Token }
      });
      var summData = await summResp.json();
      var accountSummaries = summData.accountSummaries || [];

      var matchedProperty = null;
      for (var si = 0; si < accountSummaries.length && !matchedProperty; si++) {
        var propSummaries = accountSummaries[si].propertySummaries || [];
        for (var pi = 0; pi < propSummaries.length; pi++) {
          var ps = propSummaries[pi];
          var propName = (ps.displayName || '').toLowerCase();
          if (practiceName && propName.indexOf(practiceName.toLowerCase()) >= 0) { matchedProperty = ps; break; }
          if (websiteDomain && propName.indexOf(websiteDomain) >= 0) { matchedProperty = ps; break; }
        }
      }

      // Fallback to existing config
      if (!matchedProperty && config.ga4_property) {
        var propId = config.ga4_property.replace('properties/', '');
        matchedProperty = { property: propId, displayName: config.ga4_property };
      }
      if (!matchedProperty) throw new Error('No GA4 property matching "' + practiceName + '" or "' + websiteDomain + '"');

      var propertyResource = matchedProperty.property;
      if (!propertyResource.startsWith('properties/')) propertyResource = 'properties/' + propertyResource;

      // Add team as EDITOR (admin-level) + SA as VIEWER
      var ga4Adds = [];

      for (var ei = 0; ei < TEAM_OWNERS.length; ei++) {
        (function(email) {
          ga4Adds.push({ email: email, role: 'editor', promise: tryAdd('GA4 editor ' + email, function() {
            return fetch('https://analyticsadmin.googleapis.com/v1beta/' + propertyResource + '/accessBindings', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + ga4Token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ user: email, roles: ['predefinedRoles/editor'] })
            });
          })});
        })(TEAM_OWNERS[ei]);
      }

      ga4Adds.push({ email: SA_EMAIL, role: 'viewer', promise: tryAdd('GA4 SA viewer', function() {
        return fetch('https://analyticsadmin.googleapis.com/v1beta/' + propertyResource + '/accessBindings', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + ga4Token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: SA_EMAIL, roles: ['predefinedRoles/viewer'] })
        });
      })});

      // Wait for all adds
      var ga4Results = await Promise.all(ga4Adds.map(function(a) { return a.promise; }));
      for (var ri = 0; ri < ga4Adds.length; ri++) {
        ga4Adds[ri].result = ga4Results[ri];
        delete ga4Adds[ri].promise;
      }

      // Verify - list access bindings
      var ga4VerifyResp = await fetch('https://analyticsadmin.googleapis.com/v1beta/' + propertyResource + '/accessBindings', {
        headers: { 'Authorization': 'Bearer ' + ga4Token }
      });
      var ga4VerifyData = await ga4VerifyResp.json();
      var currentBindings = (ga4VerifyData.accessBindings || []).map(function(b) { return { user: b.user, roles: b.roles }; });

      var allGa4Succeeded = ga4Adds.every(function(a) { return a.result.added; });
      configUpdates.ga4_property = propertyResource;

      results.ga4 = {
        success: allGa4Succeeded,
        property: propertyResource,
        display_name: matchedProperty.displayName,
        users_added: ga4Adds,
        current_bindings: currentBindings,
        verified: currentBindings.some(function(b) { return b.user === SA_EMAIL; })
      };

      ga4Adds.forEach(function(a) { if (a.result.error) errors.push(a.result.error); });

    } catch (e) {
      errors.push('GA4: ' + e.message);
      results.ga4 = { success: false, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GTM: Find container, add team as publish + SA as read
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('gtm')) {
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      var gtmToken = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/tagmanager.manage.users');
      if (gtmToken.error) throw new Error('Token failed: ' + gtmToken.error);

      // Find matching container
      var gtmAcctResp = await fetch('https://tagmanager.googleapis.com/tagmanager/v2/accounts', {
        headers: { 'Authorization': 'Bearer ' + gtmToken }
      });
      var gtmAcctData = await gtmAcctResp.json();
      var gtmAccounts = gtmAcctData.account || [];

      var matchedContainer = null;
      var matchedGtmAccount = null;

      for (var gi = 0; gi < gtmAccounts.length && !matchedContainer; gi++) {
        var gtmAcct = gtmAccounts[gi];
        var contResp = await fetch('https://tagmanager.googleapis.com/tagmanager/v2/' + gtmAcct.path + '/containers', {
          headers: { 'Authorization': 'Bearer ' + gtmToken }
        });
        var contData = await contResp.json();
        var containers = contData.container || [];

        for (var ci = 0; ci < containers.length; ci++) {
          var cont = containers[ci];
          var contDomains = cont.domainName || [];
          if (typeof contDomains === 'string') contDomains = [contDomains];
          var contName = (cont.name || '').toLowerCase();

          for (var di = 0; di < contDomains.length; di++) {
            var d = contDomains[di].replace(/^www\./, '').toLowerCase();
            if (websiteDomain && (d.indexOf(websiteDomain) >= 0 || websiteDomain.indexOf(d) >= 0)) {
              matchedContainer = cont; matchedGtmAccount = gtmAcct; break;
            }
          }
          if (!matchedContainer && practiceName && contName.indexOf(practiceName.toLowerCase()) >= 0) {
            matchedContainer = cont; matchedGtmAccount = gtmAcct;
          }
          if (matchedContainer) break;
        }
      }

      if (!matchedContainer) throw new Error('No GTM container matching "' + websiteDomain + '" or "' + practiceName + '"');

      // Add team as PUBLISH (admin) + SA as READ
      var gtmAdds = [];

      for (var ti = 0; ti < TEAM_OWNERS.length; ti++) {
        (function(email) {
          gtmAdds.push({ email: email, role: 'PUBLISH', promise: tryAdd('GTM admin ' + email, function() {
            return fetch('https://tagmanager.googleapis.com/tagmanager/v2/' + matchedGtmAccount.path + '/user_permissions', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + gtmToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                emailAddress: email,
                accountAccess: { permission: 'ADMIN' },
                containerAccess: [{ containerId: matchedContainer.containerId, permission: 'PUBLISH' }]
              })
            });
          })});
        })(TEAM_OWNERS[ti]);
      }

      gtmAdds.push({ email: SA_EMAIL, role: 'READ', promise: tryAdd('GTM SA read', function() {
        return fetch('https://tagmanager.googleapis.com/tagmanager/v2/' + matchedGtmAccount.path + '/user_permissions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + gtmToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailAddress: SA_EMAIL,
            accountAccess: { permission: 'NO_ACCESS' },
            containerAccess: [{ containerId: matchedContainer.containerId, permission: 'READ' }]
          })
        });
      })});

      var gtmResults = await Promise.all(gtmAdds.map(function(a) { return a.promise; }));
      for (var gri = 0; gri < gtmAdds.length; gri++) {
        gtmAdds[gri].result = gtmResults[gri];
        delete gtmAdds[gri].promise;
      }

      // Verify - list user permissions
      var gtmVerifyResp = await fetch('https://tagmanager.googleapis.com/tagmanager/v2/' + matchedGtmAccount.path + '/user_permissions', {
        headers: { 'Authorization': 'Bearer ' + gtmToken }
      });
      var gtmVerifyData = await gtmVerifyResp.json();
      var currentPerms = (gtmVerifyData.userPermission || []).map(function(p) { return { email: p.emailAddress, account: p.accountAccess ? p.accountAccess.permission : null }; });

      var allGtmSucceeded = gtmAdds.every(function(a) { return a.result.added; });

      results.gtm = {
        success: allGtmSucceeded,
        container_name: matchedContainer.name,
        container_id: matchedContainer.containerId,
        account: matchedGtmAccount.name,
        users_added: gtmAdds,
        current_users: currentPerms,
        verified: currentPerms.some(function(p) { return p.email === SA_EMAIL; })
      };

      gtmAdds.forEach(function(a) { if (a.result.error) errors.push(a.result.error); });

    } catch (e) {
      errors.push('GTM: ' + e.message);
      results.gtm = { success: false, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LocalFalcon: Search + add location
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('localfalcon')) {
    try {
      if (!lfKey) throw new Error('LOCALFALCON_API_KEY not configured');

      if (config.localfalcon_place_id) {
        results.localfalcon = { success: true, place_id: config.localfalcon_place_id, already_configured: true, verified: true };
      } else {
        var city = contact.city || '';
        var state = contact.state || contact.province || '';
        var proximity = [city, state].filter(Boolean).join(', ');

        // Search
        var lfSearchResp = await fetch('https://api.localfalcon.com/v2/locations/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'api_key=' + lfKey + '&name=' + encodeURIComponent(practiceName) + (proximity ? '&proximity=' + encodeURIComponent(proximity) : '')
        });
        var lfSearchData = await lfSearchResp.json();
        var lfResults = (lfSearchData.data && lfSearchData.data.results) || [];

        if (lfResults.length === 0) {
          // Check saved locations
          var lfSavedResp = await fetch('https://api.localfalcon.com/v1/locations/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'api_key=' + lfKey + '&query=' + encodeURIComponent(practiceName) + '&limit=5'
          });
          var lfSavedData = await lfSavedResp.json();
          var savedLocs = (lfSavedData.data && lfSavedData.data.locations) || [];
          var nameMatch = savedLocs.find(function(l) {
            return (l.name || '').toLowerCase().indexOf(practiceName.toLowerCase()) >= 0;
          });
          if (nameMatch) {
            configUpdates.localfalcon_place_id = nameMatch.place_id;
            results.localfalcon = { success: true, place_id: nameMatch.place_id, location_name: nameMatch.name, already_saved: true, verified: true };
          } else {
            throw new Error('No results for "' + practiceName + '"' + (proximity ? ' near ' + proximity : '') + '. Try adding manually in LocalFalcon dashboard.');
          }
        } else {
          var best = lfResults[0];
          var lfAddResp = await fetch('https://api.localfalcon.com/v2/locations/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'api_key=' + lfKey + '&platform=google&place_id=' + encodeURIComponent(best.place_id)
          });
          var lfAddData = await lfAddResp.json();
          if (!lfAddData.success) throw new Error('Add failed: ' + (lfAddData.message || 'unknown'));

          configUpdates.localfalcon_place_id = best.place_id;
          results.localfalcon = { success: true, place_id: best.place_id, location_name: best.name, address: best.address, added: true, verified: true };
        }
      }
    } catch (e) {
      errors.push('LocalFalcon: ' + e.message);
      results.localfalcon = { success: false, error: e.message };
    }
  }

  // ─── Save config updates ───────────────────────────────────────
  if (Object.keys(configUpdates).length > 0) {
    try {
      configUpdates.updated_at = new Date().toISOString();
      await fetch(sbUrl + '/rest/v1/report_configs?client_slug=eq.' + clientSlug, {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(configUpdates)
      });
    } catch (e) {
      errors.push('Config save: ' + e.message);
    }
  }

  // ─── Update deliverable statuses ───────────────────────────────
  try {
    var deliverableMap = {
      localfalcon: 'localfalcon_setup',
      gbp: 'gbp_service_account',
      ga4: 'ga4_setup',
      gtm: 'gtm_setup'
    };
    for (var svc in deliverableMap) {
      if (results[svc] && results[svc].success && results[svc].verified !== false) {
        await fetch(sbUrl + '/rest/v1/deliverables?contact_id=eq.' + contact.id + '&deliverable_type=eq.' + deliverableMap[svc] + '&status=neq.delivered', {
          method: 'PATCH', headers: sbHeaders(),
          body: JSON.stringify({
            status: 'delivered',
            delivered_at: new Date().toISOString(),
            notes: 'Auto-configured by bootstrap-access. ' + JSON.stringify(results[svc]).substring(0, 200),
            updated_at: new Date().toISOString()
          })
        });
      }
    }
  } catch (e) {
    errors.push('Deliverable update: ' + e.message);
  }

  return res.status(200).json({
    success: errors.length === 0,
    client_slug: clientSlug,
    practice_name: practiceName,
    results: results,
    config_updates: configUpdates,
    errors: errors
  });
};


// ═══════════════════════════════════════════════════════════════════
// Helper: Get access token via domain-wide delegation
// ═══════════════════════════════════════════════════════════════════
async function getDelegatedToken(saJson, impersonateEmail, scope) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) {
      throw new Error('SA JSON missing private_key or client_email');
    }
    var crypto = require('crypto');

    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: impersonateEmail,
      scope: scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })).toString('base64url');

    var signable = header + '.' + claims;
    var signer = crypto.createSign('RSA-SHA256');
    signer.update(signable);
    var signature = signer.sign(sa.private_key, 'base64url');

    var jwt = signable + '.' + signature;

    var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));
    }
    return tokenData.access_token;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

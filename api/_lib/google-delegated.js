// api/_lib/google-delegated.js
// Shared helpers for getting Google API access tokens via the
// reporting@moonraker-client-hq.iam.gserviceaccount.com service account.
//
// Two modes:
//   getDelegatedAccessToken(mailbox, scope) — domain-wide delegation
//     impersonates a Google Workspace user (e.g. calls@moonraker.ai,
//     chris@moonraker.ai). Use for Gmail and for GSC properties owned
//     by users rather than the SA.
//
//   getServiceAccountToken(scope) — direct SA token (no impersonation).
//     Use for Google APIs where the SA itself has been granted access
//     (e.g. GSC properties where the SA email is added as a user).

var nodeCrypto = require('crypto');

var _tokenCache = {};   // keyed by `${mailbox || 'sa'}|${scope}`

function loadServiceAccount() {
  var raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var missing');
  var sa;
  try { sa = JSON.parse(raw); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('Service account JSON missing client_email or private_key');
  }
  return sa;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function exchangeJwt(jwt) {
  var resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt)
  });
  var data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('Token exchange failed: ' + (data.error_description || data.error || resp.status));
  }
  return data;
}

async function getDelegatedAccessToken(mailbox, scope) {
  if (!mailbox) throw new Error('mailbox required for delegated token');
  var cacheKey = mailbox + '|' + scope;
  var cached = _tokenCache[cacheKey];
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  var sa = loadServiceAccount();
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claims = {
    iss: sa.client_email,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
    sub: mailbox
  };
  var signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  var signer = nodeCrypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  var signature = signer.sign(sa.private_key);
  var jwt = signingInput + '.' + b64url(signature);

  var data = await exchangeJwt(jwt);
  _tokenCache[cacheKey] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  return data.access_token;
}

async function getServiceAccountToken(scope) {
  var cacheKey = 'sa|' + scope;
  var cached = _tokenCache[cacheKey];
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  var sa = loadServiceAccount();
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claims = {
    iss: sa.client_email,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  var signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  var signer = nodeCrypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  var signature = signer.sign(sa.private_key);
  var jwt = signingInput + '.' + b64url(signature);

  var data = await exchangeJwt(jwt);
  _tokenCache[cacheKey] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  return data.access_token;
}

// Try a list of impersonation users in order, return first one that succeeds.
// Used for GSC properties — different clients have different owner accounts.
async function getFirstWorkingImpersonation(mailboxes, scope, testFn) {
  var lastErr;
  for (var i = 0; i < mailboxes.length; i++) {
    try {
      var token = await getDelegatedAccessToken(mailboxes[i], scope);
      var ok = await testFn(token);
      if (ok) return { token: token, mailbox: mailboxes[i] };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No impersonation user worked');
}

module.exports = {
  getDelegatedAccessToken: getDelegatedAccessToken,
  getServiceAccountToken: getServiceAccountToken,
  getFirstWorkingImpersonation: getFirstWorkingImpersonation
};

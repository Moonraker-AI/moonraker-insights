// api/_lib/auth.js
// Shared authentication module for all admin API routes.
//
// Verifies Supabase Auth ES256 JWTs locally using cached JWKS public keys.
// No network call needed per request (only on cold start or key rotation).
//
// Flow:
//   1. Extract JWT from Authorization header
//   2. Fetch JWKS public key (cached in-memory across warm invocations)
//   3. Verify ES256 signature + expiry locally
//   4. Check admin_profiles membership
//
// Usage:
//   var auth = require('./_lib/auth');
//   var user = await auth.requireAdmin(req, res);
//   if (!user) return;

var nodeCrypto = require('crypto');
var sb = require('./supabase');

// ── JWKS cache (persists across warm invocations) ─────────────────

var _jwksCache = null;        // { keys: { kid: KeyObject }, fetchedAt: timestamp }
var JWKS_MAX_AGE = 300000;    // Re-fetch JWKS every 5 minutes at most
var JWKS_URL = null;

function getJwksUrl() {
  if (!JWKS_URL) JWKS_URL = sb.url() + '/auth/v1/.well-known/jwks.json';
  return JWKS_URL;
}

// Fetch JWKS and convert to Node KeyObjects, keyed by kid
async function fetchJwks() {
  var resp = await fetch(getJwksUrl());
  if (!resp.ok) throw new Error('JWKS fetch failed: ' + resp.status);

  var data = await resp.json();
  if (!data.keys || !Array.isArray(data.keys)) throw new Error('Invalid JWKS response');

  var keys = {};
  for (var i = 0; i < data.keys.length; i++) {
    var jwk = data.keys[i];
    if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
      try {
        keys[jwk.kid] = nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' });
      } catch (e) {
        console.error('[auth] Failed to import JWK kid=' + jwk.kid + ':', e.message);
      }
    }
  }

  _jwksCache = { keys: keys, fetchedAt: Date.now() };
  return keys;
}

// Get cached keys or fetch fresh
async function getKeys(forceRefresh) {
  if (!forceRefresh && _jwksCache && (Date.now() - _jwksCache.fetchedAt) < JWKS_MAX_AGE) {
    return _jwksCache.keys;
  }
  return fetchJwks();
}

// ── Base64url helpers ─────────────────────────────────────────────

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ── JWT verification ──────────────────────────────────────────────

async function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;

  var parts = token.split('.');
  if (parts.length !== 3) return null;

  // Decode header to get kid
  var header;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  } catch (e) { return null; }

  if (header.alg !== 'ES256' || !header.kid) return null;

  // Get the public key for this kid
  var keys = await getKeys(false);
  var publicKey = keys[header.kid];

  // If key not found, try refreshing JWKS (key rotation scenario)
  if (!publicKey) {
    keys = await getKeys(true);
    publicKey = keys[header.kid];
    if (!publicKey) return null;
  }

  // Verify ES256 signature
  var signingInput = parts[0] + '.' + parts[1];
  var signature = b64urlDecode(parts[2]);

  // ES256 JWTs use raw R||S format (64 bytes), but Node expects DER
  // Convert raw signature to DER format
  var derSig = rawToDer(signature);

  var valid = nodeCrypto.verify(
    'sha256',
    Buffer.from(signingInput),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature
  );

  if (!valid) {
    // Try with refreshed keys (in case of key rotation mid-flight)
    keys = await getKeys(true);
    publicKey = keys[header.kid];
    if (!publicKey) return null;

    valid = nodeCrypto.verify(
      'sha256',
      Buffer.from(signingInput),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature
    );
    if (!valid) return null;
  }

  // Decode and validate payload
  var payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (e) { return null; }

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// Convert raw R||S (64 bytes) to DER format for ECDSA
// Not needed when using dsaEncoding: 'ieee-p1363', but kept for reference
function rawToDer(raw) {
  return raw; // Node handles ieee-p1363 natively
}

// ── Token extraction ──────────────────────────────────────────────

function extractToken(req) {
  var auth = req.headers.authorization || req.headers.Authorization || '';
  if (auth.startsWith('Bearer ')) {
    var token = auth.slice(7).trim();
    if (token.length > 0) return token;
  }
  return null;
}

// ── Admin profile cache (per-invocation) ──────────────────────────

var _profileCache = {};

async function getAdminProfile(userId) {
  if (_profileCache[userId]) return _profileCache[userId];
  try {
    var profile = await sb.one(
      'admin_profiles?id=eq.' + userId + '&select=id,email,display_name,role&limit=1'
    );
    if (profile) _profileCache[userId] = profile;
    return profile;
  } catch (e) {
    console.error('[auth] Admin profile lookup failed:', e.message);
    return null;
  }
}

// ── Main middleware ────────────────────────────────────────────────

async function requireAdmin(req, res) {
  var token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  var payload = await verifyJwt(token);
  if (!payload || !payload.sub) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  var profile = await getAdminProfile(payload.sub);
  if (!profile) {
    res.status(403).json({ error: 'Not authorized. Admin access required.' });
    return null;
  }

  // Update last_login_at (fire-and-forget)
  sb.mutate(
    'admin_profiles?id=eq.' + payload.sub,
    'PATCH',
    { last_login_at: new Date().toISOString() },
    'return=minimal'
  ).catch(function() {});

  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
    name: profile.display_name
  };
}

module.exports = {
  verifyJwt: verifyJwt,
  extractToken: extractToken,
  requireAdmin: requireAdmin
};

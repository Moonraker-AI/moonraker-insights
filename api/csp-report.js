// CSP violation collector.
// Receives browser report-to / report-uri payloads, filters extension noise,
// logs to stdout (Vercel captures). Fail-open: any exception still returns 204.

var rateLimit = require('./_lib/rate-limit');

// API-L6: unauthenticated endpoint. Cap body size and rate-limit per IP so
// attackers cannot flood it. Both guards run BEFORE the existing fail-open
// handler body so rejections surface as 413/429 instead of a silent 204.
const MAX_BODY_BYTES = 16 * 1024; // 16 KB

const IGNORED_SOURCES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-extension://',
  'safari-web-extension://',
  'webkit-masked-url:',
  'about:blank'
];

function isExtensionNoise(blockedUri, sourceFile) {
  const v = String(blockedUri || '') + ' ' + String(sourceFile || '');
  return IGNORED_SOURCES.some(p => v.indexOf(p) !== -1);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  // API-L6: size cap (Content-Length header + post-parse fallback).
  var contentLength = parseInt(req.headers && req.headers['content-length'], 10);
  if (!isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Payload too large' });
  }

  // API-L6: per-IP rate limit. failClosed: false so a rate-limit store outage
  // does not take the CSP collector down with it (matches existing fail-open posture).
  try {
    var ip = rateLimit.getIp(req);
    var rl = await rateLimit.check('ip:' + ip + ':csp-report', 60, 60, { failClosed: false });
    if (rl && rl.allowed === false) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
  } catch (_) { /* fail-open on rate-limiter errors */ }

  try {
    // Body can be application/csp-report, application/reports+json, or application/json
    let body = req.body;
    if (!body) body = {};
    if (typeof body === 'string') {
      // API-L6 post-parse size fallback when Content-Length was missing/lying.
      if (body.length > MAX_BODY_BYTES) {
        return res.status(413).json({ error: 'Payload too large' });
      }
      try { body = JSON.parse(body); } catch (_) { body = { raw: body }; }
    }

    // Normalize: legacy report-uri uses { 'csp-report': {...} }; Reporting API uses an array
    const reports = Array.isArray(body) ? body : [body['csp-report'] ? { type: 'csp-violation', body: body['csp-report'] } : body];

    for (const r of reports) {
      const payload = r && r.body ? r.body : r;
      const blockedUri = payload && (payload['blocked-uri'] || payload.blockedURL || payload.blockedUri);
      const sourceFile = payload && (payload['source-file'] || payload.sourceFile);
      if (isExtensionNoise(blockedUri, sourceFile)) continue;

      const summary = {
        ts: new Date().toISOString(),
        ua: (req.headers && req.headers['user-agent']) || null,
        ref: (req.headers && req.headers['referer']) || null,
        violated: payload && (payload['violated-directive'] || payload.effectiveDirective || payload.violatedDirective),
        blocked: blockedUri,
        source: sourceFile,
        doc: payload && (payload['document-uri'] || payload.documentURL),
        line: payload && (payload['line-number'] || payload.lineNumber),
        sample: payload && (payload['script-sample'] || payload.sample)
      };
      console.error('[csp-violation]', JSON.stringify(summary));
    }
  } catch (e) {
    console.error('[csp-report handler error]', e && e.message);
  }
  res.status(204).end();
};

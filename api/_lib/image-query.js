// api/_lib/image-query.js
// Shared helper for building Pexels-friendly search queries from newsletter image suggestions.
// Strips brand/initialism terms and appends a topical anchor when the query is thin.

// Brand names, initialisms, and news artifacts that confuse Pexels's visual search.
// Keep this in lower-case. Matching is word-level.
var STOP_TERMS = [
  // Tech brands
  'google','meta','facebook','instagram','tiktok','twitter','youtube','linkedin',
  'snapchat','pinterest','whatsapp','apple','microsoft','amazon','netflix',
  'openai','anthropic','claude','chatgpt','gpt','gemini','nano','banana','turboquant',
  // Regulatory / gov initialisms
  'hipaa','medicare','medicaid','ftc','ocr','hhs','crtc','gbp','ehr','fda','cms',
  'phipa','nhs','hipaaa','prsa','dpa','gdpr','ccpa','cpra',
  // Internet/tech terms that return wrong imagery
  'seo','sem','ppc','api','sdk','url','ui','ux','cms','crm','saas','erp','app','apps',
  'kpi','kpis','roi','algorithm','dataset','backlink','serp','serps','crawlable',
  // News artifacts
  'update','updates','announced','released','breaking','report','reports','reported',
  'announces','update','policy','legislation','act','bill','rule','ruling',
  // Dates
  'january','february','march','april','may','june','july','august','september',
  'october','november','december','monday','tuesday','wednesday','thursday','friday',
  // Generic filler from image_suggestion prompts
  'representing','depicting','showing','featuring','illustrating','captures',
  'capturing','symbolizing','suggesting','conveying','surfacing',
  'with','and','the','for','from','that','this','these','those','such','their',
  'close','closeup','overhead','above','below','beside','next'
];

var STOP_SET = {};
for (var i = 0; i < STOP_TERMS.length; i++) STOP_SET[STOP_TERMS[i]] = true;

// Topical anchors. When the cleaned query is very short, we append one of these
// to keep Pexels results on-brand (office/professional/therapy imagery).
// Rotates so different stories in the same edition don't all get identical anchors.
var ANCHORS = [
  'therapist office',
  'professional desk',
  'counselor workspace',
  'home office laptop',
  'therapy practice'
];

function pickAnchor(seed) {
  var n = typeof seed === 'number' ? seed : (seed ? String(seed).length : 0);
  return ANCHORS[Math.abs(n) % ANCHORS.length];
}

// Convert a free-form image suggestion into a clean Pexels query.
// - Strip punctuation
// - Drop STOP_TERMS
// - Drop digits-only tokens and very-short tokens
// - Deduplicate while preserving order
// - Append a topical anchor if fewer than 3 useful tokens remain
function cleanQuery(suggestion, seed) {
  if (!suggestion) return '';
  var normalized = String(suggestion).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  var tokens = normalized.split(/\s+/).filter(Boolean);
  var seen = {};
  var cleaned = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (t.length < 3) continue;
    if (/^\d+$/.test(t)) continue;
    if (STOP_SET[t]) continue;
    if (seen[t]) continue;
    seen[t] = true;
    cleaned.push(t);
  }
  // Cap total tokens (Pexels ignores overly long queries)
  if (cleaned.length > 8) cleaned = cleaned.slice(0, 8);
  // If too thin, append a topical anchor
  if (cleaned.length < 3) {
    cleaned.push(pickAnchor(seed));
  }
  return cleaned.join(' ');
}

module.exports = { cleanQuery: cleanQuery };

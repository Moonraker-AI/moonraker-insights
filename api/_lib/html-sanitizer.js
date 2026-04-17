// api/_lib/html-sanitizer.js
// Server-side HTML sanitization — two modes:
//
//   sanitizeText(s)        — strict: returns plain text. Strips every angle-
//                            bracketed tag, decodes numeric + named entities,
//                            normalizes whitespace. Use for user-submitted
//                            free-text fields (endorsement.content, etc.) that
//                            should never contain markup.
//
//   sanitizeHtml(s, opts)  — allowlist: returns HTML with only safe tags and
//                            attributes. Strips <script>, <iframe>, <object>,
//                            <embed>, event handlers (onclick etc.), and
//                            javascript:/data: URLs. Use for AI-generated
//                            output that we want to keep as HTML before
//                            publishing to a public page.
//
// No external deps. Written so it fails safe — if parsing goes sideways on a
// weird input, the worst case is over-stripping, never under-stripping.
// That's intentional: this runs on the content-page deploy path where stored
// XSS on a client's published site is catastrophic and any stripped-too-hard
// artifact is visible to Chris in the preview before it goes live.

// ── sanitizeText ──────────────────────────────────────────────────────

function sanitizeText(s, maxLen) {
  if (s == null) return '';
  var str = String(s);

  // Strip tags. Greedy across newlines so pathological <x\n>...</x> blocks go.
  str = str.replace(/<[^>]*>/g, ' ');

  // Decode entities. Loop until stable so nested encodings unwind:
  // "&amp;lt;script&amp;gt;" → "&lt;script&gt;" → "<script>" → caught by the
  // next tag-strip below.
  for (var i = 0; i < 5; i++) {
    var before = str;
    str = decodeEntities(str);
    if (str === before) break;
  }

  // Second tag-strip catches anything that was hiding inside entities.
  str = str.replace(/<[^>]*>/g, ' ');

  // Kill remaining stray angle brackets — they're either a failed-parse edge
  // case or a user trying to defeat the regex. Either way, safer gone.
  str = str.replace(/[<>]/g, '');

  // Kill null bytes and other control chars (except tab/newline/carriage).
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Collapse whitespace runs.
  str = str.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (maxLen && str.length > maxLen) str = str.slice(0, maxLen).trim();

  return str;
}

// ── sanitizeHtml (allowlist) ──────────────────────────────────────────

// Tags that survive sanitization. Everything else gets its tags stripped
// (content between them is preserved as text). Chosen to cover what Claude
// writes into generated content pages: structural markup, headings, lists,
// links, inline emphasis, images.
var DEFAULT_ALLOWED_TAGS = [
  'html','head','body','meta','title','link','style',
  'main','section','article','header','footer','nav','aside','figure','figcaption',
  'div','span','p','br','hr',
  'h1','h2','h3','h4','h5','h6',
  'strong','em','b','i','u','small','sup','sub',
  'ul','ol','li','dl','dt','dd',
  'blockquote','cite','q',
  'a','img','picture','source',
  'table','thead','tbody','tfoot','tr','th','td','caption',
  'pre','code',
  'svg','path','circle','rect','line','polyline','polygon','g','defs','use','title'
];

// Attributes we keep on surviving tags. Everything else is dropped —
// especially all on*=... event handlers.
var DEFAULT_ALLOWED_ATTRS = {
  '*':    ['id','class','style','lang','dir','role','aria-label','aria-labelledby','aria-describedby','aria-hidden','title','data-*'],
  'a':    ['href','target','rel'],
  'img':  ['src','alt','width','height','loading','srcset','sizes'],
  'source': ['src','srcset','type','media','sizes'],
  'link': ['rel','href','as','type','crossorigin'],
  'meta': ['name','content','charset','property','http-equiv'],
  'td':   ['colspan','rowspan','scope'],
  'th':   ['colspan','rowspan','scope'],
  'svg':  ['viewBox','width','height','xmlns','fill','stroke','stroke-width','preserveAspectRatio'],
  'path': ['d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin'],
  'circle': ['cx','cy','r','fill','stroke'],
  'rect': ['x','y','width','height','fill','stroke','rx','ry'],
  'line': ['x1','y1','x2','y2','stroke','stroke-width'],
  'polyline': ['points','fill','stroke','stroke-width'],
  'polygon':  ['points','fill','stroke','stroke-width'],
  'g':    ['transform','fill','stroke'],
  'use':  ['href','x','y','width','height']
};

// URL schemes we allow on href/src. Anything else (javascript:, data:, vbscript:)
// gets the attribute dropped entirely.
var SAFE_URL_SCHEMES = ['http:','https:','mailto:','tel:','#','/','./','../'];

function sanitizeHtml(input, opts) {
  if (input == null) return '';
  opts = opts || {};
  var allowedTags  = opts.allowedTags  || DEFAULT_ALLOWED_TAGS;
  var allowedAttrs = opts.allowedAttrs || DEFAULT_ALLOWED_ATTRS;

  var tagSet = {};
  allowedTags.forEach(function(t) { tagSet[t.toLowerCase()] = true; });

  var str = String(input);

  // 1. Nuke HTML comments. They can contain conditional IE comments with
  //    script, or be used to hide content from linters.
  str = str.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Nuke entire <script>, <style>, <iframe>, <object>, <embed> blocks
  //    including their contents. Do this BEFORE the tag-level rewrite,
  //    because we want the inner text gone, not preserved.
  //
  //    NOTE: <style> is in the DEFAULT_ALLOWED_TAGS list for full-page
  //    sanitization (content pages use inline <style>). If the caller wants
  //    to strip style blocks too, they pass opts.allowedTags without 'style'.
  var DEADLY_BLOCK_TAGS = ['script','iframe','object','embed','noscript','noframes'];
  DEADLY_BLOCK_TAGS.forEach(function(t) {
    var re = new RegExp('<' + t + '\\b[^>]*>[\\s\\S]*?<\\/' + t + '\\s*>', 'gi');
    str = str.replace(re, '');
    // Also nuke self-closing or unclosed versions.
    var reSelf = new RegExp('<' + t + '\\b[^>]*\\/?>', 'gi');
    str = str.replace(reSelf, '');
  });

  // 3. Walk every remaining tag. Keep if allowlisted, strip otherwise.
  //    Attributes are filtered per-tag.
  str = str.replace(/<(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, function(match, slash, tagName, attrs) {
    var tag = tagName.toLowerCase();
    if (!tagSet[tag]) return '';               // unknown tag → drop whole tag
    if (slash) return '</' + tag + '>';        // closing tag — no attrs
    var cleanAttrs = filterAttrs(tag, attrs, allowedAttrs);
    return '<' + tag + cleanAttrs + '>';
  });

  // 4. Kill lingering stray < or > that slipped through (e.g. inside
  //    mangled entity references). This can over-strip a legitimate
  //    "2 < 3" string; that's the intended safety tradeoff.
  str = str.replace(/<(?![a-zA-Z\/])/g, '&lt;');

  return str;
}

function filterAttrs(tag, rawAttrs, allowedAttrs) {
  if (!rawAttrs) return '';

  var perTag = allowedAttrs[tag] || [];
  var anyTag = allowedAttrs['*']  || [];
  var globalSet = {}, tagSet = {};
  anyTag.forEach(function(a) { globalSet[a.toLowerCase()] = true; });
  perTag.forEach(function(a) { tagSet[a.toLowerCase()]   = true; });
  var allowsDataStar = anyTag.indexOf('data-*') !== -1;

  var out = '';
  // Match name="value" | name='value' | name=value | name
  var attrRe = /\s*([a-zA-Z_:][a-zA-Z0-9_:.\-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  var m;
  while ((m = attrRe.exec(rawAttrs)) !== null) {
    var name = m[1].toLowerCase();
    var value = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : null));

    // Kill event handlers regardless of allowlist. Defense in depth.
    if (/^on/i.test(name)) continue;
    // Kill any attribute whose name starts with 'xmlns:' but isn't plain xmlns.
    if (/^xmlns:/i.test(name)) continue;

    // Is this attribute allowed for this tag or globally?
    var ok = globalSet[name] || tagSet[name];
    if (!ok && allowsDataStar && /^data-[a-z0-9-]+$/.test(name)) ok = true;
    if (!ok) continue;

    // URL-bearing attributes need scheme allowlist
    if (name === 'href' || name === 'src' || name === 'action' || name === 'formaction') {
      if (value == null) continue;
      if (!isSafeUrl(value)) continue;
    }

    // style= is allowed but must not contain expression(), url(javascript:), etc.
    if (name === 'style' && value != null) {
      if (/expression\s*\(|javascript\s*:|vbscript\s*:|@import/i.test(value)) continue;
    }

    if (value == null) {
      out += ' ' + name;
    } else {
      // Re-escape the value so quotes/angles in it can't break out.
      out += ' ' + name + '="' + escapeAttrValue(value) + '"';
    }
  }
  return out;
}

function isSafeUrl(url) {
  if (!url) return false;
  var trimmed = String(url).trim();
  // Allow fragment / relative paths
  if (trimmed.charAt(0) === '#') return true;
  if (trimmed.charAt(0) === '/' || trimmed.charAt(0) === '.') return true;
  // Allow mailto:/tel:/http(s):
  var m = trimmed.match(/^([a-z][a-z0-9+.\-]*):/i);
  if (!m) return true;  // no scheme = relative = fine
  var scheme = m[1].toLowerCase() + ':';
  return SAFE_URL_SCHEMES.indexOf(scheme) !== -1;
}

function escapeAttrValue(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── entity decoder (minimal; sanitizeText only) ──────────────────────

// Named entities we care about. Full HTML5 set is ~2000 entries — we only
// need enough to catch sneaky encodings of markup chars. Anything missing
// gets left as literal text, which is safe.
var NAMED_ENTS = {
  'lt':   '<',   'gt':  '>',   'amp':  '&',
  'quot': '"',   'apos':"'",   'nbsp':' ',
  'copy': '©',   'reg': '®',   'trade':'™',
  'hellip':'…',  'mdash':'—',  'ndash':'–',
  'lsquo':'‘',   'rsquo':'’',  'ldquo':'“', 'rdquo':'”'
};

function decodeEntities(s) {
  // Numeric: &#123;  &#x7B;
  s = s.replace(/&#(\d+);?/g, function(m, d) {
    var n = parseInt(d, 10);
    if (isNaN(n) || n < 0 || n > 0x10FFFF) return '';
    return String.fromCodePoint(n);
  });
  s = s.replace(/&#[xX]([0-9a-fA-F]+);?/g, function(m, h) {
    var n = parseInt(h, 16);
    if (isNaN(n) || n < 0 || n > 0x10FFFF) return '';
    return String.fromCodePoint(n);
  });
  // Named
  s = s.replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, function(m, name) {
    return Object.prototype.hasOwnProperty.call(NAMED_ENTS, name) ? NAMED_ENTS[name] : m;
  });
  return s;
}

module.exports = {
  sanitizeText: sanitizeText,
  sanitizeHtml: sanitizeHtml,
  DEFAULT_ALLOWED_TAGS:  DEFAULT_ALLOWED_TAGS,
  DEFAULT_ALLOWED_ATTRS: DEFAULT_ALLOWED_ATTRS
};

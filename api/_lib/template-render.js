// /api/_lib/template-render.js
// Plain-string template renderer. Mustache-compatible subset, ~80 lines, no deps.
// Designed for Pagemaster v2 page templates rendered server-side from
// Supabase content_jsonb + a per-type HTML template file.
//
// Supported syntax:
//
//   {{path.to.value}}        Escaped interpolation (HTML-safe by default).
//                            Returns '' for undefined / null.
//
//   {{{raw.html}}}           Unescaped interpolation. Use only where the
//                            source is trusted (admin-authored rich-text fields,
//                            sanitized via html-sanitizer before storage).
//
//   {{#each items}}...{{/each}}
//                            Iterate. Inside the block, properties of the
//                            current item are accessible directly: {{question}}.
//                            Special vars: {{@index}} (0-based), {{@first}},
//                            {{@last}}.
//
//   {{#if value}}...{{/if}}  Render block when value is truthy. Treats empty
//                            arrays and empty strings as falsy.
//
//   {{#unless value}}...{{/unless}}
//                            Inverse of #if.
//
//   {{> partial_name}}       Inline a partial. Partials are resolved by the
//                            caller via the partials map.
//
// Not supported (intentional):
//   - Inline expressions, math, function calls
//   - Custom helpers (precompute in the data object)
//   - Async resolution (synchronous string in, string out)
//
// Render is pure: same data + same template = same output.

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolvePath(data, path) {
  if (!path) return undefined;
  if (path === '.') return data;
  // Special block-iteration variables
  if (path === '@index' || path === '@first' || path === '@last') {
    return data && data[path];
  }
  var parts = path.split('.');
  var cur = data;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function isTruthy(v) {
  if (v === null || v === undefined || v === false || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  if (typeof v === 'string' && v.length === 0) return false;
  return true;
}

// Parse a template into a token stream, then walk it for rendering.
// Supports nested blocks via a stack-based parse.
function tokenize(template) {
  var tokens = [];
  var re = /\{\{\{([^}]+)\}\}\}|\{\{([#\/>][^}]+|[^}]+)\}\}/g;
  var lastIndex = 0;
  var m;
  while ((m = re.exec(template)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ type: 'text', value: template.substring(lastIndex, m.index) });
    }
    if (m[1]) {
      tokens.push({ type: 'raw', value: m[1].trim() });
    } else {
      var inner = m[2].trim();
      if (inner.charAt(0) === '#') {
        var head = inner.substring(1).trim();
        var spIdx = head.indexOf(' ');
        var op = spIdx === -1 ? head : head.substring(0, spIdx);
        var arg = spIdx === -1 ? '' : head.substring(spIdx + 1).trim();
        tokens.push({ type: 'open', op: op, arg: arg });
      } else if (inner.charAt(0) === '/') {
        tokens.push({ type: 'close', op: inner.substring(1).trim() });
      } else if (inner.charAt(0) === '>') {
        tokens.push({ type: 'partial', name: inner.substring(1).trim() });
      } else {
        tokens.push({ type: 'var', value: inner });
      }
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < template.length) {
    tokens.push({ type: 'text', value: template.substring(lastIndex) });
  }
  return tokens;
}

function renderTokens(tokens, data, partials, startIdx, endIdx) {
  var out = '';
  var i = startIdx;
  while (i < endIdx) {
    var tok = tokens[i];
    if (tok.type === 'text') {
      out += tok.value;
      i++;
    } else if (tok.type === 'var') {
      out += escapeHtml(resolvePath(data, tok.value));
      i++;
    } else if (tok.type === 'raw') {
      var raw = resolvePath(data, tok.value);
      out += (raw === null || raw === undefined) ? '' : String(raw);
      i++;
    } else if (tok.type === 'partial') {
      var partial = partials && partials[tok.name];
      if (partial) {
        out += renderString(partial, data, partials);
      } else {
        out += '<!-- missing partial: ' + escapeHtml(tok.name) + ' -->';
      }
      i++;
    } else if (tok.type === 'open') {
      var closeIdx = findMatchingClose(tokens, i, tok.op);
      if (closeIdx === -1) {
        // Unclosed block — render the open token as text and skip
        out += '<!-- unclosed block: ' + escapeHtml(tok.op) + ' -->';
        i++;
        continue;
      }
      if (tok.op === 'each') {
        var arr = resolvePath(data, tok.arg);
        if (Array.isArray(arr) && arr.length > 0) {
          for (var j = 0; j < arr.length; j++) {
            var item = arr[j];
            var ctx;
            if (item !== null && typeof item === 'object') {
              ctx = Object.assign({}, item, {
                '@index': j,
                '@first': j === 0,
                '@last': j === arr.length - 1,
                '@root': data['@root'] || data,
              });
            } else {
              ctx = {
                '.': item,
                '@index': j,
                '@first': j === 0,
                '@last': j === arr.length - 1,
                '@root': data['@root'] || data,
              };
            }
            out += renderTokens(tokens, ctx, partials, i + 1, closeIdx);
          }
        }
      } else if (tok.op === 'if') {
        if (isTruthy(resolvePath(data, tok.arg))) {
          out += renderTokens(tokens, data, partials, i + 1, closeIdx);
        }
      } else if (tok.op === 'unless') {
        if (!isTruthy(resolvePath(data, tok.arg))) {
          out += renderTokens(tokens, data, partials, i + 1, closeIdx);
        }
      } else {
        // Unknown block, render contents as-is
        out += renderTokens(tokens, data, partials, i + 1, closeIdx);
      }
      i = closeIdx + 1;
    } else if (tok.type === 'close') {
      // Unmatched close — skip
      i++;
    } else {
      i++;
    }
  }
  return out;
}

function findMatchingClose(tokens, openIdx, op) {
  var depth = 1;
  for (var i = openIdx + 1; i < tokens.length; i++) {
    if (tokens[i].type === 'open' && tokens[i].op === op) depth++;
    else if (tokens[i].type === 'close' && tokens[i].op === op) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function renderString(template, data, partials) {
  if (!template) return '';
  var tokens = tokenize(template);
  // Tag root for nested-block @root access
  var rootData = data && typeof data === 'object'
    ? Object.assign({ '@root': data }, data)
    : data;
  return renderTokens(tokens, rootData, partials || {}, 0, tokens.length);
}

module.exports = {
  render: renderString,
  escapeHtml: escapeHtml,
  // Exposed for testing
  _tokenize: tokenize,
  _resolvePath: resolvePath,
};

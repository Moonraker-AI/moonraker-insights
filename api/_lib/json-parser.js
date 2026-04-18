// api/_lib/json-parser.js
//
// Robustly extract and parse a JSON value from text that may be wrapped in
// markdown code fences, surrounded by prose, or contain trailing content.
//
// Closes audit findings M25 (compile-report.js) and L11 (process-entity-audit.js).
// Both sites previously used `text.replace(/```json/g, '').replace(/```/g, '')`
// to strip markdown fences before `JSON.parse`. That approach corrupts JSON
// when a string VALUE contains a nested ```json or ``` substring, because the
// global replace fires anywhere in the text, not only at fence boundaries.
// Example adversarial Claude output that broke the old strip:
//
//     Here is the output:
//     ```json
//     { "note": "See `npm install ```json-parser`...`" }
//     ```
//
// The old strip would remove the backtick-triple sequences inside the string
// value, producing invalid JSON. The bracket-tracker below finds the first
// balanced `{...}` or `[...]` in the text and parses exactly that span,
// respecting JSON string delimiters and backslash escapes so content inside
// strings is never counted toward bracket depth.
//
// Exports:
//   parseFenced(text)   -> parsed object/array
//   extractFenced(text) -> the substring that parseFenced would parse
//                          (useful for debugging or custom error formatting)
//
// Both throw Error on malformed input. parseFenced rethrows JSON.parse errors
// with a prefix so callers can distinguish the extract phase from the parse phase.

module.exports = {
  parseFenced: parseFenced,
  extractFenced: extractFenced
};

function extractFenced(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('parseFenced: input is not a non-empty string');
  }

  // Find the first opening brace or bracket. Anything before it (markdown
  // fences, prose preamble, blank lines) is ignored.
  var start = -1;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch === '{' || ch === '[') {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error('parseFenced: no { or [ found in input');
  }

  // Scan forward tracking nesting depth of {} and [] combined. Respect
  // JSON string delimiters (") and backslash escapes so content inside
  // strings -- including stray `{`, `}`, `[`, `]`, or triple backticks --
  // is not counted toward bracket depth.
  var depth = 0;
  var inString = false;
  var escape = false;

  for (var j = start; j < text.length; j++) {
    var c = text.charAt(j);

    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        return text.substring(start, j + 1);
      }
      if (depth < 0) {
        throw new Error('parseFenced: unbalanced closing bracket at index ' + j);
      }
    }
  }

  throw new Error('parseFenced: unbalanced brackets; no matching close found after index ' + start);
}

function parseFenced(text) {
  var slice = extractFenced(text);
  try {
    return JSON.parse(slice);
  } catch (parseErr) {
    var err = new Error('parseFenced: JSON.parse failed: ' + parseErr.message);
    err.slice = slice;
    throw err;
  }
}

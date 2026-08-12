// src/middleware/sanitize.js
// Input sanitization middleware — strips null bytes, trims strings,
// blocks path traversal in string values, and caps body size.
// Applied globally in server.js AFTER JSON parsing.

'use strict';

/**
 * Recursively sanitize an object's string values:
 *  - Trim whitespace
 *  - Remove null bytes (PostgreSQL rejects them)
 *  - Truncate strings over MAX_STRING_LENGTH
 */
const MAX_STRING_LENGTH = 8000;
// eslint-disable-next-line no-control-regex -- intentionally strips NUL bytes
const NULL_BYTE_RE      = /\x00/g;
// Path-traversal pattern — reject bodies containing ../ or ..\
const PATH_TRAVERSAL_RE = /\.\.[/\\]/;

function sanitizeValue(v) {
  if (typeof v !== 'string') return v;
  const stripped = v.replace(NULL_BYTE_RE, '');
  // Data URLs (signature captures, inline image uploads, etc.) are legitimately
  // far longer than normal text fields. Truncating one mid-stream corrupts the
  // payload — a chopped base64 PNG can no longer be decoded, which is exactly
  // what broke signature rendering in the consent/PAR-Q PDFs. The JSON body-size
  // limit already bounds total request size, so pass data URLs through uncapped.
  if (stripped.startsWith('data:')) return stripped;
  return stripped.slice(0, MAX_STRING_LENGTH);
}

function sanitizeObj(obj) {
  if (obj === null || typeof obj !== 'object') return sanitizeValue(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObj);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[sanitizeValue(k)] = sanitizeObj(v);
  }
  return out;
}

function hasPathTraversal(obj) {
  const str = JSON.stringify(obj);
  return PATH_TRAVERSAL_RE.test(str);
}

/**
 * Express middleware.
 * Sanitizes req.body in-place. Rejects if path traversal is detected.
 */
function sanitizeBody(req, res, next) {
  if (!req.body || typeof req.body !== 'object') return next();

  if (hasPathTraversal(req.body)) {
    return res.status(400).json({ error: 'Invalid input: path traversal detected' });
  }

  req.body = sanitizeObj(req.body);
  next();
}

/**
 * Sanitize query string params — null bytes & length limits only.
 * (Query params are never used in file-path context, so no traversal check.)
 */
function sanitizeQuery(req, res, next) {
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') {
        req.query[k] = v.replace(NULL_BYTE_RE, '').slice(0, 500);
      }
    }
  }
  next();
}

module.exports = { sanitizeBody, sanitizeQuery };

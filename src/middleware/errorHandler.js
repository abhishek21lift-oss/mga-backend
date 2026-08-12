// src/middleware/errorHandler.js
// Centralized error handler. Mount LAST.

const logger = require('../lib/logger');

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.path });
}

/**
 * Turn a violated unique-constraint name into something worth reading.
 *
 * Matching on the constraint rather than parsing err.detail, because detail
 * quotes the offending VALUE — "Key (mobile)=(9876543210) already exists" — and
 * echoing a phone number back is how a duplicate-check becomes a lookup oracle.
 * The constraint name alone says which field, which is all the user needs.
 *
 * Everything here is scoped per organization by migration 149, so "already
 * exists" now means "in this studio" and the copy can say so plainly.
 */
function duplicateMessage(constraint) {
  if (!constraint) return 'Duplicate entry — this record already exists.';
  if (/mobile/.test(constraint)) return 'A client with this mobile number already exists in this studio.';
  if (/email/.test(constraint))  return 'A record with this email already exists in this studio.';
  return 'Duplicate entry — this record already exists.';
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details && { details: err.details }),
    });
  }

  // ISSUE-050: structured responses for PostgreSQL constraint violations
  //
  // 23505 says "something was already taken" but not what, and the bare
  // "Duplicate entry — this record already exists." is close to useless at the
  // point it is read. A studio owner adding a client saw exactly that string,
  // looked at their own empty client list, and concluded the button was
  // broken. Naming the field is the difference between a dead end and an
  // obvious next step ("oh, that number is already on someone's record").
  if (err.code === '23505') {
    return res.status(409).json({
      error: duplicateMessage(err.constraint),
      ...(err.constraint && { constraint: err.constraint }),
    });
  }
  if (err.code === '23514') return res.status(400).json({ error: 'Value violates a data integrity constraint.' });
  if (err.code === '23503') return res.status(409).json({ error: 'Referenced record does not exist.' });
  if (err.code === '22001') return res.status(400).json({ error: 'Value too long for field.' });

  logger.error({ err: err.message, stack: err.stack, method: req.method, url: req.originalUrl }, 'Unhandled error');
  // M-01: never leak internal error details to clients in production
  const message = process.env.NODE_ENV === 'production'
    ? 'An internal error occurred'
    : (err.message || 'Internal server error');
  res.status(500).json({ error: message });
}

module.exports = { HttpError, notFound, errorHandler };

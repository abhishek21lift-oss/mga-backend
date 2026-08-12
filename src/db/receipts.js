// src/db/receipts.js
//
// Concurrency-safe receipt-number generator.
//
// WHY: code paths in payments.js and clients.js (and the since-deleted
// client-actions.js) all built
// receipt numbers with `Date.now()` and `Math.random()`. Under concurrency
// the millisecond timestamp + 4-digit random tail can collide and Postgres
// rejects the insert because `payments.receipt_no` is UNIQUE — surfacing
// as a 500 to the cashier mid-payment.
//
// FIX: draw from a Postgres sequence; format as RCP-YYYYMMDD-NNNNNN. The
// sequence is created lazily on first call (idempotent) so we don't need
// a new migration for existing deployments.
//
// USAGE:
//   const { genReceiptNo } = require('../db/receipts');
//   const receipt = await genReceiptNo(tx); // tx is optional — pool by default

const pool = require('./pool');

async function ensureSequence(client) {
  // CREATE SEQUENCE IF NOT EXISTS is safe to call repeatedly. Postgres ignores
  // the CREATE if the sequence already exists.
  await client.query(`CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 100001`);
}

function pad(n, w) {
  const s = String(n);
  return s.length >= w ? s : '0'.repeat(w - s.length) + s;
}

function todayCompact() {
  const d = new Date();
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1, 2) +
    pad(d.getUTCDate(), 2)
  );
}

async function genReceiptNo(client) {
  const c = client || pool;
  await ensureSequence(c);
  const { rows } = await c.query(`SELECT nextval('receipt_no_seq') AS n`);
  return `RCP-${todayCompact()}-${pad(rows[0].n, 6)}`;
}

module.exports = { genReceiptNo };

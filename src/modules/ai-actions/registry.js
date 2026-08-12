'use strict';
/**
 * The things the assistant is allowed to actually do.
 *
 * Everything here follows one shape, and the shape is the safety property:
 *
 *   resolve(req, params) → { recipients, message, warnings }
 *
 * resolve() is READ-ONLY and it is the only source of recipients. It runs
 * twice: once to build the plan the operator reads, and again at execute time
 * so the run cannot be pointed at anybody the client asked for. Nothing the
 * browser sends is ever treated as a list of people to message — the browser
 * sends parameters, the server decides who that means.
 *
 * Two consequences worth stating out loud:
 *
 *   A caller cannot message another organization's clients by guessing ids,
 *   because it never supplies ids at all. Every query here is org-scoped, and
 *   an org-less user resolves to organization_id = NULL, which matches no rows.
 *
 *   A caller cannot widen the blast radius by editing the request. `days` and
 *   `min_balance` are clamped server-side; asking for 3650 days gets 90.
 *
 * And one honesty rule, which exists because this codebase already had the
 * other kind of bug: if the delivery channel is not configured, that is a
 * warning ON THE PLAN, shown before the operator confirms. Not a surprise in
 * the results afterwards, and never a silent success.
 */

const pool = require('../../db/pool');
const { tenantScope } = require('../../lib/tenant-db');
const { sendText, twilioWhatsappConfigured } = require('../../services/whatsappDelivery');

/** Clamp an incoming number into a range, falling back for junk input. */
function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** How many people one confirmation may reach. A studio roster is hundreds,
 *  not thousands; a plan bigger than this is a mistake somewhere upstream and
 *  should be looked at rather than sent. */
const MAX_RECIPIENTS = 200;

function moneyINR(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** Rows → recipients, dropping anyone we cannot actually reach. Somebody with
 *  no mobile number is not a silent failure at send time; they are excluded
 *  here and counted, so the plan says "12 of 15, 3 have no number". */
function toRecipients(rows) {
  const reachable = [];
  const unreachable = [];
  for (const r of rows) {
    (r.mobile ? reachable : unreachable).push(r);
  }
  return { reachable, unreachable };
}

const ACTIONS = [
  {
    id: 'renewal_reminders',
    title: 'Send renewal reminders',
    /** Leaves the building. The confirmation step is not decoration. */
    outward: true,
    roles: ['admin', 'manager', 'super_admin'],
    describe: (p) => `WhatsApp every active client whose package ends within ${p.days} days`,
    normalize: (body = {}) => ({ days: clampInt(body.days, { min: 1, max: 90, fallback: 7 }) }),

    async resolve(req, params) {
      const scope = tenantScope(req);
      const values = [params.days];
      let where = `deleted_at IS NULL
                   AND status = 'active'
                   AND pt_end_date IS NOT NULL
                   AND pt_end_date::DATE BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::INTERVAL`;
      if (scope.applyFilter) {
        values.push(scope.orgId);
        where += ` AND organization_id = $${values.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, name, mobile, pt_end_date::TEXT,
                (pt_end_date::DATE - CURRENT_DATE)::INT AS days_left
           FROM pt_clients
          WHERE ${where}
          ORDER BY pt_end_date ASC, id ASC
          LIMIT ${MAX_RECIPIENTS}`,
        values,
      );

      const { reachable, unreachable } = toRecipients(rows);
      const warnings = [];
      if (!twilioWhatsappConfigured()) {
        warnings.push('WhatsApp is not configured on this server — nothing will be delivered.');
      }
      if (unreachable.length) {
        warnings.push(`${unreachable.length} matching client${unreachable.length === 1 ? ' has' : 's have'} no mobile number and will be skipped.`);
      }

      return {
        recipients: reachable.map((r) => ({
          id: r.id,
          name: r.name,
          mobile: r.mobile,
          detail: r.days_left === 0 ? 'ends today' : `${r.days_left}d left`,
          body: `Hi ${r.name}, your personal training package ends on ${r.pt_end_date}. Reply here to renew and keep your slot.`,
        })),
        warnings,
      };
    },
  },

  {
    id: 'dues_reminders',
    title: 'Send payment reminders',
    outward: true,
    roles: ['admin', 'manager', 'super_admin'],
    describe: (p) => `WhatsApp every client with a balance over ${moneyINR(p.min_balance)}`,
    normalize: (body = {}) => ({
      min_balance: clampInt(body.min_balance, { min: 1, max: 1_000_000, fallback: 1 }),
    }),

    async resolve(req, params) {
      const scope = tenantScope(req);
      const values = [params.min_balance];
      let where = `deleted_at IS NULL AND balance_amount >= $1`;
      if (scope.applyFilter) {
        values.push(scope.orgId);
        where += ` AND organization_id = $${values.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, name, mobile, balance_amount
           FROM pt_clients
          WHERE ${where}
          ORDER BY balance_amount DESC, id ASC
          LIMIT ${MAX_RECIPIENTS}`,
        values,
      );

      const { reachable, unreachable } = toRecipients(rows);
      const warnings = [];
      if (!twilioWhatsappConfigured()) {
        warnings.push('WhatsApp is not configured on this server — nothing will be delivered.');
      }
      if (unreachable.length) {
        warnings.push(`${unreachable.length} matching client${unreachable.length === 1 ? ' has' : 's have'} no mobile number and will be skipped.`);
      }

      return {
        recipients: reachable.map((r) => ({
          id: r.id,
          name: r.name,
          mobile: r.mobile,
          detail: moneyINR(r.balance_amount),
          body: `Hi ${r.name}, a balance of ${moneyINR(r.balance_amount)} is pending on your training account. Reply here if you'd like a payment link.`,
        })),
        warnings,
      };
    },
  },
];

/**
 * Deliver one plan. Returns a per-recipient result and never throws for a
 * delivery failure — a run where four of twelve failed is a real outcome that
 * has to be reportable, not an exception that loses the other eight.
 *
 * `not_configured` is passed through from the transport rather than being
 * mapped onto 'sent' or onto 'failed'. It is neither: nothing broke, and
 * nothing was delivered.
 */
async function deliver(recipients) {
  const results = [];
  for (const r of recipients) {
    // Sequential on purpose. This is an SMS gateway with per-account rate
    // limits, and a studio-sized list finishes in seconds either way.
    const out = await sendText({ to: r.mobile, body: r.body });
    results.push({ id: r.id, name: r.name, status: out?.status ?? 'failed', error: out?.error ?? null });
  }
  return results;
}

function findAction(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

function canRun(action, user) {
  return Boolean(action && user && action.roles.includes(user.role));
}

/** What this user is allowed to see offered. */
function listFor(user) {
  return ACTIONS.filter((a) => canRun(a, user)).map((a) => ({
    id: a.id, title: a.title, outward: a.outward,
  }));
}

module.exports = { ACTIONS, MAX_RECIPIENTS, findAction, canRun, listFor, deliver, clampInt };

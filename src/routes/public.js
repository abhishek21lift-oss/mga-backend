'use strict';
// Unauthenticated, read-only data for the public marketing site.
//
// Exists because the landing page previously hardcoded BOTH its pricing and its
// social-proof numbers, and both had drifted away from reality:
//   • it advertised ₹999/mo for 30 clients while the system charges ₹1,499/mo
//     with a 5-client cap — a promise the product cannot honour
//   • it claimed 12k+ coaches / 1.4M clients / 9M sessions / 40+ countries
//
// Everything here is aggregate-only. No studio name, client name, revenue
// figure or any other per-tenant value is exposed — this endpoint is reachable
// by anyone on the internet, so it must never become a data-leak surface.

const router = require('express').Router();
const pool = require('../db/pool');
const subscription = require('../lib/subscription');

// Cached briefly: this is hit by every anonymous landing-page view and the
// numbers move slowly. Keeps a traffic spike off the database.
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };

// GET /api/public/plans — the live plan catalogue, priced exactly as checkout
// will price it (launch offer applied while founder slots remain).
router.get('/plans', async (req, res, next) => {
  try {
    const plans = await subscription.getPlans();
    const slots = await subscription.founderSlotsRemaining();
    const priced = plans.map((p) => {
      const { amount, isLaunch } = subscription.effectivePrice(p, slots);
      return {
        code: p.code,
        name: p.name,
        price_inr: p.price_inr,
        effective_price_inr: amount,
        is_launch: isLaunch,
        duration_months: p.duration_months,
        client_limit: p.client_limit,
        best_for: p.best_for,
      };
    });
    res.json({
      data: {
        plans: priced,
        founder_slots_remaining: slots,
        founder_limit: subscription.FOUNDER_LIMIT,
        trial_days: subscription.TRIAL_DAYS,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/public/stats — real platform aggregates.
//
// Deliberately counts only what can be stated truthfully: live studios, active
// clients under management, and sessions delivered. There is no "countries"
// figure because the schema does not record country, and inventing one is how
// the previous numbers came to exist.
router.get('/stats', async (req, res, next) => {
  try {
    if (cache.data && Date.now() - cache.at < CACHE_MS) {
      return res.json({ data: cache.data });
    }

    // NB: organizations has no deleted_at column in this schema — only status.
    const { rows: [row] } = await pool.query(`
      SELECT
        (SELECT count(*) FROM organizations
          WHERE status <> 'suspended')::int                    AS studios,
        (SELECT count(*) FROM trainers
          WHERE status = 'active' AND deleted_at IS NULL)::int  AS trainers,
        (SELECT count(*) FROM pt_clients
          WHERE status = 'active' AND deleted_at IS NULL)::int  AS active_clients,
        (SELECT count(*) FROM pt_sessions
          WHERE status = 'completed')::int                      AS sessions_completed
    `);

    cache = { at: Date.now(), data: row };
    res.json({ data: row });
  } catch (err) { next(err); }
});

module.exports = router;

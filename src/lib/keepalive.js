'use strict';

/**
 * Keepalive scheduling for a host that sleeps when idle.
 *
 * ── Status: INERT on the current deployment ─────────────────────────────────
 *
 * Production is a VPS running docker compose with `restart: unless-stopped`.
 * Nothing spins the containers down, so there is nothing to keep awake, and the
 * box leaves KEEPALIVE_URL unset — which disables all of this. It is kept
 * because the scheduling logic is correct and tested, and a future move to a
 * sleeping host would want it back. The reasoning below is written against the
 * free-tier host this was originally built for: read it as history, not as a
 * description of where the app runs today.
 *
 * Two things make this work that the previous self-ping got wrong.
 *
 * 1. The request has to LEAVE the container. Render spins a free service down
 *    after 15 minutes without inbound traffic, and "inbound" means through
 *    their router. The old ping went to http://localhost:PORT, which never
 *    leaves the box, so it kept the event loop busy and nothing else — the
 *    service still slept. Pinging the service's own PUBLIC url goes out and
 *    comes back through the router, which does count. Render injects
 *    RENDER_EXTERNAL_URL for exactly this sort of thing.
 *
 * 2. It must not run all night. The free tier includes 750 instance-hours a
 *    month and staying awake 24/7 costs roughly 730 of them — no margin, and
 *    any second free service on the account pushes the total over, at which
 *    point everything stops. Pinging only during studio hours costs about 550
 *    and leaves the overnight window to sleep, which nobody is using anyway.
 *    The first visitor after the window opens still pays one cold start.
 *
 * Everything is env-configurable; the defaults suit a studio operating roughly
 * 5am to 11pm India time.
 */

const DEFAULTS = {
  startHour: 5,
  endHour: 23,
  timeZone: 'Asia/Kolkata',
};

/** Hour (0–23) in an arbitrary IANA zone, without pulling in a date library. */
function hourIn(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(date);
  // Defensive mod: some ICU builds render midnight as "24" under h24.
  return parseInt(parts, 10) % 24;
}

/**
 * Is `date` inside the active window? Handles a window that wraps past
 * midnight (e.g. 22 → 6), and treats start === end as "always on".
 */
function isWithinActiveHours(date, { startHour, endHour, timeZone }) {
  const h = hourIn(timeZone, date);
  if (startHour === endHour) return true;
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}

/** Clamp an env-supplied hour to 0–23, falling back when absent or junk. */
function parseHour(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

/**
 * Resolve keepalive config from the environment.
 * Returns { url, startHour, endHour, timeZone }; url is null when there is
 * nothing safe to ping, in which case the caller should stay quiet rather than
 * ping something wrong.
 */
function resolveKeepalive(env = process.env) {
  // An explicit URL wins — it is the escape hatch for non-Render hosting.
  // Otherwise derive from what Render injects. Never fall back to localhost:
  // that is the bug this module exists to fix, and a silent no-op is worse
  // than an obvious disabled state.
  let url = env.KEEPALIVE_URL || null;
  if (!url && env.RENDER_EXTERNAL_URL) {
    url = `${env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/api/health`;
  }

  return {
    url,
    startHour: parseHour(env.KEEPALIVE_START_HOUR, DEFAULTS.startHour),
    endHour: parseHour(env.KEEPALIVE_END_HOUR, DEFAULTS.endHour),
    timeZone: env.KEEPALIVE_TZ || DEFAULTS.timeZone,
  };
}

module.exports = { resolveKeepalive, isWithinActiveHours, hourIn, DEFAULTS };

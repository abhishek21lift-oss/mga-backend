'use strict';

/**
 * Studio-local calendar dates.
 *
 * ── The bug this exists to stop ─────────────────────────────────────────────
 *
 * "Today" was computed as `new Date().toISOString().slice(0, 10)`, which is the
 * date in UTC. The studio is in India (UTC+05:30), so between 00:00 and 05:30
 * IST that string is YESTERDAY. In that window the dashboard queried
 * `pt_sessions WHERE session_date = '<yesterday>'` while the page header — which
 * formats with the BROWSER's locale — printed today's date. A trainer opening
 * the app at 6am saw an empty "Today's Sessions" panel titled with the correct
 * day, and nothing anywhere explained the mismatch.
 *
 * The same applies to SQL. `CURRENT_DATE` is evaluated in the DATABASE session's
 * TimeZone, which was never set and therefore defaulted to UTC — so every
 * `session_date = CURRENT_DATE`, `DATE_TRUNC('month', CURRENT_DATE)` and
 * `created_at::date` rolled over at 05:30 IST too. That half is fixed in
 * src/db/pool.js, which now sets the session TimeZone on every pooled
 * connection; this module is the JavaScript half. Both read APP_TIMEZONE so the
 * two can never drift apart.
 *
 * ── Why a fixed zone and not the browser's ─────────────────────────────────
 *
 * A studio's day is defined by where the studio is, not by where the person
 * looking at the screen happens to be. A trainer checking tomorrow's roster from
 * another country must see the same day boundary the studio operates on, so the
 * zone is server configuration rather than a per-request header.
 */

/** Where the studio operates. Overridable for a deployment in another zone. */
const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

let warned = false;

/**
 * The configured zone, validated once.
 *
 * An unknown zone makes Intl throw a RangeError. Letting that escape would turn
 * a typo in an env var into a 500 on every dashboard request, so a bad value
 * falls back to the default and says so — once, not per call.
 */
function appTimeZone() {
  const configured = process.env.APP_TIMEZONE;
  if (!configured) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: configured });
    return configured;
  } catch {
    if (!warned) {
      warned = true;
      // Required lazily: logger pulls in config that imports this module.
      require('./logger').warn(
        { APP_TIMEZONE: configured, fallback: DEFAULT_TIME_ZONE },
        'APP_TIMEZONE is not a valid IANA time zone — falling back',
      );
    }
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Calendar date as 'YYYY-MM-DD' in `timeZone`.
 *
 * `en-CA` is used because it formats as YYYY-MM-DD natively; building the string
 * from formatToParts would be the same result with more code. Exported with both
 * arguments injectable so the day-boundary behaviour is testable without
 * mocking the clock globally.
 */
function todayIn(timeZone = appTimeZone(), date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(date);
}

/** Today in the studio's zone — the form nearly every caller wants. */
function today(date = new Date()) {
  return todayIn(appTimeZone(), date);
}

/**
 * Today as a three-letter weekday: 'Mon' … 'Sun'.
 *
 * This exact spelling is a storage format, not a display choice.
 * pt_clients.preferred_training_days holds what the enrolment form wrote —
 * `form.trainingDays.join(', ')` over the keys Mon/Tue/Wed/Thu/Fri/Sat/Sun —
 * so "Mon, Wed, Fri" is a literal string in the column. Matching against it
 * means producing the same three letters.
 *
 * `en-US` gives exactly those abbreviations. It is pinned rather than left to
 * the server locale for that reason: a runtime that formatted 'Mon.' or a
 * localised name would match nothing, and would do so silently — the roster
 * would simply come back empty, which is the failure this whole function
 * exists to end.
 */
function todayShortDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: appTimeZone(),
  }).format(date);
}

module.exports = { DEFAULT_TIME_ZONE, appTimeZone, todayIn, today, todayShortDay };

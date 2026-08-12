// Guards on the "clients enrolled to train today" query.
//
// Three properties of that SQL are load-bearing and all three fail SILENTLY if
// someone reformats the query and drops a clause:
//
//   1. the organization_id filter — without it one studio's dashboard lists
//      another studio's clients, which is the single worst bug this product
//      can have;
//   2. the two NOT EXISTS de-duplication clauses — without them a client with
//      a booked slot appears twice in a two-row panel, pushing out the person
//      who actually needs attention;
//   3. exact day matching — a naive LIKE '%Thu%' would match a
//      preferred_training_days of 'Thursday-ish' and roster somebody who does
//      not train today.
//
// None of these throw. None of them make a test fail elsewhere. The panel just
// quietly shows the wrong people, which is indistinguishable from showing the
// right ones unless you know the data. There is no database in this suite (see
// clientPhoto.exposure.test.js for the same constraint), so this reads the SQL
// out of the source and asserts the clauses are still present.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'pt-os', 'pt-os.service.js'),
  'utf8',
);

/** Every SQL template literal passed to pool.query() in the source. */
function queries(src) {
  const out = [];
  const re = /pool\.query\(\s*`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = src.indexOf('`', open + 1);
    if (close === -1) throw new Error('unterminated SQL template literal');
    out.push(src.slice(open + 1, close));
  }
  return out;
}

/** The one query containing all of `needles`. Throws unless exactly one
 *  matches — an ambiguous match means this guard has drifted off the query it
 *  was written to protect, which must fail loudly rather than pass against
 *  the wrong SQL. */
function queryWith(...needles) {
  const hits = queries(SRC).filter((q) => needles.every((n) => q.includes(n)));
  if (hits.length !== 1) {
    throw new Error(`expected 1 query matching ${JSON.stringify(needles)}, found ${hits.length}`);
  }
  return hits[0];
}

const enrolledQuery = () => queryWith('preferred_training_days', 'string_to_array');

describe('the enrolled-today query', () => {
  it('exists at all', () => {
    expect(enrolledQuery()).toContain('FROM pt_clients');
  });

  it('is scoped to one organization', () => {
    // The whole product promise. Asserted on the filtered branch specifically,
    // because the query interpolates it conditionally.
    expect(enrolledQuery()).toContain('c.organization_id = $3');
  });

  it('matches whole day tokens, not substrings', () => {
    // = ANY(string_to_array(...)) is exact. A LIKE would match 'Thursday-ish'
    // and roster a client who does not train today.
    expect(enrolledQuery()).toContain("$2 = ANY(string_to_array(replace(c.preferred_training_days, ' ', ''), ','))");
    expect(enrolledQuery()).not.toMatch(/LIKE/i);
  });

  it('tolerates both "Mon, Wed" and "Mon,Wed"', () => {
    // The form writes ', ' but the column is free text and has been edited by
    // hand; stripping spaces before the split makes both parse identically.
    expect(enrolledQuery()).toContain("replace(c.preferred_training_days, ' ', '')");
  });

  it('excludes clients who already have a booked session today', () => {
    // Otherwise the same person occupies two of the panel's two visible rows.
    const q = enrolledQuery();
    expect(q).toContain('NOT EXISTS');
    expect(q).toContain('FROM pt_sessions s');
    expect(q).toContain('s.session_date = $1');
  });

  it('excludes clients whose programme already covers today', () => {
    const q = enrolledQuery();
    expect(q).toContain('FROM workout_assignments a');
    expect(q).toContain('EXTRACT(ISODOW FROM $1::date)');
  });

  it('leaves out inactive and deleted clients', () => {
    const q = enrolledQuery();
    expect(q).toContain('c.deleted_at IS NULL');
    expect(q).toContain("c.status = 'active'");
  });

  it('orders by a PARSED time, never by the raw text', () => {
    // preferred_workout_time is free text holding two formats — the enrolment
    // dropdown writes '6:00 AM', its custom <input type="time"> writes '06:00'
    // — and as strings '1:00 PM' < '5:00 AM', so a text sort puts the
    // afternoon slot ahead of the dawn one. This shipped that way earlier
    // today; the ordering looked deliberate and was wrong.
    const q = enrolledQuery();
    expect(q).toContain("to_timestamp(trim(c.preferred_workout_time), 'HH12:MI AM')::time");
    expect(q).toContain("c.preferred_workout_time::time");
    expect(q).not.toMatch(/ORDER BY\s+c\.preferred_workout_time NULLS LAST/);
  });

  it('sorts an unparseable time last instead of corrupting the order', () => {
    // Somebody typing "Morning" into the column must not reorder the rows
    // around them.
    expect(enrolledQuery()).toMatch(/END NULLS LAST/);
  });
});

describe('getOpsSummary contract', () => {
  it('returns the new list alongside the two that already existed', () => {
    // The frontend merges all three into one queue; a rename here blanks the
    // panel for exactly the studios this was built for.
    expect(SRC).toContain('today_sessions, today_unscheduled, today_enrolled');
  });

  it('passes the org id as the third parameter when filtering', () => {
    // $1 today, $2 the day token, $3 the org — off-by-one here would compare
    // an org id against a weekday and silently return nothing.
    expect(SRC).toContain('apply ? [today, todayDay, scope.orgId] : [today, todayDay]');
  });
});

// ── Per-trainer session totals ─────────────────────────────────────────────
//
// This query took no parameters at all: it listed every active trainer on the
// PLATFORM, with their session counts, to every studio that loaded a
// dashboard. It sat in the middle of a function whose every other query was
// already scoped, which is exactly how it survived — nothing about the code
// around it looked wrong.
describe('the per-trainer totals query', () => {
  const trainerSessionsQuery = () => queryWith('FROM pt_trainers t', 'LEFT JOIN pt_sessions s');

  it('lists only this organization\'s trainers', () => {
    expect(trainerSessionsQuery()).toContain('t.organization_id = $1');
  });

  it('counts only this organization\'s sessions', () => {
    // Separate from the trainer filter: without it a foreign session whose
    // trainer_id happens to match a local trainer is COUNTED against them, and
    // an inflated number is the last place anyone looks for a tenancy bug.
    expect(trainerSessionsQuery()).toContain('s.organization_id = $1');
  });

  it('filters sessions in the JOIN, never in the WHERE', () => {
    // In the WHERE clause the session filter discards the NULL-extended rows a
    // LEFT JOIN produces, silently making it an INNER JOIN — every trainer
    // with no sessions this month vanishes, which is precisely who a manager
    // is scanning this list for. Asserted by position: the session's org
    // filter must appear before the WHERE keyword.
    const q = trainerSessionsQuery();
    const joinFilter = q.indexOf('s.organization_id = $1');
    const whereAt = q.indexOf('WHERE t.deleted_at');
    expect(joinFilter).toBeGreaterThan(-1);
    expect(whereAt).toBeGreaterThan(-1);
    expect(joinFilter).toBeLessThan(whereAt);
  });

  it('is actually given the org id — it used to take no parameters', () => {
    // pool.query(`…`) with no second argument is what the leak looked like.
    // The template is interpolated with $1, so a missing bindings array would
    // now throw rather than quietly return the platform.
    const src = SRC.slice(SRC.indexOf('FROM pt_trainers t') - 900);
    expect(src).toContain('`, bareParams);');
  });
});

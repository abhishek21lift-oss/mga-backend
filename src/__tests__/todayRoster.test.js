// GET /workout-log/today — who the trainer is training, in the order the day
// happens.
//
// This endpoint used to be an INNER JOIN on workout_assignments, so it could
// only ever answer for clients who already had a programme. A client enrolled
// yesterday with a 6am slot booked and no plan written yet — the single most
// common state for a new client — did not appear at all and could not be
// started from here.
//
// It now unions the three places a studio records that someone is coming in
// (a booked pt_sessions slot, an active programme covering the weekday, an
// enrolment training day) and orders the result by the clock, because that is
// the order the trainer works through the day in and because the dashboard
// card renders the first two rows of exactly this list.
//
// Everything below is guarded at the source. There is no database in this
// suite — see clientPhoto.exposure.test.js for the same constraint — and the
// ordering and the tenancy are both things that fail SILENTLY: a roster in the
// wrong order still looks like a roster.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'pt-os', 'workout-log.routes.js'),
  'utf8',
);

/**
 * The text of a template literal starting at `open`, nested ones included.
 *
 * A naive indexOf('`') stops at the first backtick it meets, and this query
 * interpolates `${org ? \`AND ...\` : ''}` three times — so the naive version
 * returned the first fifth of the SQL and every assertion below it passed or
 * failed for the wrong reason. Tracks `${` depth and steps over escapes.
 */
function templateAt(src, open) {
  let i = open + 1;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
    if (ch === '}' && depth > 0) { depth--; i++; continue; }
    if (ch === '`') {
      if (depth === 0) return src.slice(open + 1, i);
      // A nested literal inside an interpolation — skip to its close.
      const inner = templateAt(src, i);
      i += inner.length + 2;
      continue;
    }
    i++;
  }
  throw new Error('unterminated template literal');
}

/**
 * SQL with its `--` comments stripped.
 *
 * The query explains itself at length, and the prose names the very things
 * these assertions look for — "a LIKE would let 'Thursday-ish' match", "LATERAL
 * with LIMIT 1 because…". Matching against the raw text counts those, so an
 * assertion either passes on a sentence or fails on one, and the only way to
 * make it green is to delete the explanation. Assertions about code read code.
 */
const code = (sql) => sql.replace(/--.*$/gm, '');

/** The roster query — the one with the three-source union in it. */
function rosterQuery() {
  const re = /pool\.query\(\s*`/g;
  let m;
  const hits = [];
  while ((m = re.exec(SRC)) !== null) {
    const q = templateAt(SRC, m.index + m[0].length - 1);
    if (q.includes('WITH candidates AS')) hits.push(q);
  }
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 roster query, found ${hits.length}`);
  }
  return hits[0];
}

describe('all three sources are asked', () => {
  const q = rosterQuery();

  it('includes booked slots', () => {
    expect(q).toContain('FROM pt_sessions s');
    expect(q).toContain('s.session_date = $1::date');
  });

  it('skips a cancelled booking', () => {
    // A cancelled slot is not someone coming in.
    expect(q).toContain("s.status <> 'cancelled'");
  });

  it('includes clients whose programme covers the day', () => {
    expect(q).toContain('FROM workout_assignments wa');
    expect(q).toContain('wa.start_date <= $1::date');
  });

  it('includes clients whose enrolment names the day', () => {
    // Whole-token match: a LIKE would let 'Thursday-ish' match 'Thu'.
    expect(q).toContain("$3 = ANY(string_to_array(replace(c2.preferred_training_days, ' ', ''), ','))");
    expect(code(q)).not.toMatch(/LIKE/i);
  });
});

describe('a client appears once, for the most specific reason', () => {
  const q = rosterQuery();

  it('groups the candidates by client', () => {
    expect(q).toContain('GROUP BY client_id');
  });

  it('keeps the strongest source and the earliest time', () => {
    // source_rank 1 booked < 2 programme < 3 enrolled, so MIN is "most
    // specific". MIN(start_time) keeps a real 6am booking over the 9am the
    // same client's enrolment happens to say.
    expect(q).toContain('MIN(start_time)');
    expect(q).toContain('MIN(source_rank)');
  });

  it('does not fan a client out on two assignments or two logs', () => {
    // Both were real: live data already had a client with two sessions on one
    // date. A plain join turns that into two rows in the roster.
    const sql = code(q);
    expect(sql.match(/LEFT JOIN LATERAL/g) ?? []).toHaveLength(2);
    // One cap per lateral. Without them a second active assignment, or a
    // second log on the same date, splits one client across two rows.
    expect(sql.match(/LIMIT 1/g) ?? []).toHaveLength(2);
  });
});

describe('a client with no programme is still on the list', () => {
  const q = rosterQuery();

  it('reaches the assignment by LEFT JOIN, not INNER', () => {
    // The whole point. An INNER JOIN here is what made a newly enrolled
    // client invisible on the screen a trainer opens on the gym floor.
    const sql = code(q);
    expect(sql).toContain('LEFT JOIN LATERAL');
    // The OUTER reach for the plan must be LEFT. The union's programme branch
    // keeps its INNER join — a programme candidate is defined by having a plan
    // — so this looks only at the join that hangs off the roster.
    expect(sql).toContain('LEFT JOIN workout_plans wp ON wp.id = wa.workout_plan_id');
    expect(sql).not.toMatch(/roster r[\s\S]*?\n\s+JOIN workout_plans/);
  });

  it('counts zero planned exercises rather than returning null', () => {
    expect(q).toContain('COALESCE((SELECT COUNT(*) FROM workout_exercises we');
  });
});

describe('the order is the clock', () => {
  const q = rosterQuery();
  const order = q.slice(q.indexOf('ORDER BY'));

  it('puts timed rows before untimed ones', () => {
    // Nobody has said when an untimed row is, so it cannot be interleaved
    // honestly with rows that have a real time.
    expect(order).toContain('(r.start_time IS NULL)');
    expect(order).toContain('r.start_time');
  });

  it('sinks rest days to the bottom', () => {
    expect(order).toContain('r.source_rank = 2');
    expect(order).toContain('NOT EXISTS');
  });

  it('falls back to the name so the list is stable between refreshes', () => {
    expect(order.trimEnd().endsWith('c.name')).toBe(true);
  });

  it('sorts rest days before the time comparison, not after', () => {
    // Order of the ORDER BY terms is the whole behaviour: a rest day with no
    // time would otherwise land among the untimed programme rows instead of
    // at the end.
    expect(order.indexOf('r.source_rank = 2')).toBeLessThan(order.indexOf('(r.start_time IS NULL)'));
  });
});

describe('the enrolment time is parsed, not string-sorted', () => {
  it('handles both formats the enrolment form writes', () => {
    // The dropdown writes '6:00 AM'; the custom field is an
    // <input type="time"> and writes '06:00'. As strings '1:00 PM' sorts
    // before '5:00 AM', which would put the afternoon slot first.
    expect(SRC).toContain("to_timestamp(trim(c2.preferred_workout_time), 'HH12:MI AM')::time");
    expect(SRC).toContain('c2.preferred_workout_time::time');
  });

  it('yields NULL for anything else', () => {
    // Somebody typing "Morning" must sort last, not reorder their neighbours.
    const parse = SRC.slice(SRC.indexOf('const PREFERRED_TIME'));
    expect(parse.slice(0, 700)).toContain('ELSE NULL');
  });

  it('keeps the other two sources on the same type', () => {
    // A text column mixed into a union with TIME ones would compare as text
    // again and undo the parsing.
    expect(rosterQuery()).toContain('NULL::time');
  });
});

describe('tenancy', () => {
  const q = rosterQuery();

  it('filters every source inside the union, not once at the end', () => {
    // A foreign row entering the candidate set could be grouped against a
    // local client and hand them someone else's appointment time.
    expect(q).toContain('AND s.organization_id =');
    expect(q).toContain('AND wa.organization_id =');
    expect(q).toContain('AND c2.organization_id =');
  });

  it('still limits a plain trainer to their own clients', () => {
    expect(SRC).toContain('AND c.trainer_id = $');
  });
});

describe('the response', () => {
  it('says why each client is on the list', () => {
    // The UI labels the row from this rather than guessing from which fields
    // are null.
    expect(SRC).toContain("source,");
    expect(SRC).toContain("r.source_rank === 1 ? 'booked'");
  });

  it('normalises the time to HH:MM', () => {
    expect(SRC).toContain("String(r.start_time).slice(0, 5)");
  });

  it('only calls a programme client a rest day', () => {
    // Narrowed from `planned === 0`, which was safe while every row came from
    // an assignment. A booked client with no plan also has zero planned
    // exercises, and greying out the one row with a real appointment on it
    // would be the worst possible row to hide.
    expect(SRC).toContain("is_rest_day: source === 'programme' && planned === 0");
  });
});

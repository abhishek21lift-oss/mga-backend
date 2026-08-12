// The client's face has to survive a query rewrite.
//
// photo_url was on pt_clients from the start and almost nothing selected it,
// so a photo uploaded on the profile page appeared on exactly one screen.
// The fix is unglamorous — add one column to four SELECTs — and the failure
// mode is equally unglamorous: someone reformats a query, drops the column,
// and every avatar silently falls back to initials. Nothing throws. No test
// fails. It just quietly goes back to how it was.
//
// So this reads the SQL out of the source and asserts the column is still
// there. It cannot run the queries (no database in CI), which is exactly why
// it guards the text.
'use strict';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** Every SQL template literal passed to pool.query() in a file. */
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

/** The one query in `src` containing all of `needles`. Throws unless exactly
 *  one matches — an ambiguous or missing match means the guard has drifted
 *  off the query it was written to protect, which must fail loudly rather
 *  than pass against the wrong SQL. */
function queryWith(src, ...needles) {
  const hits = queries(src).filter((q) => needles.every((n) => q.includes(n)));
  if (hits.length !== 1) {
    throw new Error(`expected 1 query matching ${JSON.stringify(needles)}, found ${hits.length}`);
  }
  return hits[0];
}

describe('the queries behind a client avatar select photo_url', () => {
  test('the PT clients list — the roster', () => {
    const sql = queryWith(read('modules', 'pt-os', 'pt-os.service.js'), 'FROM pt_clients c', 'total_earned_commission', 'ORDER BY c.name');
    expect(sql).toMatch(/\bc\.photo_url\b/);
  });

  test('ops summary — renewals due and top dues', () => {
    const src = read('modules', 'pt-os', 'pt-os.service.js');
    expect(queryWith(src, "INTERVAL '7 days'", 'days_left')).toMatch(/\bphoto_url\b/);
    expect(queryWith(src, 'due_status', 'ORDER BY balance_amount DESC')).toMatch(/\bphoto_url\b/);
  });

  test('the dues report — both arms of the union, and the outer select', () => {
    const sql = queryWith(read('routes', 'reports.js'), 'UNION ALL', 'FROM clients c');
    // Three: legacy `clients`, `pt_clients`, and the outer SELECT that has to
    // carry it back out of the subquery. Miss the outer one and the column is
    // computed and thrown away.
    expect(sql.match(/photo_url/g) || []).toHaveLength(3);
  });

  test('invoices — joined for the face, scoped so it cannot be a data leak', () => {
    const sql = queryWith(read('routes', 'invoices.js'), 'FROM invoices i', 'AS items', 'ORDER BY i.issue_date DESC');
    expect(sql).toMatch(/pc\.photo_url\s+AS\s+client_photo/);
    // An invoice carries a nullable client_id and a denormalised client_name.
    // Joining on id alone would let a mis-set client_id read a row belonging
    // to another organization, so org equality is part of the join condition
    // itself rather than inherited from the WHERE clause.
    expect(sql).toMatch(/ON\s+pc\.id\s*=\s*i\.client_id/);
    expect(sql).toMatch(/AND\s+pc\.organization_id\s*=\s*i\.organization_id/);
    // And it must stay a LEFT join: an inner one would drop every invoice
    // whose client_id is null, which is what the simplified invoice form
    // creates.
    expect(sql).toMatch(/LEFT JOIN\s+pt_clients\s+pc/);
  });

  test('today\'s workout log — the name that appears on /pt-os/today', () => {
    const src = read('modules', 'pt-os', 'workout-log.routes.js');
    expect(src).toMatch(/c\.photo_url\s+AS\s+client_photo/);
  });
});

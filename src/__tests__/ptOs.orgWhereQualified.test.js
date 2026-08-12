// An org filter in a JOINed query must name its table.
//
// orgWhere() defaults to an UNQUALIFIED column:
//
//   function orgWhere(req, params, col = 'organization_id')
//
// which is right for a single-table query and wrong the moment the query
// joins something that also has an organization_id. Postgres cannot resolve
// it and throws:
//
//   column reference "organization_id" is ambiguous
//
// /api/pt-os/clients/birthdays shipped exactly that. It joins trainers, and
// pt_clients and trainers BOTH have the column, so every single call was a
// 500 — 49 of them in one day. Nothing caught it because the failure needs a
// real database with both tables present: unit tests mock the pool, and a
// mocked pool will happily "run" ambiguous SQL.
//
// So this reads the source instead. For each route handler it collects the
// variables built from an unqualified orgWhere(), then fails if one of them is
// interpolated into a query that contains a SQL JOIN.
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'modules', 'pt-os', 'pt-os.routes.js');

/** Route handlers, split on the router.<verb>( boundary. */
function handlers(src) {
  return src
    .split(/(?=^router\.(?:get|post|put|patch|delete)\()/m)
    .map((block) => {
      const m = block.match(/^router\.(\w+)\('([^']+)'/);
      return m ? { verb: m[1], route: m[2], block } : null;
    })
    .filter(Boolean);
}

/** Template literals handed to pool.query( in a block. */
function queryTemplates(block) {
  const out = [];
  const re = /pool\.query\(\s*`/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = block.indexOf('`', open + 1);
    if (close === -1) break;
    out.push(block.slice(open + 1, close));
  }
  return out;
}

/**
 * A real SQL JOIN, not JavaScript's Array.join.
 *
 * `${LEAD_STATUSES.join(', ')}` inside an error message tripped a first draft
 * of this check and reported two routes that were single-table and fine.
 * Requiring a table name after the keyword is what separates them.
 */
const SQL_JOIN = /\b(?:INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN\s+[a-z_][a-z0-9_]*/i;

function offenders() {
  const src = fs.readFileSync(FILE, 'utf8');
  const found = [];

  for (const { verb, route, block } of handlers(src)) {
    // Variables assigned from an orgWhere() call with no column argument.
    const unqualified = new Set();
    const assign = /const\s+(\w+)\s*=\s*orgWhere\(\s*req\s*,\s*\w+\s*\)/g;
    let m;
    while ((m = assign.exec(block)) !== null) unqualified.add(m[1]);
    if (unqualified.size === 0) continue;

    for (const sql of queryTemplates(block)) {
      if (!SQL_JOIN.test(sql)) continue;
      for (const v of unqualified) {
        if (sql.includes(`\${${v}}`)) {
          found.push(`${verb.toUpperCase()} ${route} — \${${v}} is unqualified in a JOINed query`);
        }
      }
    }
  }
  return found;
}

describe('orgWhere in a JOINed query names its table', () => {
  test('no route interpolates an unqualified org filter into a JOIN', () => {
    // Anything listed here is a guaranteed 500 on every call, in production
    // only, with a message that names no route.
    expect(offenders()).toEqual([]);
  });

  test('the scan can actually see the file it is guarding', () => {
    // Without this, a rename or a changed router style would make the check
    // green by finding nothing at all.
    const src = fs.readFileSync(FILE, 'utf8');
    expect(handlers(src).length).toBeGreaterThan(20);
    expect(src).toContain('orgWhere(');
  });

  test('a SQL JOIN is distinguished from Array.join', () => {
    expect(SQL_JOIN.test('FROM pt_clients c LEFT JOIN trainers t ON t.id = c.trainer_id')).toBe(true);
    expect(SQL_JOIN.test("status must be one of: ${LEAD_STATUSES.join(', ')}")).toBe(false);
  });

  test('birthdays — the route this was written for — is qualified', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    const block = handlers(src).find((h) => h.route === '/clients/birthdays');
    expect(block).toBeDefined();
    expect(block.block).toMatch(/orgWhere\(req, params, 'c\.organization_id'\)/);
  });
});

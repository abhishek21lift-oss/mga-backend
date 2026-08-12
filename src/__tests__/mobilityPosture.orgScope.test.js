// Mobility and posture assessments were the two Screening-section tables that
// missed the 084 tenant-scoping sweep (weekly_checkins/strength_logs/
// progress_photos). Their list route filtered on client_id alone and their
// patch route filtered on id alone — no organization_id guard on either — so
// a caller who knew or guessed another org's client_id, or another org's
// assessment id, could read or edit that org's mobility/posture records.
// Found in a static code audit of the Screening sidebar section; fixed by
// migration 156 (adds + backfills organization_id, same shape as 084) plus
// scoping the GET/POST/PATCH handlers the same way `/goals` already is.
//
// Static rather than a live-database check, same reasoning as
// tenantScope.convention.test.js next door: CI has no live database, and this
// catches the regression on the branch instead of after it ships.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '156_mobility_posture_organization_id.sql');
const ROUTES = path.join(__dirname, '..', 'modules', 'progress', 'progress.routes.js');

describe('migration 156 — mobility/posture organization_id', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  it.each(['pt_mobility_performance_assessments', 'pt_posture_assessments'])(
    'adds an indexed, backfilled organization_id to %s',
    (table) => {
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS organization_id`));
      expect(sql).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS idx_${table}_organization_id ON ${table}\\(organization_id\\)`));
      // Backfilled from the client's own org, same as 084 — not left NULL for
      // every pre-existing row.
      expect(sql).toMatch(new RegExp(`UPDATE ${table}[\\s\\S]*?SET organization_id = c\\.organization_id[\\s\\S]*?FROM pt_clients c`));
    }
  );

  it('is additive — no NOT NULL, no data deleted', () => {
    expect(sql).not.toMatch(/SET NOT NULL/);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/DROP /i);
  });
});

describe('mobility/posture routes are tenant-scoped, matching /goals', () => {
  const src = fs.readFileSync(ROUTES, 'utf8');

  // Isolate each handler's body so a match against one route can't be
  // satisfied by code that belongs to a neighbouring one.
  const handler = (method, path) => {
    const start = src.indexOf(`router.${method}('${path}'`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("}));", start);
    return src.slice(start, end);
  };

  it.each([
    ['get', '/mobility-performance-assessments'],
    ['get', '/posture-assessments'],
  ])('%s %s filters the list by the caller\'s organization', (method, route) => {
    const body = handler(method, route);
    expect(body).toContain('tenantScope(req)');
    expect(body).toMatch(/where\.push\(`organization_id = \$\$\{params\.length\}`\)/);
  });

  it.each([
    ['post', '/mobility-performance-assessments'],
    ['post', '/posture-assessments'],
  ])('%s %s stamps the new row with the caller\'s organization', (method, route) => {
    const body = handler(method, route);
    expect(body).toContain('orgIdOf(req)');
    expect(body).toContain('organization_id');
  });

  it.each([
    ['patch', '/mobility-performance-assessments/:id'],
    ['patch', '/posture-assessments/:id'],
  ])('%s %s only finds a record inside the caller\'s organization', (method, route) => {
    const body = handler(method, route);
    expect(body).toContain('tenantScope(req)');
    expect(body).toMatch(/AND organization_id = \$2/);
  });
});

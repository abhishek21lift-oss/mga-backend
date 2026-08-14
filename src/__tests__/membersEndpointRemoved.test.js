'use strict';
// /api/v1/members is gone, and putting it back has to be a decision.
//
// It served nine routes off a table with no organization_id, so migration 157
// could not cover it at any stage of the RLS rollout — 157 discovers tables BY
// that column. list() had no org predicate for admin or manager either, so the
// endpoint had neither an application-layer nor a database-layer tenant
// boundary. Its four siblings with the same defect were deleted earlier; this
// one was kept because the frontend appeared to call two of its routes.
//
// Both were dead. `member.get` and `member.metrics` are defined in the
// frontend's api barrel and invoked from nowhere. A read-only count against
// production then returned: 0 rows, 0 organisations represented, 0
// attributable rows, 0 conflicting derivations, 0 duplicate member codes, no
// recent activity. So there was nothing to preserve and nothing to migrate.
//
// This test is the guard. Reintroducing the endpoint fails the build until
// someone deletes these assertions, which is the explicit decision the removal
// note asks for — and if it comes back, it must come back with a tenant
// boundary, because the table still has no organization_id.
//
// The TABLE is deliberately untouched. See the last test here.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');

describe('the /api/v1/members endpoint stays removed', () => {
  it('is not mounted', () => {
    // Any express mount of that path, however it is spelled.
    expect(server).not.toMatch(/app\.use\(\s*['"`]\/api\/v1\/members/);
  });

  it('has no module left to mount', () => {
    expect(fs.existsSync(path.join(SRC, 'modules', 'members'))).toBe(false);
  });

  it('is not reachable from anywhere else in the source', () => {
    // A second mount, a proxy, a router re-export — anything that would put
    // the path back without touching server.js.
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;          // comments are fine
          if (/['"`]\/api\/v1\/members/.test(line) || /modules\/members/.test(line)) {
            offenders.push(`${path.relative(SRC, p)}:${i + 1}`);
          }
        });
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('records why, so reinstating it is a decision and not an accident', () => {
    // The guard is only half the mechanism. Someone deleting these assertions
    // should find the reasoning rather than have to reconstruct it.
    const note = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', 'MEMBERS-TENANT-GAP.md'), 'utf8');
    expect(note).toMatch(/organization_id/);
    expect(note).toMatch(/157/);
    expect(server).toMatch(/MEMBERS-TENANT-GAP\.md/);
  });
});

describe('what was deliberately left alone', () => {
  it('no migration drops or alters the members table', () => {
    // The table is empty but not orphaned, and dropping a table was never part
    // of this. A migration doing so would be a separate, larger decision.
    const dir = path.join(SRC, 'db', 'migrations');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      // `members` exactly — not member_memberships, team_members, founder_members.
      if (/\b(DROP\s+TABLE|TRUNCATE)\s+(IF\s+EXISTS\s+)?(public\.)?members\b/i.test(sql)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the table still has the consumers that kept it', () => {
    // renewal.worker.js joins the abandoned v3 members table three times, and
    // member_memberships has a foreign key to it. Both are why the table stays
    // even though the endpoint went.
    //
    // The assertion now names `legacy_members_v3`, because migration 166
    // renamed that table. This is a retarget, not a relaxation, and the
    // distinction matters: the guard still asserts the worker addresses the
    // ABANDONED table and not the canonical one. If someone repoints these
    // joins at the new `members`, this fails — which is the outcome worth
    // catching, because those queries would then look plausible while joining
    // a table that has no relationship to member_memberships at all.
    //
    // A rename rather than a drop was chosen precisely so the test above ("no
    // migration drops or alters the members table") keeps its full force.
    // Comments stripped before matching. The worker's header quotes the
    // failing query verbatim to record what is broken about it, and that quote
    // contains the literal being searched for — so matching the raw file makes
    // documenting the problem indistinguishable from having it. The same
    // reasoning oldBrandLeakage.test.js sets out for allowing brand names in
    // comments: a check that punishes explanation gets the explanation deleted.
    const worker = fs.readFileSync(path.join(SRC, 'workers', 'renewal.worker.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/[^\n]*$/gm, ' ');

    // Still joins the abandoned table — the class-reminder query does, and
    // Phase 12 owns rebuilding that one.
    expect(worker).toMatch(/JOIN legacy_members_v3\b/);

    // The blanket "must not join `members`" assertion is GONE, and its removal
    // is a correction rather than a relaxation.
    //
    // It was right while the worker only served the abandoned v3 stack: back
    // then any `JOIN members` meant somebody had pointed a member_memberships
    // query at the canonical table, which would have looked plausible while
    // joining something unrelated.
    //
    // Phase 3 makes joining canonical `members` the CORRECT thing for the
    // reminder sweep to do — it reads `memberships JOIN members`, which is the
    // whole point of the rewrite. So the assertion is narrowed to the thing that
    // is actually wrong: a `member_memberships` query must never resolve its
    // member against the canonical table.
    const memberMembershipsQueries = worker.match(/FROM member_memberships[\s\S]{0,400}?(?=`|\bWHERE\b)/gi) || [];
    for (const q of memberMembershipsQueries) {
      expect(q).not.toMatch(/JOIN members\b/);
    }
  });
});

describe('the canonical member domain is a different thing entirely', () => {
  // Phase 2 introduced /api/members on migration 166's table. The assertions
  // above are about /api/v1/members on the abandoned one, and both must hold at
  // once — so this pins the properties that make them different, rather than
  // leaving a future reader to conclude the guard above was quietly defeated.
  const members = fs.readFileSync(path.join(SRC, 'routes', 'members.js'), 'utf8');
  const migration = fs.readFileSync(
    path.join(SRC, 'db', 'migrations', '166_member_domain.sql'), 'utf8');

  it('is mounted at /api/members, not the guarded v1 path', () => {
    expect(server).toMatch(/app\.use\(\s*'\/api\/members'/);
    expect(server).not.toMatch(/app\.use\(\s*['"`]\/api\/v1\/members/);
  });

  it('sits on a table that is org-scoped from birth', () => {
    // The old table could not be tenanted at all — no organization_id, so
    // migration 157's dynamic RLS discovery could never cover it. That was the
    // whole reason the endpoint had to go.
    expect(migration).toMatch(/organization_id\s+UUID\s+NOT NULL REFERENCES organizations\(id\)/);
  });

  it('scopes every route, which is what the old one did not', () => {
    // list() had no org predicate for admin or manager: an admin of one studio
    // calling GET /api/v1/members got every studio's rows.
    expect(members).toContain('tenantScope');
    expect(members).toContain('orgIdOf');
    const handlers = members.match(/router\.(get|post|put|delete)\(/g) || [];
    expect(handlers.length).toBeGreaterThanOrEqual(5);
    // Every read and write goes through orgWhere() or stamps orgIdOf().
    expect((members.match(/orgWhere\(req, \w+/g) || []).length).toBeGreaterThanOrEqual(5);
  });
});

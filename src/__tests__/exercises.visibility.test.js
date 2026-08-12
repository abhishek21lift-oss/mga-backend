// Who can see a custom exercise.
//
// A trainer's custom exercises are their own — their cues, their naming, their
// half-finished experiments. Another trainer in the same studio must not see
// them, and no other studio can reach them at all. Built-in exercises (the 890
// seeded rows, organization_id NULL) stay shared by everybody.
//
// This replaced a three-way `visibility` column that let the author widen the
// audience to the whole studio or to every studio on the platform. The column
// still exists but nothing reads it, so there is no value anyone could set
// that would share a custom exercise.
//
// The tests below read the SQL the route actually builds rather than standing
// up a database: the predicate IS the security boundary, and it is reused by
// the list, count and facet queries, so what matters is that every read
// carries it and that no read still consults `visibility`.
'use strict';

const queries = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params });
    // /meta reads totals.rows[0] unguarded, so that one query has to come back
    // with a row or the handler 500s before the assertions get a look in.
    if (/COUNT\(\*\)::int AS total,/i.test(flat)) {
      return { rows: [{ total: 0, custom: 0, compound: 0, isolation: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rows: [{ id: 'e1' }], rowCount: 1 };
    }),
    release: jest.fn(),
  })),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';
const mockUser = { id: 'trainer-a', role: 'trainer', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/exercises', require('../routes/exercises'));
  return a;
}

/** Every SELECT the request issued against `exercises`. */
const reads = () => queries.filter((q) => /FROM exercises e/i.test(q.sql));

beforeEach(() => { queries.length = 0; });

describe('reading exercises', () => {
  it('scopes custom exercises to the trainer who wrote them', async () => {
    await request(app()).get('/api/exercises').expect(200);

    const r = reads();
    expect(r.length).toBeGreaterThan(0);
    for (const q of r) {
      // Built-ins stay shared…
      expect(q.sql).toMatch(/e\.organization_id IS NULL/);
      // …and anything owned by a studio must match BOTH the org and the author.
      expect(q.sql).toMatch(/e\.organization_id = \$\d+::uuid AND e\.created_by = \$\d+/);
    }
  });

  it('no longer lets the visibility column widen the audience', async () => {
    // The bug this closes: `visibility <> 'private'` meant the default made a
    // custom exercise readable by everyone in the studio.
    await request(app()).get('/api/exercises').expect(200);
    for (const q of reads()) {
      expect(q.sql).not.toMatch(/visibility <> 'private'/);
      expect(q.sql).not.toMatch(/WHERE[\s\S]*e\.visibility\s*=/);
    }
  });

  it('passes the callerid and org into every scoped read', async () => {
    await request(app()).get('/api/exercises').expect(200);
    for (const q of reads()) {
      expect(q.params).toContain(ORG_A);
      expect(q.params).toContain('trainer-a');
    }
  });

  it('applies the same predicate to the facet counts', async () => {
    // Counts are built from a separate query. If it drifted, the filter rail
    // would advertise exercises the list refuses to show — which is both a
    // leak of names and a confusing dead end.
    await request(app()).get('/api/exercises/meta').expect(200);
    for (const q of reads()) {
      expect(q.sql).toMatch(/e\.created_by = \$\d+/);
    }
  });
});

describe('creating an exercise', () => {
  const body = { name: 'Copenhagen Plank' };

  it('stamps the author and their org onto the row', async () => {
    await request(app()).post('/api/exercises').send(body).expect(201);
    const insert = queries.find((q) => /INSERT INTO exercises/i.test(q.sql));
    expect(insert).toBeTruthy();
    expect(insert.params).toContain(ORG_A);
    expect(insert.params).toContain('trainer-a');
  });

  it('stores it as private regardless of what the client asks for', async () => {
    // There is no longer a choice to make, so a caller sending visibility
    // 'public' must not get one. The literal is in the SQL, not the params.
    await request(app()).post('/api/exercises').send({ ...body, visibility: 'public' }).expect(201);
    const insert = queries.find((q) => /INSERT INTO exercises/i.test(q.sql));
    expect(insert.sql).toMatch(/'private'/);
    expect(insert.params).not.toContain('public');
    expect(insert.params).not.toContain('organization');
  });
});

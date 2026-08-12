// Notification Centre routes.
//
// Sending is the only irreversible action in the Control Centre, so most of
// what is tested here is the API refusing to make it reachable by accident:
// create never delivers, a sent announcement cannot be edited or deleted, and
// a targeted audience with nothing in it is rejected rather than reaching
// nobody and reporting success.
jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
// audit() and every super-admin read moved to the platform pool (migration 163).
// Same mock object, so assertions about what SQL a handler ran keep working;
// which pool it used is asserted separately, in platformPool.tiers.test.js.
jest.mock('../db/platformPool', () => require('../db/pool'));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn() }));
jest.mock('../lib/announcements', () => ({
  resolveRecipients: jest.fn(),
  send: jest.fn(),
  audienceClause: jest.fn(),
  dispatchDue: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'op-1', name: 'Owner', role: 'super_admin' }; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  invalidateUserCache: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const announcements = require('../lib/announcements');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'op-1', name: 'Owner', role: 'super_admin' }; next(); });
  a.use('/api/super-admin', require('../modules/platform/super-admin.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const calls = () => pool.query.mock.calls.map(([sql, params]) => ({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }));
const call = (re) => calls().find((c) => re.test(c.sql));

const DRAFT = { id: 'a1', title: 'Maintenance', body: 'Sunday 2am', status: 'draft', audience: 'all' };
const SENT = { ...DRAFT, status: 'sent', sent_at: new Date().toISOString() };
const BASE = { title: 'Maintenance window', body: 'We are upgrading on Sunday at 2am IST.' };

beforeEach(() => {
  pool.query.mockReset();
  announcements.send.mockReset();
  announcements.resolveRecipients.mockReset();
});

describe('listing', () => {
  it('counts read receipts from the delivered copies rather than a stored tally', async () => {
    // is_read on each fanned-out notification IS the receipt. A stored count
    // would need updating every time somebody opened their bell.
    pool.query.mockResolvedValueOnce({ rows: [{ ...SENT, delivered: 12, read_count: 5 }] });
    const res = await request(app()).get('/api/super-admin/announcements');
    expect(res.status).toBe(200);
    expect(res.body.data[0].read_count).toBe(5);
    expect(call(/FROM platform_announcements/).sql).toMatch(/n\.ref_id = a\.id::text/);
  });

  it('filters by status', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/super-admin/announcements?status=scheduled');
    expect(call(/FROM platform_announcements/).params).toContain('scheduled');
  });
});

describe('creating', () => {
  it('always creates a draft — creating never delivers', async () => {
    // An endpoint that could both create and send would put an irreversible
    // action behind a mistyped request body.
    pool.query.mockResolvedValueOnce({ rows: [DRAFT] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).post('/api/super-admin/announcements').send(BASE);
    expect(res.status).toBe(201);
    expect(announcements.send).not.toHaveBeenCalled();
    // The status column is absent from the INSERT entirely, so it takes the
    // schema default of 'draft'. Matched precisely because `audience_statuses`
    // is in the column list and contains the same substring.
    expect(call(/INSERT INTO platform_announcements/).sql).not.toMatch(/[( ]status[,)]/);
  });

  it('requires a title and a message', async () => {
    for (const body of [{}, { title: 'x' }, { body: 'y' }, { title: '   ', body: 'y' }]) {
      pool.query.mockReset();
      const res = await request(app()).post('/api/super-admin/announcements').send(body);
      expect(res.status).toBe(400);
      expect(call(/INSERT INTO platform_announcements/)).toBeUndefined();
    }
  });

  it('rejects an absolute URL in the link', async () => {
    // A platform notice carrying an off-site link is a phishing vector waiting
    // for whoever gets write access to this table next.
    const res = await request(app()).post('/api/super-admin/announcements')
      .send({ ...BASE, link: 'https://evil.example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/in-app path/);
  });

  it('accepts an in-app path', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DRAFT] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).post('/api/super-admin/announcements')
      .send({ ...BASE, link: '/subscription' });
    expect(res.status).toBe(201);
  });

  it('rejects an unknown severity and an unknown audience', async () => {
    for (const patch of [{ severity: 'apocalyptic' }, { audience: 'everyone' }]) {
      const res = await request(app()).post('/api/super-admin/announcements').send({ ...BASE, ...patch });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a targeted audience with an empty list', async () => {
    // Reaching nobody looks exactly like a successful send.
    for (const patch of [
      { audience: 'plan', audience_plans: [] },
      { audience: 'status', audience_statuses: [] },
      { audience: 'studios', audience_org_ids: [] },
      { audience: 'plan' },
    ]) {
      pool.query.mockReset();
      const res = await request(app()).post('/api/super-admin/announcements').send({ ...BASE, ...patch });
      expect(res.status).toBe(400);
      expect(call(/INSERT INTO platform_announcements/)).toBeUndefined();
    }
  });

  it('rejects an unknown role', async () => {
    const res = await request(app()).post('/api/super-admin/announcements')
      .send({ ...BASE, audience_roles: ['admin', 'wizard'] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/wizard/);
  });

  it('caps title and body length', async () => {
    for (const patch of [{ title: 'x'.repeat(141) }, { body: 'y'.repeat(4001) }]) {
      const res = await request(app()).post('/api/super-admin/announcements').send({ ...BASE, ...patch });
      expect(res.status).toBe(400);
    }
  });
});

describe('editing', () => {
  it('refuses to edit a sent announcement', async () => {
    // The copy already in a studio's bell does not change, so editing the
    // record would make it disagree with what was actually received.
    pool.query.mockResolvedValueOnce({ rows: [SENT] });
    const res = await request(app()).patch('/api/super-admin/announcements/a1').send({ title: 'Revised' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ALREADY_SENT');
    expect(call(/UPDATE platform_announcements/)).toBeUndefined();
  });

  it('edits a draft', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [DRAFT] })
      .mockResolvedValueOnce({ rows: [{ ...DRAFT, title: 'Revised' }] })
      .mockResolvedValue({ rows: [] });
    const res = await request(app()).patch('/api/super-admin/announcements/a1').send({ title: 'Revised' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Revised');
  });

  it('404s on an unknown announcement', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).patch('/api/super-admin/announcements/nope').send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('preview', () => {
  it('uses the same resolver as the send', async () => {
    // A preview computed by different code from the send is a preview of
    // nothing — the number the operator confirms must be the number that goes.
    pool.query.mockResolvedValueOnce({ rows: [DRAFT] });
    announcements.resolveRecipients.mockResolvedValueOnce({
      users: Array.from({ length: 14 }, (_, i) => ({ name: `U${i}`, role: 'admin', organization_name: 'Iron House' })),
      studio_count: 3,
    });

    const res = await request(app()).post('/api/super-admin/announcements/a1/preview');

    expect(res.body.data.recipient_count).toBe(14);
    expect(res.body.data.studio_count).toBe(3);
    // A sample, because "14 recipients" is not something an operator can
    // sanity-check but a list of names is.
    expect(res.body.data.sample).toHaveLength(10);
    expect(announcements.resolveRecipients).toHaveBeenCalled();
  });

  it('delivers nothing', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DRAFT] });
    announcements.resolveRecipients.mockResolvedValueOnce({ users: [], studio_count: 0 });
    await request(app()).post('/api/super-admin/announcements/a1/preview');
    expect(announcements.send).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('sends and audits the reach', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DRAFT] }).mockResolvedValue({ rows: [] });
    announcements.send.mockResolvedValueOnce({ ...SENT, recipient_count: 14, studio_count: 3 });

    const res = await request(app()).post('/api/super-admin/announcements/a1/send');

    expect(res.status).toBe(200);
    const insert = call(/INSERT INTO activity_log/);
    expect(insert.params).toEqual(expect.arrayContaining(['announcement_sent']));
    expect(JSON.stringify(insert.params)).toMatch(/"recipients":14/);
  });

  it('refuses a second send', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SENT] });
    const res = await request(app()).post('/api/super-admin/announcements/a1/send');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ALREADY_SENT');
    expect(announcements.send).not.toHaveBeenCalled();
  });

  it('409s when it loses the race to a concurrent send', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DRAFT] });
    announcements.send.mockResolvedValueOnce(null);
    const res = await request(app()).post('/api/super-admin/announcements/a1/send');
    expect(res.status).toBe(409);
  });
});

describe('scheduling', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();

  it('schedules for a future time', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...DRAFT, status: 'scheduled' }] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).post('/api/super-admin/announcements/a1/schedule').send({ scheduled_for: future });
    expect(res.status).toBe(200);
    expect(call(/UPDATE platform_announcements/).sql).toMatch(/status IN \('draft', 'scheduled'\)/);
  });

  it('rejects a time in the past', async () => {
    // It would fire on the very next dispatcher tick — a send dressed up as
    // a schedule.
    const res = await request(app()).post('/api/super-admin/announcements/a1/schedule')
      .send({ scheduled_for: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(call(/UPDATE platform_announcements/)).toBeUndefined();
  });

  it('rejects an unparseable date', async () => {
    const res = await request(app()).post('/api/super-admin/announcements/a1/schedule').send({ scheduled_for: 'soon' });
    expect(res.status).toBe(400);
  });

  it('refuses to schedule an already-sent announcement', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });   // the guarded UPDATE matches nothing
    const res = await request(app()).post('/api/super-admin/announcements/a1/schedule').send({ scheduled_for: future });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_SCHEDULABLE');
  });
});

describe('cancel and delete', () => {
  it('cancels a scheduled announcement', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...DRAFT, status: 'cancelled' }] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).post('/api/super-admin/announcements/a1/cancel');
    expect(res.status).toBe(200);
    expect(call(/UPDATE platform_announcements/).sql).toMatch(/status = 'scheduled'/);
  });

  it('cannot recall a sent announcement', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).post('/api/super-admin/announcements/a1/cancel');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_CANCELLABLE');
  });

  it('deletes only drafts and cancelled ones', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DRAFT] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).delete('/api/super-admin/announcements/a1');
    expect(res.status).toBe(200);
    expect(call(/DELETE FROM platform_announcements/).sql).toMatch(/status IN \('draft', 'cancelled'\)/);
  });

  it('refuses to delete a sent announcement', async () => {
    // Deleting it would orphan the notifications already in studios' bells
    // from the record that explains them.
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).delete('/api/super-admin/announcements/a1');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_DELETABLE');
  });
});

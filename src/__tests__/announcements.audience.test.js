// Announcement targeting and send safety.
//
// The two failure modes that matter here both reach real people and cannot be
// taken back: sending to the wrong studios, and sending twice. Everything below
// is one of those.
'use strict';

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { audienceClause, resolveRecipients, send, dispatchDue } = require('../lib/announcements');

/** A scriptable client that records every statement. */
function makeClient(handlers = []) {
  const log = [];
  const client = {
    log,
    query: jest.fn(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: flat, params });
      for (const h of handlers) if (h.match.test(flat)) return h.result;
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  return client;
}

describe('audience targeting', () => {
  it('reaches everyone when the audience is "all"', () => {
    expect(audienceClause({ audience: 'all' }).clause).toBe('TRUE');
  });

  it('filters by plan', () => {
    const { clause, params } = audienceClause({ audience: 'plan', audience_plans: ['growth', 'elite'] });
    expect(clause).toMatch(/o\.plan_code = ANY\(\$1\)/);
    expect(params[0]).toEqual(['growth', 'elite']);
  });

  it('filters by SUBSCRIPTION status, not the super-admin on/off column', () => {
    // An operator targeting "frozen studios" means the billing state. Matching
    // organizations.status would instead hit suspended-by-the-platform studios,
    // a completely different and much smaller set.
    const { clause } = audienceClause({ audience: 'status', audience_statuses: ['frozen'] });
    expect(clause).toMatch(/o\.subscription_status/);
    expect(clause).not.toMatch(/o\.status =/);
  });

  it('filters by an explicit studio list, cast to uuid', () => {
    const { clause } = audienceClause({ audience: 'studios', audience_org_ids: ['a', 'b'] });
    // The cast goes inside ANY() — the parameter is the array, so casting the
    // result of ANY would be casting a boolean.
    expect(clause).toMatch(/o\.id = ANY\(\$1::uuid\[\]\)/);
  });

  it('treats an unknown audience as "all" rather than silently reaching nobody', () => {
    // Broadcasting too widely is visible and recoverable by apology; a send
    // that reaches nobody looks exactly like a successful one.
    expect(audienceClause({ audience: 'nonsense' }).clause).toBe('TRUE');
  });
});

describe('recipient resolution', () => {
  const rows = [
    { id: 'u1', organization_id: 'o1', organization_name: 'Iron House', role: 'admin' },
    { id: 'u2', organization_id: 'o1', organization_name: 'Iron House', role: 'manager' },
    { id: 'u3', organization_id: 'o2', organization_name: 'Flex Lab', role: 'admin' },
  ];

  it('counts distinct studios, not recipients', async () => {
    const db = makeClient([{ match: /FROM users u/, result: { rows } }]);
    const r = await resolveRecipients({ audience: 'all' }, db);
    expect(r.users).toHaveLength(3);
    expect(r.studio_count).toBe(2);
  });

  it('excludes platform operators from a platform announcement', async () => {
    const db = makeClient([{ match: /FROM users u/, result: { rows } }]);
    await resolveRecipients({ audience: 'all' }, db);
    expect(db.log[0].sql).toMatch(/u\.role <> 'super_admin'/);
  });

  it('excludes deactivated and deleted accounts', async () => {
    const db = makeClient([{ match: /FROM users u/, result: { rows } }]);
    await resolveRecipients({ audience: 'all' }, db);
    expect(db.log[0].sql).toMatch(/u\.is_active = TRUE/);
    expect(db.log[0].sql).toMatch(/u\.deleted_at IS NULL/);
  });

  it('defaults to admins and managers when no roles are set', async () => {
    // A maintenance window is not something a studio's members need pushed
    // at them; the default audience is the people who can act on it.
    const db = makeClient([{ match: /FROM users u/, result: { rows: [] } }]);
    await resolveRecipients({ audience: 'all' }, db);
    expect(db.log[0].params.at(-1)).toEqual(['admin', 'manager']);
  });

  it('honours an explicit role list', async () => {
    const db = makeClient([{ match: /FROM users u/, result: { rows: [] } }]);
    await resolveRecipients({ audience: 'all', audience_roles: ['admin'] }, db);
    expect(db.log[0].params.at(-1)).toEqual(['admin']);
  });
});

describe('send', () => {
  const DRAFT = { id: 'a1', title: 'Maintenance', body: 'Sunday 2am', link: '/x', status: 'draft' };
  const users = [{ id: 'u1', organization_id: 'o1' }, { id: 'u2', organization_id: 'o2' }];

  function poolFor(handlers) {
    const client = makeClient(handlers);
    return { pool: { connect: async () => client }, client };
  }

  it('delivers one notification per recipient and marks it sent', async () => {
    const { pool, client } = poolFor([
      { match: /SELECT \* FROM platform_announcements WHERE id/, result: { rows: [DRAFT] } },
      { match: /FROM users u/, result: { rows: users } },
      { match: /UPDATE platform_announcements/, result: { rows: [{ ...DRAFT, status: 'sent' }] } },
    ]);

    const out = await send('a1', pool, { name: 'Owner' });

    expect(out.status).toBe('sent');
    expect(client.log.filter((c) => /INSERT INTO notifications/.test(c.sql))).toHaveLength(2);
    expect(client.log.some((c) => /COMMIT/.test(c.sql))).toBe(true);
  });

  it('links every copy back to the announcement, which is what makes read receipts countable', async () => {
    const { pool, client } = poolFor([
      { match: /SELECT \* FROM platform_announcements WHERE id/, result: { rows: [DRAFT] } },
      { match: /FROM users u/, result: { rows: users } },
      { match: /UPDATE platform_announcements/, result: { rows: [DRAFT] } },
    ]);
    await send('a1', pool, {});
    const insert = client.log.find((c) => /INSERT INTO notifications/.test(c.sql));
    expect(insert.sql).toMatch(/ref_id/);
    expect(insert.params).toContain('a1');
  });

  it('takes a row lock so two concurrent sends cannot both fan out', async () => {
    const { pool, client } = poolFor([
      { match: /SELECT \* FROM platform_announcements WHERE id/, result: { rows: [DRAFT] } },
      { match: /UPDATE platform_announcements/, result: { rows: [DRAFT] } },
    ]);
    await send('a1', pool, {});
    expect(client.log[1].sql).toMatch(/FOR UPDATE/);
  });

  it('guards the status update too, so a lost race writes nothing', async () => {
    const { pool, client } = poolFor([
      { match: /SELECT \* FROM platform_announcements WHERE id/, result: { rows: [DRAFT] } },
      { match: /UPDATE platform_announcements/, result: { rows: [DRAFT] } },
    ]);
    await send('a1', pool, {});
    const upd = client.log.find((c) => /UPDATE platform_announcements/.test(c.sql));
    expect(upd.sql).toMatch(/status <> 'sent'/);
  });

  it('refuses an already-sent announcement without delivering anything', async () => {
    const { pool, client } = poolFor([
      { match: /SELECT \* FROM platform_announcements WHERE id/, result: { rows: [{ ...DRAFT, status: 'sent' }] } },
    ]);
    expect(await send('a1', pool, {})).toBeNull();
    expect(client.log.some((c) => /INSERT INTO notifications/.test(c.sql))).toBe(false);
    expect(client.log.some((c) => /ROLLBACK/.test(c.sql))).toBe(true);
  });

  it('refuses a cancelled announcement', async () => {
    const { pool } = poolFor([
      { match: /SELECT \* FROM platform_announcements WHERE id/, result: { rows: [{ ...DRAFT, status: 'cancelled' }] } },
    ]);
    expect(await send('a1', pool, {})).toBeNull();
  });

  it('rolls back and releases the client when delivery blows up mid-fan-out', async () => {
    // A half-delivered broadcast is the worst outcome: some studios told, the
    // record still saying draft, and no way to tell which.
    const client = makeClient([]);
    client.query = jest.fn(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      client.log.push({ sql: flat });
      if (/SELECT \* FROM platform_announcements WHERE id/.test(flat)) return { rows: [DRAFT] };
      if (/FROM users u/.test(flat)) return { rows: users };
      if (/INSERT INTO notifications/.test(flat)) throw new Error('connection lost');
      return { rows: [] };
    });

    await expect(send('a1', { connect: async () => client }, {})).rejects.toThrow('connection lost');
    expect(client.log.some((c) => /ROLLBACK/.test(c.sql))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('scheduled dispatch', () => {
  it('only picks up scheduled announcements whose time has passed', async () => {
    const pool = makeClient([{ match: /SELECT id FROM platform_announcements/, result: { rows: [] } }]);
    await dispatchDue(pool);
    expect(pool.log[0].sql).toMatch(/status = 'scheduled'/);
    expect(pool.log[0].sql).toMatch(/scheduled_for <= now\(\)/);
  });

  it('keeps going when one announcement fails', async () => {
    // A malformed audience on one must not hold up a maintenance notice.
    const clients = {
      bad: makeClient([]),
      good: makeClient([
        { match: /SELECT \* FROM platform_announcements WHERE id/, result: { rows: [{ id: 'ok', status: 'draft' }] } },
        { match: /UPDATE platform_announcements/, result: { rows: [{ id: 'ok', status: 'sent' }] } },
      ]),
    };
    clients.bad.query = jest.fn(async () => { throw new Error('boom'); });

    let n = 0;
    const pool = {
      query: async () => ({ rows: [{ id: 'bad' }, { id: 'ok' }] }),
      connect: async () => (n++ === 0 ? clients.bad : clients.good),
    };

    expect(await dispatchDue(pool)).toBe(1);
  });
});

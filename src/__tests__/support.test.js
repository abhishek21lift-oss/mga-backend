// Support ticket rules shared by both sides.
//
// The leak barrier — internal operator notes never reaching the tenant — is
// verified end-to-end against a real database (see the live-SQL run in the
// commit message). What is checked here is the logic a mock CAN prove: the
// status transitions, the first-response clock, and that the tenant query is
// hard-wired to exclude internal notes.
'use strict';

const support = require('../lib/support');

describe('the tenant message query', () => {
  it('filters internal notes out at the SQL level', () => {
    // This constant is the ONLY message query a tenant path uses. If the
    // predicate ever goes missing, operator commentary about a customer is
    // served to that customer.
    expect(support.TENANT_MESSAGE_SQL).toMatch(/is_internal = FALSE/);
  });

  it('does not select the is_internal column at all', () => {
    // Not merely filtered — absent, so nothing downstream can branch on it
    // and accidentally surface one.
    expect(support.TENANT_MESSAGE_SQL).not.toMatch(/SELECT[\s\S]*is_internal[\s\S]*FROM/);
  });

  it('is a different query from the platform one, which keeps them', () => {
    expect(support.PLATFORM_MESSAGE_SQL).toMatch(/is_internal/);
    expect(support.PLATFORM_MESSAGE_SQL).not.toMatch(/is_internal = FALSE/);
  });
});

describe('new-ticket validation', () => {
  const ok = { subject: 'Check-ins failing', body: 'QR scanner errors.' };

  it('accepts a well-formed ticket and defaults sensibly', () => {
    expect(support.validateNewTicket(ok).value).toEqual({
      subject: 'Check-ins failing', body: 'QR scanner errors.',
      category: 'general', priority: 'normal',
    });
  });

  it('requires both a subject and a message', () => {
    for (const body of [{}, { subject: 'x' }, { body: 'y' }, { subject: '   ', body: 'y' }, { subject: 'x', body: '  ' }]) {
      expect(support.validateNewTicket(body).error).toBeTruthy();
    }
  });

  it('rejects an unknown category or priority', () => {
    expect(support.validateNewTicket({ ...ok, category: 'gossip' }).error).toMatch(/category/);
    expect(support.validateNewTicket({ ...ok, priority: 'apocalyptic' }).error).toMatch(/priority/);
  });

  it('caps the lengths', () => {
    expect(support.validateNewTicket({ ...ok, subject: 'x'.repeat(201) }).error).toBeTruthy();
    expect(support.validateNewTicket({ ...ok, body: 'y'.repeat(10001) }).error).toBeTruthy();
  });

  it('trims, so whitespace does not pass as content', () => {
    expect(support.validateNewTicket({ subject: '  Hi  ', body: '  There  ' }).value)
      .toMatchObject({ subject: 'Hi', body: 'There' });
  });
});

describe('addMessage', () => {
  /** A scriptable client that records every statement. */
  function makeDb(ticket) {
    const log = [];
    const client = {
      log,
      query: jest.fn(async (sql, params) => {
        const flat = String(sql).replace(/\s+/g, ' ').trim();
        log.push({ sql: flat, params });
        if (/SELECT \* FROM support_tickets WHERE id/.test(flat)) return { rows: ticket ? [ticket] : [] };
        if (/INSERT INTO support_ticket_messages/.test(flat)) {
          return { rows: [{ id: 'm1', is_internal: params[5], author_side: params[1], body: params[4] }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    return { connect: async () => client, client };
  }

  const OPEN = { id: 't1', status: 'open', first_response_at: null };

  it('a platform reply moves an open ticket to pending', async () => {
    const db = makeDb(OPEN);
    await support.addMessage(db, { ticketId: 't1', side: 'platform', body: 'On it' });
    const upd = db.client.log.find((c) => /UPDATE support_tickets SET status/.test(c.sql));
    expect(upd.params[1]).toBe('pending');
  });

  it('a studio reply reopens a resolved ticket', async () => {
    const db = makeDb({ ...OPEN, status: 'resolved' });
    await support.addMessage(db, { ticketId: 't1', side: 'studio', body: 'Still broken' });
    const upd = db.client.log.find((c) => /UPDATE support_tickets SET status/.test(c.sql));
    expect(upd.params[1]).toBe('open');
  });

  it('clears resolved_at when reopening, or the CHECK constraint rejects the row', async () => {
    const db = makeDb({ ...OPEN, status: 'resolved' });
    await support.addMessage(db, { ticketId: 't1', side: 'studio', body: 'Still broken' });
    const upd = db.client.log.find((c) => /UPDATE support_tickets SET status/.test(c.sql));
    expect(upd.sql).toMatch(/resolved_at = CASE WHEN \$2 IN \('resolved','closed'\) THEN resolved_at ELSE NULL END/);
  });

  it('stamps first_response_at only for a platform message', async () => {
    const db = makeDb(OPEN);
    await support.addMessage(db, { ticketId: 't1', side: 'platform', body: 'On it' });
    expect(db.client.log.find((c) => /UPDATE support_tickets SET status/.test(c.sql)).params[2]).toBe(true);

    const db2 = makeDb(OPEN);
    await support.addMessage(db2, { ticketId: 't1', side: 'studio', body: 'More info' });
    expect(db2.client.log.find((c) => /UPDATE support_tickets SET status/.test(c.sql)).params[2]).toBe(false);
  });

  it('uses COALESCE so a later reply cannot reset the first-response clock', async () => {
    const db = makeDb({ ...OPEN, first_response_at: new Date() });
    await support.addMessage(db, { ticketId: 't1', side: 'platform', body: 'Update' });
    expect(db.client.log.find((c) => /UPDATE support_tickets SET status/.test(c.sql)).sql)
      .toMatch(/COALESCE\(first_response_at, now\(\)\)/);
  });

  it('an INTERNAL note moves nothing — the studio was never told anything', async () => {
    // Counting it as a response would corrupt the response-time figures the
    // support function is judged on.
    const db = makeDb(OPEN);
    await support.addMessage(db, { ticketId: 't1', side: 'platform', body: 'note', isInternal: true });
    expect(db.client.log.some((c) => /UPDATE support_tickets SET status/.test(c.sql))).toBe(false);
    expect(db.client.log.some((c) => /UPDATE support_tickets SET updated_at/.test(c.sql))).toBe(true);
  });

  it('refuses to let the studio side author an internal note', async () => {
    const db = makeDb(OPEN);
    await support.addMessage(db, { ticketId: 't1', side: 'studio', body: 'x', isInternal: true });
    const ins = db.client.log.find((c) => /INSERT INTO support_ticket_messages/.test(c.sql));
    expect(ins.params[5]).toBe(false);
  });

  it('takes a row lock so two replies cannot race the status', async () => {
    const db = makeDb(OPEN);
    await support.addMessage(db, { ticketId: 't1', side: 'platform', body: 'x' });
    expect(db.client.log[1].sql).toMatch(/FOR UPDATE/);
  });

  it('returns null for an unknown ticket without writing', async () => {
    const db = makeDb(null);
    expect(await support.addMessage(db, { ticketId: 'nope', side: 'studio', body: 'x' })).toBeNull();
    expect(db.client.log.some((c) => /INSERT/.test(c.sql))).toBe(false);
  });

  it('reports a closed ticket rather than silently appending to it', async () => {
    const db = makeDb({ ...OPEN, status: 'closed' });
    expect(await support.addMessage(db, { ticketId: 't1', side: 'studio', body: 'x' })).toEqual({ closed: true });
    // Nothing is written — a reply to a closed ticket must not vanish into a
    // thread nobody is reading.
    expect(db.client.log.some((c) => /INSERT/.test(c.sql))).toBe(false);
  });

  it('rolls back and releases the client when the write fails', async () => {
    const db = makeDb(OPEN);
    db.client.query = jest.fn(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      db.client.log.push({ sql: flat });
      if (/SELECT \* FROM support_tickets/.test(flat)) return { rows: [OPEN] };
      if (/INSERT INTO support_ticket_messages/.test(flat)) throw new Error('disk full');
      return { rows: [] };
    });
    await expect(support.addMessage(db, { ticketId: 't1', side: 'studio', body: 'x' })).rejects.toThrow('disk full');
    expect(db.client.log.some((c) => /ROLLBACK/.test(c.sql))).toBe(true);
    expect(db.client.release).toHaveBeenCalled();
  });
});

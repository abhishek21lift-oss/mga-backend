// 23505 responses have to say WHICH field was taken.
//
// A studio owner adding a client hit a duplicate on a phone number that
// belonged to a different studio's client (see migration 149) and the API
// answered "Duplicate entry — this record already exists." From inside their
// own studio the client list was empty, so the message was not merely vague,
// it read as false — and the button read as broken. Naming the field is what
// turns that into an obvious next step.
//
// The value must NOT be echoed. Postgres puts it in err.detail
// ("Key (mobile)=(9876543210) already exists"), and reflecting that back would
// turn a duplicate check into a lookup oracle for numbers on other studios'
// rosters. These tests pin both halves: name the field, never the value.
'use strict';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { errorHandler } = require('../middleware/errorHandler');

function run(err) {
  const req = { method: 'POST', originalUrl: '/api/pt-os/clients', path: '/clients' };
  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  errorHandler(err, req, res, () => {});
  return res;
}

const dupe = (constraint) => ({
  code: '23505',
  constraint,
  detail: 'Key (mobile)=(6387171298) already exists.',
  message: 'duplicate key value violates unique constraint',
});

describe('duplicate-key responses', () => {
  test('a mobile collision names the mobile number and the studio scope', () => {
    const res = run(dupe('pt_clients_org_mobile_unique'));

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/mobile number/i);
    // Scoped wording matters: post-149 a duplicate really is within this studio,
    // and saying so is what stops it reading as a lie to someone whose own list
    // is empty.
    expect(res.body.error).toMatch(/this studio/i);
  });

  test('an email collision names the email', () => {
    const res = run(dupe('pt_clients_org_email_unique'));

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });

  test('the legacy clients table constraints map too (if it is ever scoped)', () => {
    expect(run(dupe('clients_org_mobile_uniq')).body.error).toMatch(/mobile number/i);
    expect(run(dupe('clients_org_email_uniq')).body.error).toMatch(/email/i);
  });

  test('the offending value is never echoed back', () => {
    // err.detail carries the number. It must not reach the client.
    const res = run(dupe('pt_clients_org_mobile_unique'));

    expect(JSON.stringify(res.body)).not.toMatch(/6387171298/);
  });

  test('the constraint name is returned so a client can branch on it', () => {
    const res = run(dupe('pt_clients_org_mobile_unique'));

    expect(res.body.constraint).toBe('pt_clients_org_mobile_unique');
  });

  test('an unrecognised constraint still gets the generic 409, not a crash', () => {
    const res = run(dupe('some_future_constraint'));

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('a 23505 with no constraint name is handled', () => {
    // Not every driver path populates err.constraint.
    const res = run({ code: '23505', message: 'duplicate key' });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect(res.body).not.toHaveProperty('constraint');
  });
});

// Enrolment: payment method, the agreement, and the form as a PDF.
//
// Three things here fail quietly rather than loudly:
//
//   A free-text payment method. Nothing breaks; the finance screen that groups
//   by it just reports "UPI", "upi" and "Upi " as three payment methods.
//
//   A trainer setting a money field. PATCH silently drops fields outside the
//   role's allowlist, so the request succeeds, the UI says saved, and the
//   column keeps its old value.
//
//   A route ordering mistake. /clients/:id/enrollment-pdf declared after
//   /clients/:id is swallowed by it, and the download returns a JSON client
//   record with a .pdf filename.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const fs = require('fs');
const path = require('path');
const { buildEnrollmentPdf, ageFrom, METHOD_LABELS } = require('../lib/ptEnrollmentPdf');

const ROUTES = path.join(__dirname, '..', 'modules', 'pt-os', 'pt-os.routes.js');
const src = () => fs.readFileSync(ROUTES, 'utf8');

describe('payment method is a closed set', () => {
  test('the five the UI offers are the five the server accepts', () => {
    const m = src().match(/const PAYMENT_METHODS = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
     
    const methods = eval(`[${m[1]}]`);
    expect(methods).toEqual(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'SPLIT']);
  });

  test('every accepted value has a label for the PDF', () => {
    const m = src().match(/const PAYMENT_METHODS = \[([^\]]+)\]/);
     
    for (const method of eval(`[${m[1]}]`)) {
      expect(METHOD_LABELS[method]).toBeTruthy();
    }
  });

  test('the route validates it rather than writing whatever arrives', () => {
    expect(src()).toMatch(/PAYMENT_METHODS\.includes\(String\(req\.body\.payment_method\)\)/);
  });
});

describe('the role boundary', () => {
  /** The two allowlists in PATCH /clients/:id, trainer first. */
  function allowlists() {
    const block = src().match(/const allowed = isTrainer\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[([\s\S]*?)\];/);
    if (!block) throw new Error('allowlists not found');
    // Strip line comments FIRST. A comma inside one ("Money-adjacent, so
    // admin only") splits the comment in two and glues the quoted entry that
    // follows onto the tail of a fragment, which then fails the startsWith
    // test — so the field looks absent when it is right there in the list.
    const parse = (t) => (t.replace(/\/\/[^\n]*/g, '').match(/'[^']+'/g) || [])
      .map((x) => x.replace(/'/g, ''));
    return { trainer: parse(block[1]), admin: parse(block[2]) };
  }

  test('a trainer cannot set the payment method', () => {
    // It is money-adjacent, and PATCH drops out-of-allowlist fields silently.
    const { trainer, admin } = allowlists();
    expect(trainer).not.toContain('payment_method');
    expect(admin).toContain('payment_method');
  });

  test('but a trainer CAN record the agreement', () => {
    // A trainer runs the enrolment in front of the client. Locking the
    // signature to admins would mean the person holding the phone cannot
    // record the thing the client just signed.
    const { trainer, admin } = allowlists();
    for (const f of ['agreement_accepted_at', 'agreement_signature', 'agreement_text']) {
      expect(trainer).toContain(f);
      expect(admin).toContain(f);
    }
  });
});

describe('the PDF route', () => {
  test('is declared before /clients/:id, or :id swallows it', () => {
    const s = src();
    const pdf = s.indexOf("router.get('/clients/:id/enrollment-pdf'");
    const byId = s.indexOf("router.get('/clients/:id',");
    expect(pdf).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    expect(pdf).toBeLessThan(byId);
  });

  test('is org-scoped, and qualified because it aliases the table', () => {
    const block = src().slice(src().indexOf("router.get('/clients/:id/enrollment-pdf'"));
    expect(block.slice(0, 900)).toMatch(/orgWhere\(req, params, 'c\.organization_id'\)/);
  });

  test('answers 404 for a client the caller cannot see, not 500', () => {
    const block = src().slice(src().indexOf("router.get('/clients/:id/enrollment-pdf'"));
    expect(block.slice(0, 1200)).toMatch(/status\(404\)/);
  });
});

describe('ageFrom', () => {
  test('counts whole years', () => {
    const d = new Date();
    const thirty = new Date(Date.UTC(d.getUTCFullYear() - 30, d.getUTCMonth(), d.getUTCDate()));
    expect(ageFrom(thirty.toISOString().slice(0, 10))).toBe(30);
  });

  test('has not had this year\'s birthday yet', () => {
    const d = new Date();
    // Tomorrow's date, thirty years ago: still 29.
    const tomorrow = new Date(Date.UTC(d.getUTCFullYear() - 30, d.getUTCMonth(), d.getUTCDate() + 1));
    expect(ageFrom(tomorrow.toISOString().slice(0, 10))).toBe(29);
  });

  test('returns null rather than a number for missing or junk input', () => {
    expect(ageFrom(null)).toBeNull();
    expect(ageFrom(undefined)).toBeNull();
    expect(ageFrom('')).toBeNull();
    expect(ageFrom('not-a-date')).toBeNull();
  });

  test('refuses an implausible age instead of printing it', () => {
    // A mistyped year (1098, 3025) should read as "no age", not as "age 928".
    expect(ageFrom('1098-01-01')).toBeNull();
    expect(ageFrom('3025-01-01')).toBeNull();
  });
});

describe('the generated document', () => {
  const CLIENT = {
    name: 'Hari Narayan Singh', unique_id: 'PTC-00025', mobile: '9990000001',
    dob: '1998-03-15', weight: 78, goal: 'Fat Loss', joining_date: '2024-02-01',
    package_type: 'PT 3 Months', trainer_name: 'Abhishek',
    pt_start_date: '2025-09-19', pt_end_date: '2025-12-19', duration_months: 3,
    training_mode: 'Offline', sessions_per_week: 3,
    final_amount: 30000, paid_amount: 20000, balance_amount: 10000,
    payment_method: 'UPI',
    agreement_text: 'I agree to the terms.',
    agreement_accepted_at: '2026-08-06T04:00:00Z',
    agreement_signature: null,
  };

  test('is a PDF', async () => {
    const buf = await buildEnrollmentPdf(CLIENT);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(1000);
  });

  test('survives a client with almost nothing filled in', async () => {
    // Half of these columns are nullable and a draft enrolment has most of
    // them empty. Throwing here would make "download" fail on exactly the
    // records most likely to need checking.
    const buf = await buildEnrollmentPdf({ name: 'Nobody' });
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('survives an unsigned agreement', async () => {
    const buf = await buildEnrollmentPdf({ ...CLIENT, agreement_signature: null });
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('survives a malformed signature data URL', async () => {
    // embedSignature draws an error line rather than throwing; this pins that
    // a corrupt signature still produces a document.
    const buf = await buildEnrollmentPdf({ ...CLIENT, agreement_signature: 'data:image/png;base64,@@@' });
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});

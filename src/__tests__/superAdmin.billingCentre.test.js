// Billing Centre routes.
//
// The pool is mocked and the assertions are mostly about the SQL: what matters
// here is that the list, the totals and the export describe the SAME set, and
// that an operator cannot write columns they were never offered.
jest.mock('../db/pool', () => ({ query: jest.fn() }));
// audit() and every super-admin read moved to the platform pool (migration 163).
// Same mock object, so assertions about what SQL a handler ran keep working;
// which pool it used is asserted separately, in platformPool.tiers.test.js.
jest.mock('../db/platformPool', () => require('../db/pool'));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'op-1', name: 'Owner', role: 'super_admin' }; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  invalidateUserCache: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

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

const SETTINGS = {
  id: true, legal_name: 'MY PT STUDIO PVT LTD', gstin: '27AAAAA0000A1Z5', state_code: '27',
  gst_percent: '18.00', prices_include_gst: true, invoice_prefix: 'MPT', country: 'India',
};
const TOTALS = { count: 2, gross_inr: '2360', taxable_inr: '2000', tax_inr: '360', refunded_inr: '0', untaxed_count: 0 };

beforeEach(() => pool.query.mockReset());

describe('settings', () => {
  it('returns the singleton row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SETTINGS] });
    const res = await request(app()).get('/api/super-admin/billing/settings');
    expect(res.status).toBe(200);
    expect(res.body.data.gstin).toBe('27AAAAA0000A1Z5');
  });

  it('falls back to sane defaults when the row is missing', async () => {
    // A database that predates migration 122 must still be able to invoice.
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get('/api/super-admin/billing/settings');
    expect(res.body.data.gst_percent).toBe(18);
    expect(res.body.data.prices_include_gst).toBe(true);
  });

  it('writes only whitelisted columns', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SETTINGS] })
      .mockResolvedValueOnce({ rows: [SETTINGS] })
      .mockResolvedValue({ rows: [] });

    await request(app()).put('/api/super-admin/billing/settings')
      .send({ legal_name: 'New Name', id: false, updated_by: 'someone else', is_founder: true });

    const upd = call(/UPDATE platform_billing_settings/);
    expect(upd.sql).toMatch(/legal_name = \$1/);
    expect(upd.sql).not.toMatch(/is_founder/);
    // updated_by is set from the session, never from the body.
    expect(upd.params).toContain('Owner');
    expect(upd.params).not.toContain('someone else');
  });

  it('rejects an out-of-range GST rate', async () => {
    const res = await request(app()).put('/api/super-admin/billing/settings').send({ gst_percent: 180 });
    expect(res.status).toBe(400);
    expect(call(/UPDATE platform_billing_settings/)).toBeUndefined();
  });

  it('rejects a prefix that would make an ugly invoice number', async () => {
    for (const invoice_prefix of ['MPT-2024', 'a b', '', 'TOOLONGPREFIX1']) {
      pool.query.mockReset();
      const res = await request(app()).put('/api/super-admin/billing/settings').send({ invoice_prefix });
      expect(res.status).toBe(400);
    }
  });

  it('records that the change is not retroactive', async () => {
    // The operator changing 18 → 12 needs the audit trail to say that last
    // year's invoices did not silently move with it.
    pool.query
      .mockResolvedValueOnce({ rows: [SETTINGS] })
      .mockResolvedValueOnce({ rows: [{ ...SETTINGS, gst_percent: 12 }] })
      .mockResolvedValue({ rows: [] });

    await request(app()).put('/api/super-admin/billing/settings').send({ gst_percent: 12 });

    const insert = call(/INSERT INTO activity_log/);
    expect(insert.params).toEqual(expect.arrayContaining(['billing_settings_updated']));
    expect(JSON.stringify(insert.params)).toMatch(/from now on/i);
  });
});

describe('invoice list', () => {
  it('applies the same filter to the rows and to the totals', async () => {
    // If they diverged, the KPI strip would describe a different set from the
    // table underneath it — and nobody would notice until an audit.
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [TOTALS] });

    await request(app()).get('/api/super-admin/billing/invoices?status=paid&from=2026-01-01&q=iron');

    const [list, totals] = calls();
    for (const frag of [/i\.status = \$\d/, /i\.issued_at >= \$\d/, /ILIKE/]) {
      expect(list.sql).toMatch(frag);
      expect(totals.sql).toMatch(frag);
    }
    expect(totals.params).toEqual(list.params.slice(0, totals.params.length));
  });

  it('makes the end date inclusive of its whole day', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [TOTALS] });
    await request(app()).get('/api/super-admin/billing/invoices?to=2026-03-31');
    expect(call(/subscription_invoices/).sql).toMatch(/INTERVAL '1 day'/);
  });

  it('caps the page size however large a limit is asked for', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [TOTALS] });
    await request(app()).get('/api/super-admin/billing/invoices?limit=99999');
    expect(calls()[0].params).toContain(200);
  });

  it('reports how many rows have no tax snapshot', async () => {
    // Under-reported tax is worse than absent tax if the operator cannot see
    // that some rows are simply not itemised.
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...TOTALS, untaxed_count: 7 }] });
    const res = await request(app()).get('/api/super-admin/billing/invoices');
    expect(res.body.totals.untaxed_count).toBe(7);
  });

  it('reports has_more from the filtered count, not the page', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'i1' }] })
      .mockResolvedValueOnce({ rows: [{ ...TOTALS, count: 90 }] });
    const res = await request(app()).get('/api/super-admin/billing/invoices?limit=1');
    expect(res.body.page.has_more).toBe(true);
  });
});

describe('CSV export', () => {
  const ROW = {
    invoice_number: 'MPT-2026-00001', issued_at: '2026-03-01T00:00:00Z',
    organization_name: 'Iron House', billing_gstin: '27BBBBB1111B1Z9',
    plan_name: 'Growth', period_start: '2026-03-01T00:00:00Z', period_end: '2026-04-01T00:00:00Z',
    taxable_value_inr: '1000.00', gst_percent: '18.00', cgst_inr: '90.00', sgst_inr: '90.00',
    igst_inr: '0.00', amount_inr: 1180, status: 'paid',
    payment_method: 'upi', payment_reference: 'UTR123', buyer_snapshot: null,
  };

  it('exports the filtered set, not everything', async () => {
    pool.query.mockResolvedValue({ rows: [ROW] });
    await request(app()).get('/api/super-admin/billing/invoices/export?org_id=11111111-1111-1111-1111-111111111111');
    expect(call(/subscription_invoices/).sql).toMatch(/i\.organization_id = \$1::uuid/);
  });

  it('sends a UTF-8 CSV attachment', async () => {
    pool.query.mockResolvedValue({ rows: [ROW] });
    const res = await request(app()).get('/api/super-admin/billing/invoices/export');
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="invoices-/);
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);   // BOM, so Excel reads UTF-8
    expect(res.text).toMatch(/"MPT-2026-00001"/);
  });

  it('leaves un-itemised tax blank rather than writing zero', async () => {
    // A 0 would be summed by the spreadsheet and understate the taxable base.
    pool.query.mockResolvedValue({ rows: [{ ...ROW, taxable_value_inr: null, cgst_inr: null, sgst_inr: null, igst_inr: null, gst_percent: null }] });
    const res = await request(app()).get('/api/super-admin/billing/invoices/export');
    const dataLine = res.text.split('\n')[1];
    expect(dataLine).toMatch(/,,,,,/);
    expect(dataLine).toMatch(/"1180"/);
  });

  it('defuses a formula hidden in a payment reference', async () => {
    pool.query.mockResolvedValue({ rows: [{ ...ROW, payment_reference: '=cmd|calc' }] });
    const res = await request(app()).get('/api/super-admin/billing/invoices/export');
    expect(res.text).toMatch(/"'=cmd\|calc"/);
  });

  it('is itself an audited act', async () => {
    pool.query.mockResolvedValue({ rows: [ROW] });
    await request(app()).get('/api/super-admin/billing/invoices/export');
    expect(call(/INSERT INTO activity_log/).params).toEqual(expect.arrayContaining(['billing_exported']));
  });
});

describe('invoice PDF', () => {
  const INVOICE = {
    id: 'inv-1', invoice_number: 'MPT-2026-00001', organization_id: 'org-1', payment_id: 'pay-1',
    plan_code: 'growth', amount_inr: 1180, taxable_value_inr: '1000.00', gst_percent: '18.00',
    cgst_inr: '90.00', sgst_inr: '90.00', igst_inr: '0.00', status: 'paid',
    issued_at: '2026-03-01T00:00:00Z', period_start: '2026-03-01T00:00:00Z', period_end: '2026-04-01T00:00:00Z',
    seller_snapshot: { legal_name: 'MY PT STUDIO PVT LTD', gstin: '27AAAAA0000A1Z5', state: 'Maharashtra' },
    buyer_snapshot: { name: 'Iron House Fitness LLP', gstin: '27BBBBB1111B1Z9' },
    organization_name: 'Iron House', plan_name: 'Growth',
  };

  it('renders a PDF', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [INVOICE] })
      .mockResolvedValueOnce({ rows: [{ id: 'pay-1', method: 'upi', reference: 'UTR123' }] })
      .mockResolvedValueOnce({ rows: [SETTINGS] });

    const res = await request(app()).get('/api/super-admin/billing/invoices/inv-1/pdf').buffer();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('renders a legacy invoice that has no tax snapshot', async () => {
    // Pre-migration-122 rows must still print, without inventing a split.
    pool.query
      .mockResolvedValueOnce({ rows: [{ ...INVOICE, taxable_value_inr: null, gst_percent: null, cgst_inr: null, sgst_inr: null, igst_inr: null, seller_snapshot: null, buyer_snapshot: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pay-1' }] })
      .mockResolvedValueOnce({ rows: [SETTINGS] });

    const res = await request(app()).get('/api/super-admin/billing/invoices/inv-1/pdf').buffer();
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('404s on an unknown invoice', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get('/api/super-admin/billing/invoices/nope/pdf');
    expect(res.status).toBe(404);
  });
});

describe('studio billing profile', () => {
  it('saves the registered identity, upper-casing the GSTIN', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'org-1', billing_name: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'org-1', billing_gstin: '27BBBBB1111B1Z9' }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).put('/api/super-admin/organizations/org-1/billing-profile')
      .send({ billing_gstin: '27bbbbb1111b1z9', billing_city: 'Pune' });

    expect(res.status).toBe(200);
    expect(call(/UPDATE organizations SET billing_/).params).toContain('27BBBBB1111B1Z9');
  });

  it('records the previous values so a wrong edit can be traced', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'org-1', billing_name: 'Old LLP' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'org-1' }] })
      .mockResolvedValue({ rows: [] });

    await request(app()).put('/api/super-admin/organizations/org-1/billing-profile').send({ billing_name: 'New LLP' });

    const insert = call(/INSERT INTO activity_log/);
    expect(JSON.stringify(insert.params)).toMatch(/Old LLP/);
    expect(JSON.stringify(insert.params)).toMatch(/New LLP/);
  });

  it('refuses columns outside the billing profile', async () => {
    const res = await request(app()).put('/api/super-admin/organizations/org-1/billing-profile')
      .send({ subscription_status: 'active', client_limit: 99999 });
    expect(res.status).toBe(400);
    expect(call(/UPDATE organizations/)).toBeUndefined();
  });

  it('404s for an unknown studio', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).put('/api/super-admin/organizations/nope/billing-profile').send({ billing_city: 'Pune' });
    expect(res.status).toBe(404);
  });
});

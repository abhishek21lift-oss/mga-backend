jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../db/pool');
const { genReceiptNo } = require('../db/receipts');

describe('genReceiptNo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a RCP-prefixed string in the expected format', async () => {
    pool.query.mockImplementation(async function() {
      if (/CREATE SEQUENCE IF NOT EXISTS receipt_no_seq/i.test(arguments[0])) {
        return { rows: [] };
      }
      if (/SELECT nextval/i.test(arguments[0])) {
        return { rows: [{ n: 100001 }] };
      }
      return { rows: [] };
    });
    const r = await genReceiptNo();
    expect(r).toMatch(/^RCP-\d{8}-\d{6}$/);
  });

  it('produces unique values for sequential calls', async () => {
    let n = 100001;
    pool.query.mockImplementation(async function() {
      if (/CREATE SEQUENCE IF NOT EXISTS receipt_no_seq/i.test(arguments[0])) {
        return { rows: [] };
      }
      if (/SELECT nextval/i.test(arguments[0])) {
        n += 1;
        return { rows: [{ n: n - 1 }] };
      }
      return { rows: [] };
    });
    const a = await genReceiptNo();
    const b = await genReceiptNo();
    expect(a).not.toBe(b);
  });
});

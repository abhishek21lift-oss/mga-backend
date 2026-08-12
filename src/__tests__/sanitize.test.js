const { sanitizeBody } = require('../middleware/sanitize');

describe('sanitize middleware — null byte regression', () => {
  it('removes null bytes from string values in req.body', () => {
    const req = { body: { name: 'a\x00b\x00c' } };
    sanitizeBody(req, {}, function() {});
    expect(req.body.name).toBe('abc');
    // eslint-disable-next-line no-control-regex -- asserting NUL bytes are stripped
    expect(req.body.name).not.toMatch(/\x00/);
  });

  it('removes null bytes from nested objects', () => {
    const req = { body: { user: { email: 'evil\x00@x.com' } } };
    sanitizeBody(req, {}, function() {});
    expect(req.body.user.email).toBe('evil@x.com');
  });

  it('removes null bytes from arrays of strings', () => {
    const req = { body: { tags: ['a\x00', 'b\x00c'] } };
    sanitizeBody(req, {}, function() {});
    expect(req.body.tags).toEqual(['a', 'bc']);
  });
});

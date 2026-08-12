'use strict';
// bookings.service.js wrote to audit_log with columns that table has never had
// (user_id/action/entity/entity_id/before/after — the real columns are
// table_name/record_id/old_data/new_data/changed_by), so every create/cancel
// that reached the statement threw. Unreached in practice — the module has no
// live frontend caller — which is the only reason it never surfaced as a
// production 500. Fixed to write activity_log, the table every other audited
// write in the app actually uses, rather than patching the columns to match a
// second, otherwise-unused table.
//
// This originally covered members.service.js too. That module was deleted with
// the /api/v1/members endpoint (see MEMBERS-TENANT-GAP.md), so only the
// bookings half remains — the assertions were removed rather than the file,
// because the bookings half still guards live code.

const fs = require('fs');
const path = require('path');

const bookings = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'bookings', 'bookings.service.js'), 'utf8');
const bookingsRoutes = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'bookings', 'bookings.routes.js'), 'utf8');

describe('bookings.service.js no longer writes to the wrong table', () => {
  it('never references audit_log or its non-existent columns again', () => {
    expect(bookings).not.toContain('audit_log');
    expect(bookings).not.toMatch(/\bentity\b\s*,\s*entity_id.*\bafter\b/);
  });

  it('writes activity_log instead, for both audited actions', () => {
    for (const action of ['booking.create', 'booking.cancel']) {
      expect(bookings).toContain(`'${action}'`);
    }
    expect((bookings.match(/INSERT INTO activity_log/g) || []).length).toBe(2);
  });

  it('the booking writes stay on the transaction client, not a separate pool.query', () => {
    // Unlike payments.js, this module never commits before logging — the
    // audit row and the booking it describes are one atomic write here, so
    // keeping it on `client` (the same connection as BEGIN/COMMIT) is
    // correct, not a shortcut, as long as it happens before COMMIT.
    for (const action of ['booking.create', 'booking.cancel']) {
      const at = bookings.indexOf(`'${action}'`);
      const before = bookings.slice(0, at);
      expect(before.slice(before.lastIndexOf('client.query') , at)).toBeTruthy();
    }
  });
});

describe('the ctx() helper now carries what activity_log needs', () => {
  it("bookings.routes.js's ctx() includes user_name and organization_id", () => {
    const fn = bookingsRoutes.slice(bookingsRoutes.indexOf('const ctx = (req)'), bookingsRoutes.indexOf('});') + 3);
    expect(fn).toContain('user_name: req.user.name');
    expect(fn).toContain('organization_id: req.user.organization_id');
  });
});

'use strict';

/**
 * Public self-serve trial signup: POST /api/registrations.
 *
 * Deliberately unauthenticated — the applicant does not have an account yet,
 * which is the entire point. The handler and all of its validation live with
 * the Command Centre queue that reviews these applications
 * (modules/platform/super-admin/registrations.js), so the shape written here
 * and the shape read there can never drift.
 */

const router = require('express').Router();
const { handlers } = require('../modules/platform/super-admin/registrations');

router.post('/', handlers.create);

module.exports = router;

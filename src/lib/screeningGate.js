// src/lib/screeningGate.js
// Shared PAR-Q + Informed Consent safety gate, used by workout plan
// assignment (src/routes/workouts.js POST /assign) and Workout Log session
// creation (src/modules/pt-os/workout-log.routes.js).
// Always a live SELECT against the source-of-truth tables — never a
// cached/trusted client-submitted flag.
//
// Semantics:
//   • HARD BLOCK (403) only when the client's latest PAR-Q explicitly says
//     workout_gate_status = 'blocked' — a real medical flag. Training a
//     client the screening has flagged stays impossible.
//   • Missing paperwork (no PAR-Q on file, or no completed Informed
//     Consent) is a WARNING, not a block: the action proceeds and the
//     route returns the warnings so the UI can nudge the trainer to
//     complete screening. Blocking every unscreened client outright made
//     the whole workout system unusable on day one.
const pool = require('../db/pool');
const { logActivity } = require('./activityLog');

// Returns { blocked, warnings }:
//   blocked  — null when the action may proceed, or { status, body } for
//              the 403 to send (explicit medical block only).
//   warnings — human-readable strings for missing screening paperwork;
//              include them in the success response as screening_warnings.
async function checkScreeningGate(req, clientId) {
  const warnings = [];

  const { rows: gateRows } = await pool.query(
    `SELECT workout_gate_status FROM pt_parq_forms
      WHERE client_id = $1 AND deleted_at IS NULL
      ORDER BY assessment_date DESC LIMIT 1`,
    [clientId]
  );
  const gate = gateRows[0];
  if (gate && gate.workout_gate_status === 'blocked') {
    await logActivity(req, 'workout.assign.blocked', 'pt_client', clientId, {
      reason: 'gate_blocked',
    });
    return {
      blocked: {
        status: 403,
        body: {
          error: 'This client\'s PAR-Q screening flags them as medically blocked — clearance is required before training.',
          code: 'PARQ_BLOCKED',
        },
      },
      warnings,
    };
  }
  if (!gate) {
    warnings.push('No PAR-Q health screening on file for this client.');
  }

  const { rows: consentRows } = await pool.query(
    `SELECT status FROM pt_informed_consents
      WHERE client_id = $1 AND status NOT IN ('archived')
      ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  );
  const consent = consentRows[0];
  if (!consent || consent.status !== 'completed') {
    warnings.push('Informed Consent is not completed for this client.');
  }

  if (warnings.length > 0) {
    await logActivity(req, 'workout.assign.warned', 'pt_client', clientId, {
      warnings,
    });
  }

  return { blocked: null, warnings };
}

module.exports = { checkScreeningGate };

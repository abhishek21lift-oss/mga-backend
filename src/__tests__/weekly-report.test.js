// The weekly progress report.
//
// This is the one artefact in the module that LEAVES the system — it gets sent
// to a client, saved to their phone, and read months later without any of the
// context the app provides. So the things worth testing are the ones that would
// be embarrassing in a file a client keeps:
//
//   - reporting on someone else's client
//   - a week's page that quietly reports the whole block's attendance
//   - a volume figure that disagrees with the log it came from
//   - a projection presented as a fact

const request = require('supertest');

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = global.__mockUser; next(); },
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
}));
jest.mock('../middleware/rbac', () => ({ requireRole: () => (_req, _res, next) => next() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

const mockClientInOrg = jest.fn(async () => true);
jest.mock('../lib/orgGuard', () => ({ clientInOrg: (...a) => mockClientInOrg(...a) }));

// Capture what the generator is handed rather than parsing a PDF: the layout
// is not the contract, the data going into it is.
const mockGenerate = jest.fn(async () => '/uploads/progress-reports/c-1-2026-07-27.pdf');
jest.mock('../lib/weeklyProgressPdf', () => ({ generateWeeklyProgressPdf: (...a) => mockGenerate(...a) }));

const pool = require('../db/pool');

function app() {
  const express = require('express');
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));
  return a;
}

const ORG = '11111111-1111-1111-1111-111111111111';
const CLIENT = { id: 'c-1', name: 'Priya', organization_id: ORG, studio_name: 'MY PT STUDIO' };

/** Routes each read by its SQL so the six parallel queries can differ. */
function routed({ sessions = [], prs = [], sets = [], plan = null } = {}) {
  return async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/FROM pt_clients c/.test(s)) return { rows: [CLIENT] };
    if (/FROM workout_sessions ws LEFT JOIN workout_session_exercises/.test(s)) return { rows: sessions };
    if (/is_pr_weight OR s\.is_pr_reps/.test(s)) return { rows: prs };
    if (/GROUP BY e\.target_muscle/.test(s)) return { rows: sets };
    if (/FROM workout_assignments wa/.test(s)) return { rows: plan ? [plan] : [] };
    if (/muscle_volume_landmarks/.test(s)) return { rows: [{ target_muscle: 'chest', mev_sets: 8, mrv_sets: 22 }] };
    return { rows: [] };
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClientInOrg.mockResolvedValue(true);
  mockGenerate.mockResolvedValue('/uploads/progress-reports/c-1-2026-07-27.pdf');
  global.__mockUser = { id: 'u-1', role: 'trainer', organization_id: ORG };
  pool.query.mockImplementation(routed());
});

describe('POST /workout-log/weekly-report', () => {
  it('refuses another studio\'s client before generating anything', async () => {
    mockClientInOrg.mockResolvedValue(false);
    await request(app()).post('/api/pt-os/workout-log/weekly-report')
      .send({ client_id: 'c-9', week_start: '2026-07-29' }).expect(404);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('snaps any date in the week to that week\'s Monday', async () => {
    // A trainer taps the button on a Thursday. The report must cover Mon-Sun,
    // not Thursday-to-Thursday, or two consecutive reports overlap and both
    // claim the same sessions.
    const res = await request(app()).post('/api/pt-os/workout-log/weekly-report')
      .send({ client_id: 'c-1', week_start: '2026-07-30' }).expect(200);
    expect(res.body.data.week_start).toBe('2026-07-27');
    expect(res.body.data.week_end).toBe('2026-08-02');
  });

  it('reports ONE week of attendance, not the whole block', async () => {
    // The page is headed with a single week's dates, so the figure under them
    // must cover that week and nothing else.
    //
    // What enforces it is the DATE WINDOW handed to adherence, not the `weeks`
    // argument: start and asOf are six days apart, so one row comes back
    // whatever `weeks` says. Verified by mutation — bumping `weeks` to 12
    // leaves this test green, while widening asOf to a date months later
    // fails it, which is the failure that would actually reach a client.
    pool.query.mockImplementation(routed({
      plan: { start_date: '2026-07-27', planned_days: [1, 3, 5] },
      sessions: [
        { session_date: '2026-07-27', status: 'completed', total_volume: '4200', set_count: 12, notes: null },
        { session_date: '2026-07-29', status: 'completed', total_volume: '3800', set_count: 10, notes: 'Knee felt fine today.' },
      ],
    }));
    await request(app()).post('/api/pt-os/workout-log/weekly-report')
      .send({ client_id: 'c-1', week_start: '2026-07-27' }).expect(200);

    const { adherence } = mockGenerate.mock.calls[0][0];
    expect(adherence.planned).toBe(3);
    expect(adherence.completed).toBe(2);
    expect(adherence.weeks).toHaveLength(1);
  });

  it('computes volume from the sets, not a stored total', async () => {
    // Nothing keeps a denormalised session total in step with an edited set,
    // and a report that disagrees with the log is worse than no report.
    await request(app()).post('/api/pt-os/workout-log/weekly-report')
      .send({ client_id: 'c-1' }).expect(200);
    const sessionSql = pool.query.mock.calls
      .map(([s]) => String(s).replace(/\s+/g, ' '))
      .find((s) => /FROM workout_sessions ws LEFT JOIN workout_session_exercises/.test(s));
    expect(sessionSql).toMatch(/SUM\(s\.weight_kg \* s\.reps\) FILTER \(WHERE s\.completed\)/);
    // GROUP BY ws.id, or a session with two exercises fans into two rows and
    // the report double-counts the week.
    expect(sessionSql).toMatch(/GROUP BY ws\.id/);
  });

  it('carries each session\'s trainer note through to the document', async () => {
    // The note is the most specific thing in the report and the part a client
    // actually reads. Dropping it leaves a page of numbers.
    pool.query.mockImplementation(routed({
      sessions: [{ session_date: '2026-07-29', status: 'completed', total_volume: '3800', set_count: 10, notes: 'Knee felt fine today.' }],
    }));
    await request(app()).post('/api/pt-os/workout-log/weekly-report')
      .send({ client_id: 'c-1', week_start: '2026-07-27' }).expect(200);
    expect(mockGenerate.mock.calls[0][0].sessions[0].notes).toBe('Knee felt fine today.');
  });

  it('passes the trainer\'s own note through unchanged', async () => {
    await request(app()).post('/api/pt-os/workout-log/weekly-report')
      .send({ client_id: 'c-1', coach_note: 'Great week. Deload next.' }).expect(200);
    expect(mockGenerate.mock.calls[0][0].coachNote).toBe('Great week. Deload next.');
  });

  it('hands the generator no projection to print', async () => {
    // A PDF reads as a record, not as a screen. "At this rate you will squat
    // 140 kg by October" is two months of extrapolation from four points, and
    // a client cannot tell it from a measurement.
    await request(app()).post('/api/pt-os/workout-log/weekly-report')
      .send({ client_id: 'c-1' }).expect(200);
    const payload = mockGenerate.mock.calls[0][0];
    for (const key of ['forecast', 'projection', 'estimated_1rm_by', 'trend', 'score', 'grade']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('requires a client id', async () => {
    await request(app()).post('/api/pt-os/workout-log/weekly-report').send({}).expect(400);
  });

  it('reports no attendance target when the client has no programme', async () => {
    await request(app()).post('/api/pt-os/workout-log/weekly-report')
      .send({ client_id: 'c-1' }).expect(200);
    expect(mockGenerate.mock.calls[0][0].adherence).toBeNull();
  });
});

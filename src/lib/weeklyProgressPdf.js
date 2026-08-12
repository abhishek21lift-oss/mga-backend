// The weekly progress report a trainer sends a client.
//
// pdfkit, matching parqPdf.js and the rest of this repo — no headless browser
// to ship or run, which is the same constraint that decided the others.
//
// ── What goes in, and what deliberately does not ──────────────────────────
//
// Everything on this page is measured: sessions attended against sessions
// prescribed, volume moved, records broken, sets per muscle, and whatever the
// trainer wrote after each workout. There is no score, no grade and no
// projection.
//
// That last one matters most here, because a progress report is exactly where
// "at this rate you will squat 140 kg by October" wants to appear. Two months
// of linear extrapolation from four data points is not a forecast, and a
// client cannot tell the difference between a number that was measured and a
// number that was invented — especially inside a PDF, which reads as a record
// rather than as a screen.
//
// ── Why the trainer's note is the last section and not the first ──────────
//
// The numbers are the evidence; the note is the interpretation. Putting the
// note first makes the figures look like decoration for an opinion. Putting it
// last means a client reads what happened, then what their coach makes of it.

const PDFDocument = require('pdfkit');
const { fmtDate, drawSectionHeading, drawLabelValue } = require('./pdfHelpers');
const { saveFile } = require('./fileStorage');

const DAY_NAME = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** 12,480 rather than 12480 — a volume figure is read, not calculated with. */
const kg = (v) => `${Math.round(Number(v) || 0).toLocaleString('en-IN')} kg`;

/**
 * Build the report and store it.
 *
 * @param {object} input
 *   client        { id, name, organization_id }
 *   studioName    the studio's name for the header
 *   weekStart     'YYYY-MM-DD', the Monday
 *   weekEnd       'YYYY-MM-DD', the Sunday
 *   sessions      [{ session_date, status, duration_minutes, notes, total_volume, set_count }]
 *   adherence     { planned, completed, pct }
 *   prs           [{ session_date, exercise_name, weight_kg, reps, kinds }]
 *   muscles       [{ target_muscle, sets, status, mev_sets, mrv_sets }]
 *   coachNote     optional free text the trainer writes for this week
 * @returns {Promise<string>} the stored URL
 */
async function generateWeeklyProgressPdf(input) {
  const {
    client, studioName, weekStart, weekEnd,
    sessions = [], adherence = null, prs = [], muscles = [], coachNote = null,
  } = input;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  // ── Header ──
  doc.fontSize(18).font('Helvetica-Bold').fillColor('#111827')
    .text('Weekly Progress Report', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#6B7280')
    .text(studioName || 'Training Report', { align: 'center' });
  doc.moveDown();

  drawSectionHeading(doc, 'Client');
  drawLabelValue(doc, 'Name:', client?.name);
  drawLabelValue(doc, 'Week:', `${fmtDate(weekStart)} to ${fmtDate(weekEnd)}`);

  // ── Attendance ──
  drawSectionHeading(doc, 'Attendance');
  if (!adherence || adherence.pct == null) {
    // No programme means there is no target. Printing "0 of 0 (0%)" would read
    // as a failure rather than as an absence of anything to measure.
    doc.fontSize(10).fillColor('#6B7280')
      .text('No programme was assigned for this week, so there is no attendance target to report against.');
  } else {
    drawLabelValue(doc, 'Sessions completed:', `${adherence.completed} of ${adherence.planned} (${adherence.pct}%)`);
  }

  // ── The week's sessions ──
  drawSectionHeading(doc, 'Sessions');
  const completed = sessions.filter((s) => s.status === 'completed');
  if (completed.length === 0) {
    doc.fontSize(10).fillColor('#6B7280').text('No completed sessions this week.');
  } else {
    for (const s of completed) {
      const day = DAY_NAME[isoDow(s.session_date)] || '';
      const bits = [
        s.set_count ? `${s.set_count} sets` : null,
        s.total_volume ? kg(s.total_volume) : null,
        s.duration_minutes ? `${s.duration_minutes} min` : null,
      ].filter(Boolean);
      drawLabelValue(doc, `${day} ${fmtDate(s.session_date)}:`, bits.join(' · ') || 'logged');
      if (s.notes) {
        // The trainer's note from that session, verbatim. It is the most
        // specific thing in the document and the part a client actually reads.
        doc.fontSize(9).fillColor('#4B5563').font('Helvetica-Oblique')
          .text(s.notes, { indent: 12 });
        doc.font('Helvetica').fillColor('#111827');
      }
    }
    const weekVolume = completed.reduce((t, s) => t + (Number(s.total_volume) || 0), 0);
    doc.moveDown(0.3);
    drawLabelValue(doc, 'Total volume this week:', kg(weekVolume));
  }

  // ── Records ──
  drawSectionHeading(doc, 'Personal Records');
  if (prs.length === 0) {
    doc.fontSize(10).fillColor('#6B7280')
      .text('No new records this week. Records are rare by definition — a week without one is a normal week.');
  } else {
    for (const p of prs) {
      const load = [
        p.weight_kg != null ? `${p.weight_kg} kg` : null,
        p.reps != null ? `${p.reps} reps` : null,
      ].filter(Boolean).join(' × ');
      drawLabelValue(doc, `${p.exercise_name}:`, `${load}  (${p.kinds.join(', ')})`);
    }
  }

  // ── Sets per muscle ──
  if (muscles.length > 0) {
    drawSectionHeading(doc, 'Sets per muscle');
    for (const m of muscles) {
      // The range is the studio's, and the line says so. Without that, a
      // client reads "below range" as a clinical finding rather than as their
      // coach's target.
      const range = m.mev_sets != null || m.mrv_sets != null
        ? ` (your coach's target ${m.mev_sets ?? '—'}–${m.mrv_sets ?? '—'})`
        : '';
      drawLabelValue(doc, `${cap(m.target_muscle)}:`, `${m.sets} sets${range}`);
    }
  }

  // ── The coach's note ──
  if (coachNote && String(coachNote).trim()) {
    drawSectionHeading(doc, 'From your coach');
    doc.fontSize(10).fillColor('#111827').font('Helvetica').text(String(coachNote).trim());
  }

  doc.moveDown(1);
  doc.fontSize(8).fillColor('#9CA3AF')
    .text('All figures in this report are taken from workouts logged during the week shown.', { align: 'center' });

  doc.end();
  const buffer = await new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Keyed by client and week, so regenerating a week overwrites rather than
  // accumulating a new file per tap of the button.
  //
  // The client id must lead the filename and must be a UUID: routes/uploads.js
  // takes the first 36 characters of the basename as the owning row's id and
  // refuses anything that is not UUID-shaped, which is what stops another
  // studio fetching this report. Every pt_clients.id is UUID-shaped today
  // (checked against the live table), but the column is TEXT, so a
  // non-UUID id would make its owner's report unreadable rather than
  // world-readable — the safe direction, and worth knowing about.
  return saveFile(
    'progress-reports',
    `${client.id}-${weekStart}.pdf`,
    buffer,
    'application/pdf',
    { organizationId: client?.organization_id },
  );
}

function isoDow(date) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? 0 : ((d.getUTCDay() + 6) % 7) + 1;
}

const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

module.exports = { generateWeeklyProgressPdf };

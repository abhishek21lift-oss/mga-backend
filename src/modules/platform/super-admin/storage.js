'use strict';
// Storage accounting — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  pool,
} = require('./shared');
// ═══════════════════════════════════════════════════════════════════════════
//  STORAGE ACCOUNTING
//
//  Per-studio object-storage usage — the fourth and last source the Executive
//  Dashboard needs, alongside AI usage, support tickets and churn.
//
//  ── Every number here is partial, and every response says so ──────────────
//
//  Objects written before migration 128 ran have no ledger row, so these are
//  bytes ACCOUNTED SINCE `measuring_since`, not bytes in the bucket. That
//  field is returned by every endpoint for the same reason the Billing Centre
//  labels un-itemised invoices and the AI Control Centre names unpriced
//  models: a partial figure presented as a total gets budgeted against.
//
//  ── Live vs. ever ──────────────────────────────────────────────────────────
//
//  Deletes are soft. `bytes` everywhere means live bytes (deleted_at IS NULL);
//  deleted bytes are reported separately as `deleted_bytes`, because "what am
//  I paying for" and "what has this studio ever uploaded" are different
//  questions and averaging them answers neither.
//
//  ── Unattributed bytes are shown, not hidden ──────────────────────────────
//
//  A write from a path with no studio in scope records with organization_id
//  NULL. Those rows are excluded from by-studio and reported as
//  `unattributed_bytes`, so the per-studio rows always sum to less than the
//  total and the difference is visible rather than silently absorbed.
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_MAX_DAYS = 365;
function storageDays(v, dflt = 30) {
  const n = Number(v);
  if (!Number.isFinite(n) || String(v ?? '').trim() === '') return dflt;
  return Math.min(Math.max(Math.trunc(n), 1), STORAGE_MAX_DAYS);
}

async function measuringSince() {
  try {
    const { rows } = await pool.query('SELECT measuring_since FROM storage_accounting_meta WHERE id');
    return rows[0]?.measuring_since || null;
  } catch { return null; }
}

// ── GET /storage/overview ───────────────────────────────────────────────────
router.get('/storage/overview', async (req, res, next) => {
  try {
    const days = storageDays(req.query.days);
    const [totals, byCategory, since] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(bytes) FILTER (WHERE deleted_at IS NULL), 0)::bigint AS bytes,
                count(*) FILTER (WHERE deleted_at IS NULL)::int                   AS objects,
                -- Soft-deleted rows: bytes no longer live, kept so history
                -- stays answerable. Reported apart, never netted in.
                COALESCE(SUM(bytes) FILTER (WHERE deleted_at IS NOT NULL), 0)::bigint AS deleted_bytes,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int               AS deleted_objects,
                COALESCE(SUM(bytes) FILTER (WHERE deleted_at IS NULL
                                              AND organization_id IS NULL), 0)::bigint AS unattributed_bytes,
                count(DISTINCT organization_id) FILTER (WHERE deleted_at IS NULL)::int AS studios,
                COALESCE(SUM(bytes) FILTER (WHERE deleted_at IS NULL
                                              AND created_at >= now() - ($1 || ' days')::interval),
                         0)::bigint                                               AS bytes_added,
                count(*) FILTER (WHERE deleted_at IS NULL
                                   AND created_at >= now() - ($1 || ' days')::interval)::int AS objects_added
           FROM storage_objects`,
        [String(days)]
      ),
      pool.query(
        `SELECT category,
                COALESCE(SUM(bytes), 0)::bigint AS bytes,
                count(*)::int                   AS objects
           FROM storage_objects
          WHERE deleted_at IS NULL
          GROUP BY category
          ORDER BY 2 DESC`
      ),
      measuringSince(),
    ]);

    const t = totals.rows[0];
    res.json({
      data: {
        window_days: days,
        bytes: Number(t.bytes),
        objects: t.objects,
        deleted_bytes: Number(t.deleted_bytes),
        deleted_objects: t.deleted_objects,
        unattributed_bytes: Number(t.unattributed_bytes),
        studios: t.studios,
        bytes_added: Number(t.bytes_added),
        objects_added: t.objects_added,
        by_category: byCategory.rows.map((r) => ({ ...r, bytes: Number(r.bytes) })),
        // The honesty valve. Null only if the meta row is somehow missing, in
        // which case the UI should say the coverage is unknown rather than
        // imply it is complete.
        measuring_since: since,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /storage/by-studio ──────────────────────────────────────────────────
// Ranked by live bytes. Studios with no accounted objects are omitted rather
// than listed at zero — zero here means "nothing since measuring_since", not
// "nothing stored", and a screen full of zeroes reads as the latter.
router.get('/storage/by-studio', async (req, res, next) => {
  try {
    const [result, since] = await Promise.all([
      pool.query(
        `SELECT o.id AS organization_id, o.name AS organization_name, o.plan_code,
                COALESCE(SUM(s.bytes) FILTER (WHERE s.deleted_at IS NULL), 0)::bigint AS bytes,
                count(*) FILTER (WHERE s.deleted_at IS NULL)::int                     AS objects,
                COALESCE(SUM(s.bytes) FILTER (WHERE s.deleted_at IS NOT NULL), 0)::bigint AS deleted_bytes,
                count(DISTINCT s.category) FILTER (WHERE s.deleted_at IS NULL)::int   AS categories,
                max(s.created_at) FILTER (WHERE s.deleted_at IS NULL)                 AS last_upload_at
           FROM storage_objects s
           JOIN organizations o ON o.id = s.organization_id
          GROUP BY o.id, o.name, o.plan_code
          ORDER BY 4 DESC`
      ),
      measuringSince(),
    ]);
    res.json({
      data: result.rows.map((r) => ({
        ...r, bytes: Number(r.bytes), deleted_bytes: Number(r.deleted_bytes),
      })),
      meta: { measuring_since: since },
    });
  } catch (err) { next(err); }
});

// ── GET /storage/trend ──────────────────────────────────────────────────────
// Bytes accounted per day, by upload date. Not a running total of what is
// stored: a day's figure is what arrived that day, so a spike is visible
// instead of being flattened into a rising line.
router.get('/storage/trend', async (req, res, next) => {
  try {
    const days = storageDays(req.query.days);
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COALESCE(SUM(bytes), 0)::bigint                       AS bytes,
              count(*)::int                                         AS objects
         FROM storage_objects
        WHERE created_at >= now() - ($1 || ' days')::interval
          AND deleted_at IS NULL
        GROUP BY 1
        ORDER BY 1`,
      [String(days)]
    );
    res.json({ data: rows.map((r) => ({ ...r, bytes: Number(r.bytes) })) });
  } catch (err) { next(err); }
});

// ── GET /storage/largest ────────────────────────────────────────────────────
// The objects actually driving the bill. Keys only — no content is read, and
// nothing here can serve a file.
router.get('/storage/largest', async (req, res, next) => {
  try {
    const n = Number(req.query.limit);
    const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 100) : 25;
    const { rows } = await pool.query(
      `SELECT s.key, s.category, s.bytes::bigint, s.content_type, s.created_at,
              o.name AS organization_name
         FROM storage_objects s
         LEFT JOIN organizations o ON o.id = s.organization_id
        WHERE s.deleted_at IS NULL
        ORDER BY s.bytes DESC, s.created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ data: rows.map((r) => ({ ...r, bytes: Number(r.bytes) })) });
  } catch (err) { next(err); }
});

module.exports = router;

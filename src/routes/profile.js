const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');
// otplib v13 removed the `authenticator` singleton that v12 exported and
// replaced it with these functions. Verification now returns a RESULT OBJECT
// ({ valid, delta, ... }), not a boolean — reading it as a boolean would make
// every code appear valid, so the `.valid` property is checked explicitly.
// `epochTolerance` is in SECONDS; 30 is one TOTP step either side, matching
// what v12's `{ window: 1 }` meant.
const { generateSecret, verifySync } = require('otplib');
const pool = require('../db/pool');
const { auth, invalidateUserCache } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const logger = require('../lib/logger');
const { saveFile, deleteFile } = require('../lib/fileStorage');
const credentials = require('../lib/credentials');
const profileFields = require('../lib/profileFields');
const { profileCompletion } = require('../lib/profileCompletion');
const portfolio = require('../lib/portfolio');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || '')) {
      return cb(new Error('Only PNG, JPG, WEBP, or GIF images are allowed'));
    }
    cb(null, true);
  },
});

const defaultNotifications = {
  email_logins: true,
  email_payments: true,
  email_reports: true,
  email_marketing: false,
  push_logins: true,
  push_tasks: true,
  push_mentions: true,
  whatsapp_alerts: false,
  frequency: 'instant',
};

const defaultPreferences = {
  theme: 'system',
  language: 'en',
  timezone: 'Asia/Calcutta',
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '12h',
  compactMode: false,
};

let schemaReady;

function jsonOrDefault(value, fallback) {
  if (!value) return { ...fallback };
  if (typeof value === 'object') return { ...fallback, ...value };
  try {
    return { ...fallback, ...JSON.parse(value) };
  } catch {
    return { ...fallback };
  }
}

function clientInfo(req) {
  const ua = String(req.headers['user-agent'] || '');
  const browser = /Chrome/i.test(ua) ? 'Chrome'
    : /Firefox/i.test(ua) ? 'Firefox'
    : /Safari/i.test(ua) ? 'Safari'
    : /Edge/i.test(ua) ? 'Edge'
    : 'Browser';
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Mac OS|Macintosh/i.test(ua) ? 'macOS'
    : /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';
  const type = /Mobile|Android|iPhone/i.test(ua) ? 'mobile' : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
  return { browser, os, type, ip: req.ip || '' };
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT,
        location TEXT,
        bio TEXT,
        avatar_url TEXT,
        notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
        preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
        mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        mfa_secret TEXT,
        job_title TEXT,
        experience_since DATE,
        specialisations JSONB NOT NULL DEFAULT '[]'::jsonb,
        certifications JSONB NOT NULL DEFAULT '[]'::jsonb,
        cover_url TEXT,
        designation TEXT,
        philosophy TEXT,
        training_style TEXT,
        current_gym TEXT,
        languages JSONB NOT NULL DEFAULT '[]'::jsonb,
        coaching_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
        previous_gyms JSONB NOT NULL DEFAULT '[]'::jsonb,
        education JSONB NOT NULL DEFAULT '[]'::jsonb,
        achievements JSONB NOT NULL DEFAULT '[]'::jsonb,
        working_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  await schemaReady;
}

async function profileFor(userId) {
  await ensureSchema();
  await pool.query('INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.created_at, u.last_login,
            p.phone, p.location, p.bio, p.avatar_url,
            p.notification_preferences, p.preferences, p.mfa_enabled,
            p.job_title, p.experience_since, p.specialisations, p.certifications,
            p.cover_url, p.designation, p.philosophy, p.training_style, p.current_gym,
            p.languages, p.coaching_modes, p.previous_gyms, p.education,
            p.achievements, p.working_hours,
            -- Completion scores the portfolio, and a count is all it needs.
            -- Fetching the rows here would put a 30-item gallery inside every
            -- profile read for one integer; the gallery has its own endpoint.
            (SELECT count(*) FROM user_portfolio_items i WHERE i.user_id = u.id) AS portfolio_count
       FROM users u
  LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  return rows[0];
}

/** A JSONB column that should hold a list, defended at the boundary. */
function arr(v) { return Array.isArray(v) ? v : []; }

function shapeProfile(row) {
  const since = row.experience_since
    ? new Date(row.experience_since).toISOString().slice(0, 10) : null;
  return {
    id: row.id,
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    role: row.role || '',
    location: row.location || '',
    bio: row.bio || '',
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login,
    mfaEnabled: Boolean(row.mfa_enabled),
    jobTitle: row.job_title || '',
    // Normalise ONCE and derive from that. node-postgres hands a DATE column
    // back as a Date object, not a 'YYYY-MM-DD' string, and passing the raw
    // value to yearsOfExperience() made it reject its own stored date and
    // report null years for everyone.
    experienceSince: since,
    // A date in, a duration out. See lib/credentials.js — storing "8 years"
    // is wrong twelve months later and nobody comes back to correct it.
    yearsExperience: credentials.yearsOfExperience(since),
    specialisations: Array.isArray(row.specialisations) ? row.specialisations : [],
    // Each certificate arrives with its expiry status already decided. The
    // browser's clock is not evidence of whether someone is currently
    // qualified to take a session.
    certifications: credentials.presentCertifications(row.certifications),
    credentialSummary: credentials.credentialSummary(row.certifications),

    // ── Migration 133 fields ────────────────────────────────────────────────
    coverUrl: row.cover_url || null,
    designation: row.designation || '',
    philosophy: row.philosophy || '',
    trainingStyle: row.training_style || '',
    currentGym: row.current_gym || '',
    languages: arr(row.languages),
    coachingModes: arr(row.coaching_modes),
    previousGyms: arr(row.previous_gyms),
    education: arr(row.education),
    achievements: arr(row.achievements),
    workingHours: (row.working_hours && typeof row.working_hours === 'object'
      && !Array.isArray(row.working_hours)) ? row.working_hours : {},
    // Derived, so the UI never has to add up a week of split shifts itself
    // and then disagree with the next screen that tries.
    weeklyMinutes: profileFields.weeklyMinutes(row.working_hours),
    // count(*) is a BIGINT, which node-postgres hands back as a string. Left
    // as one it would render "3" correctly and compare as "3" > 30, so it is
    // coerced once here rather than at each place that reads it.
    portfolioCount: Number(row.portfolio_count || 0),

    // The percentage and the checklist come from ONE call over one weight
    // table, so the ring and the next-step list can never disagree about the
    // same profile. Computed here rather than in the browser because it
    // describes SAVED data — it must change when the server accepts a write,
    // not while somebody is typing.
    completion: profileCompletion(row),
  };
}

router.use(auth);

router.get('/me', async (req, res, next) => {
  try {
    const row = await profileFor(req.user.id);
    res.json(shapeProfile(row));
  } catch (err) {
    next(err);
  }
});

/**
 * Every column on user_profiles that PUT /me may write, as data.
 *
 * ── Why a table and not eighteen if-blocks ───────────────────────────────────
 *
 * The rule "a field the client did not send is left alone" has to hold for
 * every field, and the version of this written as one guard per field did not:
 * phone, location and bio were built into the SET list unconditionally, so a
 * PUT that omitted them wrote '' over whatever was there. Nobody noticed
 * because the only client always sent all three — until this page grew tabs
 * that legitimately do not render them.
 *
 * Expressed this way the rule lives in exactly one line of the loop below, so
 * a nineteenth field cannot forget it.
 *
 * `parse` returns { value } or { error }, matching lib/credentials.js.
 * `json` marks a column that must be stringified before it is bound.
 */
const ok = (value) => ({ value });

const PROFILE_FIELDS = [
  { body: 'phone',            col: 'phone',            parse: (v) => ok(credentials.cleanText(v, 40)) },
  { body: 'location',         col: 'location',         parse: (v) => ok(credentials.cleanText(v, 160)) },
  { body: 'bio',              col: 'bio',              parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.freeText)) },
  { body: 'job_title',        col: 'job_title',        parse: (v) => ok(credentials.cleanText(v, credentials.LIMITS.job_title)) },
  { body: 'designation',      col: 'designation',      parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.designation)) },
  { body: 'philosophy',       col: 'philosophy',       parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.philosophy)) },
  { body: 'training_style',   col: 'training_style',   parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.trainingStyle)) },
  { body: 'current_gym',      col: 'current_gym',      parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.gymName)) },
  {
    body: 'experience_since',
    col: 'experience_since',
    parse: (v) => {
      const d = credentials.cleanDate(v);
      return d === undefined ? { error: 'Invalid experience start date' } : ok(d);
    },
  },
  { body: 'specialisations',  col: 'specialisations',  parse: credentials.validateSpecialisations,  json: true },
  { body: 'certifications',   col: 'certifications',   parse: credentials.validateCertifications,   json: true },
  { body: 'languages',        col: 'languages',        parse: profileFields.validateLanguages,      json: true },
  { body: 'coaching_modes',   col: 'coaching_modes',   parse: profileFields.validateCoachingModes,  json: true },
  { body: 'previous_gyms',    col: 'previous_gyms',    parse: profileFields.validatePreviousGyms,   json: true },
  { body: 'education',        col: 'education',        parse: profileFields.validateEducation,      json: true },
  { body: 'achievements',     col: 'achievements',     parse: profileFields.validateAchievements,   json: true },
  { body: 'working_hours',    col: 'working_hours',    parse: profileFields.validateWorkingHours,   json: true },
];

router.put('/me', async (req, res, next) => {
  try {
    await ensureSchema();
    // name and email stay outside the table: they live on `users`, they are
    // required rather than optional, and email carries a uniqueness check.
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 AND deleted_at IS NULL',
      [email, req.user.id]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    // Validate everything BEFORE writing anything, so a bad certification
    // cannot leave the name and email already updated.
    const writes = [];
    for (const f of PROFILE_FIELDS) {
      if (req.body[f.body] === undefined) continue;   // ← the whole contract, once
      const r = f.parse(req.body[f.body]);
      if (r.error) return res.status(400).json({ error: r.error });
      writes.push([f.col, f.json ? JSON.stringify(r.value) : r.value]);
    }

    await pool.query('UPDATE users SET name = $1, email = $2, updated_at = NOW() WHERE id = $3', [name, email, req.user.id]);

    // Guarantee the row, then UPDATE only the columns this request carried.
    //
    // The obvious shape — one INSERT ... ON CONFLICT with COALESCE on each
    // value — cannot express the difference between "the client omitted this
    // field" and "the client cleared it", because both arrive as NULL and
    // COALESCE keeps the old value for each. That would make an experience
    // date, once set, impossible to erase.
    await pool.query('INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.id]);

    if (writes.length) {
      const params = [req.user.id];
      const sets = writes.map(([col, value]) => { params.push(value); return `${col} = $${params.length}`; });
      sets.push('updated_at = NOW()');
      await pool.query(`UPDATE user_profiles SET ${sets.join(', ')} WHERE user_id = $1`, params);
    }

    invalidateUserCache(req.user.id);
    await logActivity(req, 'profile.update', 'user', req.user.id, { name, email });
    const row = await profileFor(req.user.id);
    res.json(shapeProfile(row));
  } catch (err) {
    next(err);
  }
});

// M-06: magic byte signatures to verify actual file type, not just MIME header
const IMAGE_SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg',  magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  ext: 'png',  magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif',  ext: 'gif',  magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46], offset4: [0x57, 0x45, 0x42, 0x50] },
];

function detectImageType(buf) {
  for (const sig of IMAGE_SIGNATURES) {
    const header = sig.magic.every((b, i) => buf[i] === b);
    if (!header) continue;
    if (sig.offset4 && !sig.offset4.every((b, i) => buf[8 + i] === b)) continue;
    return sig;
  }
  return null;
}

/**
 * Remove an object a profile column no longer points at.
 *
 * Fire-and-forget, for the same reason the storage ledger is: a failed cleanup
 * must not fail an upload that has already succeeded. The object stays in
 * storage_objects, so it is still accounted for and can be reaped.
 */
function forgetObject(url, what) {
  if (!url) return;
  const key = String(url).replace(/^\/uploads\//, '');
  Promise.resolve(deleteFile(key)).catch((err) =>
    logger.warn({ err: err.message, key }, `old ${what} cleanup failed (non-critical)`));
}

/**
 * Point a single-image profile column at a new object, and remove the one it
 * replaced.
 *
 * Avatar and cover are the same operation on two columns, and the part worth
 * sharing is the ORDER: read the outgoing URL, save the new object, write the
 * row, and only then delete. A delete that ran first and then failed to save
 * would leave the profile pointing at a file that no longer exists.
 *
 * `column` is interpolated into the SQL, so it is a literal from the two call
 * sites below and never anything a request can influence.
 *
 * @returns {{value:string}|{error:string, status:number}}
 */
async function swapProfileImage(req, { column, buffer, prefix = '' }) {
  // M-06: verify magic bytes — MIME header alone can be spoofed
  const detected = detectImageType(buffer);
  if (!detected) {
    return { error: 'File content does not match an allowed image type (PNG, JPG, WEBP, GIF)', status: 400 };
  }

  // Read the outgoing object BEFORE overwriting the column. Without this every
  // change left its predecessor in R2 for good — invisible, unreferenced, and
  // billed.
  const { rows: prev } = await pool.query(
    `SELECT ${column} AS url FROM user_profiles WHERE user_id = $1`, [req.user.id]
  );
  const previousUrl = prev[0]?.url || null;

  const filename = `${prefix}${req.user.id}-${Date.now()}.${detected.ext}`;
  const url = await saveFile('profile', filename, buffer, detected.mime,
    { organizationId: req.user.organization_id, uploadedBy: req.user.id });

  await pool.query(
    `INSERT INTO user_profiles (user_id, ${column}, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET ${column} = EXCLUDED.${column}, updated_at = NOW()`,
    [req.user.id, url]
  );

  if (previousUrl && previousUrl !== url) forgetObject(previousUrl, column);
  return { value: url };
}

router.post('/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Avatar file is required' });
    await ensureSchema();

    const saved = await swapProfileImage(req, { column: 'avatar_url', buffer: req.file.buffer });
    if (saved.error) return res.status(saved.status).json({ error: saved.error });

    await logActivity(req, 'profile.avatar.update', 'user', req.user.id);
    res.json({ avatarUrl: saved.value });
  } catch (err) {
    next(err);
  }
});

// A cover banner is a wide image behind the identity block, so it carries more
// pixels than an avatar and gets its own ceiling. Same category as the avatar:
// `profile/` is the public tier in routes/uploads.js, which is correct for both
// — they are the two images a profile exists to show.
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || '')) {
      return cb(new Error('Only PNG, JPG, WEBP, or GIF images are allowed'));
    }
    cb(null, true);
  },
});

router.post('/cover', coverUpload.single('cover'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Cover image is required' });
    await ensureSchema();

    const saved = await swapProfileImage(req, {
      column: 'cover_url', buffer: req.file.buffer, prefix: 'cover-',
    });
    if (saved.error) return res.status(saved.status).json({ error: saved.error });

    await logActivity(req, 'profile.cover.update', 'user', req.user.id);
    res.json({ coverUrl: saved.value });
  } catch (err) {
    next(err);
  }
});

// A cover is decoration, and decoration someone regrets has to be removable —
// unlike an avatar, which always falls back to initials, a banner they dislike
// would otherwise be permanent. Column cleared first, object second, matching
// the portfolio delete: a broken image is worse than a stale object.
router.delete('/cover', async (req, res, next) => {
  try {
    await ensureSchema();
    // Read then write, rather than one statement with a subquery in RETURNING:
    // that form's correctness turns on which snapshot the subquery sees, which
    // is exactly the kind of thing a later reader gets wrong. Two concurrent
    // deletes would both remove the same key, which is a no-op.
    const { rows } = await pool.query(
      'SELECT cover_url FROM user_profiles WHERE user_id = $1', [req.user.id]
    );
    await pool.query(
      'UPDATE user_profiles SET cover_url = NULL, updated_at = NOW() WHERE user_id = $1',
      [req.user.id]
    );
    forgetObject(rows[0]?.cover_url, 'cover_url');
    await logActivity(req, 'profile.cover.remove', 'user', req.user.id);
    res.json({ coverUrl: null });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PORTFOLIO
//
//  Every route here is scoped by `user_id = req.user.id`, which is inherently
//  tenant-scoped — a row belongs to exactly one person. organization_id is
//  stamped from the session on insert so routes/uploads.js can resolve a
//  served object key back to an owner without a join.
//
//  ── Ordering of writes, and why ──────────────────────────────────────────
//
//  UPLOAD: file first, row second, and the key deleted in the catch. If the
//  INSERT fails, the orphan is one ledger entry an operator can reap.
//
//  DELETE: row first, file second. A failed file delete leaks an object that
//  storage_objects still knows about. The inverse leaves a row pointing at
//  nothing — a permanently broken tile whose delete button already "worked",
//  which is the worse of the two.
// ═══════════════════════════════════════════════════════════════════════════

const portfolioUpload = multer({
  storage: multer.memoryStorage(),
  // The route enforces the real per-kind limits; this is the outer wall so a
  // large body is rejected before it is buffered.
  limits: { fileSize: portfolio.LIMITS.imageBytes, files: 2 },
});

async function portfolioRows(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM user_portfolio_items
      WHERE user_id = $1
      ORDER BY pinned DESC, sort_order ASC, created_at DESC`,
    [userId]
  );
  return rows;
}

/** Save one image buffer, returning what the row needs. */
async function saveImage(req, buffer, limitBytes) {
  const detected = detectImageType(buffer);
  if (!detected) return { error: 'File content does not match an allowed image type (PNG, JPG, WEBP, GIF)', status: 400 };
  const quota = portfolio.checkQuota({ currentCount: 0, bytes: buffer.length, limitBytes });
  if (quota.error) return quota;

  // Its own UUID, not the row's: a before/after holds two objects, and
  // uploads.js resolves ownership by looking the key up directly.
  const key = `portfolio/${crypto.randomUUID()}.${detected.ext}`;
  const url = await saveFile('portfolio', key.split('/')[1], buffer, detected.mime,
    { organizationId: req.user.organization_id, uploadedBy: req.user.id });
  return { value: { key, url, mime: detected.mime, bytes: buffer.length } };
}

router.get('/portfolio', async (req, res, next) => {
  try {
    res.json((await portfolioRows(req.user.id)).map(portfolio.present));
  } catch (err) { next(err); }
});

router.post('/portfolio', portfolioUpload.fields([
  { name: 'file', maxCount: 1 }, { name: 'after', maxCount: 1 },
]), async (req, res, next) => {
  const written = [];
  try {
    const kind = String(req.body.kind || 'image');
    if (!portfolio.KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown item kind' });

    const existing = await portfolioRows(req.user.id);
    const cap = portfolio.checkQuota({
      currentCount: existing.length,
      bytes: req.files?.file?.[0]?.buffer?.length ?? 0,
      limitBytes: kind === 'video_link' ? portfolio.LIMITS.posterBytes : portfolio.LIMITS.imageBytes,
    });
    if (cap.error) return res.status(cap.status).json({ error: cap.error });

    const { value: meta } = portfolio.validateMeta(req.body);

    // Every kind needs a primary image: for a video_link it is the poster,
    // because a card with no picture is a grey box in a gallery.
    const primary = await saveImage(req, req.files.file[0].buffer,
      kind === 'video_link' ? portfolio.LIMITS.posterBytes : portfolio.LIMITS.imageBytes);
    if (primary.error) return res.status(primary.status).json({ error: primary.error });
    written.push(primary.value.key);

    let after = null;
    let externalUrl = null;

    if (kind === 'before_after') {
      if (!req.files?.after?.[0]) return res.status(400).json({ error: 'A before/after needs both images' });
      const second = await saveImage(req, req.files.after[0].buffer, portfolio.LIMITS.imageBytes);
      if (second.error) return res.status(second.status).json({ error: second.error });
      written.push(second.value.key);
      after = second.value;
    } else if (kind === 'video_link') {
      const parsed = portfolio.parseVideoUrl(req.body.external_url);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      externalUrl = parsed.value.url;
    }

    const { rows } = await pool.query(
      `INSERT INTO user_portfolio_items
         (user_id, organization_id, kind, title, caption,
          file_key, file_url, mime_type, file_size_bytes,
          after_file_key, after_file_url, after_mime_type, after_file_size_bytes,
          external_url, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               COALESCE((SELECT MAX(sort_order) + 1 FROM user_portfolio_items WHERE user_id = $1), 0))
       RETURNING *`,
      [req.user.id, req.user.organization_id || null, kind, meta.title, meta.caption,
       primary.value.key, primary.value.url, primary.value.mime, primary.value.bytes,
       after?.key || null, after?.url || null, after?.mime || null, after?.bytes ?? null,
       externalUrl]
    );

    await logActivity(req, 'profile.portfolio.add', 'user', req.user.id, { kind });
    res.status(201).json(portfolio.present(rows[0]));
  } catch (err) {
    // The files landed but the row did not. Remove them rather than leave
    // objects nothing will ever reference.
    for (const key of written) {
      Promise.resolve(deleteFile(key)).catch(() => {});
    }
    next(err);
  }
});

router.patch('/portfolio/:id', async (req, res, next) => {
  try {
    const { rows: found } = await pool.query(
      'SELECT * FROM user_portfolio_items WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    // 404 rather than 403 for someone else's item: a 403 confirms the id
    // exists, which is information the caller has no business having.
    if (!found.length) return res.status(404).json({ error: 'Item not found' });

    const sets = [];
    const params = [req.params.id, req.user.id];
    const put = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };

    // Same partial rule as PUT /me: omitted means untouched.
    if (req.body.title !== undefined) put('title', portfolio.validateMeta(req.body).value.title);
    if (req.body.caption !== undefined) put('caption', portfolio.validateMeta(req.body).value.caption);

    if (req.body.pinned !== undefined) {
      const want = Boolean(req.body.pinned);
      if (want && !found[0].pinned) {
        const { rows: c } = await pool.query(
          'SELECT count(*)::int n FROM user_portfolio_items WHERE user_id = $1 AND pinned', [req.user.id]
        );
        const lim = portfolio.checkPinLimit(c[0].n);
        if (lim.error) return res.status(lim.status).json({ error: lim.error });
      }
      put('pinned', want);
    }

    if (!sets.length) return res.json(portfolio.present(found[0]));
    sets.push('updated_at = now()');
    const { rows } = await pool.query(
      `UPDATE user_portfolio_items SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
      params
    );
    res.json(portfolio.present(rows[0]));
  } catch (err) { next(err); }
});

router.delete('/portfolio/:id', async (req, res, next) => {
  try {
    // DELETE ... RETURNING: one statement that both removes the row and hands
    // back the keys, so two concurrent deletes cannot both try to remove the
    // same objects.
    const { rows } = await pool.query(
      'DELETE FROM user_portfolio_items WHERE id = $1 AND user_id = $2 RETURNING file_key, after_file_key',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    for (const key of [rows[0].file_key, rows[0].after_file_key].filter(Boolean)) {
      Promise.resolve(deleteFile(key)).catch((err) =>
        logger.warn({ err: err.message, key }, 'portfolio object cleanup failed (non-critical)'));
    }
    await logActivity(req, 'profile.portfolio.remove', 'user', req.user.id, {});
    res.json({ id: req.params.id, removed: true });
  } catch (err) { next(err); }
});

router.put('/portfolio/order', async (req, res, next) => {
  try {
    const existing = await portfolioRows(req.user.id);
    const check = portfolio.validateOrder(req.body.ids, existing.map((r) => r.id));
    if (check.error) {
      // A 409 carries the current list so a stale tab can re-render from truth
      // instead of guessing what it missed.
      return res.status(check.status).json({
        error: check.error,
        ...(check.status === 409 ? { items: existing.map(portfolio.present) } : {}),
      });
    }

    // One statement, so a failure part-way cannot leave half an order applied.
    const values = check.value.map((_, i) => `($${i + 2}::uuid, ${i})`).join(', ');
    await pool.query(
      `UPDATE user_portfolio_items p SET sort_order = v.ord, updated_at = now()
         FROM (VALUES ${values}) AS v(id, ord)
        WHERE p.id = v.id AND p.user_id = $1`,
      [req.user.id, ...check.value]
    );
    res.json((await portfolioRows(req.user.id)).map(portfolio.present));
  } catch (err) { next(err); }
});

router.put('/password', async (req, res, next) => {
  try {
    const currentPassword = String(req.body.currentPassword || req.body.current || '');
    const newPassword = String(req.body.newPassword || req.body.password || '');
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 12);
    // AUD-005. This is a SECOND password-change path, parallel to
    // /api/auth/change-password, and it had no refresh-token revocation at all —
    // so changing your password here left every refresh token alive for the rest
    // of its 7-day window, including a stolen one. Bumping token_version only
    // kills the 15-minute access tokens; /api/auth/refresh never reads it.
    //
    // Unlike the auth.js handler this route issues no replacement session, so
    // every token goes, the caller's included — which matches what this route
    // already did to the access token.
    await pool.query(
      `WITH pw AS (
         UPDATE users
            SET password = $1, token_version = token_version + 1, updated_at = NOW()
          WHERE id = $2
         RETURNING id
       )
       UPDATE refresh_tokens
          SET revoked_at = NOW()
        WHERE user_id = (SELECT id FROM pw)
          AND revoked_at IS NULL`,
      [hashed, req.user.id]
    );
    invalidateUserCache(req.user.id);
    await logActivity(req, 'profile.password.update', 'user', req.user.id);
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
});

router.post('/mfa/setup', async (req, res, next) => {
  try {
    await ensureSchema();
    const secret = generateSecret();
    await pool.query(
      `INSERT INTO user_profiles (user_id, mfa_secret, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET mfa_secret = EXCLUDED.mfa_secret, updated_at = NOW()`,
      [req.user.id, secret]
    );
    res.json({
      secret,
      qrUrl: `otpauth://totp/619-ERP:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=619-ERP`,
    });
  } catch (err) {
    next(err);
  }
});

// A 6-digit TOTP code is a 1M-value space; throttle harder than the general
// per-user API limit so it can't be brute-forced from a single account.
const mfaVerifyLimiter = rateLimit({
  store: makeStore('mfa'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many MFA verification attempts. Please wait 15 minutes.' },
});

router.post('/mfa/verify', mfaVerifyLimiter, async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Valid MFA code is required' });
    await ensureSchema();
    const { rows } = await pool.query('SELECT mfa_secret FROM user_profiles WHERE user_id = $1', [req.user.id]);
    const storedSecret = rows[0] && rows[0].mfa_secret;
    if (!storedSecret) return res.status(400).json({ error: 'MFA setup required before verification' });
    const valid = verifySync({
      secret: storedSecret, token: code, strategy: 'totp', epochTolerance: 30,
    }).valid;
    if (!valid) return res.status(400).json({ error: 'Invalid MFA code' });
    await pool.query(
      `UPDATE user_profiles
          SET mfa_enabled = TRUE, updated_at = NOW()
        WHERE user_id = $1`,
      [req.user.id]
    );
    const recoveryCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());
    await logActivity(req, 'profile.mfa.enable', 'user', req.user.id);
    res.json({ recoveryCodes });
  } catch (err) {
    next(err);
  }
});

router.delete('/mfa', async (req, res, next) => {
  try {
    await ensureSchema();
    await pool.query('UPDATE user_profiles SET mfa_enabled = FALSE, mfa_secret = NULL, updated_at = NOW() WHERE user_id = $1', [req.user.id]);
    await logActivity(req, 'profile.mfa.disable', 'user', req.user.id);
    res.json({ message: 'MFA disabled' });
  } catch (err) {
    next(err);
  }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const row = await profileFor(req.user.id);
    res.json(jsonOrDefault(row.notification_preferences, defaultNotifications));
  } catch (err) {
    next(err);
  }
});

router.put('/notifications', async (req, res, next) => {
  try {
    await ensureSchema();
    const preferences = jsonOrDefault(req.body, defaultNotifications);
    await pool.query(
      `INSERT INTO user_profiles (user_id, notification_preferences, updated_at)
       VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET notification_preferences = EXCLUDED.notification_preferences, updated_at = NOW()`,
      [req.user.id, JSON.stringify(preferences)]
    );
    res.json(preferences);
  } catch (err) {
    next(err);
  }
});

router.get('/preferences', async (req, res, next) => {
  try {
    const row = await profileFor(req.user.id);
    res.json(jsonOrDefault(row.preferences, defaultPreferences));
  } catch (err) {
    next(err);
  }
});

router.put('/preferences', async (req, res, next) => {
  try {
    await ensureSchema();
    const preferences = jsonOrDefault(req.body, defaultPreferences);
    await pool.query(
      `INSERT INTO user_profiles (user_id, preferences, updated_at)
       VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET preferences = EXCLUDED.preferences, updated_at = NOW()`,
      [req.user.id, JSON.stringify(preferences)]
    );
    res.json(preferences);
  } catch (err) {
    next(err);
  }
});

router.get('/devices', (req, res) => {
  const info = clientInfo(req);
  res.json([{
    id: 'current',
    name: `${info.browser} on ${info.os}`,
    type: info.type,
    browser: info.browser,
    os: info.os,
    ip: info.ip,
    location: 'Current network',
    lastSeen: new Date().toISOString(),
    isCurrent: true,
  }]);
});

router.delete('/devices/:id', (req, res) => {
  if (req.params.id === 'current') return res.status(400).json({ error: 'Cannot revoke the current device here' });
  res.json({ message: 'Device revoked' });
});

router.get('/sessions', (req, res) => {
  const info = clientInfo(req);
  res.json([{
    id: 'current',
    ip: info.ip,
    location: 'Current network',
    device: `${info.type} device`,
    browser: info.browser,
    createdAt: req.user.last_login || new Date().toISOString(),
    lastActive: new Date().toISOString(),
    isCurrent: true,
  }]);
});

router.delete('/sessions/:id', (req, res) => {
  if (req.params.id === 'current') return res.status(400).json({ error: 'Cannot revoke the current session here' });
  res.json({ message: 'Session revoked' });
});

router.post('/sessions/revoke-all', async (req, res, next) => {
  try {
    await pool.query('UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1', [req.user.id]);
    invalidateUserCache(req.user.id);
    await logActivity(req, 'profile.sessions.revoke_all', 'user', req.user.id);
    res.clearCookie('token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });
    res.json({ message: 'All sessions revoked' });
  } catch (err) {
    next(err);
  }
});

router.get('/activity', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const category = String(req.query.category || '').trim();
    const params = [req.user.id];
    const conds = ['user_id = $1'];
    if (category && category !== 'all') {
      params.push(`${category}.%`);
      conds.push(`action LIKE $${params.length}`);
    }
    const where = conds.join(' AND ');
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM activity_log WHERE ${where}`, params);
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, action, entity_type, ip_address, created_at
         FROM activity_log
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = count.rows[0]?.total || 0;
    res.json({
      events: rows.map((row) => ({
        id: row.id,
        type: row.action,
        description: row.action.replace(/\./g, ' '),
        ip: row.ip_address || '',
        location: 'Current network',
        createdAt: row.created_at,
        category: row.action.split('.')[0] || 'system',
      })),
      hasMore: offset + rows.length < total,
      total,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

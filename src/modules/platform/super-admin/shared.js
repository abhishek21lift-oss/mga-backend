'use strict';
// Shared context for the super-admin routers.
//
// Everything here was the module-level prelude of super-admin.routes.js before
// audit H-03 split that file by domain. Two helpers moved in from further down
// because more than one domain uses them:
//
//   csvCell           — audit export (operations) and invoice export (billing)
//   deliverInvitation — studio creation (organizations) and resend (invitations)
//
// Kept as a plain module of values rather than a factory: these are process-wide
// singletons (a pg pool, a logger, a multer instance) and were already shared by
// every route in the original file. Passing them explicitly makes the coupling
// visible in each importer's require line, which is the point.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const pool = require('../../../db/pool');
// Tier three. Every module in this directory sits behind auth +
// requireSuperAdmin + requireSuperAdminMfa, so the helpers below run only for
// platform operators and need cross-organisation reach that app_tenant does
// not have. `pool` stays exported because one path here is genuinely
// anonymous — public studio registration — and must keep using the tenant
// role and its SECURITY DEFINER function (162).
const platformPool = require('../../../db/platformPool');
const logger = require('../../../lib/logger');
const { saveFile } = require('../../../lib/fileStorage');
const { invalidateUserCache } = require('../../../middleware/auth');
const subscription = require('../../../lib/subscription');
const invitations = require('../../../lib/invitations');
const { sendAdminInvitation, sendPasswordReset, isConfigured: smtpConfigured } = require('../../../lib/email');
const { frontendUrl } = require('../../../lib/frontendUrl');
const { apiUrl } = require('../../../lib/apiUrl');
const { TRIAL_DAYS } = subscription;

// Roles a tenant login may hold (never 'super_admin' — that is platform-only and
// cannot be created, edited, or impersonated through this tenant-facing portal).
const TENANT_ROLES = ['admin', 'manager', 'trainer', 'member'];
// How long a read-only impersonation session stays valid before the operator
// must re-enter the studio. Short by design — impersonation is a spot check.
const IMPERSONATION_TTL = process.env.IMPERSONATION_TTL || '30m';

// ── Logo upload (per-studio branding) ───────────────────────────────────────
// memoryStorage + magic-byte sniff (MIME header alone can be spoofed), same
// pattern as the PAR-Q/consent document uploads.
const LOGO_MAX_BYTES = parseInt(process.env.ORG_LOGO_MAX_BYTES, 10) || 2 * 1024 * 1024; // 2MB
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype || '')) {
      return cb(new Error('Only PNG, JPG, or WEBP images are allowed'));
    }
    cb(null, true);
  },
});
const LOGO_SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg',  magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  ext: 'png',  magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" (WEBP container)
];
function detectLogoType(buf) {
  for (const sig of LOGO_SIGNATURES) {
    if (sig.magic.every((b, i) => buf[i] === b)) return sig;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function slugify(name) {
  return String(name || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'org';
}

/**
 * `runner` lets a caller inside a transaction check against uncommitted rows.
 * approveHandler has always passed its borrowed client here; the parameter was
 * missing, so the check silently ran on the pool instead — harmless while the
 * connecting role was table-owning, and wrong the moment it was not, because
 * app_tenant sees no organizations at all and every slug looked free.
 */
async function uniqueSlug(base, runner = platformPool) {
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const { rows } = await runner.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
    if (!rows.length) return slug;
    slug = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function audit(req, action, entityType, entityId, data) {
  try {
    // Platform pool: activity_log is tenant-scoped by 157, and a platform
    // action has no organisation, so this write is impossible as app_tenant.
    await platformPool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.user?.id || null, req.user?.name || null, action, entityType,
       entityId || null, data || {}, req.ip || null, req.get('user-agent') || null]
    );
  } catch (err) {
    logger.warn({ err: err.message, action }, 'super-admin audit log write failed');
  }
}

// ── Moved here from the audit-export section: also used by billing ──────────
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Escape per RFC 4180. The leading-character guard defuses spreadsheet
  // formula injection: a logged value beginning =, +, - or @ would otherwise
  // execute when the CSV is opened in Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

// ── Moved here from the invitations section: also used when creating a studio ─
/**
 * Send (or resend) one invitation and record the outcome.
 *
 * Never throws. The caller has already committed a studio; a failed email is
 * something to report and retry, not something to unwind an account over.
 */
async function deliverInvitation(invitation, rawToken) {
  try {
    await sendAdminInvitation({
      to: invitation.email,
      ownerName: invitation.owner_name,
      studioName: invitation.studio_name,
      actionUrl: frontendUrl(`/auth/set-password?token=${rawToken}`),
      // Omitted when the API has no public base URL — a relative pixel would
      // resolve against the mail client and render as a broken image.
      pixelUrl: apiUrl(`/api/invitations/track/${invitation.track_id}.gif`) || undefined,
      expiryHours: invitations.EXPIRY_HOURS,
    });
    await invitations.markSent(invitation.id);
    return { sent: true, error: null };
  } catch (err) {
    await invitations.markSendFailed(invitation.id, err.message).catch(() => {});
    logger.error({ err: err.message, invitation: invitation.id }, 'invitation email failed');
    return { sent: false, error: err.message };
  }
}

// Only what a domain router actually imports. LOGO_MAX_BYTES, LOGO_SIGNATURES,
// multer, apiUrl and sendAdminInvitation are deliberately NOT exported: they
// exist to build logoUpload, detectLogoType and deliverInvitation above, and
// nothing outside this file references them. An export nobody imports reads as
// an extension point that was never designed.
module.exports = {
  EMAIL_RE,
  IMPERSONATION_TTL,
  TENANT_ROLES,
  TRIAL_DAYS,
  audit,
  bcrypt,
  crypto,
  csvCell,
  deliverInvitation,
  detectLogoType,
  frontendUrl,
  invalidateUserCache,
  platformPool,
  invitations,
  jwt,
  logger,
  logoUpload,
  pool,
  saveFile,
  sendPasswordReset,
  slugify,
  smtpConfigured,
  subscription,
  uniqueSlug,
};

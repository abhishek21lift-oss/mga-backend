'use strict';

/**
 * Product identity for outbound content — the values that must change when
 * this codebase is deployed as a different product.
 *
 * Extracted from the transactional email templates, which carried
 * "MY PT STUDIO" and "support@myptstudio.com" as literals in both the HTML
 * and plain-text bodies. Mail is the worst place for a stale brand: it leaves
 * the platform, it is the first thing a newly invited member sees, and a
 * support address that belongs to a different company is a dead end that
 * neither the sender nor the recipient learns about.
 *
 * Read from the environment at call time rather than captured at require
 * time, matching lib/frontendUrl.js — the templates are required once at boot
 * and a value snapshotted then cannot be changed by a test.
 *
 * ── On the fallbacks, which are deliberately not uniform ───────────────────
 *
 * siteName() falls back to the existing name so this module changes nothing
 * in the repository it was extracted from; getting it wrong is cosmetic.
 *
 * supportEmail() has NO fallback and returns null when unset. Callers must
 * omit the contact line rather than substitute anything. A missing support
 * address in an email is a bug someone reports; a plausible wrong one routes
 * real people to a company that cannot help them and will not know why they
 * are writing.
 */

/** Product name for mail footers and subjects. */
function siteName() {
  return String(process.env.SITE_NAME || 'MY PT STUDIO').trim();
}

/** Support address, or null when unconfigured. */
function supportEmail() {
  const raw = String(process.env.SUPPORT_EMAIL || '').trim();
  return raw || null;
}

module.exports = { siteName, supportEmail };

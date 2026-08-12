// src/lib/portfolio.js
//
// Rules for the portfolio gallery: what may be uploaded, how much, and what a
// reorder is allowed to say.
//
// Pure — no pool import — so the limits and the URL parsing are testable
// without a database, matching lib/credentials.js and lib/profileFields.js.
'use strict';

const { cleanText } = require('./credentials');

const LIMITS = {
  /** Items per user. Past this a gallery stops being a portfolio. */
  items: 30,
  /** A pin with no limit is just a second unordered list. */
  pinned: 3,
  imageBytes: 8 * 1024 * 1024,
  posterBytes: 4 * 1024 * 1024,
  title: 120,
  caption: 400,
  url: 500,
};

const KINDS = ['image', 'before_after', 'video_link'];

/**
 * Accepted video hosts.
 *
 * A closed allowlist, not "any URL": this string is rendered into an embed on
 * the profile, and letting an arbitrary origin in there is how a portfolio card
 * becomes someone else's page. Both hosts are also the only two with a stable
 * embed contract worth relying on.
 */
const VIDEO_HOSTS = [
  { host: /^(www\.)?youtube\.com$/i, provider: 'youtube' },
  { host: /^youtu\.be$/i, provider: 'youtube' },
  { host: /^(www\.)?vimeo\.com$/i, provider: 'vimeo' },
  { host: /^player\.vimeo\.com$/i, provider: 'vimeo' },
];

/**
 * Parse a video URL to { url, provider }, or return an error.
 *
 * Requires https. An http embed is blocked as mixed content by every browser
 * the app supports, so accepting one stores a link that can only ever render
 * as a blank box.
 */
function parseVideoUrl(raw) {
  const value = cleanText(raw, LIMITS.url);
  if (!value) return { error: 'A video link is required' };

  let u;
  try { u = new URL(value); } catch { return { error: 'That is not a valid URL' }; }
  if (u.protocol !== 'https:') return { error: 'The video link must start with https://' };

  const match = VIDEO_HOSTS.find((v) => v.host.test(u.hostname));
  if (!match) return { error: 'Only YouTube and Vimeo links are supported' };

  // Rebuilt from the parsed URL rather than stored as typed, so tracking
  // parameters and credentials in the original do not survive into the page.
  u.username = ''; u.password = ''; u.hash = '';
  return { value: { url: u.toString(), provider: match.provider } };
}

/** Normalise the free-text fields shared by every kind. */
function validateMeta(body) {
  return {
    value: {
      title: cleanText(body.title, LIMITS.title),
      caption: cleanText(body.caption, LIMITS.caption),
    },
  };
}

/**
 * Decide whether an upload is allowed, given what the user already has.
 * @returns {{ok:true}|{error:string, status:number}}
 */
function checkQuota({ currentCount, bytes, limitBytes = LIMITS.imageBytes }) {
  if (currentCount >= LIMITS.items) {
    return { error: `Your portfolio is full — ${LIMITS.items} items is the maximum`, status: 409 };
  }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { error: 'That file is empty', status: 400 };
  }
  if (bytes > limitBytes) {
    return { error: `That file is larger than ${Math.round(limitBytes / (1024 * 1024))}MB`, status: 413 };
  }
  return { ok: true };
}

/** Whether one more pin is allowed. */
function checkPinLimit(currentPinned) {
  if (currentPinned >= LIMITS.pinned) {
    return { error: `You can pin up to ${LIMITS.pinned} items`, status: 409 };
  }
  return { ok: true };
}

/**
 * Validate a reorder against what the user actually has.
 *
 * The submitted id SET must equal the stored set exactly. A partial apply is
 * the wrong answer for the case this exists to catch: two tabs open, one
 * deletes an item, the other reorders. Applying what matches would silently
 * drop the delete; returning the current list lets the stale tab re-render from
 * truth.
 *
 * @returns {{value:string[]}|{error:string, status:number}}
 */
function validateOrder(submitted, existingIds) {
  if (!Array.isArray(submitted)) return { error: 'Expected a list of ids', status: 400 };

  const seen = new Set();
  for (const id of submitted) {
    const v = String(id || '').trim();
    if (!v) return { error: 'Expected a list of ids', status: 400 };
    if (seen.has(v)) return { error: 'The same item appears twice', status: 400 };
    seen.add(v);
  }

  const have = new Set(existingIds);
  const sameSize = seen.size === have.size;
  const sameMembers = sameSize && [...seen].every((id) => have.has(id));
  if (!sameMembers) {
    return { error: 'Your portfolio changed in another tab — reload and try again', status: 409 };
  }
  return { value: submitted.map((id) => String(id).trim()) };
}

/** The row shape the API returns. Never leaks the storage key. */
function present(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title || '',
    caption: row.caption || '',
    url: row.file_url,
    afterUrl: row.after_file_url || null,
    externalUrl: row.external_url || null,
    bytes: Number(row.file_size_bytes || 0) + Number(row.after_file_size_bytes || 0),
    pinned: Boolean(row.pinned),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

module.exports = {
  LIMITS, KINDS, VIDEO_HOSTS,
  parseVideoUrl, validateMeta, checkQuota, checkPinLimit, validateOrder, present,
};

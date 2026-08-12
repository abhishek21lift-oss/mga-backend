// src/lib/credentials.js
//
// Validation and expiry logic for the professional credentials on a user's
// profile — certifications and specialisations.
//
// ── Why the expiry status is computed on the server ──────────────────────────
//
// It would be a one-liner in the browser, and it would be wrong there. A device
// with a skewed clock, or simply left open overnight, would show a lapsed
// certificate as current. Whether someone is qualified to take a session today
// is not a question to answer against an unverified clock, so the server states
// it and the UI renders what it is told.
//
// Pure functions with no database import, so the rules can be tested directly.
'use strict';

/** Certificates inside this window are "expiring" rather than "valid". */
const EXPIRING_SOON_DAYS = 60;

const MAX_CERTIFICATIONS = 40;
const MAX_SPECIALISATIONS = 20;
const LIMITS = { name: 120, issuer: 120, credential_id: 80, specialisation: 60, job_title: 120 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A 'YYYY-MM-DD' string, or null. Rejects '2026-02-31' — Date would roll it. */
function cleanDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!DATE_RE.test(s)) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return s;
}

function cleanText(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD', in UTC. */
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** Today as 'YYYY-MM-DD' in UTC. Injectable so tests are not clock-dependent. */
function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Where a certificate stands right now.
 *
 * 'unknown' is a distinct outcome from 'valid'. A certificate with no expiry
 * recorded might never expire or might have lapsed years ago, and quietly
 * treating it as current is exactly the mistake this feature exists to stop.
 * The UI is expected to show it differently.
 *
 * @returns {{status:'expired'|'expiring'|'valid'|'unknown', daysLeft:number|null}}
 */
function certificateStatus(cert, now = new Date()) {
  const expires = cert && cert.expires_on ? cleanDate(cert.expires_on) : null;
  if (!expires) return { status: 'unknown', daysLeft: null };
  const daysLeft = daysBetween(today(now), expires);
  // A certificate expiring today is still valid today — it lapses tomorrow.
  if (daysLeft < 0) return { status: 'expired', daysLeft };
  if (daysLeft <= EXPIRING_SOON_DAYS) return { status: 'expiring', daysLeft };
  return { status: 'valid', daysLeft };
}

/**
 * Normalise one certificate from client input.
 * @returns {{value:object}|{error:string}}
 */
function validateCertificate(raw, index) {
  const where = `Certification ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where} is malformed` };

  const name = cleanText(raw.name, LIMITS.name);
  if (!name) return { error: `${where} needs a name` };

  const issued_on = cleanDate(raw.issued_on);
  if (issued_on === undefined) return { error: `${where} has an invalid issue date` };
  const expires_on = cleanDate(raw.expires_on);
  if (expires_on === undefined) return { error: `${where} has an invalid expiry date` };

  // A certificate that expired before it was issued is a typo, and stored
  // unchallenged it would render as permanently lapsed with no way to see why.
  if (issued_on && expires_on && daysBetween(issued_on, expires_on) < 0) {
    return { error: `${where} expires before it was issued` };
  }

  return {
    value: {
      // Stable id so the UI can key rows and reorder without React reusing
      // state across two different certificates.
      id: cleanText(raw.id, 40) || `cert_${Date.now().toString(36)}_${index}`,
      name,
      issuer: cleanText(raw.issuer, LIMITS.issuer),
      issued_on,
      expires_on,
      credential_id: cleanText(raw.credential_id, LIMITS.credential_id),
    },
  };
}

/**
 * Normalise the whole certifications list.
 * @returns {{value:object[]}|{error:string}}
 */
function validateCertifications(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Certifications must be a list' };
  if (raw.length > MAX_CERTIFICATIONS) {
    return { error: `That is more than ${MAX_CERTIFICATIONS} certifications` };
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = validateCertificate(raw[i], i);
    if (r.error) return { error: r.error };
    out.push(r.value);
  }
  return { value: out };
}

/**
 * Normalise specialisations: a list of short labels.
 *
 * De-duplicated case-insensitively but stored as typed — "Strength &
 * Conditioning" and "strength & conditioning" are one specialisation, and the
 * first spelling wins rather than being lowercased into something nobody wrote.
 *
 * @returns {{value:string[]}|{error:string}}
 */
function validateSpecialisations(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Specialisations must be a list' };
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const v = cleanText(item, LIMITS.specialisation);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length > MAX_SPECIALISATIONS) {
      return { error: `That is more than ${MAX_SPECIALISATIONS} specialisations` };
    }
  }
  return { value: out };
}

/**
 * Whole years since `since`, or null. Returns a DURATION rather than storing
 * one: "8 years" written into a row is wrong twelve months later and nobody
 * comes back to fix it.
 */
function yearsOfExperience(since, now = new Date()) {
  const from = cleanDate(since);
  if (!from) return null;
  const days = daysBetween(from, today(now));
  if (days < 0) return null;
  return Math.floor(days / 365.25);
}

/** Attaches computed status to each certificate, for the API response. */
function presentCertifications(list, now = new Date()) {
  return (Array.isArray(list) ? list : []).map((c) => ({ ...c, ...certificateStatus(c, now) }));
}

/** Counts for the profile header, so the UI does not re-derive them. */
function credentialSummary(list, now = new Date()) {
  const seen = presentCertifications(list, now);
  return {
    total: seen.length,
    expired: seen.filter((c) => c.status === 'expired').length,
    expiring: seen.filter((c) => c.status === 'expiring').length,
    unknown: seen.filter((c) => c.status === 'unknown').length,
  };
}

module.exports = {
  EXPIRING_SOON_DAYS, MAX_CERTIFICATIONS, MAX_SPECIALISATIONS,
  certificateStatus, validateCertificate, validateCertifications,
  validateSpecialisations, yearsOfExperience, presentCertifications,
  credentialSummary, cleanText, cleanDate, LIMITS,
};

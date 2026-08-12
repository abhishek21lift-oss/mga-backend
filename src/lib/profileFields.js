// src/lib/profileFields.js
//
// Validation for the profile fields added in migration 133: languages,
// coaching modes, previous gyms, education, achievements and working hours.
//
// Sibling of lib/credentials.js and deliberately the same shape — every
// validator returns `{ value }` or `{ error }`, never throws, and never touches
// the database. The route stays thin and the rules stay testable.
//
// The recurring decision here is that a malformed ENTRY is dropped while a
// malformed LIST is rejected. Someone adding a blank row and moving on should
// not get an error dialog; someone POSTing an object where an array belongs has
// a bug worth reporting.
'use strict';

const { cleanText, cleanDate, LIMITS: CRED_LIMITS } = require('./credentials');

const MAX = {
  languages: 15,
  coachingModes: 5,
  previousGyms: 20,
  education: 15,
  achievements: 40,
  hoursPerDay: 4,
};

const LIMITS = {
  language: 40,
  gymName: 120,
  role: 80,
  institution: 140,
  degree: 120,
  field: 120,
  title: 160,
  issuer: 120,
  detail: 600,
  designation: 120,
  philosophy: 2000,
  trainingStyle: 600,
  freeText: 2000,
};

/** The coaching modes the UI offers. A closed set — it drives layout and filters. */
const COACHING_MODES = ['online', 'offline', 'hybrid', 'home', 'video'];

/** Achievement kinds, closed so the timeline can pick an icon per kind. */
const ACHIEVEMENT_KINDS = [
  'competition', 'certification', 'award', 'record',
  'media', 'speaking', 'publication', 'other',
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Anything from the first year a gym could plausibly exist to next year. */
const YEAR_MIN = 1900;

/** 'YYYY-MM' or null. undefined signals "malformed", matching cleanDate(). */
function cleanMonth(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().slice(0, 7);
  return MONTH_RE.test(s) ? s : undefined;
}

/** A four-digit year as a number, or null. undefined signals malformed. */
function cleanYear(v, now = new Date()) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n)) return undefined;
  // One year ahead, because a degree or a competition can be scheduled.
  if (n < YEAR_MIN || n > now.getUTCFullYear() + 1) return undefined;
  return n;
}

/** Stable id for a list row, so React keys survive a reorder. */
function rowId(existing, prefix, index) {
  return cleanText(existing, 40) || `${prefix}_${Date.now().toString(36)}_${index}`;
}

/** A list of short labels: trimmed, de-duplicated case-insensitively, blanks dropped. */
function validateLabelList(raw, { max, limit, name }) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: `${name} must be a list` };
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const v = cleanText(item, limit);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length > max) return { error: `That is more than ${max} ${name.toLowerCase()}` };
  }
  return { value: out };
}

function validateLanguages(raw) {
  return validateLabelList(raw, { max: MAX.languages, limit: LIMITS.language, name: 'Languages' });
}

/**
 * Coaching modes, filtered against the closed set.
 *
 * An unknown mode is DROPPED rather than rejected: the set may grow, and an old
 * client sending a mode this build has never heard of should not be unable to
 * save its name and phone number too.
 */
function validateCoachingModes(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Coaching modes must be a list' };
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const v = String(item || '').trim().toLowerCase();
    if (!COACHING_MODES.includes(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  // Returned in the canonical order, not the order sent, so the UI renders the
  // same chips in the same places regardless of the order they were ticked.
  return { value: COACHING_MODES.filter((m) => out.includes(m)) };
}

/**
 * Previous gyms. `to` empty means "still there".
 * @returns {{value:object[]}|{error:string}}
 */
function validatePreviousGyms(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Previous gyms must be a list' };
  if (raw.length > MAX.previousGyms) return { error: `That is more than ${MAX.previousGyms} gyms` };

  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const gymName = cleanText(r.name, LIMITS.gymName);
    if (!gymName) continue; // a blank row the user added and abandoned

    const from = cleanMonth(r.from);
    if (from === undefined) return { error: `Gym ${i + 1} has an invalid start month` };
    const to = cleanMonth(r.to);
    if (to === undefined) return { error: `Gym ${i + 1} has an invalid end month` };
    // Left before arriving is a typo. Stored, it renders as a negative tenure.
    if (from && to && to < from) return { error: `Gym ${i + 1} ends before it starts` };

    out.push({ id: rowId(r.id, 'gym', i), name: gymName, role: cleanText(r.role, LIMITS.role), from, to });
  }
  return { value: out };
}

/** Education entries. Institution is the only required field. */
function validateEducation(raw, now = new Date()) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Education must be a list' };
  if (raw.length > MAX.education) return { error: `That is more than ${MAX.education} entries` };

  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const institution = cleanText(r.institution, LIMITS.institution);
    if (!institution) continue;

    const year = cleanYear(r.year, now);
    if (year === undefined) return { error: `Education ${i + 1} has an invalid year` };

    out.push({
      id: rowId(r.id, 'edu', i),
      institution,
      degree: cleanText(r.degree, LIMITS.degree),
      field: cleanText(r.field, LIMITS.field),
      year,
    });
  }
  return { value: out };
}

/** Achievements. Title is required; kind falls back to 'other'. */
function validateAchievements(raw, now = new Date()) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Achievements must be a list' };
  if (raw.length > MAX.achievements) return { error: `That is more than ${MAX.achievements} achievements` };

  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const title = cleanText(r.title, LIMITS.title);
    if (!title) continue;

    const year = cleanYear(r.year, now);
    if (year === undefined) return { error: `Achievement ${i + 1} has an invalid year` };

    const rawKind = String(r.kind || '').trim().toLowerCase();
    out.push({
      id: rowId(r.id, 'ach', i),
      title,
      // Unknown kinds become 'other' rather than failing the save — the kind
      // only picks an icon, and losing an icon is not worth losing the entry.
      kind: ACHIEVEMENT_KINDS.includes(rawKind) ? rawKind : 'other',
      issuer: cleanText(r.issuer, LIMITS.issuer),
      year,
      detail: cleanText(r.detail, LIMITS.detail),
    });
  }
  // Newest first, undated last: a timeline reads from the most recent thing,
  // and an entry with no year has no place in the sequence.
  out.sort((a, b) => (b.year || 0) - (a.year || 0));
  return { value: out };
}

/**
 * Working hours: `{ mon: [{from,to}], ... }`.
 *
 * A day may hold several ranges because split shifts are the norm in this
 * trade — 06:00-10:00 and 17:00-21:00 is one coach's ordinary Tuesday, and a
 * single from/to per day cannot express it.
 */
function validateWorkingHours(raw) {
  if (raw === undefined || raw === null) return { value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Working hours must be an object' };

  const out = {};
  for (const day of DAYS) {
    const ranges = raw[day];
    if (!Array.isArray(ranges)) continue;
    if (ranges.length > MAX.hoursPerDay) {
      return { error: `More than ${MAX.hoursPerDay} time ranges on ${day}` };
    }

    const kept = [];
    for (const r of ranges) {
      if (!r || typeof r !== 'object') continue;
      const from = String(r.from || '').trim();
      const to = String(r.to || '').trim();
      // A half-filled range is an abandoned row, not an error.
      if (!from && !to) continue;
      if (!TIME_RE.test(from) || !TIME_RE.test(to)) {
        return { error: `Invalid time on ${day} — use HH:MM` };
      }
      // Equal is rejected too: a zero-length shift means the same as not
      // being there, and stored it renders as an open slot nobody can book.
      if (to <= from) return { error: `${day} has a range that ends before it starts` };
      kept.push({ from, to });
    }

    if (!kept.length) continue;
    kept.sort((a, b) => a.from.localeCompare(b.from));
    // Overlapping shifts on one day cannot both be true and would double-count
    // any availability figure built on top of this.
    for (let i = 1; i < kept.length; i += 1) {
      if (kept[i].from < kept[i - 1].to) return { error: `${day} has overlapping time ranges` };
    }
    out[day] = kept;
  }
  return { value: out };
}

/** Total minutes across the week — for "hours available" without re-deriving it. */
function weeklyMinutes(hours) {
  if (!hours || typeof hours !== 'object') return 0;
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let total = 0;
  for (const day of DAYS) {
    for (const r of Array.isArray(hours[day]) ? hours[day] : []) {
      if (TIME_RE.test(r.from || '') && TIME_RE.test(r.to || '')) total += mins(r.to) - mins(r.from);
    }
  }
  return total;
}

module.exports = {
  COACHING_MODES, ACHIEVEMENT_KINDS, DAYS, MAX, LIMITS, CRED_LIMITS,
  cleanMonth, cleanYear,
  validateLanguages, validateCoachingModes, validatePreviousGyms,
  validateEducation, validateAchievements, validateWorkingHours,
  weeklyMinutes,
  // Re-exported so the route has one import for field cleaning.
  cleanText, cleanDate,
};

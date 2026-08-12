// src/lib/profileCompletion.js
//
// How complete a profile is, and what to do about it.
//
// ── Why this is on the server ────────────────────────────────────────────────
//
// The percentage appears in at least three places at once — a hero ring, a
// completion panel, and a next-steps list. It is a number ABOUT saved data, so
// it must change at exactly one moment: when the server accepts a write.
// Computed in the browser it would tick up while someone types, then disagree
// with the server the first time validation trimmed a field, and drift
// permanently the first time a threshold changed on one side only.
//
// The same call returns the percentage AND the checklist, from one list of
// weights, so the two cannot contradict each other.
'use strict';

const { certificateStatus } = require('./credentials');

/**
 * Thresholds a field must clear to count.
 *
 * These are stated in the labels below, deliberately. Someone stuck at 92%
 * with an unexplained gap will type filler to clear it; someone told "80+
 * characters" either writes a bio or decides not to. Naming the bar is the
 * difference between a score that improves a profile and one that pollutes it.
 */
const MIN = {
  bio: 80,
  philosophy: 60,
  trainingStyle: 20,
  specialisations: 3,
  portfolio: 3,
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * Every scored field, its weight, and how to tell whether it is done.
 *
 * ── A field is only scored if the user can actually fill it ─────────────────
 *
 * Cover banner and portfolio were held out of this table while they were
 * columns with no upload path: scoring them would have parked everyone below
 * 100% with a step they could not take, and a checklist you cannot finish stops
 * being read. Both ship with this change, so both are scored, and the ten
 * points they need came off the existing entries rather than out of thin air.
 * That does move every stored profile's percentage by a point or two, which is
 * unavoidable whenever the table grows and is the reason it is not something to
 * do casually.
 *
 * Weights sum to exactly 100; a test asserts it, because a silent drift here
 * makes every percentage on the platform subtly wrong.
 */
const WEIGHTS = [
  { key: 'avatar', weight: 7, tab: 'overview', label: 'Add a profile photo', done: (p) => Boolean(p.avatar_url) },
  // Decoration, and priced as decoration — the banner makes a profile look
  // finished, but nobody hires a coach for their header image.
  { key: 'cover', weight: 3, tab: 'overview', label: 'Add a cover banner', done: (p) => Boolean(p.cover_url) },
  { key: 'phone', weight: 4, tab: 'overview', label: 'Add a contact number', done: (p) => str(p.phone).length >= 6 },
  { key: 'location', weight: 4, tab: 'overview', label: 'Add your location', done: (p) => Boolean(str(p.location)) },

  { key: 'bio', weight: 9, tab: 'credentials', label: `Write a bio (${MIN.bio}+ characters)`, done: (p) => str(p.bio).length >= MIN.bio },
  { key: 'philosophy', weight: 5, tab: 'credentials', label: `Describe your coaching philosophy (${MIN.philosophy}+ characters)`, done: (p) => str(p.philosophy).length >= MIN.philosophy },
  { key: 'training_style', weight: 4, tab: 'credentials', label: 'Describe your training style', done: (p) => str(p.training_style).length >= MIN.trainingStyle },
  { key: 'languages', weight: 3, tab: 'credentials', label: 'List a language you coach in', done: (p) => list(p.languages).length >= 1 },

  { key: 'job_title', weight: 5, tab: 'overview', label: 'Add your job title', done: (p) => Boolean(str(p.job_title)) },
  { key: 'designation', weight: 4, tab: 'credentials', label: 'Add your designation', done: (p) => Boolean(str(p.designation)) },
  { key: 'experience_since', weight: 5, tab: 'credentials', label: 'Set when you started coaching', done: (p) => Boolean(p.experience_since) },
  { key: 'coaching_modes', weight: 4, tab: 'credentials', label: 'Say how you coach', done: (p) => list(p.coaching_modes).length >= 1 },
  { key: 'previous_gyms', weight: 4, tab: 'credentials', label: 'Add where you have coached', done: (p) => list(p.previous_gyms).length >= 1 },
  {
    key: 'working_hours',
    weight: 5,
    tab: 'credentials',
    label: 'Set your weekly availability',
    done: (p) => {
      const h = p.working_hours;
      if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
      return Object.values(h).some((ranges) => Array.isArray(ranges) && ranges.length > 0);
    },
  },

  { key: 'specialisations', weight: 7, tab: 'credentials', label: `Add ${MIN.specialisations} specialisations`, done: (p) => list(p.specialisations).length >= MIN.specialisations },
  {
    key: 'certifications',
    weight: 11,
    tab: 'credentials',
    label: 'Add a certification',
    // An EXPIRED certificate still counts as complete. Completeness is "have
    // you told us about your qualifications"; currency is a different question,
    // already answered by credentialSummary and shown in its own strip. Folding
    // them together would drop someone's score on a day nobody edited anything,
    // which makes the number meaningless as a measure of effort.
    done: (p) => list(p.certifications).length >= 1,
  },
  { key: 'education', weight: 5, tab: 'credentials', label: 'Add your education', done: (p) => list(p.education).length >= 1 },
  { key: 'achievements', weight: 4, tab: 'credentials', label: 'Add an achievement', done: (p) => list(p.achievements).length >= 1 },

  {
    key: 'portfolio',
    weight: 7,
    tab: 'portfolio',
    label: 'Upload 3 portfolio items',
    // Weighted like a certification for a reason: a certificate says somebody
    // taught you, and a portfolio shows what you did with it. Three, not one,
    // because a single photograph is not a body of work — and the threshold is
    // in the label, like every other one here.
    done: (p) => Number(p.portfolio_count || 0) >= MIN.portfolio,
  },
];

/** How many next steps to surface. More than this reads as a chore list. */
const NEXT_STEPS = 3;

/**
 * @param {object} row a user_profiles row joined with its user
 * @returns {{percent:number, earned:number, total:number,
 *            items:Array<{key,label,weight,tab,done:boolean}>,
 *            nextSteps:Array<{key,label,weight,tab}>}}
 */
function profileCompletion(row) {
  const p = row || {};
  const items = WEIGHTS.map((w) => ({
    key: w.key,
    label: w.label,
    weight: w.weight,
    tab: w.tab,
    done: Boolean(w.done(p)),
  }));

  const total = WEIGHTS.reduce((n, w) => n + w.weight, 0);
  const earned = items.reduce((n, i) => n + (i.done ? i.weight : 0), 0);

  // Math.round would report 100% at 99.6 — a profile with an unfinished step
  // and a full ring, which is exactly the moment someone stops filling it in.
  const percent = earned === total ? 100 : Math.min(99, Math.round((earned / total) * 100));

  const nextSteps = items
    .filter((i) => !i.done)
    // Heaviest first: the fastest route to a better profile, not a walk down
    // the form in field order.
    .sort((a, b) => b.weight - a.weight)
    .slice(0, NEXT_STEPS)
    .map(({ key, label, weight, tab }) => ({ key, label, weight, tab }));

  return { percent, earned, total, items, nextSteps };
}

/**
 * Certificates needing attention — separate from completion on purpose.
 * Reuses the same status rules the profile already reports per certificate.
 */
function credentialAttention(certifications, now = new Date()) {
  const seen = list(certifications).map((c) => certificateStatus(c, now));
  return {
    expired: seen.filter((s) => s.status === 'expired').length,
    expiring: seen.filter((s) => s.status === 'expiring').length,
  };
}

module.exports = { WEIGHTS, MIN, NEXT_STEPS, profileCompletion, credentialAttention };

'use strict';
/**
 * Global search.
 *
 * The top-bar search box used to filter a hardcoded list of page names in the
 * browser. This replaces it with a real server-side search over the data the
 * studio actually cares about, starting with clients.
 *
 * ── Shape of this module ─────────────────────────────────────────────────────
 * Search is a registry of PROVIDERS, not a query. A provider owns one entity
 * type: it knows how to find rows and how to flatten them into the generic
 * result item the UI renders. Adding workouts, invoices, diet plans or files
 * later means appending a provider here — the route, the envelope and the
 * entire frontend stay untouched. That constraint is the reason every provider
 * returns the same flat item shape instead of its own row.
 *
 * ── Tenant isolation ─────────────────────────────────────────────────────────
 * Every provider receives an already-resolved scope and MUST apply it. Search
 * is the single easiest place in an app to leak another tenant's data — one
 * forgotten clause and a coach can enumerate a rival studio's client list by
 * typing letters. So the scope clause is built once, here, by `scopeClause()`,
 * and a provider that does not use it returns nothing useful. A trainer is
 * additionally pinned to their own clients; that is a stricter rule than the
 * org filter and is applied on top of it, never instead of it.
 */

const pool = require('../../db/pool');

/** Hard ceiling per group. Keeps one broad query ("a") from returning a studio's
 *  entire book, and keeps the payload small enough to stay under the latency
 *  budget on a phone. */
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 8;

/** Below this length a substring search matches almost everything and the
 *  trigram index cannot help (a trigram is 3 characters). Two characters is
 *  still allowed for initials/short codes, one is not. */
const MIN_QUERY_LENGTH = 2;

/** Fuzzy matching only kicks in from this length. Below it, "typo tolerance"
 *  is indistinguishable from returning random rows. */
const FUZZY_MIN_LENGTH = 4;

/** pg_trgm word_similarity threshold for the typo fallback. Calibrated against
 *  the requirement that "Rhul" finds "Rahul Sharma", which scores exactly 0.4;
 *  0.35 leaves headroom for a second transposition without opening the gate to
 *  unrelated names. Set explicitly in the SQL rather than relying on the
 *  pg_trgm.word_similarity_threshold GUC, because that is session state and
 *  this backend talks to a connection pooler that may not preserve it. */
const FUZZY_THRESHOLD = 0.35;

// ── Input handling ───────────────────────────────────────────────────────────

/** LIKE treats % and _ as wildcards, so a user typing "100%" would otherwise
 *  match every row. Escape them (and the escape character itself) for the
 *  pattern form of the query. The unescaped form is kept separately because
 *  word_similarity() is not a pattern match and must not see the backslashes. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Mobile numbers are stored bare and 10 digits long (validation enforces
 * /^[6-9]\d{9}$/), but people paste them with a country code, spaces and
 * dashes. Reducing to digits handles the punctuation; dropping everything
 * before the last 10 handles "+91". Keeping the tail rather than stripping a
 * literal "91" prefix also means the stored form could gain a country code
 * later without this breaking, because a substring search for the local part
 * still hits.
 */
function phoneDigits(raw) {
  const digits = (raw.match(/\d/g) || []).join('');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalise(raw) {
  const trimmed = String(raw ?? '').trim().slice(0, 120);
  const lower = trimmed.toLowerCase();
  return {
    raw: trimmed,
    lower,
    like: escapeLike(lower),
    digits: phoneDigits(trimmed),
  };
}

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * Builds the isolation clause every provider must include.
 *
 * `scope` comes from lib/tenant-db#tenantScope and is already fail-closed: a
 * tenant user with no organization resolves to orgId=null, and
 * `organization_id = NULL` matches no rows.
 *
 * `trainerId` is set when the caller is a trainer, pinning them to their own
 * roster. Admins and managers see the whole studio.
 */
function scopeClause({ scope, trainerId }, alias, params) {
  const clauses = [];
  if (scope.applyFilter) {
    params.push(scope.orgId);
    clauses.push(`${alias}.organization_id = $${params.length}`);
  }
  if (trainerId) {
    params.push(trainerId);
    clauses.push(`${alias}.trainer_id = $${params.length}`);
  }
  // A super admin operating platform-wide has no filter at all; that is the
  // one and only case where this returns TRUE.
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

// ── Clients provider ─────────────────────────────────────────────────────────

/**
 * In this schema "archived" is not a status value — it is the absence of
 * `active`. lib/subscription.js defines a seat as being consumed by an ACTIVE
 * client only, so expiring, freezing or soft-deleting a client is what the
 * product means by archiving. Search groups on exactly that definition so the
 * two surfaces agree.
 */
const LIVE_PREDICATE = `(c.deleted_at IS NULL AND c.status = 'active')`;

const CLIENT_COLUMNS = `
  c.id, c.client_id, c.name, c.mobile, c.email, c.photo_url, c.goal,
  c.package_type, c.status, c.pt_end_date, c.trainer_name, c.deleted_at`;

/**
 * One query, two independently-planned branches.
 *
 * The literal branch (LIKE) can use the trigram GIN indexes. The fuzzy branch
 * (word_similarity) cannot use any index and is driven by the tenant filter
 * instead. Written as a UNION ALL rather than an OR so the planner picks the
 * right strategy for each half — an OR would force one plan for both and
 * degrade the common case to a sequential scan.
 *
 * Scores are deliberately coarse integers. The point is a stable, explainable
 * ordering (exact name > name prefix > word prefix > substring > phone > code >
 * fuzzy), not a relevance model.
 */
async function searchClients(ctx, { archived }) {
  const { q, limit } = ctx;
  const params = [q.like, q.lower, q.digits];
  const isolation = scopeClause(ctx, 'c', params);
  const groupPredicate = archived ? `NOT ${LIVE_PREDICATE}` : LIVE_PREDICATE;
  const base = `${isolation} AND ${groupPredicate}`;

  // $1 escaped-for-LIKE, $2 raw lowered (for word_similarity), $3 digits.
  const literal = `
    SELECT c.id,
           CASE
             WHEN lower(c.name) = $2                              THEN 100
             WHEN lower(c.name) LIKE $1 || '%'                    THEN 92
             -- A match at the start of any word: "sha" finds "Rahul Sharma".
             -- The leading space makes the first word behave like the rest.
             WHEN lower(' ' || c.name) LIKE '% ' || $1 || '%'     THEN 84
             WHEN lower(c.name) LIKE '%' || $1 || '%'             THEN 76
             WHEN $3 <> '' AND c.mobile LIKE $3 || '%'            THEN 72
             WHEN $3 <> '' AND c.mobile LIKE '%' || $3            THEN 70
             WHEN $3 <> '' AND c.mobile LIKE '%' || $3 || '%'     THEN 66
             WHEN c.client_id IS NOT NULL
              AND lower(c.client_id) LIKE '%' || $1 || '%'        THEN 62
             ELSE 55
           END AS score
    FROM pt_clients c
    WHERE ${base}
      AND (
            lower(c.name) LIKE '%' || $1 || '%'
        OR ($3 <> '' AND length($3) >= 3 AND c.mobile LIKE '%' || $3 || '%')
        OR (c.email IS NOT NULL AND lower(c.email) LIKE '%' || $1 || '%')
        OR (c.client_id IS NOT NULL AND lower(c.client_id) LIKE '%' || $1 || '%')
      )`;

  // Only pay for the fuzzy branch when it can plausibly help. Skipping it for
  // short queries also keeps the cheap, common case to a single index scan.
  const fuzzy = q.lower.length >= FUZZY_MIN_LENGTH
    ? `
    UNION ALL
    SELECT c.id,
           -- Capped below every literal score: a guess never outranks a match.
           (30 + word_similarity($2, lower(c.name)) * 20)::int AS score
    FROM pt_clients c
    WHERE ${base}
      AND word_similarity($2, lower(c.name)) >= ${FUZZY_THRESHOLD}
      AND lower(c.name) NOT LIKE '%' || $1 || '%'`
    : '';

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    WITH matched AS (${literal}${fuzzy}),
    ranked AS (SELECT id, max(score) AS score FROM matched GROUP BY id)
    SELECT ${CLIENT_COLUMNS}, r.score
    FROM ranked r
    JOIN pt_clients c ON c.id = r.id
    ORDER BY r.score DESC, c.name ASC
    LIMIT ${limitParam}`;

  const { rows } = await pool.query(sql, params);
  return rows;
}

/** Flattens a client row into the generic item every result card renders. */
function toClientItem(row) {
  const isLive = !row.deleted_at && row.status === 'active';
  const badges = [
    isLive
      ? { label: 'Active', tone: 'positive' }
      : { label: row.deleted_at ? 'Deleted' : titleCase(row.status || 'Inactive'), tone: 'muted' },
  ];
  if (row.package_type) badges.push({ label: row.package_type, tone: 'neutral' });

  return {
    id: row.id,
    type: 'client',
    title: row.name,
    subtitle: row.mobile || row.email || null,
    // Secondary line: what distinguishes two clients with similar names.
    meta: [row.goal, row.trainer_name && `Coach ${row.trainer_name}`]
      .filter(Boolean).join(' · ') || null,
    href: `/pt-os/clients/${row.id}`,
    avatar_url: row.photo_url || null,
    badges,
    // Typed extras for the client card. Generic consumers ignore this; the
    // client renderer uses it rather than re-deriving from the strings above.
    fields: {
      client_id: row.client_id,
      mobile: row.mobile,
      email: row.email,
      goal: row.goal,
      package_type: row.package_type,
      pt_end_date: row.pt_end_date,
      trainer_name: row.trainer_name,
      status: row.deleted_at ? 'deleted' : row.status,
      is_active: isLive,
    },
  };
}

function titleCase(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

// ── Generic text search ──────────────────────────────────────────────────────

/**
 * Everything except clients matches the same way: one headline column plus a
 * few supporting ones, substring, ranked by where the match landed. This builds
 * that query once instead of eight near-identical copies, each of which would
 * be a separate opportunity to forget the isolation clause.
 *
 * Clients keep their own bespoke query because they alone match on phone-number
 * digits, which needs a different normalisation and a different set of scores.
 *
 * @param from       FROM clause including the alias and any JOINs.
 * @param key        Expression for the row's primary key (must be unique).
 * @param columns    SELECT list.
 * @param primary    Expression for the headline text. Scored and fuzzy-matched.
 * @param secondary  Supporting text expressions. Scored lower, never fuzzy —
 *                   a typo'd match against a note or a reference number is
 *                   noise, not a near miss.
 * @param predicates Extra WHERE clauses. MUST already include the isolation
 *                   clause the caller built with scopeClause().
 * @param order      Tiebreak after score.
 */
async function textSearch(ctx, {
  from, key = 'x.id', columns, primary, secondary = [], predicates, params, order = primary, limit,
}) {
  const { q } = ctx;
  const where = predicates.join(' AND ');
  const matchable = [primary, ...secondary]
    .map((expr) => `lower(${expr}) LIKE '%' || $1 || '%'`)
    .join(' OR ');

  // Secondary hits all score the same. Ranking a note above a reference number
  // would be a guess dressed up as relevance.
  const secondaryScore = secondary.length
    ? `WHEN ${secondary.map((e) => `lower(${e}) LIKE '%' || $1 || '%'`).join(' OR ')} THEN 64`
    : '';

  const literal = `
    SELECT ${key} AS _id,
           CASE
             WHEN lower(${primary}) = $2                          THEN 100
             WHEN lower(${primary}) LIKE $1 || '%'                THEN 92
             WHEN lower(' ' || ${primary}) LIKE '% ' || $1 || '%' THEN 84
             WHEN lower(${primary}) LIKE '%' || $1 || '%'         THEN 76
             ${secondaryScore}
             ELSE 55
           END AS score
    FROM ${from}
    WHERE ${where} AND (${matchable})`;

  const fuzzy = q.lower.length >= FUZZY_MIN_LENGTH
    ? `
    UNION ALL
    SELECT ${key} AS _id,
           (30 + word_similarity($2, lower(${primary})) * 20)::int AS score
    FROM ${from}
    WHERE ${where}
      AND word_similarity($2, lower(${primary})) >= ${FUZZY_THRESHOLD}
      AND lower(${primary}) NOT LIKE '%' || $1 || '%'`
    : '';

  params.push(limit ?? ctx.limit);
  const limitParam = `$${params.length}`;

  // The score is aggregated per key BEFORE the payload is selected, so a row
  // that matches on two columns appears once at its best score.
  const sql = `
    WITH matched AS (${literal}${fuzzy}),
         ranked AS (SELECT _id, max(score) AS score FROM matched GROUP BY _id)
    SELECT ${columns}, r.score
    FROM ${from}
    JOIN ranked r ON r._id = ${key}
    WHERE ${where}
    ORDER BY r.score DESC, ${order} ASC
    LIMIT ${limitParam}`;

  const { rows } = await pool.query(sql, params);
  return rows;
}

/** Money, formatted the way the rest of the product formats it. */
function inr(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/**
 * Scope for the three "catalogue" tables that gained an organization_id in
 * migration 106. NULL means product-seeded and shared, so it stays visible to
 * everyone; anything else belongs to one studio.
 */
function libraryScope(ctx, alias, params) {
  if (!ctx.scope.applyFilter) return 'TRUE';
  params.push(ctx.scope.orgId);
  return `(${alias}.organization_id IS NULL OR ${alias}.organization_id = $${params.length})`;
}

// ── Exercise library ─────────────────────────────────────────────────────────

/**
 * Deliberately NOT tenant-scoped: `exercises` is a seeded reference library of
 * ~890 movements with no organization_id, shared by every studio exactly as the
 * existing /api/workouts/exercises endpoint shares it. Nothing here is a
 * studio's own data, so there is nothing to isolate.
 */
async function searchExercises(ctx) {
  const params = [ctx.q.like, ctx.q.lower];
  return textSearch(ctx, {
    from: 'exercises x',
    columns: 'x.id, x.name, x.muscle_group, x.target_muscle, x.equipment, x.body_part, x.difficulty',
    primary: 'x.name',
    // A coach searches by what they want to train or what kit is free, not only
    // by the movement's name. Matches the concatenated-facet index in 106.
    secondary: [
      `coalesce(x.muscle_group, '') || ' ' || coalesce(x.target_muscle, '')
        || ' ' || coalesce(x.equipment, '') || ' ' || coalesce(x.body_part, '')`,
    ],
    predicates: ['x.is_active IS NOT FALSE'],
    params,
  });
}

function toExerciseItem(row) {
  const muscle = row.target_muscle || row.muscle_group || row.body_part;
  return {
    id: row.id,
    type: 'exercise',
    title: row.name,
    subtitle: muscle ? titleCase(muscle) : null,
    meta: row.equipment ? titleCase(row.equipment) : null,
    href: `/pt-os/exercise-library?q=${encodeURIComponent(row.name || '')}`,
    avatar_url: null,
    badges: row.difficulty ? [{ label: titleCase(row.difficulty), tone: 'neutral' }] : [],
    fields: { muscle_group: row.muscle_group, equipment: row.equipment },
  };
}

// ── Workout plans ────────────────────────────────────────────────────────────

async function searchWorkoutPlans(ctx) {
  const params = [ctx.q.like, ctx.q.lower];
  return textSearch(ctx, {
    from: 'workout_plans x',
    columns: 'x.id, x.name, x.goal, x.difficulty, x.duration_weeks, x.sessions_per_week',
    primary: 'x.name',
    secondary: ['coalesce(x.goal, \'\')'],
    predicates: [libraryScope(ctx, 'x', params), 'x.deleted_at IS NULL', 'x.is_active IS NOT FALSE'],
    params,
  });
}

function toWorkoutPlanItem(row) {
  return {
    id: row.id,
    type: 'workout_plan',
    title: row.name,
    subtitle: row.goal ? titleCase(String(row.goal).replace(/_/g, ' ')) : null,
    meta: row.duration_weeks
      ? `${row.duration_weeks} weeks · ${row.sessions_per_week || '?'}×/week`
      : null,
    href: `/pt-os/workout-plans/${row.id}`,
    avatar_url: null,
    badges: row.difficulty ? [{ label: titleCase(row.difficulty), tone: 'neutral' }] : [],
    fields: { goal: row.goal, duration_weeks: row.duration_weeks },
  };
}

// ── Diet plans ───────────────────────────────────────────────────────────────

async function searchDietPlans(ctx) {
  const params = [ctx.q.like, ctx.q.lower];
  return textSearch(ctx, {
    from: 'diet_templates x',
    columns: 'x.id, x.name, x.goal, x.daily_calories, x.daily_protein_g',
    primary: 'x.name',
    secondary: ['coalesce(x.goal, \'\')'],
    predicates: [libraryScope(ctx, 'x', params), 'x.is_active IS NOT FALSE'],
    params,
  });
}

function toDietPlanItem(row) {
  return {
    id: row.id,
    type: 'diet_plan',
    title: row.name,
    subtitle: row.goal ? titleCase(String(row.goal).replace(/_/g, ' ')) : null,
    meta: row.daily_calories ? `${row.daily_calories} kcal · ${row.daily_protein_g || 0}g protein` : null,
    href: `/pt-os/diet-plans?q=${encodeURIComponent(row.name || '')}`,
    avatar_url: null,
    badges: [],
    fields: { goal: row.goal, daily_calories: row.daily_calories },
  };
}

// ── Client-linked records ────────────────────────────────────────────────────
//
// Invoices, payments and assessments all hang off a client, and none of them
// carries a trainer relationship that can be trusted on its own. So all three
// are scoped through the CLIENT row: join pt_clients and apply the same
// scopeClause() the client provider uses. One rule, one implementation — a
// trainer cannot see a payment against someone else's client because they
// cannot see that client.

async function searchInvoices(ctx) {
  const params = [ctx.q.like, ctx.q.lower];
  const isolation = scopeClause(ctx, 'c', params);
  return textSearch(ctx, {
    from: 'invoices x JOIN pt_clients c ON c.id = x.client_id',
    columns: 'x.id, x.invoice_no, x.client_name, x.total_amount, x.amount, x.status, x.issue_date',
    // The number is what people quote, but the name is what they remember, so
    // the name is the headline and the number is matched alongside it.
    primary: 'coalesce(x.client_name, c.name)',
    secondary: ['coalesce(x.invoice_no, \'\')'],
    predicates: [isolation, 'c.deleted_at IS NULL', 'x.cancelled_at IS NULL'],
    order: 'x.issue_date DESC NULLS LAST, coalesce(x.client_name, c.name)',
    params,
  });
}

function toInvoiceItem(row) {
  const amount = inr(row.total_amount ?? row.amount);
  const status = String(row.status || 'draft').toLowerCase();
  return {
    id: row.id,
    type: 'invoice',
    title: row.invoice_no ? `Invoice ${row.invoice_no}` : 'Invoice',
    subtitle: row.client_name || null,
    meta: [amount, row.issue_date && String(row.issue_date).slice(0, 10)].filter(Boolean).join(' · ') || null,
    href: `/finance/invoices?q=${encodeURIComponent(row.invoice_no || row.client_name || '')}`,
    avatar_url: null,
    badges: [{ label: titleCase(status), tone: status === 'paid' ? 'positive' : 'warning' }],
    fields: { invoice_no: row.invoice_no, amount: row.total_amount ?? row.amount, status: row.status },
  };
}

async function searchPayments(ctx) {
  const params = [ctx.q.like, ctx.q.lower];
  const isolation = scopeClause(ctx, 'c', params);
  return textSearch(ctx, {
    from: 'pt_payments x JOIN pt_clients c ON c.id = x.client_id',
    columns: 'x.id, x.amount, x.payment_method, x.payment_ref, x.date, x.notes, c.name AS client_name',
    primary: 'c.name',
    secondary: ['coalesce(x.payment_ref, \'\')', 'coalesce(x.notes, \'\')'],
    predicates: [isolation, 'x.deleted_at IS NULL', 'c.deleted_at IS NULL'],
    order: 'x.date DESC NULLS LAST, c.name',
    params,
  });
}

function toPaymentItem(row) {
  return {
    id: row.id,
    type: 'payment',
    title: `${inr(row.amount) ?? '—'} · ${row.client_name}`,
    subtitle: row.payment_ref || row.notes || null,
    meta: [row.date && String(row.date).slice(0, 10), row.payment_method].filter(Boolean).join(' · ') || null,
    href: `/finance/collected-payments?q=${encodeURIComponent(row.payment_ref || row.client_name || '')}`,
    avatar_url: null,
    badges: row.payment_method ? [{ label: String(row.payment_method).toUpperCase(), tone: 'neutral' }] : [],
    fields: { amount: row.amount, payment_ref: row.payment_ref, date: row.date },
  };
}

async function searchAssessments(ctx) {
  const params = [ctx.q.like, ctx.q.lower];
  const isolation = scopeClause(ctx, 'c', params);
  return textSearch(ctx, {
    from: 'pt_assessments x JOIN pt_clients c ON c.id = x.client_id',
    columns: `x.id, x.client_id, x.assessment_number, x.assessment_type, x.assessment_date,
              x.overall_fitness_score, c.name AS client_name, c.photo_url`,
    primary: 'c.name',
    // assessment_number is a smallint, so it needs casting before it can be
    // pattern-matched at all.
    secondary: ['coalesce(x.assessment_type, \'\')', 'coalesce(x.assessment_number::text, \'\')'],
    predicates: [isolation, 'c.deleted_at IS NULL'],
    order: 'x.assessment_date DESC NULLS LAST, c.name',
    params,
  });
}

function toAssessmentItem(row) {
  const n = row.assessment_number;
  return {
    id: row.id,
    type: 'assessment',
    title: `Assessment${n ? ` #${n}` : ''} · ${row.client_name}`,
    subtitle: row.assessment_type ? titleCase(String(row.assessment_type).replace(/_/g, ' ')) : null,
    meta: row.assessment_date ? String(row.assessment_date).slice(0, 10) : null,
    // No standalone assessment route exists; the client profile is where an
    // assessment is actually read.
    href: `/pt-os/clients/${row.client_id}`,
    avatar_url: row.photo_url || null,
    // Explicit null/undefined test rather than truthiness: a genuine score of
    // 0 is a result, not a missing value.
    badges: row.overall_fitness_score === null || row.overall_fitness_score === undefined
      ? []
      : [{ label: `Score ${Math.round(row.overall_fitness_score)}`, tone: 'neutral' }],
    fields: { assessment_number: n, assessment_date: row.assessment_date, client_id: row.client_id },
  };
}

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * Studio broadcasts. Org-scoped but NOT trainer-scoped, because a broadcast has
 * no owner — which is exactly why the provider is switched off for trainers
 * rather than filtered for them. "Everyone in the studio can read it" is an
 * assumption to make deliberately, not one to fall into.
 */
async function searchMessages(ctx) {
  const params = [ctx.q.like, ctx.q.lower];
  const predicates = ['TRUE'];
  if (ctx.scope.applyFilter) {
    params.push(ctx.scope.orgId);
    predicates[0] = `x.organization_id = $${params.length}`;
  }
  return textSearch(ctx, {
    from: 'communication_history x',
    columns: 'x.id, x.title, x.type, x.audience, x.status, x.sent_at',
    primary: 'coalesce(x.title, \'\')',
    secondary: ['coalesce(x.body, \'\')'],
    predicates,
    order: 'x.sent_at DESC NULLS LAST, x.title',
    params,
  });
}

function toMessageItem(row) {
  return {
    id: row.id,
    type: 'message',
    title: row.title || 'Untitled message',
    subtitle: row.audience ? titleCase(String(row.audience).replace(/_/g, ' ')) : null,
    meta: [row.type && String(row.type).toUpperCase(), row.sent_at && String(row.sent_at).slice(0, 10)]
      .filter(Boolean).join(' · ') || null,
    href: '/engagement/notifications',
    avatar_url: null,
    badges: row.status ? [{ label: titleCase(row.status), tone: row.status === 'sent' ? 'positive' : 'muted' }] : [],
    fields: { type: row.type, sent_at: row.sent_at },
  };
}

// ── AI conversations ─────────────────────────────────────────────────────────

/**
 * Scoped to the signed-in user, not the organization. `ai_conversations` has no
 * organization_id — it has user_id, and a coach's chat history is personal even
 * within one studio. Filtering by org here would show a trainer their owner's
 * conversations.
 */
async function searchAiConversations(ctx) {
  const params = [ctx.q.like, ctx.q.lower, ctx.userId];
  return textSearch(ctx, {
    from: 'ai_conversations x',
    columns: 'x.id, x.title, x.updated_at',
    primary: 'coalesce(x.title, \'\')',
    predicates: [`x.user_id = $3`],
    order: 'x.updated_at DESC NULLS LAST, x.title',
    params,
  });
}

function toAiConversationItem(row) {
  return {
    id: row.id,
    type: 'ai_conversation',
    title: row.title || 'Untitled conversation',
    subtitle: null,
    meta: row.updated_at ? String(row.updated_at).slice(0, 10) : null,
    href: '/ai-coach',
    avatar_url: null,
    badges: [],
    fields: { updated_at: row.updated_at },
  };
}

// ── Provider registry ────────────────────────────────────────────────────────

/**
 * Order here IS the order the UI renders, and it encodes the product's stated
 * priority: live clients first, archived clients second, everything else after.
 * Adding an entity type means adding a row here and nothing else.
 *
 * `enabled` lets a provider opt out per request — used for the noise floor on
 * short queries, and for the two providers that are not visible to every role.
 */
const PROVIDERS = [
  {
    type: 'clients',
    label: 'Clients',
    run: (ctx) => searchClients(ctx, { archived: false }).then((r) => r.map(toClientItem)),
  },
  {
    type: 'archived_clients',
    label: 'Archived clients',
    enabled: (ctx) => ctx.q.lower.length >= 3,
    run: (ctx) => searchClients(ctx, { archived: true }).then((r) => r.map(toClientItem)),
  },
  {
    type: 'exercises',
    label: 'Exercises',
    // ~890 rows and mostly short generic words ("row", "curl"), so a two-letter
    // query would return an arbitrary slice of the library.
    enabled: (ctx) => ctx.q.lower.length >= 3,
    run: (ctx) => searchExercises(ctx).then((r) => r.map(toExerciseItem)),
  },
  {
    type: 'workout_plans',
    label: 'Workout plans',
    run: (ctx) => searchWorkoutPlans(ctx).then((r) => r.map(toWorkoutPlanItem)),
  },
  {
    type: 'diet_plans',
    label: 'Diet plans',
    run: (ctx) => searchDietPlans(ctx).then((r) => r.map(toDietPlanItem)),
  },
  {
    type: 'assessments',
    label: 'Assessments',
    enabled: (ctx) => ctx.q.lower.length >= 3,
    run: (ctx) => searchAssessments(ctx).then((r) => r.map(toAssessmentItem)),
  },
  {
    type: 'invoices',
    label: 'Invoices',
    enabled: (ctx) => ctx.q.lower.length >= 3,
    run: (ctx) => searchInvoices(ctx).then((r) => r.map(toInvoiceItem)),
  },
  {
    type: 'payments',
    label: 'Payments',
    enabled: (ctx) => ctx.q.lower.length >= 3,
    run: (ctx) => searchPayments(ctx).then((r) => r.map(toPaymentItem)),
  },
  {
    type: 'messages',
    label: 'Messages',
    // Broadcasts belong to the studio, not to a coach. Rather than invent an
    // ownership rule for a table that has none, the group is simply not offered
    // to trainers.
    enabled: (ctx) => ctx.role !== 'trainer' && ctx.q.lower.length >= 3,
    run: (ctx) => searchMessages(ctx).then((r) => r.map(toMessageItem)),
  },
  {
    type: 'ai_conversations',
    label: 'AI conversations',
    // Personal history, keyed on the signed-in user. Without a user id there is
    // nothing to scope to, so the provider does not run at all.
    enabled: (ctx) => Boolean(ctx.userId) && ctx.q.lower.length >= 3,
    run: (ctx) => searchAiConversations(ctx).then((r) => r.map(toAiConversationItem)),
  },
];

/** Secondary groups get a shorter list than clients. Ten groups at the full
 *  limit would be sixty rows in a dropdown nobody can read. */
const SECONDARY_LIMIT = 4;

/** Across all groups. A broad query ("a") can match every provider at once;
 *  this is what stops the panel becoming a report. */
const MAX_TOTAL_ITEMS = 24;

/**
 * Runs every applicable provider and assembles the envelope.
 *
 * Providers run concurrently: they are independent queries against the same
 * pool, and running them in series would make total latency the sum of the
 * parts — exactly the thing the <200ms budget cannot afford once there are five
 * entity types instead of two.
 */
async function search({ query, scope, trainerId, userId, role, limit, types }) {
  const started = Date.now();
  const q = normalise(query);

  if (q.lower.length < MIN_QUERY_LENGTH) {
    return { query: q.raw, groups: [], took_ms: Date.now() - started };
  }

  const requested = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const ctx = {
    q,
    scope,
    trainerId,
    userId,
    role,
    limit: requested,
    // Everything below the two client groups is a supporting answer, so it gets
    // a shorter list. Clients keep the full limit.
    secondaryLimit: Math.min(requested, SECONDARY_LIMIT),
  };

  const wanted = PROVIDERS.filter((p) => {
    if (types && types.length && !types.includes(p.type)) return false;
    return p.enabled ? p.enabled(ctx) : true;
  });

  const results = await Promise.all(wanted.map((p, i) => p.run(
    // The first two providers are the client groups; the rest are secondary.
    i < 2 ? ctx : { ...ctx, limit: ctx.secondaryLimit },
  )));

  let budget = MAX_TOTAL_ITEMS;
  const groups = [];
  for (let i = 0; i < wanted.length; i += 1) {
    // An empty group is chrome with nothing in it; the UI should not have to
    // filter these out itself.
    if (!results[i].length || budget <= 0) continue;
    // Trimming from the tail of the ORDER is safe: within a group the rows are
    // already sorted best-first, and groups are already in priority order, so
    // the budget always spends on the strongest answers.
    const items = results[i].slice(0, budget);
    budget -= items.length;
    groups.push({ type: wanted[i].type, label: wanted[i].label, items, total: items.length });
  }

  return { query: q.raw, groups, took_ms: Date.now() - started };
}

/** Which providers would run for a given caller. Exposed so the visibility
 *  rules can be asserted without a database. */
function providersFor(ctx) {
  return PROVIDERS.filter((p) => (p.enabled ? p.enabled(ctx) : true)).map((p) => p.type);
}

/** Every registered entity type, in render order. */
function providerTypes() {
  return PROVIDERS.map((p) => p.type);
}

module.exports = {
  search,
  // Exported for tests and for future providers that need the same guarantees.
  normalise,
  escapeLike,
  scopeClause,
  libraryScope,
  providersFor,
  providerTypes,
  MAX_LIMIT,
  MIN_QUERY_LENGTH,
  FUZZY_MIN_LENGTH,
  FUZZY_THRESHOLD,
};

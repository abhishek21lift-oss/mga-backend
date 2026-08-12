# Global search

`GET /api/search?q=…` powers the search box in the top navigation. It replaced a
box that filtered a hardcoded list of page names in the browser.

## Response envelope

```jsonc
{
  "data": {
    "query": "sha",
    "took_ms": 41,
    "groups": [
      {
        "type": "clients",              // stable machine name
        "label": "Clients",             // heading the UI renders
        "total": 2,
        "items": [
          {
            "id": "…",
            "type": "client",
            "title": "Prakhar Sharma",
            "subtitle": "9872455859",
            "meta": "Fat loss · Coach Vinay",
            "href": "/pt-os/clients/…", // where clicking goes
            "avatar_url": null,
            "badges": [{ "label": "Active", "tone": "positive" }],
            "fields": { }               // optional, type-specific extras
          }
        ]
      }
    ]
  }
}
```

Every item has the same shape regardless of what it is. That is the whole point:
the frontend renders `title / subtitle / meta / badges / href` and knows nothing
about clients specifically, so a new entity type appears in the UI without a
frontend change.

## Registered providers

In render order. Each returns at most 4 items except the two client groups,
which get the caller's requested limit; the whole response is capped at 24
items so a broad query cannot turn the dropdown into a report.

| Group | Table | Scoped by | Matches on |
| ----- | ----- | --------- | ---------- |
| `clients` | `pt_clients` (active, not deleted) | org + trainer | name, mobile digits, email, client code |
| `archived_clients` | `pt_clients` (everything else) | org + trainer | same |
| `exercises` | `exercises` | **nothing** — shared reference library | name, muscle, target, equipment, body part |
| `workout_plans` | `workout_plans` | org, NULL = shared | name, goal |
| `diet_plans` | `diet_templates` | org, NULL = shared | name, goal |
| `assessments` | `pt_assessments` | via the client row | client name, type, number |
| `invoices` | `invoices` | via the client row | client name, invoice number |
| `payments` | `pt_payments` | via the client row | client name, reference, notes |
| `messages` | `communication_history` | org; **not offered to trainers** | title, body |
| `ai_conversations` | `ai_conversations` | `user_id` — personal, not org | title |

Three scoping shapes, deliberately distinct:

- **Direct** — the table has `organization_id`, so `scopeClause()` applies to it.
- **Via the client row** — invoices, payments and assessments have no
  trustworthy trainer relationship of their own, so they join `pt_clients` and
  apply `scopeClause()` to *that* alias. A trainer cannot see a payment against
  someone else's client because they cannot see that client. One rule, one
  implementation.
- **Library** — `workout_plans` and `diet_templates` use `libraryScope()`:
  `organization_id IS NULL OR = <caller's org>`, where NULL means shipped with
  the product.

`exercises` is the one provider with no isolation at all. It is a seeded
reference library of ~890 movements with no `organization_id`, shared by every
studio exactly as `/api/workouts/exercises` already shares it. Nothing in it
belongs to a studio, so there is nothing to isolate. If studio-authored
exercises are ever added, that provider needs the `libraryScope()` treatment.

`ai_conversations` is scoped to the **user**, not the org — a coach's chat
history is personal even inside one studio.

### Known gap

Migration 106 added `organization_id` to `workout_plans` and `diet_templates`
and backfilled it from `created_by`, and both create routes now stamp it. The
**existing GET routes for those two tables still read unscoped**, exactly as
they did before. Narrowing them changes what current screens show, so it is its
own change; the column is in place so it becomes a one-line `WHERE` when
someone takes it. Search does not widen the exposure in the meantime.

## Adding a searchable entity type

Append a provider to `PROVIDERS` in `src/modules/search/search.service.js`:

```js
{
  type: 'invoices',
  label: 'Invoices',
  enabled: (ctx) => ctx.q.lower.length >= 3,   // optional
  run: (ctx) => searchInvoices(ctx).then((rows) => rows.map(toInvoiceItem)),
}
```

Order in the array is the order groups render. Providers run concurrently.

**A provider MUST apply `scopeClause(ctx, alias, params)` to its query.** That
call is the only thing keeping one studio's records out of another studio's
search box, and it also pins a trainer to their own roster. A provider that
skips it is a cross-tenant leak. `scopeClause` returns `TRUE` for exactly one
caller — a platform super admin operating with no target org.

## Matching

Two independently-planned branches, unioned:

| Branch  | Predicate                        | Index                            |
| ------- | -------------------------------- | -------------------------------- |
| literal | `lower(name) LIKE '%q%'`, mobile / email / client code substrings | trigram GIN (migration 105) |
| fuzzy   | `word_similarity(q, lower(name)) >= 0.35` | none — driven by the tenant filter |

Written as `UNION ALL` rather than `OR` so each half gets the right plan; an
`OR` would force one plan for both and degrade the common case to a sequential
scan. The fuzzy branch only runs from 4 characters, and is what makes "Rhul"
find "Rahul Sharma". Scores are coarse integers chosen so a guess can never
outrank a literal match.

The threshold is written into the SQL rather than set via
`pg_trgm.word_similarity_threshold`, because that GUC is session state and this
backend talks to a connection pooler that may not preserve it.

## Indexes

`src/db/migrations/105_client_search_indexes.sql` — trigram GIN on
`lower(name)`, `mobile`, `lower(email)`, `lower(client_id)`, plus a composite
`(organization_id, status, name)`.

They are deliberately **not** partial on `deleted_at`: search has an "Archived
clients" group covering soft-deleted and non-active clients, and that is the set
most likely to grow without bound.

`unaccent()` is not used in any index expression — it is STABLE, not IMMUTABLE,
and the usual workaround (an IMMUTABLE wrapper) lies to the planner and corrupts
the index if the dictionary changes. Accent folding, if ever needed, belongs in
a generated column.

## Rate limiting

`/api/search` carries its own limiter (240/min per user) instead of the shared
`userApiLimiter`. A 300ms debounce still produces several requests per typed
word, and that traffic should not eat the budget real API calls need.

## Not on the server

Recent searches and recently-viewed records live in `localStorage`
(`src/components/search/recent.ts`). Recency is personal and per-device, so
keeping it client-side makes it instant, keeps it working when the backend is
cold, and avoids creating another cross-tenant surface. It is cleared on logout.

# MY PT STUDIO — Command Center: Implementation Plan

**Status:** decisions locked (§3). Phase 1 in progress.
**Survey date:** 2026-08-04, against `main` @ `b86b9db`.

Written after searching the repository (the brief's §18) and after establishing
what production actually is. Roughly 40% of the requested surface already exists
in some form and must be reused rather than rebuilt (§1).

**Two corrections on record**, both the same mistake: reading a stale hosting
artefact as a description of production.

1. The first draft of §2 claimed VPS monitoring and Docker control were
   impossible, because it took `render.yaml` for the deployment. Production is a
   Hostinger VPS running docker compose, and `docker-compose.yml` says so in its
   own header. Everything in the brief is buildable.
2. §3's D1 then claimed Vercel sat in the request path and would block a
   WebSocket, because the frontend carried a `vercel.json` and a Vercel-specific
   error message. **The frontend also deploys to the same VPS** — its own
   `.github/workflows/deploy.yml` runs `docker compose build frontend`. Vercel is
   nowhere in the request path.

Both stale files have since been deleted, and the routing that actually exists
is version-controlled in `infra/nginx/`. That folder is the fix for the class of
error, not just for the two instances.

---

## 1. What already exists — reuse map

The brief says do not duplicate services, Redis connections, Docker checks or
health endpoints. Here is what is already there and must be built *on*, not
beside.

| Requested module | Already in the repo | Where |
|---|---|---|
| Health endpoint | `GET /api/health` (liveness) and `GET /api/super-admin/system-health` (deep: db latency, pool, migrations, db size, process memory, uptime, errors_24h, BullMQ summary) | `src/server.js:321`, `src/modules/platform/super-admin/operations.js:372` |
| Queue / BullMQ | `collectQueueStats()`, `summarize()`, per-queue waiting/active/delayed/completed/failed/paused, all timeout-guarded | `src/lib/queueHealth.js` |
| Redis | One shared client with `ping()`, `isReady()`, `isConfigured()`, `ensureReady()`, separate worker connection | `src/lib/redis.js` |
| Security Center | login events, threats, sessions, overview | `src/modules/platform/super-admin/security.js` |
| AI Center | usage overview, by-model, by-studio, trend, provider settings | `src/modules/platform/super-admin/ai.js`; tables `ai_usage_log`, `ai_provider_settings`, `platform_ai_settings` |
| Storage | overview, by-studio, trend, largest | `src/modules/platform/super-admin/storage.js` |
| SMTP | `isConfigured()`, `describeConfig()`, `verifyConnection()`, typed error explanations | `src/lib/email.js`, `scripts/verify-smtp.js` |
| Request timing | every `/api/*` request already logs `{method,url,status,ms,req_id}` | `src/server.js:295` |
| Frontend shell | `/platform` with tab router: Overview, Studios, Finance, Activity, Registrations, Coupons | `src/app/platform/` |
| UI kit | `Card`, `Badge`, `Button`, `KpiCard`, `StatCard`, `GlassTable`, `DonutChart`, `chart.tsx`, `Skeleton`, `PageHeader`, `cn` — already glass-styled | `src/components/ui/` |
| Client contract | `api.superAdmin.systemHealth()` and the `SystemHealth` type | `endpoints/platform.ts:184`, `types.ts:1773` |
| Auth gate | `auth → requireSuperAdmin → requireSuperAdminMfa` on the whole `/api/super-admin` mount | `src/server.js` |
| SSE precedent | AI generation already streams `text/event-stream` | `src/routes/ai.js` |
| Charts / motion | `recharts`, `framer-motion` installed | frontend `package.json` |

**Consequence:** the Command Center is a new *tab* on `/platform` plus a
`command-center` service layer that composes existing collectors — not a new
app, and not a second health stack.

---

## 2. Infrastructure reality — CORRECTED

**The first version of this section was wrong.** It read `render.yaml` and
concluded the platform runs on Render free, and therefore that VPS monitoring
and Docker control were impossible. That file has since been **deleted** — it
described a host this app does not run on and had already misled one reader.

Production is a **Hostinger VPS running docker compose**, for BOTH halves.
Confirmed by each repo's own `.github/workflows/deploy.yml`: push to `main` →
SSH → `cd /opt/myptstudio` → `docker compose build backend|frontend && up -d`.

Live topology:

| Container | Role | Notes |
|---|---|---|
| `redis` | `redis:7-alpine` | bound to `127.0.0.1:6379`, appendonly, `maxmemory 256mb`, `noeviction`, compose healthcheck |
| `api` | the Express app | `127.0.0.1:5000`, `RUN_WORKERS=0` |
| `worker` | `node src/workers/index.js` | `RUN_WORKERS=1`, `stop_grace_period: 30s` |
| `frontend` | Next.js standalone | `127.0.0.1:3000` |

In front of all of it, on the host, sits **nginx** — routing on the Host header,
now version-controlled in `infra/nginx/`. It was the one part of production
nothing in either repo described.

**Everything the brief asked for is buildable.** Host CPU/RAM/disk/load/
temperature/process count come from `/proc` and `/sys`; Docker Center comes from
the Docker Engine API; the `worker` container is genuinely separate, so
per-worker restart is real, not a euphemism for restarting everything.

### Three things that must be resolved on the box

**A. The repo's compose file is not the one that runs.** Its own header says the
live file is at `/opt/myptstudio/docker-compose.yml`, outside this repository,
and the deploy script targets a service called **`backend`** while the repo file
defines **`api`**. Service names, mounts and volumes must be read off the box
before the Docker collector can name anything correctly.

**B. The API container cannot see Docker or the host today.** Nothing mounts
`/var/run/docker.sock`, `/proc` or `/sys` into it. Without those mounts the
collectors return "unavailable" — correctly, but uselessly.

**C. The container runs as a non-root user.** `Dockerfile` line 12 is
`USER express` (uid 1001). Even with the socket mounted, `/var/run/docker.sock`
is normally `root:docker 0660`, so uid 1001 cannot read it.

### How to grant access — recommended shape

Mounting the raw Docker socket into an internet-facing API container is
effectively handing out root on the VPS: anything that can talk to that socket
can start a privileged container and own the host. So:

```yaml
  # Allow-listed Docker access. The API never touches the raw socket.
  dockerproxy:
    image: tecnativa/docker-socket-proxy
    restart: unless-stopped
    environment:
      CONTAINERS: 1       # list + inspect
      POST: 1             # needed for restart
      IMAGES: 1
      INFO: 1
      # everything else stays 0: no EXEC, no VOLUMES, no SECRETS, no SWARM
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    ports:
      - '127.0.0.1:2375:2375'

  api:
    environment:
      DOCKER_HOST: tcp://dockerproxy:2375
    volumes:
      - /proc:/host/proc:ro     # host CPU, memory, load, process count
      - /sys:/host/sys:ro       # thermal zones, block devices
```

With `EXEC: 0` the socket proxy cannot be used to run commands inside
containers, which is the escalation path that matters. Host `/proc` and `/sys`
are read-only mounts and expose no write surface.

This is a change to the **live** compose file, which this repo cannot make. It
needs to be applied on the box (decision D6 below).

---

## 3. Decisions — LOCKED

| # | Decision | Consequence |
|---|---|---|
| **D1** | **WebSocket** | Adds `ws` to the backend. nginx needs an `Upgrade`/`Connection` map for `/api/command-center/stream` — config in `infra/nginx/`. Polling every 5s remains the fallback. See D7/D8 for how the browser reaches it and how it authenticates. |
| **D2** | **Real VPS monitoring. Ignore Render.** | `/proc` + `/sys` + Docker Engine API. ✅ `render.yaml` deleted, along with the frontend's `vercel.json`, so neither can be read as truth again. |
| **D3** | **No Render API key** | Nothing lost — Render is not production. |
| **D4** | **Hybrid logs** | ring buffer (hot, in-memory) → critical lines → `system_logs` table → archive/retention. |
| **D5** | **Escalation ladder for recovery** | pause → drain in-flight → resume → if still unhealthy restart worker → if still unhealthy restart container. Never jump straight to a restart. |
| **D6** | **OPEN — needs action on the VPS** | The compose changes in §2. Until then Docker/VPS cards report "not mounted" rather than guessing. |
| **D7** | **One env var, scheme-derived** | `NEXT_PUBLIC_API_URL` is the single source of truth. `wsBase()` swaps `https`→`wss`, so a domain change is one edit and the two origins cannot disagree. No second `NEXT_PUBLIC_WS_URL`. |
| **D8** | **Ticket auth for the socket** | Login → JWT cookie → `GET /api/ws-ticket` (authenticated, ~30s, single-use) → `wss://api.myptstudio.com/...?ticket=…` → verify → connected. |
| **D9** | **Do NOT widen the cookie to `.myptstudio.com`** | Rejected deliberately: it would work, but it puts the session cookie on every subdomain forever to serve one transport. D8 achieves the same thing scoped to a 30-second, single-use credential. |

### D7–D9 in detail — why the socket cannot just reuse the session

The browser reaches the API two different ways, and only one of them can carry a
WebSocket:

```
API calls    browser → nginx → frontend container → Next rewrite → backend
WebSocket    browser → nginx ──────────────────────────────────→ backend
```

The Next.js rewrite is an HTTP proxy and does not pass an `Upgrade`, so realtime
traffic must address `api.myptstudio.com` directly (**D7**).

That creates the auth problem. `setTokenCookie` in `src/routes/auth.js` sets no
`domain` attribute, so the cookie is **host-only** on `myptstudio.com` and is
never sent to the `api` subdomain. Browsers also cannot set headers on a
WebSocket, so `Authorization: Bearer` is unavailable. Two ways out, and the
cheaper one is the wrong one:

* Add `domain: '.myptstudio.com'` — one line, and it permanently broadens the
  session cookie to every present and future subdomain to serve a single
  feature. **Rejected (D9).**
* Issue a short-lived ticket (**D8**). The ticket is minted over the path that
  already works and authenticates, is worth ~30 seconds, is single-use, and
  carries only the identity the socket needs. A leaked ticket is worth almost
  nothing; a leaked session cookie is worth everything.

### D5 in detail — the recovery ladder

Each rung has an explicit health verdict and a stop condition. Nothing escalates
on its own without either an operator click or an explicit auto-recover policy.

```
unhealthy signal
  └─ 1. PAUSE queue          BullMQ pause(), in-flight jobs keep running
     └─ 2. DRAIN             wait for active == 0, bounded (30s, matches
                             stop_grace_period — a renewal job killed mid-flight
                             is a card charged with no membership row)
        └─ 3. RESUME         re-check health
           └─ 4. RESTART WORKER    docker restart <worker>  (SIGTERM, 30s grace)
              └─ 5. RESTART CONTAINER  the api/backend container
                 └─ 6. STOP + PAGE     never loop; hand to a human
```

### One Click Recovery

The flow the brief asks for, made safe:

```
detect  →  Guardian produces a finding with a confidence score
        →  finding maps to a NAMED, allow-listed remediation
        →  operator sees: what is wrong, why, what will run, blast radius
        →  ONE CLICK  (typed confirmation for anything destructive)
        →  pre-flight snapshot captured
        →  remediation runs, streamed live over the WebSocket
        →  post-flight health check
        →  success → notify owner  |  failure → auto-rollback to previous rung
        →  the whole run written to activity_log with actor + before/after
```

Rules, because this button can take production down:
- **Never auto-executes below 95% confidence.** Default is suggest-only;
  auto-recover is opt-in per remediation.
- Every remediation is **idempotent** and has a **declared blast radius**
  (which containers, expected downtime).
- **Circuit breaker:** the same remediation may not fire twice within 10
  minutes, and 3 failures in an hour disables auto-recovery until cleared.
- A **dry-run** mode renders the exact commands without executing.

---

## 4. Architecture

```
src/modules/command-center/
  collectors/            one file per source; each exports async collect()
    runtime.collector.js       process, memory, event-loop lag, GC
    database.collector.js      pool, pg_stat_activity, pg_stat_statements, size, migrations
    redis.collector.js         wraps lib/redis.js ping + INFO
    queue.collector.js         wraps lib/queueHealth.js (NO new BullMQ clients)
    ai.collector.js            ai_usage_log aggregates + provider health
    smtp.collector.js          wraps lib/email.js describeConfig/verifyConnection
    security.collector.js      login_events, rate-limit hits, RLS/env posture
    http.collector.js          in-memory request-timing ring: p50/p95/p99, slow endpoints
    platform.collector.js      Render / Supabase / Vercel APIs, when keys exist
  registry.js            name -> { collector, ttl, severity rules }
  snapshot.service.js    parallel collect, per-collector timeout, cache
  guardian.service.js    rules engine -> findings; optional LLM narration
  alerts.service.js      finding -> alert lifecycle (open/ack/resolved) + channels
  commands.service.js    allow-listed actions, each audited
  command-center.routes.js
```

Non-negotiables, all from §18:

- Every collector is **read-only** and **individually timeout-guarded**; one dead
  dependency degrades one card, never the page. This mirrors how
  `queueHealth.js` already behaves.
- **No new Redis client.** `lib/redis.js` is the only one.
- **No new health endpoint.** `/api/health` stays a liveness probe;
  `system-health` is refactored to call the same collectors so the two can never
  disagree.
- Every collector returns
  `{ status, value, latency_ms, checked_at, unavailable_reason? }`
  so the UI renders "unavailable" as a first-class state.

**Transport — recommendation: SSE, not WebSocket.** The repo already streams
`text/event-stream` for AI, it needs no new dependency, it survives the Vercel
`/api/*` rewrite unchanged, and it reconnects natively. A `ws` server on Render
free — which spins down after 15 minutes idle — buys nothing here, because this
is one-directional server→client push. Commands stay ordinary POSTs. Polling at
5s is the documented fallback when the stream drops.

**Security.** Mounts behind the existing
`auth → requireSuperAdmin → requireSuperAdminMfa`. Every command is allow-listed
by name, rate-limited, and written to `activity_log` with the actor. A console
with "flush cache" and "clear queue" buttons is a privileged surface and is
treated as one.

---

## 5. Phases

Each phase ends with: tests green, lint clean, a verification note, one commit.
Nothing merges that breaks an existing feature.

| Phase | Scope | Deliverable | Status |
|---|---|---|---|
| **0** | This document + decisions D1–D5 | agreed scope | ✅ done |
| **1** | Collector framework: `registry`, `snapshot.service`, timeout/cache harness, plus `runtime` + `database` + `redis` + `queue` collectors. `GET /api/command-center/snapshot`. Refactor `system-health` onto it. | Real data, one endpoint, no UI | ✅ done |
| **2** | Remaining collectors: `ai`, `smtp`, `security`, `http` request-timing ring, `platform`. Per-domain endpoints from §16. | Full backend surface | ✅ done |
| **3** | WebSocket `/api/command-center/stream` (D1) + per-card diffing so only changed cards re-render. Polling fallback. | Live updates | ⏸ needs nginx `Upgrade` headers on the VPS |
| **4** | Frontend `CommandCenterTab` on `/platform`: card grid, status colours, sparklines, skeleton and unavailable states, framer-motion transitions. Built from the existing `ui/` kit. | The console | ✅ done |
| **5** | Commands: run health check, test SMTP, test AI, test DB, clear queue, flush cache — allow-listed, audited, confirm-gated; destructive ones behind a typed confirmation. | Control | ✅ done — rungs 1–3; 4–5 blocked on D6 |
| **6** | Alert Center: thresholds → findings → alert lifecycle, history table, channels (browser first; email/WhatsApp reuse existing senders). | Alerting | ✅ done |
| **7** | AI Guardian: deterministic rules engine first (correlations such as "queue depth rising **and** Redis latency rising → worker starvation"), then optional LLM narration over the *finding*, never over raw metrics. Confidence shown; recommendations advisory only. | Diagnosis | ✅ done |
| **8** | Live Logs, per decision D4. | Logs | ✅ done |

Phases 3, 8 and the restart-actions in 5 depend on the decisions below.

### Phase 5 as built — and the one thing it deliberately does not do

The brief asks for a **Flush Cache** button. Implemented the obvious way, that
button is a data-loss bug on this deployment, and it took reading the compose
file to see it: **Redis here holds nothing but BullMQ.** A grep across `src/`
finds no `set`/`get`/`hset` outside the queue modules, and the Redis service is
deliberately configured `appendonly yes` + `maxmemory-policy noeviction` because,
as `docker-compose.yml` puts it, *"a queue that empties on reboot is not a
queue"*. A `FLUSHDB` behind that button would not clear a cache. It would delete
every pending invitation email and every scheduled membership renewal, and
report success.

So `cache.flush` clears the Command Center's **own collector TTL cache** — a real
cache, safe to drop, and the thing an operator actually wants when they ask for
fresh numbers. Its description says so on the card, and a test asserts it never
reaches Redis.

The rest of the allow-list, with rungs 1–3 of the D5 ladder runnable:

| Command | Destructive | Notes |
|---|---|---|
| `health.check` | no | Re-probes every collector, bypassing the TTL cache |
| `cache.flush` | no | Collector cache only. Never touches Redis |
| `database.test` | no | Round-trips a query; reports latency and pool state |
| `redis.test` | no | PING through the shared client |
| `smtp.test` | no | The live handshake the 30s tick deliberately never makes |
| `ai.test` | no | One minimal prompt. Costs money, hence a 15s cooldown |
| `queue.pause` | no | Rung 1 |
| `queue.drain` | no | Rung 2. Waits ≤30s, matching the worker's `stop_grace_period` |
| `queue.resume` | no | Rung 3 |
| `queue.retryFailed` | **yes** | Side effects repeat — an email may send twice |
| `queue.clearFailed` | **yes** | Irreversible: the payloads go too |
| `worker.restart` | **yes** | Rung 4 — **UNAVAILABLE**, needs the Docker socket (D6) |
| `container.restart` | **yes** | Rung 5 — **UNAVAILABLE**, needs the Docker socket (D6) |

Safety properties, each covered by a test verified to fail against a mutated
implementation:

* Destructive commands require a typed confirmation **equal to the command
  name**. A generic truthy `"yes"` is refused, so a click-through cannot satisfy
  the gate.
* Availability is checked **ahead of** confirmation — an operator never types
  the name of a command that was never going to run.
* Queue names are validated up front against `QUEUE_NAMES`: a clean 400 that
  never constructs a queue and never burns the cooldown, because a typo must not
  lock you out of the command you meant.
* Every run is audited, **failures included** — a failed restart is the more
  interesting row. An audit-write failure cannot mask the result.
* Per-command cooldowns stop a double-click firing twice.
* Dry run describes without executing, without auditing, without consuming the
  cooldown — and **without bypassing confirmation**, since a preview that
  skipped the gate would be a bypass.

Rungs 4–5 are declared rather than hidden, so the console shows the whole ladder
and names exactly what is missing instead of looking complete.

### Phase 6 as built — the Alert Center is a noise problem, not a detection one

The collectors already detect; Phase 2 spent its effort making those grades
honest. So the tempting version of Phase 6 is four lines: on every tick, insert
a row for every card that is not healthy.

That version is worse than nothing. **SMTP on this platform has been broken
continuously since launch.** At a 60s tick it produces 1,440 rows a day
describing one fact, the Alert Center opens on a wall of them, and an operator
learns inside a week to ignore the screen — taking the genuine alerts with it.

So an alert here is the **condition**, and it has a lifetime:

| Property | Mechanism |
|---|---|
| Dedup | Partial unique index on `(fingerprint) WHERE status <> 'resolved'` (migration 150). At most one live alert per source — a *database* guarantee, not a convention the service has to remember. |
| Recurrence | Resolved rows fall out of that partial index, so the same condition next week opens a **new** alert while the old one stays in history. Only a partial index can express "unique among the live ones". |
| Damping | 2 consecutive bad observations to open, 3 good to close. Asymmetric: a 3s probe timeout during a deploy is not an incident, and an alert that closes on the first green reading re-notifies every time it flaps. |
| Escalation | warning → critical clears `notified_at` and re-announces. The reverse updates quietly — improving is not worth a second interruption. |
| Auto-close | A condition that fixes itself closes itself, marked `auto`. Manual closures are marked `manual`, because a history full of manual closures means the *detection* is wrong and nothing else would reveal it. |
| Notify-once | `notified_at` is a column, not a promise. |

**`unavailable` never alerts.** Same rule the console renders by: a probe that
could not run (no `REDIS_URL`, no Docker socket) is a gap in observability, not
an outage. Alerting on it would page someone about a box that was never wired
up. An `unavailable` reading also counts as *clear*, so an alert is never held
open by a probe that stopped running.

**The channel self-reference rule.** A channel is never used to deliver an alert
about that channel's own subsystem — an alert about SMTP does not go by SMTP.
That is not merely futile: the send fails, and a failed send is itself
observable, so it can feed the very condition it was reporting. In-app is the
primary channel and always attempted (one INSERT on the pool everything else
already needs; if Postgres is gone, no alerting mechanism would have helped);
email is best-effort on top and suppressed for `smtp` alerts.

**Where it runs.** `setInterval(…).unref()` in the API process, following the
same pattern as the announcement dispatcher, disabled with `ALERT_EVALUATION=off`.
The API process rather than the worker because the `runtime` and `http`
collectors measure *this* process — event-loop lag, heap, the request-timing
ring — and the worker can see none of it. Overlapping ticks are safe because the
partial unique index makes double-opening impossible.

There is no "evaluate now" route. Forcing an evaluation is an operator action
with a cost, and Phase 5 already built the machinery for those, so it is
`alerts.evaluate` in the allow-list rather than a fourth door on the router.

Verified beyond the unit tests: migration 150 and every query the service issues
were run against a real PostgreSQL 16 — the `ON CONFLICT … WHERE` inference, the
recurrence-after-resolve behaviour, and a raw duplicate insert being rejected by
the index. Migrations run automatically at boot, so a migration that only *looks*
correct would stop the API container from starting.

---

## 6. Explicit non-goals

- No fabricated metrics. A card with no source says so.
- No second Redis client, no second BullMQ registry, no second health endpoint.
- No mutation of tenant data from this console. It reads infrastructure and
  performs allow-listed operational actions only.
- Not a replacement for Sentry. Sentry stays the error tracker; this correlates
  and controls.


### Phase 7 as built — a confident wrong answer is the thing to design against

The demo-friendly build is: serialise the snapshot, hand it to a model, ask
"what is wrong". It always answers — including when nothing is wrong, and
including when the real cause is not in the data — and **nothing in the output
separates "found it" from "wrote something that reads like finding it".** An
operator acting on the second at 3am is worse off than one with no guidance.

So the diagnosis is decided by rules that can be read, argued with and tested.
The model's only job is to reword a finding the codebase already stands behind.
It cannot create a finding, change a severity, or move a confidence number — and
a test asserts exactly that, by having the model reply *"Actually the database is
the problem and I am 100% certain"* and checking the finding is unchanged.

**The rules are correlations, never thresholds.** Collectors own thresholds and
already do them well; a rule that re-checked one would be a second place for the
number to go stale. What a collector *cannot* do is look at another card:

| Rule | The correlation, and the misdiagnosis it prevents |
|---|---|
| `worker.starvation` | jobs waiting **and** nothing active **and Redis healthy**. Without the Redis half, the queue card is red and somebody restarts Redis — which is fine. |
| `redis.enqueue_failure_imminent` | memory high **and policy is noeviction**. On an eviction policy the same number is normal operation; here writes get *rejected*, so renewals fail to enqueue. |
| `mail.silently_discarded` | mail critical **and the email queue is accumulating failures** — sends are being attempted and rejected at the transport. Mail failing with a *clean* email queue is a different bug in a different file. |
| `runtime.event_loop_blocked` | lag high **and CPU low**. High lag with high CPU is a busy process wanting capacity; low CPU means something synchronous is holding the loop, and scaling would not help. Opposite fixes. |
| `database.connections_held` | pool waiting **and** idle-in-transaction **and requests slowing**. Waiters with no user-visible effect is a headroom question; waiters slowing requests is an incident. |
| `http.slow_because_database` | API p95 high **and** DB latency high **and** the loop healthy. The anti-symptom-chasing rule: without it, an hour goes into profiling request handlers. |
| `ai.provider_degraded` | fallback rate high **and** the ai queue backing up. A rate alone cannot tell a degraded provider from simply sending fewer requests. |

A structural test enforces this — every rule must read more than one card. It
**failed on first run** and caught three of these rules reading a single card;
they were strengthened with the cross-card signal each was missing rather than
the test being weakened.

**Confidence is computed, and shown next to the list it summarises.** A model
asked "how confident are you" emits a number with nothing behind it. Here it is
derived from which signals fired, and the UI prints all of them — including a
section most versions of this screen omit: **what could not be checked**. "Redis
is healthy" and "we cannot see Redis" are different states; an engine that
conflated them would confidently blame the worker on a box where Redis was never
configured. An unknown *trigger* never satisfies a rule at all; an unknown
*corroborating* signal lowers confidence and says so by name.

Confidence is capped below 1.0. A rules engine claiming certainty about a system
it observes through eight sampled probes is lying.

**One Click Recovery** (D5) ships here as `recovery.run`: assess → pause → drain
→ resume → verify, on one queue, **stopping as soon as the queue is healthy**.
Stopping early is the point — a routine that always runs to the end restarts a
healthy worker, and that is how ops teams stop trusting the button. It asks the
queue *collector* whether it worked rather than keeping its own idea of
"healthy", so it can never disagree with the card. When it does not recover it
names rung 4 and says plainly that rung 4 needs the Docker socket, instead of
finishing at rung 3 and reporting success.


### Phase 8 as built — the loop, and the two halves that stay separate

**The bug this phase is mostly written to avoid.** Persisting error logs means
that when the database is unhealthy, the INSERT fails. The obvious thing to do
with a failed INSERT is log an error — which is at `error` level, so it is
captured, so it is queued, so it fails, so it logs an error. That loop pins the
CPU and floods the disk during exactly the incident the feature exists to
investigate. Three guards, because any one alone is insufficient:

1. **Re-entrancy flag** around the flush, so a line emitted *while* flushing is
   never itself queued.
2. **Failures go to `process.stderr` directly, never through the logger.** The
   logger is what feeds this module. A test asserts against the real stderr,
   because the whole point is that this path bypasses the logging stack.
3. **The pending queue is bounded.** A database that stays down costs a fixed
   amount of heap and a counter, not an OOM — otherwise the process dies of the
   monitoring rather than of the problem. Dropped lines are counted and the
   console shows the number, so the gap in the record is visible.

All three were verified by mutation.

**The two halves answer different questions and are not merged.**

| | Ring (memory) | `system_logs` (Postgres) |
|---|---|---|
| Holds | everything recent | `error` and above only |
| Survives restart | no | yes |
| Covers | **this process only** | api **and worker** |
| Cost | one array slot | one batched INSERT per 5s |

Persisting every line would be a row for roughly every request — a tax on a
database already carrying the product's load, paid forever, to store text that
is interesting for four minutes. The ring is fast and lossy by design; the table
is slow and durable by design; the UI never presents one as the other.

**Why `source` exists.** Production runs two node processes in separate
containers. Each has its own ring, and the console is served by the API — so the
live tail can only ever show API lines. Without saying so, an operator watching
a queue incident sees nothing from the worker and concludes the worker is dead.
It is not: its errors are in `system_logs` and nowhere else. The worker gets its
own flush interval (and a flush on SIGTERM, since the errors immediately
preceding a shutdown are the interesting ones).

**Capture is a pino multistream, not a wrapper.** Wrapping the logger's methods
would miss child loggers and anything using pino directly, and would put a
function call in front of every log statement in the app. stdout receives
exactly what it did before, so `docker logs` is unaffected — this adds a reader,
it does not move the output. `LOG_CAPTURE=off` restores the original
single-stream logger, because this is the most widely required module in the app
and a change here should be revertible by an environment variable rather than a
deploy.

**One thing the phase added that the brief did not ask for.** `lib/logger.js`
redacts by *path* — authorization headers, passwords, emails. That covers
structured fields and misses a secret sitting inside a free-text message or an
error string. It did not matter much when those lines went to a VPS's stdout; it
matters now that they are stored in a table and rendered in a browser. So the
capture scrubs connection-string credentials, bearer tokens, JWTs and
prefixed provider keys on the way in — conservatively, since over-masking costs
an operator one ssh and under-masking puts a live credential in a database row.
Verified end-to-end against the real logger: `postgres://admin:hunter2@…` reaches
the ring as `postgres://admin:[REDACTED]@…` with the hostname intact.

Migration 151 and every query the module issues were run against a real
PostgreSQL 16, including the retention sweep deleting only the aged row.

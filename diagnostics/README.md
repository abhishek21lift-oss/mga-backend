# diagnostics/

**Temporary.** Nothing here is loaded by the application. Delete the folder when
the investigation it belongs to is closed.

## redis-trace.js

Answers: **who is dialling `127.0.0.1:6379`?**

Production logs carried a repeating `ECONNREFUSED 127.0.0.1:6379` while
`REDIS_HOST=redis` was set, Redis was healthy, `lib/redis.js` resolved to
`redis:6379`, and the health endpoint reported Redis connected. Rather than
produce another hypothesis, this prints the stack trace of whoever actually
opens the connection.

### Running it

On the VPS, against the real container:

```bash
# One-off, without changing the compose file. The container exits when you do.
docker compose run --rm --entrypoint sh backend -c \
  'node --require ./diagnostics/redis-trace.js src/server.js'
```

or, to trace the *running* service, add the flag to its command temporarily:

```yaml
# /opt/myptstudio/docker-compose.yml — REVERT AFTER DIAGNOSIS
backend:
  command: node --require ./diagnostics/redis-trace.js src/server.js
```

```bash
docker compose up -d backend && docker compose logs -f backend | grep -A30 REDIS-TRACE
```

The worker container is a separate process with its own connections — if the
error appears in the worker's logs, trace that one:

```yaml
worker:
  command: node --require ./diagnostics/redis-trace.js src/workers/index.js
```

Locally: `npm run diagnose:redis`.

### What it prints

On startup, the environment it is running under — read this first:

```
██ redis-trace ACTIVE
██   watching   : loopback:6379
██   REDIS_HOST : redis
██   REDIS_PORT : 6379
██   REDIS_URL  : (unset)          <- if this is SET, it overrides REDIS_HOST
██   NODE_ENV   : production
██   commit     : (not stamped — see below)
```

Then, for each loopback dial:

```
══════════════════════════════════════════════════════════════════════════════
██ REDIS-TRACE  new Redis()  ->  127.0.0.1:6379     (occurrence 1)
══════════════════════════════════════════════════════════════════════════════
CALLER : Object.<anonymous> (src/jobs/whatever.js:4:1)
OPTIONS: {"host":"127.0.0.1","port":6379,...}
STACK  :
      at RedisConnection.init (node_modules/bullmq/.../redis-connection.js:193)
   >> at Object.<anonymous> (src/jobs/whatever.js:4:1)
══════════════════════════════════════════════════════════════════════════════
```

`>>` marks frames in this repository. `CALLER` is the first of them — the
answer. Each unique site reports up to 3 times (`REDIS_TRACE_MAX`) so a
reconnect loop cannot flood the log.

### How it works, and why three layers

| Layer | Catches |
|---|---|
| `net.Socket.prototype.connect` | **every** outbound TCP connection, whatever library opened it — the backstop that cannot be evaded |
| ioredis constructor | the fully *resolved* options, which the socket layer cannot show |
| node-redis `createClient` | `redis@6` is installed; nothing requires it today, but its default is also loopback |

Patching one client would have been another guess. The socket layer alone
answers the question; the other two make the answer readable.

It runs via `--require` so it patches before any application module loads —
including `src/instrument.js` (Sentry), which installs its own module hooks on
line 8 of `server.js`.

### It does not change behaviour

Every patch calls through and returns the original result. Nothing is
swallowed, no option is rewritten. Verified by loading `lib/redis` and
`jobs/queue` with and without it — identical resolved options, identical
queues. If the diagnostic itself throws, it catches and continues.

### Two gaps found while testing it — both by testing against a *known* bug first

Worth recording, because both were silent false negatives that would have made
the tool confidently report "nothing found":

1. **ioredis is constructed via `.default`.** BullMQ does
   `new ioredis_1.default(rest)` (`redis-connection.js:193`). A `construct`
   trap on the Proxy is not enough — the `default` static returns the original
   class and walks straight past it. Fixed with a `get` trap.
2. **`net.connect()` normalizes its arguments into an array.** `args[0]` is
   `[{host, port}, cb]`, not `{host, port}`, so the port comparison quietly
   failed and the backstop missed the most common call shape.

An instrument that has not been shown to catch a bug you already understand is
not evidence about the one you do not.

### Stamping the commit

`commit:` reads `GIT_COMMIT` or `SOURCE_COMMIT`. Neither is set today, which
matters more than it looks: *"the fix is deployed"* is itself an assumption, and
if the running image predates the fix then the logs describe older code and no
tracing will explain them. To stamp it, add to the Dockerfile:

```dockerfile
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
```

and pass `--build-arg GIT_COMMIT=$(git rev-parse --short HEAD)` in the deploy.

Until then, confirm what is running directly:

```bash
docker compose exec backend git -C /opt/myptstudio/619-erp-backend rev-parse --short HEAD
docker compose exec backend ls src/jobs/email.queue.js   # gone in the fixed build
docker compose exec backend env | grep -i redis          # is REDIS_URL set?
```

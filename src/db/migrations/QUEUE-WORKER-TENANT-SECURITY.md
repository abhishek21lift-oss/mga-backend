# Queue and worker tenant security

Companion to WEBHOOK-SECURITY.md. Covers what happens after a job is enqueued,
where AsyncLocalStorage does not survive and tenant identity has to be
reconstructed from persisted metadata or not at all.

## Producer → queue → worker

| Queue | Producer | Worker | Worker DB access | Class |
|-------|----------|--------|------------------|-------|
| `ai` | `services/ai.service.js` | `ai.worker.js` | none | SHARED (delivery) |
| `email` | `services/email.service.js`, `emailQueue.service.js` | `email.worker.js` | none | SHARED (delivery) |
| `whatsapp` | `services/whatsapp.service.js` | `whatsapp.worker.js` | none | SHARED (delivery) |
| `notifications` | `services/notificationFanout.js` | `notifications.worker.js` | **6 calls via notifications.service** | SHARED — see below |
| `membership-renewals` | cron scheduler | `renewal.worker.js` | yes, per tenant | SHARED |
| — (setInterval) | `server.js` | `subscription.worker.js` | yes, platform-wide | PLATFORM |

Traced by following each worker's requires, not by grepping the worker files:
three of the four delivery workers hold no database access anywhere in their
call graph, and the fourth does.

## Why the delivery workers need no tenant context

`ai`, `email` and `whatsapp` make no database call at any depth. Their job
payload is the finished article — recipient, subject, body — resolved by the
producer while it was still inside the request's tenant context. The worker
makes no tenant decision, so there is no decision to get wrong, and a forged
`organization_id` in the payload would have nothing to influence.

This is a real guarantee but a fragile one: it holds only while those workers
stay DB-free. The moment one resolves an id against the database it acquires a
tenant boundary and needs a trusted `organization_id` in the envelope.

## Findings

**`notifications` cannot be written as app_tenant.** `notifications.service`
inserts into `notifications` from inside the worker, across the queue boundary,
with no tenant context — and none is possible there, because
AsyncLocalStorage does not cross Redis. The table has no `organization_id`, so
157 gave it no policy and 131's deny-all applies:

```
INSERT INTO notifications … → 42501 new row violates row-level security policy
```

In-app notifications are therefore never stored. It fails closed, so this is an
outage rather than a leak, and it is keyed on `user_id` so there is no
cross-tenant exposure either way.

**`notification_log` does not exist.** The same service writes delivery results
to it:

```
INSERT INTO notification_log … → 42P01 relation "notification_log" does not exist
```

Same class as the Razorpay gateway columns: code written against a schema this
product does not have. Not invented here — where notification delivery history
belongs, and whether it is tenant-scoped, is a domain decision.

## Not yet verified

Recorded so the gap is visible rather than implied by silence. None of these
were tested:

- retry preserving tenant identity across a failure
- two tenants processing concurrently through real workers
- tenant reconstruction after a worker process restart
- automation engine ownership and cross-tenant target ids
- scheduled automation restoring tenant from persisted config
- webhook → queue boundary end to end
- dead-letter and manual replay preserving tenant

The first three are only meaningful against a live Redis with real workers; the
remainder need the automation module traced the way the workers were here.

## Job payload secrets

Checked: no producer places a JWT secret, database URL, provider API key or
OAuth token into `job.data`. Payloads carry recipients, template names and
rendered content.

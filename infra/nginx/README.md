# infra/nginx

The reverse-proxy configuration for the VPS, version-controlled so a migration
is a copy rather than an archaeology exercise.

> **These files are a template, not the live config.** Nothing in this repo is
> deployed to nginx automatically — `deploy.yml` only rebuilds containers. The
> live files are on the box and may already differ. **Diff before replacing.**

## Why this folder exists

Everything about how requests reach this app lived in one place: a box. The
repo's own files actively contradicted it — a `render.yaml` describing a host
the app does not run on, and a `vercel.json` describing a frontend deployment
that does not happen. Both have been deleted for exactly that reason. This
folder is the replacement: the routing written down where it can be reviewed,
diffed and restored.

## The topology

```
                         ┌──────────────────────────────────────┐
  myptstudio.com     ──► │ nginx (host)                          │
  www.myptstudio.com ──► │   443 TLS, routes on the Host header  │
  api.myptstudio.com ──► │                                       │
                         └───────┬───────────────────┬──────────┘
                                 │                   │
                    127.0.0.1:3000                127.0.0.1:5000
                    frontend container            backend container
                                                        │
                                              127.0.0.1:6379  redis
                                                     worker container
```

All three names resolve to the same address. Both app containers bind to
**loopback only** (`docker-compose.yml`), so nginx is the only route in — do not
"fix" a connection problem by exposing a container on `0.0.0.0`.

## The request path has two shapes

```
API calls    browser → nginx → frontend container → Next rewrite → backend
WebSocket    browser → nginx ──────────────────────────────────→ backend
```

Ordinary API calls use relative URLs (`apiBase()` returns `''` in production)
and are forwarded by the Next.js rewrite in the frontend's `next.config.js`.
**That hop cannot carry a WebSocket** — it is an HTTP proxy and does not pass an
`Upgrade`. So realtime traffic addresses `api.myptstudio.com` directly, derived
from `NEXT_PUBLIC_API_URL` by `wsBase()` in the frontend's `src/lib/http.ts`
(`https` → `wss`), which keeps one variable as the source of truth for both.

If you ever see the Command Center silently fall back to polling, there are two
usual suspects and neither is the application code:

1. **This proxy** — no `Upgrade` block on the `api.` vhost, or a 60s
   `proxy_read_timeout` cutting an idle stream. Verify with the curl below.
2. **The frontend's CSP.** `connect-src` must list the **`wss://`** origin, not
   just the `https://` one — an `https:` source expression does not permit a
   `wss:` URL. Built from `NEXT_PUBLIC_API_URL` in the frontend's
   `src/lib/security-headers.js`. A CSP block shows up in the browser console as
   `Refused to connect to 'wss://…'` and nowhere in these logs at all, which is
   why it is worth ruling out early.

## Files

| File | Goes where | Purpose |
|---|---|---|
| `install-websocket.sh` | run on the VPS | does the whole install, safely |
| `patch-vhost.py` | called by the script | inserts the location block into the right `server{}` |
| `websocket.conf` | `http {}` block | the `$connection_upgrade` map and the shared proxy headers |
| `myptstudio.conf` | `sites-available/` | reference: what a correct config looks like |

## Installing

```bash
cd /opt/myptstudio/619-erp-backend && git pull origin main
cd infra/nginx

sudo ./install-websocket.sh --dry-run     # prints the exact diff, changes nothing
sudo ./install-websocket.sh               # applies it
```

That is the whole thing. The script:

* refuses to start if the config is **already** invalid, so a pre-existing
  error cannot be blamed on this change;
* finds the API vhost by `server_name`, not by filename, and only the one that
  also listens on **443** — the `:80` block names the host too, and patching it
  would put the handshake behind a 301;
* reuses an existing `$connection_upgrade` map instead of adding a second one.
  Two maps for the same variable is a fatal error, and it is the most common
  way this particular change takes a box down;
* **inserts only.** It never replaces the vhost, so certificate paths, redirects
  and rate limits the template knows nothing about survive untouched;
* backs up `/etc/nginx`, runs `nginx -t`, and **puts everything back** if the
  test or the reload fails;
* is idempotent — the second run says `nothing to do`;
* then proves it from outside with the handshake curl below.

Nothing rolls back after a successful reload. If the final check comes back
unhappy the config is still applied, and the script prints the revert command —
undoing a valid config because a curl could not resolve DNS would be the worse
outcome.

<details>
<summary>Doing it by hand instead</summary>

```bash
sudo nginx -T > /tmp/nginx-before.conf
sudo cp -a /etc/nginx /etc/nginx.bak.$(date +%F)

# The map MUST be in http {}, not inside a server {} — nginx rejects it there.
sudo mkdir -p /etc/nginx/snippets
sudo cp websocket.conf /etc/nginx/conf.d/websocket.conf
sudo sed -n '/^proxy_set_header Host/,$p' websocket.conf \
  | sudo tee /etc/nginx/snippets/myptstudio-proxy.conf

# DIFF FIRST — the live file may carry things this template does not know about.
diff /etc/nginx/sites-available/myptstudio.conf myptstudio.conf

sudo nginx -t && sudo systemctl reload nginx
```
</details>

If `nginx -t` fails, nothing has been applied yet — fix and re-test. Restore
with `sudo rm -rf /etc/nginx && sudo mv /etc/nginx.bak.<date> /etc/nginx`.

## Verifying the WebSocket path

A plain `curl` gets a `426` or `400`, which is nginx doing the right thing. To
see a real upgrade:

```bash
curl -isS -m 10 https://api.myptstudio.com/api/command-center/stream \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" | head -20
```

| You get | Means |
|---|---|
| `401 Unauthorized` | **the proxy is correct.** The app received the handshake and refused it because the curl carried no ticket — see below. This is the success case for this test. |
| `101 Switching Protocols` | the proxy is correct *and* the ticket was valid |
| `502` | nginx reached nothing — is the backend container up? |
| `200` with HTML | the request went to the **frontend**, not the API — wrong vhost |
| `404` | reached the app, wrong path — it serves exactly `/api/command-center/stream` |
| hangs, then `504` | `proxy_read_timeout` is still the 60s default |

## How the stream authenticates

The socket does **not** present the session cookie, and that is deliberate.

The cookie belongs to `myptstudio.com`; the socket must address
`api.myptstudio.com`, because the Next.js rewrite cannot carry an `Upgrade`.
Different host, so the browser sends no cookie — and `new WebSocket()` gives
JavaScript no way to set an `Authorization` header either.

Widening the cookie to `.myptstudio.com` would fix it, and was rejected: that
sends the session to every present and future subdomain, forever, so that one
operator console can live-update.

Instead the console `POST`s to
`/api/super-admin/command-center/stream-ticket` over the ordinary authenticated
channel and spends the returned ticket in the handshake query string. The ticket
is **single-use** and expires in 30 seconds, which is what makes a query string
an acceptable place to put one — by the time it reaches this access log it is
already spent. The alternatives and why each was rejected are written up in
`src/modules/command-center/tickets.js`.

Consequence for debugging: the `401` above is the proxy working. For a real
`101`, mint a ticket with the browser's session first and append `?ticket=…`
within 30 seconds.

## Certificates

Issued by certbot. `api.myptstudio.com` needs its own certificate (or a SAN on
the main one) — a certificate for `myptstudio.com` does **not** cover a
subdomain, and a browser refuses a `wss://` to a host whose certificate does not
match, with an error that looks like a WebSocket bug and is not.

```bash
sudo certbot --nginx -d myptstudio.com -d www.myptstudio.com
sudo certbot --nginx -d api.myptstudio.com
sudo certbot renew --dry-run
```

## What deliberately is NOT here

**Security headers.** The frontend's `src/lib/security-headers.js` is the single
source of truth and Next.js applies them. Setting them in nginx too is how they
drift, and how a CSP ends up quietly weaker than the file claiming to define it.

**Caching rules.** A deleted `vercel.json` carried a `no-store` policy that was
never actually applied, because nothing served the app from Vercel. Reinstating
it here would be introducing a caching change under the heading of a cleanup.
If that policy is wanted, it should be a deliberate decision — Next.js already
sets `immutable` on `/_next/static` itself.

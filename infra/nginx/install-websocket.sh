#!/usr/bin/env bash
#
# Give the api.* vhost a WebSocket path, on a box whose nginx config this
# repository has never seen.
#
# ── Why a script and not the copy-paste in README.md ────────────────────────
#
# The README's steps are correct, and someone following them carefully gets the
# same result. The failure mode is not the steps — it is doing them at 1am
# against a live proxy: forgetting `nginx -t`, pasting the map inside a server{}
# block where nginx rejects it, or replacing a vhost that carried a rate limit
# nobody remembered. This does the same work, refuses to guess, and puts the
# config back exactly as it was if anything goes wrong.
#
# ── What it will NOT do ─────────────────────────────────────────────────────
#
# It never replaces the vhost. The live file may carry certificate paths,
# redirects or limits this repository does not know about, so the only edit is
# INSERTING one location block into the server that already answers for the API.
#
# Idempotent: run it twice and the second run changes nothing.
#
#   sudo ./install-websocket.sh              # apply
#   sudo ./install-websocket.sh --dry-run    # print the diff, change nothing
#   sudo API_HOST=api.example.com ./install-websocket.sh
set -euo pipefail

API_HOST="${API_HOST:-api.myptstudio.com}"
BACKEND="${BACKEND:-127.0.0.1:5000}"
STREAM_PATH="${STREAM_PATH:-/api/command-center/stream}"
SNIPPET=/etc/nginx/snippets/myptstudio-proxy.conf
MAP_FILE=/etc/nginx/conf.d/websocket-map.conf

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo — nginx -T and /etc/nginx both need root"
command -v nginx   >/dev/null || die "nginx is not installed on this host"
command -v python3 >/dev/null || die "python3 is required (Ubuntu ships it)"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# ── 0. The config must already be valid ─────────────────────────────────────
#
# Otherwise a pre-existing error surfaces after our edit, gets blamed on it, and
# the restore below cannot tell the two apart.
if ! nginx -t >/dev/null 2>&1; then
  nginx -t || true
  die "the EXISTING config is already invalid — fix that first; this script will not add to it"
fi
nginx -T >"$WORK/dump" 2>/dev/null

# ── 1. Find the vhost that already answers for the API ──────────────────────
#
# By server_name, not by filename: the file can be called anything, and guessing
# a path is how you edit the wrong site.
# -R, not -r. sites-enabled holds SYMLINKS into sites-available, and `grep -r`
# does not follow symlinks found inside a directory — only ones named on the
# command line. With -r this found nothing on a stock Debian/Ubuntu nginx and
# reported "no vhost declares server_name ...", which is a confusing way to say
# "I did not look".
VHOST="$(grep -RlE "^[[:space:]]*server_name[^;]*\b${API_HOST//./\\.}\b" \
          /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | head -1 || true)"
[[ -n "$VHOST" ]] || die "no vhost declares server_name ${API_HOST}. Set API_HOST=... if the API is served under another name."
VHOST="$(readlink -f "$VHOST")"   # sites-enabled entries are usually symlinks
say "API vhost: $VHOST"

# Measured NOW, before the patch. Afterwards the file contains the block this
# script adds — which includes the snippet — so the same grep would always
# match and the advisory at the end would never fire.
VHOST_HAD_XFF=1
grep -qE 'X-Forwarded-For|myptstudio-proxy\.conf' "$VHOST" || VHOST_HAD_XFF=0

# ── 2. The \$connection_upgrade map ─────────────────────────────────────────
#
# It has to live in http{}, and exactly once — nginx refuses to start with the
# variable mapped twice. An existing one is reused rather than duplicated; this
# is the most common way this particular change takes a box down.
if grep -q 'connection_upgrade' "$WORK/dump"; then
  say "\$connection_upgrade already defined — reusing it, not adding a second map"
  WRITE_MAP=0
else
  WRITE_MAP=1
fi

# ── 3. The location block to insert ─────────────────────────────────────────
cat >"$WORK/block" <<EOF

    # ── Command Center realtime stream ──────────────────────────────────
    # Added by infra/nginx/install-websocket.sh
    location ${STREAM_PATH} {
        proxy_pass http://${BACKEND};
        include ${SNIPPET};

        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;

        # The default is 60s. A console left open on a quiet night sends
        # nothing for minutes, so at 60s the socket would drop about once a
        # minute and the client would spend its life reconnecting — which reads
        # as "the realtime feature is flaky" and is actually this line.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # Buffering a stream defeats the point of streaming it.
        proxy_buffering off;
    }
EOF

# ── 4. Work out the edit before making it ───────────────────────────────────
set +e
PATCH_MSG="$(python3 "$(dirname "$0")/patch-vhost.py" \
              "$VHOST" "$API_HOST" "$STREAM_PATH" "$WORK/block" "$WORK/patched")"
PATCH_RC=$?
set -e
case "$PATCH_RC" in
  0) say "$PATCH_MSG" ;;
  3) say "$PATCH_MSG"; say "nothing to do."; exit 0 ;;
  *) die "$PATCH_MSG" ;;
esac

if [[ $DRY_RUN -eq 1 ]]; then
  say "--dry-run: this is the change, nothing has been written"
  [[ $WRITE_MAP -eq 1 ]] && echo "  + would create $MAP_FILE (the \$connection_upgrade map)"
  echo "  + would create/overwrite $SNIPPET (shared proxy headers)"
  echo
  diff -u "$VHOST" "$WORK/patched" || true
  exit 0
fi

# ── 5. Apply, validate, and undo the whole thing if it does not hold ────────
BACKUP="/etc/nginx.bak.$(date +%Y%m%d-%H%M%S)"
cp -a /etc/nginx "$BACKUP"
say "backup: $BACKUP"

restore() {
  say "restoring $BACKUP"
  rm -rf /etc/nginx
  cp -a "$BACKUP" /etc/nginx
}

mkdir -p /etc/nginx/snippets /etc/nginx/conf.d

if [[ $WRITE_MAP -eq 1 ]]; then
  cat >"$MAP_FILE" <<'EOF'
# Added by infra/nginx/install-websocket.sh
#
# Makes `Connection` depend on whether the client actually asked to upgrade.
# Hardcoding `proxy_set_header Connection "upgrade"` works for WebSockets and
# quietly breaks every ordinary request through the same location.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
  say "wrote $MAP_FILE"
fi

cat >"$SNIPPET" <<'EOF'
# Added by infra/nginx/install-websocket.sh
#
# X-Forwarded-For matters beyond logging: the API's rate limiters and the
# Security Center's "failed logins from N addresses" read the client IP.
# Without it every request appears to come from the Docker bridge gateway —
# one address, so per-IP limits silently become global limits.
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;

# HTTP/1.1 is required for an Upgrade to be legal at all; nginx proxies with
# 1.0 by default, which silently makes WebSocket impossible.
proxy_http_version 1.1;
EOF
say "wrote $SNIPPET"

cp "$WORK/patched" "$VHOST"
say "patched $VHOST"

if ! nginx -t 2>"$WORK/err"; then
  cat "$WORK/err" >&2
  restore
  die "nginx -t failed — nothing was applied, the config is back as it was"
fi
say "nginx -t passed"

# Reload, not restart: reload keeps existing connections. systemctl is the
# normal path; `nginx -s reload` covers a host without systemd (a container, or
# nginx started by hand) so the script does not fall over at the last step.
if command -v systemctl >/dev/null && systemctl reload nginx 2>/dev/null; then
  say "nginx reloaded (systemctl)"
elif nginx -s reload 2>/dev/null; then
  say "nginx reloaded (nginx -s)"
else
  restore
  die "reload failed — config restored, nothing is applied"
fi

# ── From here the change IS applied ─────────────────────────────────────────
#
# Everything below only LOOKS at the result. Nothing after this point rolls
# back, and that is deliberate: the config is valid and loaded, so undoing it
# because a curl from this box could not resolve DNS would replace a working
# proxy with a broken one for the wrong reason.
say "APPLIED. Revert with:  sudo rm -rf /etc/nginx && sudo mv $BACKUP /etc/nginx && sudo nginx -t && sudo systemctl reload nginx"

# ── Advisory: the vhost's OWN location / ────────────────────────────────────
#
# This script is insert-only, so whatever `location /` already did, it still
# does. Worth saying out loud when that block forwards no client IP: the API's
# rate limiters and the Security Center's "failed logins from N addresses" both
# read it, and without it every request on the platform looks like it came from
# the Docker bridge gateway — one address, so per-IP limits quietly become
# global limits. Not fixed here, because changing how existing traffic is
# proxied is a different change from adding a WebSocket path.
if [[ $VHOST_HAD_XFF -eq 0 ]]; then
  printf '\033[33mNOTE:\033[0m %s\n' \
    "$VHOST sets no X-Forwarded-For outside the block just added." \
    "  Per-IP rate limiting and the Security Center see the proxy's IP, not the client's." \
    "  To fix, add  include ${SNIPPET};  to that vhost's own 'location /' — separate change, test it separately."
fi

# ── 6. Prove it from outside ────────────────────────────────────────────────
#
# 401 is the SUCCESS case: the handshake reached the app and the app refused it
# for having no ticket. A 101 here would mean the app accepted an unauthenticated
# socket, which would be a much worse problem than a missing proxy line.
#
# ── Why this retries ────────────────────────────────────────────────────────
#
# `systemctl reload nginx` returns when the SIGNAL has been sent, not when the
# new workers are serving. The old workers keep handling connections until they
# drain, so a check fired microseconds later can be answered by a worker still
# running the previous config — and report a confident, completely wrong
# diagnosis about a change that was in fact applied correctly.
#
# Seen exactly once, on the first real box this ran against: the config was
# right, `nginx -t` was clean, and the app answered 401 when asked directly, but
# the immediate check came back 404. Retrying settles it.
probe() {
  local code
  # No -k, deliberately. The browser will not open a wss:// to a host whose
  # certificate does not match, and that failure looks exactly like a WebSocket
  # bug — so a check that skipped verification would pass while the feature
  # stayed broken. A 000 here with everything else green is worth reading as
  # "the certificate", not "the proxy".
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    "https://${API_HOST}${STREAM_PATH}" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" 2>/dev/null || true)"
  # curl already writes 000 through -w when it never got a response, and it also
  # exits non-zero — so a `|| echo 000` here appends a SECOND 000 and the case
  # below falls through to "unexpected HTTP 000000". Normalise instead.
  [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
  printf '%s' "$code"
}

say "verifying https://${API_HOST}${STREAM_PATH}"
CODE=000
for attempt in 1 2 3 4; do
  CODE="$(probe)"
  # 401 and 101 are settled answers; anything else may just be a draining worker.
  [[ "$CODE" == 401 || "$CODE" == 101 ]] && break
  [[ $attempt -lt 4 ]] && { say "  got ${CODE}, waiting for the reload to settle…"; sleep 2; }
done

bad() { printf '\033[33mCHECK:\033[0m %s\n' "$*" >&2; exit 1; }

case "$CODE" in
  401) say "HTTP 401 — correct. The proxy carried the handshake and the app refused it for having no ticket."
       say "done. The Command Center badge should read Live on the next page load." ;;
  101) say "HTTP 101 — connected without a ticket. The proxy is fine, but check the app's auth: nothing should upgrade unauthenticated." ;;
  502) bad "HTTP 502 — nginx reached nothing. Is the backend container up on ${BACKEND}? The proxy config is applied and valid." ;;
  404) bad "HTTP 404 — reached the app, wrong path. Is the backend running the Phase 3 build? The proxy config is applied and valid." ;;
  200) bad "HTTP 200 — the FRONTEND answered. ${API_HOST} resolves to the wrong upstream; that is a DNS or vhost problem, not this block." ;;
  000) bad "no response — DNS, firewall or TLS, none of which this script changed. The proxy config is applied and valid; try the curl in README.md from your laptop." ;;
  *)   bad "HTTP ${CODE} — unexpected. The proxy config is applied and valid; run the curl in README.md by hand to see the body." ;;
esac

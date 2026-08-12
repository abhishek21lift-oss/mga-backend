#!/usr/bin/env python3
"""Insert one location block into the right server{} block of an nginx vhost.

Called by install-websocket.sh. Writes the patched file to a scratch path and
prints what it did; it never touches the original.

    patch-vhost.py <vhost> <api_host> <stream_path> <block_file> <out_file>

Exit codes, because the shell branches on them:
    0  patched, result written to <out_file>
    2  could not find a server block to patch — nothing written
    3  already present, nothing to do

── Why this is not a regex ──────────────────────────────────────────────────

A vhost file holds several server{} blocks, and each contains location{} blocks
with their own braces. `server\\s*{(.*?)}` stops at the first inner closing
brace and hands back a fragment; a greedy version swallows every server in the
file. Brace depth is the only thing that actually delimits them.

── Why the 443 check matters ────────────────────────────────────────────────

The api host is named by TWO server blocks: the :80 one that redirects to https
and the :443 one that proxies. They both match on server_name. Patching the
redirect block would put the socket behind a 301 — the handshake would follow it
to https, arrive at the block that has no WebSocket location, and fail in a way
that looks exactly like the proxy never having been configured at all.
"""
import re
import sys


def server_spans(src):
    """(start, end) of every top-level server{...}, by brace depth."""
    spans, depth, start = [], 0, None
    for i, ch in enumerate(src):
        if ch == '{':
            if depth == 0:
                head = src.rfind('server', 0, i)
                # `server` must be the whole token before this brace — otherwise
                # `server_name foo {` or a comment mentioning server matches.
                start = head if head != -1 and src[head:i].strip() == 'server' else None
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and start is not None:
                spans.append((start, i + 1))
                start = None
    return spans


def strip_comments(text):
    """Comments must not satisfy the server_name / listen checks."""
    return re.sub(r'(?m)#.*$', '', text)


def main():
    vhost, api_host, stream_path, block_file, out_file = sys.argv[1:6]
    src = open(vhost).read()
    block = open(block_file).read()

    if f'location {stream_path}' in strip_comments(src):
        print(f'already present in {vhost}')
        return 3

    name_re = re.compile(r'server_name[^;]*\b' + re.escape(api_host) + r'\b')
    listen_re = re.compile(r'listen\s+[^;]*\b443\b')

    target = None
    for s, e in server_spans(src):
        body = strip_comments(src[s:e])
        if name_re.search(body) and listen_re.search(body):
            target = (s, e)
            break

    if target is None:
        print(f'no server block both names {api_host} and listens on 443')
        return 2

    s, e = target
    body = src[s:e]

    # Insert before `location /`. nginx picks the longest literal prefix
    # regardless of order, so this is for the next person reading the file, not
    # for correctness.
    m = re.search(r'\n[ \t]*location\s+/\s*\{', body)
    if m:
        at, where = s + m.start(), 'before location /'
    else:
        at, where = e - 1, 'at the end of the server block'

    open(out_file, 'w').write(src[:at] + '\n' + block.strip('\n') + '\n' + src[at:])
    print(f'will insert {where} of the 443 server for {api_host}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

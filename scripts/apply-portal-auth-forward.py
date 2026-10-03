#!/usr/bin/env python3
"""Let the portal forward the caller's own Authorization header.

The pubserver now requires HTTP Basic auth, so the portal's dashboard path
started returning 401: the proxy dialed the upstream anonymously. A browser that
has already authenticated to an upstream re-sends that header for the same
origin, so the fix is to pass the caller's header through.

The portal never reads, stores, or injects a credential -- it only relays the
header the client already sent, and only to the allowlisted upstream it was
going to contact anyway.
"""
import sys

PATH = '/Users/a/trading/openalice-fleet/office-hud/server/index.js'

EDITS = []


def edit(old, new, label):
    EDITS.append((old, new, label))


edit(
    """function proxyPortal(target, slug, res) {
  const http = require('http');
  const upstream = http.request(
    { host: '127.0.0.1', port: target.entry.port, path: target.targetPath, method: 'GET', timeout: 10000 },""",
    """function proxyPortal(target, slug, res, req) {
  const http = require('http');
  // Relay only the caller's own credentials. The portal holds no secret, so it
  // cannot grant access the caller did not already have.
  const forwarded = {};
  if (req && typeof req.headers.authorization === 'string') {
    forwarded.authorization = req.headers.authorization;
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: target.entry.port, path: target.targetPath, method: 'GET', timeout: 10000, headers: forwarded },""",
    'forward-auth',
)

edit(
    """  return proxyPortal(target, req.params.slug, res);
}""",
    """  return proxyPortal(target, req.params.slug, res, req);
}""",
    'pass-req',
)


def main():
    with open(PATH) as handle:
        source = handle.read()
    for old, new, label in EDITS:
        count = source.count(old)
        if count != 1:
            print(f'FAIL {label}: expected exactly 1 match, found {count}')
            return 1
        source = source.replace(old, new)
    with open(PATH, 'w') as handle:
        handle.write(source)
    print(f'ok: applied {len(EDITS)} edits')
    return 0


if __name__ == '__main__':
    sys.exit(main())

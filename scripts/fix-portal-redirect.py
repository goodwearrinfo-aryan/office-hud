#!/usr/bin/env python3
"""Fix the portal redirect loop.

Express matches routes in registration order and, without strict routing,
`/port/dash/` also matches the bare `/port/:slug` route. That route redirected
to itself, so the service index never resolved. Register the wildcard first and
redirect only when no path segment followed the slug, so deep paths such as
/port/dash/index.html are proxied untouched.
"""
import sys

PATH = '/Users/a/trading/openalice-fleet/office-hud/server/index.js'

OLD = """app.get('/port/:slug', (req, res) => {
  res.redirect(302, `/port/${encodeURIComponent(req.params.slug)}/`);
});

app.head('/port/:slug/*', (req, res) => res.status(405).end());

app.get('/port/:slug/*', (req, res) => {
  if (!isLocalRequest(req)) {
    return sendError(res, 403, 'local_only', 'portal proxy is loopback-only');
  }
  const target = portalTarget(req.params.slug, req.params[0]);
  if (!target) {
    return sendError(res, 404, 'unknown_portal_service', 'No such portal service');
  }
  return proxyPortal(target, req.params.slug, res);
});"""

NEW = """function portalEntry(req, res) {
  // Registered wildcard-first: without strict routing `/port/dash/` also matches
  // `/port/:slug`, and a redirect there would loop onto itself forever.
  if (req.params[0] === undefined) {
    return res.redirect(302, `${req.path}/`);
  }
  if (!isLocalRequest(req)) {
    return sendError(res, 403, 'local_only', 'portal proxy is loopback-only');
  }
  const target = portalTarget(req.params.slug, req.params[0]);
  if (!target) {
    return sendError(res, 404, 'unknown_portal_service', 'No such portal service');
  }
  return proxyPortal(target, req.params.slug, res);
}

app.get('/port/:slug/*', portalEntry);
app.head('/port/:slug/*', (_req, res) => res.status(405).end());
app.get('/port/:slug', portalEntry);"""


def main():
    with open(PATH) as handle:
        source = handle.read()
    count = source.count(OLD)
    if count != 1:
        print(f'FAIL: expected exactly 1 match, found {count}')
        return 1
    with open(PATH, 'w') as handle:
        handle.write(source.replace(OLD, NEW))
    print(f'ok: portal redirect loop fixed in {PATH}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

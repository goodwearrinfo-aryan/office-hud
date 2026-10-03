#!/usr/bin/env python3
"""Merge every local service behind the office-hud port (one port to open).

The HUD already probes a list of ports for the ops floor, but reaching a service
still means knowing its number. This adds a strict allowlist proxy so the console
is the only port anyone opens: /port/<slug>/... fronts the upstream.

Kept as a script so the transformation is reviewable and re-runnable; each
replacement asserts it matched exactly once.
"""
import sys

PATH = '/Users/a/trading/openalice-fleet/office-hud/server/index.js'

EDITS = []


def edit(old, new, label):
    EDITS.append((old, new, label))


# 1. portal allowlist, placed next to the existing SERVICE_PORTS registry so the
#    two lists stay readable side by side.
edit(
    """const SESSION_STALE_MS = 5 * 60 * 1000;""",
    """// Browser-facing services, reachable through this one origin. The request path
// never contributes a host and verbs are restricted to GET/HEAD, so this cannot
// be turned into a general-purpose proxy onto arbitrary local ports.
const PORTAL_SERVICES = new Map([
  ['dash', { port: 3002, label: 'Trading Lab', role: 'dashboards + JSON feeds', browser: true }],
  ['bot', { port: 8765, label: 'Bot API', role: 'paper/testnet state', browser: true }],
  ['ollama', { port: 11434, label: 'Ollama', role: 'local model runtime', browser: true }],
  ['tunnel', { port: 20241, label: 'Cloudflared', role: 'tunnel metrics', browser: false }],
  ['harness', { port: 8080, label: 'Free harness', role: 'OpenAI-compatible API', browser: false }],
]);
const SESSION_STALE_MS = 5 * 60 * 1000;""",
    'portal-allowlist',
)

# 2. proxy implementation + routes, before the static SPA catch-all.
edit(
    """// ---------- static web app ----------""",
    """// ---------- single-port portal ----------

function portalSlugForPort(port) {
  for (const [slug, entry] of PORTAL_SERVICES) {
    if (entry.port === port) return slug;
  }
  return null;
}

// Keep redirects inside this origin so following one never lands the operator
// back on a raw port number.
function rewriteUpstreamLocation(location) {
  const value = String(location || '');
  const match = /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):(\\d+)(\\/[^?#]*)?(\\?[^#]*)?/i.exec(value);
  if (!match) return value;
  const targetPort = Number(match[1]);
  const tail = match[2] || '/';
  const query = match[3] || '';
  const dest = portalSlugForPort(targetPort);
  if (!dest) return value;
  return `/port/${dest}${tail}${query}`;
}

function portalTarget(slug, rest) {
  const entry = PORTAL_SERVICES.get(slug);
  if (!entry) return null;
  const raw = String(rest == null ? '' : rest).replace(/^\\/+/, '');
  if (/[\\r\\n]/.test(raw)) return null;
  // A traversal segment could walk out of the intended upstream path.
  if (raw.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return { entry, targetPath: `/${raw}` };
}

function proxyPortal(target, slug, res) {
  const http = require('http');
  const upstream = http.request(
    { host: '127.0.0.1', port: target.entry.port, path: target.targetPath, method: 'GET', timeout: 10000 },
    (upstreamRes) => {
      const type = String(upstreamRes.headers['content-type'] || '');
      if (type) res.setHeader('Content-Type', type);
      const location = rewriteUpstreamLocation(upstreamRes.headers.location);
      if (location) res.setHeader('Location', location);
      // Dashboards must not be served from cache or a fix would go unnoticed.
      if (type.includes('text/html')) res.setHeader('Cache-Control', 'no-store');
      res.status(upstreamRes.statusCode || 502);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, 502, 'portal_upstream_error',
      `${target.entry.label} (127.0.0.1:${target.entry.port}): ${error.message}`);
  });
  upstream.end();
}

app.get('/port/:slug', (req, res) => {
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
});

app.get('/api/portal', async (_req, res) => {
  const health = await getServiceHealth();
  const byPort = new Map((health.services || []).map((service) => [service.port, service]));
  res.json({
    host: health.host,
    checkedAt: health.checkedAt,
    entryPort: PORT,
    services: [...PORTAL_SERVICES].map(([slug, entry]) => {
      const probe = byPort.get(entry.port);
      return {
        slug,
        ...entry,
        status: probe ? probe.status : 'unknown',
        latencyMs: probe ? probe.latencyMs : null,
        path: `/port/${slug}/`,
      };
    }),
  });
});

// ---------- static web app ----------""",
    'portal-routes',
)

# 3. expose the internals the test suite asserts against.
edit(
    """    isLocalRequest, isIdentifier, requestError, sendError, buildSnapshot,""",
    """    isLocalRequest, isIdentifier, requestError, sendError, buildSnapshot,
    portalTarget, rewriteUpstreamLocation, portalSlugForPort, PORTAL_SERVICES,""",
    'internals',
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
    print(f'ok: applied {len(EDITS)} edits to {PATH}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

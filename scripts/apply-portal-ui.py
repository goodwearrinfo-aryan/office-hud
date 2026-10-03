#!/usr/bin/env python3
"""Surface the single-port portal in the office-hud ops floor.

The SERVICE PORTS table lists every port but gives no way to reach one. This
adds an OPEN column that links through /port/<slug>/ so the console port is the
only port anyone has to open, and a header strip naming that entry port.
"""
import sys

OPS = '/Users/a/trading/openalice-fleet/office-hud/web/src/components/OpsFloor.tsx'
API = '/Users/a/trading/openalice-fleet/office-hud/web/src/api.ts'

EDITS = []


def edit(path, old, new, label):
    EDITS.append((path, old, new, label))


# 1. api.ts — portal payload types alongside the existing ServiceHealth type.
edit(
    API,
    """export interface VerifyState {""",
    """export interface PortalService {
  slug: string;
  port: number;
  label: string;
  role: string;
  browser: boolean;
  status: 'online' | 'offline' | 'unknown';
  latencyMs: number | null;
  path: string;
}

export interface PortalResponse {
  host: string;
  checkedAt: string;
  entryPort: number;
  services: PortalService[];
}

export interface VerifyState {""",
    'portal-types',
)

# 2. OpsFloor — pull the portal alongside the existing health feed.
edit(
    OPS,
    """  const { data: serviceHealth, error: serviceError } = useLive<ServiceHealth>('/api/services/health');""",
    """  const { data: serviceHealth, error: serviceError } = useLive<ServiceHealth>('/api/services/health');
  const { data: portal, error: portalError } = useLive<PortalResponse>('/api/portal');""",
    'portal-hook',
)

# 3. OpsFloor — import the new types.
edit(
    OPS,
    """  type ServiceHealth,
} from '../api';""",
    """  type ServiceHealth,
  type PortalResponse,
} from '../api';""",
    'portal-import',
)

# 4. OpsFloor — header strip naming the one entry port.
edit(
    OPS,
    """          <h3 className="font-mono text-hud-amber text-sm mb-3">SERVICE PORTS</h3>""",
    """          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="font-mono text-hud-amber text-sm">SERVICE PORTS</h3>
            <span className="badge badge-success">
              ONE PORT · {portal?.entryPort ?? '—'} · /port/&lt;service&gt;/
            </span>
          </div>""",
    'portal-header',
)

# 5. OpsFloor — OPEN links through the portal.
edit(
    OPS,
    """              <thead><tr><th>Service</th><th>Port</th><th>Role</th><th>State</th></tr></thead>
              <tbody>
                {services.map(service => (
                  <tr key={service.port}>
                    <td>{service.name}</td>
                    <td className="font-mono">{service.port}</td>
                    <td className="text-hud-dim">{service.role}</td>
                    <td><StatusBadge ok={service.status === 'online'} label={service.status === 'online' ? 'LISTENING' : 'OFFLINE'} /></td>
                  </tr>
                ))}
                {services.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-hud-dim">{serviceError ? 'Service status unavailable' : 'Loading service status…'}</td></tr>}
              </tbody>""",
    """              <thead><tr><th>Service</th><th>Port</th><th>Role</th><th>State</th><th>Open</th></tr></thead>
              <tbody>
                {portal?.services.map(service => (
                  <tr key={service.slug}>
                    <td>{service.label}</td>
                    <td className="font-mono">{service.port}</td>
                    <td className="text-hud-dim">{service.role}</td>
                    <td><StatusBadge ok={service.status === 'online'} label={service.status === 'online' ? 'LISTENING' : 'OFFLINE'} /></td>
                    <td>
                      <a
                        className="badge badge-warning"
                        href={service.path}
                        target="_blank"
                        rel="noreferrer"
                      >
                        OPEN
                      </a>
                    </td>
                  </tr>
                ))}
                {!portal && services.map(service => (
                  <tr key={service.port}>
                    <td>{service.name}</td>
                    <td className="font-mono">{service.port}</td>
                    <td className="text-hud-dim">{service.role}</td>
                    <td><StatusBadge ok={service.status === 'online'} label={service.status === 'online' ? 'LISTENING' : 'OFFLINE'} /></td>
                    <td className="text-hud-dim">—</td>
                  </tr>
                ))}
                {services.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-hud-dim">{serviceError || portalError ? 'Service status unavailable' : 'Loading service status…'}</td></tr>}
              </tbody>""",
    'portal-links',
)


def main():
    with open(OPS) as handle:
        ops_source = handle.read()
    with open(API) as handle:
        api_source = handle.read()
    for path, old, new, label in EDITS:
        source = ops_source if path == OPS else api_source
        count = source.count(old)
        if count != 1:
            print(f'FAIL {label}: expected exactly 1 match, found {count}')
            return 1
        updated = source.replace(old, new)
        if path == OPS:
            ops_source = updated
        else:
            api_source = updated
    with open(OPS, 'w') as handle:
        handle.write(ops_source)
    with open(API, 'w') as handle:
        handle.write(api_source)
    print(f'ok: applied {len(EDITS)} edits')
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Retry a service probe once before declaring it offline.

A single TCP connect that resets or times out is not proof that a service is
down: it also happens when the listener is briefly busy, which made a healthy
dashboard render as OFFLINE in the ops floor and made the two service-health
endpoints disagree with each other. Probing again distinguishes a transient blip
from a service that is genuinely down.

Healthy services still resolve on the first attempt, so the common path costs
nothing.
"""
import sys

PATH = '/Users/a/trading/openalice-fleet/office-hud/server/index.js'

OLD = """function checkServicePort(service) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host: '127.0.0.1', port: service.port });
    let settled = false;
    const finish = (online, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ...service,
        status: online ? 'online' : 'offline',
        latencyMs: Date.now() - startedAt,
        error,
      });
    };"""

NEW = """const SERVICE_PROBE_ATTEMPTS = 2;
const SERVICE_PROBE_RETRY_MS = 150;

function checkServicePort(service, attempt = 0) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host: '127.0.0.1', port: service.port });
    let settled = false;
    const finish = (online, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (!online && attempt + 1 < SERVICE_PROBE_ATTEMPTS) {
        setTimeout(() => {
          checkServicePort(service, attempt + 1).then(resolve);
        }, SERVICE_PROBE_RETRY_MS);
        return;
      }
      resolve({
        ...service,
        status: online ? 'online' : 'offline',
        latencyMs: Date.now() - startedAt,
        error,
        attempts: attempt + 1,
      });
    };"""


def main():
    with open(PATH) as handle:
        source = handle.read()
    count = source.count(OLD)
    if count != 1:
        print(f'FAIL: expected exactly 1 match, found {count}')
        return 1
    with open(PATH, 'w') as handle:
        handle.write(source.replace(OLD, NEW))
    print('ok: service probe now retries once before reporting offline')
    return 0


if __name__ == '__main__':
    sys.exit(main())

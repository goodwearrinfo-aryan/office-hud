#!/bin/bash
# Prepare this checkout so `npm test` means something.
#
# Both of these were mistaken for flaky tests, twice, on two machines:
#
#   1. Dependencies. This is an npm workspaces monorepo (workspaces: [server,
#      web]) and the ROOT package.json has no dependencies of its own. So
#      `npm ci` at the root succeeds, installs almost nothing, and leaves
#      `require('express')` failing inside server/. That surfaced as ~108
#      failures. `npm ci` inside web/ has the mirror problem.
#
#   2. web/dist. The tournament launcher tests assert that GET / injects into
#      the built SPA shell. With no web/dist/index.html there is nothing to
#      inject into, so exactly those two tests fail.
#
# A fresh clone has neither. That combination fails a *variable* number of
# tests depending on what an earlier run happened to leave behind, which reads
# exactly like flakiness. It is not flaky; it is unprepared.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

status=0

if [ ! -d node_modules/express ]; then
  echo "installing workspace dependencies (server + web)..."
  npm install --workspaces --include-workspace-root --silent || status=1
fi
[ -d node_modules/express ] || { echo "FAIL: node_modules/express still missing"; status=1; }

if [ ! -f web/dist/index.html ]; then
  echo "building web/dist (the launcher tests need a built index.html)..."
  ( cd web && npm run build --silent ) || status=1
fi
[ -f web/dist/index.html ] || { echo "FAIL: web/dist/index.html still missing"; status=1; }

if [ "$status" = "0" ]; then
  echo "ready: dependencies installed, web/dist built. 'npm test' is meaningful now."
else
  echo "not ready -- see the failures above"
fi
exit "$status"
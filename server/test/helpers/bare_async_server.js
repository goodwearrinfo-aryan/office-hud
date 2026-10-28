'use strict';
// Runs in its own process, which is the only way to observe what an unwrapped
// async route actually does to the HUD. Two reasons:
//   - node:test claims unhandled rejections as test failures, so the hang it
//     causes in the real server is invisible when the probe shares a process.
//   - the real server installs a unhandledRejection listener in bootstrap(), so
//     a rejection cannot crash it. Reproduced here: this measures a hang, not a
//     crash, which is the failure mode operators never see.
//
// Usage: node bare_async_server.js [bare|wrapped]  -> prints "hung" or "answered:<status>"
const express = require('express');
const { makeFixtureHive, loadServer } = require('./harness');

const mode = process.argv[2] || 'bare';
process.on('unhandledRejection', () => {});

const app = express();
const fail = async () => {
  throw new Error('producer blew up');
};

let cleanup = null;
if (mode === 'wrapped') {
  // The wrapper comes from the real server module, not a local copy, so this
  // probe also fails if asyncRoute ever stops answering.
  const fixture = makeFixtureHive();
  cleanup = fixture.cleanup;
  app.get('/probe', loadServer(fixture.hive).internals.asyncRoute(fail));
} else {
  app.get('/probe', fail);
}

const server = app.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/probe`;
  const outcome = await fetch(url, { signal: AbortSignal.timeout(1500) })
    .then((res) => `answered:${res.status}`, (error) => (
      error && error.name === 'TimeoutError' ? 'hung' : `error:${error && error.name}`
    ));
  console.log(outcome);
  cleanup?.();
  process.exit(0);
});

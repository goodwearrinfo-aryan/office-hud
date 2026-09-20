#!/usr/bin/env node
// office CLI — start the HUD server and open the browser.

const { spawn } = require('child_process');
const { homedir } = require('os');
const { join } = require('path');

const PORT = process.env.PORT || 4747;
const HUD_DIR = join(homedir(), 'openalice-fleet', 'office-hud');
const SERVER = join(HUD_DIR, 'server', 'index.js');

function log(...args) { console.log('[office]', ...args); }

function isServerRunning() {
  return new Promise((resolve) => {
    const child = spawn('lsof', ['-ti', `:${PORT}`]);
    let out = '';
    child.stdout.on('data', (d) => out += d);
    child.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] : null));
  });
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'stop') {
    const pid = await isServerRunning();
    if (pid) {
      process.kill(Number(pid), 'SIGTERM');
      log(`stopped server (pid ${pid})`);
    } else {
      log('server not running');
    }
    return;
  }

  if (cmd === 'status') {
    const pid = await isServerRunning();
    log(pid ? `running (pid ${pid}) on port ${PORT}` : 'stopped');
    return;
  }

  // default: start + open
  const existing = await isServerRunning();
  if (existing) {
    log(`server already running (pid ${existing})`);
  } else {
    log(`starting server on port ${PORT}…`);
    const child = spawn('node', [SERVER], {
      cwd: HUD_DIR,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    // wait for server to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await isServerRunning()) break;
    }
  }

  const url = `http://localhost:${PORT}`;
  log(`opening ${url}`);
  const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(openCmd, [url], { detached: true }).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
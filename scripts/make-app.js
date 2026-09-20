#!/usr/bin/env node
// make-app.js — builds Office HUD.app via osacompile

const { execSync } = require('child_process');
const { homedir } = require('os');
const { join } = require('path');

const HUD_DIR = join(homedir(), 'openalice-fleet', 'office-hud');
const APP_PATH = '/Applications/Office HUD.app';

const applescript = `
do shell script "
  cd ${HUD_DIR}
  PORT=4747
  lsof -ti:$PORT >/dev/null 2>&1 || nohup node server/index.js >/tmp/office-hud.log 2>&1 &
  sleep 1
  open http://localhost:$PORT
"
`;

function main() {
  console.log('[make-app] building Office HUD.app…');
  try {
    execSync(`osacompile -o "${APP_PATH}" -e ${JSON.stringify(applescript)}`, { stdio: 'inherit' });
    console.log('[make-app] installed to', APP_PATH);
    console.log('[make-app] press ⌘Space → type "office" → Enter');
  } catch (e) {
    console.error('[make-app] failed:', e.message);
    process.exit(1);
  }
}

main();
#!/usr/bin/env node
// make-app.js — builds Office HUD.app via osacompile

const { execSync } = require('child_process');
const { writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join, dirname } = require('path');

// Resolve relative to this script rather than homedir(). The fleet does not live
// at ~/openalice-fleet on every machine — on the mini it is ~/trading/openalice-fleet —
// so a homedir() guess bakes one host's layout into an artifact that gets installed
// on another. Same reasoning as bin/office.js.
const HUD_DIR = join(dirname(__filename), '..');
const APP_PATH = '/Applications/Office HUD.app';

// The `on run` wrapper is required: osacompile rejects a bare `do shell script`
// with "A unknown token can't go here", so make:app has been failing outright.
const applescript = `
on run
  do shell script "
    cd ${HUD_DIR}
    PORT=4747
    lsof -ti:$PORT >/dev/null 2>&1 || nohup node server/index.js >/tmp/office-hud.log 2>&1 &
    sleep 1
    open http://localhost:$PORT
  "
end run
`;

function main() {
  console.log('[make-app] building Office HUD.app…');
  // Compile from a temp FILE rather than -e. osacompile -e takes one line, and
  // JSON.stringify turns the script's newlines into the two characters \n, so
  // the compiler sees a single mangled line and reports "A unknown token can't go
  // go here". Writing the script out and passing the path is what actually works.
  const tmp = join(tmpdir(), `office-hud-launcher-${process.pid}.applescript`);
  try {
    writeFileSync(tmp, applescript);
    execSync(`osacompile -o ${JSON.stringify(APP_PATH)} ${JSON.stringify(tmp)}`, { stdio: 'inherit' });
    console.log('[make-app] installed to', APP_PATH);
    console.log('[make-app] press ⌘Space → type "office" → Enter');
  } catch (e) {
    console.error('[make-app] failed:', e.message);
    process.exitCode = 1;
  } finally {
    rmSync(tmp, { force: true });
  }
}

main();
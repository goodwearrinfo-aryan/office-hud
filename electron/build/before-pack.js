/**
 * beforePack: stage the HUD server's runtime dependencies into the app.
 *
 * Why this exists
 * ---------------
 * The HUD server is spawned as a child process by electron/dist/main/server-manager.js,
 * which resolves it at `path.join(__dirname, '..', '..', 'server', 'index.js')`.
 * In a packaged app that is `<app>.app/Contents/Resources/app.asar/server/index.js`,
 * so the server source must live *inside* the asar next to `dist/`.
 *
 * Its dependencies are the awkward part:
 *   - office-hud/server/node_modules is EMPTY. npm hoisted them one level up to
 *     office-hud/node_modules, which is outside the Electron app directory.
 *   - electron-builder's `files` globs are resolved relative to the app dir and
 *     silently ignore patterns that try to escape it (verified: `../server/**`
 *     produced no error and no files). A `from:` object pattern can *read* from
 *     outside, but it cannot be filtered down to a transitive closure.
 *   - We are not allowed to npm-install express/js-yaml/sqlite3 here, so we
 *     cannot simply declare them as dependencies of this package and let
 *     electron-builder's own node_modules resolver do the work.
 *
 * So: compute the closure of server/package.json's dependencies from the hoisted
 * tree and copy exactly those packages into .packstage/node_modules, which the
 * `files` list then picks up into app.asar/node_modules.
 *
 * Computing the closure at pack time (rather than hardcoding ~111 glob patterns in
 * package.json) means a dependency bump in server/package.json is picked up on the
 * next build instead of silently producing an app whose server cannot start.
 *
 * Writes only inside electron/.packstage. Reads ../server and ../node_modules.
 */

const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const OFFICE_HUD_DIR = path.resolve(APP_DIR, '..');
const SERVER_DIR = path.join(OFFICE_HUD_DIR, 'server');
const STAGE_DIR = path.join(APP_DIR, '.packstage');
const STAGE_MODULES = path.join(STAGE_DIR, 'node_modules');

/** Resolve `name` by walking up node_modules the way Node does. */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Transitive closure over `dependencies` (prod only, matching Node resolution). */
function collectClosure(roots) {
  const found = new Map();
  const missing = new Set();
  const queue = [...roots];

  while (queue.length > 0) {
    const name = queue.shift();
    if (found.has(name) || missing.has(name)) continue;

    const dir = resolvePackageDir(name, OFFICE_HUD_DIR);
    if (!dir) {
      missing.add(name);
      continue;
    }
    found.set(name, dir);

    const manifest = readJson(path.join(dir, 'package.json'));
    for (const dep of Object.keys(manifest.dependencies || {})) queue.push(dep);
  }

  return { found, missing };
}

/**
 * Stripped while staging rather than via `files` negation patterns.
 *
 * electron-builder's file matcher (app-builder-lib/out/util/filter.js) walks
 * patterns through a sequential state machine where a `!` pattern is only
 * consulted when the previous pattern already matched, so negation behaviour
 * depends on pattern order. Filtering here is order-independent and keeps the
 * packaged app small: source maps and test fixtures are dead weight at runtime.
 */
const SKIP_DIRS = new Set(['.bin', '.github', 'docs', 'test', 'tests', '__tests__', 'example', 'examples']);

function shouldSkip(src) {
  const parts = src.split(path.sep);
  if (parts.some((part) => SKIP_DIRS.has(part))) return true;
  return parts[parts.length - 1].endsWith('.map');
}

function copyPackage(name, srcDir) {
  const dest = path.join(STAGE_MODULES, name);
  fs.cpSync(srcDir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => !shouldSkip(src),
  });
}

exports.default = async function beforePack(context) {
  const serverManifest = readJson(path.join(SERVER_DIR, 'package.json'));
  const roots = Object.keys(serverManifest.dependencies || {});
  if (roots.length === 0) throw new Error('server/package.json declares no dependencies');

  const { found, missing } = collectClosure(roots);

  // A dep that cannot be resolved locally is not a warning: server/index.js does
  // `require('express')` at top level, so a missing package yields an app that
  // builds cleanly and then shows an error page. Fail the build instead.
  if (missing.size > 0) {
    throw new Error(
      `cannot resolve HUD server dependencies from office-hud/node_modules: ${[...missing].join(', ')}. ` +
        'Install them at office-hud/ (npm install) and re-run the build.'
    );
  }

  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_MODULES, { recursive: true });

  for (const [name, dir] of found) copyPackage(name, dir);

  console.log(`  • beforePack        staged ${found.size} server dependencies into .packstage/node_modules`);
  console.log(`  • beforePack        roots: ${roots.join(', ')} (${context.electronPlatformName}/${context.arch})`);
};

# Office HUD — Electron shell

Native macOS shell (arm64) for the Office HUD.

## The one thing that matters most

**This app bundles no UI.** There is no `file://` bundle and no local HTML asset.

The window loads `http://127.0.0.1:4747`, served by the HUD server. The shell is
only a native frame, a menu, and a tray of process management around that HTTP
endpoint. Everything you actually look at — the floor view, the ledger, the
terminal — comes off the wire at runtime.

Two consequences follow, and they drive every packaging decision below:

1. **If nothing is serving `127.0.0.1:4747`, you get a blank window or an error
   page — not a degraded offline app.** There is nothing to fall back to.
2. **The port may be owned by something else entirely.** On this laptop `:4747`
   is normally an SSH forward to the deployment host. `main/server-manager.ts`
   probes the port *before* spawning anything and attaches to whatever is
   already there. It never stops a server it did not start, and quitting the app
   does not take the fleet's HUD down.

The endpoint is discovered, never assumed. `shared/config.ts` is the single
source of truth for the host, port, and health path (`/api/live/status`).

## Run from source

```sh
cd office-hud/electron
npm install
npm start          # tsc build, then electron dist/main/main.js
```

Other scripts:

| script | what it does |
| --- | --- |
| `npm start` | build + launch from source |
| `npm run build` | `tsc -p tsconfig.json` → `dist/` |
| `npm run build:watch` | same, in watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | build, then `node --test dist/test/*.test.js` |
| `npm run dist` | build, then package `.app` + `.dmg` (arm64) |
| `npm run dist:dir` | unpacked `.app` only — faster, skips DMG |
| `npm run clean` | remove `release/` and `.packstage/` |

## Package

```sh
cd office-hud/electron
npm install        # once
npm run dist       # build + electron-builder --mac --arm64
```

### Where the output lands

| artifact | path |
| --- | --- |
| app bundle | `office-hud/electron/release/mac-arm64/Office HUD.app` |
| disk image | `office-hud/electron/release/Office HUD-0.1.0-arm64.dmg` |
| blockmap | `office-hud/electron/release/Office HUD-0.1.0-arm64.dmg.blockmap` |
| build log | `office-hud/electron/release/builder-debug.yml` |

Everything lands under `release/`, which is gitignored. To try the app without
installing, run the binary directly:

```sh
office-hud/electron/release/mac-arm64/"Office HUD.app"/Contents/MacOS/"Office HUD"
```

The `.app` is also mounted inside the DMG, so drag-to-Applications works as
usual.

### Signing

Ad-hoc only, by design. `"identity": null` disables signing outright and
`hardenedRuntime` is `false`, which is what you want for a locally built app that
is never distributed:

- no Developer ID certificate or provisioning profile needed
- no notarization, no Apple ID credentials in the environment
- no Gatekeeper prompt for a locally built bundle

The trade-off is that the bundle is **not** distributable: copying it to another
Mac will trip Gatekeeper. Do not add a signing identity without also adding
notarization — a signed-but-unnotarized app fails on other machines *later* and
more confusingly than an unsigned one does now.

## What is inside the .app

Only four things, in `Contents/Resources/app.asar`:

| path | contents |
| --- | --- |
| `dist/` | compiled `main/`, `preload/`, `shared/` — **no** `test/`, **no** `.map` |
| `server/` | the HUD server: `index.js`, `package.json`, `lib/` — **no** `test/` |
| `node_modules/` | the server's dependency closure, staged by `build/before-pack.js` |
| `package.json` | Electron entry metadata |

Deliberately **not** bundled:

- **`~/openalice-fleet/hive`** — the hive stays where it is. The server reads it
  through its own `OFFICE_HUD_HIVE` env var at runtime; the app never copies it.
- `office-hud/web/` — the HUD server serves the built UI itself.
- `office-hud/scripts/` — including the retired `make-app.js` and
  `launcher.applescript`. Packaging has no dependency on either; they are left
  in place, unreferenced.

### Why the server must sit at `app.asar/server/`

This is not a free choice. `main/server-manager.ts` resolves the server it
spawns as:

```js
path.join(__dirname, '..', '..', 'server', 'index.js')
```

In a packaged app `__dirname` is `app.asar/dist/main`, so that expression
resolves to `app.asar/server/index.js`. The server therefore has to live *inside*
the asar as a sibling of `dist/`. It cannot be moved to `Contents/Resources/` via
`extraResources`, which is the usual home for bundled assets, without editing
that source file. `asarUnpack` is set for `**/*.node` only, so sqlite3's native
binding unpacks to `app.asar.unpacked/` and still loads.

### Why `build/before-pack.js` exists

The HUD server's dependencies are not where you would expect:

- `office-hud/server/node_modules` is **empty** — npm hoisted them one level up
  to `office-hud/node_modules`, outside this package.
- electron-builder's `files` globs resolve relative to the app directory and
  **silently ignore** patterns that try to escape it. A plain `"../server/**"`
  entry produces no error and no files. This was verified, not assumed.
- We cannot `npm install express js-yaml sqlite3` here, so declaring them as
  dependencies here and letting electron-builder resolve them is not an option.

So `build/before-pack.js` resolves the transitive closure of
`server/package.json`'s dependencies out of the hoisted tree and copies exactly
those packages into `.packstage/node_modules`, which `files` then places at
`app.asar/node_modules`. It stages 111 packages as of this writing.

Two deliberate choices in that hook:

- **The closure is computed at pack time** rather than hardcoded as ~111 glob
  patterns in `package.json`, so bumping a dependency in `server/package.json`
  cannot silently produce an app whose server cannot start.
- **An unresolvable dependency fails the build.** `server/index.js` does
  `require('express')` at the top level, so a missing package yields an app that
  builds cleanly and then shows an error page. Better to stop at pack time with a
  message naming the missing package.

Source maps, test directories, `.bin` stubs, and docs are dropped during staging
rather than by `files` negation patterns. electron-builder's file matcher
(`app-builder-lib/out/util/filter.js`) evaluates patterns through a sequential
state machine where a `!` pattern is only consulted when the previous pattern
already matched — so negation behaviour depends on pattern order. Filtering in
the hook is order-independent.

## Is `dist/` ignored?

Yes, and that is deliberate.

`dist/` is `tsc` output derived from the committed `main/`, `preload/`,
`shared/`, and `test/` TypeScript sources. It is regenerated by `npm run build`,
and `npm run dist` runs that build before packaging — so ignoring it cannot lose
anything, and it keeps compiled JavaScript out of history.

It is worth knowing that this was **already** the effective behaviour before this
package existed: `office-hud/.gitignore` contains a bare `dist/` rule, which
matches at any depth, so it already covered `office-hud/electron/dist/`.
Confirmed:

```sh
$ git check-ignore -v office-hud/electron/dist/main/main.js
office-hud/.gitignore:5:dist/    office-hud/electron/dist/main/main.js
```

The rule is repeated in this package's `.gitignore` so that `office-hud/electron`
stays correct as a self-contained unit if it is ever moved out from under the
parent ignore file. The parent file was not modified.

## Adding a dependency to the server

1. Add it to `office-hud/server/package.json`.
2. `npm install` at `office-hud/` so it lands in the hoisted tree.
3. `npm run dist` in `office-hud/electron`.

The staging hook picks it up automatically. If step 2 is skipped, the build fails
with the missing package named — it does not produce a broken app.

## Verified

Checked on this machine (macOS arm64, Electron 33.4.11, electron-builder
26.15.3):

- `npm run dist` exits 0 and produces the `.app` and the `.dmg`.
- The asar contains `dist/`, `server/`, `node_modules/` (111 packages),
  `package.json` — and zero `.map` files, zero `dist/test`, zero `server/test`.
- `express` 4.22.3 and `js-yaml` 4.3.2 resolve from inside the packaged asar via
  `createRequire('<app>.asar/server/index.js')`.
- `sqlite3` 6.0.1 resolves *and loads* under Electron's ABI 130
  (`VERSION = 3.52.0`). It is N-API based, so the binding is ABI-stable and the
  Node-ABI-127 build in the hoisted tree needed no rebuild.
- The `.dmg` is a valid UDIF image; `Info.plist` carries
  `com.goodwearr.office-hud`; `icon.icns` is embedded.
- No `hive` path is referenced anywhere in the bundle.

Not verified: the GUI was never launched end-to-end, and the DMG was never
mounted and run from `/Applications`. Both were avoided deliberately — a cold
launch probes `:4747` and, if the SSH forward is down, would spawn a server and
bind the fleet's HUD port.

# Office HUD — Electron launch checklist

Display-dependent behaviour cannot run in CI, so this is the verification. Run it
once after `npm run dist`, and again after any change to the shell.

## Status: the GUI gate has been performed and passed

The shell was launched on a display-capable host against a spare port (4799), so
the fleet's `:4747` forward was never touched. Verified over the Chrome DevTools
Protocol against the live DOM:

| check | result |
|---|---|
| preload bridge | `document.documentElement.dataset.native === '1'` |
| titlebar drag region | present (`hud-topbar` marked `-webkit-app-region: drag`) |
| native title strip | rendered `Office HUD` / `Local hive (app-spawned)` |
| connection state | `hud-connection is-live` |
| hive reported | `~/openalice-fleet/hive` |
| floors rendered | 64 elements |
| WebSocket | 11 resources subscribed, sequence advancing |
| attach/own | `ownership: owned`, local server bound, released on quit |

**The launch found a bug no test could.** `process.execPath` inside Electron is
the Electron binary, not node, so the spawned HUD server never started: the shell
sat on its failure page for the full 15s timeout. An end-to-end check had passed
because it ran under plain node, where `execPath` really is node. Fixed with
`ELECTRON_RUN_AS_NODE` and re-verified end to end.

Sections below remain the regression gate for future changes; C (WiFi-off) was
performed in the run above.

## Setup

```sh
cd office-hud/electron
npm install
npm run dist
open "release/mac-arm64/Office HUD.app"
```

## A. Cold start, server already up (the normal case)

`:4747` is held by the SSH forward to the mini.

- [ ] Dock icon appears; window opens within ~2s.
- [ ] Amber "Starting…" page appears first, then the HUD renders.
- [ ] Floor 5 is selected (the app's default).
- [ ] Floor switches live over the WebSocket: Cmd+1..Cmd+0, then Cmd+- Cmd+= Cmd+Backspace Cmd+. Cmd+, all change floor.
- [ ] `?` opens help; `Esc` closes it.
- [ ] Cmd+K opens the command palette (must NOT be swallowed by the menu).
- [ ] Cmd+T toggles dark/light (must NOT be swallowed by the menu).
- [ ] Window has no dead strip: the top bar drags the window, and its buttons still click.

## B. Attach ownership — the rule that matters

- [ ] Quit the app (Cmd+Q).
- [ ] `lsof -nP -iTCP:4747 -sTCP:LISTEN` still shows the `ssh` forward. **The app must not kill a server it did not start.**
- [ ] Relaunch; it attaches again.

## C. WiFi off — the app must serve the HUD itself

This is the case the whole attach-or-spawn design exists for.

- [ ] Turn WiFi off, or `pkill -f 'ssh.*4747'` to drop just the forward.
- [ ] Wait for the keepalive to fail to restore it, then launch the app.
- [ ] It reports it is starting the server, then the HUD renders **from the local hive**.
- [ ] The hive label reads as the app-spawned local hive, not the deployment host's.
- [ ] Cmd+Q quits and the port is released (`lsof` shows nothing on 4747).
- [ ] Relaunch with WiFi still off: it spawns again and renders.
- [ ] Restore WiFi. The forward comes back; a server may already hold the port — the app must attach, not double-bind.

## D. Failure and recovery

- [ ] With the port dead and the local server unable to start, the amber page shows the **real** server output, not just "exited during startup".
- [ ] The **Retry** button works (it uses `ipcRenderer.send`, so it must not be a dead `ipcMain.handle`).
- [ ] Bring the server back while the window is open: the HUD reloads by itself.

## E. Window state

- [ ] Resize and move, then Cmd+Q and relaunch: bounds are restored.
- [ ] Resize then immediately quit (<250ms): the final size is still restored (close flushes, it does not cancel).
- [ ] Maximize, quit, relaunch: still maximized.
- [ ] Quit, then move the saved window off-screen externally and relaunch: it comes back on-screen.

## F. Single instance and deep links

- [ ] Launch twice quickly: the second launch focuses the first; no second window, no port race.
- [ ] `open "officehud://floor/f3"` with the app **closed**: opens on floor 3.
- [ ] `open "officehud://floor/f3"` with the app **already open**: navigates to floor 3 (warm path, no reload).
- [ ] `open "officehud://agent/<id>"`: opens that agent's drawer.

## G. Chrome hygiene

- [ ] Cmd+` / Cmd+W behave normally.
- [ ] View menu shows all 15 floors with the right shortcuts.
- [ ] "Open in Browser" points at the same port the shell attached to.
- [ ] A link to an external site opens in the default browser, not inside the app.

## H. Regression guard

- [ ] `cd office-hud && npm test` — 322 pass / 5 fail, the 5 being the queue/truthfulness/redaction tests owned by another session.
- [ ] `cd office-hud/electron && npm test` — 11 pass, and **the runner exits** (a leaked timer here previously hung it forever).
- [ ] `cd office-hud/web && npx tsc --noEmit` — clean.
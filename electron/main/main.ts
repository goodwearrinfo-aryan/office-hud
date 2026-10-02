import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { ServerManager, type ServerStatus } from './server-manager';
import { buildMenu, registerAsDefaultProtocolClient } from './menu';
import { applyInitialState, initialBounds, persistBounds } from './window-state';
import { APP_NAME, HUD_ORIGIN, PROTOCOL } from '../shared/config';

/**
 * The HUD is served over HTTP by server/index.js, so the window loads a real
 * origin rather than a file:// bundle. That keeps one implementation of the app:
 * the same build runs in a browser and here, and the WebSocket, SSE and fetch
 * paths are identical. The cost is that we must wait for a healthy server before
 * the first paint, which is what the loading window below exists for.
 */
const server = new ServerManager();
let window: BrowserWindow | null = null;
let pendingDeepLink: string | null = null;

/**
 * True only for the HUD's own origin.
 *
 * A string prefix test is not an origin test: `http://127.0.0.1:4747@evil/`
 * starts with our origin and would load inside the app chrome.
 */
function isInternal(url: string): boolean {
  try {
    return new URL(url).origin === HUD_ORIGIN;
  } catch {
    return false;
  }
}

function loadingHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0e14;color:#e6e9ef;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
  body{display:flex;align-items:center;justify-content:center}
  .wrap{text-align:center;max-width:520px;padding:24px}
  .dot{width:10px;height:10px;border-radius:50%;background:#f5a623;margin:0 auto 18px;
    animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
  h1{font-size:15px;font-weight:600;margin:0 0 8px;letter-spacing:.01em}
  p{color:#8b93a7;margin:0}
  button{margin-top:16px;background:#f5a623;color:#0b0e14;border:0;border-radius:6px;
    padding:8px 16px;font-weight:600;cursor:pointer}
</style></head><body><div class="wrap">
  <div class="dot"></div><h1>${APP_NAME}</h1><p>${message}</p>
  <div id="retry"></div></div>
<script>
  // The shell posts the terminal failure here; only then offer a retry, so a
  // slow start does not look like a broken app.
  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type !== 'hud:server-failed') return;
    document.querySelector('p').textContent = data.detail || 'The HUD server is not responding.';
    document.getElementById('retry').innerHTML = '<button id="b">Retry</button>';
    document.getElementById('b').onclick = () => window.officeHud.retry();
  });
</script></body></html>`;
}

function showLoading(message: string): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml(message))}`);
}

/** Load the HUD, then flush any deep link that arrived while we were starting. */
async function loadHud(): Promise<void> {
  if (!window || window.isDestroyed()) return;
  try {
    await window.loadURL(HUD_ORIGIN);
  } catch {
    // loadHud surfaces its own failures through the loading page.
    return;
  }
  if (pendingDeepLink && window && !window.isDestroyed()) {
    window.webContents.send('hud:deep-link', pendingDeepLink);
    pendingDeepLink = null;
  }
}

/** Re-enter the HUD after the server came back, preserving a pending deep link. */
async function reloadHud(): Promise<void> {
  if (!window || window.isDestroyed()) return;
  if (window.webContents.getURL() === HUD_ORIGIN) return;
  await loadHud();
}

/** Deliver a deep link to an already-loaded HUD without reloading the page. */
function dispatchDeepLink(url: string): void {
  if (!window || window.isDestroyed()) return;
  pendingDeepLink = null;
  if (window.webContents.getURL() === HUD_ORIGIN) {
    window.webContents.send('hud:deep-link', url);
  } else {
    pendingDeepLink = url;
  }
}

function createWindow(): void {
  const bounds = initialBounds();
  window = new BrowserWindow({
    ...bounds,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#0b0e14',
    // hiddenInset lets the HUD's own dark chrome run under the traffic lights.
    // The web layer adds a drag region only when it detects the native shell,
    // so the browser build is unchanged.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  persistBounds(window);
  applyInitialState(window, bounds);

  // Paint the loading page immediately. The window is created hidden, and
  // ready-to-show needs a painted frame, so waiting for ensureLive() first
  // leaves the app looking like it failed to launch for up to ~19s.
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml('Starting…'))}`);
  window.once('ready-to-show', () => { window?.show(); });
  window.on('closed', () => {
    window = null;
    server.off('status', onServerStatus);
    server.off('recovered', onRecovered);
  });

  // External links open in the user's browser, never inside the shell.
  const openExternally = (url: string): void => {
    if (!isInternal(url)) void shell.openExternal(url);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return;
    event.preventDefault();
    openExternally(url);
  });

  /** Bound once so it can be detached when the window closes. */
  const onServerStatus = (status: ServerStatus): void => {
    if (!window || window.isDestroyed()) return;
    if (status.state === 'failed') {
      // The listener lives in the document that is loading right now, so send
      // only once it is actually the loading page.
      if (window.webContents.getURL().startsWith('data:')) {
        window.webContents.send('hud:server-failed', { detail: status.detail });
      } else {
        void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml(status.detail))}`)
          .then(() => { window?.webContents.send('hud:server-failed', { detail: status.detail }); })
          .catch(() => { /* the window is going away; nothing to report into */ });
      }
    }
    };
  server.on('status', onServerStatus);
  // The manager emits a separate 'recovered' event when a lost server returns.
  const onRecovered = (): void => { void reloadHud(); };
  server.on('recovered', onRecovered);
}

function focusOrCreate(): void {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
    return;
  }
  createWindow();
}

function handleDeepLinkFrom(argv: string[]): void {
  const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (link) pendingDeepLink = link;
}

// A second launch must focus the first, never race it for the port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    focusOrCreate();
    // A warm activation must still route; queueing it would fire it later
    // against an unrelated page load.
    if (link) dispatchDeepLink(link);
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    focusOrCreate();
    dispatchDeepLink(url);
  });

  app.whenReady().then(async () => {
    registerAsDefaultProtocolClient();
    Menu.setApplicationMenu(buildMenu());
    // The preload uses ipcRenderer.send (fire-and-forget), so the handler must be
    // ipcMain.on. An ipcMain.handle on the same channel is a different registry
    // and would silently never fire, leaving Retry inert.
    ipcMain.on('hud:retry', () => {
      void server.ensureLive()
        .then(() => loadHud())
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          if (window && !window.isDestroyed()) {
            void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml(detail))}`);
          }
        });
    });
    handleDeepLinkFrom(process.argv);
    createWindow();

    try {
      await server.ensureLive();
      await loadHud();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showLoading(detail);
      if (window && !window.isDestroyed()) window.webContents.send('hud:server-failed', { detail });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) focusOrCreate();
    });
  });

  app.on('window-all-closed', () => {
    // On macOS closing the last window does not quit, so before-quit never
    // fires and the health interval plus any self-spawned server would be
    // orphaned with no owner. Shut down explicitly on that path.
    void server.shutdown();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // Only ever stops a server we spawned; an attached launchd server survives.
    void server.shutdown();
  });
}
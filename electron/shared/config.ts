/**
 * Single source of truth for everything the shell and the HUD server must agree
 * on. The server reads PORT/HOST/OFFICE_HUD_HIVE from its own environment, so
 * these values are what we hand it when we are the ones who spawn it.
 *
 * The endpoint is discovered, never assumed: the shell attaches to whatever is
 * already serving on this port, whether that is a launchd job, a manually
 * started process, or an SSH forward to the deployment host. Nothing here
 * encodes which machine owns the port.
 */

/**
 * Port the HUD server listens on. Matches server/index.js's own default.
 *
 * Validated, because an inherited PORT aimed at something else would otherwise
 * yield `http://127.0.0.1:NaN`, the probe could never succeed, and the failure
 * would look identical to a dead server.
 */
function readPort(): number {
  const raw = process.env.OFFICE_HUD_PORT || process.env.PORT;
  if (!raw) return 4747;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Office HUD: PORT must be an integer 1-65535, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export const HUD_PORT = readPort();

/** Loopback only. server/index.js refuses to bind anywhere else. */
export const HUD_HOST = '127.0.0.1';

export const HUD_ORIGIN = `http://${HUD_HOST}:${HUD_PORT}`;

/**
 * The HUD server's own health surface. A 200 here means something is serving
 * the app; the body is not trusted because another process may hold the port.
 */
export const HUD_HEALTH_PATH = '/api/live/status';

/**
 * Labelled distinctly when we spawn the server ourselves, so the UI can say the
 * hive it is reading is local rather than the deployment host's. This is the env
 * var server/index.js reads as OFFICE_HUD_LABEL.
 */
export const OWNED_HIVE_LABEL = 'Local hive (app-spawned)';

export const WINDOW_STATE_FILE = `${process.env.HOME}/Library/Application Support/office-hud/window-state.json`;

export const DEFAULT_WINDOW = { width: 1560, height: 980, minWidth: 1100, minHeight: 720 };

/** Single-instance identity: a second launch focuses this window instead. */
export const APP_ID = 'com.goodwearr.office-hud';

export const APP_NAME = 'Office HUD';

/** Deep links: officehud://floor/f5 and officehud://agent/<id>. */
export const PROTOCOL = 'officehud';
import { BrowserWindow, screen } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_WINDOW, WINDOW_STATE_FILE } from '../shared/config';

/**
 * Window bounds that survive a restart.
 *
 * Writes are debounced because 'resize' and 'move' fire continuously during a
 * drag, and a synchronous write per event would put the main thread on the
 * disk on every frame of the gesture.
 */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULTS: WindowState = { ...DEFAULT_WINDOW, maximized: false };

let writeTimer: NodeJS.Timeout | null = null;
/** Last bounds seen, so a write never has to re-read the file. */
let pending: WindowState | null = null;

function read(): WindowState {
  try {
    const parsed = JSON.parse(readFileSync(WINDOW_STATE_FILE, 'utf8')) as Partial<WindowState>;
    return {
      ...DEFAULTS,
      ...parsed,
      width: typeof parsed.width === 'number' && parsed.width >= DEFAULT_WINDOW.minWidth ? parsed.width : DEFAULTS.width,
      height: typeof parsed.height === 'number' && parsed.height >= DEFAULT_WINDOW.minHeight ? parsed.height : DEFAULTS.height,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(state: WindowState): void {
  pending = state;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 250);
  writeTimer.unref?.();
}

/** Persist immediately. Used on close, where the debounce would never fire. */
function flush(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const state = pending;
  if (!state) return;
  try {
    mkdirSync(dirname(WINDOW_STATE_FILE), { recursive: true });
    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // A failed bounds write must never take the app down.
  }
}

export function persistBounds(window: BrowserWindow): void {
  const save = (): void => {
    if (window.isDestroyed()) return;
    const maximized = window.isMaximized();
    // Bounds read while maximized describe the full screen, not the restored
    // window, so keep the last normal-state rectangle.
    if (!maximized) {
      write({ ...window.getNormalBounds(), maximized: false });
    } else {
      // Reuse the in-memory bounds: write() has just cancelled the pending
      // debounce, so reading the file back would lose the resize that led here.
      write({ ...(pending ?? read()), maximized: true });
    }
  };
  window.on('resize', save);
  window.on('move', save);
  window.on('maximize', save);
  window.on('unmaximize', save);
  // Flush, do not cancel: the quit gesture is exactly the resize that would
  // otherwise be dropped.
  window.on('close', flush);
}

export function initialBounds(): WindowState {
  const state = read();
  if (state.maximized) return { ...state, maximized: true };
  // Drop a saved position that would land the window off-screen.
  if (state.x !== undefined && state.y !== undefined) {
    const visible = screen.getAllDisplays().some((display) => {
      const b = display.workArea;
      return state.x! < b.x + b.width && state.x! + state.width > b.x
        && state.y! < b.y + b.height && state.y! + state.height > b.y;
    });
    if (!visible) return { ...state, x: undefined, y: undefined };
  }
  return state;
}

export function applyInitialState(window: BrowserWindow, state: WindowState): void {
  if (state.maximized) window.maximize();
}
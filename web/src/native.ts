/**
 * Native-shell bridge.
 *
 * The HUD is one build that runs in a browser and inside the Electron shell.
 * Everything here is a no-op in a browser, so nothing in the app may depend on
 * it for correctness — it only enables the shell's chrome and forwards the
 * shell's menu commands to the same state the keyboard already drives.
 */

export interface NativeHud {
  isNative: true;
  platform: string;
  retry: () => void;
  onCommand: (handler: (command: string, payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    officeHud?: NativeHud;
  }
}

/** True only inside the Electron shell. */
export const isNative = (): boolean =>
  typeof window !== 'undefined' && window.officeHud?.isNative === true;

/**
 * Mark the document as native before first paint so CSS can add the titlebar
 * drag region without a flash of an undraggable bar.
 */
export function markNative(): boolean {
  if (!isNative()) return false;
  document.documentElement.dataset.native = '1';
  return true;
}

/** Subscribe to shell-initiated commands. Returns an unsubscribe function. */
export function onShellCommand(
  handler: (command: string, payload: unknown) => void,
): () => void {
  if (!isNative()) return () => {};
  return window.officeHud!.onCommand(handler);
}

/** Ask the shell to retry after a terminal server failure. */
export function retryServer(): void {
  window.officeHud?.retry();
}

/**
 * Apply a deep link of the form officehud://floor/f5 or officehud://agent/<id>.
 * Returns what it handled, so the caller can decide whether to also open a drawer.
 */
export function parseDeepLink(url: string): { floor?: string; agentId?: string } | null {
  if (!url.startsWith('officehud://')) return null;
  const rest = url.slice('officehud://'.length).replace(/^\/+/, '');
  const [kind, value] = rest.split('/');
  if (!kind || !value) return null;
  if (kind === 'floor') return { floor: value };
  if (kind === 'agent') return { agentId: decodeURIComponent(value) };
  return null;
}
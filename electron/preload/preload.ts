import { contextBridge, ipcRenderer } from 'electron';

/**
 * The whole native surface the HUD can see.
 *
 * Deliberately minimal: the app is the same build that runs in a browser, so
 * nothing here may become load-bearing for rendering. It only reports that a
 * native shell is present (which enables the titlebar drag region) and forwards
 * shell-initiated navigation. There is no filesystem, shell or arbitrary-IPC
 * access on purpose.
 */
const api = {
  /** True inside the Electron shell; the web layer gates chrome on this. */
  isNative: true,

  platform: process.platform,

  /** Ask the shell to retry bringing the server up after a terminal failure. */
  retry: (): void => { ipcRenderer.send('hud:retry'); },

  /** Shell-initiated navigation: floors, palette, theme, deep links. */
  onCommand: (handler: (command: string, payload: unknown) => void): (() => void) => {
    const channels = ['hud:navigate', 'hud:focus-floor', 'hud:command-palette', 'hud:toggle-theme', 'hud:help', 'hud:deep-link', 'hud:restart-server'];
    const listeners = channels.map((channel) => {
      const listener = (_event: unknown, payload: unknown): void => {
        handler(channel.replace('hud:', ''), payload);
      };
      ipcRenderer.on(channel, listener);
      return () => { ipcRenderer.removeListener(channel, listener); };
    });
    return () => { for (const off of listeners) off(); };
  },
};

contextBridge.exposeInMainWorld('officeHud', api);

export type OfficeHudApi = typeof api;
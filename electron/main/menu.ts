import { app, Menu, BrowserWindow, shell, type MenuItemConstructorOptions } from 'electron';
import { APP_NAME, HUD_ORIGIN, PROTOCOL } from '../shared/config';

/**
 * Mirrors web/src/App.tsx's keyboard map so the menu and the in-app keys agree:
 * digits 1-9 and 0, then -, =, Backspace, ., and a final unassigned floor.
 */
const FLOOR_KEYS: ReadonlyArray<{ accelerator: string; floor: string }> = [
  { accelerator: 'CmdOrCtrl+1', floor: 'f1' },
  { accelerator: 'CmdOrCtrl+2', floor: 'f2' },
  { accelerator: 'CmdOrCtrl+3', floor: 'f3' },
  { accelerator: 'CmdOrCtrl+4', floor: 'f4' },
  { accelerator: 'CmdOrCtrl+5', floor: 'f5' },
  { accelerator: 'CmdOrCtrl+6', floor: 'f6' },
  { accelerator: 'CmdOrCtrl+7', floor: 'f7' },
  { accelerator: 'CmdOrCtrl+8', floor: 'f8' },
  { accelerator: 'CmdOrCtrl+9', floor: 'f9' },
  { accelerator: 'CmdOrCtrl+0', floor: 'f10' },
  { accelerator: 'CmdOrCtrl+-', floor: 'f11' },
  { accelerator: 'CmdOrCtrl+=', floor: 'f12' },
  { accelerator: 'CmdOrCtrl+Backspace', floor: 'f13' },
  { accelerator: 'CmdOrCtrl+.', floor: 'f14' },
  { accelerator: 'CmdOrCtrl+,', floor: 'f15' },
];

/** The SPA owns floor state; the menu only asks it to navigate. */
function send(channel: string, payload?: unknown): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

export function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const floorItems: MenuItemConstructorOptions[] = FLOOR_KEYS.map(({ accelerator, floor }) => ({
    label: `Floor ${floor.slice(1)}`,
    accelerator,
    click: () => { send('hud:navigate', { floor }); },
  }));

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open HUD', accelerator: 'CmdOrCtrl+O', click: () => { send('hud:focus-floor', { floor: 'f5' }); } },
        { type: 'separator' },
        { label: 'Restart HUD Server', click: () => { send('hud:restart-server'); } },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...floorItems,
        { type: 'separator' },
        // Cmd+K and Cmd+Shift+T are deliberately NOT native accelerators: the
        // renderer already implements them, and a native accelerator is
        // consumed before the page sees the keydown, which would break the
        // browser build's own shortcuts. The menu items below are reachable
        // by mouse and forward the same intent over the bridge.
        { label: 'Command Palette', click: () => { send('hud:command-palette'); } },
        { label: 'Toggle Dark / Light', click: () => { send('hud:toggle-theme'); } },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'HUD Help', click: () => { send('hud:help'); } },
        {
          label: 'Open in Browser',
          click: () => { void shell.openExternal(HUD_ORIGIN); },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function registerAsDefaultProtocolClient(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}
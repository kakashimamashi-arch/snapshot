'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  desktopCapturer,
  screen,
  clipboard,
  nativeImage,
  dialog,
  Tray,
  Menu,
  systemPreferences,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

const isMac = process.platform === 'darwin';

// Pre-warmed overlay windows, one per display id, reused across captures.
const overlays = new Map(); // String(display.id) -> BrowserWindow
let settingsWin = null;
let tray = null;
let capturing = false;
let registeredShortcut = null;

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+X';
let config = { shortcut: DEFAULT_SHORTCUT, openAtLogin: false };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch (_) {}
}
function saveConfig() {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('saveConfig failed:', e);
  }
}
function applyShortcut() {
  if (registeredShortcut) {
    globalShortcut.unregister(registeredShortcut);
    registeredShortcut = null;
  }
  let ok = false;
  try {
    ok = globalShortcut.register(config.shortcut, captureAndShow);
  } catch (_) {
    ok = false;
  }
  if (ok) registeredShortcut = config.shortcut;
  return ok;
}
function applyLoginItem() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!config.openAtLogin });
  } catch (e) {
    console.error('setLoginItemSettings failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Overlay window pool
// ---------------------------------------------------------------------------
function createOverlayWindow(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    hasShadow: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win._loaded = false;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on('did-finish-load', () => {
    win._loaded = true;
  });
  win.loadFile(path.join(__dirname, 'overlay.html'));
  return win;
}

function ensureOverlays() {
  const displays = screen.getAllDisplays();
  const ids = new Set(displays.map((d) => String(d.id)));
  for (const [id, win] of [...overlays.entries()]) {
    if (!ids.has(id) || win.isDestroyed()) {
      if (!win.isDestroyed()) win.destroy();
      overlays.delete(id);
    }
  }
  for (const d of displays) {
    const id = String(d.id);
    if (!overlays.has(id) || overlays.get(id).isDestroyed()) {
      overlays.set(id, createOverlayWindow(d));
    }
  }
}

function sendInit(win, payload) {
  if (win._loaded) {
    win.webContents.send('init-capture', payload);
  } else {
    win.webContents.once('did-finish-load', () => win.webContents.send('init-capture', payload));
  }
}

function hideOverlays() {
  unregisterOverlayShortcuts();
  activeOverlay = null;
  for (const [, win] of overlays) {
    if (!win.isDestroyed()) {
      win.webContents.send('overlay:reset');
      if (win.isVisible()) win.hide();
    }
  }
}

// Show an overlay and give its web page keyboard focus. Called only AFTER the
// screenshot is painted (on 'overlay:ready'), so we never capture the overlay
// itself. Taking the foreground makes Ctrl+C / Esc work and lets Windows treat
// the full-monitor window as a fullscreen app (auto-hiding the taskbar).
let activeOverlay = null;
function showAndFocus(win) {
  if (!win.isVisible()) win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  win.focus();
  win.webContents.focus();
  if (isMac) app.focus({ steal: true });
  activeOverlay = win;
  registerOverlayShortcuts();
}

// While the overlay is open, drive the critical actions with SYSTEM-WIDE
// shortcuts. These fire regardless of whether the window managed to grab
// keyboard focus (a background/tray app can't always take the foreground on
// Windows), so Ctrl+C reliably copies + closes. Removed as soon as it hides.
let overlayShortcutsOn = false;
const OVERLAY_KEYS = {
  'CommandOrControl+C': 'copy',
  'CommandOrControl+S': 'save',
  'CommandOrControl+Z': 'undo',
  Escape: 'close',
};
function routeAction(action) {
  let win =
    activeOverlay && !activeOverlay.isDestroyed() && activeOverlay.isVisible()
      ? activeOverlay
      : null;
  if (!win) {
    for (const [, w] of overlays) {
      if (!w.isDestroyed() && w.isVisible()) { win = w; break; }
    }
  }
  if (win) win.webContents.send('overlay:action', action);
}
function registerOverlayShortcuts() {
  if (overlayShortcutsOn) return;
  overlayShortcutsOn = true;
  for (const [accel, action] of Object.entries(OVERLAY_KEYS)) {
    try {
      globalShortcut.register(accel, () => routeAction(action));
    } catch (_) {}
  }
}
function unregisterOverlayShortcuts() {
  if (!overlayShortcutsOn) return;
  overlayShortcutsOn = false;
  for (const accel of Object.keys(OVERLAY_KEYS)) {
    try {
      globalShortcut.unregister(accel);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Capture — capture FIRST (overlays still hidden), then paint, then show.
// ---------------------------------------------------------------------------
function promptScreenRecordingPermission() {
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Відкрити Системні параметри', 'Скасувати'],
    defaultId: 0,
    title: 'Snapshot потребує доступу до запису екрана',
    message: 'macOS блокує захоплення екрана.',
    detail:
      'Перейдіть у Системні параметри → Конфіденційність і безпека → Запис екрана та увімкніть Snapshot ' +
      '(може відображатися як «Terminal», «Electron» або «Snapshot» — залежно від способу запуску), потім повністю закрийте й відкрийте застосунок знову.',
  });
  if (choice === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
}

// desktopCapturer.getSources() can transiently fail right after a macOS
// permission change (TCC cache not yet refreshed for this process) even when
// getMediaAccessStatus() already reports 'granted'. Retry briefly before
// surfacing an error.
async function getSourcesWithRetry(opts, attempts = 3, delayMs = 350) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await desktopCapturer.getSources(opts);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function captureAndShow() {
  if (capturing) return;
  capturing = true;
  try {
    if (isMac) {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status !== 'granted') {
        promptScreenRecordingPermission();
        return;
      }
    }

    ensureOverlays();
    const displays = screen.getAllDisplays();

    for (const display of displays) {
      const win = overlays.get(String(display.id));
      if (!win || win.isDestroyed()) continue;

      const width = Math.round(display.size.width * display.scaleFactor);
      const height = Math.round(display.size.height * display.scaleFactor);
      const sources = await getSourcesWithRetry({
        types: ['screen'],
        thumbnailSize: { width, height },
      });

      let source = sources.find((s) => String(s.display_id) === String(display.id));
      if (!source) {
        const idx = displays.indexOf(display);
        source = sources[idx] || sources[0];
      }
      if (!source) continue;

      win.setBounds(display.bounds);
      sendInit(win, {
        dataURL: source.thumbnail.toDataURL(),
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
      });
    }
  } catch (err) {
    console.error('Capture failed:', err);
    const msg = (err && (err.message || err.toString())) || 'Невідома помилка (див. логи в терміналі).';
    // "Failed to get sources." is what macOS gives us when Screen Recording
    // access isn't actually working for this process, even if
    // getMediaAccessStatus() claims it's granted.
    if (isMac && (msg.includes('Failed to get sources') || systemPreferences.getMediaAccessStatus('screen') !== 'granted')) {
      promptScreenRecordingPermission();
    } else {
      dialog.showErrorBox('Snapshot', 'Не вдалося зробити скріншот: ' + msg);
    }
  } finally {
    capturing = false;
  }
}

// ---------------------------------------------------------------------------
// IPC — overlay
// ---------------------------------------------------------------------------
ipcMain.on('overlay:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) showAndFocus(win);
});

ipcMain.on('overlay:close', hideOverlays);

// Renderer reports which overlay the user is interacting with (multi-monitor),
// so system-wide Ctrl+C/S/Z route to the right screen.
ipcMain.on('overlay:activate', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) activeOverlay = win;
});

ipcMain.on('overlay:copy', (event, dataURL) => {
  try {
    clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
  } catch (err) {
    console.error('Copy failed:', err);
  }
  hideOverlays();
});

ipcMain.handle('overlay:save', async (event, dataURL) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defaultName = `Snapshot ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Зберегти скріншот',
    defaultPath: path.join(app.getPath('pictures'), defaultName),
    filters: [{ name: 'Зображення PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { saved: false };

  const base64 = dataURL.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  hideOverlays();
  return { saved: true, filePath };
});

// ---------------------------------------------------------------------------
// IPC — settings
// ---------------------------------------------------------------------------
ipcMain.handle('settings:get', () => config);

ipcMain.handle('settings:save', (event, next) => {
  const prevShortcut = config.shortcut;
  config = {
    ...config,
    shortcut: (next && next.shortcut) || config.shortcut,
    openAtLogin: !!(next && next.openAtLogin),
  };
  let ok = true;
  if (config.shortcut !== prevShortcut) {
    ok = applyShortcut();
    if (!ok) {
      config.shortcut = prevShortcut;
      applyShortcut();
    }
  }
  applyLoginItem();
  saveConfig();
  buildTrayMenu();
  return { ok, config };
});

ipcMain.on('settings:close', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 352,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Snapshot — Налаштування',
    autoHideMenuBar: true,
    backgroundColor: '#0b1120',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isMac && app.dock) app.dock.show();
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.webContents.once('did-finish-load', () => {
    settingsWin.webContents.send('settings:init', config);
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (isMac && app.dock) app.dock.hide();
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function prettyShortcut(accel) {
  if (isMac) {
    return accel
      .replace('CommandOrControl', '⌘')
      .replace('Command', '⌘')
      .replace('Control', '⌃')
      .replace('Alt', '⌥')
      .replace('Shift', '⇧')
      .replace(/\+/g, '');
  }
  return accel.replace('CommandOrControl', 'Ctrl');
}

function buildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Snapshot', enabled: false },
    { type: 'separator' },
    {
      label: 'Зробити скріншот',
      accelerator: config.shortcut,
      click: () => captureAndShow(),
    },
    { type: 'separator' },
    {
      label: 'Запуск при вході',
      type: 'checkbox',
      checked: !!config.openAtLogin,
      click: (item) => {
        config.openAtLogin = item.checked;
        applyLoginItem();
        saveConfig();
      },
    },
    { label: 'Змінити комбінацію…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Вийти зі Snapshot', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('Snapshot · ' + prettyShortcut(config.shortcut) + ' — зробити скріншот');
}

function createTray() {
  try {
    let icon;
    if (isMac) {
      // Monochrome template image: adapts to light/dark menu bar automatically.
      icon = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
      if (!icon.isEmpty()) icon.setTemplateImage(true);
    } else {
      icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    }
    tray = new Tray(icon && !icon.isEmpty() ? icon : nativeImage.createEmpty());
  } catch (e) {
    return;
  }
  tray.on('click', () => captureAndShow());
  buildTrayMenu();
}

// ---------------------------------------------------------------------------
// Single-instance lock — a leftover tray instance would keep the global
// shortcut and make a new launch silently fail to register it.
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => captureAndShow());

  app.whenReady().then(() => {
    loadConfig();
    if (isMac && app.dock) app.dock.hide();

    createTray();
    // Note: we do NOT call applyLoginItem() here on every startup. The login
    // item state persists on its own; re-applying it unconditionally on an
    // unsigned/dev build has been observed to abort the whole process on
    // recent macOS ("Operation not permitted", platform_util_mac.mm). It's
    // only ever applied when the user actually toggles the setting.
    if (!applyShortcut()) console.warn('Failed to register global shortcut', config.shortcut);

    ensureOverlays(); // pre-warm so the first capture is quicker

    const resync = () => ensureOverlays();
    screen.on('display-added', resync);
    screen.on('display-removed', resync);
    screen.on('display-metrics-changed', resync);

    app.on('activate', () => captureAndShow());
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    // Background utility — stay alive in the tray.
  });
}

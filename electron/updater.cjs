// Automatic updates for the desktop app, from the GitHub releases of ryanbarnal/tala-pdf.
//
// Windows (and the Linux AppImage): new versions download in the background and install on
// restart, or the next time the app quits.
// macOS: Apple only lets signed apps replace themselves, and these builds are not signed yet, so
// the app checks for new versions and offers a Download button that opens the release page.
const { app, shell, ipcMain } = require('electron');

const RELEASES = 'https://github.com/ryanbarnal/tala-pdf/releases/latest';
const FIRST_CHECK_MS = 8 * 1000;
const EVERY_MS = 4 * 60 * 60 * 1000;

function setupUpdates(getWindow) {
  const send = (state) => getWindow()?.webContents.send('update', state);
  const testFeed = process.env.TALA_UPDATE_FEED; // used by the tests: a local "generic" update server
  if (!app.isPackaged && !testFeed) {
    ipcMain.handle('update-check', () => ({ state: 'unavailable', reason: 'Updates work in the installed app only.' }));
    ipcMain.handle('update-install', () => false);
    ipcMain.handle('update-download-page', () => shell.openExternal(RELEASES));
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn('updater unavailable', e);
    return;
  }
  const canInstall = process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE);
  autoUpdater.autoDownload = canInstall;
  autoUpdater.autoInstallOnAppQuit = canInstall;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  if (testFeed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed });
  }

  let last = { state: 'idle' };
  let manual = false; // a check the person asked for, which should report "up to date" too
  const emit = (s) => {
    last = s;
    send(s);
  };

  autoUpdater.on('checking-for-update', () => manual && emit({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => emit({ state: canInstall ? 'downloading' : 'available', version: info.version, percent: 0, canInstall }));
  autoUpdater.on('update-not-available', (info) => {
    if (manual) emit({ state: 'none', version: info?.version || app.getVersion() });
    else last = { state: 'idle' };
    manual = false;
  });
  autoUpdater.on('download-progress', (p) => emit({ ...last, state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info.version, canInstall }));
  autoUpdater.on('error', (err) => {
    // Background checks fail quietly (offline, GitHub unreachable); a check the person asked for says why.
    if (manual) emit({ state: 'error', message: friendly(err) });
    manual = false;
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, EVERY_MS).unref?.();

  ipcMain.handle('update-check', async () => {
    if (last.state === 'downloading' || last.state === 'ready' || last.state === 'available') return last;
    manual = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      manual = false;
      return { state: 'error', message: friendly(err) };
    }
    return last;
  });
  ipcMain.handle('update-install', () => {
    if (last.state !== 'ready' || !canInstall) return false;
    // Closing the window first lets the app ask about unsaved changes as usual.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });
  ipcMain.handle('update-download-page', () => shell.openExternal(RELEASES));
  ipcMain.handle('update-state', () => last);
}

function friendly(err) {
  const m = String(err?.message || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR|EAI_AGAIN|getaddrinfo/i.test(m)) return 'Could not reach GitHub. Check your internet connection and try again.';
  if (/404|latest.*\.yml/i.test(m)) return 'No published release was found yet.';
  return 'The update check did not work. Try again later.';
}

module.exports = { setupUpdates };

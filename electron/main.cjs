const { app, BrowserWindow, dialog, ipcMain, protocol, net, Menu, shell, session } = require('electron');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const isMac = process.platform === 'darwin';

let win = null;
let rendererReady = false;
let dirty = false;
const pending = []; // files to open once the window is ready
const allowed = new Set(); // paths the user picked; the only ones the page may read or write

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

const pdfArgs = (argv) => argv.filter((a) => /\.pdf$/i.test(a) && !a.startsWith('-'));

async function readEntry(p) {
  const bytes = new Uint8Array(await fs.readFile(p));
  const isPdf = /\.pdf$/i.test(p);
  if (isPdf) {
    allowed.add(p);
    app.addRecentDocument(p);
  }
  // Only PDFs are saved back in place; other files are converted into a new, unsaved PDF.
  return { name: path.basename(p), bytes, ref: isPdf ? p : null };
}

/**
 * Turn converted HTML (from Word, Excel, PowerPoint or text files) into a PDF with Chromium's own
 * PDF printer, so text stays real, selectable text. Runs in a hidden window with scripts disabled
 * and no network access.
 */
async function htmlToPdf(html) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tala-convert-'));
  const file = path.join(dir, 'doc.html');
  await fs.writeFile(file, html, 'utf8');
  const ses = session.fromPartition('tala-convert');
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(file|data|blob):/.test(details.url) }));
  const w = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, sandbox: true, session: ses, contextIsolation: true },
  });
  try {
    await w.loadFile(file);
    return new Uint8Array(await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }));
  } finally {
    w.destroy();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sendFile(p) {
  if (!win || !rendererReady) return void pending.push(p);
  try {
    win.webContents.send('open-file', await readEntry(p));
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch (e) {
    dialog.showErrorBox('Could not open file', `${p}\n\n${e.message}`);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 480,
    backgroundColor: '#1b2338',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('app://tala/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://tala/')) e.preventDefault();
  });
  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Keep working', 'Close anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'Some documents have unsaved changes.',
      detail: 'If you close now, the changes are kept as a recovery copy and offered again the next time you start the app.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    for (const p of pdfArgs(argv.slice(1))) sendFile(path.resolve(p));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  // macOS delivers "Open with" and dropped-on-dock files here, possibly before the app is ready.
  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (app.isReady() && !win) createWindow();
    sendFile(p);
  });

  app.whenReady().then(() => {
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.on('ready', () => {
      rendererReady = true;
      for (const p of pending.splice(0)) sendFile(p);
    });
    ipcMain.on('set-dirty', (_e, v) => {
      dirty = !!v;
      if (isMac && win) win.setDocumentEdited(dirty);
    });
    ipcMain.on('allow-path', (_e, p) => {
      if (typeof p === 'string' && /\.pdf$/i.test(p)) allowed.add(p);
    });
    ipcMain.handle('open-dialog', async (_e, multiple, exts) => {
      const extensions = Array.isArray(exts) && exts.length ? exts.filter((x) => /^[a-z0-9]{1,5}$/i.test(x)) : ['pdf'];
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
        filters: [{ name: extensions.length > 1 ? 'Supported files' : 'PDF documents', extensions }],
      });
      if (res.canceled) return [];
      return Promise.all(res.filePaths.map(readEntry));
    });
    ipcMain.handle('html-to-pdf', async (_e, html) => {
      if (typeof html !== 'string') throw new Error('Nothing to convert.');
      return htmlToPdf(html);
    });
    ipcMain.handle('read', async (_e, p) => {
      // Reopening a recent file: only PDFs, and only by a path this app saved earlier.
      if (typeof p !== 'string' || !/\.pdf$/i.test(p)) throw new Error('Not a PDF file.');
      return readEntry(p);
    });
    ipcMain.handle('write', async (_e, p, bytes) => {
      if (!allowed.has(p)) throw new Error('This file was not opened from the app.');
      await fs.writeFile(p, bytes);
      return true;
    });
    ipcMain.handle('save-as', async (_e, name, bytes) => {
      const ext = path.extname(name).slice(1) || 'pdf';
      const res = await dialog.showSaveDialog(win, {
        defaultPath: name,
        filters: [{ name: ext.toUpperCase() + ' file', extensions: [ext] }],
      });
      if (res.canceled || !res.filePath) return null;
      await fs.writeFile(res.filePath, bytes);
      allowed.add(res.filePath);
      return { path: res.filePath, name: path.basename(res.filePath) };
    });

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(isMac ? [{ role: 'appMenu' }] : []),
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
        },
        { role: 'windowMenu' },
      ]),
    );

    for (const p of pdfArgs(process.argv.slice(1))) pending.push(path.resolve(p));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}

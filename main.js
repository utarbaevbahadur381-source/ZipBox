'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const A = require('./archive');

let win = null;
let session = null; // { file, target, tmpDir, openDir, canModify }

const ARCHIVE_EXT = ['zip', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz'];

const handle = (channel, fn) =>
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  });

const progress = (v) => {
  if (win && !win.isDestroyed()) win.webContents.send('progress', v);
};

function dropSession(s) {
  if (!s) return;
  for (const d of [s.tmpDir, s.openDir]) {
    if (d) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

function need() {
  if (!session) throw new Error('Сначала откройте архив.');
  return session;
}

// ---------- архив ----------
handle('arc:open', async (file, password) => {
  let target = file;
  let tmpDir = null;
  let info = await A.list(file, password);
  const type = (info.type || '').toLowerCase();
  let canModify = ['zip', '7z', 'tar'].includes(type);
  // .tar.gz / .tgz / .tar.bz2 / .tar.xz: сначала достаём внутренний tar
  if (['gzip', 'bzip2', 'xz'].includes(type) && info.entries.length === 1 && /\.tar$/i.test(info.entries[0].name)) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipbox-'));
    await A.extract(file, tmpDir, null, password, progress);
    target = path.join(tmpDir, info.entries[0].name);
    info = await A.list(target, null);
    canModify = false;
  }
  const old = session;
  session = { file, target, tmpDir, openDir: null, canModify };
  dropSession(old);
  return {
    name: path.basename(file),
    path: file,
    type: info.type,
    entries: info.entries,
    canModify,
    needsPassword: info.entries.some((e) => e.encrypted),
  };
});

handle('arc:extract', async ({ names, dest, password }) => A.extract(need().target, dest, names, password, progress));

handle('arc:openEntry', async ({ name, password }) => {
  const s = need();
  if (!s.openDir) s.openDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipbox-open-'));
  await A.extract(s.target, s.openDir, [name], password, progress);
  const full = path.join(s.openDir, ...name.split('/').filter(Boolean));
  const err = await shell.openPath(full);
  if (err) throw new Error(err);
  return {};
});

handle('arc:create', async ({ items, out, fmt, level, password }) => A.create(out, items, { fmt, level, password }, progress));
handle('arc:add', async ({ items, prefix, password }) => {
  const s = need();
  if (!s.canModify) throw new Error('В этот архив нельзя добавлять файлы.');
  return A.add(s.target, items, prefix, password, progress);
});
handle('arc:remove', async ({ names, password }) => {
  const s = need();
  if (!s.canModify) throw new Error('Из этого архива нельзя удалять файлы.');
  return A.remove(s.target, names, password);
});
handle('arc:test', async ({ password }) => A.test(need().target, password, progress));

// ---------- диалоги ----------
ipcMain.handle('dlg:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Открыть архив',
    properties: ['openFile'],
    filters: [
      { name: 'Архивы', extensions: ARCHIVE_EXT },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dlg:dir', async (_e, def) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Куда распаковать?',
    defaultPath: def,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dlg:files', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Выберите файлы', properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dlg:folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Выберите папку', properties: ['openDirectory'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dlg:save', async (_e, def, fmt) => {
  const names = { zip: 'ZIP-архив', '7z': '7Z-архив', tar: 'TAR-архив' };
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить архив',
    defaultPath: def + '.' + fmt,
    filters: [{ name: names[fmt] || 'Архив', extensions: [fmt] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath.toLowerCase().endsWith('.' + fmt) ? r.filePath : r.filePath + '.' + fmt;
});
ipcMain.handle('shell:reveal', (_e, p) => shell.openPath(p));

// ---------- окно ----------
function argvFile(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args.find((a) => {
    try {
      return !a.startsWith('-') && fs.statSync(a).isFile();
    } catch (_) {
      return false;
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 760,
    minHeight: 460,
    title: 'ZipBox',
    backgroundColor: '#17161f',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    const f = argvFile(process.argv);
    if (f) win.webContents.send('open-path', f);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = argvFile(argv);
    if (f) win.webContents.send('open-path', f);
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('quit', () => dropSession(session));
}

'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');
const ARCH_EXT = /\.(zip|7z|tar|gz|tgz|bz2|tbz2|xz|txz)$/i;

function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
}

const ICON_DIR = '<svg class="ico" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_FILE = '<svg class="ico f" viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>';

// ------------------------------------------------------------ состояние
const S = { arc: null, entries: [], cwd: '', sel: new Set(), rows: [], anchor: -1, sort: { key: 'name', dir: 1 }, pw: null, busy: false };

// ------------------------------------------------------------ интерфейс-помощники
function setStatus(t) { $('#status').textContent = t; }

function setProgress(v) {
  const bar = $('#bar');
  if (v == null) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.firstElementChild.style.width = v + '%';
}
zb.onProgress(setProgress);

let toastTimer;
function toast(text, actionText, action) {
  const t = $('#toast');
  t.innerHTML = '<span>' + esc(text) + '</span>';
  if (actionText) {
    const a = document.createElement('a');
    a.textContent = actionText;
    a.onclick = () => { t.classList.add('hidden'); action(); };
    t.appendChild(a);
  }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 6000);
}

function showModal(title, el, buttons) {
  return new Promise((resolve) => {
    const ov = $('#overlay');
    const m = $('#modal');
    m.innerHTML = '<h2>' + esc(title) + '</h2>';
    m.appendChild(el);
    const row = document.createElement('div');
    row.className = 'btns';
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        const p = buttons.find((b) => b.primary);
        if (p) close(p.value);
      }
    };
    const close = (v) => {
      document.removeEventListener('keydown', onKey, true);
      ov.classList.add('hidden');
      resolve(v);
    };
    buttons.forEach((b) => {
      const x = document.createElement('button');
      x.textContent = b.text;
      if (b.primary) x.className = 'primary';
      x.onclick = () => close(b.value);
      row.appendChild(x);
    });
    m.appendChild(row);
    document.addEventListener('keydown', onKey, true);
    ov.classList.remove('hidden');
    const first = m.querySelector('input,select');
    if (first) first.focus();
  });
}

function textEl(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}
const alertBox = (text) => showModal('ZipBox', textEl(text), [{ text: 'OK', primary: true, value: true }]);
async function confirmBox(text, okText) {
  return (await showModal('ZipBox', textEl(text), [{ text: okText || 'OK', primary: true, value: true }, { text: 'Отмена', value: false }])) === true;
}
async function askPassword() {
  const el = document.createElement('div');
  el.innerHTML = '<p>Архив защищён паролем.</p><input class="full" type="password" placeholder="Пароль">';
  const v = await showModal('Введите пароль', el, [{ text: 'OK', primary: true, value: 'ok' }, { text: 'Отмена', value: null }]);
  return v === 'ok' ? el.querySelector('input').value : null;
}

function showMenu(x, y, items) {
  const m = $('#ctx');
  m.innerHTML = '';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.textContent = it.text;
    if (it.danger) b.className = 'danger';
    b.onclick = () => { hideMenu(); it.fn(); };
    m.appendChild(b);
  });
  m.classList.remove('hidden');
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, innerWidth - w - 6) + 'px';
  m.style.top = Math.min(y, innerHeight - h - 6) + 'px';
}
function hideMenu() { $('#ctx').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) hideMenu(); });

// выполнение задачи с индикатором
async function run(label, fn) {
  if (S.busy) return null;
  S.busy = true;
  document.body.classList.add('busy');
  setStatus(label);
  setProgress(0);
  let r;
  try { r = await fn(); } finally {
    S.busy = false;
    document.body.classList.remove('busy');
    setProgress(null);
  }
  if (!r.ok) {
    setStatus('Ошибка');
    if (r.code === 'PASSWORD') { S.pw = null; await alertBox('Неверный пароль.'); } else await alertBox(r.error);
    return null;
  }
  setStatus('Готово');
  return r.data || {};
}

// ------------------------------------------------------------ открытие архива
async function openFile(p, pw = null) {
  if (S.busy) return;
  const r = await zb.open(p, pw);
  if (!r.ok) {
    if (r.code === 'PASSWORD') {
      const v = await askPassword();
      if (v == null) return;
      return openFile(p, v);
    }
    return alertBox(r.error);
  }
  S.arc = r.data;
  S.entries = r.data.entries;
  S.cwd = '';
  S.sel.clear();
  S.pw = pw;
  render();
}

async function reload() {
  const cwd = S.cwd;
  const r = await zb.open(S.arc.path, S.pw);
  if (!r.ok) { S.arc = null; render(); return alertBox(r.error); }
  S.arc = r.data;
  S.entries = r.data.entries;
  S.cwd = S.entries.some((e) => e.name.startsWith(cwd)) ? cwd : '';
  S.sel.clear();
  render();
}

// ------------------------------------------------------------ отображение
function visibleRows() {
  const folders = new Map();
  const files = [];
  for (const e of S.entries) {
    if (!e.name.startsWith(S.cwd)) continue;
    const rel = e.name.slice(S.cwd.length);
    if (!rel) continue;
    const t = rel.replace(/\/$/, '');
    if (t.includes('/')) {
      const f = t.split('/')[0];
      if (!folders.has(f)) folders.set(f, { name: f, isDir: true, full: S.cwd + f + '/' });
    } else if (e.isDir) {
      folders.set(t, { name: t, isDir: true, full: S.cwd + t + '/', modified: e.modified });
    } else {
      files.push({ name: t, isDir: false, full: e.name, size: e.size, packed: e.packed, modified: e.modified, enc: e.encrypted });
    }
  }
  const { key, dir } = S.sort;
  const val = (r) => (key === 'type' ? (r.isDir ? '' : (r.name.split('.').pop() || '').toLowerCase()) : key === 'name' ? r.name.toLowerCase() : r[key]);
  const cmp = (a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  };
  const f1 = [...folders.values()].sort(cmp);
  const f2 = files.sort(cmp);
  return [...f1, ...f2];
}

function render() {
  const has = !!S.arc;
  $('#empty').classList.toggle('hidden', has);
  $('#tablewrap').classList.toggle('hidden', !has);
  document.querySelectorAll('[data-needs]').forEach((b) => {
    b.disabled = !(has && (b.dataset.needs !== 'modify' || S.arc.canModify));
  });
  document.title = has ? S.arc.name + ' — ZipBox' : 'ZipBox';
  if (!has) { $('#crumbs').innerHTML = ''; setStatus('Готово'); return; }
  renderCrumbs();
  renderRows();
}

function renderCrumbs() {
  const c = $('#crumbs');
  c.innerHTML = '';
  const parts = S.cwd.split('/').filter(Boolean);
  const add = (text, cwd, last) => {
    if (c.childNodes.length) c.appendChild(document.createTextNode(' › '));
    const a = document.createElement(last ? 'span' : 'a');
    a.textContent = text;
    if (last) a.className = 'cur'; else a.onclick = () => { S.cwd = cwd; S.sel.clear(); render(); };
    c.appendChild(a);
  };
  add(S.arc.name, '', !parts.length);
  parts.forEach((p, i) => add(p, parts.slice(0, i + 1).join('/') + '/', i === parts.length - 1));
}

function renderRows() {
  S.rows = visibleRows();
  const tb = $('#rows');
  let html = '';
  if (S.cwd) html += '<tr class="row dir" data-up="1"><td>' + ICON_DIR + '..</td><td></td><td></td><td></td><td></td></tr>';
  S.rows.forEach((r, i) => {
    const ext = r.isDir ? 'Папка' : (r.name.includes('.') ? r.name.split('.').pop().toUpperCase() : 'Файл');
    html += '<tr class="row' + (r.isDir ? ' dir' : '') + (S.sel.has(r.full) ? ' sel' : '') + '" data-i="' + i + '">' +
      '<td title="' + esc(r.name) + '">' + (r.isDir ? ICON_DIR : ICON_FILE) + esc(r.name) + (r.enc ? '<span class="lock">пароль</span>' : '') + '</td>' +
      '<td class="c-num">' + fmtSize(r.size) + '</td><td class="c-num">' + fmtSize(r.packed) + '</td>' +
      '<td>' + esc(r.modified || '') + '</td><td>' + esc(ext) + '</td></tr>';
  });
  tb.innerHTML = html;
  document.querySelectorAll('th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.k === S.sort.key);
    th.classList.toggle('desc', th.dataset.k === S.sort.key && S.sort.dir < 0);
  });
  updateStatus();
}

function updateStatus() {
  const files = S.entries.filter((e) => !e.isDir);
  const total = files.reduce((a, e) => a + (e.size || 0), 0);
  let t = 'Файлов: ' + files.length + ', размер: ' + fmtSize(total);
  if (S.sel.size) t += '   |   Выбрано: ' + S.sel.size;
  setStatus(t);
}

// ------------------------------------------------------------ выделение и клики
function rowFromEvent(e) {
  const tr = e.target.closest('tr.row');
  if (!tr) return null;
  if (tr.dataset.up) return { up: true };
  return { r: S.rows[+tr.dataset.i], i: +tr.dataset.i };
}

$('#rows').addEventListener('click', (e) => {
  const x = rowFromEvent(e);
  if (!x || x.up) { if (!x) { S.sel.clear(); renderRows(); } return; }
  if (e.shiftKey && S.anchor >= 0) {
    const [a, b] = [Math.min(S.anchor, x.i), Math.max(S.anchor, x.i)];
    S.sel.clear();
    for (let i = a; i <= b; i++) S.sel.add(S.rows[i].full);
  } else if (e.ctrlKey || e.metaKey) {
    S.sel.has(x.r.full) ? S.sel.delete(x.r.full) : S.sel.add(x.r.full);
    S.anchor = x.i;
  } else {
    S.sel.clear();
    S.sel.add(x.r.full);
    S.anchor = x.i;
  }
  renderRows();
});

$('#rows').addEventListener('dblclick', (e) => {
  const x = rowFromEvent(e);
  if (!x) return;
  if (x.up) return goUp();
  openRow(x.r);
});

$('#rows').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const x = rowFromEvent(e);
  if (x && !x.up && !S.sel.has(x.r.full)) { S.sel.clear(); S.sel.add(x.r.full); renderRows(); }
  const items = [];
  if (S.sel.size === 1) items.push({ text: 'Открыть', fn: () => openRow(S.rows.find((r) => S.sel.has(r.full))) });
  items.push({ text: S.sel.size ? 'Распаковать выбранное…' : 'Распаковать всё…', fn: doExtract });
  if (S.arc.canModify && S.sel.size) items.push({ text: 'Удалить из архива', danger: true, fn: doDelete });
  showMenu(e.clientX, e.clientY, items);
});

document.querySelectorAll('th').forEach((th) =>
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : 1 };
    renderRows();
  })
);

function goUp() {
  const p = S.cwd.replace(/\/$/, '').split('/');
  p.pop();
  S.cwd = p.length ? p.join('/') + '/' : '';
  S.sel.clear();
  render();
}

function openRow(r) {
  if (!r) return;
  if (r.isDir) { S.cwd = r.full; S.sel.clear(); render(); } else doOpenEntry(r.full);
}

document.addEventListener('keydown', (e) => {
  if (!$('#overlay').classList.contains('hidden')) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); doOpen(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); doCreate(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'e') { e.preventDefault(); doExtract(); }
  else if (!S.arc) return;
  else if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); S.rows.forEach((r) => S.sel.add(r.full)); renderRows(); }
  else if (e.key === 'Enter' && S.sel.size === 1) openRow(S.rows.find((r) => S.sel.has(r.full)));
  else if (e.key === 'Backspace') goUp();
  else if (e.key === 'Delete' && S.arc.canModify) doDelete();
});

// ------------------------------------------------------------ действия
function expandSel() {
  const keys = [...S.sel];
  const out = [];
  for (const e of S.entries) {
    if (keys.some((k) => e.name === k || (k.endsWith('/') && e.name.startsWith(k)))) out.push(e.name);
  }
  return out;
}

async function ensurePw() {
  if (S.arc.needsPassword && S.pw == null) {
    const v = await askPassword();
    if (v == null) return false;
    S.pw = v;
  }
  return true;
}

async function doOpen() {
  const p = await zb.dlgOpen();
  if (p) openFile(p);
}

async function doExtract() {
  if (!S.arc) return;
  const names = S.sel.size ? expandSel() : null;
  if (S.sel.size && !names.length) return;
  if (!(await ensurePw())) return;
  const dest = await zb.dlgDir(dirName(S.arc.path));
  if (!dest) return;
  const r = await run('Распаковка…', () => zb.extract({ names, dest, password: S.pw }));
  if (r) {
    if (r.warning) toast(r.warning, 'Показать папку', () => zb.reveal(dest));
    else toast('Распаковано', 'Показать папку', () => zb.reveal(dest));
  }
}

async function doOpenEntry(name) {
  if (!(await ensurePw())) return;
  await run('Открытие файла…', () => zb.openEntry({ name, password: S.pw }));
}

async function doAdd(kind) {
  const items = kind === 'files' ? await zb.dlgFiles() : await zb.dlgFolder();
  if (items.length) addItems(items);
}

async function addItems(items) {
  const r = await run('Добавление…', () => zb.add({ items, prefix: S.cwd, password: S.pw }));
  if (r) { await reload(); toast('Добавлено в архив'); }
}

async function doDelete() {
  if (!S.arc || !S.arc.canModify || !S.sel.size) {
    if (S.arc && S.arc.canModify) toast('Выберите файлы для удаления');
    return;
  }
  if (!(await confirmBox('Удалить выбранное из архива? Это нельзя отменить.', 'Удалить'))) return;
  if (!(await ensurePw())) return;
  const r = await run('Удаление…', () => zb.remove({ names: expandSel(), password: S.pw }));
  if (r) { await reload(); toast('Удалено из архива'); }
}

async function doTest() {
  if (!(await ensurePw())) return;
  const r = await run('Проверка…', () => zb.test({ password: S.pw }));
  if (r) await alertBox(r.ok ? 'Ошибок не найдено. Архив в порядке.' : 'Архив повреждён:\n' + r.message);
}

async function doCreate(initial = []) {
  const items = [...initial];
  const el = document.createElement('div');
  el.innerHTML =
    '<div class="list"></div>' +
    '<div class="row"><button data-a="files">+ Файлы</button><button data-a="folder">+ Папка</button></div>' +
    '<label>Формат <select id="c-fmt"><option value="zip">ZIP (подходит везде)</option><option value="7z">7Z (сжимает лучше)</option><option value="tar">TAR (без сжатия)</option></select></label>' +
    '<label>Сжатие <select id="c-lvl"><option value="1">Быстрое</option><option value="5" selected>Обычное</option><option value="9">Максимальное</option></select></label>' +
    '<label>Пароль <input id="c-pw" type="password" placeholder="не обязательно"></label>';
  const list = el.querySelector('.list');
  const fmt = el.querySelector('#c-fmt');
  const lvl = el.querySelector('#c-lvl');
  const pw = el.querySelector('#c-pw');

  const draw = () => {
    list.innerHTML = items.length
      ? items.map((p, i) => '<div class="it"><span title="' + esc(p) + '">' + esc(p) + '</span><button data-i="' + i + '">×</button></div>').join('')
      : '<div class="none">Добавьте файлы или папку</div>';
  };
  list.onclick = (e) => { const b = e.target.closest('button'); if (b) { items.splice(+b.dataset.i, 1); draw(); } };
  const addAll = (arr) => { arr.forEach((p) => { if (!items.includes(p)) items.push(p); }); draw(); };
  el.querySelector('[data-a=files]').onclick = async () => addAll(await zb.dlgFiles());
  el.querySelector('[data-a=folder]').onclick = async () => addAll(await zb.dlgFolder());
  fmt.onchange = () => { pw.disabled = lvl.disabled = fmt.value === 'tar'; };
  draw();

  for (;;) {
    const v = await showModal('Создать архив', el, [{ text: 'Создать', primary: true, value: 'ok' }, { text: 'Отмена', value: null }]);
    if (v !== 'ok') return;
    if (items.length) break;
    toast('Добавьте хотя бы один файл');
  }
  const name = items.length === 1 ? baseName(items[0]).replace(/\.[^.]*$/, '') || 'Архив' : 'Архив';
  const out = await zb.dlgSave(dirName(items[0]) + '\\' + name, fmt.value);
  if (!out) return;
  const password = fmt.value === 'tar' ? '' : pw.value;
  const r = await run('Создание архива…', () => zb.create({ items, out, fmt: fmt.value, level: +lvl.value, password }));
  if (r) { await openFile(out, password || null); toast('Архив создан'); }
}

// ------------------------------------------------------------ кнопки
$('#b-open').onclick = $('#e-open').onclick = doOpen;
$('#b-create').onclick = $('#e-create').onclick = () => doCreate();
$('#b-extract').onclick = doExtract;
$('#b-delete').onclick = doDelete;
$('#b-test').onclick = doTest;
$('#b-add').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [{ text: 'Файлы…', fn: () => doAdd('files') }, { text: 'Папку…', fn: () => doAdd('folder') }]);
};

// ------------------------------------------------------------ перетаскивание
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#drop').classList.remove('hidden'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.add('hidden');
  const paths = [...e.dataTransfer.files].map((f) => zb.pathFor(f)).filter(Boolean);
  if (!paths.length) return;
  if (paths.length === 1 && ARCH_EXT.test(paths[0])) return openFile(paths[0]);
  if (S.arc && S.arc.canModify) {
    if (await confirmBox('Добавить ' + paths.length + ' шт. в открытый архив?', 'Добавить')) addItems(paths);
    return;
  }
  doCreate(paths);
});

zb.onOpenPath((p) => openFile(p));
render();

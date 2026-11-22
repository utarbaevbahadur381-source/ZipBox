'use strict';
// Движок архиватора: обёртка над 7-Zip (7za), который поставляется вместе с программой.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const bin = () => require('7zip-bin').path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const pwArg = (p) => (p ? ['-p' + p] : []);
const toArc = (n) => (process.platform === 'win32' ? n.replace(/\//g, '\\') : n);

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(), args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      if (opts.onProgress) {
        const m = d.match(/(\d{1,3})%/g);
        if (m) opts.onProgress(Math.min(100, parseInt(m[m.length - 1], 10)));
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function failure(res) {
  const text = res.err + '\n' + res.out;
  if (/wrong password|can not open encrypted|enter password|cannot open encrypted/i.test(text)) {
    const e = new Error('Нужен пароль или он неверный.');
    e.code = 'PASSWORD';
    return e;
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /error|can not|cannot|unsupported|is not/i.test(l));
  return new Error(lines.slice(0, 3).join('\n') || 'Ошибка архиватора (код ' + res.code + ').');
}

function listFile(lines) {
  const f = path.join(
    os.tmpdir(),
    'zipbox-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.lst'
  );
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
  return f;
}

async function list(file, password) {
  const res = await run(['l', '-slt', '-sccUTF-8', ...pwArg(password), file]);
  if (res.code >= 2) throw failure(res);
  const text = res.out.replace(/\r/g, '');
  const sep = '\n----------\n';
  const idx = text.indexOf(sep);
  if (idx < 0) throw new Error('Не удалось прочитать архив. Возможно, это не архив.');
  const type = ((text.slice(0, idx).match(/^Type = (.+)$/m) || [])[1] || '').trim();
  const entries = [];
  for (const block of text.slice(idx + sep.length).split(/\n\n+/)) {
    const kv = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(' = ');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 3);
    }
    if (!kv.Path) continue;
    const isDir = kv.Folder === '+' || /^D/.test(kv.Attributes || '');
    let name = kv.Path.replace(/\\/g, '/');
    if (isDir) name = name.replace(/\/?$/, '/');
    const size = parseInt(kv.Size, 10);
    const packed = parseInt(kv['Packed Size'], 10);
    entries.push({
      name,
      isDir,
      size: isNaN(size) ? null : size,
      packed: isNaN(packed) ? null : packed,
      modified: (kv.Modified || '').slice(0, 16),
      encrypted: kv.Encrypted === '+',
    });
  }
  return { type, entries };
}

async function extract(file, dest, names, password, onProgress) {
  fs.mkdirSync(dest, { recursive: true });
  const args = ['x', '-y', '-bsp1', '-sccUTF-8', '-scsUTF-8', '-spd', ...pwArg(password), '-o' + dest, file];
  let lst;
  if (names && names.length) {
    lst = listFile(names.map((n) => toArc(n.replace(/\/$/, ''))));
    args.push('@' + lst);
  }
  try {
    const res = await run(args, { onProgress });
    if (res.code >= 2) throw failure(res);
    return { warning: res.code === 1 ? 'Часть файлов распаковать не удалось.' : '' };
  } finally {
    if (lst) fs.rmSync(lst, { force: true });
  }
}

async function create(out, items, opts, onProgress) {
  const fmt = opts.fmt || 'zip';
  const level = opts.level || 5;
  const password = fmt === 'tar' ? '' : opts.password;
  fs.rmSync(out, { force: true });
  const args = ['a', '-t' + fmt, '-y', '-bsp1', '-sccUTF-8', '-scsUTF-8', '-spd'];
  if (fmt !== 'tar') args.push('-mx=' + level);
  if (password) {
    args.push('-p' + password);
    args.push(fmt === 'zip' ? '-mem=AES256' : '-mhe=on');
  }
  const lst = listFile(items);
  args.push(out, '@' + lst);
  try {
    const res = await run(args, { onProgress });
    if (res.code >= 2) throw failure(res);
    return {};
  } finally {
    fs.rmSync(lst, { force: true });
  }
}

async function add(file, items, prefix, password, onProgress) {
  let targets = items;
  let cwd;
  let tmp;
  if (prefix) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zipbox-add-'));
    const segs = prefix.split('/').filter(Boolean);
    const dir = path.join(tmp, ...segs);
    fs.mkdirSync(dir, { recursive: true });
    for (const it of items) fs.cpSync(it, path.join(dir, path.basename(it)), { recursive: true });
    targets = [segs[0]];
    cwd = tmp;
  }
  const lst = listFile(targets);
  const args = ['a', '-y', '-bsp1', '-sccUTF-8', '-scsUTF-8', '-spd', ...pwArg(password), file, '@' + lst];
  try {
    const res = await run(args, { onProgress, cwd });
    if (res.code >= 2) throw failure(res);
    return {};
  } finally {
    fs.rmSync(lst, { force: true });
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function remove(file, names, password) {
  const lst = listFile(names.map((n) => toArc(n.replace(/\/$/, ''))));
  try {
    const res = await run(['d', '-y', '-sccUTF-8', '-scsUTF-8', '-spd', ...pwArg(password), file, '@' + lst]);
    if (res.code >= 2) throw failure(res);
    return {};
  } finally {
    fs.rmSync(lst, { force: true });
  }
}

async function test(file, password, onProgress) {
  const res = await run(['t', '-y', '-bsp1', '-sccUTF-8', ...pwArg(password), file], { onProgress });
  if (res.code === 0) return { ok: true };
  if (res.code >= 2 || /error/i.test(res.out + res.err)) {
    const e = failure(res);
    if (e.code === 'PASSWORD') throw e;
    return { ok: false, message: e.message };
  }
  return { ok: true };
}

module.exports = { list, extract, create, add, remove, test };

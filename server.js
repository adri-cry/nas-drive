const express = require('express');
const multer = require('multer');
const mime = require('mime-types');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.disable('x-powered-by');
const PORT = 3000;

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Ganti path ini sesuai folder NAS kamu, default: folder "storage" di samping server.js
const STORAGE_ROOT = path.join(__dirname, 'storage');
// Papan tulis bersama disimpan terpisah dari file user (tidak muncul di file manager)
const BOARDS_ROOT = path.join(__dirname, 'boards');

// Batasan keamanan
const MAX_READ_PREVIEW_BYTES = 2 * 1024 * 1024; // /api/read maksimal 2MB
const MAX_UPLOAD_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB per file
const MAX_UPLOAD_FILES = 50;
const MAX_BOARD_BYTES = 1 * 1024 * 1024; // 1MB per papan
const MAX_BOARD_NAME = 100;

// Pastikan folder storage ada
if (!fs.existsSync(STORAGE_ROOT)) {
  fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  console.log(`📁 Storage folder dibuat: ${STORAGE_ROOT}`);
}

// Pastikan folder boards ada
if (!fs.existsSync(BOARDS_ROOT)) {
  fs.mkdirSync(BOARDS_ROOT, { recursive: true });
  console.log(`📝 Boards folder dibuat: ${BOARDS_ROOT}`);
}

// ─── SECURITY HEADERS ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ─── MULTER (upload) ───────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const rel = req.query.path || '';
      const dest = resolveStoragePath(rel);
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    try {
      const clean = sanitizeFilename(file.originalname);
      // Cegah overwrite diam-diam: buat nama unik bila sudah ada
      try {
        const destDir = resolveStoragePath(req.query.path || '');
        const uniqueFull = uniqueDestPath(destDir, clean);
        cb(null, path.basename(uniqueFull));
      } catch {
        cb(null, clean);
      }
    } catch (e) {
      cb(e);
    }
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE, files: MAX_UPLOAD_FILES }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function sanitizePath(rel) {
  let s = String(rel || '');
  // Tolak null byte (bisa bypass check di beberapa fs)
  s = s.replace(/\0/g, '');
  if (s === '') return '';
  const normalized = path.normalize(s);
  // Strip leading slash/backslash agar path absolut tidak lolos.
  // JANGAN strip "..": biarkan prefix-check di resolveStoragePath yang menolak
  // (eksplisit 400), bukan diam-diam redirect ke root.
  const noLead = normalized.replace(/^[\/\\]+/, '');
  if (noLead === '.' || noLead === '') return '';
  return noLead;
}

function resolveStoragePath(rel) {
  const safePath = sanitizePath(rel || '');
  const full = path.join(STORAGE_ROOT, safePath);
  // Cek dengan separator agar sibling "storage-backup" tidak lolos startsWith
  if (full !== STORAGE_ROOT && !full.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error('Access denied');
  }
  return full;
}

// Nama file upload: buang direktori, karakter kontrol, dan cegah overwrite diam-diam
function sanitizeFilename(originalname) {
  let name = Buffer.from(String(originalname || ''), 'latin1').toString('utf8');
  name = name.replace(/\0/g, '').trim();
  // Buang path apa pun (c:.., a/b, ..\..) -> basename, tangani slash dua OS
  name = name.split('/').pop().split('\\').pop();
  name = path.basename(name);
  if (!name || name === '.' || name === '..') throw new Error('Invalid filename');
  if (name.length > 255) throw new Error('Filename too long');
  return name;
}

// Hindari overwrite diam-diam: kalau sudah ada, beri suffix " (1)", " (2)", ...
function uniqueDestPath(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Too many duplicate filenames');
}

// Validasi nama file/folder baru (mkdir & rename): tidak boleh mengandung separator
function validateNewName(name) {
  if (typeof name !== 'string') throw new Error('Invalid name');
  const trimmed = name.trim().replace(/\0/g, '');
  if (!trimmed) throw new Error('Name is required');
  if (trimmed === '.' || trimmed === '..') throw new Error('Invalid name');
  if (trimmed.length > 255) throw new Error('Name too long');
  if (/[\/\\]/.test(trimmed)) throw new Error('Name must not contain / or \\');
  return trimmed;
}

function assertNotRoot(rel, action) {
  const safe = sanitizePath(rel || '');
  if (safe === '') throw new Error(`Refusing to ${action || 'modify'} root folder`);
}

// Tolak symlink agar tidak bisa baca file di luar root via link
function assertNoSymlink(full) {
  try {
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new Error('Symlinks are not allowed');
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
}

function buildContentDisposition(basename, isDownload, forceAttachment) {
  const safe = String(basename).replace(/[\r\n"]/g, '_').replace(/;/g, '_');
  const encoded = encodeURIComponent(basename).replace(/['()]/g, escape);
  const disp = (isDownload || forceAttachment) ? 'attachment' : 'inline';
  return `${disp}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

// ─── PAPAN (shared boards) ───────────────────────────────────────────────────
function validateBoardName(name) {
  if (typeof name !== 'string') throw new Error('Invalid board name');
  const trimmed = name.trim().replace(/\0/g, '');
  if (!trimmed) throw new Error('Board name is required');
  if (trimmed === '.' || trimmed === '..') throw new Error('Invalid board name');
  if (trimmed.length > MAX_BOARD_NAME) throw new Error('Board name too long');
  if (/[\/\\]/.test(trimmed)) throw new Error('Board name must not contain / or \\');
  if (trimmed !== path.basename(trimmed)) throw new Error('Invalid board name');
  return trimmed;
}

function resolveBoardFile(name) {
  const clean = validateBoardName(name);
  const full = path.join(BOARDS_ROOT, clean + '.md');
  // Defense in depth: nama sudah divalidasi tanpa separator, tapi cek prefix tetap dilakukan
  if (!full.startsWith(BOARDS_ROOT + path.sep)) {
    throw new Error('Access denied');
  }
  return { clean, full };
}

// Cache papan di memori: name -> { content, version, clients:Set, saveTimer }
const boardCache = new Map();

function loadBoardState(name) {
  const { clean, full } = resolveBoardFile(name);
  let cached = boardCache.get(clean);
  if (cached) return { clean, full, state: cached };
  let content = '';
  try {
    if (fs.existsSync(full)) {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_BOARD_BYTES) throw new Error('Board file invalid');
      content = fs.readFileSync(full, 'utf8');
      if (content.length > MAX_BOARD_BYTES) content = content.slice(0, MAX_BOARD_BYTES);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  cached = { content, version: 0, clients: new Set(), saveTimer: null };
  boardCache.set(clean, cached);
  return { clean, full, state: cached };
}

function scheduleBoardSave(clean, full, state) {
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    try {
      const tmp = full + '.tmp';
      fs.writeFileSync(tmp, state.content, 'utf8');
      fs.renameSync(tmp, full);
    } catch (e) {
      console.error('Gagal simpan papan ' + clean + ': ' + e.message);
    }
  }, 1000);
}

function getFileIcon(ext, isDir) {
  if (isDir) return 'folder';
  const map = {
    image: ['jpg','jpeg','png','gif','bmp','webp','svg','ico'],
    video: ['mp4','mkv','avi','mov','webm','flv'],
    audio: ['mp3','wav','flac','ogg','aac','m4a'],
    pdf: ['pdf'],
    code: ['js','ts','py','java','php','cpp','c','cs','go','rs','sh','bat','json','xml','yaml','yml','env','ini','toml','sql'],
    text: ['txt','md','log','csv'],
    archive: ['zip','rar','7z','tar','gz','bz2'],
    word: ['doc','docx'],
    excel: ['xls','xlsx','ods'],
    ppt: ['ppt','pptx'],
  };
  for (const [type, exts] of Object.entries(map)) {
    if (exts.includes(ext.toLowerCase())) return type;
  }
  return 'file';
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '—';
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B','KB','MB','GB','TB','PB','EB'];
  let i = Math.floor(Math.log(bytes) / Math.log(1024));
  i = Math.max(0, Math.min(i, units.length - 1));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        ips.push(alias.address);
      }
    }
  }
  return ips;
}

// ─── API ───────────────────────────────────────────────────────────────────────

// List directory
app.get('/api/list', (req, res) => {
  try {
    const rel = req.query.path || '';
    // Pakai safe path yang sudah disanitasi untuk breadcrumb agar traversal tidak bocor
    const safeRel = sanitizePath(rel);
    const full = resolveStoragePath(rel);
    assertNoSymlink(full);
    const lst = fs.lstatSync(full);
    if (!lst.isDirectory()) return res.status(400).json({ ok: false, error: 'Not a directory' });
    const entries = fs.readdirSync(full, { withFileTypes: true });

    const items = entries.map(e => {
      const itemPath = path.join(full, e.name);
      let stat = {};
      try {
        const ls = fs.lstatSync(itemPath);
        // Jangan ikuti symlink
        if (ls.isSymbolicLink()) {
          stat = { size: 0, mtime: ls.mtime };
          const ext0 = path.extname(e.name).replace('.', '');
          return {
            name: e.name,
            isDir: false,
            size: 0,
            sizeFormatted: '—',
            modified: stat.mtime ? stat.mtime.toISOString() : null,
            icon: 'file',
            ext: ext0.toLowerCase()
          };
        }
        stat = fs.statSync(itemPath);
      } catch {}
      const isDir = e.isDirectory();
      const ext = path.extname(e.name).replace('.', '');
      return {
        name: e.name,
        isDir,
        size: isDir ? null : stat.size,
        sizeFormatted: isDir ? '—' : formatSize(stat.size || 0),
        modified: stat.mtime ? stat.mtime.toISOString() : null,
        icon: getFileIcon(ext, isDir),
        ext: ext.toLowerCase()
      };
    });

    // Sort: folders first, then files alphabetically
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'id', { sensitivity: 'base' });
    });

    // Breadcrumb dari safe path (bukan input mentah)
    const parts = safeRel.split(/[\/\\]/).filter(Boolean);
    const breadcrumb = [{ name: 'Home', path: '' }];
    parts.forEach((p, i) => {
      breadcrumb.push({ name: p, path: parts.slice(0, i + 1).join('/') });
    });

    res.json({ ok: true, items, breadcrumb, currentPath: safeRel });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Upload files
app.post('/api/upload', (req, res, next) => {
  upload.array('files', MAX_UPLOAD_FILES)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: 'File too large' });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ ok: false, error: 'Too many files' });
      }
      return res.status(400).json({ ok: false, error: err.message });
    }
    next();
  });
}, (req, res) => {
  res.json({ ok: true, count: (req.files || []).length });
});

// Create folder
app.post('/api/mkdir', express.json(), (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid request body' });
    }
    const basePath = sanitizePath(req.body.path || '');
    const cleanName = validateNewName(req.body.name);
    const full = resolveStoragePath(path.join(basePath, cleanName));
    if (fs.existsSync(full)) {
      return res.status(400).json({ ok: false, error: 'Already exists' });
    }
    fs.mkdirSync(full, { recursive: false });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Delete file/folder
app.delete('/api/delete', express.json(), (req, res) => {
  try {
    if (!req.body || typeof req.body.path !== 'string' || !req.body.path.trim()) {
      return res.status(400).json({ ok: false, error: 'Path is required' });
    }
    assertNotRoot(req.body.path, 'delete');
    const full = resolveStoragePath(req.body.path);
    assertNoSymlink(full);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    if (stat.isSymbolicLink()) {
      return res.status(403).json({ ok: false, error: 'Symlinks are not allowed' });
    }
    if (stat.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: false });
    } else {
      fs.unlinkSync(full);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Rename
app.post('/api/rename', express.json(), (req, res) => {
  try {
    if (!req.body || typeof req.body.oldPath !== 'string' || !req.body.oldPath.trim()) {
      return res.status(400).json({ ok: false, error: 'oldPath is required' });
    }
    const cleanNew = validateNewName(req.body.newName);
    assertNotRoot(req.body.oldPath, 'rename');
    const oldFull = resolveStoragePath(req.body.oldPath);
    assertNoSymlink(oldFull);
    // oldPath parent dihitung dari safe path agar traversal tidak bisa kabur
    const safeOld = sanitizePath(req.body.oldPath);
    const dir = path.dirname(safeOld);
    const safeDir = (dir === '.' || dir === '') ? '' : dir;
    const newFull = resolveStoragePath(path.join(safeDir, cleanNew));
    assertNoSymlink(newFull);
    if (!fs.existsSync(oldFull)) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    if (fs.existsSync(newFull)) {
      return res.status(400).json({ ok: false, error: 'Target already exists' });
    }
    fs.renameSync(oldFull, newFull);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Copy file/folder ke folder tujuan (untuk paste dari copy)
app.post('/api/copy', express.json(), (req, res) => {
  try {
    if (!req.body || typeof req.body.src !== 'string' || !req.body.src.trim()) {
      return res.status(400).json({ ok: false, error: 'src is required' });
    }
    if (!req.body || typeof req.body.destDir !== 'string') {
      return res.status(400).json({ ok: false, error: 'destDir is required' });
    }
    assertNotRoot(req.body.src, 'copy');
    const srcFull = resolveStoragePath(req.body.src);
    assertNoSymlink(srcFull);
    const destDirFull = resolveStoragePath(sanitizePath(req.body.destDir));
    assertNoSymlink(destDirFull);
    let srcStat;
    try {
      srcStat = fs.lstatSync(srcFull);
    } catch {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    if (srcStat.isSymbolicLink()) {
      return res.status(403).json({ ok: false, error: 'Symlinks are not allowed' });
    }
    let destStat;
    try {
      destStat = fs.statSync(destDirFull);
    } catch {
      return res.status(404).json({ ok: false, error: 'Destination folder not found' });
    }
    if (!destStat.isDirectory()) {
      return res.status(400).json({ ok: false, error: 'Destination is not a folder' });
    }
    const base = path.basename(sanitizePath(req.body.src));
    if (!base || base === '.' || base === '..') {
      return res.status(400).json({ ok: false, error: 'Invalid name' });
    }
    // Cegah copy folder ke dalam dirinya sendiri / keturunannya (rekursi tak berujung)
    if (srcStat.isDirectory()) {
      if (destDirFull === srcFull || destDirFull.startsWith(srcFull + path.sep)) {
        return res.status(400).json({ ok: false, error: 'Cannot copy a folder into itself' });
      }
    }
    const targetFull = uniqueDestPath(destDirFull, base);
    if (srcStat.isDirectory()) {
      fs.cpSync(srcFull, targetFull, { recursive: true, dereference: false });
    } else {
      fs.copyFileSync(srcFull, targetFull);
    }
    res.json({ ok: true, name: path.basename(targetFull) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Move file/folder ke folder tujuan (untuk paste dari cut)
app.post('/api/move', express.json(), (req, res) => {
  try {
    if (!req.body || typeof req.body.src !== 'string' || !req.body.src.trim()) {
      return res.status(400).json({ ok: false, error: 'src is required' });
    }
    if (!req.body || typeof req.body.destDir !== 'string') {
      return res.status(400).json({ ok: false, error: 'destDir is required' });
    }
    assertNotRoot(req.body.src, 'move');
    const srcFull = resolveStoragePath(req.body.src);
    assertNoSymlink(srcFull);
    const destDirFull = resolveStoragePath(sanitizePath(req.body.destDir));
    let srcStat;
    try {
      srcStat = fs.lstatSync(srcFull);
    } catch {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    if (srcStat.isSymbolicLink()) {
      return res.status(403).json({ ok: false, error: 'Symlinks are not allowed' });
    }
    let destStat;
    try {
      destStat = fs.statSync(destDirFull);
    } catch {
      return res.status(404).json({ ok: false, error: 'Destination folder not found' });
    }
    if (!destStat.isDirectory()) {
      return res.status(400).json({ ok: false, error: 'Destination is not a folder' });
    }
    const base = path.basename(sanitizePath(req.body.src));
    if (!base || base === '.' || base === '..') {
      return res.status(400).json({ ok: false, error: 'Invalid name' });
    }
    const targetFull = path.join(destDirFull, base);
    if (targetFull === srcFull) {
      return res.json({ ok: true, name: base, moved: false });
    }
    if (srcStat.isDirectory()) {
      if (destDirFull === srcFull || destDirFull.startsWith(srcFull + path.sep)) {
        return res.status(400).json({ ok: false, error: 'Cannot move a folder into itself' });
      }
    }
    if (fs.existsSync(targetFull)) {
      return res.status(400).json({ ok: false, error: 'Target already exists' });
    }
    fs.renameSync(srcFull, targetFull);
    res.json({ ok: true, name: base, moved: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// List papan
app.get('/api/boards', (req, res) => {
  try {
    const entries = fs.readdirSync(BOARDS_ROOT, { withFileTypes: true });
    const boards = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => {
        const full = path.join(BOARDS_ROOT, e.name);
        let stat = {};
        try { stat = fs.statSync(full); } catch {}
        return {
          name: e.name.slice(0, -3),
          size: stat.size || 0,
          modified: stat.mtime ? stat.mtime.toISOString() : null
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'id', { sensitivity: 'base' }));
    res.json({ ok: true, boards });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Buat papan baru
app.post('/api/boards', express.json(), (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid request body' });
    }
    const { clean, full } = resolveBoardFile(req.body.name);
    if (fs.existsSync(full)) {
      return res.status(400).json({ ok: false, error: 'Board already exists' });
    }
    fs.writeFileSync(full, '', 'utf8');
    res.json({ ok: true, name: clean });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Hapus papan
app.delete('/api/boards', express.json(), (req, res) => {
  try {
    if (!req.body || typeof req.body.name !== 'string' || !req.body.name.trim()) {
      return res.status(400).json({ ok: false, error: 'Board name is required' });
    }
    const { clean, full } = resolveBoardFile(req.body.name);
    const cached = boardCache.get(clean);
    if (cached) {
      if (cached.saveTimer) {
        clearTimeout(cached.saveTimer);
        cached.saveTimer = null;
      }
      for (const ws of cached.clients) {
        try { ws.send(JSON.stringify({ type: 'board-deleted' })); ws.close(); } catch {}
      }
      boardCache.delete(clean);
    }
    try {
      fs.unlinkSync(full);
    } catch {
      return res.status(404).json({ ok: false, error: 'Board not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Download / stream file
app.get('/api/file', (req, res) => {
  try {
    const rel = req.query.path;
    if (typeof rel !== 'string' || !rel.trim()) {
      return res.status(400).json({ error: 'Path is required' });
    }
    const full = resolveStoragePath(rel);
    assertNoSymlink(full);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });

    let mimeType = mime.lookup(full) || 'application/octet-stream';
    const base = path.basename(full);
    const isDownload = req.query.dl === '1';

    // File HTML/SVG bila di-inline akan jadi stored XSS satu origin.
    // Paksa download untuk tipe aktif tersebut.
    const activeTypes = new Set([
      'text/html', 'application/xhtml+xml',
      'image/svg+xml', 'text/xml', 'application/xml',
      'text/javascript', 'application/javascript'
    ]);
    const forceAttachment = activeTypes.has(mimeType);
    if (forceAttachment) {
      mimeType = isDownload ? mimeType : 'text/plain; charset=utf-8';
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', buildContentDisposition(base, isDownload, false));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    // Range support (for video streaming) — divalidasi ketat
    const range = req.headers.range;
    if (range && !isDownload) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      let start, end;
      if (m[1] === '') {
        // suffix-range: bytes=-N (N byte terakhir)
        const suffix = parseInt(m[2], 10);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          return res.status(416).end();
        }
        if (stat.size === 0) {
          res.setHeader('Content-Range', `bytes */0`);
          return res.status(416).end();
        }
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? stat.size - 1 : parseInt(m[2], 10);
        if (!Number.isInteger(start) || !Number.isInteger(end) ||
            start < 0 || end < 0 || start >= stat.size || start > end) {
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          return res.status(416).end();
        }
        end = Math.min(end, stat.size - 1);
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      });
      const stream = fs.createReadStream(full, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) return res.status(404).json({ error: 'File not found' });
        try { res.destroy(); } catch {}
      });
      stream.pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(full);
      stream.on('error', () => {
        if (!res.headersSent) return res.status(404).json({ error: 'File not found' });
        try { res.destroy(); } catch {}
      });
      stream.pipe(res);
    }
  } catch (e) {
    if (!res.headersSent) res.status(404).json({ error: 'File not found' });
    else try { res.end(); } catch {}
  }
});

// Read text file content (for preview)
app.get('/api/read', (req, res) => {
  try {
    const rel = req.query.path;
    if (typeof rel !== 'string' || !rel.trim()) {
      return res.status(400).json({ ok: false, error: 'Path is required' });
    }
    const full = resolveStoragePath(rel);
    assertNoSymlink(full);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    if (stat.isDirectory()) return res.status(400).json({ ok: false, error: 'Is a directory' });
    if (stat.size > MAX_READ_PREVIEW_BYTES) {
      return res.status(413).json({ ok: false, error: 'File too large to preview (max 2MB)' });
    }
    const content = fs.readFileSync(full, 'utf8');
    // Potong defensif bila file membengkak antara stat & read
    const sliced = content.length > MAX_READ_PREVIEW_BYTES ? content.slice(0, MAX_READ_PREVIEW_BYTES) : content;
    res.json({ ok: true, content: sliced });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── FRONTEND ─────────────────────────────────────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});
app.get('/{*path}', (req, res) => {
  res.send(HTML);
});

// Global error handler (JSON parse error, dll) — jangan bocorkan HTML stack
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ ok: false, error: err.message || 'Bad request' });
});

// ─── HTML ─────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NAS Drive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0e0f12;
    --surface: #16181e;
    --surface2: #1e2028;
    --border: #2a2d38;
    --accent: #4f8ef7;
    --accent2: #7c5af5;
    --green: #3dd68c;
    --red: #f7584f;
    --yellow: #f5c542;
    --text: #e4e6f0;
    --muted: #6b7080;
    --font: 'Syne', sans-serif;
    --mono: 'IBM Plex Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); }

  /* LAYOUT */
  #app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

  /* TOPBAR */
  .topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 0 20px; height: 56px;
    background: var(--surface); border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .topbar-logo {
    font-size: 18px; font-weight: 700; letter-spacing: -0.5px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-right: 8px;
  }
  .topbar-logo span { font-family: var(--mono); }

  /* BREADCRUMB */
  .breadcrumb {
    display: flex; align-items: center; gap: 4px;
    flex: 1; overflow: hidden;
    font-size: 13px; font-family: var(--mono); color: var(--muted);
  }
  .breadcrumb a {
    color: var(--accent); text-decoration: none; white-space: nowrap;
    padding: 3px 6px; border-radius: 4px;
    transition: background 0.15s;
  }
  .breadcrumb a:hover { background: rgba(79,142,247,0.12); }
  .breadcrumb .sep { color: var(--border); }
  .breadcrumb .current { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* TOOLBAR */
  .toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 20px;
    background: var(--surface); border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 14px; border-radius: 7px;
    font-size: 13px; font-family: var(--font); font-weight: 500;
    border: 1px solid var(--border); background: var(--surface2);
    color: var(--text); cursor: pointer; transition: all 0.15s;
    white-space: nowrap;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); background: rgba(79,142,247,0.08); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { opacity: 0.88; }
  .btn.danger:hover { border-color: var(--red); color: var(--red); background: rgba(247,88,79,0.08); }
  .btn.sm { padding: 4px 10px; font-size: 12px; }
  .spacer { flex: 1; }
  .search-wrap { position: relative; }
  .search-wrap input {
    background: var(--surface2); border: 1px solid var(--border);
    color: var(--text); padding: 7px 12px 7px 32px;
    border-radius: 7px; font-size: 13px; font-family: var(--font);
    width: 200px; transition: border 0.15s;
  }
  .search-wrap input:focus { outline: none; border-color: var(--accent); }
  .search-wrap .icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 14px; }

  /* FILE LIST */
  #file-area {
    flex: 1; overflow-y: auto; padding: 16px 20px;
    position: relative;
  }
  #file-area.drag-over::after {
    content: 'Drop files to upload';
    position: absolute; inset: 0;
    background: rgba(79,142,247,0.1);
    border: 2px dashed var(--accent);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; font-weight: 600; color: var(--accent);
    pointer-events: none;
    display: flex;
  }
  .file-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
  }
  .file-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 12px 12px;
    cursor: pointer;
    transition: all 0.15s;
    position: relative;
    user-select: none;
  }
  .file-card:hover { border-color: var(--accent); transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
  .file-card.selected { border-color: var(--accent); background: rgba(79,142,247,0.08); }
  .file-icon {
    font-size: 36px; text-align: center; margin-bottom: 10px;
    line-height: 1;
  }
  .file-name {
    font-size: 12px; font-weight: 500; text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .file-meta {
    font-size: 10px; color: var(--muted); text-align: center;
    font-family: var(--mono); margin-top: 4px;
  }
  .file-actions {
    position: absolute; top: 6px; right: 6px;
    display: none; gap: 3px;
  }
  .file-card:hover .file-actions { display: flex; }
  .file-act-btn {
    width: 22px; height: 22px;
    border-radius: 4px; border: none;
    background: var(--surface2); color: var(--muted);
    cursor: pointer; font-size: 11px; display: flex;
    align-items: center; justify-content: center;
    transition: all 0.12s;
  }
  .file-act-btn:hover { background: var(--border); color: var(--text); }
  .file-act-btn.del:hover { background: rgba(247,88,79,0.2); color: var(--red); }

  /* LIST VIEW */
  .file-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .file-table th {
    text-align: left; padding: 8px 12px;
    color: var(--muted); font-weight: 500;
    border-bottom: 1px solid var(--border);
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
    font-family: var(--mono);
  }
  .file-table td { padding: 9px 12px; border-bottom: 1px solid rgba(42,45,56,0.5); }
  .file-table tr:hover td { background: var(--surface2); }
  .file-table tr.selected td { background: rgba(79,142,247,0.08); }
  .file-row-name { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .file-row-icon { font-size: 18px; flex-shrink: 0; }
  .row-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.12s; }
  .file-table tr:hover .row-actions { opacity: 1; }

  /* EMPTY */
  .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 60%; gap: 12px; color: var(--muted);
  }
  .empty-state .icon { font-size: 48px; opacity: 0.3; }
  .empty-state p { font-size: 14px; }

  /* STATUS BAR */
  .statusbar {
    display: flex; align-items: center; gap: 16px;
    padding: 0 20px; height: 32px;
    background: var(--surface); border-top: 1px solid var(--border);
    font-size: 11px; font-family: var(--mono); color: var(--muted);
    flex-shrink: 0;
  }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); display: inline-block; }

  /* MODAL */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 100;
    backdrop-filter: blur(4px);
  }
  .modal {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px; min-width: 340px;
    max-width: 90vw; max-height: 90vh;
    display: flex; flex-direction: column; gap: 16px;
  }
  .modal-title { font-size: 16px; font-weight: 600; }
  .modal input {
    background: var(--surface2); border: 1px solid var(--border);
    color: var(--text); padding: 9px 12px;
    border-radius: 7px; font-size: 13px; font-family: var(--font);
    width: 100%;
  }
  .modal input:focus { outline: none; border-color: var(--accent); }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* PREVIEW MODAL */
  .preview-modal { width: min(800px, 95vw); }
  .preview-modal .preview-body { overflow: auto; max-height: 65vh; }
  .preview-modal img { max-width: 100%; border-radius: 6px; display: block; margin: 0 auto; }
  .preview-modal video { max-width: 100%; border-radius: 6px; display: block; }
  .preview-modal pre {
    background: var(--surface2); padding: 16px; border-radius: 8px;
    font-size: 12px; font-family: var(--mono); overflow: auto;
    white-space: pre-wrap; word-break: break-word;
  }
  .preview-modal .pdf-frame { width: 100%; height: 60vh; border: none; border-radius: 6px; }

  /* UPLOAD PROGRESS */
  .upload-toast {
    position: fixed; bottom: 48px; right: 20px;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 18px;
    min-width: 240px; z-index: 200;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    font-size: 13px;
  }
  .upload-toast .title { font-weight: 600; margin-bottom: 8px; }
  .progress-bar { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; margin-top: 6px; }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.2s; }

  /* TOAST */
  .toast {
    position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%);
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 18px;
    font-size: 13px; z-index: 300;
    animation: slideUp 0.2s ease, fadeOut 0.3s 2.5s forwards;
  }
  @keyframes slideUp { from { opacity:0; transform: translateX(-50%) translateY(10px); } }
  @keyframes fadeOut { to { opacity:0; } }

  /* VIEW TOGGLE */
  .view-toggle { display: flex; gap: 2px; }
  .view-btn {
    width: 30px; height: 30px; border-radius: 5px;
    border: 1px solid var(--border); background: var(--surface2);
    color: var(--muted); cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.12s;
  }
  .view-btn.active { border-color: var(--accent); color: var(--accent); background: rgba(79,142,247,0.1); }

  /* SCROLLBAR */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted); }

  /* APP NAV */
  .app-nav { display: flex; gap: 4px; margin-right: 8px; }
  .nav-btn {
    padding: 6px 12px; border-radius: 7px; font-size: 13px; font-family: var(--font);
    border: 1px solid transparent; background: transparent; color: var(--muted);
    cursor: pointer; transition: all 0.15s; white-space: nowrap;
  }
  .nav-btn:hover { color: var(--text); background: var(--surface2); }
  .nav-btn.active { color: var(--accent); background: rgba(79,142,247,0.1); border-color: var(--border); }

  /* BOARD VIEW */
  #board-view { display: none; flex: 1; min-height: 0; }
  #board-view.open { display: flex; }
  .board-layout { display: flex; flex: 1; min-height: 0; width: 100%; }
  .board-sidebar {
    width: 230px; flex-shrink: 0; background: var(--surface);
    border-right: 1px solid var(--border); display: flex; flex-direction: column;
    min-height: 0;
  }
  .board-side-head { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
  .board-side-head input {
    background: var(--surface2); border: 1px solid var(--border); color: var(--text);
    padding: 7px 10px; border-radius: 7px; font-size: 12px; font-family: var(--font); width: 100%;
  }
  .board-side-head input:focus { outline: none; border-color: var(--accent); }
  .board-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
  .board-item {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 7px;
    border: 1px solid transparent; cursor: pointer; font-size: 13px; transition: all 0.12s;
  }
  .board-item:hover { background: var(--surface2); }
  .board-item.active { border-color: var(--accent); background: rgba(79,142,247,0.08); }
  .board-item .bname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .board-item .bdel {
    border: none; background: transparent; color: var(--muted); cursor: pointer;
    font-size: 12px; padding: 2px 4px; border-radius: 4px; display: none;
  }
  .board-item:hover .bdel { display: block; }
  .board-item .bdel:hover { color: var(--red); background: rgba(247,88,79,0.12); }
  .board-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .board-toolbar {
    display: flex; align-items: center; gap: 10px; padding: 10px 16px;
    background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .board-title { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .board-status { font-size: 11px; font-family: var(--mono); color: var(--muted); }
  .board-users { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0; }
  .user-chip {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 20px; padding: 3px 10px 3px 6px; font-family: var(--mono);
  }
  .user-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .board-typing { font-size: 11px; color: var(--accent); font-family: var(--mono); min-height: 14px; padding: 2px 16px 0; }
  #board-editor {
    flex: 1; resize: none; background: var(--bg); color: var(--text);
    border: none; outline: none; padding: 18px; font-size: 14px; line-height: 1.7;
    font-family: var(--mono); min-height: 0;
  }
  #board-editor:disabled { opacity: 0.5; }
  @media (max-width: 700px) {
    .board-layout { flex-direction: column; }
    .board-sidebar { width: 100%; border-right: none; border-bottom: 1px solid var(--border); max-height: 180px; }
  }
</style>
</head>
<body>
<div id="app">
  <!-- TOPBAR -->
  <div class="topbar">
    <div class="topbar-logo">📦 <span>NAS</span>Drive</div>
    <div class="app-nav">
      <button class="nav-btn active" id="nav-files" onclick="switchAppView('files')">📁 Files</button>
      <button class="nav-btn" id="nav-boards" onclick="switchAppView('boards')">📝 Papan</button>
    </div>
    <div class="breadcrumb" id="breadcrumb"></div>
  </div>

  <!-- TOOLBAR -->
  <div class="toolbar">
    <button class="btn primary" onclick="openUpload()">⬆ Upload</button>
    <button class="btn" onclick="openMkdir()">📁 New Folder</button>
    <button class="btn danger" id="btn-delete-sel" style="display:none" onclick="deleteSelected()">🗑 Delete</button>
    <button class="btn" id="btn-paste" style="display:none" onclick="pasteClipboard()">📋 Paste</button>
    <div class="spacer"></div>
    <div class="search-wrap">
      <span class="icon">🔍</span>
      <input type="text" placeholder="Search..." id="search-input" oninput="filterFiles()">
    </div>
    <div class="view-toggle">
      <button class="view-btn active" id="btn-grid" onclick="setView('grid')" title="Grid">⊞</button>
      <button class="view-btn" id="btn-list" onclick="setView('list')" title="List">☰</button>
    </div>
  </div>

  <!-- FILE AREA -->
  <div id="file-area">
    <div id="file-list"></div>
  </div>

  <!-- STATUS BAR -->
  <div class="statusbar" id="files-statusbar">
    <span><span class="status-dot"></span> Online</span>
    <span id="status-info">Loading...</span>
    <span id="status-sel" style="display:none; color:var(--accent)"></span>
    <span style="margin-left:auto; color:var(--muted)">NAS Drive v1.0</span>
  </div>

  <!-- BOARD VIEW (papan tulis bersama, realtime) -->
  <div id="board-view">
    <div class="board-layout">
      <div class="board-sidebar">
        <div class="board-side-head">
          <button class="btn primary" onclick="createBoard()">＋ Papan Baru</button>
          <input type="text" id="board-username" maxlength="30" placeholder="Nama kamu...">
        </div>
        <div class="board-list" id="board-list"></div>
      </div>
      <div class="board-main">
        <div class="board-toolbar">
          <div class="board-title" id="board-title">Pilih papan</div>
          <span class="board-status" id="board-status"></span>
          <div class="board-users" id="board-users"></div>
        </div>
        <div class="board-typing" id="board-typing"></div>
        <textarea id="board-editor" placeholder="Pilih atau buat papan dulu..." disabled></textarea>
      </div>
    </div>
  </div>
</div>

<!-- Hidden file input -->
<input type="file" id="file-input" multiple accept="*/*" style="display:none" onchange="uploadFiles(this.files)">

<script>
// ─── STATE ────────────────────────────────────────────────────────────────────
let currentPath = '';
let allItems = [];
let lastRendered = [];
let selected = new Set();
let viewMode = 'grid';
let clipboard = null; // { mode: 'copy'|'cut', srcs: [relPath,...] }
// ─── PAPAN state (dideklarasikan di atas agar INIT bisa pakai) ───────────────
let boardList = [];
let activeBoard = '';
let boardWS = null;
let boardVersion = 0;
let boardSendTimer = null;
let boardTypingSent = 0;
let boardTypingClear = null;
let boardReconnectTimer = null;
let boardViewOpen = false;
let myBoardName = 'User';
let myBoardColor = '#4f8ef7';

// ─── INIT ─────────────────────────────────────────────────────────────────────
loadDir('');
initFileListDelegation();
initClipboardShortcuts();
boardUserInit();

function initClipboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'c' || k === 'x') {
      if (!selected.size) return;
      e.preventDefault();
      setClipboard(k === 'c' ? 'copy' : 'cut', Array.from(selected).map(function (n) { return fullRel(n); }));
    } else if (k === 'v') {
      if (!clipboard) return;
      e.preventDefault();
      pasteClipboard();
    }
  });
}

function setClipboard(mode, srcs) {
  srcs = (srcs || []).filter(function (s) { return typeof s === 'string' && s.trim(); });
  if (!srcs.length) return;
  clipboard = { mode: mode, srcs: srcs };
  updateClipboardUI();
  const label = mode === 'cut' ? 'Cut' : 'Copied';
  showToast(label + ' ' + srcs.length + ' item(s) — buka folder tujuan lalu Paste');
}

function updateClipboardUI() {
  const btn = document.getElementById('btn-paste');
  if (!btn) return;
  if (clipboard && clipboard.srcs.length) {
    btn.style.display = '';
    const n = clipboard.srcs.length;
    const first = clipboard.srcs[0].split('/').pop();
    btn.textContent = (clipboard.mode === 'cut' ? '✂ Paste (cut) ' : '📋 Paste (copy) ') + (n === 1 ? first : n + ' items');
  } else {
    btn.style.display = 'none';
  }
}

function copyItem(e, name) {
  e && e.stopPropagation();
  setClipboard('copy', [fullRel(name)]);
}

function cutItem(e, name) {
  e && e.stopPropagation();
  setClipboard('cut', [fullRel(name)]);
}

async function pasteClipboard() {
  if (!clipboard || !clipboard.srcs.length) return;
  const mode = clipboard.mode;
  const srcs = clipboard.srcs.slice();
  const endpoint = mode === 'cut' ? '/api/move' : '/api/copy';
  let okCount = 0;
  let failMsg = '';
  for (const src of srcs) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: src, destDir: currentPath })
      });
      const d = await r.json().catch(function () { return {}; });
      if (r.ok && d.ok) okCount++;
      else failMsg = (d && d.error) || ('HTTP ' + r.status);
    } catch (err) {
      failMsg = err && err.message ? err.message : String(err);
    }
  }
  if (mode === 'cut' && okCount === srcs.length) clipboard = null;
  updateClipboardUI();
  selected.clear();
  updateSelectionUI();
  if (okCount === srcs.length) showToast(mode === 'cut' ? 'Moved!' : 'Copied!');
  else if (okCount > 0) showToast(okCount + ' berhasil, sisanya gagal: ' + failMsg, true);
  else showToast('Paste gagal: ' + failMsg, true);
  loadDir(currentPath);
}

// Delegasi klik untuk daftar file: hindari inline onclick dengan nama file
// (bug lama: esc() + entity-decode = stored XSS + file "&" rusak).
function initFileListDelegation() {
  const listEl = document.getElementById('file-list');
  listEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || !listEl.contains(t)) return;
    const idx = parseInt(t.getAttribute('data-idx'), 10);
    const item = lastRendered[idx];
    if (!item && t.getAttribute('data-action') !== 'select-all') return;
    const action = t.getAttribute('data-action');
    if (action === 'download') downloadFile(e, fullRel(item.name));
    else if (action === 'preview') previewFile(e, item, fullRel(item.name));
    else if (action === 'rename') renameItem(e, item.name);
    else if (action === 'delete') deleteItem(e, fullRel(item.name));
    else if (action === 'copy') copyItem(e, item.name);
    else if (action === 'cut') cutItem(e, item.name);
    else if (action === 'open') openItem(item.name, item.isDir);
    else if (action === 'select') {
      // Folder langsung terbuka saat diklik (single-click), agar folder baru
      // gampang dibuka. Ctrl/Cmd+klik tetap untuk seleksi (bulk delete).
      if (item.isDir && !(e.ctrlKey || e.metaKey)) openItem(item.name, true);
      else toggleSelect(e, item.name);
    }
  });
  listEl.addEventListener('dblclick', (e) => {
    const t = e.target.closest('[data-idx]');
    if (!t || !listEl.contains(t)) return;
    const item = lastRendered[parseInt(t.getAttribute('data-idx'), 10)];
    if (item) openItem(item.name, item.isDir);
  });
  listEl.addEventListener('change', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || !listEl.contains(t)) return;
    if (t.getAttribute('data-action') === 'select-all') selectAll(t.checked);
    else if (t.getAttribute('data-action') === 'select-check') {
      const item = lastRendered[parseInt(t.getAttribute('data-idx'), 10)];
      if (item) toggleSelectCheck(e, item.name);
    }
  });
  document.getElementById('breadcrumb').addEventListener('click', (e) => {
    const a = e.target.closest('[data-crumb]');
    if (!a) return;
    e.preventDefault();
    loadDir(a.getAttribute('data-crumb') || '');
  });
}

function fullRel(name) {
  return (currentPath ? currentPath + '/' : '') + name;
}

// ─── LOAD DIRECTORY ───────────────────────────────────────────────────────────
async function loadDir(p) {
  try {
    currentPath = p;
    selected.clear();
    updateSelectionUI();
    const r = await fetch('/api/list?path=' + encodeURIComponent(p));
    const data = await r.json();
    if (!data.ok) return showToast('Error: ' + data.error, true);
    allItems = data.items;
    // Pakai currentPath dari server (sudah disanitasi) agar traversal tidak nyangkut
    if (typeof data.currentPath === 'string') currentPath = data.currentPath;
    renderBreadcrumb(data.breadcrumb);
    renderFiles(allItems);
    document.getElementById('status-info').textContent =
      data.items.length + ' items';
  } catch (err) {
    showToast('Network error: ' + (err && err.message ? err.message : err), true);
  }
}

// ─── BREADCRUMB ───────────────────────────────────────────────────────────────
function renderBreadcrumb(crumbs) {
  const el = document.getElementById('breadcrumb');
  el.textContent = '';
  crumbs.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ' / ';
      el.appendChild(sep);
    }
    if (i === crumbs.length - 1 && crumbs.length > 1) {
      const s = document.createElement('span');
      s.className = 'current';
      s.textContent = c.name;
      el.appendChild(s);
    } else {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = c.name;
      a.setAttribute('data-crumb', c.path || '');
      el.appendChild(a);
    }
  });
}

// ─── RENDER FILES ─────────────────────────────────────────────────────────────
function renderFiles(items) {
  const q = document.getElementById('search-input').value.toLowerCase();
  const filtered = q ? items.filter(i => i.name.toLowerCase().includes(q)) : items;
  const el = document.getElementById('file-list');

  if (!filtered.length) {
    el.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>Folder kosong</p><p style="font-size:12px">Klik Upload atau drag &amp; drop file ke sini</p></div>';
    return;
  }

  if (viewMode === 'grid') renderGrid(el, filtered);
  else renderList(el, filtered);
}

function renderGrid(el, items) {
  lastRendered = items;
  el.innerHTML = '<div class="file-grid">' +
    items.map((item, idx) => {
      const icon = getIconEmoji(item.icon);
      return \`<div class="file-card\${selected.has(item.name) ? ' selected' : ''}"
        data-action="select" data-idx="\${idx}"
        title="\${esc(item.name)}">
        <div class="file-icon">\${icon}</div>
        <div class="file-name">\${esc(item.name)}</div>
        <div class="file-meta">\${esc(item.sizeFormatted || '')}</div>
        <div class="file-actions">
          \${!item.isDir ? \`<button class="file-act-btn" data-action="download" data-idx="\${idx}" title="Download">⬇</button>
          <button class="file-act-btn" data-action="preview" data-idx="\${idx}" title="Preview">👁</button>\` : ''}
          <button class="file-act-btn" data-action="copy" data-idx="\${idx}" title="Copy">📋</button>
          <button class="file-act-btn" data-action="cut" data-idx="\${idx}" title="Cut">✂</button>
          <button class="file-act-btn" data-action="rename" data-idx="\${idx}" title="Rename">✏</button>
          <button class="file-act-btn del" data-action="delete" data-idx="\${idx}" title="Delete">🗑</button>
        </div>
      </div>\`;
    }).join('') + '</div>';
}

function renderList(el, items) {
  lastRendered = items;
  el.innerHTML = \`<table class="file-table">
    <thead><tr>
      <th style="width:40px"><input type="checkbox" data-action="select-all"></th>
      <th>Nama</th><th>Ukuran</th><th>Diubah</th><th style="width:150px">Aksi</th>
    </tr></thead>
    <tbody>\${items.map((item, idx) => {
      const icon = getIconEmoji(item.icon);
      const mod = item.modified ? new Date(item.modified).toLocaleDateString('id-ID') : '—';
      return \`<tr class="\${selected.has(item.name) ? 'selected' : ''}">
        <td><input type="checkbox" \${selected.has(item.name) ? 'checked' : ''}
          data-action="select-check" data-idx="\${idx}"></td>
        <td><div class="file-row-name" data-action="select" data-idx="\${idx}">
          <span class="file-row-icon">\${icon}</span> \${esc(item.name)}
        </div></td>
        <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">\${esc(item.sizeFormatted || '')}</td>
        <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">\${esc(mod)}</td>
        <td><div class="row-actions">
          \${!item.isDir ? \`<button class="btn sm" data-action="download" data-idx="\${idx}">⬇</button>
          <button class="btn sm" data-action="preview" data-idx="\${idx}">👁</button>\` : ''}
          <button class="btn sm" data-action="copy" data-idx="\${idx}" title="Copy">📋</button>
          <button class="btn sm" data-action="cut" data-idx="\${idx}" title="Cut">✂</button>
          <button class="btn sm danger" data-action="delete" data-idx="\${idx}">🗑</button>
        </div></td>
      </tr>\`;
    }).join('')}</tbody>
  </table>\`;
}

// ─── OPEN ITEM ────────────────────────────────────────────────────────────────
function openItem(name, isDir) {
  if (isDir) {
    loadDir(currentPath ? currentPath + '/' + name : name);
  } else {
    const rel = (currentPath ? currentPath + '/' : '') + name;
    const item = allItems.find(i => i.name === name);
    previewFile(null, item, rel);
  }
}

// ─── SELECTION ────────────────────────────────────────────────────────────────
function toggleSelect(e, name) {
  if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
  if (e.ctrlKey || e.metaKey) {
    selected.has(name) ? selected.delete(name) : selected.add(name);
  } else {
    if (selected.has(name) && selected.size === 1) selected.clear();
    else { selected.clear(); selected.add(name); }
  }
  updateSelectionUI();
  renderFiles(allItems);
}

function toggleSelectCheck(e, name) {
  e.target.checked ? selected.add(name) : selected.delete(name);
  updateSelectionUI();
  renderFiles(allItems);
}

function selectAll(checked) {
  if (checked) allItems.forEach(i => selected.add(i.name));
  else selected.clear();
  updateSelectionUI();
  renderFiles(allItems);
}

function updateSelectionUI() {
  const n = selected.size;
  const btn = document.getElementById('btn-delete-sel');
  const sel = document.getElementById('status-sel');
  btn.style.display = n > 0 ? '' : 'none';
  sel.style.display = n > 0 ? '' : 'none';
  sel.textContent = n + ' selected';
}

async function deleteSelected() {
  if (!selected.size) return;
  if (!confirm(\`Hapus \${selected.size} item?\`)) return;
  let failed = 0;
  for (const name of [...selected]) {
    const rel = (currentPath ? currentPath + '/' : '') + name;
    try {
      const r = await fetch('/api/delete', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: rel }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) failed++;
    } catch { failed++; }
  }
  selected.clear();
  if (failed) showToast(\`Selesai dengan \${failed} gagal dihapus\`, true);
  else showToast('Deleted!');
  loadDir(currentPath);
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
function openUpload() { document.getElementById('file-input').click(); }

async function uploadFiles(files) {
  if (!files.length) return;
  const toast = showUploadToast(files.length);
  const fd = new FormData();
  for (const f of files) fd.append('files', f);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload?path=' + encodeURIComponent(currentPath));
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) {
      const pct = Math.round(e.loaded / e.total * 100);
      toast.querySelector('.progress-fill').style.width = pct + '%';
      toast.querySelector('.pct').textContent = pct + '%';
    }
  };
  xhr.onload = () => {
    toast.remove();
    try {
      if (xhr.status >= 200 && xhr.status < 300) {
        const d = JSON.parse(xhr.responseText || '{}');
        if (d.ok) { showToast('Upload selesai!'); loadDir(currentPath); return; }
        showToast('Upload gagal: ' + (d.error || ('HTTP ' + xhr.status)), true);
      } else {
        let msg = 'HTTP ' + xhr.status;
        try { msg = (JSON.parse(xhr.responseText || '{}').error) || msg; } catch {}
        showToast('Upload gagal: ' + msg, true);
      }
    } catch {
      showToast('Upload gagal: HTTP ' + xhr.status, true);
    }
    loadDir(currentPath);
  };
  xhr.onerror = () => { toast.remove(); showToast('Upload gagal!', true); };
  xhr.send(fd);
  document.getElementById('file-input').value = '';
}

function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const files = e.dataTransfer ? e.dataTransfer.files : null;
  if (!files || !files.length) {
    showToast('Tidak ada file yang di-drop (drop folder belum didukung)', true);
    return;
  }
  uploadFiles(files);
}

document.getElementById('file-area').addEventListener('dragover', e => {
  e.preventDefault(); e.currentTarget.classList.add('drag-over');
});
document.getElementById('file-area').addEventListener('dragleave', e => {
  e.currentTarget.classList.remove('drag-over');
});
document.getElementById('file-area').addEventListener('drop', handleDrop);

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────
function downloadFile(e, rel) {
  e && e.stopPropagation();
  window.open('/api/file?path=' + encodeURIComponent(rel) + '&dl=1');
}

// ─── DELETE ───────────────────────────────────────────────────────────────────
async function deleteItem(e, rel) {
  e && e.stopPropagation();
  const name = rel.split('/').pop();
  if (!confirm('Hapus "' + name + '"?')) return;
  const r = await fetch('/api/delete', {
    method: 'DELETE', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ path: rel })
  });
  const d = await r.json();
  if (d.ok) { showToast('Deleted!'); loadDir(currentPath); }
  else showToast('Error: ' + d.error, true);
}

// ─── RENAME ───────────────────────────────────────────────────────────────────
function renameItem(e, name) {
  e && e.stopPropagation();
  const oldPath = (currentPath ? currentPath + '/' : '') + name;
  showModal('Rename', name, async (newName) => {
    if (!newName || newName === name) return;
    const r = await fetch('/api/rename', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ oldPath, newName })
    });
    const d = await r.json();
    if (d.ok) { showToast('Renamed!'); loadDir(currentPath); }
    else showToast('Error: ' + d.error, true);
  });
}

// ─── MKDIR ────────────────────────────────────────────────────────────────────
function openMkdir() {
  showModal('New Folder', 'New Folder', async (name) => {
    if (!name) return;
    const r = await fetch('/api/mkdir', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: currentPath, name })
    });
    const d = await r.json();
    if (d.ok) { showToast('Folder dibuat!'); loadDir(currentPath); }
    else showToast('Error: ' + d.error, true);
  });
}

// ─── PREVIEW ─────────────────────────────────────────────────────────────────
function previewFile(e, item, rel) {
  e && e.stopPropagation();
  if (!item) return;
  const icon = item.icon;
  const fileUrl = '/api/file?path=' + encodeURIComponent(rel);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal preview-modal';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px';
  const titleEl = document.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  titleEl.textContent = item.name;
  const btnWrap = document.createElement('div');
  btnWrap.style.cssText = 'display:flex;gap:8px;flex-shrink:0';
  const dlBtn = document.createElement('button');
  dlBtn.className = 'btn sm';
  dlBtn.textContent = '⬇ Download';
  dlBtn.onclick = (ev) => downloadFile(ev, rel);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn sm';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => overlay.remove();
  btnWrap.appendChild(dlBtn);
  btnWrap.appendChild(closeBtn);
  header.appendChild(titleEl);
  header.appendChild(btnWrap);
  modal.appendChild(header);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'preview-body';
  modal.appendChild(bodyEl);
  overlay.appendChild(modal);
  overlay.onclick = ev => { if (ev.target === overlay) overlay.remove(); };

  if (icon === 'image') {
    const img = document.createElement('img');
    img.src = fileUrl;
    img.alt = item.name;
    bodyEl.appendChild(img);
  } else if (icon === 'video') {
    const vid = document.createElement('video');
    vid.controls = true;
    vid.autoplay = true;
    vid.style.cssText = 'max-width:100%;border-radius:6px';
    const src = document.createElement('source');
    src.src = fileUrl;
    vid.appendChild(src);
    bodyEl.appendChild(vid);
  } else if (icon === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'pdf-frame';
    frame.src = fileUrl;
    bodyEl.appendChild(frame);
  } else if (['text','code'].includes(icon)) {
    const pre = document.createElement('pre');
    pre.id = 'preview-text';
    pre.textContent = 'Loading...';
    bodyEl.appendChild(pre);
    setTimeout(async () => {
      try {
        const r = await fetch('/api/read?path=' + encodeURIComponent(rel));
        const d = await r.json();
        pre.textContent = d.ok ? d.content : ('Cannot read file: ' + (d.error || ''));
      } catch (err) {
        pre.textContent = 'Cannot read file';
      }
    }, 50);
  } else {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'text-align:center;padding:32px;color:var(--muted)';
    const big = document.createElement('div');
    big.style.cssText = 'font-size:48px;margin-bottom:12px';
    big.textContent = getIconEmoji(icon);
    const txt = document.createElement('div');
    txt.textContent = 'Preview tidak tersedia untuk tipe file ini.';
    const br = document.createElement('br');
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = '⬇ Download';
    btn.onclick = (ev) => downloadFile(ev, rel);
    wrap.appendChild(big);
    wrap.appendChild(txt);
    wrap.appendChild(br);
    wrap.appendChild(btn);
    bodyEl.appendChild(wrap);
  }

  document.body.appendChild(overlay);
}

// ─── PAPAN (shared editor, realtime) ──────────────────────────────────────────
function boardUserInit() {
  try {
    const saved = JSON.parse(localStorage.getItem('nas-board-user') || 'null');
    if (saved && saved.name) {
      myBoardName = String(saved.name).slice(0, 30) || 'User';
      myBoardColor = saved.color || myBoardColor;
    } else {
      myBoardName = 'User-' + Math.floor(1000 + Math.random() * 9000);
      const palette = ['#4f8ef7', '#3dd68c', '#f5c542', '#f7584f', '#7c5af5', '#e67e22'];
      myBoardColor = palette[Math.floor(Math.random() * palette.length)];
      try { localStorage.setItem('nas-board-user', JSON.stringify({ name: myBoardName, color: myBoardColor })); } catch (e) {}
    }
  } catch (e) {
    myBoardName = 'User';
  }
  const inp = document.getElementById('board-username');
  if (inp) {
    inp.value = myBoardName;
    inp.onchange = function () {
      const v = inp.value.trim().slice(0, 30);
      if (!v) { inp.value = myBoardName; return; }
      myBoardName = v;
      try { localStorage.setItem('nas-board-user', JSON.stringify({ name: myBoardName, color: myBoardColor })); } catch (e) {}
      if (boardWS && boardWS.readyState === 1 && activeBoard) sendBoardJoin();
    };
  }
  const ed = document.getElementById('board-editor');
  if (ed) {
    ed.addEventListener('input', function () {
      const now = Date.now();
      if (now - boardTypingSent > 1500 && boardWS && boardWS.readyState === 1 && activeBoard) {
        boardTypingSent = now;
        try { boardWS.send(JSON.stringify({ type: 'typing' })); } catch (e) {}
      }
      if (boardSendTimer) clearTimeout(boardSendTimer);
      boardSendTimer = setTimeout(sendBoardUpdate, 400);
    });
  }
  const bl = document.getElementById('board-list');
  if (bl) {
    bl.addEventListener('click', function (e) {
      const del = e.target.closest('[data-del]');
      if (del && bl.contains(del)) {
        e.stopPropagation();
        deleteBoard(del.getAttribute('data-del') || '');
        return;
      }
      const it = e.target.closest('[data-board]');
      if (it && bl.contains(it)) openBoard(it.getAttribute('data-board') || '');
    });
  }
}

function switchAppView(v) {
  boardViewOpen = (v === 'boards');
  document.getElementById('nav-files').classList.toggle('active', !boardViewOpen);
  document.getElementById('nav-boards').classList.toggle('active', boardViewOpen);
  const toolbar = document.querySelector('.toolbar');
  const fileArea = document.getElementById('file-area');
  const statusbar = document.getElementById('files-statusbar');
  const boardView = document.getElementById('board-view');
  const crumb = document.getElementById('breadcrumb');
  if (boardViewOpen) {
    if (toolbar) toolbar.style.display = 'none';
    if (fileArea) fileArea.style.display = 'none';
    if (statusbar) statusbar.style.display = 'none';
    if (crumb) crumb.style.display = 'none';
    boardView.classList.add('open');
    loadBoards();
    connectBoardWS();
  } else {
    if (toolbar) toolbar.style.display = '';
    if (fileArea) fileArea.style.display = '';
    if (statusbar) statusbar.style.display = '';
    if (crumb) crumb.style.display = '';
    boardView.classList.remove('open');
    if (boardWS) { try { boardWS.close(); } catch (e) {} boardWS = null; }
    if (boardReconnectTimer) { clearTimeout(boardReconnectTimer); boardReconnectTimer = null; }
  }
}

async function loadBoards() {
  try {
    const r = await fetch('/api/boards');
    const d = await r.json();
    if (!d.ok) { showToast('Error: ' + d.error, true); return; }
    boardList = d.boards || [];
    renderBoardList();
  } catch (err) {
    showToast('Network error', true);
  }
}

function renderBoardList() {
  const el = document.getElementById('board-list');
  el.textContent = '';
  if (!boardList.length) {
    const p = document.createElement('div');
    p.style.cssText = 'padding:12px;font-size:12px;color:var(--muted);text-align:center';
    p.textContent = 'Belum ada papan. Buat satu!';
    el.appendChild(p);
    return;
  }
  boardList.forEach(function (b) {
    const it = document.createElement('div');
    it.className = 'board-item' + (b.name === activeBoard ? ' active' : '');
    it.setAttribute('data-board', b.name);
    const dot = document.createElement('span');
    dot.textContent = '📝';
    const nm = document.createElement('span');
    nm.className = 'bname';
    nm.textContent = b.name;
    const del = document.createElement('button');
    del.className = 'bdel';
    del.title = 'Hapus papan';
    del.textContent = '🗑';
    del.setAttribute('data-del', b.name);
    it.appendChild(dot);
    it.appendChild(nm);
    it.appendChild(del);
    el.appendChild(it);
  });
}

function createBoard() {
  showModal('Papan Baru', 'Papan-1', async function (name) {
    if (!name) return;
    try {
      const r = await fetch('/api/boards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
      });
      const d = await r.json();
      if (d.ok) { showToast('Papan dibuat!'); loadBoards(); openBoard(d.name); }
      else showToast('Error: ' + d.error, true);
    } catch (err) {
      showToast('Network error', true);
    }
  });
}

async function deleteBoard(name) {
  if (!name) return;
  if (!confirm('Hapus papan "' + name + '"?')) return;
  try {
    const r = await fetch('/api/boards', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    const d = await r.json();
    if (d.ok) {
      showToast('Papan dihapus!');
      if (activeBoard === name) {
        activeBoard = '';
        document.getElementById('board-title').textContent = 'Pilih papan';
        const ed = document.getElementById('board-editor');
        ed.value = '';
        ed.disabled = true;
      }
      loadBoards();
    } else showToast('Error: ' + d.error, true);
  } catch (err) {
    showToast('Network error', true);
  }
}

function openBoard(name) {
  if (!name) return;
  activeBoard = name;
  boardVersion = 0;
  document.getElementById('board-title').textContent = name;
  const ed = document.getElementById('board-editor');
  ed.value = '';
  ed.disabled = true;
  setBoardStatus('Menghubungkan...');
  renderBoardList();
  connectBoardWS();
}

function boardWSUrl() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws-board';
}

function connectBoardWS() {
  if (!boardViewOpen) return;
  if (boardWS && (boardWS.readyState === 0 || boardWS.readyState === 1)) {
    if (activeBoard) sendBoardJoin();
    return;
  }
  let ws;
  try {
    ws = new WebSocket(boardWSUrl());
  } catch (e) {
    setBoardStatus('Gagal konek');
    return;
  }
  boardWS = ws;
  ws.onopen = function () {
    setBoardStatus('Terhubung');
    if (activeBoard) sendBoardJoin();
  };
  ws.onmessage = function (ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'state') {
      if (msg.board !== activeBoard) return;
      boardVersion = msg.version || 0;
      const ed = document.getElementById('board-editor');
      ed.value = typeof msg.content === 'string' ? msg.content : '';
      ed.disabled = false;
      renderBoardUsers(msg.users || []);
      setBoardStatus('Sinkron');
    } else if (msg.type === 'update') {
      if (typeof msg.version !== 'number' || msg.version <= boardVersion) return;
      boardVersion = msg.version;
      const ed = document.getElementById('board-editor');
      const s = ed.selectionStart;
      const epos = ed.selectionEnd;
      ed.value = typeof msg.content === 'string' ? msg.content : '';
      try {
        ed.setSelectionRange(Math.min(s, ed.value.length), Math.min(epos, ed.value.length));
      } catch (e2) {}
      const t = document.getElementById('board-typing');
      if (t) t.textContent = '';
      setBoardStatus('Sinkron');
    } else if (msg.type === 'roster') {
      renderBoardUsers(msg.users || []);
    } else if (msg.type === 'typing') {
      const t = document.getElementById('board-typing');
      if (t && msg.name) {
        t.textContent = msg.name + ' sedang mengetik...';
        if (boardTypingClear) clearTimeout(boardTypingClear);
        boardTypingClear = setTimeout(function () { t.textContent = ''; }, 2500);
      }
    } else if (msg.type === 'board-deleted') {
      showToast('Papan dihapus oleh pengguna lain', true);
      activeBoard = '';
      document.getElementById('board-title').textContent = 'Pilih papan';
      const ed = document.getElementById('board-editor');
      ed.value = '';
      ed.disabled = true;
      loadBoards();
    } else if (msg.type === 'error') {
      showToast('Papan: ' + (msg.error || 'error'), true);
    }
  };
  ws.onclose = function () {
    if (boardWS === ws) boardWS = null;
    if (!boardViewOpen) return;
    setBoardStatus('Terputus, menyambung ulang...');
    if (boardReconnectTimer) clearTimeout(boardReconnectTimer);
    boardReconnectTimer = setTimeout(connectBoardWS, 2000);
  };
  ws.onerror = function () {
    try { ws.close(); } catch (e) {}
  };
}

function sendBoardJoin() {
  if (!boardWS || boardWS.readyState !== 1 || !activeBoard) return;
  try {
    boardWS.send(JSON.stringify({ type: 'join', board: activeBoard, name: myBoardName, color: myBoardColor }));
  } catch (e) {}
}

function sendBoardUpdate() {
  if (!boardWS || boardWS.readyState !== 1 || !activeBoard) return;
  const ed = document.getElementById('board-editor');
  if (ed.value.length > 1024 * 1024) {
    showToast('Papan melebihi 1MB, tidak dikirim', true);
    return;
  }
  try {
    boardWS.send(JSON.stringify({ type: 'update', content: ed.value }));
    setBoardStatus('Mengirim...');
  } catch (e) {}
}

function setBoardStatus(s) {
  const el = document.getElementById('board-status');
  if (el) el.textContent = s;
}

function renderBoardUsers(users) {
  const el = document.getElementById('board-users');
  el.textContent = '';
  (users || []).forEach(function (u) {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    const dot = document.createElement('span');
    dot.className = 'user-dot';
    dot.style.background = u.color || '#4f8ef7';
    const nm = document.createElement('span');
    nm.textContent = u.name || 'Anon';
    chip.appendChild(dot);
    chip.appendChild(nm);
    el.appendChild(chip);
  });
}

// ─── FILTER ───────────────────────────────────────────────────────────────────
function filterFiles() { renderFiles(allItems); }

// ─── VIEW MODE ────────────────────────────────────────────────────────────────
function setView(mode) {
  viewMode = mode;
  document.getElementById('btn-grid').classList.toggle('active', mode === 'grid');
  document.getElementById('btn-list').classList.toggle('active', mode === 'list');
  renderFiles(allItems);
}

// ─── MODAL ────────────────────────────────────────────────────────────────────
function showModal(title, defaultVal, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal';
  const titleEl = document.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'modal-input';
  input.value = String(defaultVal == null ? '' : defaultVal);
  input.autofocus = true;
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => overlay.remove();
  const okBtn = document.createElement('button');
  okBtn.className = 'btn primary';
  okBtn.id = 'modal-ok';
  okBtn.textContent = 'OK';
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  box.appendChild(titleEl);
  box.appendChild(input);
  box.appendChild(actions);
  overlay.appendChild(box);
  okBtn.onclick = () => {
    const val = input.value.trim();
    overlay.remove();
    onConfirm(val);
  };
  input.onkeydown = e => {
    if (e.key === 'Enter') okBtn.click();
    if (e.key === 'Escape') overlay.remove();
  };
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  setTimeout(() => {
    input.focus(); input.select();
  }, 50);
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.borderColor = isError ? 'var(--red)' : 'var(--green)';
  t.textContent = (isError ? '❌ ' : '✅ ') + msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function showUploadToast(count) {
  const t = document.createElement('div');
  t.className = 'upload-toast';
  t.innerHTML = \`<div class="title">⬆ Uploading \${count} file(s)</div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)">
      <span>Progress</span><span class="pct">0%</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>\`;
  document.body.appendChild(t);
  return t;
}

// ─── ICONS ────────────────────────────────────────────────────────────────────
function getIconEmoji(type) {
  const m = {
    folder: '📁', image: '🖼', video: '🎬', audio: '🎵',
    pdf: '📄', code: '💻', text: '📝', archive: '🗜',
    word: '📘', excel: '📗', ppt: '📙', file: '📎'
  };
  return m[type] || '📎';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
</script>
</body>
</html>`;

// ─── PAPAN REALTIME (WebSocket) ───────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

function boardRoster(state) {
  const users = [];
  for (const ws of state.clients) {
    if (ws.readyState === 1 && ws._boardUser) users.push(ws._boardUser);
  }
  return users;
}

function broadcastBoard(clean, state, exceptWs, msg) {
  const data = JSON.stringify(msg);
  for (const ws of state.clients) {
    if (ws !== exceptWs && ws.readyState === 1) {
      try { ws.send(data); } catch {}
    }
  }
}

wss.on('connection', (ws) => {
  ws._board = null;
  ws._lastUpdate = 0;

  ws.on('message', (raw) => {
    let msg;
    try {
      if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
      const text = raw.toString('utf8');
      if (text.length > 2 * 1024 * 1024) return;
      msg = JSON.parse(text);
    } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // --- join papan ---
    if (msg.type === 'join') {
      try {
        if (typeof msg.board !== 'string') throw new Error('Invalid board');
        const { clean, full } = resolveBoardFile(msg.board);
        if (!fs.existsSync(full)) {
          try { ws.send(JSON.stringify({ type: 'error', error: 'Board not found' })); } catch {}
          return;
        }
        const loaded = loadBoardState(msg.board);
        // pindah board: keluarkan dari board lama
        if (ws._board && ws._board !== loaded.clean) {
          const prev = boardCache.get(ws._board);
          if (prev) {
            prev.clients.delete(ws);
            broadcastBoard(ws._board, prev, ws, { type: 'roster', users: boardRoster(prev) });
          }
        }
        ws._board = loaded.clean;
        const name = String(msg.name || 'Anon').slice(0, 30) || 'Anon';
        const color = /^#[0-9a-fA-F]{6}$/.test(msg.color || '') ? msg.color : '#4f8ef7';
        ws._boardUser = { name, color };
        loaded.state.clients.add(ws);
        try {
          ws.send(JSON.stringify({
            type: 'state', board: loaded.clean,
            content: loaded.state.content, version: loaded.state.version,
            users: boardRoster(loaded.state)
          }));
        } catch {}
        broadcastBoard(loaded.clean, loaded.state, ws, { type: 'roster', users: boardRoster(loaded.state) });
      } catch (e) {
        try { ws.send(JSON.stringify({ type: 'error', error: e.message })); } catch {}
      }
      return;
    }

    if (!ws._board) return;
    const cached = boardCache.get(ws._board);
    if (!cached) return;
    const state = cached;

    // --- update isi (last-write-wins + version, debounce di client) ---
    if (msg.type === 'update') {
      const now = Date.now();
      if (now - ws._lastUpdate < 100) return; // rate limit: abaikan spam
      ws._lastUpdate = now;
      if (typeof msg.content !== 'string' || msg.content.length > MAX_BOARD_BYTES) return;
      state.content = msg.content;
      state.version++;
      const { full } = resolveBoardFile(ws._board);
      scheduleBoardSave(ws._board, full, state);
      broadcastBoard(ws._board, state, ws, {
        type: 'update', content: state.content, version: state.version
      });
      return;
    }

    // --- indikator mengetik ---
    if (msg.type === 'typing') {
      if (!ws._boardUser) return;
      broadcastBoard(ws._board, state, ws, {
        type: 'typing', name: ws._boardUser.name
      });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws._board) return;
    const cached = boardCache.get(ws._board);
    if (!cached) return;
    cached.clients.delete(ws);
    // simpan langsung saat user terakhir pergi
    if (cached.clients.size === 0) {
      if (cached.saveTimer) {
        clearTimeout(cached.saveTimer);
        cached.saveTimer = null;
      }
      try {
        const { full } = resolveBoardFile(ws._board);
        const tmp = full + '.tmp';
        fs.writeFileSync(tmp, cached.content, 'utf8');
        fs.renameSync(tmp, full);
      } catch {}
    } else {
      broadcastBoard(ws._board, cached, ws, { type: 'roster', users: boardRoster(cached) });
    }
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('\n🚀 NAS Drive berjalan!\n');
  console.log('  Local:   http://localhost:' + PORT);
  ips.forEach(ip => console.log('  Network: http://' + ip + ':' + PORT));
  console.log('\n📁 Storage root: ' + STORAGE_ROOT);
  console.log('\n📝 Boards root: ' + BOARDS_ROOT);
  console.log('\nBagi IP Network ke perangkat lain di jaringan yang sama.\n');
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws-board' || (req.url && req.url.startsWith('/ws-board?'))) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

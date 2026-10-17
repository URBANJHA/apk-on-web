// Cloud APK Runner - MVP
// Browser <-> Node server <-> ADB <-> Android (Redroid container)
const express = require('express');
const multer = require('multer');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ADB_HOST = process.env.ADB_HOST || 'localhost:5555';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || ''; // set this on any public server!
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
  fileFilter: (_req, file, cb) =>
    cb(null, file.originalname.toLowerCase().endsWith('.apk')),
});

// ---------- ADB helpers (execFile = no shell injection) ----------
function adb(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('adb', ['-s', ADB_HOST, ...args],
      { maxBuffer: 32 * 1024 * 1024, timeout: 120000, ...opts },
      (err, stdout, stderr) =>
        err ? reject(new Error(stderr?.toString() || err.message)) : resolve(stdout));
  });
}

function connectAdb() {
  return new Promise((resolve) => {
    execFile('adb', ['connect', ADB_HOST], (err, out) => {
      console.log('[adb connect]', (out || err?.message || '').toString().trim());
      resolve();
    });
  });
}

const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
const num = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;

// ---------- Auth ----------
function authed(token) { return !ACCESS_TOKEN || token === ACCESS_TOKEN; }
function authMiddleware(req, res, next) {
  if (authed(req.get('x-access-token'))) return next();
  res.status(401).json({ error: 'Invalid access token' });
}

// ---------- HTTP API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', authMiddleware, async (_req, res) => {
  try {
    const size = (await adb(['shell', 'wm', 'size'])).match(/(\d+)x(\d+)/);
    res.json({ online: true, width: +size[1], height: +size[2] });
  } catch (e) { res.json({ online: false, error: e.message }); }
});

app.post('/api/upload', authMiddleware, upload.single('apk'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Only .apk files are allowed' });
  try {
    const out = await adb(['install', '-r', '-t', req.file.path]);
    res.json({ ok: /Success/.test(out), output: out.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

app.get('/api/apps', authMiddleware, async (_req, res) => {
  try {
    const out = await adb(['shell', 'pm', 'list', 'packages', '-3']);
    res.json({
      packages: out.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/launch', authMiddleware, async (req, res) => {
  const pkg = req.body?.pkg;
  if (!PKG_RE.test(pkg || '')) return res.status(400).json({ error: 'Bad package name' });
  try {
    await adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/uninstall', authMiddleware, async (req, res) => {
  const pkg = req.body?.pkg;
  if (!PKG_RE.test(pkg || '')) return res.status(400).json({ error: 'Bad package name' });
  try { res.json({ ok: true, output: (await adb(['uninstall', pkg])).trim() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- WebSocket: screen stream + input ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token') || '';
  if (!authed(token)) return ws.close(4401, 'unauthorized');

  let alive = true;
  ws.on('close', () => { alive = false; });

  // Screen loop: PNG screenshots over WebSocket (simple; swap for scrcpy/WebRTC later)
  (async function loop() {
    while (alive) {
      const t0 = Date.now();
      try {
        const png = await adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
        if (alive && ws.readyState === 1 && png.length > 100) ws.send(png);
      } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
      const spent = Date.now() - t0;
      await new Promise(r => setTimeout(r, Math.max(0, 120 - spent)));
    }
  })();

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (m.type === 'tap' && num(m.x, 0, 5000) && num(m.y, 0, 5000)) {
        await adb(['shell', 'input', 'tap', String(Math.round(m.x)), String(Math.round(m.y))]);
      } else if (m.type === 'swipe' && [m.x1, m.y1, m.x2, m.y2].every(v => num(v, 0, 5000))) {
        const d = num(m.ms, 50, 3000) ? Math.round(m.ms) : 300;
        await adb(['shell', 'input', 'swipe',
          ...[m.x1, m.y1, m.x2, m.y2].map(v => String(Math.round(v))), String(d)]);
      } else if (m.type === 'key' && ['BACK', 'HOME', 'APP_SWITCH', 'ENTER', 'DEL'].includes(m.key)) {
        await adb(['shell', 'input', 'keyevent', 'KEYCODE_' + m.key]);
      } else if (m.type === 'text' && typeof m.text === 'string' && /^[A-Za-z0-9 .,@_-]{1,100}$/.test(m.text)) {
        await adb(['shell', 'input', 'text', m.text.replace(/ /g, '%s')]);
      }
    } catch (e) { console.error('[input error]', e.message); }
  });
});

connectAdb().then(() =>
  server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`)));

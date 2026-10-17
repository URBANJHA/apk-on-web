const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('token') || '';
let ws = null, dev = { width: 720, height: 1280 }, retry = null, wantLive = false;
let frames = 0, tapAt = 0;

const api = (url, opt = {}) =>
  fetch(url, { ...opt, headers: { ...(opt.headers || {}), 'x-access-token': token } });
const post = (url, body) => api(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---------- UI helpers ----------
function pill(kind, text) { const p = $('pill'); p.className = 'pill ' + kind; p.textContent = text; }
function setState(text) { $('state').hidden = false; $('state').innerHTML = text; $('screen').hidden = true; }
function say(text, cls = '') { $('msg').textContent = text; $('msg').className = 'msg ' + cls; }
function log(text, cls = '') {
  const ol = $('log');
  if (ol.firstChild && ol.firstChild.textContent === 'Nothing yet.') ol.innerHTML = '';
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = new Date().toLocaleTimeString() + '  ' + text;
  ol.prepend(li);
  while (ol.children.length > 60) ol.lastChild.remove();
}
$('clear').onclick = () => { $('log').innerHTML = '<li>Nothing yet.</li>'; };

// ---------- Connection ----------
async function connect() {
  token = $('token').value; sessionStorage.setItem('token', token);
  wantLive = true; pill('wait', 'Connecting');
  try {
    const r = await api('/api/status');
    if (r.status === 401) { wantLive = false; pill('off', 'Offline'); setState('Wrong access token.'); return log('Wrong access token', 'err'); }
    const s = await r.json();
    if (!s.online) { wantLive = false; pill('off', 'Android offline'); setState('Android is not reachable.<br>' + (s.error || '')); return log('Android offline: ' + (s.error || ''), 'err'); }
    dev = s; $('size').textContent = s.width + ' x ' + s.height;
    openStream(); loadApps();
  } catch (e) { wantLive = false; pill('off', 'Offline'); setState('Cannot reach the server.'); log('Server unreachable', 'err'); }
}

function openStream() {
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/stream?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'blob';
  ws.onopen = () => { pill('live', 'Live'); log('Connected', 'ok'); };
  ws.onmessage = (e) => {
    const img = $('screen'), old = img.src;
    img.src = URL.createObjectURL(e.data);
    img.hidden = false; $('state').hidden = true; frames++;
    if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    if (tapAt) { $('lat').textContent = (performance.now() - tapAt | 0) + ' ms'; tapAt = 0; }
  };
  ws.onclose = () => {
    pill(wantLive ? 'wait' : 'off', wantLive ? 'Reconnecting' : 'Offline');
    setState(wantLive ? 'Connection lost. Reconnecting...' : 'Disconnected.');
    if (wantLive) { clearTimeout(retry); retry = setTimeout(connect, 2000); }
  };
}
setInterval(() => { $('fps').textContent = frames ? frames + ' fps' : '-'; frames = 0; }, 1000);
$('connect').onclick = connect;
$('token').value = token;
$('token').addEventListener('keydown', (e) => e.key === 'Enter' && connect());

// ---------- Input: tap, swipe, keys, text ----------
const send = (o) => { if (ws && ws.readyState === 1) { tapAt = performance.now(); ws.send(JSON.stringify(o)); } };

function toDevice(ev) {   // pointer position -> device pixels (object-fit: contain)
  const r = $('screen').getBoundingClientRect();
  const k = Math.min(r.width / dev.width, r.height / dev.height);
  const w = dev.width * k, h = dev.height * k;
  const x = (ev.clientX - r.left - (r.width - w) / 2) / k;
  const y = (ev.clientY - r.top - (r.height - h) / 2) / k;
  return { x: Math.max(0, Math.min(dev.width, x)), y: Math.max(0, Math.min(dev.height, y)) };
}
let down = null;
const scr = $('screen');
scr.addEventListener('pointerdown', (e) => { down = { ...toDevice(e), t: Date.now() }; scr.setPointerCapture(e.pointerId); scr.focus(); });
scr.addEventListener('pointerup', (e) => {
  if (!down) return;
  const up = toDevice(e);
  if (Math.hypot(up.x - down.x, up.y - down.y) < 15) send({ type: 'tap', x: up.x, y: up.y });
  else send({ type: 'swipe', x1: down.x, y1: down.y, x2: up.x, y2: up.y, ms: Date.now() - down.t });
  down = null;
});
scr.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { Enter: 'ENTER', Backspace: 'DEL', Escape: 'BACK' };
  if (map[e.key]) { e.preventDefault(); send({ type: 'key', key: map[e.key] }); }
  else if (/^[A-Za-z0-9 .,@_-]$/.test(e.key)) { e.preventDefault(); send({ type: 'text', text: e.key }); }
});
document.querySelectorAll('[data-key]').forEach(b => b.onclick = () => send({ type: 'key', key: b.dataset.key }));
function sendText() { const t = $('text').value; if (t) { send({ type: 'text', text: t }); $('text').value = ''; } }
$('sendText').onclick = sendText;
$('text').addEventListener('keydown', (e) => e.key === 'Enter' && sendText());
$('shot').onclick = () => {
  if ($('screen').hidden) return log('No screen to save yet', 'err');
  const a = document.createElement('a');
  a.href = $('screen').src; a.download = 'android-' + Date.now() + '.png'; a.click();
};

// ---------- Apps ----------
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
async function loadApps() {
  const r = await api('/api/apps'); if (!r.ok) return;
  const { packages } = await r.json(), ul = $('apps'); ul.innerHTML = '';
  if (!packages.length) { ul.innerHTML = '<li class="empty">No apps yet. Install an APK above.</li>'; return; }
  packages.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="ico"></span><span class="name"></span><span class="acts"><button class="btn sm primary">Open</button><button class="btn sm ghost">Remove</button></span>';
    const last = p.split('.').pop();
    const ico = li.querySelector('.ico');
    ico.textContent = last[0].toUpperCase(); ico.style.background = `hsl(${hue(p)} 55% 42%)`;
    li.querySelector('.name').textContent = p;
    const [open, rm] = li.querySelectorAll('button');
    open.onclick = async () => { await post('/api/launch', { pkg: p }); log('Opened ' + p); };
    rm.onclick = async () => {
      if (!confirm('Remove ' + p + ' from the device?')) return;
      await post('/api/uninstall', { pkg: p }); log('Removed ' + p); loadApps();
    };
    ul.appendChild(li);
  });
}
$('refresh').onclick = loadApps;

// ---------- Upload (drag and drop, with progress) ----------
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), $('apk').click()));
$('apk').onchange = (e) => upload(e.target.files[0]);

function upload(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.apk')) return say('Only .apk files are allowed.', 'err');
  if (!wantLive) return say('Connect first, then upload.', 'err');
  const fd = new FormData(); fd.append('apk', file);
  const bar = $('bar'), fill = bar.firstElementChild, xhr = new XMLHttpRequest();
  bar.hidden = false; bar.classList.remove('busy'); fill.style.width = '0'; say('Uploading ' + file.name + '...');
  xhr.open('POST', '/api/upload'); xhr.setRequestHeader('x-access-token', token);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) fill.style.width = (e.loaded / e.total * 100) + '%'; };
  xhr.upload.onload = () => { bar.classList.add('busy'); say('Installing on the device...'); };
  xhr.onload = () => {
    bar.hidden = true; $('apk').value = '';
    let j = {}; try { j = JSON.parse(xhr.responseText); } catch {}
    if (j.ok) { say('Installed ' + file.name, 'ok'); log('Installed ' + file.name, 'ok'); loadApps(); }
    else { say(j.error || j.output || 'Install failed.', 'err'); log('Install failed: ' + file.name, 'err'); }
  };
  xhr.onerror = () => { bar.hidden = true; say('Upload failed. Check the connection.', 'err'); };
  xhr.send(fd);
}

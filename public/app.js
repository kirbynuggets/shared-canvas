import { Replica, uid } from '/src/crdt.js';
import { SyncClient } from '/src/sync-client.js';

const $ = (s) => document.querySelector(s);

/* =====================================================================
   Identity and room
   One client id per tab (sessionStorage) so two tabs are two replicas.
   ===================================================================== */
const params = new URLSearchParams(location.search);
let roomName = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
if (!roomName) { roomName = uid(6); history.replaceState(null, '', `?room=${roomName}`); }

const NAMES_A = ['Curious', 'Sleepy', 'Brave', 'Gentle', 'Swift', 'Cosy', 'Witty', 'Sunny', 'Quiet', 'Bold'];
const NAMES_B = ['Otter', 'Panda', 'Heron', 'Fox', 'Koala', 'Lynx', 'Robin', 'Moth', 'Yak', 'Finch'];
const PALETTE = ['#1d1b19', '#ff6b4a', '#f2a33a', '#2fb67c', '#3b82f6', '#a855f7'];
const PEER_COLORS = ['#ff6b4a', '#3b82f6', '#2fb67c', '#a855f7', '#f2a33a', '#ec4899', '#14b8a6', '#6366f1'];

function sessionValue(key, make) {
  let v = sessionStorage.getItem(key);
  if (!v) { v = make(); sessionStorage.setItem(key, v); }
  return v;
}
const me = {
  client: sessionValue('sc-client', () => uid(8)),
  name: sessionValue('sc-name', () => `${pick(NAMES_A)} ${pick(NAMES_B)}`),
  color: sessionValue('sc-color', () => pick(PEER_COLORS)),
};
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

/* =====================================================================
   Local persistence (IndexedDB): every op we know about, per room
   ===================================================================== */
const store = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('shared-canvas', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('ops');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  let queue = [], timer = null;
  const flush = async () => {
    timer = null; const batch = queue; queue = [];
    if (!batch.length) return;
    const db = await open(); const tx = db.transaction('ops', 'readwrite'); const st = tx.objectStore('ops');
    for (const op of batch) st.put(op, `${roomName}|${op.client}:${op.seq}`);
  };
  return {
    async load() {
      // never let a slow or blocked IndexedDB hold the board hostage
      return Promise.race([this.loadAll(), new Promise((r) => setTimeout(() => r([]), 1500))]);
    },
    async loadAll() {
      try {
        const db = await open();
        return await new Promise((res) => {
          const out = [], range = IDBKeyRange.bound(`${roomName}|`, `${roomName}|￿`);
          db.transaction('ops').objectStore('ops').openCursor(range).onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
        });
      } catch { return []; }
    },
    save(ops) { queue.push(...ops); if (!timer) timer = setTimeout(flush, 250); },
  };
})();

/* =====================================================================
   Replica + sync
   ===================================================================== */
const replica = new Replica(me.client);
const peers = new Map();          // client -> { name, color, x, y, el, sx, sy, seen }
let unsynced = 0;
const latencies = [];

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(roomName)}`;
const sync = new SyncClient({
  url: wsUrl,
  replica,
  profile: { name: me.name, color: me.color },
  onOps(ops, info) {
    store.save(ops);
    const t0 = performance.now();
    dirty = true;
    if (replica.visible().length) hideEmpty();
    if (!info.initial) {
      const now = Date.now();
      // only live edits count; ops that waited out an offline spell would swamp the number
      for (const op of ops) if (op.at && now - op.at < 1500) latencies.push(Math.max(0, now - op.at));
      if (latencies.length > 300) latencies.splice(0, latencies.length - 300);
    }
    const who = info.from && peers.get(info.from);
    lastMerge = `${ops.length} op${ops.length > 1 ? 's' : ''}${who ? ` from ${who.name}` : info.initial ? ' on sync' : ''} · ${(performance.now() - t0).toFixed(2)} ms`;
  },
  onPresence(p) {
    if (p.t === 'leave') { const peer = peers.get(p.client); if (peer) { peer.el.remove(); peers.delete(p.client); renderPeers(); } return; }
    if (p.client === me.client) return;
    let peer = peers.get(p.client);
    if (!peer) {
      const el = document.createElement('div');
      el.className = 'cursor';
      el.innerHTML = `<svg viewBox="0 0 18 18"><path d="M2 2l14 6-6 2-2 6z" fill="${p.color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span style="background:${p.color}">${escapeHtml(p.name)}</span>`;
      $('#cursors').appendChild(el);
      peer = { name: p.name, color: p.color, el, x: null, y: null, sx: null, sy: null, seen: 0 };
      peers.set(p.client, peer);
      renderPeers();
      if (sync.status === 'live') toast(`${p.name} joined`);
    }
    if (Number.isFinite(p.x)) { peer.x = p.x; peer.y = p.y; peer.seen = performance.now(); }
  },
  onStatus(s) {
    if (s === 'live') unsynced = 0;
    if (s !== 'live') { for (const p of peers.values()) p.el.remove(); peers.clear(); renderPeers(); }
    renderStatus();
  },
  onRtt(ms) { rtt = ms; },
});
let rtt = null, lastMerge = '-';

function emit(op) {
  op.at = Date.now();   // wall-clock stamp, only used to show end-to-end latency
  store.save([op]);
  if (sync.status === 'live') sync.push([op]); else if (op.kind !== 'points') unsynced += 1;   // count strokes and erases, not point chunks
  dirty = true;
  return op;
}

/* =====================================================================
   View: pan + zoom
   ===================================================================== */
const canvas = $('#board'), ctx = canvas.getContext('2d');
const view = { x: 0, y: 0, z: 1 };
let W = 0, H = 0, DPR = 1, dirty = true;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  dirty = true;
}
addEventListener('resize', resize);
resize();
const toWorld = (sx, sy) => [(sx - view.x) / view.z, (sy - view.y) / view.z];
const toScreen = (wx, wy) => [wx * view.z + view.x, wy * view.z + view.y];

/* =====================================================================
   Tools
   ===================================================================== */
let tool = 'pen', color = PALETTE[0], size = 5;
$('#colors').innerHTML = PALETTE.map((c, i) => `<button data-c="${c}" style="background:${c}" class="${i ? '' : 'on'}" title="Colour ${i + 1}" aria-label="Colour ${i + 1}"></button>`).join('');
$$('#colors button').forEach((b) => b.onclick = () => setColor(b.dataset.c));
$$('[data-tool]').forEach((b) => b.onclick = () => setTool(b.dataset.tool));
$('#size').oninput = (e) => setSize(+e.target.value);
function $$(s) { return [...document.querySelectorAll(s)]; }
function setTool(t) { tool = t; $$('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)); canvas.classList.toggle('erasing', t === 'eraser'); }
function setColor(c) { color = c; $$('#colors button').forEach((b) => b.classList.toggle('on', b.dataset.c === c)); if (tool !== 'pen') setTool('pen'); updateSizeDot(); }
function setSize(s) { size = Math.max(1, Math.min(40, s)); $('#size').value = size; updateSizeDot(); }
function updateSizeDot() { const d = $('#sizeDot'); d.style.setProperty('--d', Math.max(3, size * .9) + 'px'); d.style.setProperty('--c', color); }
updateSizeDot();

/* =====================================================================
   Drawing — points stream in small chunks so peers watch strokes appear live
   ===================================================================== */
let current = null, panning = null, flushTimer = null;
const redoStack = [];

/* touch: one finger draws, two fingers pan and pinch-zoom */
const touches = new Map();
let pinch = null;
function pinchState() {
  const [p, q] = [...touches.values()];
  return { mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2, d: Math.hypot(p.x - q.x, p.y - q.y) || 1, vx: view.x, vy: view.y, vz: view.z };
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      // a second finger means "move the board": drop the stroke the first finger just started
      if (current) { const id = current.id, tiny = replica.points(replica.strokes.get(id)).length + current.buf.length < 12; clearInterval(flushTimer); current = null; previewPts = null; if (tiny) emit(replica.deleteStroke(id)); else flushPoints(); }
      erasing = false;
      pinch = pinchState();
      return;
    }
    if (touches.size > 2) return;
  }
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || spaceDown) { panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; canvas.classList.add('panning'); return; }
  if (e.button !== 0) return;
  hideEmpty();
  if (tool === 'eraser') { erasing = true; eraseAt(e.clientX, e.clientY); return; }
  const id = uid(10);
  emit(replica.beginStroke(id, { color, width: size, tool: 'pen' }));
  redoStack.length = 0;
  current = { id, idx: 0, buf: [] };
  addPoint(e);
  flushTimer = setInterval(flushPoints, 40);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const n = pinchState(), z = Math.max(0.2, Math.min(5, pinch.vz * n.d / pinch.d));
      view.z = z;
      view.x = n.mx - (pinch.mx - pinch.vx) * (z / pinch.vz);
      view.y = n.my - (pinch.my - pinch.vy) * (z / pinch.vz);
      dirty = true;
      return;
    }
  }
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  sendPresence(wx, wy);
  if (panning) { view.x = panning.vx + e.clientX - panning.x; view.y = panning.vy + e.clientY - panning.y; dirty = true; return; }
  if (erasing) { eraseAt(e.clientX, e.clientY); return; }
  if (!current) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) addPoint(ev);
});
const endPointer = (e) => {
  if (e && e.pointerType === 'touch') { touches.delete(e.pointerId); if (pinch) { if (touches.size === 0) pinch = null; return; } }
  if (panning) { panning = null; canvas.classList.remove('panning'); }
  erasing = false;
  if (!current) return;
  flushPoints(); clearInterval(flushTimer); current = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function addPoint(e) {
  const [x, y] = toWorld(e.clientX, e.clientY);
  const last = current.buf[current.buf.length - 1] || current.last;
  if (last && Math.hypot(x - last[0], y - last[1]) < 0.6 / view.z) return;
  const p = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  current.buf.push(p); current.last = p;
  // draw the in-progress segment immediately for zero-latency feel
  dirty = true;
  previewPts = current;
}
let previewPts = null;
function flushPoints() {
  if (!current || !current.buf.length) return;
  emit(replica.addPoints(current.id, current.idx++, current.buf));
  current.buf = [];
}

/* eraser: delete any stroke whose path passes near the pointer */
let erasing = false;
function eraseAt(sx, sy) {
  const [x, y] = toWorld(sx, sy), r = 8 / view.z;
  for (const s of replica.visible()) {
    const pts = replica.points(s), hit = r + s.meta.width / 2;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[i + 1] || a;
      if (distToSegment(x, y, a, b) < hit) { emit(replica.deleteStroke(s.id)); break; }
    }
  }
}
function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  let t = l ? ((px - a[0]) * dx + (py - a[1]) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/* undo deletes your newest stroke; redo re-adds a copy under a new id (2P-set semantics) */
function undo() {
  const s = replica.lastStrokeBy(me.client); if (!s) return toast('Nothing of yours to undo');
  redoStack.push({ meta: { ...s.meta }, pts: [...replica.points(s)] });
  emit(replica.deleteStroke(s.id));
}
function redo() {
  const r = redoStack.pop(); if (!r) return;
  const id = uid(10);
  emit(replica.beginStroke(id, { color: r.meta.color, width: r.meta.width, tool: r.meta.tool }));
  for (let i = 0, k = 0; i < r.pts.length; i += 200, k++) emit(replica.addPoints(id, k, r.pts.slice(i, i + 200)));
}
let clearArmed = 0;
function clearBoard() {
  if (performance.now() - clearArmed > 2500) { clearArmed = performance.now(); $('#clear').classList.add('armed'); toast('Tap clear again to wipe the board for everyone'); setTimeout(() => $('#clear').classList.remove('armed'), 2500); return; }
  clearArmed = 0; $('#clear').classList.remove('armed');
  for (const s of replica.visible()) emit(replica.deleteStroke(s.id));
  toast('Board cleared');
}
$('#undo').onclick = undo; $('#redo').onclick = redo; $('#clear').onclick = clearBoard;

/* pan with wheel / two-finger scroll, zoom with ctrl or pinch */
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const z = Math.max(0.2, Math.min(5, view.z * Math.exp(-e.deltaY * 0.01)));
    view.x = e.clientX - (e.clientX - view.x) * (z / view.z); view.y = e.clientY - (e.clientY - view.y) * (z / view.z); view.z = z;
  } else { view.x -= e.deltaX; view.y -= e.deltaY; }
  dirty = true;
}, { passive: false });

let spaceDown = false;
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.key !== 'Escape') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod) return;
  if (e.key === ' ') { spaceDown = true; canvas.classList.add('panning'); }
  else if (e.key === 'p') setTool('pen');
  else if (e.key === 'e') setTool('eraser');
  else if (e.key === 'i') togglePanel();
  else if (e.key === '[') setSize(size - 2);
  else if (e.key === ']') setSize(size + 2);
  else if (/^[1-6]$/.test(e.key)) setColor(PALETTE[+e.key - 1]);
});
addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; canvas.classList.remove('panning'); } });

/* presence, throttled */
let lastPresence = 0;
function sendPresence(x, y) {
  const t = performance.now(); if (t - lastPresence < 40) return; lastPresence = t;
  sync.presence({ x: Math.round(x), y: Math.round(y), tool, drawing: !!current });
}

/* =====================================================================
   Rendering
   ===================================================================== */
const pathCache = new WeakMap();   // stroke -> { n, path }
function strokePath(pts) {
  const p = new Path2D();
  if (pts.length === 1) { p.moveTo(pts[0][0], pts[0][1]); p.lineTo(pts[0][0] + 0.01, pts[0][1]); return p; }
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    p.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const l = pts[pts.length - 1]; p.lineTo(l[0], l[1]);
  return p;
}
function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(DPR * view.z, 0, 0, DPR * view.z, DPR * view.x, DPR * view.y);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of replica.visible()) {
    let pts = replica.points(s);
    if (previewPts && s.id === previewPts.id && previewPts.buf.length) pts = pts.concat(previewPts.buf);
    if (!pts.length) continue;
    let c = pathCache.get(s);
    if (!c || c.n !== pts.length) { c = { n: pts.length, path: strokePath(pts) }; pathCache.set(s, c); }
    ctx.strokeStyle = s.meta.color; ctx.lineWidth = s.meta.width;
    ctx.stroke(c.path);
  }
  canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  canvas.style.backgroundSize = `${24 * view.z}px ${24 * view.z}px`;
}

function frame() {
  if (dirty) { draw(); dirty = false; }
  const t = performance.now();
  for (const p of peers.values()) {
    if (p.x == null) { p.el.style.opacity = 0; continue; }
    const [tx, ty] = toScreen(p.x, p.y);
    p.sx = p.sx == null ? tx : p.sx + (tx - p.sx) * 0.35;
    p.sy = p.sy == null ? ty : p.sy + (ty - p.sy) * 0.35;
    p.el.style.transform = `translate(${p.sx}px, ${p.sy}px)`;
    p.el.style.opacity = '';
    p.el.classList.toggle('idle', t - p.seen > 4000);
  }
  if (!$('#panel').hidden) renderPanel();
  requestAnimationFrame(frame);
}

/* =====================================================================
   UI chrome
   ===================================================================== */
function renderStatus() {
  const b = $('#status'), s = sync.status;
  b.className = `pill status ${s}`;
  b.querySelector('span').textContent =
    s === 'live' ? (rtt != null ? `live · ${Math.round(rtt)} ms` : 'live')
    : s === 'connecting' || s === 'idle' ? 'connecting…'
    : unsynced ? `offline · ${unsynced} change${unsynced > 1 ? 's' : ''} waiting` : 'offline';
}
setInterval(renderStatus, 1000);
$('#status').onclick = async () => {
  if (sync.wantOnline) { sync.disconnect(); toast('You are offline. Keep drawing, it will all merge later.'); }
  else {
    const waiting = unsynced;
    const r = await sync.connect();
    unsynced = 0;
    toast(`Back online · sent ${r.sent} op${r.sent === 1 ? '' : 's'}, received ${r.received}${waiting ? ' · merged with no conflicts' : ''}`);
  }
};
function renderPeers() {
  const all = [{ ...me, isMe: true }, ...[...peers.values()]];
  $('#peers').innerHTML = all.slice(0, 6).map((p) => `<b class="${p.isMe ? 'me' : ''}" style="background:${p.color}" title="${escapeHtml(p.name)}${p.isMe ? ' (you)' : ''}">${initials(p.name)}</b>`).join('') + (all.length > 6 ? `<b style="background:#77716a">+${all.length - 6}</b>` : '');
}
const initials = (n) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

$('#share').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('Link copied. Send it to someone and draw together'); }
  catch { toast(location.href); }
};
function togglePanel() { $('#panel').hidden = !$('#panel').hidden; $('#inspect').classList.toggle('on', !$('#panel').hidden); }
$('#inspect').onclick = togglePanel;
function renderPanel() {
  $('#pMe').textContent = `${me.name} · ${me.client}`;
  $('#pLamport').textContent = replica.lamport;
  $('#pOps').textContent = replica.ops.size.toLocaleString();
  $('#pStrokes').textContent = replica.visible().length;
  $('#pRtt').textContent = rtt != null && sync.status === 'live' ? `${rtt.toFixed(1)} ms` : '-';
  if (latencies.length) {
    const s = [...latencies].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    $('#pLat').textContent = `p50 ${q(.5)} · p95 ${q(.95)} ms`;
  }
  $('#pMerge').textContent = lastMerge;
  const sv = replica.stateVector();
  const html = Object.entries(sv).sort((a, b) => b[1] - a[1]).map(([c, n]) => {
    const peer = c === me.client ? me : peers.get(c);
    return `<li><span><b style="background:${peer ? peer.color : '#ccc'}"></b>${escapeHtml(peer ? peer.name : c)}</span><span>${n}</span></li>`;
  }).join('');
  if ($('#pSv').innerHTML !== html) $('#pSv').innerHTML = html;
}

/* zoom out just enough that everything already drawn is on screen (never zooms in) */
function fitToContent() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of replica.visible()) for (const [x, y] of replica.points(s)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (!Number.isFinite(x0)) return;
  const pad = 40, top = 80, bottom = 90;
  const z = Math.min(1, (W - pad * 2) / Math.max(1, x1 - x0), (H - top - bottom) / Math.max(1, y1 - y0));
  if (z >= 1 && x0 >= 0 && y0 >= top && x1 <= W && y1 <= H - bottom) return;
  view.z = z; view.x = (W - (x1 - x0) * z) / 2 - x0 * z; view.y = top + (H - top - bottom - (y1 - y0) * z) / 2 - y0 * z;
  dirty = true;
}

let tt;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2600); }
function hideEmpty() { $('#empty').classList.add('gone'); }

/* =====================================================================
   Boot: load local ops first (works fully offline), then sync
   ===================================================================== */
$('#roomName').textContent = `room ${roomName}`;
renderPeers();
(async () => {
  frame();
  const saved = await store.load();
  replica.merge(saved);
  if (replica.visible().length) hideEmpty();
  dirty = true;
  const r = await sync.connect();
  if (replica.visible().length) { hideEmpty(); fitToContent(); }
  if (r.received || r.sent) toast(`Synced · received ${r.received}, sent ${r.sent}`);
})();

// expose for debugging and demos
window.sharedCanvas = { replica, sync, me };
if (params.has('panel')) togglePanel();

/**
 * Shared Canvas server: static files + a WebSocket relay that is itself a replica.
 *
 * Each room is a Replica holding every op ever made in it, persisted as an
 * append-only JSON-lines log. The server never resolves conflicts; it only
 * stores ops and forwards new ones, because the CRDT makes every order safe.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Replica } from '../src/crdt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = { '/': 'public/index.html' };
const ALLOWED_DIRS = ['public', 'src'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const MAX_MSG_BYTES = 512 * 1024;
const MAX_OPS_PER_MSG = 500;

export function createServer({ port = 8787, dataDir = path.join(ROOT, 'data'), log = console.log } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rooms = new Map();

  function room(name) {
    let r = rooms.get(name);
    if (r) return r;
    r = { name, replica: new Replica('server'), peers: new Map(), file: path.join(dataDir, `${name}.jsonl`) };
    if (fs.existsSync(r.file)) {
      const lines = fs.readFileSync(r.file, 'utf8').split('\n');
      for (const line of lines) { if (!line) continue; try { r.replica.apply(JSON.parse(line)); } catch { /* skip a torn last line */ } }
    }
    r.out = fs.createWriteStream(r.file, { flags: 'a' });
    rooms.set(name, r);
    return r;
  }

  /* ------------------------------------------------------------ static files */
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size })); }
    const rel = STATIC[url.pathname] || url.pathname.replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    const inside = ALLOWED_DIRS.some((d) => file.startsWith(path.join(ROOT, d) + path.sep));
    if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });

  /* ------------------------------------------------------------ sync */
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const name = (url.searchParams.get('room') || 'lobby').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'lobby';
    const r = room(name);
    let me = null;

    const broadcast = (msg, except) => {
      const data = JSON.stringify(msg);
      for (const [sock] of r.peers) if (sock !== except && sock.readyState === 1) sock.send(data);
    };

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.t === 'hello' && typeof msg.client === 'string') {
        me = { client: msg.client.slice(0, 64), name: String(msg.name || 'guest').slice(0, 40), color: String(msg.color || '#333').slice(0, 32) };
        r.peers.set(ws, me);
        const peers = [...r.peers.values()].filter((p) => p !== me).map((p) => ({ t: 'presence', ...p }));
        ws.send(JSON.stringify({ t: 'welcome', sv: r.replica.stateVector(), ops: r.replica.missing(msg.sv || {}), peers }));
        broadcast({ t: 'presence', ...me }, ws);
        log(`[${name}] + ${me.name} (${r.peers.size} here, ${r.replica.ops.size} ops)`);
      } else if (msg.t === 'ops' && me && Array.isArray(msg.ops)) {
        const fresh = r.replica.merge(msg.ops.slice(0, MAX_OPS_PER_MSG));
        if (!fresh.length) return;
        for (const op of fresh) r.out.write(JSON.stringify(op) + '\n');
        broadcast({ t: 'ops', ops: fresh, from: me.client }, ws);
      } else if (msg.t === 'presence' && me) {
        const p = { t: 'presence', client: me.client, name: me.name, color: me.color };
        if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) { p.x = msg.x; p.y = msg.y; }
        if (typeof msg.tool === 'string') p.tool = msg.tool.slice(0, 12);
        if (typeof msg.drawing === 'boolean') p.drawing = msg.drawing;
        broadcast(p, ws);
      } else if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
      }
    });

    ws.on('close', () => {
      r.peers.delete(ws);
      if (me) { broadcast({ t: 'leave', client: me.client }); log(`[${name}] - ${me.name} (${r.peers.size} here)`); }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        rooms,
        close: () => new Promise((done) => {
          for (const c of wss.clients) c.terminate();
          wss.close();
          for (const r of rooms.values()) r.out.end();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  createServer({ port }).then(({ port: p }) => console.log(`Shared Canvas running at http://localhost:${p}`));
}

// Seeds a room with a little drawing and a friend's cursor, for screenshots and demos.
// usage: node scripts/seed-demo.js [port] [room]
import WebSocket from 'ws';
import { Replica } from '../src/crdt.js';
import { SyncClient } from '../src/sync-client.js';

const port = process.argv[2] || 8787, room = process.argv[3] || 'demo';
const mk = (id, name, color) => new SyncClient({ url: `ws://localhost:${port}/ws?room=${room}`, replica: new Replica(id), WebSocketImpl: WebSocket, profile: { name, color } });
const a = mk('seed-ana', 'Curious Otter', '#3b82f6'), b = mk('seed-ben', 'Sunny Finch', '#ff6b4a');
await a.connect(); await b.connect();

function stroke(c, color, width, pts) {
  const r = c.replica, id = `${r.client}-${r.seq + 1}`, ops = [r.beginStroke(id, { color, width })];
  for (let i = 0, k = 0; i < pts.length; i += 12, k++) ops.push(r.addPoints(id, k, pts.slice(i, i + 13)));
  for (const op of ops) op.at = Date.now();
  c.push(ops);
}
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i / (n - 1), i));
const cx = 720, cy = 430;
// a sun
stroke(a, '#f2a33a', 7, range(120, (t) => { const a2 = t * Math.PI * 2; return [cx - 330 + Math.cos(a2) * 60, cy - 190 + Math.sin(a2) * 60]; }));
for (let k = 0; k < 10; k++) { const a2 = k / 10 * Math.PI * 2; stroke(a, '#f2a33a', 5, [[cx - 330 + Math.cos(a2) * 80, cy - 190 + Math.sin(a2) * 80], [cx - 330 + Math.cos(a2) * 110, cy - 190 + Math.sin(a2) * 110]]); }
// rolling hills
stroke(b, '#2fb67c', 9, range(160, (t) => [cx - 520 + t * 1040, cy + 120 + Math.sin(t * 9) * 26 + Math.sin(t * 3) * 18]));
// a heart
stroke(b, '#ff6b4a', 8, range(140, (t) => { const u = t * Math.PI * 2; return [cx + 250 + 9 * 16 * Math.sin(u) ** 3 / 2.2, cy - 140 - 9 * (13 * Math.cos(u) - 5 * Math.cos(2 * u) - 2 * Math.cos(3 * u) - Math.cos(4 * u)) / 2.2]; }));
// a spiral
stroke(a, '#a855f7', 5, range(220, (t) => { const u = t * Math.PI * 7; return [cx + 30 + Math.cos(u) * t * 90, cy - 120 + Math.sin(u) * t * 90]; }));
// handwriting-ish "hi!"
stroke(b, '#1d1b19', 6, [[cx - 140, cy - 10], [cx - 140, cy - 110]]);
stroke(b, '#1d1b19', 6, range(40, (t) => [cx - 140 + t * 50, cy - 50 - Math.sin(t * Math.PI) * 30 + t * 40]));
stroke(b, '#1d1b19', 6, [[cx - 70, cy - 10], [cx - 70, cy - 60]]);
stroke(b, '#1d1b19', 8, [[cx - 70, cy - 82], [cx - 69.5, cy - 82]]);
stroke(b, '#1d1b19', 6, [[cx - 30, cy - 10 - 20], [cx - 30, cy - 110]]);
stroke(b, '#1d1b19', 8, [[cx - 30, cy - 8], [cx - 29.5, cy - 8]]);
// two cursors hovering
let t = 0;
const tick = setInterval(() => {
  t += 0.05;
  a.presence({ x: cx + 140 + Math.cos(t) * 30, y: cy + 10 + Math.sin(t) * 20, tool: 'pen', drawing: false });
  b.presence({ x: cx - 260 + Math.sin(t) * 25, y: cy + 60, tool: 'pen', drawing: true });
}, 60);
const stayMs = Number(process.env.STAY_MS || 20000);
setTimeout(() => { clearInterval(tick); a.disconnect(); b.disconnect(); process.exit(0); }, stayMs);
console.log(`seeded room "${room}" on :${port}, cursors live for ${stayMs / 1000}s`);

// End-to-end sync latency over real WebSockets on localhost.
// One writer streams point chunks the way a drawing hand does; we time how long
// each op takes to reach every other client (same process, same clock).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../server/server.js';
import { Replica, opKey } from '../src/crdt.js';
import { SyncClient } from '../src/sync-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function run(readers, ops, intervalMs) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bench-'));
  const srv = await createServer({ port: 0, dataDir, log: () => {} });
  const room = `bench${readers}`;
  const sent = new Map(), lat = [];
  let received = 0;
  const mk = (id, onOps) => new SyncClient({ url: `ws://localhost:${srv.port}/ws?room=${room}`, replica: new Replica(id), WebSocketImpl: WebSocket, profile: { name: id }, onOps });
  const writer = mk('writer');
  const rs = Array.from({ length: readers }, (_, i) => mk(`r${i}`, (fresh) => {
    const now = performance.now();
    for (const op of fresh) { const t0 = sent.get(opKey(op)); if (t0 != null) lat.push(now - t0); received++; }
  }));
  await writer.connect(); await Promise.all(rs.map((r) => r.connect()));
  await sleep(100);

  const rep = writer.replica;
  const op0 = rep.beginStroke('s', { color: '#000', width: 3 });
  sent.set(opKey(op0), performance.now()); writer.push([op0]);
  const tStart = performance.now();
  for (let i = 0; i < ops; i++) {
    const op = rep.addPoints('s', i, Array.from({ length: 8 }, (_, k) => [i + k, i - k]));
    sent.set(opKey(op), performance.now());
    writer.push([op]);
    if (intervalMs) await sleep(intervalMs);
  }
  const expected = (ops + 1) * readers;
  while (received < expected) await sleep(5);
  const total = performance.now() - tStart;
  for (const c of [writer, ...rs]) c.disconnect();
  await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  return { readers, ops: ops + 1, p50: q(lat, .5), p95: q(lat, .95), p99: q(lat, .99), max: Math.max(...lat), deliveriesPerSec: expected / (total / 1000) };
}

console.log('\nSync latency benchmark: localhost WebSockets, writer → server → readers');
console.log('  mode                     readers   p50 ms   p95 ms   p99 ms   deliveries/s');
for (const [label, readers, ops, gap] of [['live drawing (60 ops/s)', 2, 300, 16], ['live drawing (60 ops/s)', 20, 300, 16], ['live drawing (60 ops/s)', 50, 300, 16], ['burst (no pacing)', 20, 5000, 0]]) {
  const r = await run(readers, ops, gap);
  console.log(`  ${label.padEnd(24)} ${String(r.readers).padStart(7)}   ${r.p50.toFixed(2).padStart(6)}   ${r.p95.toFixed(2).padStart(6)}   ${r.p99.toFixed(2).padStart(6)}   ${Math.round(r.deliveriesPerSec).toLocaleString('en-US').padStart(12)}`);
}
console.log('');

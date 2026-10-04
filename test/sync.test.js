import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../server/server.js';
import { Replica } from '../src/crdt.js';
import { SyncClient } from '../src/sync-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(10); }
}

function client(port, room, id) {
  const replica = new Replica(id);
  const sc = new SyncClient({ url: `ws://localhost:${port}/ws?room=${room}`, replica, WebSocketImpl: WebSocket, profile: { name: id, color: '#000' } });
  const draw = (sid, n = 3) => {
    const ops = [replica.beginStroke(sid, { color: '#123', width: 4 })];
    for (let i = 0; i < n; i++) ops.push(replica.addPoints(sid, i, [[i, i], [i + 1, i + 2]]));
    sc.push(ops);
    return ops;
  };
  return { replica, sc, draw };
}

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  let srv = await createServer({ port: 0, dataDir, log: () => {} });
  try { await fn(srv, dataDir, async () => { await srv.close(); srv = await createServer({ port: srv.port, dataDir, log: () => {} }); return srv; }); }
  finally { await srv.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test('live edits reach every client', async () => {
  await withServer(async (srv) => {
    const a = client(srv.port, 'room1', 'alice'), b = client(srv.port, 'room1', 'bob');
    await a.sc.connect(); await b.sc.connect();
    a.draw('s1'); b.draw('s2');
    await until(() => a.replica.visible().length === 2 && b.replica.visible().length === 2);
    assert.equal(a.replica.digest(), b.replica.digest());
    a.sc.disconnect(); b.sc.disconnect();
  });
});

test('offline edits on both sides merge on reconnect with nothing lost', async () => {
  await withServer(async (srv) => {
    const a = client(srv.port, 'room2', 'alice'), b = client(srv.port, 'room2', 'bob');
    await a.sc.connect(); await b.sc.connect();
    a.draw('shared');
    await until(() => b.replica.visible().length === 1);

    a.sc.disconnect(); b.sc.disconnect();
    // both keep working offline, including a conflicting delete of the shared stroke
    a.draw('a-offline-1'); a.draw('a-offline-2');
    b.draw('b-offline');
    b.replica.deleteStroke('shared');
    a.replica.addPoints('shared', 3, [[9, 9]]);   // alice extends the stroke bob deleted

    const ra = await a.sc.connect();
    const rb = await b.sc.connect();
    assert.ok(ra.sent > 0 && rb.sent > 0);
    await until(() => a.replica.ops.size === b.replica.ops.size && a.replica.digest() === b.replica.digest());
    const ids = a.replica.visible().map((s) => s.id).sort();
    assert.deepEqual(ids, ['a-offline-1', 'a-offline-2', 'b-offline']);   // delete wins
    a.sc.disconnect(); b.sc.disconnect();
  });
});

test('a late joiner gets the whole board, and the board survives a server restart', async () => {
  await withServer(async (srv, dataDir, restart) => {
    const a = client(srv.port, 'room3', 'alice');
    await a.sc.connect();
    for (let i = 0; i < 20; i++) a.draw(`s${i}`, 5);
    await until(() => srv.rooms.get('room3').replica.ops.size === 20 * 6);
    a.sc.disconnect();
    await sleep(50);

    const srv2 = await restart();
    const c = client(srv2.port, 'room3', 'carol');
    const r = await c.sc.connect();
    assert.equal(r.received, 120);
    assert.equal(c.replica.digest(), a.replica.digest());
    c.sc.disconnect();
  });
});

test('rooms are isolated', async () => {
  await withServer(async (srv) => {
    const a = client(srv.port, 'red', 'alice'), b = client(srv.port, 'blue', 'bob');
    await a.sc.connect(); await b.sc.connect();
    a.draw('only-red');
    await sleep(150);
    assert.equal(b.replica.ops.size, 0);
    a.sc.disconnect(); b.sc.disconnect();
  });
});

test('the server ignores malformed ops from a bad client', async () => {
  await withServer(async (srv) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=evil`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'hello', client: 'mallory', sv: {} }));
    ws.send(JSON.stringify({ t: 'ops', ops: [{ kind: 'stroke', client: 'mallory', seq: 1, lamport: 1, id: 'x', color: '#000', width: 9999 }, { kind: 'points', client: 'mallory', seq: 2, lamport: 2, id: 'x', idx: 0, pts: 'nope' }] }));
    ws.send('not json');
    await sleep(150);
    assert.equal(srv.rooms.get('evil').replica.ops.size, 0);
    ws.close();
  });
});

test('static files are served, and paths cannot escape the public folders', async () => {
  await withServer(async (srv) => {
    const ok = await fetch(`http://localhost:${srv.port}/`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Shared Canvas/);
    assert.equal((await fetch(`http://localhost:${srv.port}/src/crdt.js`)).status, 200);
    assert.equal((await fetch(`http://localhost:${srv.port}/package.json`)).status, 404);
    assert.equal((await fetch(`http://localhost:${srv.port}/public/../server/server.js`)).status, 404);
    assert.equal((await fetch(`http://localhost:${srv.port}/%2e%2e/package.json`)).status, 404);
  });
});

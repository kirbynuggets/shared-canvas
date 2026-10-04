import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica, validOp, opKey } from '../src/crdt.js';

/* Small seeded PRNG so failures are reproducible. */
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const shuffle = (a, r) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** Random editing session on one replica, occasionally learning ops from others. */
function randomEdits(rep, r, n, pool) {
  const mine = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.35 || mine.length === 0) {
      const id = `${rep.client}-${i}`;
      mine.push({ id, idx: 0 });
      pool.push(rep.beginStroke(id, { color: ['#000', '#f00', '#0f0'][Math.floor(r() * 3)], width: 1 + Math.floor(r() * 10) }));
    } else if (roll < 0.85) {
      const s = mine[Math.floor(r() * mine.length)];
      pool.push(rep.addPoints(s.id, s.idx++, [[r() * 500, r() * 500], [r() * 500, r() * 500]]));
    } else {
      // delete any stroke this replica knows about, including other people's
      const ids = [...rep.strokes.keys()];
      pool.push(rep.deleteStroke(ids[Math.floor(r() * ids.length)]));
    }
    if (r() < 0.15 && pool.length) rep.apply(pool[Math.floor(r() * pool.length)]);
  }
}

test('replicas converge under random order, duplication and partial sync (500 runs)', () => {
  for (let run = 0; run < 500; run++) {
    const r = rng(run + 1);
    const reps = ['alice', 'bob', 'carol'].map((c) => new Replica(c));
    const pool = [];
    for (const rep of reps) randomEdits(rep, r, 10 + Math.floor(r() * 40), pool);

    // deliver everything to everyone in a different random order, with duplicates
    for (const rep of reps) {
      const delivery = shuffle([...pool, ...pool.filter(() => r() < 0.3)], r);
      for (const op of delivery) rep.apply(op);
    }
    const d = reps[0].digest();
    for (const rep of reps) assert.equal(rep.digest(), d, `run ${run}: digests differ`);
    for (const rep of reps) assert.equal(rep.ops.size, new Set(pool.map(opKey)).size);
  }
});

test('state-vector sync sends exactly the missing ops', () => {
  const a = new Replica('a'), b = new Replica('b');
  a.beginStroke('s1', { color: '#000', width: 2 });
  a.addPoints('s1', 0, [[0, 0], [1, 1]]);
  b.beginStroke('s2', { color: '#f00', width: 3 });
  const toB = a.missing(b.stateVector());
  const toA = b.missing(a.stateVector());
  assert.equal(toB.length, 2);
  assert.equal(toA.length, 1);
  b.merge(toB); a.merge(toA);
  assert.equal(a.digest(), b.digest());
  assert.equal(a.missing(b.stateVector()).length, 0);
  assert.equal(b.missing(a.stateVector()).length, 0);
});

test('state vector only counts contiguous seqs, so gaps get re-sent', () => {
  const a = new Replica('a'), b = new Replica('b');
  const ops = [a.beginStroke('s', { color: '#000', width: 1 }), a.addPoints('s', 0, [[0, 0]]), a.addPoints('s', 1, [[1, 1]])];
  b.apply(ops[0]); b.apply(ops[2]);           // seq 2 missing
  assert.deepEqual(b.stateVector(), { a: 1 });
  const resend = a.missing(b.stateVector());
  assert.deepEqual(resend.map((o) => o.seq), [2, 3]);
  b.merge(resend);
  assert.deepEqual(b.stateVector(), { a: 3 });
  assert.equal(a.digest(), b.digest());
});

test('delete wins, even if it arrives before the stroke', () => {
  const a = new Replica('a'), b = new Replica('b');
  const make = a.beginStroke('s', { color: '#000', width: 1 });
  const pts = a.addPoints('s', 0, [[0, 0], [5, 5]]);
  b.apply(make);
  const del = b.deleteStroke('s');
  const c = new Replica('c');
  c.apply(del); c.apply(pts); c.apply(make);   // reverse order
  a.apply(del);
  assert.equal(a.visible().length, 0);
  assert.equal(c.visible().length, 0);
  assert.equal(a.digest(), c.digest());
});

test('points arriving before their stroke still assemble in order', () => {
  const a = new Replica('a'), b = new Replica('b');
  const ops = [a.beginStroke('s', { color: '#000', width: 1 }), a.addPoints('s', 0, [[0, 0]]), a.addPoints('s', 1, [[1, 1]]), a.addPoints('s', 2, [[2, 2]])];
  for (const op of [...ops].reverse()) b.apply(op);
  assert.deepEqual(b.points(b.visible()[0]), [[0, 0], [1, 1], [2, 2]]);
});

test('a missing chunk truncates the stroke instead of drawing garbage', () => {
  const a = new Replica('a'), b = new Replica('b');
  const ops = [a.beginStroke('s', { color: '#000', width: 1 }), a.addPoints('s', 0, [[0, 0]]), a.addPoints('s', 1, [[1, 1]]), a.addPoints('s', 2, [[2, 2]])];
  b.merge([ops[0], ops[1], ops[3]]);
  assert.deepEqual(b.points(b.visible()[0]), [[0, 0]]);
  b.apply(ops[2]);
  assert.deepEqual(b.points(b.visible()[0]), [[0, 0], [1, 1], [2, 2]]);
});

test('applying an op twice is a no-op', () => {
  const a = new Replica('a'), b = new Replica('b');
  const op = a.beginStroke('s', { color: '#000', width: 1 });
  assert.equal(b.apply(op), true);
  const v = b.version;
  assert.equal(b.apply(op), false);
  assert.equal(b.version, v);
});

test('stacking order is the same total order on every replica', () => {
  const a = new Replica('a'), b = new Replica('b');
  const x = a.beginStroke('x', { color: '#000', width: 1 });   // lamport 1, client a
  const y = b.beginStroke('y', { color: '#000', width: 1 });   // lamport 1, client b
  a.apply(y); b.apply(x);
  assert.deepEqual(a.visible().map((s) => s.id), ['x', 'y']);
  assert.deepEqual(b.visible().map((s) => s.id), ['x', 'y']);
  const z = a.beginStroke('z', { color: '#000', width: 1 });   // lamport 2, on top
  b.apply(z);
  assert.deepEqual(b.visible().map((s) => s.id), ['x', 'y', 'z']);
});

test('lamport clock moves past everything it has seen', () => {
  const a = new Replica('a'), b = new Replica('b');
  for (let i = 0; i < 5; i++) a.beginStroke(`s${i}`, { color: '#000', width: 1 });
  b.merge(a.allOps());
  const op = b.beginStroke('mine', { color: '#000', width: 1 });
  assert.equal(op.lamport, 6);
  assert.equal(b.visible().at(-1).id, 'mine');
});

test('malformed ops are rejected', () => {
  const r = new Replica('r');
  const bad = [
    null, {}, { kind: 'nope' },
    { kind: 'stroke', client: 'x', seq: 1, lamport: 1, id: 's', color: '#000', width: -1 },
    { kind: 'stroke', client: 'x', seq: 0, lamport: 1, id: 's', color: '#000', width: 1 },
    { kind: 'points', client: 'x', seq: 1, lamport: 1, id: 's', idx: 0, pts: [] },
    { kind: 'points', client: 'x', seq: 1, lamport: 1, id: 's', idx: 0, pts: [[NaN, 1]] },
    { kind: 'points', client: 'x', seq: 1, lamport: 1, id: 's', idx: 0, pts: Array(600).fill([1, 1]) },
    { kind: 'delete', client: 'x'.repeat(100), seq: 1, lamport: 1, id: 's' },
  ];
  for (const op of bad) { assert.equal(validOp(op), false); assert.equal(r.apply(op), false); }
  assert.equal(r.ops.size, 0);
});

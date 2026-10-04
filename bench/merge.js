// How fast does the CRDT itself go? Pure in-process numbers, no network.
import { Replica } from '../src/crdt.js';

const t = () => performance.now();
function session(id, strokes, chunks, ptsPerChunk) {
  const r = new Replica(id);
  for (let s = 0; s < strokes; s++) {
    const sid = `${id}-${s}`;
    r.beginStroke(sid, { color: '#123', width: 3 });
    for (let c = 0; c < chunks; c++) r.addPoints(sid, c, Array.from({ length: ptsPerChunk }, (_, i) => [s + i, c + i]));
  }
  return r;
}

// two people draw offline: 2,500 strokes each, 20 chunks of 8 points = 52,500 ops each
const t0 = t();
const a = session('alice', 2500, 20, 8), b = session('bob', 2500, 20, 8);
const tGen = t() - t0;

const t1 = t();
const toB = a.missing(b.stateVector()), toA = b.missing(a.stateVector());
const tDiff = t() - t1;

const t2 = t();
b.merge(toB); a.merge(toA);
const tMerge = t() - t2;
const merged = toA.length + toB.length;

const t3 = t();
const same = a.digest() === b.digest();
const tDigest = t() - t3;

const t4 = t();
const dup = a.merge(toA).length;   // re-delivering everything is a no-op
const tDup = t() - t4;

const fmt = (n) => Math.round(n).toLocaleString('en-US');
console.log('\nCRDT merge benchmark (Node', process.version + ')');
console.log(`  ops per replica           ${fmt(a.ops.size / 2)}`);
console.log(`  state-vector diff         ${tDiff.toFixed(1)} ms  (found ${fmt(merged)} missing ops)`);
console.log(`  merge two offline sessions ${tMerge.toFixed(1)} ms  → ${fmt(merged / (tMerge / 1000))} ops/s`);
console.log(`  re-merge duplicates        ${tDup.toFixed(1)} ms  (${dup} applied, idempotent)`);
console.log(`  materialise + compare      ${tDigest.toFixed(1)} ms  (${fmt(a.visible().length)} strokes)`);
console.log(`  converged                  ${same}`);
console.log(`  (generating the sessions took ${tGen.toFixed(0)} ms)\n`);
if (!same) process.exit(1);

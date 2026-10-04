/**
 * A tiny op-based CRDT for a shared drawing board.
 *
 * Every change is an immutable op identified by (client, seq). A replica is
 * just the set of ops it has seen, and the visible board is a pure function
 * of that set. Applying an op is idempotent and commutative, so any two
 * replicas that have seen the same ops render exactly the same board, no
 * matter what order the ops arrived in, how often they were duplicated, or
 * how long someone was offline.
 *
 * Op kinds
 *   stroke  { id, color, width, tool }       creates a stroke
 *   points  { id, idx, pts: [[x, y], ...] }  chunk `idx` of a stroke's points
 *   delete  { id }                           removes a stroke (tombstone)
 *
 * Strokes form a 2P-set: once deleted, a stroke stays deleted ("delete wins").
 * Redo is implemented by re-adding a copy under a fresh id, which keeps the
 * merge rule trivial and unambiguous.
 *
 * Stacking order is (lamport, client), a total order every replica agrees on.
 *
 * This file is shared by the browser, the server and the tests.
 */

export const opKey = (op) => `${op.client}:${op.seq}`;

const KINDS = new Set(['stroke', 'points', 'delete']);
const MAX_POINTS_PER_OP = 512;
const MAX_ID_LEN = 64;

/** Cheap structural validation, so a bad peer cannot corrupt a replica. */
export function validOp(op) {
  if (!op || typeof op !== 'object' || !KINDS.has(op.kind)) return false;
  if (typeof op.client !== 'string' || !op.client || op.client.length > MAX_ID_LEN) return false;
  if (!Number.isInteger(op.seq) || op.seq < 1) return false;
  if (!Number.isInteger(op.lamport) || op.lamport < 1) return false;
  if (typeof op.id !== 'string' || !op.id || op.id.length > MAX_ID_LEN) return false;
  if (op.kind === 'stroke') {
    if (typeof op.color !== 'string' || op.color.length > 32) return false;
    if (typeof op.width !== 'number' || !(op.width > 0 && op.width <= 200)) return false;
  }
  if (op.kind === 'points') {
    if (!Number.isInteger(op.idx) || op.idx < 0) return false;
    if (!Array.isArray(op.pts) || op.pts.length === 0 || op.pts.length > MAX_POINTS_PER_OP) return false;
    if (!op.pts.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return false;
  }
  return true;
}

export class Replica {
  constructor(clientId) {
    this.client = clientId;
    this.seq = 0;                 // last seq this replica issued
    this.lamport = 0;             // Lamport clock
    this.ops = new Map();         // opKey -> op
    this.seen = new Map();        // client -> Set of seqs (for contiguity)
    this.contig = new Map();      // client -> highest contiguous seq
    this.strokes = new Map();     // stroke id -> materialised stroke
    this.version = 0;             // bumps whenever the visible board changes
  }

  /* ------------------------------------------------------------ local ops */

  /** Create, apply and return a new local op. */
  local(kind, fields) {
    this.lamport += 1;
    this.seq += 1;
    const op = { kind, client: this.client, seq: this.seq, lamport: this.lamport, ...fields };
    this.apply(op);
    return op;
  }

  beginStroke(id, { color, width, tool = 'pen' }) { return this.local('stroke', { id, color, width, tool }); }
  addPoints(id, idx, pts) { return this.local('points', { id, idx, pts }); }
  deleteStroke(id) { return this.local('delete', { id }); }

  /* ------------------------------------------------------------ merging */

  /**
   * Integrate an op from anywhere. Returns true if it was new.
   * Idempotent and order-independent by construction.
   */
  apply(op) {
    if (!validOp(op)) return false;
    const key = opKey(op);
    if (this.ops.has(key)) return false;
    this.ops.set(key, op);
    this.lamport = Math.max(this.lamport, op.lamport);
    if (op.client === this.client) this.seq = Math.max(this.seq, op.seq);
    this.#track(op.client, op.seq);

    const s = this.#stroke(op.id);
    if (op.kind === 'stroke') {
      // first writer wins for metadata; a stroke id is only created once in practice
      if (!s.meta || compareOrder(op, s.meta) < 0) s.meta = { color: op.color, width: op.width, tool: op.tool || 'pen', client: op.client, lamport: op.lamport };
    } else if (op.kind === 'points') {
      if (!s.chunks.has(op.idx)) s.chunks.set(op.idx, op.pts);
      s.cache = null;
    } else if (op.kind === 'delete') {
      s.deleted = true;
    }
    this.version += 1;
    return true;
  }

  /** Apply many ops, return the ones that were new. */
  merge(ops) {
    const fresh = [];
    for (const op of ops) if (this.apply(op)) fresh.push(op);
    return fresh;
  }

  /* ------------------------------------------------------------ sync helpers */

  /** State vector: client -> highest contiguous seq we hold. */
  stateVector() { return Object.fromEntries(this.contig); }

  /** Every op the holder of `sv` is missing, in causal-friendly order. */
  missing(sv = {}) {
    const out = [];
    for (const op of this.ops.values()) if (op.seq > (sv[op.client] || 0)) out.push(op);
    return out.sort((a, b) => a.lamport - b.lamport || (a.client < b.client ? -1 : a.client > b.client ? 1 : a.seq - b.seq));
  }

  allOps() { return this.missing({}); }

  /* ------------------------------------------------------------ the board */

  /** Visible strokes in their agreed stacking order, with points assembled. */
  visible() {
    const out = [];
    for (const s of this.strokes.values()) {
      if (s.deleted || !s.meta) continue;
      out.push(s);
    }
    out.sort((a, b) => compareOrder(a.meta, b.meta) || (a.id < b.id ? -1 : 1));
    return out;
  }

  /** Points of a stroke, chunks in order. Stops at the first gap so a half-synced stroke still draws cleanly. */
  points(stroke) {
    if (stroke.cache) return stroke.cache;
    const pts = [];
    for (let i = 0; stroke.chunks.has(i); i++) pts.push(...stroke.chunks.get(i));
    stroke.cache = pts;
    return pts;
  }

  /** Canonical fingerprint of the visible board, used by tests to prove convergence. */
  digest() {
    return JSON.stringify(this.visible().map((s) => [s.id, s.meta.color, s.meta.width, s.meta.lamport, s.meta.client, this.points(s)]));
  }

  /** The newest visible stroke authored by `client` (for undo). */
  lastStrokeBy(client) {
    const mine = this.visible().filter((s) => s.meta.client === client);
    return mine[mine.length - 1] || null;
  }

  /* ------------------------------------------------------------ internals */

  #stroke(id) {
    let s = this.strokes.get(id);
    if (!s) { s = { id, meta: null, chunks: new Map(), deleted: false, cache: null }; this.strokes.set(id, s); }
    return s;
  }

  #track(client, seq) {
    let set = this.seen.get(client);
    if (!set) { set = new Set(); this.seen.set(client, set); }
    set.add(seq);
    let c = this.contig.get(client) || 0;
    while (set.has(c + 1)) { set.delete(c + 1); c += 1; }
    this.contig.set(client, c);
  }
}

/** Total order on (lamport, client) shared by every replica. */
export function compareOrder(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  return a.client < b.client ? -1 : a.client > b.client ? 1 : 0;
}

/** Short random id, good enough for strokes and clients. */
export function uid(n = 10) {
  const abc = 'abcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  const rnd = (globalThis.crypto && globalThis.crypto.getRandomValues) ? globalThis.crypto.getRandomValues(new Uint8Array(n)) : Array.from({ length: n }, () => Math.random() * 256 | 0);
  for (let i = 0; i < n; i++) s += abc[rnd[i] % abc.length];
  return s;
}

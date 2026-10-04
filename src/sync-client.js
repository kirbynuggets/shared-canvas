/**
 * Client half of the sync protocol. Works in the browser and in Node
 * (pass a WebSocket implementation in). The server is just another replica.
 *
 *   client -> server  hello    { client, name, color, sv }
 *   server -> client  welcome  { sv, ops, peers }     ops = what the client is missing
 *   client -> server  ops      { ops }                what the server is missing, then live ops
 *   server -> client  ops      { ops, from }          ops from other clients
 *   either way        presence { client, x, y, ... }  ephemeral, never stored
 *   client -> server  ping     { ts }  ->  pong { ts }
 *
 * Reconnecting is the same as connecting: state vectors are exchanged and each
 * side sends exactly what the other lacks, so offline edits need no special
 * outbox and nothing is ever lost or applied twice.
 */
export class SyncClient {
  constructor({ url, replica, WebSocketImpl = globalThis.WebSocket, profile = {}, onOps = () => {}, onPresence = () => {}, onStatus = () => {}, onRtt = () => {} }) {
    this.url = url;
    this.replica = replica;
    this.WS = WebSocketImpl;
    this.profile = profile;
    this.onOps = onOps;
    this.onPresence = onPresence;
    this.onStatus = onStatus;
    this.onRtt = onRtt;
    this.ws = null;
    this.status = 'idle';          // idle | connecting | live | offline
    this.wantOnline = true;
    this.retry = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.synced = Promise.resolve();
  }

  connect() {
    this.wantOnline = true;
    clearTimeout(this.retryTimer);
    if (this.ws && this.ws.readyState <= 1) return this.synced;
    this.#setStatus('connecting');
    let resolveSynced;
    this.synced = new Promise((r) => { resolveSynced = r; });
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.#send({ t: 'hello', client: this.replica.client, ...this.profile, sv: this.replica.stateVector() });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.t === 'welcome') {
        const fresh = this.replica.merge(msg.ops || []);
        if (fresh.length) this.onOps(fresh, { initial: true });
        const theyLack = this.replica.missing(msg.sv || {});
        if (theyLack.length) this.#sendOps(theyLack);
        for (const p of msg.peers || []) this.onPresence(p);
        this.#setStatus('live');
        this.#startPing();
        resolveSynced({ received: fresh.length, sent: theyLack.length });
      } else if (msg.t === 'ops') {
        const fresh = this.replica.merge(msg.ops || []);
        if (fresh.length) this.onOps(fresh, { from: msg.from });
      } else if (msg.t === 'presence' || msg.t === 'leave') {
        this.onPresence(msg);
      } else if (msg.t === 'pong') {
        this.onRtt(now() - msg.ts);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      this.#setStatus('offline');
      if (this.wantOnline) {
        const wait = Math.min(8000, 300 * 2 ** this.retry++) * (0.7 + Math.random() * 0.6);
        this.retryTimer = setTimeout(() => this.connect(), wait);
      }
    };
    ws.onerror = () => {};
    return this.synced;
  }

  /** Go offline on purpose (for demos and tests). Local edits keep working. */
  disconnect() {
    this.wantOnline = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
    this.#setStatus('offline');
  }

  /** Send freshly made local ops. Safe to call while offline; they sync on reconnect. */
  push(ops) {
    if (this.status === 'live') this.#sendOps(ops);
  }

  presence(p) {
    if (this.status === 'live') this.#send({ t: 'presence', ...p });
  }

  #sendOps(ops) {
    for (let i = 0; i < ops.length; i += 200) this.#send({ t: 'ops', ops: ops.slice(i, i + 200) });
  }

  #send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  #startPing() {
    clearInterval(this.pingTimer);
    const ping = () => this.#send({ t: 'ping', ts: now() });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  #setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }
}

const now = () => (globalThis.performance ? performance.now() : Date.now());

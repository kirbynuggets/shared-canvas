// Real-browser end-to-end test: two separate Chrome profiles draw together,
// both go offline and keep drawing, then reconnect and must converge.
// usage: npm run test:e2e   (needs Google Chrome installed; set CHROME_PATH to override)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createServer } from '../server/server.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS_DIR || path.resolve('docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`  ✓ ${msg}`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-'));
const srv = await createServer({ port: 0, dataDir, log: () => {} });
const url = `http://localhost:${srv.port}/?room=e2e`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });

async function open() {
  const ctx = await browser.createBrowserContext();       // separate storage = separate person
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(url);
  await page.waitForFunction(() => window.sharedCanvas && window.sharedCanvas.sync.status === 'live');
  return page;
}
const state = (p) => p.evaluate(() => { const r = window.sharedCanvas.replica; return { strokes: r.visible().length, ops: r.ops.size, digest: r.digest() }; });
async function scribble(page, x, y, w, h, n = 40) {
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= n; i++) { const t = i / n; await page.mouse.move(x + t * w, y + Math.sin(t * Math.PI * 3) * h); await sleep(4); }
  await page.mouse.up();
}

try {
  console.log('\nShared Canvas browser e2e');
  const a = await open(), b = await open();
  step('two browsers connected to the same room');

  await a.click('[data-c="#3b82f6"]');
  await scribble(a, 200, 300, 400, 80);
  await b.waitForFunction(() => window.sharedCanvas.replica.visible().length === 1, { timeout: 3000 });
  step('a stroke drawn in browser A appears in browser B');

  await a.click('#status'); await b.click('#status');
  await a.waitForFunction(() => window.sharedCanvas.sync.status === 'offline');
  await b.waitForFunction(() => window.sharedCanvas.sync.status === 'offline');
  await a.click('[data-c="#ff6b4a"]'); await scribble(a, 250, 480, 300, 40);
  await b.click('[data-c="#2fb67c"]'); await scribble(b, 700, 250, 300, 60); await scribble(b, 700, 450, 260, 30);
  await b.keyboard.press('e'); await b.mouse.move(205, 240); await b.mouse.down(); for (let y = 240; y <= 360; y += 10) await b.mouse.move(205, y); await b.mouse.up(); // B erases A's first stroke while offline
  await b.keyboard.press('p');
  await sleep(1100);
  const offA = await state(a), offB = await state(b);
  assert.notEqual(offA.digest, offB.digest);
  const waiting = await b.$eval('#status span', (e) => e.textContent);
  assert.match(waiting, /offline · \d+ changes? waiting/);
  await b.screenshot({ path: path.join(SHOTS, 'offline.png') });
  step(`both went offline and kept drawing; boards diverged (A: ${offA.strokes} strokes, B: ${offB.strokes}); status reads "${waiting}"`);

  const t0 = performance.now();
  await a.click('#status'); await b.click('#status');
  await a.waitForFunction(() => window.sharedCanvas.sync.status === 'live');
  await b.waitForFunction(() => window.sharedCanvas.sync.status === 'live');
  let sa, sb;
  for (let i = 0; i < 100; i++) { sa = await state(a); sb = await state(b); if (sa.digest === sb.digest && sa.ops === sb.ops) break; await sleep(20); }
  assert.equal(sa.digest, sb.digest);
  assert.equal(sa.strokes, 3);   // A's first stroke was erased by B, delete wins; 1 new from A, 2 from B
  step(`reconnected and converged in ${Math.round(performance.now() - t0)} ms: ${sa.strokes} strokes, ${sa.ops} ops, identical on both`);

  await b.reload();
  await b.waitForFunction(() => window.sharedCanvas.sync.status === 'live');
  await b.waitForFunction((d) => window.sharedCanvas.replica.digest() === d, {}, sa.digest);
  step('board survives a reload');

  await a.keyboard.press('i');
  await sleep(300);
  await a.screenshot({ path: path.join(SHOTS, 'merged.png') });
  step(`screenshots saved to ${path.relative(process.cwd(), SHOTS)}/`);
  console.log('\nAll browser checks passed.\n');
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

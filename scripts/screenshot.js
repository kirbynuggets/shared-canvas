// Captures README screenshots of a seeded room, desktop and mobile.
// usage: node scripts/screenshot.js   (starts its own server)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { createServer } from '../server/server.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-shots-'));
const srv = await createServer({ port: 0, dataDir, log: () => {} });
const seed = spawn(process.execPath, ['scripts/seed-demo.js', String(srv.port), 'demo'], { env: { ...process.env, STAY_MS: '15000' }, stdio: 'ignore' });
await sleep(1200);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
for (const [name, vp, panel] of [['hero', { width: 1440, height: 860, deviceScaleFactor: 2 }, false], ['inspector', { width: 1440, height: 860, deviceScaleFactor: 2 }, true], ['mobile', { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, false]]) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(vp);
  await page.goto(`http://localhost:${srv.port}/?room=demo${panel ? '&panel=1' : ''}`);
  await page.waitForFunction(() => window.sharedCanvas && window.sharedCanvas.sync.status === 'live');
  await sleep(3200);   // let the sync toast fade
  await sleep(300);
  await page.screenshot({ path: `docs/${name}.png` });
  console.log(`docs/${name}.png`);
  await ctx.close();
}
await browser.close(); seed.kill(); await srv.close();
fs.rmSync(dataDir, { recursive: true, force: true });

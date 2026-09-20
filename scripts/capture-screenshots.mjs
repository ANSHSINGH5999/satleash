// Captures the submission screenshots from the REAL running application with headless Chrome (no dependencies).
//   node scripts/capture-screenshots.mjs console   # needs `npm run playground` to be READY
//   node scripts/capture-screenshots.mjs drill     # needs `npm run web` (Docker); runs the real drill, takes about 45 s
//   node scripts/capture-screenshots.mjs landing   # only 01-landing.png; needs `npm run web` or the playground
// Output: screenshots/NN-name.png. Nothing is faked: if the server is not up, the script stops.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'screenshots');
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8080}`;
const mode = process.argv[2];
if (!['console', 'drill', 'landing'].includes(mode)) throw new Error('usage: node scripts/capture-screenshots.mjs console|drill|landing');
const chromePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
if (!chromePath) throw new Error('no Chrome found (set CHROME_PATH)');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch(() => null);
if (!health?.ok) throw new Error(`nothing is answering on ${BASE}: start the server first`);

const profile = mkdtempSync(join(tmpdir(), 'lb-shots-'));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', detached: true });
const done = (code) => { try { process.kill(-chrome.pid); } catch {} try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} process.exit(code); };
let target;
for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(250); }
if (!target) { console.error('Chrome did not start'); done(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const view = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const shot = async (name) => { writeFileSync(join(OUT, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); console.log('wrote', `screenshots/${name}.png`); };
const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const lens = async () => { await move(420, 520); await move(700, 560); await sleep(2800); }; // the hero's cursor lens, settled
const go = async (url, wait = 3500) => { await send('Page.navigate', { url }); await sleep(wait); };
const scrollTo = (sel, pad = 60) => ev(`scrollTo({top:document.querySelector('${sel}').getBoundingClientRect().top+scrollY-${pad},behavior:'instant'})`);
await send('Page.enable'); await send('Runtime.enable');

if (mode === 'landing') {
  await view(1280, 800);
  await go(`${BASE}/`, 4800); await lens(); await shot('01-landing');
} else if (mode === 'console') {
  await view(1280, 800);
  await go(`${BASE}/`, 4800); await lens(); await shot('01-landing');
  await view(1240, 760);
  await go(`file://${join(ROOT, 'docs/diagrams/architecture.svg')}`, 1000); await shot('09-architecture');
  await view(1280, 900);
  await go(`${BASE}/console`, 5500);
  for (const [tab, name] of [['dashboard', '02-dashboard'], ['backup', '03-backup'], ['verify', '04-verify'], ['relays', '06-relays'], ['security', '07-security']]) {
    await ev(`document.getElementById('tab-${tab}').click()`); await sleep(500); await shot(name);
  }
} else {
  await view(1280, 800);
  await go(`${BASE}/`, 3500);
  await scrollTo('#proof');
  await sleep(800);
  if (await ev(`document.getElementById('runBtn').disabled`)) { console.error('the drill button is disabled: is this `npm run web` without LND_* variables, with Docker running?'); done(1); }
  await ev(`document.getElementById('runBtn').click()`);
  let shotMid = false, finished = false;
  for (let i = 0; i < 400 && !finished; i++) {
    await sleep(500);
    const s = JSON.parse(await ev(`JSON.stringify({s:[...document.getElementById('track').children].map(l=>l.dataset.s[0]).join(''),t:document.getElementById('statusText').textContent.trim()})`));
    if (!shotMid && /^dddda/.test(s.s)) { await scrollTo('#proof', 40); await shot('05-recovery-drill'); shotMid = true; }
    finished = s.s === 'dddddd' && s.t === 'Passed';
    if (/Failed/i.test(s.t)) { console.error('the drill failed; nothing was captured as a result'); done(1); }
  }
  if (!finished) { console.error('the drill did not finish in time'); done(1); }
  await sleep(1500);
  await scrollTo('#track', 80); await sleep(400); await shot('08-recovered-state');
  await scrollTo('#metrics', 60); await sleep(400); await shot('10-proof-metrics');
}
done(0);

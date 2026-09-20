// Browser tests: drive the real pages in headless Chrome over the DevTools protocol.
// Skipped when no Chrome/Chromium is found (set CHROME_PATH). No Docker or lnd needed: the server runs with fakes.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey } from 'nostr-tools/pure';
import { DrillRunner } from './drill.js';
import { Logger } from './log.js';
import type { Monitor } from './monitor.js';
import { ROOT } from './regtest.js';
import { RelaySet } from './relays.js';
import { sleep, waitFor } from './testutil.js';
import { createApp } from './web.js';

const chromePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));
const skip = chromePath ? false : 'no Chrome/Chromium found (set CHROME_PATH)';
const log = new Logger({ level: 'error', write: () => {} });

class Browser {
  private proc!: ChildProcess;
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: any) => void>();
  private profile = mkdtempSync(join(tmpdir(), 'lifeboat-chrome-'));
  problems: string[] = [];

  async start(width = 1280, height = 900) {
    const port = 9410 + Math.floor(Math.random() * 400);
    this.proc = spawn(chromePath!, ['--headless=new', '--disable-gpu', ...(process.env.CI ? ['--no-sandbox'] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${this.profile}`, 'about:blank'], { stdio: 'ignore' });
    let wsUrl = '';
    for (let i = 0; i < 80 && !wsUrl; i++) {
      try {
        wsUrl = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[]).find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch {
        // not up yet
      }
      if (!wsUrl) await sleep(250);
    }
    assert.ok(wsUrl, 'Chrome did not start');
    this.ws = new WebSocket(wsUrl);
    await new Promise((r) => (this.ws.onopen = r));
    this.ws.onmessage = (m) => {
      const j = JSON.parse(String(m.data));
      if (j.id && this.pending.has(j.id)) return this.pending.get(j.id)!(j), this.pending.delete(j.id), undefined;
      if (j.method === 'Runtime.exceptionThrown') this.problems.push('exception: ' + (j.params.exceptionDetails.exception?.description ?? j.params.exceptionDetails.text));
      if (j.method === 'Log.entryAdded' && j.params.entry.level === 'error') this.problems.push('log: ' + j.params.entry.text);
    };
    for (const d of ['Page', 'Runtime', 'Log']) await this.send(`${d}.enable`);
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  send(method: string, params: object = {}) {
    return new Promise<any>((res) => {
      const i = ++this.id;
      this.pending.set(i, res);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev<T = any>(expr: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result;
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async open(url: string) {
    this.problems.length = 0;
    await this.send('Page.navigate', { url });
  }
  async until(expr: string, ms = 15000, what = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await this.ev(expr)) return;
      } catch {
        // page still loading
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for: ${what}`);
  }
  async click(sel: string) {
    await this.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  }
  async key(sel: string, key: string) {
    await this.ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`);
  }
  async type(sel: string, text: string) {
    await this.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  }
  text = (sel: string) => this.ev<string>(`document.querySelector(${JSON.stringify(sel)}).textContent`);
  async stop() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    if (this.proc && this.proc.exitCode === null) {
      const exited = new Promise((r) => this.proc!.once('exit', r));
      this.proc.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    try {
      rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Chrome's helper processes may still be flushing into the profile; a leftover temp directory must not fail a test
    }
  }
}

async function serve(o: Parameters<typeof createApp>[0]) {
  const app = createApp(o);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, close: () => app.close() };
}

/* ---------- fake monitor with a mutable snapshot and a real RelaySet ---------- */
const EVIL = (n: number) => `<img src=x onerror="window.__pwned=${n}">`;

function fakeMonitor(o: { hostile?: boolean; network?: string; verifyError?: Error } = {}) {
  const relays = new RelaySet(['ws://127.0.0.1:7899/']);
  const sk = generateSecretKey();
  const state = { channels: 2, failing: false, network: o.network ?? 'regtest', logs: [] as unknown[] };
  const snapshot = () => {
    if (state.failing) throw new Error('snapshot unavailable');
    const now = Date.now();
    const h = !!o.hostile;
    const url = h ? `wss://relay.example/${EVIL(1)}` : 'ws://127.0.0.1:7899/';
    const rec = { at: now - 5000, channels: state.channels, bytes: 900, eventId: 'ef'.repeat(32), fingerprint: 'ab'.repeat(32), durationMs: 12, relaysOk: [url], relaysFailed: h ? [{ url, error: '<script>window.__pwned=2</script>' }] : [] };
    const rl = relays.all().map((r) => (h ? { ...r, url: `${r.url}${EVIL(3)}` } : r));
    return {
      now,
      startedAt: now - 60000,
      node: { connected: true, pubkey: 'ab'.repeat(33), alias: h ? EVIL(4) : 'stub', network: state.network, version: `0.20.0 ${h ? EVIL(5) : ''}`, blockHeight: 5, synced: true },
      channels: { total: state.channels, active: state.channels, pending: 0, localSats: 100, remoteSats: 0 },
      nostr: { pubkey: 'cd'.repeat(32) },
      backup: { running: true, state: 'SUCCESS', nostrPubkey: 'cd'.repeat(32), streamConnected: true, publishes: 1, failures: 0, retryPending: false, invalidTransitions: 0, lastPublish: rec, history: [rec], lastError: h ? { at: now, message: EVIL(6) } : undefined },
      relays: rl,
      verify: {
        ok: !h, verdict: h ? 'failed' : 'verified', checkedAt: now, fingerprint: 'ee'.repeat(32), lndValidated: !h, channelsInBackup: state.channels, matchesCurrent: !h, channelsCurrent: state.channels, problems: h ? [EVIL(7)] : [],
        relays: [{ url, reachable: !h, error: h ? EVIL(8) : undefined, hasBackup: !h, hasLatest: !h, state: h ? 'down' : 'healthy', foreignEvents: h ? 3 : 0, latencyMs: 5, createdAt: Math.floor(now / 1000) }],
      },
      macaroon: { canSpend: false, fileLoose: false, file: h ? EVIL(9) : 'monitor.macaroon', needs: ['info:read', 'offchain:read'] },
      security: { worst: h ? 'fail' : 'pass', checks: [{ id: 'x', status: h ? 'fail' : 'pass', title: h ? EVIL(10) : 'lnd reachable', detail: h ? '<script>window.__pwned=11</script>' : 'The last poll of lnd succeeded.', fix: h ? '<svg onload=window.__pwned=12>' : undefined }] },
      config: { relays: [url], staleAfterSec: 28800 },
      logs: [{ t: new Date().toISOString(), level: 'error', msg: h ? `</div>${EVIL(13)}` : 'backup published', fields: { category: h ? EVIL(14) : 'backup', a: h ? EVIL(15) : 1 } }, ...state.logs],
    };
  };
  const monitor = {
    snapshot,
    verifyNow: async () => {
      if (o.verifyError) throw o.verifyError;
      return { ok: true, verdict: 'verified', problems: [] };
    },
    relays,
    backup: { publishNow: async () => ({ relaysOk: ['a'], durationMs: 3 }), secretKey: () => sk },
  } as unknown as Monitor;
  return { monitor, state, relays };
}

const consoleUp = async (m: ReturnType<typeof fakeMonitor>, o: Partial<Parameters<typeof createApp>[0]> = {}) => {
  const app = await serve({ root: ROOT, host: '127.0.0.1', drill: null, log, monitor: m.monitor, ...o });
  const b = new Browser();
  await b.start();
  await b.open(`${app.url}/console`);
  await b.until(`!document.getElementById('live').hidden`, 15000, 'dashboard rendered');
  return { app, b };
};
const TABS = ['dashboard', 'backup', 'verify', 'relays', 'node', 'security', 'activity', 'settings'];
const clean = (b: Browser) => b.problems.filter((p) => !/favicon/.test(p));

test('console: hostile strings from lnd, relays and logs are shown as text on every tab and never executed', { skip, timeout: 90000 }, async () => {
  const { app, b } = await consoleUp(fakeMonitor({ hostile: true }));
  try {
    for (const t of TABS) {
      await b.click(`#tab-${t}`);
      await sleep(150);
      assert.equal(await b.ev(`window.__pwned`), undefined, `a hostile string was executed on the ${t} tab`);
    }
    assert.equal(await b.ev(`document.querySelectorAll('img, svg, iframe, object, embed').length`), 0, 'hostile markup became elements');
    assert.equal(await b.ev(`document.querySelectorAll('script').length`), 1, 'no script element was injected');
    await b.click('#tab-node');
    assert.ok((await b.text('#nKv')).includes(EVIL(4)), 'the alias is displayed literally');
    await b.click('#tab-relays');
    assert.ok((await b.text('#rRows')).includes(EVIL(3)), 'relay url displayed literally');
    await b.click('#tab-activity');
    assert.ok((await b.text('#logs')).includes(EVIL(13)));
    assert.deepEqual(clean(b), [], 'no CSP violations or page errors');
  } finally {
    await b.stop();
    await app.close();
  }
});

test('console: tabs follow the WAI-ARIA pattern (roles, selection, roving tabindex, arrow keys, Home/End, hash routing)', { skip, timeout: 60000 }, async () => {
  const { app, b } = await consoleUp(fakeMonitor());
  try {
    assert.equal(await b.ev(`document.getElementById('tabs').getAttribute('role')`), 'tablist');
    const sel = () => b.ev<string>(`[...document.querySelectorAll('[role=tab]')].filter(t=>t.getAttribute('aria-selected')==='true').map(t=>t.id).join()`);
    assert.equal(await sel(), 'tab-dashboard');
    await b.key('#tab-dashboard', 'ArrowRight');
    assert.equal(await sel(), 'tab-backup');
    assert.equal(await b.ev(`document.getElementById('tab-backup').tabIndex`), 0);
    assert.equal(await b.ev(`document.getElementById('tab-dashboard').tabIndex`), -1);
    assert.equal(await b.ev(`document.getElementById('p-backup').hidden`), false);
    assert.equal(await b.ev(`document.getElementById('p-dashboard').hidden`), true);
    await b.key('#tab-backup', 'End');
    assert.equal(await sel(), 'tab-settings');
    await b.key('#tab-settings', 'ArrowRight');
    assert.equal(await sel(), 'tab-dashboard', 'wraps around');
    await b.key('#tab-dashboard', 'ArrowLeft');
    assert.equal(await sel(), 'tab-settings');
    assert.equal(await b.ev(`location.hash`), '#settings');
    await b.key('#tab-settings', 'Home');
    assert.equal(await sel(), 'tab-dashboard');
    assert.equal(await b.ev(`document.querySelectorAll('[role=tabpanel]').length`), 8);
    await b.ev(`location.hash = '#security'`);
    await b.until(`document.getElementById('tab-security').getAttribute('aria-selected') === 'true'`, 3000, 'hash routing');
  } finally {
    await b.stop();
    await app.close();
  }
});

test('console: shows real evidence, and the page follows the state as it changes (live update, network badge, mainnet banner)', { skip, timeout: 90000 }, async () => {
  const m = fakeMonitor();
  const { app, b } = await consoleUp(m);
  try {
    assert.equal(await b.text('#healthText'), 'Healthy');
    assert.match(await b.text('#readiness'), /held by 1 of 1 relays/);
    assert.match(await b.text('#readiness'), /Verification: VERIFIED/);
    const checks = await b.ev(`document.getElementById('vChecks').textContent`) as string;
    assert.match(checks, /Backup accepted by lnd/);
    assert.match(checks, /lnd decrypted the relay copy with this node's key and found 2 channel\(s\) inside/);
    assert.match(checks, /Relay redundancy.*1 of 1 relay\(s\) hold the newest backup/);
    assert.equal(await b.text('#dChan'), '2 / 2');
    assert.equal(await b.text('#net'), 'REGTEST');
    assert.equal(await b.ev(`document.getElementById('mainnet').classList.contains('show')`), false);
    assert.equal(await b.text('#dFp'), 'ab'.repeat(32));

    m.state.channels = 3; // the node opened a channel; the next poll must show it
    await b.until(`document.getElementById('dChan').textContent === '3 / 3'`, 9000, 'live update');

    m.state.network = 'mainnet';
    await b.until(`document.getElementById('mainnet').classList.contains('show')`, 9000, 'mainnet banner');
    assert.equal(await b.text('#net'), 'MAINNET');
    assert.match(await b.text('#mainnet'), /only been tested on regtest/);
    assert.deepEqual(clean(b), []);
  } finally {
    await b.stop();
    await app.close();
  }
});

test('console: losing the server shows a banner and keeps the last known state; coming back clears it', { skip, timeout: 90000 }, async () => {
  const m = fakeMonitor();
  const { app, b } = await consoleUp(m);
  try {
    m.state.failing = true;
    await b.until(`document.getElementById('banner').classList.contains('show')`, 15000, 'lost-connection banner');
    assert.match(await b.text('#banner'), /Lost connection/);
    assert.equal(await b.text('#healthText'), 'Offline');
    assert.equal(await b.text('#dChan'), '2 / 2', 'the last known state stays visible');
    m.state.failing = false;
    await b.until(`!document.getElementById('banner').classList.contains('show')`, 9000, 'banner cleared');
    assert.equal(await b.text('#healthText'), 'Healthy');
  } finally {
    await b.stop();
    await app.close();
  }
});

test('console: relay management through the UI (add, confirm-before-public, disable, enable, remove, last relay protected)', { skip, timeout: 90000 }, async () => {
  const m = fakeMonitor();
  const { app, b } = await consoleUp(m);
  try {
    await b.click('#tab-relays');
    assert.equal(await b.ev(`document.getElementById('addBtn').disabled`), true, 'nothing to add yet');
    await b.type('#addUrl', 'ws://127.0.0.1:7898');
    assert.equal(await b.ev(`document.getElementById('addBtn').disabled`), false);
    await b.click('#addBtn');
    await b.until(`document.getElementById('rRows').children.length === 2`, 9000, 'loopback relay added');
    assert.equal(m.relays.active().length, 2);

    // a public relay must be confirmed first, and nothing is added until it is
    await b.type('#addUrl', 'wss://public.example');
    await b.click('#addBtn');
    await b.until(`document.getElementById('addConfirm').classList.contains('show')`, 5000, 'confirmation panel');
    assert.match(await b.text('#addConfirmText'), /public infrastructure/);
    assert.equal(m.relays.all().length, 2, 'not added before confirmation');
    await b.click('#addNo');
    assert.equal(await b.ev(`document.getElementById('addConfirm').classList.contains('show')`), false);
    assert.equal(m.relays.all().length, 2);
    await b.type('#addUrl', 'wss://public.example');
    await b.click('#addBtn');
    await b.until(`document.getElementById('addConfirm').classList.contains('show')`, 5000);
    await b.click('#addYes');
    await b.until(`document.getElementById('rRows').children.length === 3`, 9000, 'public relay added after confirmation');
    assert.equal(m.relays.all().find((r) => r.url === 'wss://public.example/')?.session, true);

    await b.click('#rRows button[aria-label="Disable wss://public.example/"]');
    await b.until(`document.querySelector('#rRows button[aria-label="Enable wss://public.example/"]')`, 9000, 'disabled');
    assert.equal(m.relays.active().includes('wss://public.example/'), false);
    await b.click('#rRows button[aria-label="Enable wss://public.example/"]');
    await b.until(`document.querySelector('#rRows button[aria-label="Disable wss://public.example/"]')`, 9000, 'enabled again');
    await b.click('#rRows button[aria-label="Remove wss://public.example/"]');
    await b.until(`document.getElementById('rRows').children.length === 2`, 9000, 'removed');
    await b.click('#rRows button[aria-label="Remove ws://127.0.0.1:7898/"]');
    await b.until(`document.getElementById('rRows').children.length === 1`, 9000, 'second removed');

    await b.click('#rRows button[aria-label="Remove ws://127.0.0.1:7899/"]');
    await b.until(`/at least one relay must stay enabled/.test(document.getElementById('actionNote').textContent)`, 5000, 'last relay protected');
    assert.equal(m.relays.all().length, 1);
    assert.deepEqual(clean(b).filter((p) => !/40\d/.test(p)), []);
  } finally {
    await b.stop();
    await app.close();
  }
});

test('console: the public relay test needs an explicit acknowledgement and reports each step honestly', { skip, timeout: 60000 }, async () => {
  const m = fakeMonitor();
  const seen: string[] = [];
  const relayTest = async (url: string) => {
    seen.push(url);
    return { url, namespace: 'lifeboat/relay-test/abc', throwawayPubkey: 'f0'.repeat(32), eventId: 'e', published: true, publishMs: 40, retrieved: true, retrieveMs: 30, signatureValid: true, decrypted: true, payloadValid: true, fingerprintValid: true, deletionRequested: true, deletionHonored: false, errors: [] };
  };
  const { app, b } = await consoleUp(m, { relayTest });
  try {
    await b.click('#tab-relays');
    await b.type('#testUrl', 'wss://public.example');
    assert.equal(await b.ev(`document.getElementById('testBtn').disabled`), true, 'a URL alone is not enough');
    await b.ev(`(()=>{const c=document.getElementById('testAck');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    assert.equal(await b.ev(`document.getElementById('testBtn').disabled`), false);
    assert.match(await b.text('#p-relays'), /ONE encrypted dummy event signed by a throwaway key/);
    await b.click('#testBtn');
    await b.until(`document.getElementById('testResult').children.length >= 5`, 9000, 'result rendered');
    assert.deepEqual(seen, ['wss://public.example/']);
    const txt = await b.text('#testResult');
    assert.match(txt, /Published/);
    assert.match(txt, /Signature verified/);
    assert.match(txt, /Payload validated/);
    assert.match(txt, /Fingerprint validated/);
    assert.match(txt, /The relay ignored the deletion request/, 'a relay that keeps the event is reported, not glossed over');
    assert.equal(await b.ev(`document.querySelector('#testResult .item:last-child').dataset.s`), 'warn');
  } finally {
    await b.stop();
    await app.close();
  }
});

test('console: a failing action tells the operator what happened, why, the impact and what to do', { skip, timeout: 60000 }, async () => {
  const m = fakeMonitor({ verifyError: new Error('no relay accepted the backup: wss://a (timeout)') });
  const { app, b } = await consoleUp(m);
  try {
    await b.click('#verifyBtn');
    await b.until(`document.getElementById('actionNote').classList.contains('err')`, 9000, 'error shown');
    const t = await b.text('#actionNote');
    assert.match(t, /Verifying failed: no relay accepted the backup/);
    assert.match(t, /Why: Every enabled relay refused or could not be reached/);
    assert.match(t, /Impact: /);
    assert.match(t, /What to do: /);
    assert.match(t, /Request id: [0-9a-f]{8}/);
    assert.equal(await b.ev(`document.getElementById('verifyBtn').disabled`), false, 'the button is usable again');
  } finally {
    await b.stop();
    await app.close();
  }
});

test('console without a node explains how to connect, and does not error', { skip, timeout: 60000 }, async () => {
  const app = await serve({ root: ROOT, host: '127.0.0.1', drill: null, monitor: null, log });
  const b = new Browser();
  try {
    await b.start();
    await b.open(`${app.url}/console`);
    await b.until(`!document.getElementById('empty').hidden`, 15000, 'empty state shown');
    assert.equal(await b.ev(`document.getElementById('live').hidden && document.getElementById('tabs').hidden`), true);
    assert.match(await b.text('#empty'), /npm run playground/);
    assert.deepEqual(clean(b).filter((p) => !/404/.test(p)), []);
  } finally {
    await b.stop();
    await app.close();
  }
});

test('console accessibility: landmarks, one visible h1, every control has a name, inputs are labelled, panels point at their tabs', { skip, timeout: 60000 }, async () => {
  const { app, b } = await consoleUp(fakeMonitor());
  try {
    const r = await b.ev<Record<string, any>>(`(()=>{
      const name = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim();
      const controls = [...document.querySelectorAll('button, a[href], [role=tab]')];
      const unnamed = controls.filter((e) => !name(e)).map((e) => e.outerHTML.slice(0, 80));
      const inputs = [...document.querySelectorAll('input')];
      const unlabelled = inputs.filter((i) => !(i.id && document.querySelector('label[for="'+i.id+'"]')) && !i.closest('label')).map((i) => i.id);
      const visibleH1 = [...document.querySelectorAll('h1')].filter((h) => !h.closest('[hidden]'));
      const panels = [...document.querySelectorAll('[role=tabpanel]')].map((p) => !!document.getElementById(p.getAttribute('aria-labelledby')));
      const skip = document.querySelector('a.skip');
      return { unnamed, unlabelled, h1: visibleH1.length, panelsOk: panels.every(Boolean), main: !!document.querySelector('main#main'), lang: document.documentElement.lang,
        skipTarget: skip && document.querySelector(skip.getAttribute('href')) !== null, liveRegions: document.querySelectorAll('[aria-live]').length, roleAlert: document.querySelectorAll('[role=alert],[role=alertdialog]').length, tablistLabel: document.getElementById('tabs').getAttribute('aria-label') };
    })()`);
    assert.deepEqual(r.unnamed, [], 'controls without an accessible name');
    assert.deepEqual(r.unlabelled, [], 'inputs without a label');
    assert.equal(r.h1, 1);
    assert.equal(r.panelsOk, true);
    assert.equal(r.main, true);
    assert.equal(r.lang, 'en');
    assert.equal(r.skipTarget, true, 'the skip link points at real content');
    assert.ok(r.liveRegions >= 2 && r.roleAlert >= 2, 'status and error changes are announced');
    assert.ok(r.tablistLabel);
  } finally {
    await b.stop();
    await app.close();
  }
});

test('colour contrast: the listed text colours and button pairs on the console and the landing page reach 4.5:1 (WCAG AA for normal text); this is not a full accessibility audit', () => {
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const blend = (fg: string, bg: string, a: number) => '#' + rgb(fg).map((v, i) => Math.round(v * a + rgb(bg)[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
  const css = readFileSync(join(ROOT, 'web/console.html'), 'utf8');
  const v = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)![1];
  const bg = v('bg');
  const surface = blend('#ffffff', bg, 0.035);
  const texts = ['ink', 'soft', 'dim', 'accent', 'ok', 'warn', 'degraded', 'bad', 'unknown'];
  for (const t of texts) for (const [where, back] of [['page', bg], ['card', surface]] as const) {
    const r = ratio(v(t), back);
    assert.ok(r >= 4.5, `--${t} on ${where} is ${r.toFixed(2)}:1`);
  }
  const pairs: [string, string, string][] = [['button', '#e8e8e8', v('panel')], ['primary button', '#050505', '#fdfdfd'], ['danger button', '#ffd0cc', '#3a1512'], ['mainnet badge', '#ffffff', '#b3261e'], ['error banner', '#ffd0d0', blend('#ff8a8a', bg, 0.1)], ['confirm panel', '#ffe7b8', blend('#f5c26b', bg, 0.07)]];
  for (const [name, fg, back] of pairs) assert.ok(ratio(fg, back) >= 4.5, `${name} is ${ratio(fg, back).toFixed(2)}:1`);

  const land = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  const lv = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(land)![1];
  for (const t of ['ink', 'ink-muted', 'ink-soft', 'ink-dim', 'accent', 'ok']) assert.ok(ratio(lv(t), '#000000') >= 4.5, `landing --${t} is ${ratio(lv(t), '#000000').toFixed(2)}:1`);
  const cta = /\.hero-cta\{[^}]*background:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/i.exec(land)!;
  const ctaHover = /\.hero-cta:hover\{background:(#[0-9a-f]{6})/i.exec(land)![1];
  for (const [state, back] of [['rest', cta[1]], ['hover', ctaHover]]) assert.ok(ratio(cta[2], back) >= 4.5, `hero button (${state}) is ${ratio(cta[2], back).toFixed(2)}:1`);
});

/* ---------------------------------- landing ---------------------------------- */

test('landing: every command shown in "Run it" can be pasted into a shell as it is (no angle-bracket placeholders), and the first one goes to the project folder', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  const cmds = [...html.matchAll(/<code id="(c\d+)">([^<]*)<\/code>/g)].map((m) => ({ id: m[1], text: m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }));
  assert.ok(cmds.length >= 9, 'the commands are found');
  assert.match(cmds[0].text, /^cd /, 'the first command goes to the project folder');
  for (const c of cmds) {
    assert.doesNotMatch(c.text, /[<>]/, `${c.id} must not contain < or >, which a shell reads as a redirect: ${c.text}`);
    assert.match(c.text, /^(cd |export |npm |LND_CERT=)/, `${c.id} starts with a real command: ${c.text}`);
  }
  assert.ok(cmds.some((c) => c.text.includes('$LND_DIR/tls.cert')) && cmds.some((c) => c.text.startsWith('export LND_DIR=')), 'the lnd directory is set once and reused');
});


test('landing: the live drill button runs a drill and the page tracks stages, numbers, checks and measured metrics from its output', { skip, timeout: 90000 }, async () => {
  const fp = 'ab'.repeat(32);
  const lines = [
    '== fresh regtest cluster', '== fund alice and open channel #1 to bob', '== start Nostr backup daemon, then open channel #2 (must be picked up automatically)',
    'published: 1ch->1relay, 2ch->1relay', `backup fingerprint (channel set): ${fp}`, 'alice: 1000 sats on-chain + 900 sats in 2 channels', '== DISASTER: delete alice completely',
    '== RESTORE: new lnd from the seed alone, then pull backup from Nostr', 'PASS  backup verified before the disaster: lnd itself decrypted the relay copy and found 2 channel(s) in it', 'PASS  same node identity from seed', 'PASS  same Nostr backup key re-derived from seed', 'PASS  the restored backup has the channel-set fingerprint that was published',
    '== peers force-close (data-loss protection); mine until funds return', '  block 0: on-chain 1000 sats', 'recovered 890 of 900 channel sats on-chain', 'PASS  channel funds recovered (only fees lost)',
    'metrics: {"backupBytes":1811,"publishMs":42,"discoverMs":30,"importMs":15,"recoveryMs":9000,"totalMs":38000,"relaysOk":2,"relaysFailed":0,"feesSats":10,"exportMs":14,"encryptMs":5.3,"verifyMs":36,"relaysAtRestore":1}',
  ];
  const drill = new DrillRunner({ run: async (emit) => { for (const l of lines) { emit(l, false); await sleep(30); } return 0; }, cleanup: async () => {} });
  const app = await serve({ root: ROOT, host: '127.0.0.1', drill, monitor: null, log, dockerOk: async () => true });
  const b = new Browser();
  try {
    await b.start();
    await b.open(`${app.url}/`);
    await b.until(`!document.getElementById('runBtn').disabled`, 15000, 'live mode enabled the button');
    assert.equal(await b.text('#statusText'), 'Recorded run');
    assert.equal(await b.ev(`document.querySelector('.nav-links a[href="/console"]').hidden`), false, 'console link is shown when served by the app');
    await b.click('#runBtn');
    await b.until(`document.getElementById('statusText').textContent === 'Passed'`, 20000, 'run passed');
    await b.until(`document.getElementById('runBtn').textContent === 'Run it again' && !document.getElementById('runBtn').disabled`, 10000, 'idle');
    assert.deepEqual(await b.ev(`['st-channels','st-before','st-after','st-lost'].map(i=>document.getElementById(i).textContent)`), ['2', '900', '890', '10']);
    assert.equal(await b.ev(`[...document.getElementById('track').children].map(l=>l.dataset.s[0]).join('')`), 'dddddd');
    assert.equal(await b.ev(`['ck-pub','ck-verify','ck-id','ck-key','ck-fp'].map(i=>document.getElementById(i).dataset.s).join()`), 'pass,pass,pass,pass,pass');
    assert.deepEqual(await b.ev(`['m-total','m-recovery','m-bytes','m-publish','m-discover','m-import','m-relays','m-fees','m-fp'].map(i=>document.getElementById(i).textContent)`), ['38.0 s', '9.0 s', '1.8 KB', '42 ms', '30 ms', '15 ms', '2 / 0', '10 sats', fp]);
    assert.deepEqual(await b.ev(`['m-export','m-encrypt','m-verify','m-atrestore'].map(i=>document.getElementById(i).textContent)`), ['14 ms', '5.3 ms', '36 ms', '1 of 2']);
    assert.ok((await b.text('#termPre')).includes('recovered 890 of 900'));
    assert.deepEqual(clean(b), [], 'no CSP violations or page errors');
  } finally {
    await b.stop();
    await app.close();
  }
});

test('landing: the hero draws its own art, a cursor lens follows the pointer, nothing third-party but fonts, and it fits at desktop, phone and small-phone widths', { skip, timeout: 90000 }, async () => {
  const app = await serve({ root: ROOT, host: '127.0.0.1', drill: null, monitor: null, log });
  const b = new Browser();
  try {
    await b.start();
    await b.open(`${app.url}/`);
    await b.until(`document.fonts.check('500 20px Inter') && document.fonts.check('italic 400 20px "Playfair Display"')`, 15000, 'fonts loaded');
    await sleep(2200); // entrance animation
    const r = await b.ev<Record<string, any>>(`(()=>{
      const px = (id) => { const c = document.getElementById(id); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let grey = 0, warm = 0;
        for (let i = 0; i < d.length; i += 4 * 61) { const R = d[i], G = d[i+1], B = d[i+2]; if (R > 60 && Math.abs(R - G) < 40 && Math.abs(G - B) < 45) grey++; if (R > 120 && R > G * 1.5 && R > B * 1.8) warm++; } return { grey, warm, w: c.width, h: c.height }; };
      const name = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim();
      const z = (s) => getComputedStyle(document.querySelector(s)).zIndex;
      return { videos: document.querySelectorAll('video, img').length, base: px('artBase'), lens: px('artLens'), h1: document.querySelectorAll('h1').length, h1Text: document.querySelector('h1').textContent.replace(/\\s+/g,' ').trim(),
        oneLiner: document.querySelector('.hero-left p').textContent.replace(/\\s+/g,' ').trim(), cta: document.querySelector('.hero-cta').textContent.trim(), ctaBg: getComputedStyle(document.querySelector('.hero-cta')).backgroundColor,
        h1a: getComputedStyle(document.querySelector('.h1-a')).fontFamily + '|' + getComputedStyle(document.querySelector('.h1-a')).fontStyle, h1b: getComputedStyle(document.querySelector('.h1-b')).fontFamily,
        external: [...document.querySelectorAll('[src],[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href')).filter((u) => /^https?:/.test(u) && !/fonts\\.(googleapis|gstatic)\\.com/.test(u)),
        unnamed: [...document.querySelectorAll('button, a[href]')].filter((e) => !name(e)).length, art: document.querySelector('.hero-art').getAttribute('aria-label'), overflow: document.documentElement.scrollWidth - innerWidth,
        z: [z('.hero-base'), z('.hero-lens'), z('.hero-title'), z('.hero-left'), z('.hero-right')].join(','), lensEvents: getComputedStyle(document.getElementById('heroLens')).pointerEvents,
        mask: getComputedStyle(document.getElementById('heroLens')).maskImage || getComputedStyle(document.getElementById('heroLens')).webkitMaskImage, mx: document.getElementById('heroLens').style.getPropertyValue('--mx'),
        pill: getComputedStyle(document.querySelector('.nav-links')).display, burger: getComputedStyle(document.getElementById('burger')).display,
        arch: !!document.querySelector('#architecture .arch[aria-label]'), flow: [...document.querySelectorAll('.flow li')].map((l) => l.textContent).join(' ') };
    })()`);
    assert.equal(r.videos, 0, 'no video or image element: the art is drawn');
    assert.ok(r.base.grey > 20 && r.base.warm === 0, `the dim layer is drawn in grey, without the warm colour: ${JSON.stringify(r.base)}`);
    assert.ok(r.lens.warm > 20, `the lit layer is drawn in warm colours: ${JSON.stringify(r.lens)}`);
    assert.equal(r.h1, 1);
    assert.equal(r.h1Text, 'Back up your node. Verify. Recover.');
    assert.match(r.oneLiner, /Lifeboat backs up a Lightning node's channel state to Nostr relays as encrypted events, checks that backup against the live node, and restores it from the 24-word seed and a known relay URL, with no other secret or key file\./);
    assert.equal(r.cta, 'Run recovery drill');
    assert.equal(r.ctaBg, 'rgb(232, 112, 42)');
    assert.match(r.h1a, /Playfair Display.*\|italic/);
    assert.match(r.h1b, /Inter/);
    assert.deepEqual(r.external, [], 'nothing is loaded from a third party except the fonts');
    assert.equal(r.unnamed, 0);
    assert.ok(r.art);
    assert.equal(r.overflow, 0);
    assert.equal(r.z, '10,30,50,50,50', 'base under the lens under the text');
    assert.equal(r.lensEvents, 'none');
    assert.match(r.mask, /radial-gradient/);
    assert.match(r.mask, /260px/);
    assert.ok(r.mx === '' || parseFloat(r.mx) <= -900, `before any pointer movement the lens sits off-screen (${r.mx})`);
    assert.equal(r.pill, 'flex', 'desktop shows the nav pill');
    assert.equal(r.burger, 'none');
    assert.equal(r.arch, true);
    assert.equal(r.flow, 'BACKUP ENCRYPT PUBLISH WIPE DISCOVER VERIFY RESTORE RECOVERED');

    // the lens trails the pointer and then settles on it
    const at = () => b.ev<number[]>(`(()=>{const l=document.getElementById('heroLens');const t=document.getElementById('top').getBoundingClientRect();return [parseFloat(l.style.getPropertyValue('--mx')),parseFloat(l.style.getPropertyValue('--my')),t.left,t.top]})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 450 });
    await sleep(40);
    const early = await at();
    assert.ok(Math.abs(early[0] - 700) > 100, `40 ms after a jump the lens has not arrived (at ${early[0]})`);
    await sleep(3200);
    const late = await at();
    assert.ok(Math.abs(late[0] - (700 - late[2])) < 2 && Math.abs(late[1] - (450 - late[3])) < 2, `the lens settles on the pointer: ${late}`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 300 });
    await sleep(3200);
    const moved = await at();
    assert.ok(Math.abs(moved[0] - 200) < 2 && Math.abs(moved[1] - 300) < 2, `and follows it elsewhere: ${moved}`);

    // the whole hero must sit inside the viewport at desktop, phone and small-phone widths, with the right nav for each
    for (const [w, h] of [[1280, 800], [400, 800], [320, 568]]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await b.open(`${app.url}/`);
      await b.until(`document.querySelector('.hero-cta').getBoundingClientRect().width > 0`, 8000, 'hero laid out');
      await sleep(1800);
      const j = JSON.parse(await b.ev(`(()=>{const out=[];for(const s of ['.h1-a','.h1-b','.hero-right p','.hero-cta','.brand']){const e=document.querySelector(s);const r=e.getBoundingClientRect();out.push([s,Math.round(r.left),Math.round(r.right),Math.round(r.bottom)])}
        const l=document.querySelector('.hero-left');return JSON.stringify({vw:innerWidth,vh:innerHeight,out,scrollW:document.documentElement.scrollWidth,left:getComputedStyle(l).display,pill:getComputedStyle(document.querySelector('.nav-links')).display,burger:getComputedStyle(document.getElementById('burger')).display})})()`));
      for (const [sel, l, rt] of j.out) assert.ok(l >= 0 && rt <= j.vw, `${sel} spans ${l}..${rt} in a ${j.vw}px viewport`);
      assert.ok(j.out.find((o: any[]) => o[0] === '.hero-cta')![3] <= j.vh, `the button is inside the ${j.vh}px viewport`);
      assert.ok(j.scrollW <= j.vw, `no horizontal scroll at ${w}px`);
      assert.equal(j.pill, w >= 768 ? 'flex' : 'none', `nav pill at ${w}px`);
      assert.equal(j.burger, w >= 768 ? 'none' : 'flex', `hamburger at ${w}px`);
      assert.equal(j.left, w >= 640 ? 'block' : 'none', `left paragraph at ${w}px`);
    }

    // reduced motion: everything is simply there
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await b.open(`${app.url}/`);
    await sleep(500);
    assert.equal(await b.ev(`(()=>{const c=getComputedStyle(document.querySelector('.h1-a'));const z=getComputedStyle(document.querySelector('.hero-base'));return c.opacity+'|'+c.animationName+'|'+z.animationName})()`), '1|none|none');
    assert.deepEqual(clean(b), []);
  } finally {
    await b.stop();
    await app.close();
  }
});

test('landing without the server (static hosting) keeps the recorded run and a disabled button', { skip, timeout: 60000 }, async () => {
  const { createServer } = await import('node:http');
  const html = readFileSync(join(ROOT, 'web/index.html'));
  const s = createServer((req, res) => (req.url === '/' ? (res.setHeader('content-type', 'text/html'), res.end(html)) : (res.statusCode = 404, res.end())));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const b = new Browser();
  try {
    await b.start();
    await b.open(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`);
    await b.until(`document.getElementById('modeNote')`, 15000);
    await sleep(1500);
    assert.equal(await b.ev(`document.getElementById('runBtn').disabled`), true);
    assert.equal(await b.text('#statusText'), 'Recorded run');
    assert.equal(await b.ev(`document.querySelector('.nav-links a[href="/console"]').hidden`), true, 'console link stays hidden without the server');
    await waitFor(() => true);
  } finally {
    await b.stop();
    s.closeAllConnections();
    s.close();
  }
});

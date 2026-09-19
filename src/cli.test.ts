import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const clean = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    execFile(process.execPath, ['--import', 'tsx', CLI, ...args], { env: { ...clean, ...env }, timeout: 20000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    );
  });

test('cli: a missing configuration is one clear message that names every variable, exit 2', async () => {
  const r = await run(['verify']);
  assert.equal(r.code, 2);
  for (const v of ['LND_CERT', 'LND_MACAROON', 'RELAYS']) assert.match(r.out, new RegExp(v));
});

test('cli: an unreachable lnd is explained with cause and action, exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lb-cli-'));
  try {
    writeFileSync(join(dir, 'tls.cert'), 'placeholder');
    writeFileSync(join(dir, 'm.macaroon'), 'placeholder');
    chmodSync(join(dir, 'm.macaroon'), 0o600);
    const r = await run(['verify'], { LND_CERT: join(dir, 'tls.cert'), LND_MACAROON: join(dir, 'm.macaroon'), RELAYS: 'ws://127.0.0.1:1,ws://127.0.0.1:2', LND_PORT: '1' });
    assert.equal(r.code, 1);
    assert.match(r.out, /ECONNREFUSED/);
    assert.match(r.out, /cause:.*lnd/);
    assert.match(r.out, /action:.*LND_HOST/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: relay-test refuses to touch a relay without --yes, and an unknown command prints usage', async () => {
  const a = await run(['relay-test', 'wss://relay.invalid']);
  assert.equal(a.code, 2);
  assert.match(a.out, /Re-run with --yes/);
  const b = await run(['nonsense']);
  assert.equal(b.code, 2);
  assert.match(b.out, /usage: cli\.ts/);
});

/* ---- without Docker: a clear, prompt message, never a stack trace ---- */
const noDocker = (script: string) =>
  new Promise<{ code: number; out: string; ms: number }>((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'lb-nodocker-'));
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n', { mode: 0o755 });
    const t0 = Date.now();
    execFile(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(script, import.meta.url))], { env: { PATH: `${dir}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '' }, timeout: 40000 }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr, ms: Date.now() - t0 });
    });
  });

test('demo without a Docker daemon: one actionable line, exit 1, no stack trace', async () => {
  const r = await noDocker('./demo.ts');
  assert.equal(r.code, 1);
  assert.match(r.out, /prerequisite failed: Docker daemon: not reachable: start Docker/);
  assert.doesNotMatch(r.out, /^\s+at /m, 'no stack trace');
  assert.doesNotMatch(r.out, /fresh regtest cluster/, 'nothing was started');
});

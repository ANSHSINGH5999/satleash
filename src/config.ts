import { accessSync, constants, statSync } from 'node:fs';
import type { LndOpts } from './lnd.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Comma separated ws:// or wss:// URLs. Rejects anything else so a typo can't silently point at the wrong place. */
export function parseRelays(csv: string | undefined): string[] {
  const list = (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('RELAYS is empty: give at least one ws:// or wss:// relay URL, comma separated');
  const out = new Set<string>();
  for (const r of list) {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      throw new Error(`invalid relay URL: ${r}`);
    }
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error(`relay must be ws:// or wss://, got ${u.protocol} (${r})`);
    if (u.username || u.password) throw new Error(`relay URLs must not contain credentials (${u.hostname})`);
    out.add(u.href);
  }
  if (out.size > 10) throw new Error('at most 10 relays are supported');
  return [...out];
}

/** ws:// to a non-loopback host sends metadata (who publishes, when, how big) in the clear. Content stays encrypted. */
export const isCleartextRemote = (url: string): boolean => {
  const u = new URL(url);
  return u.protocol === 'ws:' && !LOOPBACK.has(u.hostname);
};

export function intFromEnv(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}, got ${raw}`);
  return n;
}

export function loadLndOpts(env: NodeJS.ProcessEnv): LndOpts {
  const certPath = env.LND_CERT;
  const macaroonPath = env.LND_MACAROON;
  if (!certPath) throw new Error('LND_CERT is not set (path to lnd tls.cert)');
  if (!macaroonPath) throw new Error('LND_MACAROON is not set (path to a macaroon file)');
  return { certPath, macaroonPath, host: env.LND_HOST || undefined, port: intFromEnv(env, 'LND_PORT', 8080, 1, 65535) };
}

/** A macaroon is a bearer credential: true if group or others can read the file (never on Windows, where modes mean nothing). */
export function isLooseMode(path: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

export const isLoopbackUrl = (url: string): boolean => LOOPBACK.has(new URL(url).hostname);

export const NETWORKS = ['mainnet', 'testnet', 'testnet4', 'signet', 'regtest'] as const;
export type Network = (typeof NETWORKS)[number] | 'unknown';
export const normalizeNetwork = (n?: string): Network => {
  const v = (n ?? '').toLowerCase();
  return (NETWORKS as readonly string[]).includes(v) ? (v as Network) : 'unknown';
};

/**
 * Lifeboat is only tested on regtest. Touching mainnet must be a deliberate act, never an accident.
 * LIFEBOAT_NETWORK, when set, names the network the operator means to use; any other node is refused.
 */
export function assertNetworkAllowed(network: Network, env: NodeJS.ProcessEnv = process.env) {
  const expected = env.LIFEBOAT_NETWORK?.trim().toLowerCase();
  if (expected && network !== expected) {
    throw new Error(`this lnd node is on ${network.toUpperCase()} but LIFEBOAT_NETWORK=${expected}. Refusing to continue: point at the node you meant, or fix LIFEBOAT_NETWORK.`);
  }
  if (network === 'mainnet' && env.LIFEBOAT_ALLOW_MAINNET !== '1') {
    throw new Error(
      'this lnd node is on MAINNET. Lifeboat has only been tested on regtest and refuses mainnet by default. ' +
        'Read docs/testnet-checklist.md, and set LIFEBOAT_ALLOW_MAINNET=1 only if you accept that risk.',
    );
  }
}

/** Startup validation: every problem at once, in words the operator can act on. */
export function validateConfig(env: NodeJS.ProcessEnv, o: { needRelays: boolean; needNode?: boolean } = { needRelays: true }): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const file = (name: string, what: string) => {
    const p = env[name];
    if (!p) {
      errors.push(`${name} is not set (${what})`);
      return;
    }
    try {
      accessSync(p, constants.R_OK);
      if (statSync(p).size === 0) errors.push(`${name} points at an empty file: ${p}`);
    } catch {
      errors.push(`${name} is not a readable file: ${p}`);
    }
  };
  if (o.needNode !== false) {
    file('LND_CERT', 'path to lnd tls.cert');
    file('LND_MACAROON', 'path to a macaroon file');
    for (const [name, lo, hi] of [['LND_PORT', 1, 65535]] as const) {
      try {
        intFromEnv(env, name, 8080, lo, hi);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (env.LND_MACAROON && isLooseMode(env.LND_MACAROON)) warnings.push('the macaroon file is readable by other users; run chmod 600 on it');
  }
  if (o.needRelays) {
    try {
      const relays = parseRelays(env.RELAYS);
      if (relays.length < 2) warnings.push('only one relay configured: it can withhold or serve a stale backup; use at least two');
      for (const r of relays.filter(isCleartextRemote)) warnings.push(`${r} uses cleartext ws://; content stays encrypted but metadata is visible`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  for (const [name, lo, hi] of [['PORT', 1, 65535], ['STALE_AFTER_SEC', 60, 30 * 86400]] as const) {
    try {
      intFromEnv(env, name, lo, lo, hi);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const net = env.LIFEBOAT_NETWORK?.trim().toLowerCase();
  if (net && !(NETWORKS as readonly string[]).includes(net)) errors.push(`LIFEBOAT_NETWORK must be one of ${NETWORKS.join(', ')}, got "${net}"`);
  return { errors, warnings };
}

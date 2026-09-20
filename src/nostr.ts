import * as nip44 from 'nostr-tools/nip44';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { MAX_PAYLOAD_BYTES } from './payload.js';

// nostr-tools defaults to the global WebSocket. On Node 22 its onerror handler calls close(), which fires another error inside
// undici, recursing until the stack overflows: any unreachable relay crashed the process. The `ws` package does not do this.
useWebSocketImplementation(WebSocket);

/** NIP-78 application-specific data: addressable, so relays keep only the newest per (pubkey, d). */
export const KIND = 30078;
export const D_TAG = 'lifeboat/scb/v1';

const selfKey = (sk: Uint8Array) => nip44.getConversationKey(sk, getPublicKey(sk));
const filterFor = (pk: string) => ({ kinds: [KIND], authors: [pk], '#d': [D_TAG] });
const newestFirst = (a: Event, b: Event) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1);

/**
 * Relays are untrusted: they may ignore our filter and send anything, so re-check the shape, author, kind, d-tag and
 * signature locally. Never throws, whatever `e` is.
 */
export const isOwnValid = (e: Event, pk: string): boolean => {
  try {
    return (
      !!e && typeof e === 'object' && e.kind === KIND && e.pubkey === pk && Array.isArray(e.tags) && typeof e.content === 'string' && Number.isInteger(e.created_at) &&
      e.tags.some((t) => Array.isArray(t) && t[0] === 'd' && t[1] === D_TAG) && verifyEvent(e)
    );
  } catch {
    return false;
  }
};

/** `encryptMs` is the time spent on NIP-44 encryption and signing, before any relay was contacted. */
export type PublishResult = { eventId: string; ok: string[]; failed: { url: string; error: string }[]; encryptMs?: number };

/** Publishes the payload, NIP-44 encrypted (and padded) to ourselves. Throws if no relay accepted it. */
export async function publishBackup(pool: SimplePool, relays: string[], sk: Uint8Array, payload: string, createdAt: number): Promise<PublishResult> {
  const bytes = Buffer.byteLength(payload);
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error(`backup payload is ${bytes} bytes, over the NIP-44 limit of ${MAX_PAYLOAD_BYTES}`);
  const tEnc = performance.now();
  const ev = finalizeEvent({ kind: KIND, created_at: createdAt, tags: [['d', D_TAG]], content: nip44.encrypt(payload, selfKey(sk)) }, sk);
  const encryptMs = Math.round((performance.now() - tEnc) * 100) / 100;
  const settled = await Promise.allSettled(pool.publish(relays, ev));
  const ok: string[] = [];
  const failed: { url: string; error: string }[] = [];
  settled.forEach((r, i) => (r.status === 'fulfilled' ? ok.push(relays[i]) : failed.push({ url: relays[i], error: String(r.reason) })));
  if (!ok.length) throw new Error(`no relay accepted the backup: ${failed.map((f) => `${f.url} (${f.error})`).join('; ')}`);
  return { eventId: ev.id, ok, failed, encryptMs };
}

/** Clock skew we tolerate before an event counts as "from the future". */
export const FUTURE_SKEW_SEC = 600;

export type Backup = { blob: string; createdAt: number; id: string; skipped: number; futureDated: boolean };

/**
 * Selection rules, in order:
 *  1. only events that are ours (author, kind, d tag) with a valid signature are candidates; duplicates collapse by id;
 *  2. candidates are ordered newest first (ties: lowest id);
 *  3. the newest one that decrypts, passes `accept` (a payload check that throws) and is not dated beyond `now + FUTURE_SKEW_SEC` wins, so a future-dated event can never
 *     shadow a current backup;
 *  4. only if every decryptable candidate is future-dated do we return the newest of them, flagged `futureDated`.
 * Bad candidates are counted in `skipped`, never fatal.
 */
export function pickNewestDecryptable(evs: Event[], sk: Uint8Array, now = Math.floor(Date.now() / 1000), accept?: (blob: string) => void): Backup | null {
  const pk = getPublicKey(sk);
  const unique = [...new Map(evs.map((e) => [e.id, e])).values()];
  const mine = unique.filter((e) => isOwnValid(e, pk)).sort(newestFirst);
  let skipped = unique.length - mine.length;
  let fallback: Backup | null = null;
  for (const e of mine) {
    let blob: string;
    try {
      blob = nip44.decrypt(e.content, selfKey(sk));
      accept?.(blob);
    } catch {
      skipped++;
      continue;
    }
    const future = e.created_at > now + FUTURE_SKEW_SEC;
    if (!future) return { blob, createdAt: e.created_at, id: e.id, skipped, futureDated: false };
    fallback ??= { blob, createdAt: e.created_at, id: e.id, skipped: 0, futureDated: true };
  }
  return fallback ? { ...fallback, skipped } : null;
}

export async function fetchLatestBackup(pool: SimplePool, relays: string[], sk: Uint8Array, maxWait = 8000, accept?: (blob: string) => void): Promise<Backup | null> {
  const evs = await pool.querySync(relays, filterFor(getPublicKey(sk)), { maxWait });
  return pickNewestDecryptable(evs, sk, undefined, accept);
}

export type RelayProbe = { url: string; reachable: boolean; latencyMs?: number; events: Event[]; error?: string };

/** Connects, asks for our backup event, and reports reachability, latency and what the relay actually holds. */
export const probeRelay = (url: string, pk: string, timeoutMs = 5000) => probeRelayFilter(url, filterFor(pk), timeoutMs);

export function probeRelayFilter(url: string, filter: object, timeoutMs = 5000): Promise<RelayProbe> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const events: Event[] = [];
    let done = false;
    let ws: WebSocket;
    const finish = (p: Partial<RelayProbe>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.terminate();
      } catch {
        // already closed
      }
      resolve({ url, reachable: false, events, ...p });
    };
    const timer = setTimeout(() => finish({ error: 'timed out' }), timeoutMs);
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    } catch (e) {
      return finish({ error: (e as Error).message });
    }
    ws.on('error', (e) => finish({ error: e.message || 'connection failed' }));
    ws.on('close', () => finish({ error: 'connection closed' }));
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'lb', filter])));
    ws.on('message', (raw) => {
      let m: unknown;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(m)) return; // a relay is free to send anything; only well-formed frames count
      if (m[0] === 'EVENT' && m[1] === 'lb' && m[2] && typeof m[2] === 'object') events.push(m[2] as Event);
      else if (m[0] === 'EOSE') finish({ reachable: true, latencyMs: Date.now() - t0 });
      else if (m[0] === 'CLOSED') finish({ error: String(m[2] ?? 'subscription closed') });
    });
  });
}

/** Newest created_at of any valid event of ours on the relays (0 if none, unreachable relays ignored). */
export async function newestOwnTimestamp(relays: string[], pk: string, timeoutMs = 4000): Promise<number> {
  const probes = await Promise.all(relays.map((u) => probeRelay(u, pk, timeoutMs)));
  return Math.max(0, ...probes.flatMap((p) => p.events.filter((e) => isOwnValid(e, pk)).map((e) => e.created_at)));
}

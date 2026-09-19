import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { deriveNostrKey } from './keys.js';
import type { BackupLnd, BackupSnapshot, Lnd } from './lnd.js';
import type { Logger } from './log.js';
import { FUTURE_SKEW_SEC, fetchLatestBackup, isOwnValid, newestOwnTimestamp, pickNewestDecryptable, probeRelay, publishBackup, type PublishResult } from './nostr.js';
import { chanPointId, channelSetHash, decodePayload, encodePayload } from './payload.js';
import { RelaySet } from './relays.js';
import { sleep } from './util.js';

export type Publisher = {
  publish(relays: string[], sk: Uint8Array, payload: string, createdAt: number): Promise<PublishResult>;
  close(relays: string[]): void;
  /** Newest created_at of our events already on the relays, so new events always sort after them. */
  newestTimestamp?(relays: string[], sk: Uint8Array): Promise<number>;
};

export const nostrPublisher = (): Publisher => {
  const pool = new SimplePool();
  return {
    publish: (r, sk, p, ts) => publishBackup(pool, r, sk, p, ts),
    close: (r) => pool.close(r),
    newestTimestamp: (r, sk) => newestOwnTimestamp(r, getPublicKey(sk)),
  };
};

/** The backup pipeline's states. `canTransition` is the only definition of what may follow what. */
export type BackupState = 'IDLE' | 'BACKING_UP' | 'ENCRYPTING' | 'PUBLISHING' | 'VERIFYING' | 'SUCCESS' | 'DEGRADED' | 'FAILED' | 'RECOVERING';

const ALLOWED: Record<BackupState, BackupState[]> = {
  IDLE: ['BACKING_UP', 'FAILED'],
  // a snapshot that changes nothing goes straight back to the state we rested in
  BACKING_UP: ['ENCRYPTING', 'IDLE', 'SUCCESS', 'DEGRADED', 'FAILED'],
  ENCRYPTING: ['PUBLISHING', 'FAILED'],
  PUBLISHING: ['SUCCESS', 'DEGRADED', 'FAILED'],
  // a publish may preempt a verification that is in flight
  VERIFYING: ['SUCCESS', 'DEGRADED', 'FAILED', 'BACKING_UP'],
  SUCCESS: ['BACKING_UP', 'VERIFYING', 'FAILED'],
  DEGRADED: ['BACKING_UP', 'VERIFYING', 'RECOVERING', 'FAILED'],
  FAILED: ['RECOVERING', 'BACKING_UP'],
  RECOVERING: ['BACKING_UP', 'FAILED'],
};
const RESTING: BackupState[] = ['IDLE', 'SUCCESS', 'DEGRADED', 'FAILED'];
export const canTransition = (from: BackupState, to: BackupState) => from === to || ALLOWED[from].includes(to);

/** An event only counts as a backup if its payload is usable: an unreadable newer one must not hide an older good one. */
const usablePayload = (blob: string) => void decodePayload(blob);

export type PublishRecord = {
  at: number;
  channels: number;
  bytes: number;
  eventId: string;
  fingerprint: string;
  durationMs: number;
  /** NIP-44 encryption and signing time; part of `durationMs`. Absent if the publisher did not measure it. */
  encryptMs?: number;
  relaysOk: string[];
  relaysFailed: { url: string; error: string }[];
};

export type BackupStatus = {
  running: boolean;
  state: BackupState;
  nostrPubkey?: string;
  streamConnected: boolean;
  publishes: number;
  failures: number;
  retryPending: boolean;
  nextRetryMs?: number;
  invalidTransitions: number;
  lastPublish?: PublishRecord;
  lastError?: { at: number; message: string };
  history: PublishRecord[];
};

export type BackupServiceOpts = {
  lnd: BackupLnd;
  relays: string[] | RelaySet;
  log: Logger;
  publisher?: Publisher;
  /** Backoff after a failed publish; the last value repeats. Each delay gets +/-20% jitter so instances don't retry in lockstep. */
  retryMs?: number[];
  /** Random source for the jitter, 0..1. */
  random?: () => number;
  /** Republish the current backup this often even if nothing changed, so relays that prune old events keep it. */
  refreshMs?: number;
  resubscribeMs?: number;
  onPublish?: (r: PublishRecord) => void;
  onState?: (s: BackupState) => void;
};

/**
 * Keeps the newest channel backup on Nostr. Publishes on every change lnd reports, re-exports after the stream
 * reconnects (changes during the gap would otherwise be missed), retries failures with jittered backoff,
 * and refreshes periodically. Work is serialised, so states never interleave.
 */
export class BackupService {
  readonly relays: RelaySet;
  private sk?: Uint8Array;
  private last = '';
  private lastTs = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = true;
  private streamUp = false;
  private closeStream = () => {};
  private timers = new Set<NodeJS.Timeout>();
  private retryTimer?: NodeJS.Timeout;
  private retryStep = 0;
  private nextRetryMs?: number;
  private history: PublishRecord[] = [];
  private lastError?: { at: number; message: string };
  private counts = { publishes: 0, failures: 0, invalid: 0 };
  private state: BackupState = 'IDLE';
  private rest: BackupState = 'IDLE';
  private readonly publisher: Publisher;

  constructor(private o: BackupServiceOpts) {
    this.publisher = o.publisher ?? nostrPublisher();
    this.relays = o.relays instanceof RelaySet ? o.relays : new RelaySet(o.relays);
  }

  async start(): Promise<void> {
    if (!this.stopped) return; // already running: a second start would double the timers and the lnd subscription
    this.stopped = false;
    try {
      await this.begin();
    } catch (e) {
      this.stopped = true; // a failed start must not look like a running service
      throw e;
    }
  }

  private async begin(): Promise<void> {
    this.sk = await deriveNostrKey(this.o.lnd);
    // A relay keeps only the newest event per key, so if it already holds one dated in our future (clock skew, an old run),
    // events we publish now would be silently ignored. Start after it.
    this.lastTs = (await this.publisher.newestTimestamp?.(this.relays.active(), this.sk).catch(() => 0)) ?? 0;
    this.o.log.info('backup service started', { category: 'backup', nostrPubkey: this.nostrPubkey(), relays: this.relays.active() });
    this.bg('startup', () => this.exportAndPublish('startup', false));
    this.subscribe();
    const every = this.o.refreshMs ?? 6 * 3600_000;
    this.timers.add(setInterval(() => this.bg('refresh', () => this.exportAndPublish('refresh', true)), every));
  }

  stop(): void {
    this.stopped = true;
    this.closeStream();
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.streamUp = false;
    this.state = 'IDLE'; // documented reset: a stopped service is idle whatever it was doing
    this.rest = 'IDLE';
    this.publisher.close(this.relays.all().map((r) => r.url));
  }

  nostrPubkey(): string | undefined {
    return this.sk && getPublicKey(this.sk);
  }

  /** The service's Nostr secret key, for verification against relays. Never logged or serialised. */
  secretKey(): Uint8Array {
    if (!this.sk) throw new Error('backup service not started');
    return this.sk;
  }

  /** Publish the node's current backup now, even if unchanged. Rejects if no relay accepted it. */
  publishNow(): Promise<PublishRecord | null> {
    return this.exec('manual', () => this.exportAndPublish('manual', true));
  }

  /** The monitor reports its verification here so the pipeline state reflects what was actually proven. */
  beginVerify(): boolean {
    if (this.state !== 'SUCCESS' && this.state !== 'DEGRADED') return false;
    this.setState('VERIFYING');
    return true;
  }
  endVerify(verdict: 'verified' | 'degraded' | 'failed') {
    if (this.state !== 'VERIFYING') return;
    this.setState(verdict === 'verified' ? 'SUCCESS' : verdict === 'degraded' ? 'DEGRADED' : 'FAILED');
  }

  status(): BackupStatus {
    return {
      running: !this.stopped,
      state: this.state,
      nostrPubkey: this.nostrPubkey(),
      streamConnected: this.streamUp,
      publishes: this.counts.publishes,
      failures: this.counts.failures,
      retryPending: !!this.retryTimer,
      nextRetryMs: this.retryTimer ? this.nextRetryMs : undefined,
      invalidTransitions: this.counts.invalid,
      lastPublish: this.history.at(-1),
      lastError: this.lastError,
      history: [...this.history],
    };
  }

  private setState(next: BackupState) {
    if (next === this.state) return;
    if (!canTransition(this.state, next)) {
      this.counts.invalid++;
      this.o.log.error('invalid backup state transition ignored', { category: 'backup', from: this.state, to: next });
      return;
    }
    this.state = next;
    if (RESTING.includes(next)) this.rest = next;
    this.o.onState?.(next);
  }

  private subscribe() {
    if (this.stopped) return;
    this.streamUp = true;
    this.closeStream = this.o.lnd.subscribeBackups(
      (snap) => this.bg('stream', () => this.publishSnapshot(snap, 'stream', false)),
      (e) => {
        this.streamUp = false;
        if (this.stopped) return;
        this.o.log.warn('backup stream ended, resubscribing', { category: 'lnd', error: e?.message });
        const t = setTimeout(() => {
          this.timers.delete(t);
          this.subscribe();
          // anything that changed while the stream was down is only visible in a fresh export
          this.bg('resubscribe', () => this.exportAndPublish('resubscribe', false));
        }, this.o.resubscribeMs ?? 3000);
        this.timers.add(t);
      },
    );
  }

  private exportAndPublish(reason: string, force: boolean) {
    return this.o.lnd.exportBackup().then((snap) => this.publishSnapshot(snap, reason, force));
  }

  private async publishSnapshot(snap: BackupSnapshot, reason: string, force: boolean): Promise<PublishRecord | null> {
    this.setState('BACKING_UP');
    const m = snap.multi_chan_backup;
    if (!m || !this.sk) {
      this.setState(this.rest);
      return null;
    }
    const peers = await this.o.lnd.channelPeerHints().catch((e: Error) => {
      this.o.log.warn('could not read peer hints, publishing without them', { category: 'lnd', error: e.message });
      return [] as string[];
    });
    // compare by channel set + peers, never by blob: lnd re-encrypts on every export
    const cp = channelSetHash(m.chan_points);
    const key = `${cp}|${[...peers].sort().join(',')}`;
    if (!force && key === this.last) {
      this.setState(this.rest);
      return null;
    }
    this.setState('ENCRYPTING');
    const payload = encodePayload({ v: 1, scb: m.multi_chan_backup, peers, cp });
    const relays = this.relays.active();
    if (!relays.length) throw new Error('no relay is enabled');
    this.setState('PUBLISHING');
    const t0 = Date.now();
    const ts = Math.max(Math.floor(Date.now() / 1000), this.lastTs + 1);
    const res = await this.publisher.publish(relays, this.sk, payload, ts);
    this.last = key;
    this.lastTs = ts;
    this.retryStep = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.lastError = undefined;
    const rec: PublishRecord = {
      at: Date.now(),
      channels: m.chan_points.length,
      bytes: Buffer.byteLength(payload),
      eventId: res.eventId,
      fingerprint: cp,
      durationMs: Date.now() - t0,
      encryptMs: res.encryptMs,
      relaysOk: res.ok,
      relaysFailed: res.failed,
    };
    this.history.push(rec);
    if (this.history.length > 20) this.history.shift();
    this.counts.publishes++;
    this.setState(res.failed.length ? 'DEGRADED' : 'SUCCESS');
    this.o.log.info('backup published', { category: 'backup', reason, channels: rec.channels, bytes: rec.bytes, durationMs: rec.durationMs, relaysOk: res.ok.length, relaysFailed: res.failed.length });
    if (res.failed.length) this.o.log.warn('some relays did not accept the backup', { category: 'relay', failed: res.failed });
    this.o.onPublish?.(rec);
    return rec;
  }

  /** Serialised; a failure is recorded and retried with backoff, then rethrown to the caller. */
  private exec(reason: string, fn: () => Promise<PublishRecord | null>): Promise<PublishRecord | null> {
    const p = this.queue.then(fn, fn).catch((e: Error) => {
      this.fail(reason, e);
      throw e;
    });
    this.queue = p.catch(() => undefined);
    return p;
  }

  private bg(reason: string, fn: () => Promise<PublishRecord | null>) {
    this.exec(reason, fn).catch(() => undefined);
  }

  private fail(reason: string, e: Error) {
    this.counts.failures++;
    this.lastError = { at: Date.now(), message: e.message };
    this.setState('FAILED');
    if (this.stopped) return;
    const steps = this.o.retryMs ?? [5_000, 15_000, 60_000, 300_000];
    const base = steps[Math.min(this.retryStep++, steps.length - 1)];
    const ms = Math.max(1, Math.round(base * (0.8 + 0.4 * (this.o.random ?? Math.random)())));
    this.o.log.warn('backup publish failed, will retry', { category: 'backup', reason, error: e.message, retryInMs: ms });
    if (this.retryTimer) return;
    this.nextRetryMs = ms;
    this.setState('RECOVERING');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.bg('retry', () => this.exportAndPublish('retry', true));
    }, ms);
  }
}

export type RelayState = 'healthy' | 'stale' | 'missing' | 'down';

export type RelayHealth = {
  url: string;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  hasBackup: boolean;
  hasLatest: boolean;
  createdAt?: number;
  /** healthy: holds the newest backup. stale: holds an older one. missing: reachable but holds none. down: unreachable */
  state: RelayState;
  /** events this relay returned that are not valid backups for our key (other authors, wrong tags, bad signatures) */
  foreignEvents: number;
};

export type VerifyResult = {
  ok: boolean;
  /** verified: proven and no caveats. degraded: proven, with caveats. failed: not proven. */
  verdict: 'verified' | 'degraded' | 'failed';
  checkedAt: number;
  createdAt?: number;
  ageSec?: number;
  matchesCurrent?: boolean;
  fingerprint?: string;
  /** true: lnd itself decrypted the relay copy and accepted it. false: lnd rejected it. undefined: lnd was not asked */
  lndValidated?: boolean;
  /** channels lnd found inside the relay copy (only when `lndValidated`) */
  channelsInBackup?: number;
  futureDated?: boolean;
  channelsCurrent: number;
  relays: RelayHealth[];
  problems: string[];
};

/**
 * A restore dry run: fetch the backup from every relay, decrypt it with the key derived from the seed,
 * and check it matches what lnd would export right now. Nothing is written to lnd.
 */
export async function verifyBackup(o: {
  lnd: Pick<BackupLnd, 'exportBackup'> & { verifyBackup?: (scb: string) => Promise<string[]> };
  sk: Uint8Array;
  relays: string[];
  timeoutMs?: number;
}): Promise<VerifyResult> {
  const pk = getPublicKey(o.sk);
  const [probes, snap] = await Promise.all([Promise.all(o.relays.map((u) => probeRelay(u, pk, o.timeoutMs))), o.lnd.exportBackup()]);
  const best = pickNewestDecryptable(probes.flatMap((p) => p.events), o.sk, undefined, usablePayload);
  const current = snap.multi_chan_backup;
  const problems: string[] = [];

  const relays: RelayHealth[] = probes.map((p) => {
    const own = p.events.filter((e) => isOwnValid(e, pk)).sort((a, b) => b.created_at - a.created_at);
    const hasLatest = !!best && own.some((e) => e.id === best.id);
    return {
      url: p.url,
      reachable: p.reachable,
      latencyMs: p.latencyMs,
      error: p.error,
      hasBackup: own.length > 0,
      hasLatest,
      createdAt: own[0]?.created_at,
      state: !p.reachable ? 'down' : !own.length ? 'missing' : hasLatest ? 'healthy' : 'stale',
      foreignEvents: new Set(p.events.map((e) => e.id)).size - own.length,
    };
  });

  const reachable = relays.filter((r) => r.reachable);
  if (!reachable.length) problems.push('no relay is reachable');
  else if (reachable.length < relays.length) problems.push(`${relays.length - reachable.length} relay(s) unreachable`);
  let matchesCurrent: boolean | undefined;
  let ageSec: number | undefined;
  let fingerprint: string | undefined;
  let lndValidated: boolean | undefined;
  let channelsInBackup: number | undefined;
  if (!best) {
    if (reachable.length) problems.push('no decryptable backup for this seed was found on any reachable relay');
  } else {
    ageSec = Math.max(0, Math.floor(Date.now() / 1000) - best.createdAt);
    const newerUnusable = new Set(probes.flatMap((p) => p.events).filter((e) => isOwnValid(e, pk) && e.created_at > best.createdAt && e.created_at <= Math.floor(Date.now() / 1000) + FUTURE_SKEW_SEC).map((e) => e.id)).size;
    if (newerUnusable) problems.push(`${newerUnusable} newer backup event(s) for this key are unreadable (undecryptable or invalid payload) and were skipped`);
    if (best.futureDated) problems.push('the newest backup is dated in the future (clock skew or a stale writer); check the clocks');
    try {
      const payload = decodePayload(best.blob);
      fingerprint = payload.cp;
      if (o.lnd.verifyBackup) {
        // lnd is the authority on what is inside the blob: it decrypts with the node's own key and lists the channels
        try {
          const inside = await o.lnd.verifyBackup(payload.scb);
          lndValidated = true;
          channelsInBackup = inside.length;
          const now = new Set(current?.chan_points.map(chanPointId));
          matchesCurrent = current ? inside.length === now.size && inside.every((p) => now.has(p)) : undefined;
        } catch (e) {
          lndValidated = false;
          matchesCurrent = false;
          problems.push(`lnd rejected the backup on the relays (it is corrupted or was made by another seed): ${(e as Error).message}`);
        }
      } else {
        matchesCurrent = current ? (payload.cp ? payload.cp === channelSetHash(current.chan_points) : payload.scb === current.multi_chan_backup) : undefined;
      }
      if (matchesCurrent === false && lndValidated !== false) problems.push("the backup on the relays is behind the node's current channels");
    } catch (e) {
      problems.push(`the backup on the relays is unreadable: ${(e as Error).message}`);
    }
    const missing = reachable.filter((r) => r.state === 'missing').length;
    const stale = reachable.filter((r) => r.state === 'stale').length;
    if (missing) problems.push(`${missing} reachable relay(s) hold no backup`);
    if (stale) problems.push(`${stale} reachable relay(s) hold an older backup than the newest one`);
  }
  for (const r of relays.filter((x) => x.foreignEvents > 0)) {
    problems.push(`${r.url} returned ${r.foreignEvents} event(s) that are not valid backups for this key (ignored)`);
  }

  const ok = reachable.length > 0 && !!best && matchesCurrent === true;
  return {
    ok,
    verdict: !ok ? 'failed' : problems.length ? 'degraded' : 'verified',
    checkedAt: Date.now(),
    createdAt: best?.createdAt,
    ageSec,
    matchesCurrent,
    fingerprint,
    lndValidated,
    channelsInBackup,
    futureDated: best?.futureDated,
    channelsCurrent: current?.chan_points.length ?? 0,
    relays,
    problems,
  };
}

export type RestoreResult = {
  createdAt: number;
  eventId: string;
  fingerprint?: string;
  skipped: number;
  peers: number;
  channelsAwaitingClose: number;
  timings: { discoverMs: number; importMs: number; redialMs: number; totalMs: number };
};

/**
 * Fetches the newest backup for this wallet's seed from Nostr and hands it to lnd, then keeps dialing the
 * channel peers: lnd's own restore connects once, and with several channels to one peer that single
 * attempt can be torn down mid-handshake, leaving nobody to trigger the peer's force-close.
 */
export async function restoreFromNostr(lnd: Lnd, relays: string[], o: { reconnectRounds?: number; pauseMs?: number; log?: Logger } = {}): Promise<RestoreResult> {
  const t0 = Date.now();
  await lnd.waitActive();
  const sk = await deriveNostrKey(lnd);
  const pool = new SimplePool();
  try {
    const t1 = Date.now();
    const got = await fetchLatestBackup(pool, relays, sk, undefined, usablePayload);
    if (!got) throw new Error('no backup for this seed found on the given relays');
    if (got.skipped) o.log?.warn('ignored relay events that were not valid backups for this seed', { category: 'relay', skipped: got.skipped });
    if (got.futureDated) o.log?.warn('the newest backup is dated in the future; restoring it because nothing newer exists', { category: 'relay' });
    const payload = decodePayload(got.blob);
    const t2 = Date.now();
    await lnd.restoreBackup(payload.scb);
    const t3 = Date.now();
    for (let i = 0; i < (o.reconnectRounds ?? 5); i++) {
      await Promise.allSettled(payload.peers.map((p) => lnd.connectPeer(p)));
      await sleep(o.pauseMs ?? 3000);
    }
    const t4 = Date.now();
    const pending = await lnd.pending().catch(() => null);
    return {
      createdAt: got.createdAt,
      eventId: got.id,
      fingerprint: payload.cp,
      skipped: got.skipped,
      peers: payload.peers.length,
      channelsAwaitingClose: pending?.waiting_close_channels?.length ?? 0,
      timings: { discoverMs: t2 - t1, importMs: t3 - t2, redialMs: t4 - t3, totalMs: t4 - t0 },
    };
  } finally {
    pool.close(relays);
  }
}

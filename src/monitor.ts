import { basename } from 'node:path';
import { BackupService, verifyBackup, type BackupStatus, type Publisher, type VerifyResult } from './backup.js';
import { assertNetworkAllowed, isLooseMode, normalizeNetwork, type Network } from './config.js';
import { MONITOR_PERMS, type Lnd, type NodeInfo } from './lnd.js';
import type { LogEntry, Logger } from './log.js';
import { RelaySet, type RelayEntry } from './relays.js';
import { assess, type Check, type CheckStatus } from './security.js';

export type MonitorOpts = {
  lnd: Lnd;
  relays: string[] | RelaySet;
  log: Logger;
  publisher?: Publisher;
  /** Path of the macaroon file the lnd client uses, to warn about loose file permissions. */
  macaroonPath?: string;
  /** Mainnet is refused unless this is true. */
  allowMainnet?: boolean;
  /** the network the operator means to use (LIFEBOAT_NETWORK); a node on any other network is refused */
  expectNetwork?: string;
  infoEveryMs?: number;
  verifyEveryMs?: number;
  staleAfterSec?: number;
  refreshMs?: number;
  retryMs?: number[];
  /** Override for tests. */
  verifyFn?: typeof verifyBackup;
};

export type MonitorSnapshot = {
  now: number;
  startedAt: number;
  node: { connected: boolean; error?: string; pubkey?: string; alias?: string; network: Network; version?: string; blockHeight?: number; synced?: boolean };
  channels: { total: number; active: number; pending: number; localSats: number; remoteSats: number } | null;
  nostr: { pubkey?: string };
  backup: BackupStatus;
  relays: RelayEntry[];
  verify: VerifyResult | null;
  /** `needs`: what Lifeboat requires of its macaroon. `canSpend` is asked of lnd itself. */
  macaroon: { canSpend: boolean | null; fileLoose: boolean | null; file?: string; needs: string[] };
  security: { checks: Check[]; worst: CheckStatus };
  config: { relays: string[]; staleAfterSec: number };
  logs: LogEntry[];
};

/** Runs the backup service against a live lnd and keeps real, measured state for the dashboard. */
export class Monitor {
  readonly backup: BackupService;
  readonly relays: RelaySet;
  private startedAt = Date.now();
  private info?: NodeInfo;
  private chans: MonitorSnapshot['channels'] = null;
  private infoError?: string;
  private verify?: VerifyResult;
  private canSpend: boolean | undefined;
  private timers = new Set<NodeJS.Timeout>();
  private verifyTimer?: NodeJS.Timeout;
  private inflight?: Promise<VerifyResult>;
  private stopped = true;
  private healing = false;

  constructor(private o: MonitorOpts) {
    this.relays = o.relays instanceof RelaySet ? o.relays : new RelaySet(o.relays);
    this.backup = new BackupService({
      lnd: o.lnd,
      relays: this.relays,
      log: o.log,
      publisher: o.publisher,
      refreshMs: o.refreshMs,
      retryMs: o.retryMs,
      // verify shortly after each publish so the dashboard reflects the new state without waiting for the next tick
      onPublish: () => this.scheduleVerify(1500),
    });
    // a relay added or enabled at runtime should receive the current backup, and the health view should catch up
    this.relays.onChange(() => {
      if (this.stopped) return;
      this.backup.publishNow().catch(() => undefined);
      this.scheduleVerify(1500);
    });
  }

  async start() {
    if (!this.stopped) return; // already running: a second start would double every timer and subscription
    this.stopped = false;
    try {
      await this.begin();
    } catch (e) {
      this.stop(); // a failed or refused start must not look like a running monitor
      throw e;
    }
  }

  private async begin() {
    this.startedAt = Date.now();
    await this.pollInfo();
    // refuse mainnet before anything is published or any key is derived
    assertNetworkAllowed(normalizeNetwork(this.info?.chains?.[0]?.network), {
      ...(this.o.allowMainnet ? { LIFEBOAT_ALLOW_MAINNET: '1' } : {}),
      ...(this.o.expectNetwork ? { LIFEBOAT_NETWORK: this.o.expectNetwork } : {}),
    });
    await this.backup.start();
    this.canSpend = await this.o.lnd.canSpendOnchain().catch(() => undefined);
    this.o.log.info('macaroon privilege check', { category: 'security', canSpendOnchain: this.canSpend ?? 'unknown' });
    this.every(this.o.infoEveryMs ?? 10_000, () => this.pollInfo());
    this.every(this.o.verifyEveryMs ?? 60_000, () => this.verifyNow().catch(() => undefined));
    this.every(3600_000, async () => {
      this.canSpend = await this.o.lnd.canSpendOnchain().catch(() => undefined);
    });
    this.scheduleVerify(500);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.backup.stop();
  }

  private every(ms: number, fn: () => unknown) {
    this.timers.add(setInterval(() => void fn(), ms));
  }

  private scheduleVerify(ms: number) {
    if (this.stopped) return;
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => void this.verifyNow().catch(() => undefined), ms);
  }

  /** Single-flight: concurrent callers share one verification instead of probing every relay several times. */
  verifyNow(): Promise<VerifyResult> {
    if (this.inflight) return this.inflight;
    const run = async () => {
      const began = this.backup.beginVerify();
      try {
        this.o.log.info('verification started', { category: 'verify' });
        const r = await (this.o.verifyFn ?? verifyBackup)({ lnd: this.o.lnd, sk: this.backup.secretKey(), relays: this.relays.active() });
        this.verify = r;
        if (began) this.backup.endVerify(r.verdict);
        // self-healing: if the relays are behind the node (a missed stream event, a restart), publish the current backup
        if (r.matchesCurrent === false && !this.healing && !this.stopped) {
          this.healing = true;
          this.o.log.warn('the backup on the relays is behind the node, republishing', { category: 'backup' });
          this.backup.publishNow().catch(() => undefined).finally(() => (this.healing = false));
        }
        this.o.log.info('backup verified', { category: 'verify', verdict: r.verdict, problems: r.problems });
        return r;
      } catch (e) {
        if (began) this.backup.endVerify('failed');
        this.o.log.error('backup verification could not run', { category: 'verify', error: (e as Error).message });
        throw e;
      }
    };
    this.inflight = run().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async pollInfo() {
    try {
      const [info, chans, pending] = await Promise.all([this.o.lnd.getInfo(), this.o.lnd.listChannels(), this.o.lnd.pending().catch(() => null)]);
      if (this.infoError) this.o.log.info('lnd reachable again', { category: 'lnd' });
      this.info = info;
      this.infoError = undefined;
      this.chans = {
        total: chans.length,
        active: chans.filter((c) => c.active).length,
        pending: (pending?.waiting_close_channels?.length ?? 0) + (pending?.pending_force_closing_channels?.length ?? 0),
        localSats: chans.reduce((s, c) => s + Number(c.local_balance), 0),
        remoteSats: chans.reduce((s, c) => s + Number(c.remote_balance), 0),
      };
    } catch (e) {
      const msg = (e as Error).message;
      if (this.infoError !== msg) this.o.log.warn('lnd not reachable', { category: 'lnd', error: msg });
      this.infoError = msg;
    }
  }

  snapshot(): MonitorSnapshot {
    const now = Date.now();
    const status = this.backup.status();
    const network = normalizeNetwork(this.info?.chains?.[0]?.network);
    const staleAfterSec = this.o.staleAfterSec ?? 8 * 3600;
    const fileLoose = this.o.macaroonPath ? isLooseMode(this.o.macaroonPath) : undefined;
    return {
      now,
      startedAt: this.startedAt,
      node: {
        connected: !this.infoError && !!this.info,
        error: this.infoError,
        pubkey: this.info?.identity_pubkey,
        alias: this.info?.alias,
        network,
        version: this.info?.version,
        blockHeight: this.info?.block_height,
        synced: this.info?.synced_to_chain,
      },
      channels: this.chans,
      nostr: { pubkey: status.nostrPubkey },
      backup: status,
      relays: this.relays.all(),
      verify: this.verify ?? null,
      macaroon: { canSpend: this.canSpend ?? null, fileLoose: fileLoose ?? null, file: this.o.macaroonPath ? basename(this.o.macaroonPath) : undefined, needs: MONITOR_PERMS.map((p) => `${p.entity}:${p.action}`) },
      security: assess({
        relays: this.relays.active(),
        status,
        verify: this.verify,
        canSpend: this.canSpend,
        macaroonFileLoose: fileLoose,
        lndConnected: this.info || this.infoError ? !this.infoError : undefined,
        network,
        channels: this.chans?.total,
        staleAfterSec,
        now,
      }),
      config: { relays: this.relays.active(), staleAfterSec },
      logs: this.o.log.recent(80),
    };
  }
}

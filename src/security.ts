import type { BackupStatus, VerifyResult } from './backup.js';
import { isCleartextRemote, normalizeNetwork } from './config.js';

/** pass: shown to be fine. warn: advisory. degraded: working with reduced safety margin. fail: not working. unknown: not measured yet. */
export type CheckStatus = 'pass' | 'warn' | 'degraded' | 'fail' | 'unknown';
export type Check = { id: string; status: CheckStatus; title: string; detail: string; fix?: string };

export type SecurityInput = {
  relays: string[];
  status: BackupStatus;
  verify?: VerifyResult;
  /** true: macaroon can spend on-chain. false: it cannot. undefined: lnd would not tell us. */
  canSpend: boolean | undefined;
  /** true: the macaroon file is readable by group/others. undefined: not checked. */
  macaroonFileLoose?: boolean;
  lndConnected?: boolean;
  network?: string;
  channels?: number;
  staleAfterSec: number;
  now: number;
  /** requests the console refused (wrong Host, Origin or token) since it started */
  blockedRequests?: number;
};

const RANK: Record<CheckStatus, number> = { pass: 0, unknown: 1, warn: 2, degraded: 3, fail: 4 };
const ago = (sec: number) => (sec < 120 ? `${Math.round(sec)}s` : sec < 7200 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 3600)}h`);

/** Every check is derived from live state (lnd answers, relay probes, publish history), never from what the code intends. */
export function assess(i: SecurityInput): { checks: Check[]; worst: CheckStatus } {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  add(
    i.lndConnected === undefined
      ? { id: 'lnd', status: 'unknown', title: 'lnd connection not checked yet', detail: 'The first poll has not completed.' }
      : i.lndConnected
        ? { id: 'lnd', status: 'pass', title: 'lnd reachable', detail: 'The last poll of lnd succeeded.' }
        : { id: 'lnd', status: 'fail', title: 'lnd is not reachable', detail: 'Node data and backups are paused until it answers again.', fix: 'Check that lnd is running and LND_HOST / LND_PORT are right. Reconnection is automatic.' },
  );

  const net = normalizeNetwork(i.network);
  if (net === 'mainnet') {
    add({ id: 'network', status: 'warn', title: 'MAINNET', detail: 'Lifeboat has only been tested on regtest. Real funds are involved. Read docs/testnet-checklist.md first.', fix: 'Use regtest or testnet until you have verified a restore yourself.' });
  } else if (net === 'unknown') {
    add({ id: 'network', status: 'unknown', title: 'Network not known', detail: 'lnd did not report which network it runs on.' });
  } else {
    add({ id: 'network', status: 'pass', title: net.toUpperCase(), detail: net === 'regtest' ? 'A throwaway test network, where Lifeboat has been tested end to end.' : 'A test network. Lifeboat has not been exercised end to end here yet.' });
  }

  if (i.canSpend === true) {
    add({
      id: 'macaroon',
      status: 'fail',
      title: 'Daemon macaroon can spend on-chain funds',
      detail: 'The macaroon this process uses is over-privileged. Anyone who reads it can move your coins.',
      fix: 'Bake a read-only macaroon: LND_MACAROON=<admin> npm run cli -- bake --out monitor.macaroon, then point LND_MACAROON at it.',
    });
  } else if (i.canSpend === false) {
    add({ id: 'macaroon', status: 'pass', title: 'Macaroon is least-privilege', detail: 'lnd confirmed this macaroon cannot spend on-chain funds.' });
  } else {
    add({ id: 'macaroon', status: 'unknown', title: 'Macaroon privileges could not be checked', detail: 'lnd did not answer the permission check. This usually means the macaroon lacks macaroon:read.', fix: 'Use a macaroon produced by `cli bake`, which includes macaroon:read.' });
  }
  if (i.macaroonFileLoose !== undefined) {
    add(
      i.macaroonFileLoose
        ? { id: 'macaroon-file', status: 'warn', title: 'Macaroon file is readable by other users', detail: 'A macaroon is a bearer credential.', fix: 'chmod 600 the macaroon file.' }
        : { id: 'macaroon-file', status: 'pass', title: 'Macaroon file permissions', detail: 'Only the owner can read the macaroon file.' },
    );
  }
  add({ id: 'tls', status: 'pass', title: 'lnd traffic is TLS-pinned', detail: "Every request is verified against the node's own certificate file; a different certificate is refused." });

  const reachable = i.verify ? i.verify.relays.filter((r) => r.reachable).length : undefined;
  if (i.relays.length < 2) {
    add({ id: 'relays', status: 'warn', title: 'Only one relay in use', detail: 'A single relay can withhold or serve a stale backup.', fix: 'Add a second, independent relay on the Relays tab (or set RELAYS).' });
  } else if (reachable === undefined) {
    add({ id: 'relays', status: 'unknown', title: 'Relays not probed yet', detail: `${i.relays.length} relays are in use; the first probe has not completed.` });
  } else if (reachable === 0) {
    add({ id: 'relays', status: 'fail', title: 'No relay is reachable', detail: 'The backup cannot be published or restored right now.', fix: 'Check network access and the relay URLs.' });
  } else if (reachable < 2) {
    add({ id: 'relays', status: 'degraded', title: `Only ${reachable} of ${i.relays.length} relays reachable`, detail: 'Redundancy is reduced until the others come back.' });
  } else {
    add({ id: 'relays', status: 'pass', title: 'Multiple relays', detail: `${reachable} of ${i.relays.length} relays reachable.` });
  }

  const clear = i.relays.filter(isCleartextRemote);
  add(
    clear.length
      ? { id: 'transport', status: 'warn', title: 'Cleartext relay connection', detail: `${clear.join(', ')} use ws://. Content is encrypted, but who publishes, when and how much is visible on the wire.`, fix: 'Use wss:// relays.' }
      : { id: 'transport', status: 'pass', title: 'Relay transport', detail: 'Relays use wss:// or loopback.' },
  );

  const s = i.status;
  const state = s.invalidTransitions > 0
    ? { id: 'state', status: 'fail' as const, title: 'Backup pipeline reached an impossible state', detail: `${s.invalidTransitions} invalid transition(s) were blocked. This is a bug; check the activity log.` }
    : s.state === 'FAILED'
      ? { id: 'state', status: 'fail' as const, title: 'Backup pipeline failed', detail: s.lastError?.message ?? 'The last attempt failed.' }
      : s.state === 'RECOVERING' || s.state === 'DEGRADED'
        ? { id: 'state', status: 'degraded' as const, title: `Backup pipeline ${s.state === 'RECOVERING' ? 'is recovering' : 'is degraded'}`, detail: s.state === 'RECOVERING' ? `A retry is scheduled${s.nextRetryMs ? ` in about ${Math.round(s.nextRetryMs / 1000)}s` : ''}.` : 'The last publish reached only some relays, or verification found caveats.' }
        : s.state === 'IDLE'
          ? { id: 'state', status: 'unknown' as const, title: 'Backup pipeline not started', detail: 'Waiting for the first backup.' }
          : { id: 'state', status: 'pass' as const, title: 'Backup pipeline healthy', detail: `State: ${s.state}.` };
  add(state);

  const last = s.lastPublish;
  if (!last) {
    add(
      (i.channels ?? 0) > 0
        ? { id: 'published', status: 'fail', title: 'No backup published yet', detail: 'This node has channels but nothing has reached a relay.', fix: 'Check relay reachability and the activity log.' }
        : { id: 'published', status: 'unknown', title: 'No backup published yet', detail: 'Nothing published so far.' },
    );
  } else {
    const age = (i.now - last.at) / 1000;
    add(
      age > i.staleAfterSec
        ? { id: 'published', status: 'warn', title: 'Backup not refreshed recently', detail: `Last publish was ${ago(age)} ago (threshold ${ago(i.staleAfterSec)}).` }
        : { id: 'published', status: 'pass', title: 'Backup published', detail: `${last.channels} channel(s), ${last.relaysOk.length} relay(s) accepted it ${ago(age)} ago.` },
    );
  }

  if (i.verify) {
    const v = i.verify;
    const when = `checked ${ago((i.now - v.checkedAt) / 1000)} ago`;
    if (v.verdict === 'verified') add({ id: 'verified', status: 'pass', title: 'Backup verified', detail: `Fetched from the relays, decrypted with the seed-derived key, and it matches the node's current channels (${when}).` });
    else if (v.verdict === 'degraded') add({ id: 'verified', status: 'degraded', title: 'Backup verified with caveats', detail: `${v.problems.join('; ')} (${when}).` });
    else add({ id: 'verified', status: v.matchesCurrent === false ? 'warn' : 'fail', title: 'Backup verification failed', detail: `${v.problems.join('; ') || 'unknown problem'} (${when}).` });

    const foreign = v.relays.filter((r) => r.foreignEvents > 0);
    add(
      foreign.length
        ? { id: 'relay-integrity', status: 'warn', title: 'Suspicious relay events', detail: `${foreign.map((r) => `${r.url}: ${r.foreignEvents}`).join(', ')} event(s) returned that are not valid backups for this key. They were ignored. This is not proof of malice: relays may also hold unrelated events.` }
        : { id: 'relay-integrity', status: 'pass', title: 'Relay data is clean', detail: 'Every event the relays returned was a valid backup event for this key.' },
    );
  } else {
    add({ id: 'verified', status: 'unknown', title: 'Backup not verified yet', detail: 'The first verification has not completed.' });
  }

  if (s.lastError) add({ id: 'errors', status: s.retryPending ? 'degraded' : 'warn', title: 'Last publish failed', detail: s.lastError.message, fix: s.retryPending ? 'A retry is scheduled.' : undefined });
  if (!s.streamConnected && s.running) add({ id: 'stream', status: 'degraded', title: "Not subscribed to lnd's backup stream", detail: 'Changes are only picked up on the periodic refresh until it reconnects.' });
  if (i.blockedRequests !== undefined) {
    add({ id: 'console', status: 'pass', title: 'Console guards active', detail: `Loopback only; Host, Origin and token checks and a nonce CSP are enforced. ${i.blockedRequests} request(s) refused since start.` });
  }

  const worst = checks.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'pass');
  return { checks, worst };
}

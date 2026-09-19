// Turns the lines printed by src/demo.ts into structured events for the web console.

export type Metric =
  | 'channels' | 'channelSats' | 'onchainBefore' | 'publishes' | 'publishRelays'
  | 'nostrKey' | 'identityMatch' | 'keyMatch' | 'onchainNow' | 'recovered' | 'fundsPass'
  | 'fingerprint' | 'backupBytes' | 'publishMs' | 'discoverMs' | 'importMs' | 'recoveryMs' | 'totalMs' | 'relaysOk' | 'relaysFailed' | 'feesSats'
  | 'exportMs' | 'encryptMs' | 'verifyMs' | 'redialMs' | 'relaysHealthy' | 'relaysAtRestore' | 'verifyPass' | 'fingerprintMatch';

export type DrillEvent =
  | { type: 'start'; at: number }
  | { type: 'line'; text: string; kind: 'plain' | 'head' | 'pass' | 'fail' | 'err' }
  | { type: 'stage'; index: number }
  | { type: 'metric'; key: Metric; value: string | number | boolean }
  | { type: 'end'; ok: boolean; at: number }
  | { type: 'idle' };

/** One entry per "== ..." header demo.ts prints, in order. */
const STAGES = [
  /^== fresh regtest cluster/,
  /^== fund alice/,
  /^== start Nostr backup daemon/,
  /^== DISASTER/,
  /^== RESTORE/,
  /^== peers force-close/,
];

const metric = (key: Metric, value: string | number | boolean): DrillEvent => ({ type: 'metric', key, value });

export function parseLine(text: string): DrillEvent[] {
  const kind = text.startsWith('== ') ? 'head' : text.startsWith('PASS') ? 'pass' : text.startsWith('FAIL') ? 'fail' : 'plain';
  const out: DrillEvent[] = [{ type: 'line', text, kind }];

  const stage = STAGES.findIndex((r) => r.test(text));
  if (stage >= 0) out.push({ type: 'stage', index: stage });

  let m: RegExpMatchArray | null;
  if ((m = text.match(/^alice: (\d+) sats on-chain \+ (\d+) sats in (\d+) channels/))) {
    out.push(metric('onchainBefore', +m[1]), metric('channelSats', +m[2]), metric('channels', +m[3]));
  } else if ((m = text.match(/^published: (.+)$/))) {
    const items = m[1].split(', ');
    out.push(metric('publishes', items.length));
    const last = items[items.length - 1].match(/->(\d+)relay/);
    if (last) out.push(metric('publishRelays', +last[1]));
  } else if ((m = text.match(/^backup fingerprint \(channel set\): ([0-9a-f]{64})$/))) {
    out.push(metric('fingerprint', m[1]));
  } else if ((m = text.match(/^metrics: (\{.*\})$/))) {
    // measured by the drill itself; only known numeric keys are accepted
    try {
      const j = JSON.parse(m[1]) as Record<string, unknown>;
      for (const k of ['backupBytes', 'publishMs', 'discoverMs', 'importMs', 'recoveryMs', 'totalMs', 'relaysOk', 'relaysFailed', 'feesSats', 'exportMs', 'encryptMs', 'verifyMs', 'redialMs', 'relaysHealthy', 'relaysAtRestore'] as const) {
        if (typeof j[k] === 'number' && Number.isFinite(j[k])) out.push(metric(k, j[k] as number));
      }
    } catch {
      // not our JSON: keep the plain line only
    }
  } else if ((m = text.match(/^backup identity .*: ([0-9a-f]{64})$/))) {
    out.push(metric('nostrKey', m[1]));
  } else if ((m = text.match(/^\s+block \d+: on-chain (\d+) sats/))) {
    out.push(metric('onchainNow', +m[1]));
  } else if ((m = text.match(/^recovered (\d+) of (\d+) channel sats/))) {
    out.push(metric('recovered', +m[1]), metric('channelSats', +m[2]));
  } else if (kind === 'pass' || kind === 'fail') {
    const ok = kind === 'pass';
    if (/same node identity/.test(text)) out.push(metric('identityMatch', ok));
    else if (/same Nostr backup key/.test(text)) out.push(metric('keyMatch', ok));
    else if (/channel funds recovered/.test(text)) out.push(metric('fundsPass', ok));
    else if (/backup verified before the disaster/.test(text)) out.push(metric('verifyPass', ok));
    else if (/restored backup has the channel-set fingerprint/.test(text)) out.push(metric('fingerprintMatch', ok));
  }
  return out;
}

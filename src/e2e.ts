// End-to-end check against real lnd nodes on regtest (needs Docker). Exit code 1 if any check fails.
// Covers: least-privilege macaroons that lnd itself confirms, live backup updates, relay divergence and outage,
// hostile relay events, and a full wipe + restore driven only by the restricted restore macaroon.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { restoreFromNostr } from './backup.js';
import { ensureMiner, mine } from './btc.js';
import { deriveNostrKey } from './keys.js';
import { Lnd, MONITOR_PERMS, RESTORE_PERMS, type Perm } from './lnd.js';
import { Logger } from './log.js';
import { Monitor } from './monitor.js';
import { D_TAG, KIND, publishBackup } from './nostr.js';
import { channelSetHash, encodePayload } from './payload.js';
import { activeChannels, adminMacaroon, compose, dataDir, freshCluster, fundAlice, initWallet, onchain, openChannel, ROOT, setupNodes, unlockWallet, wipeData } from './regtest.js';
import { startRelay } from './relay.js';
import { sleep, until } from './util.js';

const run = promisify(execFile);
let failed = 0;
const check = (ok: boolean, name: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const section = (s: string) => console.log(`\n== ${s}`);
const denied = (p: Promise<unknown>) => p.then(() => false, (e: Error) => /permission denied/.test(e.message));

const log = new Logger({ level: 'error' });
let relayA = startRelay(7777);
const relayB = startRelay(7778);
const relays = [relayA.url, relayB.url];
const pool = new SimplePool();

async function main() {
  section('regtest network with two channels');
  freshCluster();
  const { alice, bobId, minerAddr, mnemonic, aliceId } = await setupNodes();
  await fundAlice(alice, minerAddr, 3);
  await openChannel(alice, bobId, minerAddr, 1_000_000);
  await openChannel(alice, bobId, minerAddr, 500_000);

  section('least-privilege macaroons, confirmed by lnd itself');
  const bake = async (from: Lnd, name: string, perms: Perm[]) => {
    const p = join(dataDir('alice'), `${name}.macaroon`);
    writeFileSync(p, Buffer.from(await from.bakeMacaroon(perms), 'hex'), { mode: 0o600 });
    return new Lnd({ port: 8081, certPath: join(dataDir('alice'), 'tls.cert'), macaroonPath: p });
  };
  const mon = await bake(alice, 'monitor', MONITOR_PERMS);
  check((await alice.canSpendOnchain()) === true, 'admin macaroon is reported as able to spend');
  check((await mon.canSpendOnchain()) === false, 'monitor macaroon is reported as unable to spend');
  check(await denied(mon.call('POST', '/v1/transactions', { addr: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amount: '1000' })), 'monitor macaroon cannot send coins');
  check(await denied(mon.bakeMacaroon(MONITOR_PERMS)), 'monitor macaroon cannot bake more macaroons');
  check(await denied(mon.call('GET', '/v1/newaddress?type=0')), 'monitor macaroon cannot create addresses');

  section('monitor against the live node');
  const monitor = new Monitor({ lnd: mon, relays, log, macaroonPath: join(dataDir('alice'), 'monitor.macaroon'), infoEveryMs: 1000, verifyEveryMs: 1500, refreshMs: 3600_000, retryMs: [500, 500] });
  await monitor.start();
  await until(async () => {
    const s = monitor.snapshot();
    if (s.backup.lastPublish?.channels !== 2 || !s.verify?.ok) throw new Error('not yet');
  }, 'first backup published and verified', 60);
  let snap = monitor.snapshot();
  check(snap.backup.lastPublish?.relaysOk.length === 2, 'backup accepted by both relays');
  check(snap.verify?.ok === true && snap.verify.matchesCurrent === true, 'verification passes: decrypts with the seed-derived key and matches the node');
  check(snap.verify?.lndValidated === true && snap.verify.channelsInBackup === 2, 'lnd itself decrypts the relay copy (through the read-only monitor macaroon) and finds both channels inside it', JSON.stringify(snap.verify));
  check(snap.channels?.total === 2 && snap.node.network === 'regtest' && snap.node.connected, 'dashboard data is real: 2 channels, regtest, connected');
  check(snap.macaroon.canSpend === false, 'monitor reports its own macaroon as read-only');
  check(snap.security.worst === 'pass', 'security center is all green', JSON.stringify(snap.security.checks.filter((c) => c.status !== 'pass')));
  check(snap.backup.state === 'SUCCESS' && snap.backup.invalidTransitions === 0, `backup pipeline is SUCCESS with no invalid transitions (state ${snap.backup.state})`);
  check(snap.macaroon.fileLoose === false, 'the baked macaroon file is owner-only');
  const fp2 = snap.backup.lastPublish?.fingerprint;
  check(!!fp2 && fp2 === snap.verify?.fingerprint, 'the published fingerprint is what verification reads back from the relays');
  check(snap.channels?.pending === 0 && snap.node.network === 'regtest', 'pending channels and network are read from lnd');

  section('live update: a third channel is backed up without any action');
  await openChannel(alice, bobId, minerAddr, 250_000);
  await until(async () => {
    const s = monitor.snapshot();
    if (s.backup.lastPublish?.channels !== 3 || !s.verify?.ok || s.verify.channelsCurrent !== 3) throw new Error('not yet');
  }, 'backup with 3 channels verified', 60);
  check(true, 'backup updated to 3 channels and verified against the node');
  check(monitor.snapshot().backup.lastPublish?.fingerprint !== fp2, 'the channel-set fingerprint changed with the channel set');

  section('hostile and broken relay content');
  const sk = monitor.backup.secretKey();
  const foreign = finalizeEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000) + 5, tags: [['d', D_TAG]], content: 'x' }, generateSecretKey());
  await Promise.allSettled(pool.publish(relays, foreign));
  const v1 = await monitor.verifyNow();
  check(v1.ok, 'an event from another key on the relays does not affect verification');
  const garbage = finalizeEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', D_TAG]], content: 'corrupted' }, sk);
  await Promise.all(pool.publish([relayB.url], garbage)); // relay B now holds a corrupted copy of our own event
  const v2 = await monitor.verifyNow();
  const bRow = v2.relays.find((r) => r.url === relayB.url)!;
  check(v2.ok && v2.verdict === 'degraded' && bRow.reachable && !bRow.hasLatest && bRow.state === 'stale', 'a relay serving a corrupted copy is reported as stale (verdict DEGRADED), the good relay still verifies', JSON.stringify(v2.problems));
  await sleep(1200); // the healing publish must be dated after the corrupted event
  await monitor.backup.publishNow();
  const v3 = await monitor.verifyNow();
  check(v3.ok && v3.relays.every((r) => r.hasLatest), 'the next publish heals the relay', JSON.stringify({ ok: v3.ok, problems: v3.problems, relays: v3.relays.map((r) => [r.state, r.hasLatest, r.createdAt]) }));

  section('lnd rejects a relay copy it cannot decrypt');
  await sleep(1300); // events are dated in whole seconds: make the corrupted one strictly newer than the last real publish
  const real = (await mon.exportBackup()).multi_chan_backup!;
  const flipped = Buffer.from(real.multi_chan_backup, 'base64');
  flipped[flipped.length >> 1] ^= 1; // well-formed payload, one corrupted byte inside lnd's encrypted blob
  await publishBackup(pool, relays, sk, encodePayload({ v: 1, scb: flipped.toString('base64'), peers: [], cp: channelSetHash(real.chan_points) }), Math.floor(Date.now() / 1000));
  const v3b = await monitor.verifyNow();
  check(v3b.lndValidated === false && !v3b.ok && v3b.verdict === 'failed' && v3b.problems.some((p) => /lnd rejected the backup/.test(p)), 'a well-formed but corrupted backup is rejected by lnd itself', JSON.stringify(v3b.problems));
  await sleep(1300);
  await monitor.backup.publishNow();
  const v3c = await monitor.verifyNow();
  check(v3c.ok && v3c.lndValidated === true, 'the next publish restores a backup that lnd accepts', JSON.stringify(v3c.problems));

  section('relay outage');
  await relayA.close();
  const v4 = await monitor.verifyNow();
  check(v4.ok && v4.relays[0].state === 'down' && v4.relays[1].reachable, 'with one relay down, verification still passes through the other');
  check(monitor.snapshot().security.checks.find((c) => c.id === 'relays')?.status === 'degraded', 'security center flags reduced redundancy as DEGRADED');
  const p1 = await monitor.backup.publishNow();
  check(!!p1 && p1.relaysOk.length === 1 && p1.relaysFailed.length === 1, 'publishing succeeds on the surviving relay and reports the failed one');
  relayA = startRelay(7777); // comes back empty
  const p2 = await monitor.backup.publishNow();
  check(!!p2 && p2.relaysOk.length === 2, 'when the relay returns, the next publish reaches it again');
  const v5 = await monitor.verifyNow();
  check(v5.ok && v5.relays.every((r) => r.hasLatest), 'both relays hold the latest again');

  section('CLI against the real node');
  // async on purpose: the relays run inside this process, so a blocking exec would starve them and the child would time out
  const tsx = join(ROOT, 'node_modules/.bin/tsx');
  const cliEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LND_CERT: join(dataDir('alice'), 'tls.cert'), LND_PORT: '8081', RELAYS: relays.join(',') };
  const cli = async (args: string[], env: Record<string, string>) => {
    try {
      const r = await run(tsx, ['src/cli.ts', ...args], { cwd: ROOT, env, encoding: 'utf8' });
      return { code: 0, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
    } catch (e) {
      const x = e as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof x.code === 'number' ? x.code : 1, out: `${x.stdout ?? ''}${x.stderr ?? ''}`, stdout: x.stdout ?? '' };
    }
  };
  const baked = join(dataDir('alice'), 'cli-baked.macaroon');
  const bk = await cli(['bake', '--out', baked], { ...cliEnv, LND_MACAROON: adminMacaroon('alice') });
  check(bk.code === 0 && /lnd confirms: this macaroon cannot spend/.test(bk.out) && existsSync(baked), "cli bake writes the macaroon and reports lnd's own confirmation that it cannot spend", bk.out.slice(-200));
  check((await cli(['bake', '--out', baked], { ...cliEnv, LND_MACAROON: adminMacaroon('alice') })).code !== 0, 'cli bake refuses to overwrite an existing file');
  const vr = await cli(['verify'], { ...cliEnv, LND_MACAROON: baked });
  check(vr.code === 0 && /"verdict": "verified"/.test(vr.out), 'cli verify exits 0 with verdict verified', vr.out.slice(-200));
  check((() => { try { return JSON.parse(vr.stdout).verdict === 'verified'; } catch { return false; } })(), 'cli verify prints pure JSON on stdout (logs go to stderr), so a script can parse it', vr.stdout.slice(0, 120));
  const pk = await cli(['pubkey'], { ...cliEnv, LND_MACAROON: baked });
  check(pk.code === 0 && /^[0-9a-f]{64}\n$/.test(pk.stdout), 'cli pubkey prints exactly the 64-hex Nostr key on stdout', pk.stdout.slice(0, 120));
  check((await cli(['verify'], { ...cliEnv, LND_MACAROON: baked, RELAYS: 'https://nope.example' })).code === 2, 'cli verify rejects a bad RELAYS value up front (exit 2)');
  check((await cli(['verify'], { ...cliEnv, LND_MACAROON: join(dataDir('alice'), 'does-not-exist') })).code === 2, 'cli verify reports a missing macaroon file as a configuration error');
  const rt = await cli(['relay-test', relayA.url], { PATH: cliEnv.PATH, HOME: cliEnv.HOME });
  check(rt.code === 2 && /Re-run with --yes/.test(rt.out), 'cli relay-test refuses to publish anything without --yes', rt.out.slice(-200));
  const rt2 = await cli(['relay-test', relayA.url, '--yes'], { PATH: cliEnv.PATH, HOME: cliEnv.HOME });
  check(rt2.code === 0 && /"deletionHonored": true/.test(rt2.out), 'cli relay-test --yes publishes a dummy event, reads it back and deletes it', rt2.out.slice(-300));

  section('lnd outage and recovery');
  const pubsBefore = monitor.snapshot().backup.publishes;
  compose('stop', 'alice');
  await until(async () => {
    if (monitor.snapshot().node.connected) throw new Error('still connected');
  }, 'outage noticed', 30);
  const down = monitor.snapshot();
  check(!down.node.connected && down.security.checks.find((c) => c.id === 'lnd')?.status === 'fail', 'the dashboard shows lnd as unreachable and the lnd check FAILED');
  check(down.security.worst === 'fail', 'overall status is FAILED while lnd is down');
  compose('start', 'alice');
  await unlockWallet(alice);
  await until(async () => {
    const s = monitor.snapshot();
    if (!s.node.connected || !s.backup.streamConnected) throw new Error('not back yet');
  }, 'reconnect', 60);
  await mon.waitActive();
  const back = await monitor.verifyNow();
  check(back.ok && monitor.snapshot().node.connected, 'after lnd returns the monitor reconnects on its own and verification passes');
  check(monitor.snapshot().backup.streamConnected && monitor.snapshot().backup.invalidTransitions === 0, 'the backup stream resubscribed and the pipeline never left the state machine');
  void pubsBefore;

  section('disaster: wipe alice, restore with the restricted restore macaroon only');
  const chans = await activeChannels(alice);
  const inChannels = chans.reduce((s, c) => s + Number(c.local_balance), 0);
  const before = await onchain(alice);
  const nostrPub = monitor.backup.nostrPubkey();
  monitor.stop();
  compose('rm', '-sf', 'alice');
  rmSync(dataDir('alice'), { recursive: true, force: true });
  compose('up', '-d', 'alice');
  await initWallet(alice, mnemonic);
  check((await alice.getInfo()).identity_pubkey === aliceId, 'same node identity from the seed');
  check(getPublicKey(await deriveNostrKey(alice)) === nostrPub, 'same Nostr backup key re-derived from the seed');
  const restoreLnd = await bake(alice, 'restore', RESTORE_PERMS);
  check((await restoreLnd.canSpendOnchain()) === false, 'restore macaroon cannot spend either');
  const r = await restoreFromNostr(restoreLnd, relays, { pauseMs: 1500, reconnectRounds: 4 });
  check(r.fingerprint === monitor.snapshot().backup.lastPublish?.fingerprint && r.timings.totalMs > 0, 'restore reports the fingerprint of the backup it used and real timings');
  check(r.channelsAwaitingClose === 3, 'all 3 channels restored and waiting for their peers', `got ${r.channelsAwaitingClose}`);
  let recovered = 0;
  for (let i = 0; i < 90 && recovered <= inChannels * 0.95; i++) {
    await mine(1, await ensureMiner());
    await sleep(2000);
    recovered = (await onchain(alice)) - before;
  }
  check(recovered > inChannels * 0.95, `channel funds recovered on-chain (${recovered} of ${inChannels} sats)`);
}

try {
  await main();
} catch (e) {
  failed++;
  console.log(`FAIL  e2e aborted: ${(e as Error).message}`);
} finally {
  pool.close(relays);
  await Promise.allSettled([relayA.close(), relayB.close()]);
  try {
    compose('down', '-v');
  } catch {
    // best effort
  }
  wipeData();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall e2e checks passed');
process.exit(failed ? 1 : 0);

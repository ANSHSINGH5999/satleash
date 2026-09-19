// End-to-end disaster drill on regtest:
// open channels -> back up over Nostr -> wipe the node completely -> restore from the seed alone -> funds return.
// The lines it prints are parsed by src/drill-parse.ts for the web console: keep the formats stable.
import { rmSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools/pure';
import { BackupService, restoreFromNostr, verifyBackup, type PublishRecord } from './backup.js';
import { mine } from './btc.js';
import { checkPrerequisites } from './demo-env.js';
import { deriveNostrKey } from './keys.js';
import { Logger } from './log.js';
import { startRelay } from './relay.js';
import { activeChannels, compose, dataDir, freshCluster, fundAlice, initWallet, onchain, openChannel, setupNodes } from './regtest.js';
import { sleep, until } from './util.js';

const relayEnv = process.env.RELAYS?.split(',').map((s) => s.trim()).filter(Boolean);
const step = (s: string) => console.log(`\n== ${s}`);
const ok = (c: boolean, s: string) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${s}`);
  if (!c) process.exitCode = 1;
};

const prereq = await checkPrerequisites({ ports: relayEnv ? [] : [7777, 7778] });
for (const c of prereq.filter((x) => !x.ok)) console.error(`prerequisite failed: ${c.name}: ${c.detail}`);
if (prereq.some((c) => !c.ok)) process.exit(1);

const drillStart = Date.now();
step('fresh regtest cluster');
freshCluster();
// two local relays by default, so the drill can show what redundancy buys: one of them is switched off during the disaster
const localRelays = relayEnv ? [] : [startRelay(7777), startRelay(7778)];
const relays = relayEnv ?? localRelays.map((r) => r.url);
console.log('relays:', relays.join(', '));

const { alice, bobId, minerAddr, mnemonic, aliceId } = await setupNodes();

step('fund alice and open channel #1 to bob');
await fundAlice(alice, minerAddr, 3);
await openChannel(alice, bobId, minerAddr, 1_000_000);

step('start Nostr backup daemon, then open channel #2 (must be picked up automatically)');
const published: PublishRecord[] = [];
const svc = new BackupService({ lnd: alice, relays, log: new Logger({ level: 'warn' }), onPublish: (r) => published.push(r) });
await svc.start();
const nostrPub = svc.nostrPubkey()!;
console.log('backup identity (Nostr pubkey derived from seed):', nostrPub);
await openChannel(alice, bobId, minerAddr, 500_000);
await until(async () => {
  if (published.at(-1)?.channels !== 2) throw new Error('backup not updated');
}, 'backup with 2 channels published');
console.log('published:', published.map((p) => `${p.channels}ch->${p.relaysOk.length}relay`).join(', '));
const finalPublish = published.at(-1)!;
console.log(`backup fingerprint (channel set): ${finalPublish.fingerprint}`);
svc.stop();

// measured here, not remembered: how long lnd takes to export, and how long a restore dry run takes
const tExport = Date.now();
await alice.exportBackup();
const exportMs = Date.now() - tExport;
const tVerify = Date.now();
const verified = await verifyBackup({ lnd: alice, sk: await deriveNostrKey(alice), relays });
const verifyMs = Date.now() - tVerify;
console.log(`verify before the disaster: ${verified.verdict}, ${verified.relays.filter((r) => r.state === 'healthy').length} of ${relays.length} relay(s) healthy`);
ok(verified.verdict === 'verified' && verified.lndValidated === true, `backup verified before the disaster: lnd itself decrypted the relay copy and found ${verified.channelsInBackup} channel(s) in it`);

const chans = await activeChannels(alice);
const inChannels = chans.reduce((s, c) => s + Number(c.local_balance), 0);
const before = await onchain(alice);
console.log(`alice: ${before} sats on-chain + ${inChannels} sats in ${chans.length} channels`);

step('DISASTER: delete alice completely (all lnd state, channel.db, macaroons, tls)');
compose('rm', '-sf', 'alice');
rmSync(dataDir('alice'), { recursive: true, force: true });
compose('up', '-d', 'alice');
console.log('alice is gone; bob and the relays are all that remain. Only the 24-word seed survives.');
let relaysAtRestore = relays.length;
if (localRelays.length > 1) {
  await localRelays[0].close();
  relaysAtRestore--;
  console.log(`relay ${localRelays[0].url} is switched off too: the restore has to work with ${relaysAtRestore} of ${relays.length} relays`);
}

step('RESTORE: new lnd from the seed alone, then pull backup from Nostr');
const recoveryStart = Date.now();
await initWallet(alice, mnemonic);
ok((await alice.getInfo()).identity_pubkey === aliceId, 'same node identity from seed');
ok(getPublicKey(await deriveNostrKey(alice)) === nostrPub, 'same Nostr backup key re-derived from seed (no extra secret needed)');
const restored = await restoreFromNostr(alice, relays);
console.log(`restored backup published at ${new Date(restored.createdAt * 1000).toISOString()}`);
ok(restored.fingerprint === finalPublish.fingerprint, 'the restored backup has the channel-set fingerprint that was published');

step('peers force-close (data-loss protection); mine until funds return');
let recovered = 0;
for (let i = 0; i < 90; i++) {
  await mine(1, minerAddr);
  await sleep(2000);
  recovered = (await onchain(alice)) - before;
  if (i % 5 === 0) console.log(`  block ${i}: on-chain ${await onchain(alice)} sats`);
  if (recovered > inChannels * 0.95) break;
}
console.log(`recovered ${recovered} of ${inChannels} channel sats on-chain`);
console.log(
  `metrics: ${JSON.stringify({
    backupBytes: finalPublish.bytes,
    publishMs: finalPublish.durationMs,
    discoverMs: restored.timings.discoverMs,
    importMs: restored.timings.importMs,
    redialMs: restored.timings.redialMs,
    exportMs,
    encryptMs: finalPublish.encryptMs,
    verifyMs,
    relaysHealthy: verified.relays.filter((r) => r.state === 'healthy').length,
    relaysAtRestore,
    recoveryMs: Date.now() - recoveryStart,
    totalMs: Date.now() - drillStart,
    relaysOk: finalPublish.relaysOk.length,
    relaysFailed: finalPublish.relaysFailed.length,
    feesSats: inChannels - recovered,
  })}`,
);
ok(recovered > inChannels * 0.95, 'channel funds recovered (only fees lost)');

await Promise.all(localRelays.map((r) => r.close().catch(() => undefined)));
process.exit(process.exitCode ?? 0);

import { closeSync, openSync, writeSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools/pure';
import { BackupService, restoreFromNostr, verifyBackup } from './backup.js';
import { assertNetworkAllowed, isCleartextRemote, loadLndOpts, normalizeNetwork, parseRelays, validateConfig } from './config.js';
import { explain } from './errors.js';
import { deriveNostrKey } from './keys.js';
import { Lnd, MONITOR_PERMS, RESTORE_PERMS } from './lnd.js';
import { createLogger } from './log.js';
import { publicRelayTest } from './relay-test.js';

const USAGE = `usage: cli.ts <command>

  pubkey            print the Nostr key your backups are published under
  backup            run the backup daemon (publishes on every channel change)
  verify            fetch the backup from the relays and check it matches the node (exit 1 if not)
  restore           restore the newest backup from the relays into a node created from the same seed
  bake [--restore] --out <file>
                    write a least-privilege macaroon (read-only daemon by default, --restore adds restore rights).
                    Needs LND_MACAROON to be an admin macaroon. Neither variant can spend on-chain funds.
  relay-test <ws(s)-url> --yes
                    publish ONE encrypted dummy event signed by a throwaway key to a relay, read it back, ask the relay
                    to delete it. Uses no lnd, no real key and no real backup. --yes acknowledges that the relay is
                    third-party infrastructure.

env: LND_CERT, LND_MACAROON, RELAYS (backup|verify|restore), optional LND_HOST, LND_PORT (default 8080), LOG_LEVEL,
     LOG_FORMAT=json, LIFEBOAT_ALLOW_MAINNET=1 (mainnet is refused otherwise)`;

const log = createLogger(process.env, { stderr: true }); // stdout is reserved for what a command prints as its result

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const cmd = argv[0];
  if (!cmd || !['pubkey', 'backup', 'verify', 'restore', 'bake', 'relay-test'].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }

  if (cmd === 'relay-test') {
    if (!argv[1]) {
      console.error(USAGE);
      return 2;
    }
    const [url] = parseRelays(argv[1]);
    if (!argv.includes('--yes')) {
      console.error(`This will publish one encrypted DUMMY event, signed by a throwaway key, to ${url} and ask it to delete it afterwards.`);
      console.error('No real backup, key or node data is involved. Re-run with --yes to continue.');
      return 2;
    }
    const r = await publicRelayTest(url);
    console.log(JSON.stringify(r, null, 2));
    return r.published && r.retrieved && r.signatureValid && r.decrypted && r.payloadValid && r.fingerprintValid ? 0 : 1;
  }

  const cfg = validateConfig(env, { needRelays: ['backup', 'verify', 'restore'].includes(cmd) });
  for (const w of cfg.warnings) log.warn(w, { category: 'config' });
  if (cfg.errors.length) {
    console.error(`configuration is not usable:\n  - ${cfg.errors.join('\n  - ')}`);
    return 2;
  }
  const lndOpts = loadLndOpts(env);
  const lnd = new Lnd(lndOpts);
  const network = normalizeNetwork((await lnd.getInfo()).chains?.[0]?.network);
  assertNetworkAllowed(network, env);
  log.info('connected to lnd', { category: 'lnd', network: network.toUpperCase() });

  if (cmd === 'pubkey') {
    console.log(getPublicKey(await deriveNostrKey(lnd)));
    return 0;
  }

  if (cmd === 'bake') {
    const at = argv.indexOf('--out');
    const out = argv[at + 1];
    if (at < 0 || !out) throw new Error('bake needs --out <file>');
    const perms = argv.includes('--restore') ? RESTORE_PERMS : MONITOR_PERMS;
    const hex = await lnd.bakeMacaroon(perms);
    const fd = openSync(out, 'wx', 0o600); // refuses to overwrite an existing file
    try {
      writeSync(fd, Buffer.from(hex, 'hex'));
    } finally {
      closeSync(fd);
    }
    console.log(`wrote ${out} (mode 0600)`);
    console.log(`requested permissions: ${perms.map((p) => `${p.entity}:${p.action}`).join(' ')}`);
    // ask lnd, using the new macaroon, whether it can spend: the answer comes from lnd, not from what we asked for
    const spend = await new Lnd({ ...lndOpts, macaroonPath: out }).canSpendOnchain();
    console.log(spend === false ? 'lnd confirms: this macaroon cannot spend on-chain funds' : spend === true ? 'WARNING: lnd says this macaroon CAN spend on-chain funds' : 'could not ask lnd about this macaroon');
    return spend === true ? 1 : 0;
  }

  const relays = parseRelays(env.RELAYS);
  for (const r of relays.filter(isCleartextRemote)) log.warn('relay uses cleartext ws://: backup content stays encrypted but metadata is visible on the wire', { category: 'relay', relay: r });

  if (cmd === 'verify') {
    const res = await verifyBackup({ lnd, sk: await deriveNostrKey(lnd), relays });
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  if (cmd === 'restore') {
    const r = await restoreFromNostr(lnd, relays, { log });
    log.info('restore submitted', { category: 'restore', ...r, backupPublishedAt: new Date(r.createdAt * 1000).toISOString() });
    console.log(`restored the backup from ${new Date(r.createdAt * 1000).toISOString()}: ${r.channelsAwaitingClose} channel(s) now wait for their peers to force-close.`);
    console.log('Keep the node running and online. Funds arrive on-chain after the peers close and the closes confirm.');
    return 0;
  }

  // backup: run until interrupted
  const svc = new BackupService({ lnd, relays, log });
  await svc.start();
  const stop = () => {
    svc.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise<number>(() => {});
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    if (code !== 0 || process.argv[2] !== 'backup') process.exit(code);
  },
  (e: Error) => {
    const x = explain(e);
    console.error(`error: ${x.error}`);
    if (x.cause) console.error(`  cause:  ${x.cause}`);
    if (x.action) console.error(`  action: ${x.action}`);
    process.exit(1);
  },
);

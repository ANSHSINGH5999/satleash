// Regtest playground: a throwaway network with channels, two local relays, a least-privilege monitor macaroon,
// and the console pointed at it. `npm run playground`, open the printed URL, Ctrl-C to tear everything down.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mine } from './btc.js';
import { intFromEnv } from './config.js';
import { Lnd, MONITOR_PERMS } from './lnd.js';
import { createLogger } from './log.js';
import { Monitor } from './monitor.js';
import { checkPrerequisites, demoHealth } from './demo-env.js';
import { compose, dataDir, freshCluster, fundAlice, openChannel, ROOT, setupNodes, wipeData } from './regtest.js';
import { startRelay } from './relay.js';
import { createApp } from './web.js';

const log = createLogger();
const port = intFromEnv(process.env, 'PORT', 8080, 1, 65535);

const problems = (await checkPrerequisites({ ports: [port, 7777, 7778] })).filter((c) => !c.ok);
if (problems.length) {
  for (const c of problems) console.error(`prerequisite failed: ${c.name}: ${c.detail}`);
  process.exit(1);
}
log.info('building the regtest network (about 30 seconds; the first run also pulls the Docker images)');
freshCluster();
const relays = [startRelay(7777), startRelay(7778)];
const { alice, bobId, minerAddr } = await setupNodes();
await fundAlice(alice, minerAddr, 3);
await openChannel(alice, bobId, minerAddr, 1_000_000);
await openChannel(alice, bobId, minerAddr, 500_000);

// the console never sees the admin macaroon: it gets a read-only one that lnd itself confirms cannot spend
const macPath = join(dataDir('alice'), 'monitor.macaroon');
writeFileSync(macPath, Buffer.from(await alice.bakeMacaroon(MONITOR_PERMS), 'hex'), { mode: 0o600 });
const monitor = new Monitor({
  lnd: new Lnd({ port: 8081, certPath: join(dataDir('alice'), 'tls.cert'), macaroonPath: macPath }),
  relays: relays.map((r) => r.url),
  macaroonPath: macPath,
  log,
});
await monitor.start();

// lnd reports itself "not synced" once the chain tip is more than two hours old, and then refuses to open channels;
// keep the throwaway chain moving so a playground left running for hours stays usable
const chainTimer = setInterval(() => void mine(1, minerAddr).catch(() => undefined), 30_000);

const app = createApp({ root: ROOT, host: '127.0.0.1', drill: null, monitor, log });
const { server } = app;
server.listen(port, '127.0.0.1', () => {
  log.info('playground ready', { console: `http://127.0.0.1:${port}/console`, landing: `http://127.0.0.1:${port}/` });
  log.info('open another channel to watch the backup update live: npm run playground:open -- 250000');
  void announceReady();
});

// READY is printed only once the server, lnd, two healthy relays, the backup service and a verification have all answered
async function announceReady() {
  let last = '';
  for (let i = 0; i < 60; i++) {
    const h = await demoHealth(`http://127.0.0.1:${port}`);
    if (h.ready) return log.info(`READY: regtest demo environment is up at http://127.0.0.1:${port}/console (network REGTEST, disposable data)`);
    last = h.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
    await new Promise((r) => setTimeout(r, 2000));
  }
  log.warn(`NOT READY after 2 minutes: ${last}`);
}

const shutdown = async () => {
  log.info('tearing the playground down');
  clearInterval(chainTimer);
  monitor.stop();
  await app.close();
  await Promise.all(relays.map((r) => r.close()));
  try {
    compose('down', '-v');
  } catch {
    // best effort
  }
  wipeData();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

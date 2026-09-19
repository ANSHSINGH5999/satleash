// Entrypoint for `npm run web`: landing page, dashboard and APIs on loopback.
// With LND_CERT + LND_MACAROON + RELAYS set it also runs the real backup monitor against that node.
import { execFileSync } from 'node:child_process';
import { intFromEnv, loadLndOpts, parseRelays, validateConfig } from './config.js';
import { DrillRunner } from './drill.js';
import { Lnd } from './lnd.js';
import { createLogger } from './log.js';
import { Monitor } from './monitor.js';
import { ROOT, wipeData } from './regtest.js';
import { createApp } from './web.js';

const HOST = '127.0.0.1';
const log = createLogger();

async function main() {
  const port = intFromEnv(process.env, 'PORT', 8080, 1, 65535);

  let monitor: Monitor | null = null;
  if (process.env.LND_CERT || process.env.LND_MACAROON) {
    const cfg = validateConfig(process.env, { needRelays: true });
    for (const w of cfg.warnings) log.warn(w, { category: 'config' });
    if (cfg.errors.length) throw new Error(`configuration is not usable:\n  - ${cfg.errors.join('\n  - ')}`);
    const lndOpts = loadLndOpts(process.env);
    monitor = new Monitor({
      lnd: new Lnd(lndOpts),
      macaroonPath: lndOpts.macaroonPath,
      allowMainnet: process.env.LIFEBOAT_ALLOW_MAINNET === '1',
      expectNetwork: process.env.LIFEBOAT_NETWORK,
      relays: parseRelays(process.env.RELAYS),
      log,
      staleAfterSec: intFromEnv(process.env, 'STALE_AFTER_SEC', 8 * 3600, 60, 30 * 86400),
    });
    await monitor.start();
  }
  // The drill wipes and rebuilds the regtest network under <repo>/data; keep it off unless nothing else is using that network.
  const drill = monitor && process.env.LIFEBOAT_DRILL !== '1' ? null : new DrillRunner();

  const app = createApp({ root: ROOT, host: HOST, drill, monitor, log });
  const { server } = app;
  server.listen(port, HOST, () => log.info('Lifeboat console listening', { url: `http://${HOST}:${port}`, dashboard: `http://${HOST}:${port}/console`, monitor: !!monitor, drill: !!drill }));

  const shutdown = () => {
    monitor?.stop();
    drill?.shutdown();
    void app.close();
    if (drill?.busy()) {
      try {
        execFileSync('docker', ['compose', 'down', '-v'], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 });
      } catch {
        // best effort
      }
      wipeData();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: Error) => {
  log.error('could not start', { error: e.message });
  process.exit(1);
});

// Opens another channel alice -> bob on the running playground, so the console can be seen picking up the change.
import { ensureMiner, mine } from './btc.js';
import { node, openChannel } from './regtest.js';
import { until } from './util.js';

const sats = Number(process.argv[2] ?? 250_000);
if (!Number.isInteger(sats) || sats < 20_000 || sats > 5_000_000) {
  console.error('usage: playground-open.ts [sats between 20000 and 5000000]');
  process.exit(2);
}
const alice = node('alice', 8081);
const bob = node('bob', 8082);
const minerAddr = await ensureMiner();
await mine(1, minerAddr); // a stale chain tip makes lnd report "not synced"
await until(async () => {
  if (!(await alice.getInfo()).synced_to_chain) throw new Error('alice is not synced');
}, 'alice synced', 30);
await openChannel(alice, (await bob.getInfo()).identity_pubkey, minerAddr, sats);
console.log(`opened a ${sats} sat channel alice -> bob`);

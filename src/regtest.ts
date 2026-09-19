// Shared regtest plumbing for the disaster drill, the playground and the e2e script.
// Everything here is throwaway: regtest coins, a fixed wallet password, data under <repo>/data.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMiner, mine, rpc } from './btc.js';
import { waitForFile, wipeDataDir } from './demo-env.js';
import { Lnd, type ChannelInfo } from './lnd.js';
import { until } from './util.js';

/** Repo root, resolved from this file so nothing depends on the caller's working directory. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA = join(ROOT, 'data');
const PW = Buffer.from('password12345').toString('base64');

export const compose = (...a: string[]) => execFileSync('docker', ['compose', ...a], { cwd: ROOT, stdio: 'ignore' });
export const wipeData = () => wipeDataDir(ROOT);
export const dataDir = (name: string) => join(DATA, name);
export const adminMacaroon = (name: string) => join(dataDir(name), 'data/chain/bitcoin/regtest/admin.macaroon');

export const node = (name: string, port: number, macaroonPath = adminMacaroon(name)) =>
  new Lnd({ port, certPath: join(dataDir(name), 'tls.cert'), macaroonPath });

export async function initWallet(n: Lnd, mnemonic?: string[]): Promise<string[]> {
  const seed = mnemonic ?? (await until(() => n.call<{ cipher_seed_mnemonic: string[] }>('GET', '/v1/genseed'), 'genseed')).cipher_seed_mnemonic;
  await until(() => n.call('POST', '/v1/initwallet', { wallet_password: PW, cipher_seed_mnemonic: seed, recovery_window: 100 }), 'initwallet');
  await until(async () => {
    if (!(await n.getInfo()).synced_to_chain) throw new Error('not synced');
  }, 'lnd synced');
  return seed;
}

/** After a restart lnd is locked again; unlocking is what a real operator has to do too. */
export async function unlockWallet(n: Lnd) {
  await until(() => n.call('POST', '/v1/unlockwallet', { wallet_password: PW }), 'unlockwallet', 60);
  await until(async () => {
    if (!(await n.getInfo()).synced_to_chain) throw new Error('not synced');
  }, 'lnd synced after unlock', 60);
}

export const onchain = async (n: Lnd) => Number((await n.call('GET', '/v1/balance/blockchain')).confirmed_balance);
export const activeChannels = async (n: Lnd): Promise<ChannelInfo[]> => (await n.listChannels()).filter((c) => c.active);

/** Fresh bitcoind + alice + bob. Deletes <repo>/data and the compose volumes. */
export function freshCluster() {
  compose('down', '-v');
  wipeData();
  compose('up', '-d');
}

/** Waits for bitcoind, mines 101 blocks, creates alice and bob. */
export async function setupNodes() {
  // lnd writes its certificate into <repo>/data through a Docker bind mount; if that never shows up, Docker cannot see this folder
  if (!(await waitForFile(join(dataDir('alice'), 'tls.cert'), 45_000))) {
    throw new Error(
      `the lnd container started but wrote nothing into ${DATA}. Docker cannot bind-mount this folder: on Docker Desktop keep the repository inside a folder it shares (for example under your home directory) and run npm run demo:reset first.`,
    );
  }
  const alice = node('alice', 8081);
  const bob = node('bob', 8082);
  await until(() => rpc('getblockchaininfo'), 'bitcoind');
  const minerAddr = await ensureMiner();
  await mine(101, minerAddr);
  const mnemonic = await initWallet(alice);
  await initWallet(bob);
  return { alice, bob, minerAddr, mnemonic, aliceId: (await alice.getInfo()).identity_pubkey, bobId: (await bob.getInfo()).identity_pubkey };
}

export async function fundAlice(alice: Lnd, minerAddr: string, btc: number) {
  const addr = (await alice.call('GET', '/v1/newaddress?type=0')).address as string;
  await rpc('sendtoaddress', [addr, btc], 'miner');
  await mine(1, minerAddr);
  await until(async () => {
    if ((await onchain(alice)) < btc * 1e8) throw new Error('unfunded');
  }, 'alice funded');
}

/** Opens a channel alice -> bob and waits until it is active. */
export async function openChannel(alice: Lnd, bobId: string, minerAddr: string, sats: number) {
  const before = (await activeChannels(alice)).length;
  await alice.call('POST', '/v1/peers', { addr: { pubkey: bobId, host: 'bob:9735' }, perm: true }).catch((e: Error) => {
    if (!/already connected/i.test(e.message)) throw e;
  });
  await until(async () => {
    const peers = (await alice.call<{ peers?: { pub_key: string }[] }>('GET', '/v1/peers')).peers ?? [];
    if (!peers.some((p) => p.pub_key === bobId)) throw new Error('bob is not connected yet');
  }, 'alice connected to bob', 30);
  await alice.call('POST', '/v1/channels', { node_pubkey: Buffer.from(bobId, 'hex').toString('base64'), local_funding_amount: String(sats) });
  await mine(6, minerAddr);
  await until(async () => {
    if ((await activeChannels(alice)).length < before + 1) throw new Error('channel not active yet');
  }, `channel of ${sats} sats active`);
}

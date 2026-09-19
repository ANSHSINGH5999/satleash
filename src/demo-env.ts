// Demo environment helpers: prerequisites, a reset that can only ever touch <repo>/data, and a readiness check that
// says READY only when every required component has actually answered.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, sep } from 'node:path';
import type { MonitorSnapshot } from './monitor.js';

export type Check = { name: string; ok: boolean; detail: string };

/**
 * Deletes `<root>/data` and nothing else. A symbolic link at that path is unlinked, never followed, and a path that
 * resolves outside `root` or is not a directory is refused. Returns false if there was nothing to delete.
 */
export function wipeDataDir(root: string): boolean {
  const target = join(root, 'data');
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    unlinkSync(target);
    return true;
  }
  if (!st.isDirectory()) throw new Error(`${target} is not a directory; refusing to delete it`);
  if (!realpathSync(target).startsWith(realpathSync(root) + sep)) throw new Error(`${target} resolves outside the repository; refusing to delete it`);
  rmSync(target, { recursive: true, force: true });
  return true;
}

/** Polls until `path` exists. Used to notice that Docker cannot bind-mount the repository (the container then writes elsewhere). */
export async function waitForFile(path: string, timeoutMs: number, pollMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

export const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

/** Throws if the Docker daemon does not answer within 15 s (a hung `docker` never blocks the caller for longer). */
export const dockerReachable = () => void execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });

/** What the demo needs before it starts anything. Nothing is installed or pulled by this check. */
export async function checkPrerequisites(o: { ports: number[]; nodeVersion?: string; docker?: boolean; dockerInfo?: () => void }): Promise<Check[]> {
  const out: Check[] = [];
  const v = o.nodeVersion ?? process.versions.node;
  out.push({ name: 'Node.js 22 or newer', ok: Number(v.split('.')[0]) >= 22, detail: `found ${v}` });
  if (o.docker !== false) {
    try {
      (o.dockerInfo ?? dockerReachable)();
      out.push({ name: 'Docker daemon', ok: true, detail: 'reachable' });
    } catch {
      out.push({ name: 'Docker daemon', ok: false, detail: 'not reachable: start Docker Desktop or the docker service' });
    }
  }
  for (const p of o.ports) {
    const free = await portFree(p);
    out.push({ name: `Port ${p}`, ok: free, detail: free ? 'free' : 'in use (another Lifeboat run still going? try `npm run demo:reset`)' });
  }
  return out;
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; headers: { get(n: string): string | null } }>;

/** Asks the running server, and through it lnd, the relays, the backup service and the verifier. */
export async function demoHealth(base: string, fetchFn: Fetch = (u) => fetch(u, { signal: AbortSignal.timeout(5000) })): Promise<{ ready: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const get = async (path: string) => {
    try {
      return await fetchFn(base + path);
    } catch (e) {
      return { ok: false, status: 0, json: async () => ({}), headers: { get: () => null }, err: (e as Error).message } as Awaited<ReturnType<Fetch>> & { err?: string };
    }
  };

  const hz = await get('/healthz');
  add('Lifeboat server', hz.ok, hz.ok ? 'answers /healthz' : `no answer from ${base}/healthz`);
  const [page, cons] = await Promise.all([get('/'), get('/console')]);
  const html = (r: typeof page) => r.ok && (r.headers.get('content-type') ?? '').includes('text/html');
  add('Browser endpoint', html(page) && html(cons), html(page) && html(cons) ? 'landing page and console are served' : 'landing page or console is not being served');

  const mr = await get('/api/monitor');
  const s = mr.ok ? ((await mr.json()) as MonitorSnapshot) : null;
  if (!s) {
    for (const n of ['LND', 'Relays', 'Backup service', 'Verification service']) add(n, false, 'no monitor is attached to this server');
    return { ready: false, checks };
  }
  const lndOk = s.node.connected && s.node.synced === true && s.node.network === 'regtest';
  add('LND', lndOk, !s.node.connected ? `not connected${s.node.error ? `: ${s.node.error}` : ''}` : s.node.network !== 'regtest' ? `demo mode expects regtest, this node is ${s.node.network.toUpperCase()}` : s.node.synced ? `regtest, block ${s.node.blockHeight}` : 'connected but not synced yet');
  const healthy = s.verify?.relays.filter((r) => r.state === 'healthy').length ?? 0;
  add('Relays', healthy >= 2, `${healthy} of ${s.relays.filter((r) => r.enabled).length} enabled relays hold the newest backup (2 needed for the redundancy demo)`);
  const b = s.backup;
  add('Backup service', b.running && b.streamConnected && b.state === 'SUCCESS' && b.publishes >= 1, `${b.state}${b.streamConnected ? '' : ', lnd stream not connected'}, ${b.publishes} publish(es)`);
  add('Verification service', s.verify?.verdict === 'verified', s.verify ? `verdict ${s.verify.verdict.toUpperCase()}${s.verify.lndValidated ? ', lnd accepted the copy' : ''}` : 'first verification has not run yet');
  return { ready: checks.every((c) => c.ok), checks };
}

/** The `demo:reset` logic with its side effects injected, so tests can run it against a temporary root. */
export function resetDemo(o: { root: string; dockerUp: () => void; composeDown: () => void; log: (line: string) => void }): void {
  let docker = true;
  try {
    o.dockerUp(); // bounded: a hung or missing docker must not hang the reset
  } catch {
    docker = false;
  }
  if (!docker) o.log('Docker is not reachable; containers were not touched (start Docker and run this again if any are left)');
  else {
    try {
      o.composeDown();
      o.log('regtest containers and volumes removed');
    } catch {
      o.log('docker compose down failed; containers may be left (check `docker ps`)');
    }
  }
  o.log(wipeDataDir(o.root) ? `deleted ${join(o.root, 'data')}` : `nothing to delete: ${join(o.root, 'data')} does not exist`);
}

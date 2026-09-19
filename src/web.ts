// HTTP surface for the landing page, the dashboard and their APIs. Bound to loopback by the caller.
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { getPublicKey } from 'nostr-tools/pure';
import { isLoopbackUrl, parseRelays } from './config.js';
import type { DrillRunner } from './drill.js';
import { explain } from './errors.js';
import type { Logger } from './log.js';
import type { Monitor } from './monitor.js';
import { probeRelay } from './nostr.js';
import { publicRelayTest } from './relay-test.js';
import { Broadcaster } from './sse.js';

export type AppOpts = {
  root: string;
  host: string;
  drill: DrillRunner | null;
  monitor: Monitor | null;
  log: Logger;
  dockerOk?: () => Promise<boolean>;
  maxSseClients?: number;
  /** Override for tests. */
  relayTest?: typeof publicRelayTest;
};

let dockerCache = { at: 0, ok: false };
/** `docker info` spawns a process; cache the answer so polling clients cannot turn this endpoint into a process spawner. */
const defaultDockerOk = () =>
  new Promise<boolean>((resolve) => {
    if (Date.now() - dockerCache.at < 5000) return resolve(dockerCache.ok);
    execFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 }, (err) => {
      dockerCache = { at: Date.now(), ok: !err };
      resolve(!err);
    });
  });

/** Inline scripts and styles carry a per-response nonce; nothing else may run. No third-party media is allowed. */
export const csp = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "style-src-attr 'unsafe-inline'",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

export const withNonce = (html: string, nonce: string) => html.replace(/<script>/g, `<script nonce="${nonce}">`).replace(/<style>/g, `<style nonce="${nonce}">`);

const sameToken = (a: string | undefined, b: string) => {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Reads a small JSON object body; anything else is a clean 4xx, never an exception. */
function readJson(req: IncomingMessage, max = 16 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reject(new HttpError(415, 'send Content-Type: application/json'));
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (over) return; // keep draining (bounded by the server's request timeout) so the client can read the 413
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, `request body is larger than ${max} bytes`));
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'the request body is not a valid JSON object'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'the request body could not be read')));
  });
}

const str = (v: unknown, what: string, max = 300): string => {
  if (typeof v !== 'string' || !v || v.length > max) throw new HttpError(400, `${what} must be a non-empty string of at most ${max} characters`);
  return v;
};

export function createApp(o: AppOpts): { server: Server; token: string; close: () => Promise<void>; blockedRequests: () => number } {
  // Starting a run wipes and recreates the regtest network; monitor actions publish to relays. Everything that changes state
  // needs this secret, which a page on another origin cannot read.
  const token = randomBytes(16).toString('hex');
  const dockerOk = o.dockerOk ?? defaultDockerOk;
  const sse = new Broadcaster<import('./drill-parse.js').DrillEvent>({ max: o.maxSseClients ?? 20 });
  const runRelayTest = o.relayTest ?? publicRelayTest;
  let blocked = 0;
  let relayTestBusy = false;

  o.drill?.subscribe((e) => sse.broadcast(e));

  const headers = (type: string, rid: string, extra: Record<string, string> = {}) => ({
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
    'x-request-id': rid,
    ...extra,
  });
  const authed = (req: IncomingMessage) => sameToken(req.headers['x-lifeboat-token'] as string | undefined, token);

  const server = createServer(async (req, res) => {
    const rid = randomUUID().slice(0, 8);
    const send = (status: number, body: string, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, headers(type, rid));
      res.end(body);
    };
    const json = (status: number, v: unknown) => send(status, JSON.stringify(v), 'application/json');
    const fail = (status: number, e: unknown, extra: Record<string, unknown> = {}) => json(status, { ...explain(e), ...extra, requestId: rid });
    const page = (file: string) => {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, headers('text/html; charset=utf-8', rid, { 'content-security-policy': csp(nonce) }));
      res.end(withNonce(readFileSync(join(o.root, 'web', file), 'utf8'), nonce));
    };

    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    // Host check blocks DNS rebinding; Origin check blocks other sites from posting to us.
    const port = req.socket.localPort;
    const hostOk = host === `${o.host}:${port}` || host === `localhost:${port}`;
    if (!hostOk || (origin && origin !== `http://${host}`)) {
      blocked++;
      o.log.warn('blocked request', { category: 'console', requestId: rid, reason: !hostOk ? 'host' : 'origin', method: req.method, host, origin });
      return send(403, 'forbidden');
    }
    const path = new URL(req.url ?? '/', `http://${host}`).pathname;

    try {
      if (req.method === 'GET') {
        if (path === '/' || path === '/index.html') return page('index.html');
        if (path === '/console' || path === '/console.html') return page('console.html');
        if (path === '/healthz') return json(200, { ok: true, monitor: o.monitor ? o.monitor.snapshot().security.worst : null });
        if (path === '/api/config') return json(200, { token, drill: !!o.drill, monitor: !!o.monitor });
        if (path === '/api/status') return json(200, { busy: o.drill?.busy() ?? false, dockerOk: o.drill ? await dockerOk() : false, drill: !!o.drill });
        if (path === '/api/monitor') {
          if (!o.monitor) return json(404, { error: 'monitor not configured: set LND_CERT, LND_MACAROON and RELAYS', requestId: rid });
          const snap = o.monitor.snapshot();
          // the console's own guards are part of the security picture; report what they actually did
          const consoleCheck = { id: 'console', status: 'pass', title: 'Console guards active', detail: `Loopback only; Host, Origin and token checks and a nonce CSP are enforced. ${blocked} request(s) refused since start.` };
          return json(200, { ...snap, security: { ...snap.security, checks: [...snap.security.checks, consoleCheck] }, console: { blockedRequests: blocked } });
        }
        if (path === '/api/stream') {
          if (!o.drill) return send(404, 'drill disabled');
          if (sse.full) {
            o.log.warn('stream refused: too many clients', { category: 'console', requestId: rid });
            return send(503, 'too many stream clients');
          }
          res.writeHead(200, headers('text/event-stream', rid, { connection: 'keep-alive' }));
          sse.add(res, o.drill.events());
          return;
        }
      }

      if (req.method === 'POST') {
        if (!authed(req)) {
          blocked++;
          o.log.warn('rejected POST without a valid token', { category: 'console', requestId: rid, path });
          return send(403, 'bad token');
        }
        if (path === '/api/run') {
          if (!o.drill) return send(409, 'The drill is disabled while the playground owns this regtest network.');
          if (!o.drill.tryClaim()) return send(409, 'A drill is already running.');
          if (!(await dockerOk())) {
            o.drill.release();
            return send(503, "Docker isn't running. Start Docker Desktop and try again.");
          }
          o.log.info('drill started from the web console', { category: 'drill', requestId: rid });
          o.drill.run().catch((e: Error) => o.log.error('drill runner failed', { category: 'drill', requestId: rid, error: e.message }));
          return json(202, { started: true });
        }

        if (path === '/api/monitor/verify' || path === '/api/monitor/publish') {
          if (!o.monitor) return json(404, { error: 'monitor not configured', requestId: rid });
          try {
            return json(200, path.endsWith('verify') ? await o.monitor.verifyNow() : await o.monitor.backup.publishNow());
          } catch (e) {
            o.log.warn('monitor action failed', { category: 'console', requestId: rid, path, error: (e as Error).message });
            return fail(502, e);
          }
        }

        if (path === '/api/relays') {
          if (!o.monitor) return json(404, { error: 'monitor not configured', requestId: rid });
          const b = await readJson(req);
          const action = str(b.action, 'action', 20);
          const url = str(b.url, 'url', 300);
          const set = o.monitor.relays;
          try {
            if (action === 'add') {
              const [norm] = parseRelays(url);
              if (!isLoopbackUrl(norm) && b.confirm !== true) {
                return json(400, { error: 'confirmation required', needsConfirm: true, warning: `${norm} is public infrastructure. Your encrypted backup and its metadata (who publishes, when, how large) will be sent to it. Continue only if you trust it not to be your only copy.`, requestId: rid });
              }
              set.add(url);
              o.log.info('relay added', { category: 'relay', requestId: rid, relay: norm });
            } else if (action === 'remove') {
              set.remove(url);
              o.log.info('relay removed', { category: 'relay', requestId: rid, relay: url });
            } else if (action === 'enable' || action === 'disable') {
              set.setEnabled(url, action === 'enable');
              o.log.info(`relay ${action}d`, { category: 'relay', requestId: rid, relay: url });
            } else if (action === 'test') {
              const [norm] = parseRelays(url);
              const p = await probeRelay(norm, getPublicKey(o.monitor.backup.secretKey()), 5000);
              return json(200, { url: norm, reachable: p.reachable, latencyMs: p.latencyMs, error: p.error, holdsBackup: p.events.length > 0 });
            } else {
              throw new HttpError(400, 'action must be one of add, remove, enable, disable, test');
            }
            return json(200, { relays: set.all() });
          } catch (e) {
            if (e instanceof HttpError) throw e;
            return fail(400, e);
          }
        }

        if (path === '/api/relays/test-public') {
          const b = await readJson(req);
          const url = str(b.url, 'url', 300);
          if (b.confirm !== true) {
            return json(400, { error: 'confirmation required', needsConfirm: true, warning: 'This publishes one encrypted DUMMY event, signed by a throwaway key, to the relay and asks it to delete it afterwards. No real backup or key is used.', requestId: rid });
          }
          let norm: string;
          try {
            [norm] = parseRelays(url);
          } catch (e) {
            return fail(400, e);
          }
          if (relayTestBusy) return send(409, 'A public relay test is already running.');
          relayTestBusy = true;
          try {
            o.log.info('public relay test started', { category: 'relay', requestId: rid, relay: norm });
            return json(200, await runRelayTest(norm));
          } finally {
            relayTestBusy = false;
          }
        }
      }
      send(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, ...e.extra, requestId: rid });
      o.log.error('request failed', { category: 'console', requestId: rid, path, error: (e as Error).message });
      if (!res.headersSent) json(500, { error: 'internal error', requestId: rid });
    }
  });
  server.requestTimeout = 30_000;
  return {
    server,
    token,
    blockedRequests: () => blocked,
    close: () =>
      new Promise<void>((resolve) => {
        sse.closeAll();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

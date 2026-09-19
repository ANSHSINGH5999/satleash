# HTTP API (loopback only)

Every request must carry `Host: 127.0.0.1:<port>` or `localhost:<port>`, and any `Origin` header must equal `http://<Host>`; otherwise `403`. All responses send `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | none | Landing page (nonce CSP) |
| GET | `/console` | none | Dashboard (nonce CSP) |
| GET | `/healthz` | none | `{ ok: true, monitor: "pass" \| "warn" \| "degraded" \| "fail" \| "unknown" \| null }` (`ok` means the server answers; `monitor` is the security verdict) |
| GET | `/api/config` | none | `{ token, drill, monitor }`; the token is per server run |
| GET | `/api/status` | none | `{ busy, dockerOk, drill }` (docker answer cached 5 s) |
| GET | `/api/monitor` | none | `MonitorSnapshot`, or 404 when no node is attached |
| GET | `/api/stream` | none | Server-sent events of the drill (replays the last run); 404 if the drill is disabled, 503 over 20 clients |
| POST | `/api/run` | token | Start the regtest drill. 202; 409 if one is running or the drill is disabled; 503 if Docker is down |
| POST | `/api/monitor/verify` | token | Run a verification now. 200 `VerifyResult`, 502 `{ error }` |
| POST | `/api/monitor/publish` | token | Publish the current backup now. 200 `PublishRecord`, 502 `{ error }` |
| POST | `/api/relays` | token | Body `{ action, url }`, action one of `add`, `remove`, `enable`, `disable`, `test`. Returns `{ relays }`, or for `test` `{ url, reachable, latencyMs, error, holdsBackup }`. Adding a non-loopback relay needs `confirm: true`, otherwise 400 `{ needsConfirm, warning }`. The last enabled relay cannot be removed or disabled. Session-only: not persisted |
| POST | `/api/relays/test-public` | token | Body `{ url, confirm: true }`. Runs the public relay test (see `public-relay-testing.md`). One at a time; 400 without confirmation or with a bad URL |

The token goes in the `x-lifeboat-token` header and is compared in constant time.

POST bodies must be `application/json` (415 otherwise), a JSON object (400), and at most 16 KB (413, the body is drained so the client gets the answer). Every response carries `x-request-id`; error bodies include the same `requestId` and, where a cause is known, an explanation of cause, impact and action.

## Drill events (SSE `data:` lines)

`start {at}`, `line {text, kind}`, `stage {index}` (0-5), `metric {key, value}`, `end {ok, at}`, `idle`. `end` and `idle` always arrive, even if the drill crashes; `idle` means the network was cleaned up and a new run may start.

## MonitorSnapshot

`node` (connected, pubkey, alias, network, version, blockHeight, synced), `channels` (total, active, pending, localSats, remoteSats), `relays` (per-relay state, latency, newest event), `nostr.pubkey`, `backup` (status, history of the last 20 publishes, last error), `verify` (last `VerifyResult` with per-relay health), `macaroon` (`canSpend`, `fileLoose`, `file`, `needs`), `security` (`checks[]`, `worst`), `config`, `logs` (last 60 redacted entries).

# Test matrix

Run on 2026-09-19 (macOS, Node 26.7, Docker, headless Chrome, LND 0.20.0-beta, bitcoind 30 regtest). "Actual" is what was observed. Every PASS names its evidence: an automated test (file in `src/`), an e2e check against real LND (`npm run e2e`, 44 checks), or a manual run recorded in `FINAL_PROJECT_STATUS.md`.

Suite: **159 tests in 22 files, 159 pass** (`npm run check`); **44 of 44 e2e checks**; `npm audit` 0 vulnerabilities.

## Disaster scenarios

| # | Area | Scenario | Expected | Actual | Status | Evidence |
|---|---|---|---|---|---|---|
| 1 | Failure | LND unavailable | Console shows disconnected and FAILED, backups pause, recovery is automatic; CLI says why and exits 1 | As expected; CLI prints cause and action | PASS | `monitor.test.ts` (loses and regains lnd), e2e (lnd down), `cli.test.ts` |
| 2 | Failure | LND slow | A slow but timely answer succeeds | Succeeded | PASS | `lnd.test.ts` |
| 3 | Failure | LND timeout | Times out with a clear error, never hangs | Times out; also a response cut mid-body errors instead of hanging | PASS | `lnd.test.ts` |
| 4 | Failure | One relay unavailable | Publish succeeds on the rest, verification degraded, restore still works | As expected; drill restored with 1 of 2 relays switched off | PASS | e2e (relay outage), drill run |
| 5 | Failure | Several relays unavailable | Backup still found through the survivor; verdict degraded, not verified | As expected | PASS | `hostile.test.ts` |
| 6 | Failure | All relays unavailable | Lookup returns nothing promptly, verification failed with "no relay is reachable", pipeline FAILED then RECOVERING with backoff | As expected, under 8 s | PASS | `hostile.test.ts`, `backup.test.ts` |
| 7 | Failure | Relay reconnect | The next publish reaches it; a relay that comes back is used | As expected | PASS | e2e, `hostile.test.ts` |
| 8 | Nostr | Malformed relay event / junk frames | Ignored; client neither throws nor stalls | Found and fixed two crashes (probe on `null` frames, `isOwnValid` on malformed events) | PASS | `hostile.test.ts` |
| 9 | Nostr | Invalid signature | Dropped | Dropped | PASS | `nostr.test.ts`, `hostile.test.ts` |
| 10 | Nostr | Foreign event (other key, wrong kind, wrong `d`) | Dropped and counted | Dropped and counted | PASS | `nostr.test.ts`, `hostile.test.ts`, e2e |
| 11 | Nostr | Stale backup | Newer wins; stale relay reported | As expected | PASS | `nostr.test.ts`, `verify.test.ts` |
| 12 | Nostr | Future-dated event | Never shadows a current backup; flagged if the only choice | As expected | PASS | `nostr.test.ts`, `verify.test.ts`, `backup.test.ts` |
| 13 | Nostr | Duplicate backup | Collapsed by id | As expected | PASS | `nostr.test.ts`, `hostile.test.ts` |
| 14 | Recovery | Corrupted backup | Undecryptable, unusable-payload or lnd-rejected copies never win; an older good copy is used and the problem is reported | Found and fixed: an unusable newer payload used to hide an older good backup | PASS | `hostile.test.ts`, `verify.test.ts`, e2e (real LND rejects a corrupted blob) |
| 15 | Recovery | Missing backup | Restore says none was found; verify reports it | As expected | PASS | `nostr.test.ts`, `verify.test.ts` |
| 16 | HTTP | Simultaneous recovery requests | Exactly one runs; concurrent verifications share one run | As expected | PASS | `web.test.ts`, `monitor.test.ts` |
| 17 | HTTP | Browser disconnect | Server frees the client slot; no leaked connections | 300 opened and aborted: 0 established connections after | PASS | `sse.test.ts`, manual load run |
| 18 | HTTP | SSE reconnect | A reconnecting client gets the replay then live events | As expected | PASS | `sse.test.ts`, `web.test.ts` |
| 19 | Browser | Server restart | Banner "lost server", last state kept, cleared on return | As expected | PASS | `ui.test.ts` |
| 20 | Unit | Configuration error | One message naming every problem, exit 2, nothing published | As expected | PASS | `config.test.ts`, `cli.test.ts` |

## By area

| Area | Scenario | Expected | Actual | Status | Evidence |
|---|---|---|---|---|---|
| Unit | Payload validation, key derivation, logger redaction, config, errors, relay set, demo reset and health | Strict validation, secrets redacted, reset only ever touches `<repo>/data` | 33 tests pass (6 + 2 + 3 + 9 + 2 + 4 + 7) | PASS | `payload`, `keys`, `log`, `config`, `errors`, `relays` tests |
| Integration | Backup pipeline state machine, retry with jitter, stream resubscribe, self-healing, expected-network refusal, retryable start | Only documented transitions; no duplicate timers or subscriptions | Pass; found and fixed a double-`start()` duplication | PASS | `backup.test.ts`, `monitor.test.ts` |
| HTTP | Host/Origin, token, nonce CSP, body limits, single-flight, relay API, request ids | Refuse or explain, never crash | Pass | PASS | `web.test.ts`, `sse.test.ts` |
| Browser (Chrome) | Console tabs and keyboard, hostile strings as text, live updates, relay management, public relay test flow, error explanations, landing drill, contrast AA, landmarks and labels | Works; nothing executes | 13 tests pass | PASS | `ui.test.ts` |
| LND (real) | Least-privilege macaroons, live channel update, monitor, lnd validates the relay copy, corrupted blob rejected, CLI, wipe and restore with the restricted macaroon | As specified | 44 of 44 | PASS | `npm run e2e` |
| Nostr | Hostile relay, selection rules, publish results, probe | Local validation decides truth | Pass | PASS | `nostr.test.ts`, `hostile.test.ts` |
| Security | Controls in `security.md` | Each tied to a test | See that file | PASS | `security.md` |
| Recovery (real) | Two-channel drill, verify, wipe, restore with one relay off, funds back | Funds return less fees | 1,492,866 of 1,493,060 sats, 194 sats fees, 36.9 to 40.9 s across ten runs | PASS | drill runs, e2e |
| Performance | Landing load, API latency, frame rate, memory under load | No regressions, no leaks | Load 21 to 28 ms, API p50 0.6 to 0.8 ms and p95 4.4 to 5.2 ms, 61 fps, RSS 64 MB, then 80 MB after 5000 requests and 300 SSE connections, then 62 MB idle; 0 connections left, 0 duplicate publishes | PASS | manual measurements |
| Public relay | Throwaway-key dummy test on 4 public relays; read-only adversarial query | See `public-relay-testing.md` | 3 relays full pass in run 2; damus intermittent; nostr.band untested since one timeout; 414 real unrelated events rejected | PARTIAL | `public-relay-testing.md` |
| Testnet | Guardrails only | Labels, `LIFEBOAT_NETWORK`, mainnet refusal | Unit-tested with stubs; no testnet node run | NOT TESTED | `testnet-checklist.md` |
| Browsers | Firefox, Safari | n/a | Firefox not installed; Safari automation session could not be created (timed out) | NOT TESTED | see `FINAL_PROJECT_STATUS.md` |

## Demo environment

| Area | Scenario | Expected | Actual | Status | Evidence |
|---|---|---|---|---|---|
| Demo | Reset from `/`, a directory containing a decoy `data/`, and `$HOME` | Deletes `<repo>/data` only; decoy untouched; containers removed | As expected | PASS | manual run, `demo-env.test.ts` |
| Demo | Symlinked or non-directory `data` | Link removed without following it; a file is refused | As expected | PASS | `demo-env.test.ts` |
| Demo | `demo:check` with nothing running | NOT READY, each component named | As expected | PASS | manual run, `demo-env.test.ts` |
| Demo | `demo:check` against the live playground | READY only after server, LND, 2 healthy relays, backup service and a verification answered | READY after about 21 s | PASS | manual run |
| Demo | Fresh clone, `npm ci`, `npm run check`, `npm run demo`, `npm run demo:reset` | Works with no undocumented setup | Passed (155 tests at the time; drill recovered 1,492,866 of 1,493,060 sats). One gap found and fixed: a repository outside Docker's shared folders failed with "timeout waiting for genseed"; it now says Docker cannot bind-mount the folder | PASS | manual run |
| Demo | Landing drill driven through the UI in headless Chrome | Six stages, five checks pass, metrics shown | 38.2 s, all passed, no console errors | PASS | manual run, screenshots 05, 08, 10 |
| Demo | Docker unavailable: daemon down, `docker` not installed, `docker info` hangs | Clear one-line message, prompt exit, no stack trace, no hang | `demo` and `playground` stop in 0 to 15 s with the same message; the drill button answers 503 "Docker isn't running"; `demo:reset` says containers were not touched. Found and fixed: `demo:reset` waited 61 s on a hung `docker`; it is now bounded to 15 s | PASS | manual runs with a stub `docker`, `cli.test.ts`, `demo-env.test.ts`, `web.test.ts` |
| Demo | Reset with a link nested inside `data`, and with the repository path itself a link | Links removed, never followed; works | As expected | PASS | `demo-env.test.ts` |
| Demo | Release-freeze drill through the UI, fresh browser profile with extensions disabled | Six stages, five checks, metrics, no console errors or warnings | 37.6 s total, 24.0 s wipe to recovery, 1,492,866 of 1,493,060 sats, 194 sats fees, relays 2/0 accepted, 1 of 2 reachable at restore, verification verified; 0 console errors | PASS | manual run (`submission/test-results.md`) |

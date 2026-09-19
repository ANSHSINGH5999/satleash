# Feature matrix

Status legend: **verified** = exercised here by an automated test or a run this session; **implemented** = built and unit-tested but not exercised against real infrastructure; **not done**.

| Capability | Status | Evidence |
|---|---|---|
| Publish LND SCB as encrypted Nostr event on change | verified | e2e (live channel update), `backup.test.ts` |
| Seed-derived backup key, same after wipe | verified | e2e, `keys.test.ts` |
| Restore from seed alone with restricted macaroon | verified (regtest) | e2e, drill: 1,492,866 / 1,493,060 sats |
| Verify (restore dry run), verdicts verified / degraded / failed | verified | `verify.test.ts`, e2e |
| Per-relay health: healthy / stale / missing / down | verified | `verify.test.ts` |
| Hostile / foreign / future-dated relay events | verified | `nostr.test.ts`, e2e |
| Jittered retry backoff, explicit backup state machine | verified | `backup.test.ts` |
| Self-healing republish when relays are behind the node | verified | `monitor.test.ts` |
| Least-privilege macaroons (`bake`), confirmed by LND | verified | e2e |
| Mainnet refused unless `LIFEBOAT_ALLOW_MAINNET=1` | verified | `config.test.ts` |
| Console: 8 tabs, live data, relay management | verified in headless Chrome | `ui.test.ts`, screenshots |
| Loopback-only server, token, Host/Origin, nonce CSP | verified | `web.test.ts` |
| Public relay test (throwaway key, dummy payload shaped like a backup, NIP-09 cleanup) | verified one-shot on 4 public relays; 2 passed both runs, 1 intermittent, 1 timed out once | `public-relay-testing.md` |
| Strict input validation, request ids, explained errors | verified | `web.test.ts`, `errors.test.ts` |
| lnd itself decrypts the relay copy (`VerifyChanBackup`) during verification | verified (real LND, read-only macaroon) | `verify.test.ts`, e2e |
| Hostile-relay handling (junk frames, malformed and huge events, unusable payloads, disconnects) | verified | `hostile.test.ts` |
| Recovery drill with two relays, one switched off, per-step timings | verified (10 runs) | `submission/test-results.md` |
| `demo:check` (READY only when every component answered), `demo:reset` (`<repo>/data` only), prerequisite checks | verified (unit tests, manual runs, clean clone) | `demo-env.test.ts` |
| Expected-network guard `LIFEBOAT_NETWORK`, `testnet4` recognised | unit-tested against a stub only | `config.test.ts`, `monitor.test.ts` |
| Testnet / signet run | not done | `testnet-checklist.md` |
| Mainnet | not done, refused by default | |
| Chunked backups (> ~200 channels) | not done | |
| Public relay retention over time | not done | |
| Tor / proxy support | not done | |
| Core Lightning / LDK support | not done | |
| Browsers other than Chrome | not verified | |

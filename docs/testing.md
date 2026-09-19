# Testing

| Layer | Command | What it covers |
|---|---|---|
| Types | `npm run typecheck` | strict TypeScript with unused-symbol checks |
| Unit and integration (no Docker) | `npm test` | logger, config, payload, key derivation, Nostr transport against a local relay including hostile relays, backup service (retry, resubscribe, refresh, dedupe, timestamps), verification, security assessment, drill runner, HTTP API and its guards, LND client against a real HTTPS server (pinning, timeouts, streams) |
| Browser | included in `npm test` | Headless Chrome over the DevTools protocol: dashboard XSS regression, empty state, landing live-drill JS, static hosting. Skipped if no Chrome/Chromium (set `CHROME_PATH`) |
| Regtest e2e | `npm run e2e` | Real LND nodes, 44 checks: least-privilege macaroons confirmed by LND, monitor against a live node, live channel update, corrupted and foreign relay events, relay outage and recovery, wipe and restore with the restricted restore macaroon, the CLI `relay-test` command, relay management |
| Drill | `npm run demo` | The disaster drill the landing page runs |

`npm test` uses `--test-force-exit --test-timeout=30000` so a failing test cannot hang the run. The LND client tests need `openssl` to make throwaway certificates.

## Counts (2026-09-19)

`npm run check`: typecheck clean, **159 tests, 159 pass**, 0 skipped (22 test files). `npm run e2e`: 44 of 44 checks, run on real LND 0.20.0-beta / bitcoind 30 regtest. `npm audit`: 0 vulnerabilities. At the start of the previous hardening pass the suite had 67 tests and the e2e 24 checks.

Fake LND and fake publishers (`testutil.ts`) mimic the real behaviours that broke earlier code (LND re-encrypts the backup on every export). Bugs found only on real LND are listed in `FINAL_PROJECT_STATUS.md`. Browser tests drive headless Chrome over the DevTools protocol; only Chrome has been verified.

The tests bind fixed loopback ports in the 7700 to 7900 range (test relays and servers), so they should not run while another process holds those ports; they never use Docker. `npm run demo:reset` and the tests' reset checks only ever touch a temporary directory or `<repo>/data`.

## Not covered

Public relay retention over days (only the one-shot relay test was run, see `public-relay-testing.md`), testnet/mainnet, browsers other than Chrome, LND versions other than 0.20, Core Lightning/LDK, multiple tabs against the same server beyond the SSE cap, and long soak runs. **LOCAL CI PASS only**: the commands the workflow runs (`npm ci`, `npm audit`, `npm run check`) pass locally. The GitHub Actions workflow has **not** been run on GitHub, so there is no REMOTE CI result.

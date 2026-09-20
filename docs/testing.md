# Testing

| Layer | Command | What it covers |
|---|---|---|
| Types | `npm run typecheck` | strict TypeScript with unused-symbol checks |
| Unit and integration (no Docker) | `npm test` | logger, config, payload, key derivation, Nostr transport against a local relay including hostile relays, backup service (retry, resubscribe, refresh, dedupe, timestamps), verification, security assessment, drill runner, HTTP API and its guards, LND client against a real HTTPS server (pinning, timeouts, streams) |
| Browser | included in `npm test` | Headless Chrome over the DevTools protocol: dashboard XSS regression, empty state, landing live-drill JS, static hosting. Skipped if no Chrome/Chromium (set `CHROME_PATH`) |
| Regtest e2e | `npm run e2e` | Real LND nodes, 46 checks: least-privilege macaroons confirmed by LND, monitor against a live node, live channel update, corrupted and foreign relay events, relay outage and recovery, wipe and restore with the restricted restore macaroon, the CLI `relay-test` command, relay management |
| Drill | `npm run demo` | The disaster drill the landing page runs |

`npm test` uses `--test-force-exit --test-timeout=120000` so a hung test cannot stall the run; the browser-test file alone takes about 45 s, and Node 22 applies the limit to the whole file, so 30000 cancelled it. The LND client tests need `openssl` to make throwaway certificates.

## Counts (2026-09-19)

`npm run check`: typecheck clean, **161 tests, 161 pass**, 0 skipped (22 test files). `npm run e2e`: 46 of 46 checks, run on real LND 0.20.0-beta / bitcoind 30 regtest. `npm audit`: 0 vulnerabilities. At the start of the previous hardening pass the suite had 67 tests and the e2e 24 checks.

Fake LND and fake publishers (`testutil.ts`) mimic the real behaviours that broke earlier code (LND re-encrypts the backup on every export). Bugs found only on real LND are listed in `FINAL_PROJECT_STATUS.md`. Browser tests drive headless Chrome over the DevTools protocol; only Chrome has been verified.

The tests bind fixed loopback ports in the 7700 to 7900 range (test relays and servers), so they should not run while another process holds those ports; they never use Docker. `npm run demo:reset` and the tests' reset checks only ever touch a temporary directory or `<repo>/data`.

## Not covered

Public relay retention over days (only the one-shot relay test was run, see `public-relay-testing.md`), testnet/mainnet, browsers other than Chrome, LND versions other than 0.20, Core Lightning/LDK, multiple tabs against the same server beyond the SSE cap, and long soak runs. **CI**: the workflow (`npm ci`, `npm audit`, `npm run check`) succeeded on GitHub Actions for commit `0cb7a92` (run 35503145035, Node 22.23.2: 161 / 161 tests, 0 vulnerabilities). The earlier runs on `346215c` (Node 22 relay-failure stack overflow, browser-test timeout, Chrome cleanup race) and `0127152` (a landing overflow assertion that compared `scrollWidth` with `innerWidth`, which reads -15 with Linux Chrome's 15 px scrollbar) were red and were fixed. `npm run e2e` (46 / 46 on Node 22.23.2 and 26.7.0) is local only: it needs Docker and is not part of the workflow.

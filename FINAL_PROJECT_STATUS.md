# Lifeboat: final project status

Snapshot 2026-09-19, release-frozen locally 2026-09-20. "Verified" means it was run in this environment (macOS, Node 26.7, Docker, headless Chrome, LND 0.20.0-beta, bitcoind 30.0 on regtest). Anything not run is listed as such. **Nothing is pushed, published, hosted or submitted; no Git remote is configured.**

## LOCAL RELEASE FREEZE

**Status: LOCAL RELEASE CANDIDATE — FROZEN (not published)**

| Item | Status |
|---|---|
| Local commits | `92760ef` feat: freeze Lifeboat hackathon release candidate; `3d91ba3` fix: do not share a verification that began before the latest publish; then a docs-only commit recording the clean-clone result (`git log`). All local, nothing pushed |
| Clean clone | **PASS** at `3d91ba3`: fresh `git clone` from the local repository, tree identical, `npm ci`, 159 / 159 tests, audit 0, e2e 44 / 44, README demo commands (`demo`, `playground`, `demo:check`, `demo:reset`) all worked. The first clone (of `92760ef`) had one flaky e2e check, fixed in `3d91ba3` |
| Tests | `npm run check`: typecheck clean, **161 / 161** pass (22 files); 2026-09-20 after a fresh `npm ci` |
| E2E | **46 / 46** real-LND checks (regtest, Docker) |
| Benchmark | Freeze run through the UI: **37.6 s** total, **24.0 s** wipe to recovery, 1,492,866 of 1,493,060 sats, 194 sats fees, relays 2/0 accepted, 1 of 2 reachable at restore, verification verified. Known benchmark 37.9 s / 24.3 s and earlier range 36.9 to 40.9 s: **no material difference** |
| Browser | **Chrome verified** (headless, fresh profile, 0 console errors). Firefox and Safari **not tested**, no support claimed |
| Public relay | **Partial**: one-shot dummy-event tests on 4 public relays (2 passed both runs, 1 intermittent, 1 timed out once) plus a read-only adversarial query; retention unmeasured. No further public testing was done in this phase |
| Testnet | **NOT TESTED** |
| Remote CI | **NOT RUN** (no remote; the workflow has only been run locally) |
| Hosting | **NOT HOSTED**; no deployment configuration exists |
| Devfolio | **NOT SUBMITTED** |

Found and fixed in this phase: the `verifyNow` race above (found by the clean-clone e2e run); `demo:reset` waited on a hung `docker` for as long as it hung (now bounded to 15 s, and its logic is testable against a temporary directory); the LICENSE choice was left to the owner (`docs/license-decision.md` is a comparison table only). Checklist: `docs/local-release-checklist.md`.

## Final Local QA

Date: 2026-09-20. Environment: macOS 26.6.2, Node 26.7.0 (Node 22 not tested), npm 11.19.0, Docker 29.5.2, `polarlightning/lnd:0.20.0-beta`, `polarlightning/bitcoind:30.0`, Chrome 153 (headless). Start state: branch `main`, commit `2031bff`, clean tree, no Git remote. Nothing was pushed, hosted, submitted or uploaded. Every number below was measured in this pass, not copied from earlier documents.

**Status: LOCAL RELEASE CANDIDATE, FROZEN.** No feature was added.

### Results

| Area | Result | Label |
|---|---|---|
| `npm ci` (fresh `node_modules`), then `npm run check` | typecheck clean; **161 / 161** tests pass, 0 skipped (Chrome present, so the 13 browser tests ran), 44 s | VERIFIED |
| `npm test` | the test half of `npm run check`; identical result | VERIFIED |
| Build / lint | no such scripts exist (`npm run typecheck` is the compile check) | n/a |
| `npm audit` | 0 vulnerabilities | VERIFIED |
| `npm run e2e` (real LND 0.20 + bitcoind 30, regtest) | **46 PASS / 0 FAIL**, exit 0; 46 s in a clean clone with images pulled | VERIFIED |
| Recovery drill, `npm run demo` from clean state | 1,493,060 sats in 2 channels, **1,492,866 recovered, 194 sats fees**; total **36.4 s**, wipe to funds back **23.9 s**; 2 relays accepted / 0 failed, 2 healthy before, **1 of 2 reachable at restore**; verification `verified`. Repeat in the clean clone: 36.4 s / 23.7 s, same sats and fees | VERIFIED |
| e2e disaster restore (3 channels, restricted restore macaroon only) | 1,739,326 of 1,739,590 sats recovered (264 sats fees) | VERIFIED |
| README commands from scratch (`npm ci`, `check`, `web`, `playground`, `demo:check`, `playground:open`, `demo`, `demo:reset`, `e2e`) | all exist and worked; `demo:check` printed READY; reset left no containers, ports or `data/` behind | VERIFIED |
| Clean local clone (`git clone` of the local repository, commit `2f20ae0`, not GitHub) | tracked files identical; `npm ci`, check 161 / 161, audit 0, e2e 46 / 46, `demo` PASS | VERIFIED |
| Chrome | 161-test suite incl. 13 headless-Chrome tests, 0 skipped | VERIFIED |
| Firefox, Safari | not run | NOT VERIFIED |
| Public relays | one-shot dummy-event tests from 2026-09-19 only (nos.lol and relay.primal.net passed both runs; relay.damus.io intermittent; relay.nostr.band timed out once, not retried). No new public test in this pass. Retention, universal compatibility, reliability and censorship resistance are not claimed | PARTIALLY TESTED |
| Testnet, signet, mainnet | guards unit-tested against a stubbed node only | NOT TESTED |
| GitHub Actions | workflow never run remotely | NOT TESTED |
| Node 22 | not run (README says "expected to work") | NOT TESTED |
| Accessibility | see below | PARTIALLY TESTED |

Drill against the benchmark (1,493,060 / 1,492,866 / 194 sats; 24.3 s wipe to funds; full drill 36.9 to 40.9 s): sats and fees are identical. Total 36.4 s and 36.4 s are 0.5 s below the lowest earlier run, and wipe-to-funds 23.9 s / 23.7 s is 0.4 to 0.6 s below 24.3 s. About 15 s of that is the fixed 5 x 3 s redial schedule, so the spread is run-to-run variation; no code was changed to reproduce or improve any number.

### Failure modes (each is an automated test, all passing above; A, H and the concurrent/relay cases also ran against real LND)

| | Case | Expected | Actual | Evidence | |
|---|---|---|---|---|---|
| A | One relay unavailable | Verification still passes via the other, redundancy flagged DEGRADED, publish reaches the survivor, recovery on return | As expected | e2e "relay outage"; drill restores with 1 of 2 relays | PASS |
| B | Several relays unavailable | Backup still found on any live relay; all down fails promptly with a clear message | As expected | `hostile.test.ts` (multiple / all relays down) | PASS |
| C | Malformed relay event or frame | Dropped and counted, no crash or stall | As expected | `hostile.test.ts` (garbage frames, `null`, wrong types) | PASS |
| D | Foreign event (other author, kind or `d` tag) | Never selected; verification unaffected | As expected | `hostile.test.ts`, `nostr.test.ts`, e2e "hostile and broken relay content" | PASS |
| E | Invalid signature (tampered after signing) | Rejected by local validation | As expected | `hostile.test.ts` (forged, extra-field and bad-id events), `nostr.test.ts` | PASS |
| F | Stale event | Loses to a newer valid one | As expected | `nostr.test.ts` (newest wins, ties by id) | PASS |
| G | Future-dated event | Never shadows a current backup; used and flagged only if it is the only one | As expected | `nostr.test.ts`, `verify.test.ts`, `hostile.test.ts` | PASS |
| H | LND unavailable | Dashboard shows FAILED, monitor reconnects and re-verifies on its own | As expected | e2e "lnd outage and recovery"; `monitor.test.ts` | PASS |
| I | LND timeout | Request fails after the limit instead of hanging; idle stream is not killed | As expected | `lnd.test.ts` (timeout, slow-but-timely, cut-off body, idle stream) | PASS |
| J | Concurrent drill request | Exactly one drill starts, the second is refused with 409 | As expected | `web.test.ts` | PASS |
| K | Browser disconnect | Client slot freed, dead connections pruned, drill continues | As expected | `sse.test.ts`, `web.test.ts` | PASS |
| L | SSE reconnect | Late client gets the run replayed; console shows a banner when the server is lost and clears it on return | As expected | `web.test.ts`, `ui.test.ts` | PASS |

### Security recheck

Code read: `nostr.ts`, `keys.ts`, `payload.ts`, `log.ts`, `web.ts`, `lnd.ts`, `config.ts`, `demo-env.ts`. Result: **no security defect found; nothing changed in `src/` except a test assertion.**

| Control | Where | Evidence |
|---|---|---|
| TLS pinning | `lnd.ts` `opts()`: `ca` is the node's own certificate, `servername` fixed | `lnd.test.ts` (a different certificate is refused) |
| Least-privilege macaroon | `MONITOR_PERMS`, `RESTORE_PERMS`; `canSpendOnchain()` asks LND | e2e: monitor macaroon cannot send, bake or create addresses |
| Token comparison | `web.ts` `sameToken`: length check, then `timingSafeEqual`; POSTs without it get 403 | `web.test.ts`; live check: POST without token 403 |
| Host / Origin validation | `web.ts`: exact `host:port` for 127.0.0.1 or localhost; Origin must equal the Host | `web.test.ts`; live check: foreign Host 403 |
| Nonce CSP and headers | `web.ts` `csp()`, per-response nonce, `nosniff`, `no-referrer`, `DENY` | `web.test.ts`, `ui.test.ts`; live response headers inspected |
| Relay author, kind, `d` tag, signature, payload | `nostr.ts` `isOwnValid` (never throws), `payload.ts` `decodePayload` | `hostile.test.ts`, `nostr.test.ts`, `payload.test.ts` |
| Channel-set fingerprint | `payload.ts` `channelSetHash`; LND's `VerifyChanBackup` decides what a relay copy contains | `payload.test.ts`, `verify.test.ts`, e2e |
| Reset path and filesystem safety | `demo-env.ts` `wipeDataDir`: only `<repo>/data`, links unlinked not followed; the only other deletes are `data/alice` | `demo-env.test.ts` |
| Secret redaction | `log.ts` `redact` by key name and blob length | `log.test.ts` |
| XSS | text-only rendering of hostile strings | `ui.test.ts` |

Secret search over all 105 tracked text files for PRIVATE KEY, BEGIN, SEED, MNEMONIC, MACAROON, PASSWORD, SECRET, TOKEN, CREDENTIAL and for long hex or base64 literals: no PEM blocks and no real credentials. Hits are code identifiers, documentation, a regtest wallet password (`password12345`) and regtest RPC credentials (`lb`/`lb`) that are published on 127.0.0.1 only, and two public hex fixtures in tests (a Nostr public key and a transaction id). Screenshots were read: throwaway regtest data only, public keys and fingerprints, no macaroon, seed or personal data.

Residual, already documented: the console token is readable by any local process; relay metadata (key, timing, size, IP) is visible to relays.

### Network safety

Mainnet is refused unless `LIFEBOAT_ALLOW_MAINNET=1` (`config.ts` `assertNetworkAllowed`, `config.test.ts`, `monitor.test.ts`); `LIFEBOAT_NETWORK` refuses a node on any other network; the console shows REGTEST / TESTNET / MAINNET labels. The demo uses a fresh disposable regtest network under `<repo>/data` and fake coins. No production node, mainnet or testnet node was contacted. The only outside network use in this pass was fetching the URLs listed in `docs/competitive-analysis.md`.

### Accessibility

The landing hero button (`.hero-cta` in `web/index.html`) was white on `#e8702a`, 3.1 : 1. **Fixed:** text is now `#111827` (5.73 : 1 at rest, 4.62 : 1 on hover; the orange is unchanged); `ui.test.ts` asserts both states and `01-landing.png` was re-captured. Only the listed colour pairs are measured. No full WCAG audit, screen-reader test or keyboard walk-through of the landing page was done, and **no WCAG conformance is claimed**.

### Changes made in this pass

- `web/index.html`, `src/ui.test.ts`: hero button contrast (above); the contrast test title no longer says "every text colour meets WCAG AA".
- `screenshots/01-landing.png` re-captured from the running app (the only stale screenshot).
- `docs/competitive-analysis.md`: a ZEUS link that returned 404 replaced by the live page (read; it confirms the claim); an unverified Breez SDK row removed; link check recorded. The Phoenix link on Medium answered 403 to a script and was not opened by hand.
- README, `docs/deployment.md`, Devfolio draft: added that restore needs the URL of at least one relay holding the backup (relay URLs are not derived from the seed, and Lifeboat has no default relay). README track section said "Submitted"; now "Intended track (not yet submitted)".
- Benchmarks, public-relay wording, accessibility statements, e2e duration and the license line brought in line with the values above; commit hashes updated after the history was rewritten.

### Claims mapped to code

Seed-derived Nostr identity: `keys.ts` `deriveNostrKey`. No extra recovery secret: same key returns after a wipe (e2e, drill). NIP-44 encrypted backup: `nostr.ts` `publishBackup`. Untrusted relays and local validation: `isOwnValid`, `pickNewestDecryptable`. Channel-set fingerprint: `payload.ts` `channelSetHash`. Live-node verification: `lnd.ts` `verifyBackup`, `backup.ts` `verifyBackup`. Peer hints and redial: `lnd.ts` `channelPeerHints`, `backup.ts` restore loop (5 rounds of 3 s). Least-privilege macaroon: `lnd.ts` permission lists, `canSpendOnchain`, `cli.ts bake`. Real LND drill: `demo.ts`, `e2e.ts`. Each claim in `docs/technical-story.md` that was checked (60 s verify interval, 5 s / 15 s / 60 s / 5 min retry with jitter, state list, +600 s future skew) matches the code.

### Remaining issues

None that block the local release candidate. Known and documented: restore closes channels and needs peers online; about 200 channels per backup; LND only (0.20); regtest only; public relay retention unmeasured; Chrome only; the console token is readable by local processes; fonts are loaded from Google.

## A. Current status

Feature-frozen (`docs/feature-freeze.md`) and submission-ready as a package, pending owner decisions listed in section R. Verified on regtest with real LND nodes; testnet and mainnet were not run.

| Check | Result |
|---|---|
| `npm install` | completed without errors |
| `npm run check` (typecheck + tests) | clean; **161 / 161 tests pass** in 22 files |
| `npm run e2e` (real LND, regtest) | **46 / 46 checks** |
| `npm audit` | **0 vulnerabilities** |
| Build / lint | none exist; `npm run typecheck` is the compile check |
| Clean install (fresh copy, `npm ci`, check, demo, reset) | passed |
| Exact output of every command | `submission/test-results.md` |

**LOCAL CI PASS:** the commands in `.github/workflows/ci.yml` pass locally. **REMOTE GITHUB CI:** NOT RUN (no remote is configured, nothing was pushed).

## B. Baseline

| | Start of hardening | End of previous pass | Now |
|---|---|---|---|
| Unit and browser tests | 67 | 133 | **161** |
| Real-LND e2e checks | 24 | 41 | **46** |
| Recovery drill | 2 channels, 1 relay | same | 2 channels, **2 relays, one switched off during restore** |

Recovery drill baseline: 1,493,060 sats in channels, 1,492,866 recovered, 194 sats fees, about 38 to 48 s. **Now:** identical sats and fees on every run; total 36.4 to 40.9 s across eleven runs (section G; the 36.4 s run is the final QA run).

## C. Bugs fixed (each has a regression test)

Earlier passes: garbage relay event crashing restore; blob-vs-fingerprint comparison making verification impossible on real LND; missed changes during an LND stream gap; `demo.ts` deleting a relative `./data`; LND client with no timeouts and hanging on truncated bodies; future-dated events shadowing new backups; concurrent drills; SSE flush, cap and buffers; unvalidated restore payload; `canSpendOnchain` misread; peer-dial race in restore; playground going stale; **LND backup stream killed by an idle timeout** (found only in the live playground).

This pass:

| Severity | Bug | Fix | Test |
|---|---|---|---|
| High | The relay probe threw on a `null` or non-array frame from a relay (uncaught in a listener) | Frames must be arrays; junk is dropped | `hostile.test.ts` |
| High | `isOwnValid` threw on a malformed event (`tags` not an array), so one hostile relay could break verification and restore | Total function, never throws | `hostile.test.ts` |
| High | An own-signed newer event with an unusable payload hid an older good backup | Selection skips events whose payload does not decode; verification reports it | `hostile.test.ts`, `verify.test.ts` |
| Medium | Verification trusted a self-declared fingerprint | LND's `VerifyChanBackup` decrypts the relay copy and its channel list decides | `verify.test.ts`, e2e (real LND, read-only macaroon; corrupted blob rejected) |
| Medium | A verification with an unreachable relay could still read `verified` | Reduced redundancy is `degraded` | `hostile.test.ts` |
| Medium | `start()` twice doubled timers and the LND subscription; a failed start looked like a running service | Guard; failed start resets and can be retried | `monitor.test.ts`, `backup.test.ts` |
| Medium | LND 0.20's `testnet4` was reported as "unknown network" | Recognised and labelled | `config.test.ts` |
| Medium | Regtest Docker ports (including bitcoind RPC with a known password) were published on all interfaces | Bound to 127.0.0.1 | inspected |
| Medium | Landing hero one-liner overflowed the viewport on both sides (found in a screenshot; the old test only checked text) | Width and wrapping fixed; hero must fit at 1280, 400 and 320 px | `ui.test.ts` (mutation-checked) |
| Low | CLI errors were raw (`connect ECONNREFUSED`) | Cause and action shown, exit codes tested | `cli.test.ts` |
| Low | Drill in a repository Docker cannot bind-mount failed with "timeout waiting for genseed" | Clear message naming the cause | `demo-env.test.ts`, manual |
| Low | The landing page's "Run it" commands failed when pasted as shown: no `cd` step, and `<lnd dir>` placeholders that a shell reads as a redirect (`zsh: no such file or directory: lnd`) | A `cd lifeboat` step, `export LND_DIR=~/.lnd` and `$LND_DIR` paths; README and docs use the same forms | `ui.test.ts` (no `<` or `>` in any command; mutation-checked) |
| Low | `verify` and `pubkey` printed a log line on stdout ahead of their result, so a script could not parse them (found by running the landing page's commands literally) | CLI logs go to stderr; stdout carries only the result | `log.test.ts`, e2e (`cli verify` pure JSON, `cli pubkey` 64-hex) |
| Low | Drill used one relay, so redundancy was not shown | Two relays, one switched off during restore | drill runs |
| Medium | `Monitor.verifyNow()` could hand a caller the result of a verification that began before the latest publish finished (surfaced as one flaky e2e check, "the next publish heals the relay", in the clean-clone run); it could also trigger a needless republish | A run that predates the latest publish is not shared: the caller waits for it, then gets a fresh run | `monitor.test.ts` |

## D. Features added this pass

Measured encryption, export, verify and redial timings in the drill; verify checkpoints (lnd validation, fingerprint match) in the landing drill; verification checklist in the console; `LIFEBOAT_NETWORK` expected-network guard; `npm run demo:check` (READY only when everything answered) and `npm run demo:reset` (deletes `<repo>/data` only), prerequisite checks; landing copy (problem, solution, CTAs); architecture diagram; ten real screenshots and their capture script; submission package and documentation set.

## E. Security controls

Listed with tests in `docs/security-architecture.md` and `docs/security.md`; threat model (18 actors) in `docs/threat-model.md`. Key points: relay events validated locally; NIP-44 encryption before publication; TLS-pinned LND traffic; least-privilege macaroons confirmed by LND; loopback console with token, Host and Origin checks and nonce CSP; redacted logs; mainnet refused by default. Non-goals are stated there too (compromised host, stolen seed, relay metadata, other local users, all relays withholding).

## F. Tests

161 tests (22 files) and 46 e2e checks; see `docs/test-matrix.md` for the 20 disaster scenarios, each with expected, actual and evidence.

## G. Real-LND results

Recovery drill, final code (`npm run demo`, 2026-09-19): 1,493,060 sats in 2 channels, **1,492,866 recovered, 194 sats fees**, total **37.9 s**, wipe to funds back 24.3 s. Steps (measured): lnd backup export 13 ms, encryption and signing 5.5 ms, publish 10 ms, verification 41 ms, discovery 24 ms, import into lnd 85 ms, redial 15.0 s (a fixed 5 × 3 s schedule, not measured work), backup 1,811 bytes, relays 2 accepted / 0 failed, 2 healthy before the disaster, 1 reachable at restore. Ten runs ranged 36.9 to 40.9 s. The earlier baseline (1,492,866 / 194 sats / 38 to 48 s) is reproduced; the small time difference is run-to-run variation plus the added verification step (tens of milliseconds).

e2e: 46 / 46, including wipe and restore with only the restricted restore macaroon (1,739,326 of 1,739,590 sats across 3 channels), lnd validating the relay copy through the read-only macaroon, and lnd rejecting a corrupted blob.

## H. Public relay results

`docs/public-relay-testing.md`. Dummy-event test (throwaway key, isolated namespace, NIP-09 cleanup): nos.lol and relay.primal.net passed on both runs; relay.damus.io failed or dropped the read-back once and passed once; relay.nostr.band timed out once and was not retried. The current test also validates payload and fingerprint. Read-only adversarial query: 414 real unrelated kind-30078 events, none accepted, no crash. Retention over time is unmeasured.

## I. Testnet results

**NOT TESTED.** Only labels and guards are unit-tested against a stubbed node.

## J. Browser results

Chrome (headless, DevTools protocol): verified, 13 browser tests and the UI-driven drill (repeated on 2026-09-20 in a fresh profile with extensions disabled, 0 console errors or warnings). **Firefox:** not installed. **Safari:** a WebDriver session could not be created (the request timed out; remote automation is not enabled), so it was not tested. No compatibility is claimed for either.

## K. Performance

Landing (new hero, fresh browser profile): DOM ready 337 ms including the Google Fonts stylesheet, 56 KB HTML; the earlier 21 to 28 ms figures were measured with a warm profile and are not comparable. Hero: 59 fps while the pointer moves and 61 fps idle (device pixel ratio 2), no style writes while idle, JS heap 1.3 MB. API p50 0.6 to 0.8 ms, p95 4.4 to 5.2 ms. After 5,000 API calls and 300 opened-and-aborted SSE streams: RSS 64 MB, then 80 MB, then 62 MB after 100 s idle; 0 established connections left; 1 publish in total (no duplicates); no stream churn. Timers, subscriptions and RPC cadence are covered by a test (`monitor.test.ts`).

## L. Competitive analysis

`docs/competitive-analysis.md`: 13 adjacent projects with URLs, overlap, difference and concerns; bounded searches, no "first" claim.

## M. Novelty analysis

`docs/novelty-analysis.md` and `docs/differentiation.md`: differentiation is the combination (seed-only recovery, untrusted relays, verification of the relay copy with LND as authority, a real restore drill). Uncertainty: searches are bounded, private work and most of the BOSS Battle gallery were not reviewed, and no user has tried it.

## N. Track analysis

`docs/boss-battle-positioning.md`: Freedom Stack is the fit; ecash is absent; Cypherpunk and Machine Money are weak and not claimed.

## O. Demo flow

`docs/demo-script.md` (2:40, one screen): `npm run demo:reset`, `npm run web`, landing page, **Run recovery drill**: backup on two relays, verification by lnd, wipe with one relay off, restore from seed, sats, fees, time, security section, limits. Rehearsed through the UI in headless Chrome: 38.2 s, six stages, five checks passed, no console errors.

## P. Submission readiness

Ready locally: README, docs (`docs/`), `submission/` package, Devfolio copy (`submission/devfolio-submission.md`), video script and checklist, ten screenshots (`screenshots/`), architecture diagram. Not done: license, repository, remote CI, video, Devfolio submission.

## Q. Known limitations

The landing hero button was below WCAG AA contrast (white on `#e8702a`, 3.1:1) and was fixed in the final QA (dark text, 5.73:1; `docs/landing-design.md`); no full WCAG audit was run; restore closes channels and needs peers online; about 200 channels per backup; LND only (0.20 used); regtest-verified only; public relay retention unmeasured; Chrome only; relay edits in the console are session-only; both pages load fonts from Google; MIT license (`LICENSE`); the console token is readable by any local process (not a multi-user service).

## R. Exact next actions (need the owner)

1. Choose a license (`docs/license-decision.md`), add `LICENSE` and the `package.json` field.
2. Review the local commit history (`git log`); nothing has been pushed. Decide when and where to push.
3. Create the repository; replace `[GitHub URL — TO BE ADDED]` in the README and `submission/devfolio-submission.md`.
4. Let GitHub Actions run once and record the real result.
5. Record the video (`docs/video-checklist.md`), upload it yourself, add the URL.
6. Re-read the live BOSS Battle gallery for overlap; re-check numbers against your final take.
7. Submit on Devfolio yourself.

## Commands

```bash
npm install
npm run check                       # typecheck + 161 tests
npm run web                         # landing + live drill, http://127.0.0.1:8080 (Docker)
npm run playground                  # regtest + console at /console
npm run playground:open -- 250000
npm run demo                        # drill in the terminal
npm run demo:check                  # READY only when the running playground answers everywhere
npm run demo:reset                  # remove regtest containers and <repo>/data
npm run e2e                         # real-LND end to end (Docker)
npm run cli -- <pubkey|backup|verify|restore|bake|relay-test>
npm run daemon
```

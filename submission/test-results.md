# Test results (actual output)

Recorded 2026-09-19 to 2026-09-20. Environment: macOS 26.6.2, Node v26.7.0, npm 11.19.0, Docker version 29.8.0, build 88096ef005, LND 0.20.0-beta and bitcoind 30.0 (regtest images), headless Google Chrome. Output below was copied from the runs, not retyped. There is no build or lint script in this project: `npm run typecheck` is the compile check.

## npm install and npm run check

```
$ npm ci
$ npm run check
ℹ tests 159
ℹ suites 0
ℹ pass 159
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32099.449583
```

159 test cases passed, 0 failed, 0 skipped, in 22 test files (tests per file):

```
 17 src/backup.test.ts
  4 src/cli.test.ts
  9 src/config.test.ts
  7 src/demo-env.test.ts
  4 src/drill-parse.test.ts
  4 src/drill.test.ts
  2 src/errors.test.ts
  7 src/hostile.test.ts
  2 src/keys.test.ts
 14 src/lnd.test.ts
  3 src/log.test.ts
 11 src/monitor.test.ts
  7 src/nostr.test.ts
  6 src/payload.test.ts
  1 src/regtest.test.ts
  5 src/relay-test.test.ts
  4 src/relays.test.ts
 10 src/security.test.ts
  5 src/sse.test.ts
 13 src/ui.test.ts
  7 src/verify.test.ts
 17 src/web.test.ts
```

## npm run e2e, npm audit, npm run typecheck (real LND nodes, regtest)

Three consecutive e2e runs passed 44/44 after the `verifyNow` fix (one earlier run, in a fresh clone, had failed one check); the output below is the third.

```
$ npm run e2e

== regtest network with two channels

== least-privilege macaroons, confirmed by lnd itself
PASS  admin macaroon is reported as able to spend
PASS  monitor macaroon is reported as unable to spend
PASS  monitor macaroon cannot send coins
PASS  monitor macaroon cannot bake more macaroons
PASS  monitor macaroon cannot create addresses

== monitor against the live node
PASS  backup accepted by both relays
PASS  verification passes: decrypts with the seed-derived key and matches the node
PASS  lnd itself decrypts the relay copy (through the read-only monitor macaroon) and finds both channels inside it
PASS  dashboard data is real: 2 channels, regtest, connected
PASS  monitor reports its own macaroon as read-only
PASS  security center is all green
PASS  backup pipeline is SUCCESS with no invalid transitions (state SUCCESS)
PASS  the baked macaroon file is owner-only
PASS  the published fingerprint is what verification reads back from the relays
PASS  pending channels and network are read from lnd

== live update: a third channel is backed up without any action
PASS  backup updated to 3 channels and verified against the node
PASS  the channel-set fingerprint changed with the channel set

== hostile and broken relay content
PASS  an event from another key on the relays does not affect verification
PASS  a relay serving a corrupted copy is reported as stale (verdict DEGRADED), the good relay still verifies
PASS  the next publish heals the relay

== lnd rejects a relay copy it cannot decrypt
PASS  a well-formed but corrupted backup is rejected by lnd itself
PASS  the next publish restores a backup that lnd accepts

== relay outage
PASS  with one relay down, verification still passes through the other
PASS  security center flags reduced redundancy as DEGRADED
PASS  publishing succeeds on the surviving relay and reports the failed one
PASS  when the relay returns, the next publish reaches it again
PASS  both relays hold the latest again

== CLI against the real node
PASS  cli bake writes the macaroon and reports lnd's own confirmation that it cannot spend
PASS  cli bake refuses to overwrite an existing file
PASS  cli verify exits 0 with verdict verified
PASS  cli verify rejects a bad RELAYS value up front (exit 2)
PASS  cli verify reports a missing macaroon file as a configuration error
PASS  cli relay-test refuses to publish anything without --yes
PASS  cli relay-test --yes publishes a dummy event, reads it back and deletes it

== lnd outage and recovery
2026-09-19T19:31:39.280Z ERROR backup verification could not run {"category":"verify","error":"connect ECONNREFUSED 127.0.0.1:8081"}
PASS  the dashboard shows lnd as unreachable and the lnd check FAILED
PASS  overall status is FAILED while lnd is down
2026-09-19T19:31:40.781Z ERROR backup verification could not run {"category":"verify","error":"GET /v1/channels/backup -> 500: {\"code\":2,\"message\":\"wallet locked, unlock it to enable full RPC access\",\"details\":[]}"}
PASS  after lnd returns the monitor reconnects on its own and verification passes
PASS  the backup stream resubscribed and the pipeline never left the state machine

== disaster: wipe alice, restore with the restricted restore macaroon only
PASS  same node identity from the seed
PASS  same Nostr backup key re-derived from the seed
PASS  restore macaroon cannot spend either
PASS  restore reports the fingerprint of the backup it used and real timings
PASS  all 3 channels restored and waiting for their peers
PASS  channel funds recovered on-chain (1739326 of 1739590 sats)

all e2e checks passed
exit code: 0

$ npm audit
found 0 vulnerabilities
exit code: 0

$ npm run typecheck
exit code: 0
```

## Recovery drill (`npm run demo`, latest recorded run)

```
alice: 298492032 sats on-chain + 1493060 sats in 2 channels
recovered 1492866 of 1493060 channel sats on-chain
metrics: {"backupBytes":1811,"publishMs":10,"discoverMs":24,"importMs":85,"redialMs":15045,"exportMs":13,"encryptMs":5.53,"verifyMs":41,"relaysHealthy":2,"relaysAtRestore":1,"recoveryMs":24277,"totalMs":37894,"relaysOk":2,"relaysFailed":0,"feesSats":194}
```

Across the drill runs recorded that day (nine, counting three started from the landing page in headless Chrome and one from a fresh clone) the total ranged from 37.1 s to 40.9 s; every run recovered 1,492,866 of 1,493,060 sats with 194 sats in fees. The 15 s `redialMs` is a fixed schedule (5 rounds of 3 s), not measured work.

## Release-freeze drill, through the UI (2026-09-20)

Started with `npm run demo:reset` then `npm run web`; driven in headless Chrome with a brand-new profile (extensions disabled, empty storage) by pressing the page's own button; numbers read from the page. Benchmark for comparison: 37.9 s total, 24.3 s wipe to recovery, 1,492,866 of 1,493,060 sats, 194 sats fees. This run: 37.6 s and 24.0 s with identical sats and fees, within the earlier 37.1 to 40.9 s range.

```
landing: {"title":"Lifeboat — Back up, verify, recover your Lightning node","h1":"Back up your node. Verify. Recover.","cta":["Run recovery drill","View architecture"],"localStorageKeys":0}
t=0.5s stages=pppppp status="Running"
t=9.0s stages=dapppp status="Running"
t=12.1s stages=ddappp status="Running"
t=13.1s stages=dddapp status="Running"
t=14.6s stages=ddddap status="Running"
t=34.2s stages=ddddda status="Running"
t=38.2s stages=dddddd status="Passed"
result: {"st-channels":"2","st-before":"1,493,060","st-after":"1,492,866","st-lost":"194","m-total":"37.6 s","m-recovery":"24.0 s","m-bytes":"1.8 KB","m-export":"14 ms","m-encrypt":"5.4 ms","m-publish":"10 ms","m-verify":"30 ms","m-discover":"20 ms","m-import":"76 ms","m-fees":"194 sats","m-relays":"2 / 0","m-atrestore":"1 of 2"}
checks: ["ck-pub=pass","ck-verify=pass","ck-id=pass","ck-key=pass","ck-fp=pass"]
terminal: published: 1ch->2relay, 2ch->2relay | verify before the disaster: verified, 2 of 2 relay(s) healthy | PASS  backup verified before the disaster: lnd itself decrypted the relay copy and found 2 channel(s) in it | relay ws://127.0.0.1:7777/ is switched off too: the restore has to work with 1 of 2 relays | PASS  same node identity from seed | PASS  same Nostr backup key re-derived from seed (no extra secret needed) | PASS  the restored backup has the channel-set fingerprint that was published | recovered 1492866 of 1493060 channel sats on-chain | PASS  channel funds recovered (only fees lost)
drill finished: true | page problems: []
```

## Docker unavailable (manual runs with a stub `docker` on PATH)

```
daemon down : demo        -> prerequisite failed: Docker daemon: not reachable: start Docker Desktop or the docker service   (exit 1, 2 s)
daemon down : playground  -> same line                                                                                         (exit 1, 0 s)
daemon down : demo:reset  -> Docker is not reachable; containers were not touched ...                                          (exit 0)
docker hangs: demo / playground -> same prerequisite line, after the 15 s bound                                                (exit 1, 15 s)
docker hangs: demo:reset  -> bounded to 15 s (it waited 61 s before the fix)
not installed: demo / playground / demo:reset -> same lines as above
web, daemon down: GET /api/status -> {"busy":false,"dockerOk":false,"drill":true}; POST /api/run -> "Docker isn't running. Start Docker Desktop and try again." (HTTP 503)
```

## Not run

Testnet and mainnet; Firefox and Safari; Node 22; GitHub Actions (the workflow has only been run locally, so there is no remote CI result).

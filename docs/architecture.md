# Architecture

```
UI            web/index.html (landing + live drill), web/console.html (dashboard)      static, inline JS, nonce CSP
HTTP          src/web.ts (routes, security headers), src/serve.ts (entrypoint)          loopback only
Business      src/monitor.ts (state + schedules), src/security.ts (checks), src/drill.ts (drill runner), src/drill-parse.ts
Protocol      src/backup.ts (BackupService, verify, restore), src/payload.ts, src/keys.ts, src/nostr.ts
Integrations  src/lnd.ts (REST client), Nostr relays via nostr-tools and ws
Tooling       src/cli.ts, src/regtest.ts, src/demo.ts, src/playground*.ts, src/e2e.ts, src/relay.ts (test relay)
Cross-cutting src/config.ts (env parsing, relay and network validation), src/log.ts (structured, redacting logger), src/errors.ts (cause / impact / action), src/sse.ts (event broadcaster), src/relays.ts (session relay set), src/relay-test.ts (public relay test)
```

Rules the layout enforces:

- Protocol code never touches HTTP or the DOM; the web layer only calls `Monitor` and `DrillRunner`.
- `BackupService` depends on a narrow `BackupLnd` interface and a `Publisher` interface, so tests substitute fakes without mocking modules.
- There is no persistence. State is in memory (publish history, logs, relay health); the durable copy is the event on the relays.
- Pages render everything with `textContent`; they never build HTML from data.

## Data flow

1. `BackupService.start()` derives the Nostr key via LND, looks up the newest event of ours on the relays, then exports and publishes, and subscribes to LND's backup stream.
2. Each snapshot is reduced to `channelSetHash(chan_points) | peers`. Only a change (or `force`) leads to a publish: payload = `{ v, scb, peers, cp }`, NIP-44 encrypted to ourselves, kind 30078.
3. `Monitor` polls LND (10 s), probes relays and verifies (60 s and after every publish), checks its macaroon (hourly) and feeds `assess()`.
4. The console polls `GET /api/monitor`. Buttons call `POST /api/monitor/verify|publish` with the per-run token.
5. Restore: wait for LND `SERVER_ACTIVE`, derive the key, pick the newest valid decryptable event across relays, validate the payload, `RestoreChannelBackups`, then redial the peers for several rounds.

## Backup state machine

`IDLE → BACKING_UP → ENCRYPTING → PUBLISHING → SUCCESS | DEGRADED | FAILED`, plus `VERIFYING` (entered by the monitor's verification) and `RECOVERING` (a retry is scheduled). Transitions are whitelisted in `canTransition`; an impossible one is refused, counted, and shown as a failed security check. Retries use 5 s, 15 s, 60 s then 5 min, each with ±20 % jitter.

## Concurrency

Single-flight: publish (serialised inside `BackupService`), verify (`Monitor.verifyNow` shares one in-flight promise), drill (`DrillRunner`), public relay test (one at a time).

## Monitor schedule

LND poll every 10 s, verify every 60 s and after every publish, macaroon check hourly, periodic backup refresh every 6 h. `STALE_AFTER_SEC` (default 8 h) sets when "not refreshed recently" is warned.

# Deployment

Lifeboat is local-first and stateless: no database, no server-side accounts. The durable copy of your backup is the event on the relays.

## What to run

- **Backup daemon** next to your node: `npm run daemon` (env in `.env.example`). Exits on error; run it under a supervisor that restarts it.
- **Console** (optional): `npm run web` with the same `LND_*` and `RELAYS`. It also runs the backup service, so run either the daemon or the console with a node attached, not both.
- **Never expose the console.** It listens on 127.0.0.1 only and has no user accounts; the token and Host/Origin checks defend against other web pages, not against other network users. Do not put it behind a reverse proxy.

## Steps

1. `npm ci` (development dependencies are needed at runtime because the scripts use `tsx`).
2. `LND_MACAROON=$LND_DIR/data/chain/bitcoin/<network>/admin.macaroon npm run cli -- bake --out monitor.macaroon` (with `LND_CERT` and `LND_DIR` set as in the README; replace the network folder with yours; do not paste the angle brackets, the shell reads them as a redirect); keep only the baked file on the daemon host.
3. Set `LND_CERT`, `LND_MACAROON=monitor.macaroon`, `RELAYS` (two or more), then `npm run daemon`.
4. Check: `npm run cli -- verify` should exit 0, and `/healthz` (if the console runs) reports the security verdict.
5. Record your seed offline. Restore needs the seed and at least one relay that still holds the backup; no other secret or file.

## Networks

`regtest` is what has been tested. Testnet and signet need a run through `testnet-checklist.md`. Mainnet is refused unless `LIFEBOAT_ALLOW_MAINNET=1`, and then the console shows a MAINNET warning; do not do this with funds you cannot lose.

## Rollback

There is nothing to migrate. Redeploy the previous version; the event format is versioned (`v: 1`, `d = lifeboat/scb/v1`) and a version 1 backup remains readable.

## Systemd example (not tested)

```ini
[Service]
WorkingDirectory=/opt/lifeboat
EnvironmentFile=/etc/lifeboat.env
ExecStart=/usr/bin/npm run daemon
Restart=on-failure
RestartSec=10
```

## Status

Only the regtest tools have been exercised end to end. Treat any other network as untested. The CI workflow has not been run on GitHub.

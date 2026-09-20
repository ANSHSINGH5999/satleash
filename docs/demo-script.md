# Demo script (2 to 3 minutes)

Everything on screen comes from the real code and real LND nodes on a throwaway regtest network. Nothing is simulated except that the "disaster" is a deliberate wipe of a real node.

## Before you start (not part of the 3 minutes)

```bash
npm install
npm run demo:reset          # clean slate: removes regtest containers and <repo>/data only
npm run web                 # serves http://127.0.0.1:8080 with the live drill enabled
```

Open `http://127.0.0.1:8080/`. First run only: Docker pulls the images, which takes longer. Confirm the page says **Live mode is on**. The first drill run takes about 40 s; do one dry run beforehand and read the numbers you will quote from the screen, not from this file.

For the optional live-node tour (Plan B below) use `npm run playground`, wait for the line `READY: regtest demo environment is up`, or run `npm run demo:check` in another terminal (prints `READY` only when LND, two healthy relays, the backup service and a verification have all answered). Stop the web server first: both use ports 7777 and 7778.

## Plan A: one screen, about 2:40

| Time | Say | Show |
|---|---|---|
| 00:00 | "A Lightning node's channel state lives on one machine. The backup that protects it is a file someone has to keep copying." | Landing hero. Read the one-liner |
| 00:15 | "Lifeboat keeps that backup on Nostr relays, under a key derived from the seed, and checks it against the live node." | Scroll to **Architecture**; point at trusted vs untrusted |
| 00:30 | "Watch the real thing. Two LND nodes, two relays, two channels." | Click **Run recovery drill**. Stage 01 to 03 light up |
| 00:50 | "The backup daemon published every change to both relays, encrypted." | Terminal pane: `published: 1ch->2relay, 2ch->2relay`; fingerprint line |
| 01:05 | "Before any disaster, verification: lnd itself decrypts the relay copy and finds both channels." | Pill **Backup verified by lnd before the wipe**; terminal `verify before the disaster: verified, 2 of 2 relay(s) healthy` |
| 01:20 | "Now the disaster. The node is deleted completely, and one relay is switched off too." | Stage 04; terminal `alice is gone` and `relay … is switched off too` |
| 01:35 | "A new node from the 24 words and a known relay. Same identity, same Nostr key, same backup fingerprint." | Stage 05; pills **Same node identity**, **Same Nostr key**, **Restored backup has the published fingerprint** |
| 01:55 | "Funds are back on-chain." | Stage 06; read **sats before, sats after, fees, total time, relays reachable at restore** off the screen |
| 02:15 | "The relays are not trusted: events are validated locally. The daemon runs read-only, LND confirms it cannot spend. The console is loopback-only with token, Host and Origin checks and a nonce CSP." | Scroll to **Security model** |
| 02:35 | "Backup is not enough: Lifeboat checks the backup before you need it, and this drill shows the restore working. It is regtest, it closes channels, and peers must be online." | **Limits** section |

## Plan B (adds about 2 minutes): live node console

`npm run playground` → `http://127.0.0.1:8080/console`: Dashboard (recovery readiness evidence), **Verify** (what was checked, per-relay table), **Relays**, **Security**. Then `npm run playground:open -- 250000` in a second terminal and watch the backup follow the new channel.

## If something goes wrong

| Symptom | Cause | Action |
|---|---|---|
| Button disabled, "Live mode is off" | Server started with `LND_*` variables or the playground is running | Stop it; `npm run web` without those variables |
| "Docker is not running" | Docker daemon down | Start Docker; retry |
| `prerequisite failed: Port 7777` | A previous run is still active | `npm run demo:reset`, then retry |
| "Docker cannot bind-mount this folder" | Repository is outside the folders Docker Desktop shares | Move it under your home directory; `npm run demo:reset`; retry |
| Drill fails midway | Any | It cleans up by itself; press the button again. A failed run is shown as failed, never as success |
| Nothing at all | | Use the recorded run on the page (labelled with its date) and the screenshots in `screenshots/` |

## What not to claim

Not "unhackable", not "first", not "works on mainnet". It is regtest-verified, closes channels on restore, needs peers online, and public relay durability is unmeasured.

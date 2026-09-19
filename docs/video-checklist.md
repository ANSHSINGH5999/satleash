# Video recording checklist

## Machine and screen

- [ ] Resolution 1920×1080 (or 2560×1440 scaled to 1080p); browser window 1280×800 content area, page zoom 100 % (110 % if text is small on your display)
- [ ] Close every window and tab that is not the demo; use a fresh browser profile or a private window
- [ ] Hide the bookmarks bar, the dock and the menu-bar clock if it shows personal information
- [ ] Do Not Disturb on; disable notifications, calendar and chat pop-ups; quit chat apps
- [ ] Plug in power, disable sleep and the screen saver
- [ ] Stable network is not required for the drill itself (it runs on regtest), but the first run pulls Docker images: pull once beforehand

## Privacy and secrets

- [ ] Terminal shows only the repository directory: no personal path, hostname, email, or shell history; use a short prompt
- [ ] No environment variables with credentials are exported in the shell you record from; the demo needs none
- [ ] Do not open `.env` files, macaroons, `data/` folders or other projects' files on camera
- [ ] No personal or financial information in tabs, extensions or the browser's profile picture
- [ ] Only regtest data appears. Never show a testnet or mainnet node

## Environment

- [ ] `npm run demo:reset` (clean slate), then `npm run web`
- [ ] Do one full dry run and watch the numbers; take the recorded numbers from the take you keep
- [ ] Confirm the page shows **Live mode is on** and the button is enabled
- [ ] Deterministic regtest: every run uses a fresh network and the same channel sizes, but fees and timings vary a little per run: read every number off the screen, do not quote from memory
- [ ] Backup state before the take: none needed; the drill creates its own
- [ ] Recovery state after the take: `npm run demo:reset` again

## Recording

- [ ] Record the screen at 30 fps, system audio off
- [ ] Voice-over recorded separately from `video-script.md` in a quiet room; do a level check
- [ ] Do the drill button click once per take; the drill takes about 40 s, so the middle of the script is timed against it
- [ ] Record the Security and Limits sections as separate short takes
- [ ] Keep the cursor slow and visible; no window shaking

## Editing

- [ ] Total 90 to 150 seconds; trim waiting time, but do not fast-forward the drill so that timings look different from the numbers on screen
- [ ] Captions for spoken numbers; no music unless you own or license it
- [ ] No third-party footage, logos or stock clips
- [ ] Watch the final cut once with sound off (captions carry it) and once on a phone-sized player
- [ ] Do not upload anywhere until the owner approves

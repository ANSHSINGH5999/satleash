# Lifeboat: submission package

Status: **prepared locally and not submitted to Devfolio** (the repository and the landing page are published; see `FINAL_PROJECT_STATUS.md`). Everything here links to the maintained documents instead of copying them.

**Lifeboat is a TypeScript daemon and console that lets a self-hosted LND operator recover channel funds from the 24-word seed and a known relay URL, with no other secret or key file, by publishing encrypted static channel backups to Nostr relays and verifying them against the live node before they are needed.**

| Item | File |
|---|---|
| Submission copy (Devfolio fields) | [devfolio-submission.md](devfolio-submission.md) |
| Demo script (2 to 3 min) | [demo-script.md](demo-script.md) |
| Technical story | [technical-story.md](technical-story.md) |
| Architecture | [architecture.md](architecture.md) |
| Security | [security.md](security.md) |
| Differentiation | [differentiation.md](differentiation.md) |
| Track positioning | [track-positioning.md](track-positioning.md) |
| Video script | [video-script.md](video-script.md) |
| Screenshots | [screenshots.md](screenshots.md), images in [../screenshots/](../screenshots/) |
| Test results (actual output) | [test-results.md](test-results.md) |
| Everything else | [../README.md](../README.md), [../FINAL_PROJECT_STATUS.md](../FINAL_PROJECT_STATUS.md), [../docs/](../docs/) |

## Before submitting (needs the owner)

1. License: MIT chosen and added (`LICENSE`; comparison in [../docs/license-decision.md](../docs/license-decision.md)).
2. Repository: public at https://github.com/ANSHSINGH5999/lifeboat; its URL is in the README and in `devfolio-submission.md`. The landing page is hosted at https://boss-battle-psi.vercel.app; the recovery drill itself is local (Docker, regtest).
3. Done: GitHub Actions was rerun after the fixes were pushed and passed (run 35503145035 on commit `0cb7a92`). The subsequent documentation-only commit `56f2d5d` also passed (run 35504042620). The earlier runs on `346215c` and `0127152` were red and were fixed.
4. Record the video with [../docs/video-checklist.md](../docs/video-checklist.md) and add its URL.
5. Re-read the live BOSS Battle gallery for overlap and re-check the numbers against the final take.
6. Submit on Devfolio yourself. Nothing has been submitted.

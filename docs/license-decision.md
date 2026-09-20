# License decision

**Status: decided 2026-09-20: MIT, see `/LICENSE`.** The comparison below is kept as the record of the options. `package.json` has `"private": true` and no `license` field. This page is a comparison to help the owner decide; it is not legal advice, and the choice (and any hackathon-rule check) is the owner's.

## What is known about this project

- Direct and transitive **runtime** dependencies are all permissive: MIT (`@noble/*`, `@scure/*`, `ws`, `nostr-wasm`) and Unlicense (`nostr-tools`). Dev-only: MIT (`tsx`, `@types/*`) and Apache-2.0 (`typescript`). Checked from the installed `package.json` files on 2026-09-20. Any option below is compatible with what Lifeboat ships today; nothing is bundled into a distributed artifact.
- Both pages load fonts from Google Fonts at runtime (not bundled).
- The hackathon overview page consulted on 2026-09-19 states no open-source or ownership requirement. Check the current rules before publishing.
- Without any license the default is "all rights reserved": people may read a public repository but have no granted right to run, copy, modify or redistribute it.

## Comparison

| License | What it permits | What it requires | Commercial use | Modification | Redistribution | Attribution | Patent considerations | Main trade-offs |
|---|---|---|---|---|---|---|---|---|
| **MIT** | Use, copy, modify, merge, publish, distribute, sublicense, sell | Keep the copyright and licence notice | Yes | Yes, no obligation to share changes | Yes, source or binary | Required (notice kept) | No express patent grant | Shortest and most widely accepted; maximum adoption; no copyleft, no patent protection |
| **Apache-2.0** | Same as MIT | Keep licence and notices, mark changed files, keep the `NOTICE` file | Yes | Yes, no obligation to share changes | Yes | Required (notices) | **Express patent grant** from contributors, ending for anyone who sues over patents in the work | Longer text; patent clarity; not compatible with GPL-2.0-only (compatible with GPL-3.0) |
| **BSD-3-Clause** | Same as MIT | Keep notice; do not use the author's name to endorse derived products | Yes | Yes | Yes | Required | No express patent grant | Like MIT plus a no-endorsement clause |
| **MPL-2.0** | Use, modify, distribute | Changes to MPL-covered **files** must be shared under MPL; the rest of a combined work can stay under other terms | Yes | Yes, with file-level sharing | Yes | Required | Express patent grant | File-level copyleft: keeps improvements to these files open without infecting whole products; less familiar to many developers |
| **GPL-3.0** | Use, modify, distribute | Distributed derivatives must be GPL-3.0 with source available | Yes (sold copies must carry the same freedoms) | Yes; shared when distributed | Yes, under GPL-3.0 | Required | Express patent grant | Strong copyleft keeps derivatives open; many companies will not embed it; incompatible with proprietary reuse |
| **AGPL-3.0** | As GPL-3.0 | As GPL-3.0, and users who interact with a modified version **over a network** must be offered its source | Yes | Yes | Yes | Required | Express patent grant | Closes the "run it as a service" gap. Lifeboat runs locally, so this matters less here; widest reluctance among adopters |
| **No license** | Reading only | n/a | Not granted | Not granted | Not granted | n/a | n/a | Others cannot legally build on it; hackathon judges can view but not run it under any granted right |

## Options worth considering

1. **MIT** if the goal is the simplest possible reuse: it is short, familiar, and the ecosystem this touches (Bitcoin and Lightning tooling, and this project's own dependencies) is largely MIT-licensed.
2. **Apache-2.0** if you want the same permissiveness plus an explicit patent grant and clearer contribution terms.
3. **MPL-2.0 or a GPL-family licence** only if keeping improvements open is a goal that outweighs easy adoption. AGPL is a poor fit for a local tool.

I do not recommend leaving it unlicensed if the aim is for judges and other developers to run and build on it.

## What to do once you decide

1. Add a `LICENSE` file with the licence text and your name and year, add `"license": "<SPDX id>"` to `package.json`, and drop `"private": true` only if you ever publish to npm (not needed for GitHub).
2. Mention it in the README (the Limitations list currently says "No license file yet": remove that line).
3. Nothing else in the repository depends on the choice.

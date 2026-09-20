# Landing page design

The landing hero and navigation follow a supplied hero design (a full-screen hero with a cursor-following spotlight that reveals a second layer through a soft circular mask), applied to Lifeboat with Lifeboat's own copy and art. This page records what was taken over, what was adapted, and what is known to fall short.

## Taken over from the design

- **Fonts:** Inter for the page, Playfair Display italic for the wordmark and the first headline line.
- **Layout:** full-screen (`100dvh`) black hero; centred two-line headline at 14 % from the top (line 1 italic serif, letter-spacing -0.05em; line 2 sans, -0.08em, sizes 3rem / 4.5rem / 6rem at the small / `sm` / `md` breakpoints); a paragraph bottom-left (from 640 px); a paragraph and an orange button bottom-right (full width on phones).
- **Navigation:** fixed, glass pill in the centre from 768 px (`bg white/20`, blur, `white/30` border), white pill button on the right, hamburger below 768 px.
- **Motion:** blur-rise for the headline (0.25 s and 0.42 s delays), fade-up for the paragraphs (0.7 s and 0.85 s), Ken Burns zoom-out on the base layer, all off under `prefers-reduced-motion`.
- **Cursor lens:** the second layer is visible only inside a soft circle of radius 260 px that trails the pointer (eased at 10 % per frame), with the design's gradient stops (opaque to 40 %, then 0.75, 0.4, 0.12, 0).
- **Orange button** `#e8702a` (hover `#d2611f`, scale 1.03, active 0.95).

## Adapted to Lifeboat

- **Art is self-drawn, not the design's photographs:** two canvases draw the same layered ridges, one dim with unreadable hex ("ciphertext"), one lit in orange and violet with plain labels (`seed`, `channel`, `relay`, `fingerprint`, `backup event`, `peer hint`). Moving the cursor "decrypts" what is under it. No numbers or metrics are drawn; nothing is loaded from a third party except the fonts.
- **Copy and logo** are Lifeboat's (a lifebuoy mark, not the design's logo). The nav links are Lifeboat's sections.
- **Mask implementation:** the lens uses a CSS `radial-gradient` mask driven by two custom properties instead of re-encoding a canvas to a PNG on every frame. The result is the same soft circle with the same stops and much cheaper (idle: no style writes; pointer moving: 59 fps at device pixel ratio 2 in headless Chrome).
- **Phones:** the headline size is `min(3rem, 10.6vw)` so "Back up your node." stays on one line at 320 to 390 px; labels that would sit under the phone layout's text are not drawn.
- **Scroll:** below the hero the nav gains a dark blur so it stays readable over the sections.
- The console (`/console`) keeps its own styling.

## Known shortfalls

- **Contrast:** white text on the design's orange (`#e8702a`) is **3.1 : 1**, below the 4.5 : 1 WCAG AA needs for 14 px text (the hover colour `#d2611f` is 3.84 : 1). Dark text (`#111827`) on that orange would be 5.73 : 1. The colour and white text were kept because they are the design; change them if AA matters more. The colour-variable contrast test in `ui.test.ts` covers the ink colours, not this button.
- Verified in Chrome only. The mask uses `mask-image` with a `-webkit-` prefix; Firefox and Safari were not tested.
- Touch: the lens follows a dragging finger only while the browser reports pointer events (it stops when the browser takes the drag as a scroll).

## Tests

`ui.test.ts` (landing hero test): both canvases are drawn (grey and warm pixels), no `img`/`video` elements, no third-party host except fonts, layer order (`10, 30, 50`), the mask is the 260 px radial gradient, the lens starts off-screen, trails a pointer jump and then settles on it and follows it elsewhere, the hero fits at 1280, 400 and 320 px with the right nav for each, and reduced motion shows everything at once.

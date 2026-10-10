# Tupelo Current: brand starter kit

Starter assets for **Tupelo Current**. They are drawn in the same cartoon family as The Vic 361 (ink outlines, sticker colors, Fredoka lettering), with this town's own palette and motifs. Every file in `public/` overrides Victoria's copy in `docs/` through `townAssetPath()` and the static overlay.

## Concept

"First TVA City": a neon-amber lightning bolt on a night-navy sticker over a black-gum green hill. The skyline runs along Main Street (asphalt with an amber center line) past a cone-roofed water tower with a bolt on its tank, two-story brick storefronts, the Lee County courthouse dome and portico, and the downtown neon arrow sign reading TUPELO. Out of town: TVA lattice towers, utility poles and power lines, and black gum trees (green, plus a few in their autumn red). The night version lights the windows and the arrow, adds a moon, stars and fireflies. og-image.png is the night scene (navy), which suits the night-glow palette. No Elvis imagery.

Header wordmark (two-tone, for `siteNameHtml` in town.json): `Tupelo <span>Current</span>`. The span is the tilted badge, filled with the `highlight` color.

## Palette

```json
{
  "primary": "#2A46B0",
  "accent": "#2B7A4B",
  "paper": "#FFF6E2",
  "ink": "#141A3A",
  "highlight": "#FFB938"
}
```

| Role | Light | Dark mode | Use |
|---|---|---|---|
| primary | `#2A46B0` | `#8FA8FF` | links, buttons, title accent |
| accent | `#2B7A4B` | `#6FD49A` | hover underline, secondary highlights |
| paper | `#FFF6E2` | `#111733` (bg), `#1C2448` (surface) | page background |
| ink | `#141A3A` | `#05071A` (outlines/shadows), `#F4F1FF` (text) | text, outlines, offset shadows |
| highlight | `#FFB938` | `#FFC24F` | the paid label ("Spotlight"), title badge, hero marker |

Dark-mode JSON:

```json
{
  "primary": "#8FA8FF",
  "accent": "#6FD49A",
  "paper": "#111733",
  "surface": "#1C2448",
  "ink": "#05071A",
  "text": "#F4F1FF",
  "highlight": "#FFC24F"
}
```

Contrast: primary on paper is at least 4.5:1, ink on highlight is at least 7:1, and the dark-mode primary on its background is at least 7:1.

Illustration colors (skyline and logo only):

- night navy #24306B (logo disc, roofs)
- neon amber #FFB938 / light #FFD978 (bolt, sun, arrow sign, lit windows)
- black-gum green #3E9B5F, hills #93D0A2, autumn gum red #D2483E
- brick #D9714E, cream #F7E8C8, sky blue #7FC1F2
- street asphalt #4A5274

## Files

| File | Size | Used by |
|---|---|---|
| `public/logo.svg` | 128 viewBox | share cards (`server/ogImage.js`, embedded as a data URI); text is converted to paths, so it needs no fonts |
| `public/logo.png` | 96x96 | header logo, light theme (shown at 48 to 54px, clipped round) |
| `public/logo-dark.png` | 96x96 | header logo, dark theme (adds a paper-colored halo so the ink ring shows on a dark header) |
| `public/logo-512.png` | 512x512 | schema.org Organization `logo` (`server/seo.js`) |
| `public/favicon.svg` | 64 viewBox | `<link rel=icon>` (simplified mark) |
| `public/favicon-32.png` | 32x32 | PNG favicon fallback |
| `public/favicon.ico` | 16, 32, 48 | `/favicon.ico` requests |
| `public/apple-touch-icon.png` | 180x180 | iOS home screen (opaque, paper background) |
| `public/og-image.png` | 1200x630 | site-wide og:image / twitter:image |
| `public/skyline.svg` | viewBox -800 0 2800 260 | hero art and footer (day); the town sits in x 0 to 1200, with countryside on either side |
| `public/skyline-night.svg` | same | hero art and footer (dark theme) |
| `public/email/skyline.png` | 1200x260 | newsletter header (`server/newsletter.js`) |

Not overridden, because they are shared and generic: `icons.svg` and the `email/*.png` category icons (food, music and the rest), plus `sample-logo.svg`. Victoria's `outdoors` icon is a cactus, which reads as Texan; a town could add its own `email/outdoors.png` (48x48) and a matching symbol later if that matters.

## Notes

- Lettering in every SVG (the sign and tank lettering in the skylines) is outlined to paths from `server/fonts/Fredoka-Bold.ttf`, so it renders the same in an `<img>`, in resvg share cards and in email, with no font loading.
- The PNGs were rasterized from the SVGs with Playwright (Chromium), and the `.ico` was built from the 16, 32 and 48px renders.

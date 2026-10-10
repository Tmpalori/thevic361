# Shoals Setlist: brand starter kit

Starter assets for **Shoals Setlist**. They are drawn in the same cartoon family as The Vic 361 (ink outlines, sticker colors, Fredoka lettering), with this town's own palette and motifs. Every file in `public/` overrides Victoria's copy in `docs/` through `townAssetPath()` and the static overlay.

## Concept

A 1970s studio-era 45 on a cream sticker: walnut-black vinyl, a rust label, a mustard 45 rpm adapter, and a strip of gaffer tape with a scribbled setlist. The og-image badge is a mustard gaffer-tape strip with torn ends rather than a rounded pill. The skyline follows the Tennessee River in slate blue: a riverfront observation tower, Court Street storefronts, a theater blade sign spelling SHOALS, and a cinder-block recording studio with a 45 on the wall. Out of town: Wilson Dam's arched spillway on the left and the O'Neal Bridge's rust-colored truss arches on the right. No UNA purple and gold.

Header wordmark (two-tone, for `siteNameHtml` in town.json): `Shoals <span>Setlist</span>`. The span is the tilted badge, filled with the `highlight` color.

## Palette

```json
{
  "primary": "#3D5C78",
  "accent": "#B04A20",
  "paper": "#F7EDD6",
  "ink": "#2A1E17",
  "highlight": "#E5A82E"
}
```

| Role | Light | Dark mode | Use |
|---|---|---|---|
| primary | `#3D5C78` | `#93B4D2` | links, buttons, title accent |
| accent | `#B04A20` | `#F08A5D` | hover underline, secondary highlights |
| paper | `#F7EDD6` | `#1C1612` (bg), `#2A211B` (surface) | page background |
| ink | `#2A1E17` | `#0B0705` (outlines/shadows), `#F7EEDF` (text) | text, outlines, offset shadows |
| highlight | `#E5A82E` | `#F0BC4A` | the paid label ("Headliner"), title badge, hero marker |

Dark-mode JSON:

```json
{
  "primary": "#93B4D2",
  "accent": "#F08A5D",
  "paper": "#1C1612",
  "surface": "#2A211B",
  "ink": "#0B0705",
  "text": "#F7EEDF",
  "highlight": "#F0BC4A"
}
```

Contrast: primary on paper is at least 4.5:1, ink on highlight is at least 7:1, and the dark-mode primary on its background is at least 7:1.

Illustration colors (skyline and logo only):

- river slate #4C6A85 / light #9DB8CF
- rust #C4562B / light #E58A5E
- mustard tape-reel gold #E5A82E / light #F3CB6B
- cream #F6EBD3, walnut #6B4A34, vinyl #2E2622
- dam/cinder block #DCD3C2, hills #B3C98F

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

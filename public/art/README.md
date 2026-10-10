# Runtime art assets

Current gameplay skin: `floating-world-v1/` — the 「浮空积木世界」 pack (**v0.13.0**), which owns the
sky, the plaza, the scenery models, the clouds, the brand and every UI plate and glyph. Its
`manifest.json` is the resource manifest and `scene.recipe.json` the world recipe.

## What was deleted, and why (v0.13.0 §4.1 / §5.2)

Three retired skins used to live here. Their pieces were still being **shipped** even though nothing
referenced them: a built `dist` was **3544.6 KB of retired art out of 5934.8 KB — 59.7% of the deployed
bytes** — and the page requested exactly one retired file. The handoff §4.1 asks for the old art to
exit the picture, and §5.2 for the old declarations to stop competing, so the cutover was completed in
two steps: the CSS references were deleted first (§5.2), then this global usage list was built and the
files removed.

| Deleted | What it was | Why it was safe |
| --- | --- | --- |
| `reference/` — 18 of 19 files (2557.6 KB) | v0.8.27 reference garden skin: generated UI cutouts, the score plaque, the tool PNGs, both valley compositions, `ui-atlas.webp` | zero references in `src/`, `tools/`, `index.html` |
| `ui-redesign/` — all 26 files (986.9 KB) | v0.9.26 cover / settings skin: three nine-slice plates, the settings card and rows, the toggles, `close-button`, the six row glyphs, the HUD crown / trophy | same; `npm run probe:ui-paint` scans every visible element in four states for `/art/ui-redesign/` and reports 0 |
| `pastoral-valley.webp` (316.4 KB) | the v0.7 valley painting, loaded by `rendering/pastoralBackdrop.js` | that module had zero imports and was deleted too |
| `reference/README.md`, `reference/prompts.json`, `reference/slices.json`, `ui-redesign/README.md` | generation metadata for the above | dev documentation, but it was being deployed to the CDN |

**Kept on purpose** (both are still referenced, so deleting them would be the bug, not the cleanup):

- `reference/pedestal.webp` — `index.html`'s hidden `<img class="garden-pedestal">`. It is the only
  retired asset the shipped page still requests, and it is kept because
  `tools/material-grounding-probe.mjs`'s `g1b-art-*` routes read `pedestalArt` from it. See the
  acceptance receipt §4.1 — removing it is a producer call, not a cleanup.
- `block-pigment.webp` — still the painted surface on every cube (and, since v0.8.20, on CSS button
  faces). Documented below and live.

Everything deleted here is in git history; the receipts in `docs/Technical/` describe what each pack
looked like.

## Block pigment surface — v0.8.18

- Runtime asset: `block-pigment.webp`, 768 × 768, 26,764 bytes.
- Created 2026-09-21 using the built-in `image_gen.imagegen` reference-image workflow (not a direct external API call). User reference: `codex-clipboard-7a701ff7-ca40-419d-83ff-416b601b81d8.png`, inspected locally and passed through `referenced_image_paths`.
- Original remains in the tool's generated-images directory as `exec-f110a4ec-7174-446d-8186-46b663233750.png`. The requested size was 1024 × 1024; the tool returned 1254 × 1254. Runtime conversion uses Sharp resize to 768 × 768 and WebP quality 90, without repainting.
- The image supplies neutral brushwork only. Runtime removes its colour cast and mean brightness, creates three deterministic crops/rotations, and tints them using existing material colours. Height and roughness remain separate from the painted albedo. Lighting, glints, geometry and shadows are real-time; the reference screenshot is not shipped.
- Loaded from Vite's base URL. Procedural surfaces remain available while loading or after failure; no runtime image-generation service is required.
- Since v0.8.20 the same small pigment asset also supplies subtle brushwork on CSS button faces, underneath translucent gradients; button frames and icons remain CSS/SVG.

Prompt:

```text
Create a production game texture asset inspired ONLY by the subtle painterly surface of the wooden and lacquered cubes in the supplied reference. Output ONE square 1024x1024 flat, edge-to-edge, seamless material texture, viewed perfectly straight on. Monochrome grayscale, very light ivory-gray overall (average value about 220/255). A refined hand-painted maple / lacquer underpainting: broad overlapping irregular polygonal brush washes, softly angular translucent pigment patches, sparse softly flowing maple growth contours. Medium-scale shapes should be readable even reduced to 64 pixels. Very subtle pores; no dense fibers, no scratches, no cracks, no long parallel stripes. Restrained variation from light gray to near-white, avoid pure black. NO actual cube, NO bevel, NO border, NO grid, NO lighting or reflections, NO shadows, NO perspective, NO background scenery, NO UI, NO text. This is unlit albedo pigment only, to be tinted with saturated colors and illuminated by real-time 3D lights. Painterly polished premium casual mobile game art, matching the reference block surfaces rather than photoreal wood.
```

## Pastoral valley background

- Runtime asset: `pastoral-valley.webp` (1672 × 941 px, approximately 16:9; 324,012 bytes).
- Created on 2026-09-16 with Codex's built-in `image_gen.imagegen` tool.
- Reference handling: the user's first screenshot was viewed locally and supplied through `referenced_image_paths` as a painting/style reference. The call used the built-in reference-image workflow, conceptually the `images/edits` route, rather than a direct external API request.
- Reference: `codex-clipboard-2ef6d5e6-d928-4b32-862e-07bbf437ae8d.png`. No reference screenshot is required at runtime.
- Generated PNG is preserved locally at `artifacts/imagegen/pastoral-valley-source.png` (the artifacts directory is git-ignored). Its original tool output remains in the Codex generated-images directory.
- Runtime WebP is a format-only conversion at quality 88; there is no crop, resizing, compositing, or generated modification after the image tool.
- The requested ideal size was 2048 × 1152. The built-in tool selected 1672 × 941; the returned resolution is used unchanged.

## Integration

`src/rendering/pastoralBackdrop.js` loads the asset through Vite's `import.meta.env.BASE_URL`. The image fills the existing decorative backdrop using centered `object-fit: cover`, so landscape and phone layouts share the same asset. The original inline SVG stays visible until successful image loading and remains the fallback on load failure. The background never captures pointer or keyboard input.

## Final prompt

```text
Use case: illustration-story
Asset type: production background painting for a cozy 3D block puzzle game, landscape 16:9, ideally 2048x1152.
Input image: use the supplied screenshot ONLY as a visual reference for the countryside painting, atmosphere, palette and craftsmanship. All game objects and interface in that screenshot must be removed.
Primary request: paint a beautiful empty sunlit pastoral valley scene suitable as the full-screen background behind a realtime 3D puzzle board. Soft painterly gouache and detailed storybook environment art, premium cozy casual game finish, rich but controlled brushwork.
Scene: warm green rolling hills and a distant tiny village with terracotta rooftops and one slender church tower on the right. A winding pale-blue creek and small stone bridge in the lower valley. Weathered timber fence, white daisies, grasses and small wildflowers in the lower corners. A broad oak trunk along the far left edge, with sunlit leafy branches framing the top corners. Airy pale blue sky and a few luminous cream clouds.
Composition: wide landscape, horizon around the lower half. The entire central 45% of the image from top to bottom must be calm and low contrast: open sky and gently atmospheric distant valley for a large 3D block puzzle overlay. Keep high detail, darkest greens, branches, flowers, fence and village toward the outer edges and bottom; do not draw a focal object in the center. The center crop should remain pleasant on a tall phone screen. No empty white or transparent area: complete environmental painting all the way through the center.
Lighting: gentle warm sunshine from upper left, cool soft atmospheric depth in mountains, bright inviting spring afternoon.
Constraints: environment only. Absolutely NO cubes, blocks, puzzle board, pedestal, game pieces, UI, panels, frames, buttons, icons, numbers, letters, words, score, arrows, glows, floating objects, characters, people, logos or watermark. Do not recreate the screenshot's interface. No hard vector shapes, no flat clipart, no photorealism.
```

## Cartoon clear sprite atlas — v0.13.3

- Runtime assets: `cartoon-clear-v1/atlas.png` (512 × 256, 4 × 2 tiles of 128 × 128, 53,431 bytes) and
  `cartoon-clear-v1/atlas.json` (5,650 bytes). Together 59,081 bytes, inside the handoff §7.2 100KiB budget.
- Eight tiles, numbered from the PNG top-left: `confetti-blue`, `confetti-teal`, `confetti-pink`,
  `star-pop` (top row) and `sparkle-cream`, `dot-blue`, `swoosh-cream`, `dash-blue` (bottom row).
  The order is the atlas JSON own `layout.order`; the runtime reads each tile index from there.
- Authored as editable SVGs and rasterised by `tools/build-cartoon-clear-assets.py`; the sources, the
  reference storyboards, the preview sheet and the check report stay in `docs/assets/cartoon-clear-v1/`
  and are NOT deployed here (handoff §3.1).
- Sampling contract: sRGB, `flipY=true`, no mipmaps, `LinearFilter`, `ClampToEdge`, straight
  (unassociated) alpha, white modulation, `NormalBlending`, `depthTest=true`, `depthWrite=false`.
- `swoosh-cream` and `dash-blue` are authored pointing +X; the runtime rotates them to the screen
  angle of their own direction.
- Loaded from the Vite base URL by `rendering/effects.js`. While it loads, or if it fails, the clear
  draws procedural quads and the game stays playable: the atlas never blocks a move.

# Runtime art assets

Current gameplay skin: [v0.8.27 reference garden assets](reference/README.md), including generated UI cutouts, two background compositions, and the transparent stone pedestal. The older assets below remain available for fallback/legacy surfaces.

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

# Pastoral UI redesign assets (v0.9.26)

Runtime skin for the home cover, the settings panel and the two HUD score icons. Sliced from
the approved concept art handed over in `temp/ui-redesign-handoff-20260929/`
(handoff guide: `JEFFY_INTEGRATION.md`, per-asset coordinates and masks: that pack's
`manifest.json` / `manifests/*.json`).

## What is here and what is NOT

These PNGs are **cut-outs of flat GPT-generated concept art, not exports of a layered
PSD/Figma project**. The handoff pack says so itself and this directory does not claim
otherwise:

- **Icons / brand art** — cut from the final concept renders and separated from their
  background with an outline mask, producing RGBA.
- **Text-free panels / buttons** — the original border and material are kept; where a label
  or icon covered the fill, that band was repaired from a clean band of the same component.
  Stretchable end caps that were hidden behind flower decoration were rebuilt in the same
  style.
- **Derived states** — `toggle-off.png` is derived from the ON track and knob.
- **Backgrounds** — this pack ships copies of the two `valley-*.webp` paintings that already
  live in `public/art/reference/` (byte-identical, verified by SHA-256). The runtime keeps
  loading the existing files; nothing was regenerated and no pixel that the concept art hid
  behind its UI was "restored".

The concept renders themselves (`references/*.png` in the handoff pack) are design references
only and are deliberately **not** copied here: loading one as a screen background would paint
a second copy of the numbers, labels and buttons on top of the live DOM ones.

## Not delivered by the pack (do not fake it here)

- **No standalone daisy / leaf corner ornament.** In the flat renders those decorations
  overlap the frames, so they cannot be separated into reusable pieces.
  `settings-modal.png` is the clean, ornament-free stretchable version. Four ornamented
  corners need newly drawn art or separate ornament source files.
- **`home-crown-large.png` is assembly-only**, not a standalone prop: its bottom edge was
  covered by the record board, so that cut edge must stay joined to / slightly overlapping
  the top edge of `home-record.png`.
- `score-panel.png` (1181×619) from the pack is **not** adopted yet — see KNOWN_GAPS.

## Files

`icons/` — transparent glyphs and the brand lockup.

| file | used by |
|---|---|
| `logo-voxalblast.png` | home brand lockup (`#home-title` keeps the accessible name) |
| `home-crown-large.png` | home best-score crown (assembly-only, see above) |
| `nav-crown-small.png` | home leaderboard button |
| `hud-crown-best.png` | `.best-chip::before` (BEST) |
| `hud-trophy-score.png` | `.score-chip::before` (SCORE) |
| `gear-purple.png` | home settings button |
| `play-triangle.png` | home primary action |
| `plus-gold.png` | home 新游戏 action |
| `settings-speaker.png` `settings-vibration.png` `settings-turn.png` `settings-book.png` `settings-home.png` `settings-restart.png` | the matching settings rows |

`panels/` — text-free panels, buttons and switch states.

**The slices below are the ones `src/reference.css` actually draws with**, in source PNG
pixels. They are deliberately *not* the manifest's `nineSliceTRBL`: the manifest reports the
band where the material ends, the skin slices on the **corner radius**, which is roughly twice
the band. A single `border-width` can honour only one of the two — sized for the band the
corners go square, sized for the radius the frame reads as a double line — so the card splits
`border-width` (layout inset) from `border-image-width` (where the art is drawn) and slices on
the radius. Treat the manifest values as the pack's recommendation, not as shipped geometry.

| file | size | how it is drawn | used by |
|---|---|---|---|
| `home-primary.png` | 675×194 | nine-slice **65** all sides, `border-width: 1em` | `#home-primary` |
| `home-secondary.png` | 674×155 | nine-slice **51** all sides, `border-width: 1em` | `#home-new` (the second run action — NOT the `.home-secondary` class) |
| `home-nav.png` | 358×156 | nine-slice **51** all sides, `border-width: 1em` | `#home-leaderboard`, `#home-settings` |
| `home-record.png` | 441×220 | not sliced: `aspect-ratio: 441 / 220`, background `100% 100%` | home best-score plate |
| `settings-modal.png` | 776×1148 | nine-slice **56**, `border-width: 1.2em` / `border-image-width: 1.35em` | `.settings-card` frame |
| `settings-row.png` | 682×139 | nine-slice **38**, `border-width: .55em` / `border-image-width: .95em` | `.setting-row` |
| `settings-danger.png` | 682×139 | same rule as `settings-row` (shares the selector) | `#restart-setting` |
| `toggle-on.png` | 121×71 | background `contain`, never nine-slice | switch ON |
| `toggle-off.png` | 121×71 | background `contain` | switch OFF |
| `close-button.png` | 101×109 | background `contain` | settings close (already contains a static X; see mask cleanup below) |
| `keyboard-hint.png` | 183×50 | background `100% 100%`, never nine-slice | the `W A S D Q E` / language pill — it is a FULL pill (radius = half its height) and slicing it would flatten the caps |

Not copied from the pack, because nothing uses them: `panels/toggle-thumb.png` (only needed
for a hand-built track animation) and `icons/settings-close-x.png` (mutually exclusive with
the complete `close-button.png` that was chosen).

### Post-slice mask cleanup (not part of the pack)

Two files are **the pack's slice plus a background-removal pass**, applied by the committed
`tools/ui-skin-mask-clean.py`. Nothing was painted and no occluded pixel was "restored" —
the pack's outline mask had simply kept slivers of the *concept render's own background*:

| file | what was removed |
|---|---|
| `close-button.png` | 258 px of the render's green foliage, welded to the outside of the medallion's gold ring at its lower-right. Visible on a real phone as a green smudge, and it also deformed the button's `drop-shadow` (a CSS drop shadow is traced from the alpha channel). The pass now keeps only the connected component containing the medallion. |
| `settings-modal.png` | 839 px of green along the frame's outer edge (a 1-px-tall strip on the bottom border). The horizontal `stretch` then smears that along the entire bottom edge of the card. Only pixels within 8 px of the canvas edge are touched. |

**If the pack is ever re-sliced, re-run that tool** or both fringes come back. Verify with
`python tools/ui-skin-fringe-audit.py`; it must report no green clusters on any panel listed
as ornament-free.

### Known remaining artifacts (measured, not fixed)

- **Repair seam in the frame's top band.** `settings-modal.png`'s top stretch band was
  rebuilt from a clean band of the same component. There is one isolated ~8.5-luminance step
  at source **x ≈ 154**; every neighbouring column moves ≤0.2. The never-repaired bottom band
  shows no such step, so this is a real seam rather than noise, and the horizontal stretch
  carries it across the card's top edge. It is subtle (~4% on a ~213-luminance band).
  Blending it out means repainting art, so it is reported rather than silently patched.
- **A ~2 px notch** on the medallion's lower-right arc, where the foliage that was removed had
  been drawn *over* the gold edge. At the button's rendered 41×44 px this is under a pixel.
  Filling it would mean inventing gold that the concept render never showed.

Every label, score, `BEST` / `SCORE` word, language name and keycap is **live DOM text**. Only
`close-button.png` carries a baked glyph (the X), and that is intentional: the button keeps its
translated `aria-label` and does not stack a second `×`.

## Regenerating

Re-slicing needs Python 3 + Pillow and is done from the handoff pack, never over these
outputs:

```powershell
python temp/ui-redesign-handoff-20260929/tools/slice_icons.py
python temp/ui-redesign-handoff-20260929/tools/slice_panels.py
python temp/ui-redesign-handoff-20260929/tools/validate_package.py
```

Then copy the files this directory actually lists. The pack is `.gitignore`d, so treat it as a
build input, not as the shipped source of truth.

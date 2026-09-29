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

`panels/` — text-free panels, buttons and switch states. `nineSliceTRBL` values come from the
handoff manifest and are in **source PNG pixels**:

| file | size | nine-slice (T,R,B,L) | used by |
|---|---|---|---|
| `home-primary.png` | 675×194 | 78, 82, 78, 82 | `#home-primary` |
| `home-secondary.png` | 674×155 | 65, 80, 65, 80 | `#home-new` (the second run action — NOT the `.home-secondary` class) |
| `home-nav.png` | 358×156 | 62, 70, 62, 70 | `#home-leaderboard`, `#home-settings` |
| `home-record.png` | 441×220 | fixed aspect ratio | home best-score plate |
| `settings-modal.png` | 776×1148 | 76, 76, 76, 76 | `.settings-card` frame |
| `settings-row.png` | 682×139 | 43, 48, 43, 48 | `.setting-row` |
| `settings-danger.png` | 682×139 | 43, 48, 43, 48 | `#restart-setting` |
| `toggle-on.png` | 121×71 | uniform scale, never nine-slice | switch ON |
| `toggle-off.png` | 121×71 | uniform scale | switch OFF |
| `close-button.png` | 101×109 | uniform scale | settings close (already contains a static X) |
| `keyboard-hint.png` | 183×50 | 20, 25, 20, 25 | the `W A S D Q E` pill |

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

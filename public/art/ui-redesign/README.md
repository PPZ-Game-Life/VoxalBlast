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
  style. (The shipped `settings-modal.png` no longer uses the pack's band repair, or its
  two-piece home record either — see **Post-slice repairs** below.)
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
- **The home high-score decoration is ONE module, not a crown plus a plate.**
  `panels/home-record.png` is the crown, the frame and all four flower clusters cut as a single
  transparent piece (481×415) by `tools/ui-skin-home-record.py`. The pack's two separate cuts
  could not be re-joined: the concept puts the crown's base *behind* the frame, so
  `icons/home-crown-large.png` ends in a flat cut that only stays hidden while something else
  overlaps it, and a regular rounded mask chops the flowers that stick out past the frame. The
  crown file is still shipped (it is the pack's approved cut) but **nothing draws it**.
- `score-panel.png` (1181×619) from the pack is **not** adopted yet — see KNOWN_GAPS.

## Files

`icons/` — transparent glyphs and the brand lockup.

| file | used by |
|---|---|
| `logo-voxalblast.png` | home brand lockup (`#home-title` keeps the accessible name) |
| `home-crown-large.png` | retained from the pack (approved cut) but **not drawn by anything**: the home crown ships inside `panels/home-record.png`, see above |
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
| `home-record.png` | 481×415 | not sliced: the whole module is drawn at `aspect-ratio: 481 / 415`, with `Best` / the live number as DOM text over its face (`.home-record-face`) | home best-score crown + frame + flowers (ONE module) |
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

### Post-slice repairs (not part of the pack)

Three committed tools turn the pack's slices into what this directory ships. Two of them are
**background removal / reconstruction of the pack's own repair work** — nothing was painted and no
occluded pixel was "restored":

| tool | what it does |
|---|---|
| `tools/ui-skin-mask-clean.py` | removes concept-render background the pack's outline mask left welded to two panels: 258 px of green foliage outside `close-button.png`'s gold ring (visible on a phone as a green smudge, and it also deformed the button's `drop-shadow`, which CSS traces from the alpha channel — the pass keeps only the component containing the medallion), and 839 px of green along `settings-modal.png`'s outer edge, cleared only within 8 px of the canvas edge. |
| `tools/ui-skin-home-record.py` | rebuilds `panels/home-record.png` as one crown+frame+flowers module from the concept's real silhouette (handoff §4), instead of a rounded-mask plate plus a flat-cut crown. |
| `tools/ui-skin-settings-face.py` | repairs `settings-modal.png`'s inner face (handoff §5). The pack filled it with a per-row colour sampled from an 8px strip at window x 32..40 — a strip that sits **inside the frame's own gold band** wherever the band is thick, i.e. at the top and bottom of the card, which printed a gold stripe across both ends and left rectangular patch edges. This re-derives the face colour per row from the concept (a median across the face, so the concept's own title, rows and red button cannot win), composites it through a feathered inner-face mask that never touches the band, and spreads the pack's 155×56 mirror joint at x=155 (a 24-luminance step on the top band) into a ramp. |

**If the pack is ever re-sliced, re-run all three** or the fringes, the two-piece crown and the
gold stripes come back. Verify with `python tools/ui-skin-fringe-audit.py`; it must report no
green clusters on any panel listed as ornament-free.

### Known remaining artifacts (measured, not fixed)

- **Lighting asymmetry around the card's mirror patches.** The pack took the concept's daisy off
  the card's top-left corner by pasting a mirrored 155×56 block from the top-right, and took the
  foliage off the right column by pasting a mirrored 44px-wide strip of the left column. The
  hard joints are gone (see above), but the pasted regions still carry the *other side's*
  lighting: the frame's band gradient on the right is the left band's, mirrored. The pack had no
  clean source for those pixels, so the honest fix is newly drawn corner art, not a filter.
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

# ...then the two repairs this directory owns, in this order:
python tools/ui-skin-home-record.py --proof     # panels/home-record.png becomes one module
python tools/ui-skin-settings-face.py --proof   # settings-modal.png's inner face
python tools/ui-skin-mask-clean.py --write      # green fringes on close-button / settings-modal
python tools/ui-skin-fringe-audit.py            # must report no green on clean panels
```

Then copy the files this directory actually lists. `slice_icons.py` / `slice_panels.py` overwrite
`home-record.png` and `settings-modal.png` with the pack's old cuts, so the repairs are not
optional: without them the home crown is a separate flat-cut prop again and the card gets its gold
stripes back.

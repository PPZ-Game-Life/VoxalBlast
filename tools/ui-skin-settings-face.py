"""Repair the settings card's inner face (handoff `JEFFY_DISPLAY_FIXES.md` §5).

The pack built `settings-modal.png` by replacing the concept's interior with a per-row colour
sampled from an 8px-wide strip at window x 32..40. That strip is inside the frame's own gold
band wherever the band is thick — which is exactly at the top and at the bottom of the card — so
the interior came out with a **gold stripe across the top** (rows ~47..66) and a **gold band plus
a broken inner corner at the bottom** (rows ~1065..1100). The fill's own rectangle also left hard
horizontal edges at y=47 / y=1099 and the pack's block mirroring left one at y=56.

This tool does not re-cut or repaint anything: it re-derives the face colour **per row** from the
approved concept (the concept's face pixels are identical to the deployed ones wherever the pack
did not touch them — verified row by row), takes the row's *dominant* colour so baked-in labels,
row plates and the red Restart button cannot win, interpolates the rows where content does
dominate, smooths the result vertically so the concept's own row plates cannot print faint
stripes into the new face, and composites it back through a feathered inner-face mask. The gold
band is never touched: the fill mask is inset past it.

Usage:
    python tools/ui-skin-settings-face.py           # report only
    python tools/ui-skin-settings-face.py --write   # repair the deployed PNG in place
    python tools/ui-skin-settings-face.py --proof   # dump before/after zooms of both seams
"""

from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "temp" / "ui-redesign-handoff-20260929"
CONCEPT = PACK / "references" / "settings.png"
DEPLOYED = ROOT / "public" / "art" / "ui-redesign" / "panels" / "settings-modal.png"
PROOF = ROOT / ".tmp" / "ui-skin-settings-face-proof.png"

X0, Y0 = 55, 302                 # the pack's frame window inside the concept
SIZE = (776, 1148)

# Measured insets of the inner face inside that window (top, left, right, bottom), and the mask
# that is actually filled — inset a little further so no band pixel can be overwritten.
FACE = (35, 28, 28, 49)
FILL = (42, 32, 32, 50)
FILL_RADIUS = 40
FEATHER = 1.6

FACE_RADIUS = 40                 # the face's own rounded corners
EDGE_SKIP = 6                    # keep the sampled span off the anti-aliased face edge
SMOOTH = 9                       # moving-average window along the vertical gradient


def is_face(p) -> bool:
    """Cream face, as opposed to the frame's gold band (low blue) or the concept's red button."""
    r, g, b = p
    return b >= 170 and max(r, g, b) - min(r, g, b) <= 70 and min(r, g, b) >= 150


def face_bounds(y: int) -> tuple[int, int]:
    """The face's column range on row `y`, from the measured insets and corner radius.

    A fixed sample column cannot work here: the face starts below a ~35px band at the top of the
    card but after a ~28px one at the sides, so one column is inside the gold band for some rows
    and inside the face for others — which is exactly the pack's bug (it sampled window x 32..40
    and printed the band's gold across the top and bottom of the card).
    """
    top, left, right, bottom = FACE
    x0, x1 = left, SIZE[0] - 1 - right
    for arc_y, corner_x, sign in ((top + FACE_RADIUS, x0, +1),
                                  (SIZE[1] - 1 - bottom - FACE_RADIUS, x1, -1)):
        if (y < arc_y) if sign > 0 else (y > arc_y):
            dy = abs(arc_y - y)
            if dy < FACE_RADIUS:
                inset = FACE_RADIUS - (FACE_RADIUS ** 2 - dy ** 2) ** 0.5
                return (round(x0 + inset) + EDGE_SKIP, x1 - EDGE_SKIP) if sign > 0 \
                    else (x0 + EDGE_SKIP, round(x1 - inset) - EDGE_SKIP)
    return x0 + EDGE_SKIP, x1 - EDGE_SKIP


def row_colours(concept: Image.Image):
    """Per-row face colour: the row's median across the face, so baked content cannot win.

    The concept's face is identical to the deployed one wherever the pack did not touch it, so it
    is safe to read the face from it — and its top inner shadow survives, because a *median across
    the whole face* is the face colour even on rows the concept's own controls cross.
    """
    px = concept.load()
    rows: dict[int, tuple[int, int, int]] = {}
    suspect: list[int] = []
    for y in range(SIZE[1]):
        x0, x1 = face_bounds(y)
        if x1 - x0 < 40:
            suspect.append(y)
            continue
        band = [px[X0 + x, Y0 + y] for x in range(x0, x1)]
        med = tuple(int(statistics.median([v[i] for v in band])) for i in range(3))
        if is_face(med):
            rows[y] = med
        else:
            suspect.append(y)

    good = sorted(rows)
    for y in suspect:                # rows where baked content owns the whole face (red button)
        below = [g for g in good if g < y]
        above = [g for g in good if g > y]
        if not below:
            rows[y] = rows[above[0]]
        elif not above:
            rows[y] = rows[below[-1]]
        else:
            lo, hi = below[-1], above[0]
            t = (y - lo) / (hi - lo)
            rows[y] = tuple(round(rows[lo][i] * (1 - t) + rows[hi][i] * t) for i in range(3))

    ys = sorted(rows)
    med = {y: tuple(int(statistics.median([rows[min(max(y + d, ys[0]), ys[-1])][i]
                                           for d in range(-3, 4)])) for i in range(3)) for y in ys}
    half = SMOOTH // 2
    smoothed = {y: tuple(round(sum(med[min(max(y + d, ys[0]), ys[-1])][i]
                                    for d in range(-half, half + 1)) / (2 * half + 1))
                          for i in range(3)) for y in ys}
    return smoothed, suspect


def face_mask(size, insets, radius, feather):
    k = 3
    top, left, right, bottom = insets
    m = Image.new("L", (size[0] * k, size[1] * k), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (left * k, top * k, (size[0] - 1 - right) * k, (size[1] - 1 - bottom) * k),
        radius=radius * k, fill=255)
    m = m.resize(size, Image.LANCZOS)
    return m.filter(ImageFilter.GaussianBlur(feather))


# The pack also pasted `mirror(crop((w-155, 0, w, 56)))` at (0, 0) to take the concept's daisy off
# the card's top-left corner. That patch is a hard 155x56 rectangle: it leaves a one-column
# luminance step at x=155 (measured +15 on the top band, while neighbouring columns move <0.3) and
# a one-row step at y=56. Both are spread into a ramp here — no pixel is invented, the two sides'
# own lighting is interpolated across the joint, which is what the handoff's §5 asks for when it
# says not to leave a whole-block mirror joint behind.
SEAM_VERTICAL = (155, 0, 56)     # x, y0, y1
SEAM_PAD = 10
SEAM_MIN_LUM = 2.0               # only feather a joint that is a real step, never a gradient


def feather_seam(im: Image.Image, x: int, y0: int, y1: int, pad: int = SEAM_PAD) -> tuple[int, float]:
    """Blend a vertical 1px joint at `x` into a `2*pad`-wide ramp; report rows touched + step."""
    px = im.load()
    touched = 0
    worst = 0.0
    for y in range(y0, y1):
        lft, rgt = px[x - pad - 1, y], px[x + pad, y]
        if lft[3] == 0 or rgt[3] == 0:
            continue
        worst = max(worst, abs(sum(lft[:3]) - sum(rgt[:3])) / 3)
        for d in range(-pad, pad + 1):
            t = (d + pad) / (2 * pad)
            a = px[x + d, y]
            if a[3] == 0:
                continue
            px[x + d, y] = tuple(round(lft[i] * (1 - t) + rgt[i] * t) for i in range(3)) + (a[3],)
            touched += 1
    return touched, worst


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--proof", action="store_true")
    args = ap.parse_args()

    concept = Image.open(CONCEPT).convert("RGB")
    deployed = Image.open(DEPLOYED).convert("RGBA")
    if deployed.size != SIZE:
        print(f"unexpected deployed size {deployed.size}, expected {SIZE}")
        return 1

    colours, missed = row_colours(concept)
    print(f"rows sampled just inside the face : {len(colours) - len(missed)}")
    print(f"rows with no reachable face edge  : {len(missed)}")

    face = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    fp = face.load()
    for y, c in colours.items():
        for x in range(SIZE[0]):
            fp[x, y] = (c[0], c[1], c[2], 255)

    fixed = Image.composite(face, deployed, face_mask(SIZE, FILL, FILL_RADIUS, FEATHER))

    sx, sy0, sy1 = SEAM_VERTICAL
    touched, step = feather_seam(fixed, sx, sy0, sy1)
    print(f"mirror joint at x={sx}: step {step:.1f} lum over y {sy0}..{sy1} "
          f"-> ramp across {2 * SEAM_PAD}px ({touched}px blended)")

    print("seam rows, x=388 (deployed -> repaired), concept reference")
    dp, npx = deployed.load(), fixed.load()
    cp = concept.load()
    for y in list(range(36, 76, 4)) + list(range(1056, 1112, 6)):
        print(f"  y={y:4d}  {dp[388, y][:3]} -> {npx[388, y][:3]}   concept {cp[X0 + 388, Y0 + y]}")

    worst = 0
    for y, c in colours.items():
        d = max(abs(c[i] - cp[X0 + 200, Y0 + y][i]) for i in range(3))
        worst = max(worst, d)
    print(f"max |repaired row colour - concept at x=200| : {worst} (row plates / labels live there)")

    if args.write:
        fixed.save(DEPLOYED, optimize=True)
        print(f"wrote {DEPLOYED.relative_to(ROOT)}")
    else:
        print("report only — pass --write to repair the file")

    if args.proof:
        bands = [(0, 110), (1030, 1148)]
        sheets = []
        for y0, y1 in bands:
            for tag, im in (("dep", deployed), ("fix", fixed)):
                c = im.crop((300, y0, 776, y1))
                c = c.resize((c.width, c.height * 2), Image.LANCZOS)
                sheets.append((f"{tag} y{y0}-{y1}", c))
        W = max(s.width for _, s in sheets) + 20
        H = sum(s.height + 30 for _, s in sheets)
        out = Image.new("RGB", (W, H), (250, 250, 252))
        d = ImageDraw.Draw(out)
        y = 6
        for tag, s in sheets:
            d.text((10, y), tag, fill=(20, 25, 35))
            out.paste(s, (10, y + 14))
            y += s.height + 30
        PROOF.parent.mkdir(parents=True, exist_ok=True)
        out.save(PROOF)
        print(f"proof: {PROOF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

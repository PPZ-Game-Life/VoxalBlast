"""Rebuild the home high-score decoration as ONE transparent module.

Why this tool exists
--------------------
The handoff pack sliced the home record as TWO pieces (`tools/slice_panels.py` +
`tools/slice_icons.py`): a 441x220 window cut with `rounded_mask(r=50)` for the frame, and a
separate window for the crown. Both cuts are wrong in ways CSS cannot repair (handoff
`JEFFY_DISPLAY_FIXES.md` §3/§4):

  * the concepts' flower clusters stick out past the frame's rounded silhouette, so the window
    and the regular rounded mask chop them;
  * the crown's base is *behind* the frame in the concept, so the crown's own window ends in a
    flat cut that is only hidden while some other element happens to overlap it — which is why
    the deployed build showed either a gap (desktop) or a mismatch (phone);
  * background pixels inside the frame's window survived the mask as a blue line under the
    bottom edge.

So this does not re-cut two fragments. It takes ONE region of the approved concept covering the
crown, the frame and every flower, and derives the alpha from the REAL silhouette: a
colour-tolerant grow from the border marks the scene, the blended ring the grow leaves behind is
peeled, and opening-by-reconstruction drops scene debris that is still wired to the art by a thin
bridge. Nothing is painted and no occluded pixel is invented — the crown's hidden base stays
hidden exactly as the concept hides it.

The label and the number baked into the concept are removed with the pack's own row-median
method, because they are live DOM text in the build.

Usage:
    python tools/ui-skin-home-record.py            # write the PNG
    python tools/ui-skin-home-record.py --proof    # also dump a checkerboard proof next to it

Regenerates `public/art/ui-redesign/panels/home-record.png` and prints the geometry that
`src/reference.css` encodes (`.home-record` box, `.home-record-face` insets).
"""

from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "temp" / "ui-redesign-handoff-20260929"
REF = PACK / "references" / "home.png"
DST = ROOT / "public" / "art" / "ui-redesign" / "panels" / "home-record.png"
PROOF = ROOT / ".tmp" / "ui-skin-home-record-proof.png"

# Generous window: the crown's top is at source y~534, the frame's bottom edge at y~934, and the
# flower clusters reach out to x~190 / x~675. Nothing of the decoration may touch this border.
BOX = (150, 500, 700, 960)
STEP_TOL = 14     # per-step channel tolerance for the background grow
PEEL_TOL = 48     # a border pixel this close to the scene colour is scene bleeding, not outline
PEEL_PASSES = 2
ERODE_R = 2       # opening radius (drops debris attached by a bridge thinner than 2*R)
ERODE_MIN = 24    # eroded pieces smaller than this are debris, not art
BUFFER = 2        # transparent border kept around the art

# The baked-in label + number, in the pack's own plate-crop coordinates (handoff
# `slice_panels.py` erased exactly this box). The module is built from a window that starts
# `OFFSET` px up/left of that plate crop, so the box moves by the same offset.
PLATE_CROP = (206, 716)                  # source top-left of the pack's 441x220 plate window
ERASE_IN_PLATE = (111, 34, 322, 194)     # label + number
ERASE_SAMPLE_IN_PLATE = (83, 96)         # clean vertical band of the same component
ERASE_FEATHER = 2


def erase_band(data, w, box, sample_x, feather=ERASE_FEATHER):
    """Replace lettering with a same-row median taken from an empty band of the same component.

    Same method (and the same source box) as the pack's `slice_panels.py:erase_band`, so the
    frame's own shading survives: each row is filled with that row's median of a clean column
    inside the recess, and the box edges blend over `feather` px.
    """
    x0, y0, x1, y1 = box
    sx0, sx1 = sample_x
    for y in range(max(0, y0), y1):
        row = [data[y * w + x] for x in range(sx0, sx1)]
        clean = tuple(int(statistics.median([v[i] for v in row])) for i in range(3))
        for x in range(max(0, x0), x1):
            a = min(1.0, (x - x0 + 1) / feather, (x1 - x) / feather,
                    (y - y0 + 1) / feather, (y1 - y) / feather)
            r, g, b = data[y * w + x]
            data[y * w + x] = (round(r * (1 - a) + clean[0] * a),
                               round(g * (1 - a) + clean[1] * a),
                               round(b * (1 - a) + clean[2] * a))


def neighbours(i, w, h):
    x = i % w
    return [j for j, ok in ((i - w, i >= w), (i + w, i < w * (h - 1)),
                            (i - 1, x > 0), (i + 1, x < w - 1)) if ok]


def components(mask, w, h):
    """size of every 4-connected component, as {label: size} plus the label array"""
    label = [0] * (w * h)
    sizes: dict[int, int] = {}
    cur = 0
    for s in range(w * h):
        if mask[s] and not label[s]:
            cur += 1
            label[s] = cur
            q = [s]
            n = 0
            while q:
                i = q.pop()
                n += 1
                for j in neighbours(i, w, h):
                    if mask[j] and not label[j]:
                        label[j] = cur
                        q.append(j)
            sizes[cur] = n
    return label, sizes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proof", action="store_true", help="also write a checkerboard proof")
    args = ap.parse_args()

    ref = Image.open(REF).convert("RGB")
    crop = ref.crop(BOX)
    w, h = crop.size
    data = list(crop.get_flattened_data() if hasattr(crop, "get_flattened_data") else crop.getdata())

    off_x = PLATE_CROP[0] - BOX[0]
    off_y = PLATE_CROP[1] - BOX[1]
    erase_band(data, w,
               (ERASE_IN_PLATE[0] + off_x, ERASE_IN_PLATE[1] + off_y,
                ERASE_IN_PLATE[2] + off_x, ERASE_IN_PLATE[3] + off_y),
               (ERASE_SAMPLE_IN_PLATE[0] + off_x, ERASE_SAMPLE_IN_PLATE[1] + off_y))

    # --- mark the scene: grow from every border pixel along colour-similar steps ---------------
    scene = bytearray(w * h)
    stack: list[int] = []

    def push(i: int) -> None:
        if not scene[i]:
            scene[i] = 1
            stack.append(i)

    for x in range(w):
        push(x)
        push((h - 1) * w + x)
    for y in range(h):
        push(y * w)
        push(y * w + w - 1)
    while stack:
        i = stack.pop()
        r0, g0, b0 = data[i]
        for j in neighbours(i, w, h):
            if not scene[j]:
                r1, g1, b1 = data[j]
                if max(abs(r1 - r0), abs(g1 - g0), abs(b1 - b0)) <= STEP_TOL:
                    scene[j] = 1
                    stack.append(j)

    # --- peel the blended ring the grow stops on (this is the blue line under the bottom edge) --
    for _ in range(PEEL_PASSES):
        changed = []
        for i in range(w * h):
            if scene[i]:
                continue
            around = [j for j in neighbours(i, w, h) if scene[j]]
            if not around:
                continue
            r, g, b = data[i]
            for j in around:
                r2, g2, b2 = data[j]
                if max(abs(r - r2), abs(g - g2), abs(b - b2)) <= PEEL_TOL:
                    changed.append(i)
                    break
        if not changed:
            break
        for i in changed:
            scene[i] = 1

    obj = bytearray(1 - v for v in scene)

    # --- opening by reconstruction: kill scene debris still bridged to the art -----------------
    eroded = bytearray(obj)
    for i in range(w * h):
        if not obj[i]:
            continue
        x, y = i % w, i // w
        for dy in range(-ERODE_R, ERODE_R + 1):
            for dx in range(-ERODE_R, ERODE_R + 1):
                nx, ny = x + dx, y + dy
                if nx < 0 or nx >= w or ny < 0 or ny >= h or not obj[ny * w + nx]:
                    eroded[i] = 0
                    break
            if not eroded[i]:
                break
    elabel, esizes = components(eroded, w, h)
    core = {k for k, n in esizes.items() if n >= ERODE_MIN}
    rebuilt = bytearray(1 if (eroded[i] and elabel[i] in core) else 0 for i in range(w * h))
    for _ in range(ERODE_R):
        grown = bytearray(rebuilt)
        for i in range(w * h):
            if rebuilt[i] or not obj[i]:
                continue
            if any(rebuilt[j] for j in neighbours(i, w, h)):
                grown[i] = 1
        rebuilt = grown
    obj = rebuilt

    label, sizes = components(obj, w, h)
    biggest = max(sizes, key=sizes.get)
    keep = bytearray(1 if label[i] == biggest else 0 for i in range(w * h))
    print(f"scene components after opening: {len(sizes)}; kept the largest ({sizes[biggest]} px)")

    xs = [i % w for i in range(w * h) if keep[i]]
    ys = [i // w for i in range(w * h) if keep[i]]
    x0, x1, y0, y1 = min(xs), max(xs) + 1, min(ys), max(ys) + 1

    out = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
    op = out.load()
    for yy in range(y0, y1):
        row = yy * w
        for xx in range(x0, x1):
            i = row + xx
            if keep[i]:
                r, g, b = data[i]
                op[xx - x0, yy - y0] = (r, g, b, 255)
    final = Image.new("RGBA", (out.width + 2 * BUFFER, out.height + 2 * BUFFER), (0, 0, 0, 0))
    final.paste(out, (BUFFER, BUFFER))
    DST.parent.mkdir(parents=True, exist_ok=True)
    final.save(DST, optimize=True)

    # --- the geometry src/reference.css encodes, printed so it can be re-derived --------------
    fw, fh = final.size
    ax, ay = x0 - BUFFER, y0 - BUFFER                      # module (0,0) in the crop's coords
    px, py = PLATE_CROP[0] - BOX[0] - ax, PLATE_CROP[1] - BOX[1] - ay   # plate crop in module px
    pad = 0.17 * 441, 0.14 * 441, 0.05 * 441               # the old plate's own padding (source px)
    print(f"wrote {DST.relative_to(ROOT)}  {fw}x{fh}")
    print(f"  plate window in module : left {px} top {py} size 441x220")
    print(f"  .home-record           : aspect-ratio {fw} / {fh}")
    print(f"  .home-record-face      : inset "
          f"{100 * (py + pad[0]) / fh:.3f}% {100 * (fw - px - 441 + pad[1]) / fw:.3f}% "
          f"{100 * (fh - py - 220 + pad[2]) / fh:.3f}% {100 * (px + pad[1]) / fw:.3f}%")

    if args.proof:
        chk = Image.new("RGB", final.size, (245, 246, 248))
        d = ImageDraw.Draw(chk)
        for yy in range(0, chk.height, 12):
            for xx in range(0, chk.width, 12):
                if ((xx // 12) + (yy // 12)) % 2:
                    d.rectangle((xx, yy, xx + 11, yy + 11), fill=(214, 219, 224))
        chk.paste(final, (0, 0), final)
        PROOF.parent.mkdir(parents=True, exist_ok=True)
        chk.save(PROOF)
        print(f"  proof                  : {PROOF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

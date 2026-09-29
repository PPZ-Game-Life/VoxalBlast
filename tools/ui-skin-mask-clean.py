"""Mask cleanup for the sliced pastoral UI skin — removes concept-render background that
the handoff pack's outline mask left welded to two panels.

Why this exists as a committed tool
-----------------------------------
The handoff pack (`temp/ui-redesign-handoff-20260929/`, gitignored) slices its PNGs out of
a *flat* concept render with an outline mask. Where the render's background or a flower
decoration sat directly against a panel edge, the mask kept a sliver of it. `public/art/
ui-redesign/README.md` says the shipped `close-button.png` carries a static X and its own
plate — it does not say it carries a piece of the render's foliage, and `settings-modal.png`
is documented as "the clean, ornament-free stretchable version".

So this is a **background removal**, not new art: nothing is painted, no pixel is invented,
and no occluded region is "restored". If the pack is ever re-sliced, re-run this tool
afterwards or the fringe comes back.

What it changes
---------------
`panels/close-button.png`
    Keeps only the connected component that contains the medallion. The leftover foliage is
    a separate blob welded to the outside of the gold ring, and any detached cream stub of
    the settings-card fill goes with it. ~250 px of green removal.

`panels/settings-modal.png`
    Clears green-dominant pixels **only within 8 px of the canvas edge** — the pack's mask
    kept a 1-px-tall green strip along the bottom border of the frame, which the horizontal
    nine-slice stretch then smears along the whole bottom edge of the card. Restricting to
    the outer band keeps every interior pixel untouched.

Usage:
    python tools/ui-skin-mask-clean.py            # report only
    python tools/ui-skin-mask-clean.py --write    # rewrite the two PNGs in place
"""

from __future__ import annotations

import argparse
import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PANELS = ROOT / "public" / "art" / "ui-redesign" / "panels"

EDGE_BAND = 8          # px from the canvas edge for the settings-modal cleanup
SOFT_GREEN = 6         # g - max(r, b) above this counts as foliage
ALPHA_FLOOR = 8        # ignore near-invisible pixels


def is_green(r: int, g: int, b: int) -> bool:
    return g - max(r, b) > SOFT_GREEN


def clean_close_button(px, w: int, h: int) -> tuple[object, int, int]:
    """Keep the medallion; drop every other opaque blob."""
    keep = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > ALPHA_FLOOR and not is_green(r, g, b):
                keep[y * w + x] = 1

    seen = bytearray(w * h)
    best: list[int] = []
    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if not keep[i] or seen[i]:
                continue
            comp: list[int] = []
            q = deque([(sx, sy)])
            seen[i] = 1
            while q:
                cx, cy = q.popleft()
                comp.append(cy * w + cx)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if keep[j] and not seen[j]:
                            seen[j] = 1
                            q.append((nx, ny))
            if len(comp) > len(best):
                best = comp

    keep_set = bytearray(w * h)
    for i in best:
        keep_set[i] = 1

    cleared_green = cleared_other = 0
    for y in range(h):
        for x in range(w):
            i = y * w + x
            r, g, b, a = px[x, y]
            if a > ALPHA_FLOOR and not keep_set[i]:
                if is_green(r, g, b):
                    cleared_green += 1
                else:
                    cleared_other += 1
                px[x, y] = (r, g, b, 0)
    return px, cleared_green, cleared_other


def clean_settings_modal(px, w: int, h: int) -> int:
    """Clear green only in the outer edge band."""
    cleared = 0
    for y in range(h):
        for x in range(w):
            edge = x < EDGE_BAND or x >= w - EDGE_BAND or y < EDGE_BAND or y >= h - EDGE_BAND
            if not edge:
                continue
            r, g, b, a = px[x, y]
            if a > ALPHA_FLOOR and is_green(r, g, b):
                px[x, y] = (r, g, b, 0)
                cleared += 1
    return cleared


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="rewrite the PNGs (default: report only)")
    args = ap.parse_args()

    # ---- close-button.png ------------------------------------------------------------
    path = PANELS / "close-button.png"
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    before = sum(1 for y in range(h) for x in range(w)
                 if px[x, y][3] > ALPHA_FLOOR and is_green(*px[x, y][:3]))
    px, cg, co = clean_close_button(px, w, h)
    print(f"close-button.png {w}x{h}")
    print(f"  green before          : {before}px")
    print(f"  cleared (green)       : {cg}px")
    print(f"  cleared (other blob)  : {co}px")
    if args.write:
        im.save(path)

    # ---- settings-modal.png ----------------------------------------------------------
    path = PANELS / "settings-modal.png"
    im2 = Image.open(path).convert("RGBA")
    w2, h2 = im2.size
    px2 = im2.load()
    before2 = sum(1 for y in range(h2) for x in range(w2)
                  if px2[x, y][3] > ALPHA_FLOOR and is_green(*px2[x, y][:3]))
    cleared2 = clean_settings_modal(px2, w2, h2)
    print(f"\nsettings-modal.png {w2}x{h2}")
    print(f"  green before          : {before2}px")
    print(f"  cleared (edge band)   : {cleared2}px")
    if args.write:
        im2.save(path)

    if not args.write:
        print("\nreport only — pass --write to rewrite")
    else:
        print("\nwritten. re-run tools/ui-skin-fringe-audit.py to confirm 0 green on clean panels")
    return 0


if __name__ == "__main__":
    sys.exit(main())

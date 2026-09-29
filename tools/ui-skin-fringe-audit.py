"""Audit the shipped UI-redesign PNGs for leftover-concept-art fringing.

Read-only diagnostic. It does NOT modify any asset.

Rationale: the handoff pack separates cut-outs from a *flat* concept render with an
outline mask. Where a decoration (foliage / daisy / leaf) of the render sat against a
panel edge, the mask can leave a cluster of green pixels welded to the panel. Those
clusters are invisible on the offline contact sheets (which use a checkerboard) but
become obvious once the panel is nine-sliced: a cluster inside a *stretch* band is
smeared along that axis, so a small leaf turns into a tall green streak on the card.

Usage:
    python tools/ui-skin-fringe-audit.py
    python tools/ui-skin-fringe-audit.py --crop close-button   # dump a zoomed proof
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "public" / "art" / "ui-redesign"
OUT = ROOT / ".tmp" / "ui-skin-audit"

# Panels whose art is supposed to be genuinely ornament-free. The handoff README claims
# `settings-modal.png` is "the clean, ornament-free stretchable version", so a green
# cluster here contradicts a documented claim rather than being a matter of taste.
CLEAN_PANELS = {
    "settings-modal.png",
    "settings-row.png",
    "settings-danger.png",
    "home-primary.png",
    "home-secondary.png",
    "home-nav.png",
    "toggle-on.png",
    "toggle-off.png",
    "keyboard-hint.png",
}

# Art that intentionally ships concept-decoration (logo sprigs, plate flowers, crown
# leaves). Green here is expected; the audit only reports it for the record.
DECORATED = {
    "logo-voxalblast.png",
    "home-record.png",
    "home-crown-large.png",
    "nav-crown-small.png",
    "play-triangle.png",
    "plus-gold.png",
}

# Nine-slice bands from the handoff manifest (source PNG pixels, T R B L). A cluster
# inside a band is what gets stretched by `border-image-repeat: stretch`.
NINE = {
    "settings-modal.png": (76, 76, 76, 76),
    "settings-row.png": (43, 48, 43, 48),
    "settings-danger.png": (43, 48, 43, 48),
    "home-primary.png": (78, 82, 78, 82),
    "home-secondary.png": (65, 80, 65, 80),
    "home-nav.png": (62, 70, 62, 70),
    "keyboard-hint.png": (20, 25, 20, 25),
}


def is_green(r: int, g: int, b: int) -> bool:
    """Green foliage is strongly G-dominant; the pastoral gold/cream fire is R-dominant."""
    return g > 60 and g - max(r, b) > 12


def clusters(px, w: int, h: int, box: tuple[int, int, int, int], min_size: int):
    """Connected-component pass over the green mask inside `box` (4-neighbour, BFS)."""
    x0, y0, x1, y1 = box
    seen = bytearray(w * h)
    found = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            i = y * w + x
            if seen[i]:
                continue
            r, g, b, a = px[x, y]
            if a <= 128 or not is_green(r, g, b):
                continue
            stack = [(x, y)]
            seen[i] = 1
            minx = maxx = x
            miny = maxy = y
            n = 0
            while stack:
                cx, cy = stack.pop()
                n += 1
                minx = min(minx, cx); maxx = max(maxx, cx)
                miny = min(miny, cy); maxy = max(maxy, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if not (x0 <= nx < x1 and y0 <= ny < y1):
                        continue
                    j = ny * w + nx
                    if seen[j]:
                        continue
                    nr, ng, nb, na = px[nx, ny]
                    if na <= 128 or not is_green(nr, ng, nb):
                        continue
                    seen[j] = 1
                    stack.append((nx, ny))
            if n >= min_size:
                found.append({"px": n, "box": [minx, miny, maxx, maxy]})
    return sorted(found, key=lambda c: -c["px"])


def band_of(name: str, box: list[int], w: int, h: int) -> str:
    """Which nine-slice band does this cluster fall in?"""
    if name not in NINE:
        return "-"
    t, r, b, l = NINE[name]
    minx, miny, maxx, maxy = box
    hits = []
    if miny < t:
        hits.append("TOP(stretch-x)")
    if maxy >= h - b:
        hits.append("BOTTOM(stretch-x)")
    if minx < l:
        hits.append("LEFT(stretch-y)")
    if maxx >= w - r:
        hits.append("RIGHT(stretch-y)")
    return "+".join(hits) if hits else "centre"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--crop", help="dump a 4x zoom of one asset to .tmp/ui-skin-audit")
    ap.add_argument("--min-size", type=int, default=24, help="min green pixels per cluster")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)

    if args.crop:
        for p in sorted(UI.rglob("*.png")):
            if p.stem == args.crop:
                im = Image.open(p).convert("RGBA")
                bg = Image.new("RGBA", im.size, (255, 0, 255, 255))
                bg.alpha_composite(im)
                dst = OUT / f"{p.stem}-on-magenta-4x.png"
                bg.resize((im.width * 4, im.height * 4), Image.NEAREST).save(dst)
                print(f"wrote {dst}")
        return 0

    report = []
    for p in sorted(UI.rglob("*.png")):
        im = Image.open(p).convert("RGBA")
        w, h = im.size
        rel = f"{p.parent.name}/{p.name}"
        if rel.startswith("backgrounds") or p.parent == UI:
            continue
        px = im.load()
        cl = clusters(px, w, h, (0, 0, w, h), args.min_size)
        total = sum(c["px"] for c in cl)
        kind = "clean-expected" if p.name in CLEAN_PANELS else ("decorated-allowed" if p.name in DECORATED else "other")
        for c in cl:
            c["band"] = band_of(p.name, c["box"], w, h)
        report.append({"asset": rel, "size": [w, h], "class": kind,
                       "green_px": total, "clusters": cl[:6]})

    bad = [r for r in report if r["class"] == "clean-expected" and r["green_px"] > 0]
    print(f"=== green-cluster audit  (min cluster {args.min_size}px) ===\n")
    for r in report:
        if r["green_px"] == 0:
            print(f"  ok    {r['asset']:34s} {r['size'][0]}x{r['size'][1]}")
            continue
        flag = "!!" if r["class"] == "clean-expected" else "  "
        print(f" {flag}    {r['asset']:34s} {r['size'][0]}x{r['size'][1]}  "
              f"{r['green_px']}px in {len(r['clusters'])} cluster(s)  [{r['class']}]")
        for c in r["clusters"]:
            print(f"          {c['px']:6d}px  box={c['box']}  band={c['band']}")

    print(f"\n=== verdict ===")
    if bad:
        print(f"{len(bad)} panel(s) documented as ORNAMENT-FREE still carry green concept art:")
        for r in bad:
            print(f"  - {r['asset']}: {r['green_px']}px")
    else:
        print("no green clusters on any ornament-free panel")

    (OUT / "fringe-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nfull report: {OUT / 'fringe-report.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

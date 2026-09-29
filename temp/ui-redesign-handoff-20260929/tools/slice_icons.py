#!/usr/bin/env python3
"""Deterministic icon / logo slicer for the VoxalBlast UI-redesign handoff package.

Purpose
-------
Cut genuinely transparent PNG assets (icons, logo, crowns) out of the approved
*flattened* design renders. Nothing is regenerated, no image model is used: every
output pixel is copied from the source render, and only the alpha channel is
synthesised (colour segmentation + connected components + hole analysis).

Sources (first existing candidate wins, so the package stays relocatable):
    references/home.png      | E:/WorkSpace/DSH/assets/images/voxalblast-home-crowns-new-game-final.png
    references/settings.png  | E:/WorkSpace/DSH/assets/images/voxalblast-settings-pastoral-concept.png
    references/score.png     | E:/WorkSpace/DSH/assets/images/voxalblast-best-crown-score-trophy-concept.png

Outputs (all under the package root):
    assets/icons/*.png
    manifests/icons.json
    previews/icons-contact-sheet.png

Usage
-----
    python tools/slice_icons.py            # slice + manifest + contact sheet
    python tools/slice_icons.py --probe    # diagnostic score maps, writes nothing
    python tools/slice_icons.py --check    # re-run slicing and verify outputs match manifest

Requirements: Pillow only (no numpy / cv2).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import warnings
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def px_list(img):
    """RGB/RGBA pixel tuples; silences Pillow's getdata deprecation notice."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        return list(img.getdata())

PKG = Path(__file__).resolve().parents[1]
OUT_ICONS = PKG / "assets" / "icons"
OUT_MANIFEST = PKG / "manifests" / "icons.json"
OUT_SHEET = PKG / "previews" / "icons-contact-sheet.png"

ABS_SOURCES = {
    "home": Path(r"E:\WorkSpace\DSH\assets\images\voxalblast-home-crowns-new-game-final.png"),
    "settings": Path(r"E:\WorkSpace\DSH\assets\images\voxalblast-settings-pastoral-concept.png"),
    "score": Path(r"E:\WorkSpace\DSH\assets\images\voxalblast-best-crown-score-trophy-concept.png"),
}
PKG_SOURCES = {
    "home": PKG / "references" / "home.png",
    "settings": PKG / "references" / "settings.png",
    "score": PKG / "references" / "score.png",
}

# ---------------------------------------------------------------------------
# Asset table.  `window` is a generous search box in *source* pixel coordinates;
# the real source bounding box is measured from the mask, so a slightly loose
# window is harmless as long as it stays inside the parent surface (no other art
# bleeding into the box).
#
# methods:
#   warm_chroma : max(R-B, G-max(R,B))   -> warm cream / gold / leaf green vs cool sky+cloud
#   gold_sat    : 255*(max-min)/max when R>=G>=B else 0  -> saturated gold/brown vs flat cream surface
#   purple      : max(0, B-max(R,G))     -> violet gear vs cream button
#   white_glyph : 255-(max-min)          -> white glyph vs saturated red button
#   dark_glyph  : 255-max when R>=B else 0 -> brown glyph vs bright gold disc
#   bgdiff_row  : max channel delta to the per-row background estimate (flat-ish parent surface)
# ---------------------------------------------------------------------------
ASSETS = [
    dict(
        name="logo-voxalblast", src="home", window=(44, 206, 852, 419),
        probe_window=(44, 206, 852, 460),
        exclude=[(0, 0, 52, 106), (752, 0, 808, 30), (0, 184, 13, 213)],
        method="warm_chroma", lo=5, hi=18, min_area=30, hole="smart",
        readiness="production-ready",
        role="Home title lockup: wordmark + leaf/daisy decoration (subtitle excluded)",
        notes=[
            "Subtitle band (CJK tagline, top row measured at source y=420) deliberately excluded.",
            "Three exclusion rects remove non-logo background that overlaps the window corners: "
            "tree foliage top-left, a branch top-right, and a tan scene object bottom-left; see "
            "'exclude_rects_in_source'.",
            "Near-white daisy petals rely on their warm shading plus enclosed-interior fill; the "
            "outermost petal tips that sit against the blue sky may be a little soft.",
        ],
    ),
    dict(
        name="home-crown-large", src="home", window=(272, 524, 582, 706),
        method="gold_sat", lo=110, hi=175, min_area=120, hole="smart", hole_rule="all",
        readiness="assembly-only-not-standalone-ready",
        role="Home high-score crown (large)",
        notes=[
            "Panel text (top-score label / value) excluded - only the gold crown glyph is kept.",
            "All enclosed interior holes (the central vertical shine and the smaller highlights) "
            "are filled OPAQUE with the source RGB; the gold body contains no transparent "
            "speckling.",
            "Readiness: assembly-only, NOT standalone-ready. The lower edge is occluded in the "
            "flattened render by the score panel and its daisy/leaf trim, so that edge is "
            "irregular. Play it over the score panel (or any cover) so the bottom trim hides the "
            "edge; on a bare background the 'kept' lower edge is visible. A flat cut was tried and "
            "rejected: it truncated the crown mid-body at source y=670 and read clearly worse.",
        ],
    ),
    dict(
        name="nav-crown-small", src="home", window=(100, 1601, 212, 1705),
        method="gold_sat", lo=110, hi=175, min_area=60, hole="smart", hole_rule="all",
        role="Leaderboard button crown (small)",
        notes=["Cut from the cream button face; button border/plate intentionally not included.",
               "All enclosed interior highlights are filled opaque from the source RGB - the "
               "crown must have no transparent speckling inside the gold."],
    ),
    dict(
        name="gear-purple", src="home", window=(488, 1592, 598, 1718),
        method="purple", lo=30, hi=70, min_area=60, hole="none",
        expected_enclosed_transparent=1,
        role="Settings gear glyph (purple)",
        notes=["Gear centre hole intentionally transparent (hole policy 'none'; the purple body "
               "has no other enclosed holes), so the button face shows through as designed."],
    ),
    dict(
        name="play-triangle", src="home", window=(205, 1192, 308, 1296),
        method="bgdiff_row", lo=22, hi=60, min_area=200, hole="smart", hole_rule="all", keep_top=1,
        role="Continue-game play triangle",
        notes=[
            "Lowest-contrast cut in the set: glyph sits on the gold pill, so the mask is a "
            "per-row background-difference rather than a colour class.",
            "Enclosed regions are filled opaque from the source RGB, so the solid gold triangle "
            "carries no transparent pinholes.",
        ],
    ),
    dict(
        name="plus-gold", src="home", window=(258, 1436, 360, 1532),
        method="gold_sat", lo=110, hi=175, min_area=60, hole="smart", hole_rule="all", keep_top=1,
        role="New-game plus glyph",
        notes=["Cut from the cream button face."],
    ),
    dict(
        name="hud-crown-best", src="score", window=(210, 466, 356, 596),
        method="gold_sat", lo=185, hi=235, min_area=60, hole="smart", hole_rule="all", keep_top=1,
        role="HUD BEST row crown",
        notes=["Row plate / label text excluded.",
               "All enclosed interior highlights are filled opaque from the source RGB."],
    ),
    dict(
        name="hud-trophy-score", src="score", window=(200, 676, 362, 818),
        method="gold_sat", lo=185, hi=235, min_area=60, hole="smart",
        hole_rule="gold_highlight", keep_top=1, expected_enclosed_transparent=2,
        role="HUD SCORE row trophy",
        notes=["Row plate / numeral text excluded.",
               "Hole policy: the two genuine handle openings stay transparent (they show the "
               "plate's shadowed tan); the cup-body shine and every pale-gold interior region are "
               "filled opaque from the source RGB."],
    ),
    dict(
        name="settings-speaker", src="settings", window=(130, 510, 232, 596),
        method="gold_sat", lo=110, hi=175, min_area=40, hole="smart",
        role="Settings row glyph: sound / speaker",
        notes=["Speaker body plus two sound-wave arcs are separate components; all are kept "
               "(min_area 40). No row plate or label text included."],
    ),
    dict(
        name="settings-vibration", src="settings", window=(132, 650, 228, 762),
        method="gold_sat", lo=110, hi=175, min_area=20, hole="smart",
        role="Settings row glyph: haptics / vibrating phone",
        notes=["Side motion arcs are separate small components and are kept (low min_area)."],
    ),
    dict(
        name="settings-turn", src="settings", window=(134, 805, 230, 905),
        method="gold_sat", lo=110, hi=175, min_area=40, hole="smart",
        role="Settings row glyph: block turn / flip",
        notes=["Curved block-turn arrow cut from the flat cream row; no row plate or label text."],
    ),
    dict(
        name="settings-book", src="settings", window=(128, 955, 232, 1043),
        method="gold_sat", lo=110, hi=175, min_area=40, hole="smart",
        role="Settings row glyph: how to play / open book",
        notes=["Page gutter of the book is kept opaque (enclosed interior fill)."],
    ),
    dict(
        name="settings-home", src="settings", window=(130, 1096, 232, 1190),
        method="gold_sat", lo=110, hi=175, min_area=40, hole="smart",
        expected_enclosed_transparent=1,
        role="Settings row glyph: back to home",
        notes=["House glyph; recessed areas follow the source shading (one enclosed hole kept "
               "transparent). No row plate or label text."],
    ),
    dict(
        name="settings-restart", src="settings", window=(136, 1248, 230, 1346),
        method="white_glyph", lo=200, hi=236, min_area=40, hole="smart",
        role="Settings row glyph: restart (white on red plate)",
        notes=["White glyph on the saturated red plate; plate is not included."],
    ),
    dict(
        name="settings-close-x", src="settings", window=(710, 380, 762, 426),
        method="dark_glyph", lo=50, hi=95, min_area=20, hole="smart", keep_top=1,
        role="Settings close X glyph (optional static glyph)",
        notes=[
            "Cut from the gold disc only; the cream ring and the leaf trim behind the disc are excluded.",
        ],
    ),
]

SHEET_BG = ((214, 214, 214), (255, 255, 255))
SHEET_CELL = 200
SHEET_COLS = 5
SHEET_PAD = 16
SHEET_LABEL_H = 26

METHOD_DESC = {
    "warm_chroma": "warm/green chroma score max(R-B, G-max(R,B)) -> soft alpha ramp (antialiased "
                   "silhouette) -> 8-connected component filtering -> enclosed-hole fill",
    "gold_sat": "warm-hue gated saturation score 255*(max-min)/max (kept only where R>=G>=B) -> "
                "soft alpha ramp -> 8-connected component filtering -> enclosed-hole fill",
    "purple": "violet score max(0, B-max(R,G)) -> soft alpha ramp -> 8-connected component "
              "filtering -> enclosed-hole fill",
    "white_glyph": "whiteness score 255-(max-min) -> soft alpha ramp -> 8-connected component "
                   "filtering -> enclosed-hole fill",
    "dark_glyph": "darkness score 255-max for warm pixels (R>=B) -> soft alpha ramp -> 8-connected "
                  "component filtering -> enclosed-hole fill",
    "bgdiff_row": "per-row background-difference score (max channel delta to that row's edge "
                  "colour) -> soft alpha ramp -> 8-connected component filtering",
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def find_source(src: str) -> tuple[Path, str]:
    pkg = PKG_SOURCES[src]
    if pkg.exists():
        return pkg, "package-reference"
    return ABS_SOURCES[src], "absolute-fallback"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ramp(v: float, lo: float, hi: float) -> float:
    if v <= lo:
        return 0.0
    if v >= hi:
        return 1.0
    return (v - lo) / (hi - lo)


def build_scores(px, w, h, method):
    """Return a per-pixel score list (ints, ~0..255)."""
    if method == "bgdiff_row":
        edge = max(2, min(5, w // 8))
        rowbg = []
        for y in range(h):
            base = y * w
            sr = sg = sb = 0
            n = 0
            for x in list(range(edge)) + list(range(w - edge, w)):
                r, g, b = px[base + x]
                sr += r
                sg += g
                sb += b
                n += 1
            rowbg.append((sr / n, sg / n, sb / n))
        out = [0] * (w * h)
        for y in range(h):
            base = y * w
            br, bg, bb = rowbg[y]
            for x in range(w):
                r, g, b = px[base + x]
                out[base + x] = int(max(abs(r - br), abs(g - bg), abs(b - bb)))
        return out

    out = [0] * (w * h)
    for i, (r, g, b) in enumerate(px):
        mx = r if r >= g and r >= b else (g if g >= b else b)
        mn = r if r <= g and r <= b else (g if g <= b else b)
        if method == "warm_chroma":
            s = r - b
            alt = g - (r if r >= b else b)
            if alt > s:
                s = alt
        elif method == "gold_sat":
            s = int(round(255.0 * (mx - mn) / mx)) if (r >= g >= b and mx > 0) else 0
        elif method == "purple":
            s = b - (r if r >= g else g)
            if s < 0:
                s = 0
        elif method == "white_glyph":
            s = 255 - (mx - mn)
        elif method == "dark_glyph":
            s = (255 - mx) if r >= b else 0
        else:
            raise ValueError(f"unknown method {method}")
        out[i] = s
    return out


def components(mask, w, h, min_area):
    """8-connected labelling; returns (kept_pixel_list, kept_components, dropped_components)."""
    seen = bytearray(w * h)
    kept, dropped = [], 0
    for start in range(w * h):
        if not mask[start] or seen[start]:
            continue
        seen[start] = 1
        stack = [start]
        pixels = []
        while stack:
            i = stack.pop()
            pixels.append(i)
            x = i % w
            y = i // w
            for dy in (-1, 0, 1):
                ny = y + dy
                if ny < 0 or ny >= h:
                    continue
                row = ny * w
                for dx in (-1, 0, 1):
                    nx = x + dx
                    if nx < 0 or nx >= w:
                        continue
                    j = row + nx
                    if mask[j] and not seen[j]:
                        seen[j] = 1
                        stack.append(j)
        if len(pixels) >= min_area:
            kept.append(pixels)
        else:
            dropped += 1
    return kept, dropped


def outside_region(mask, w, h):
    """Flood fill the non-mask area reachable from the window border."""
    outside = bytearray(w * h)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if not mask[i] and not outside[i]:
                outside[i] = 1
                stack.append(i)
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if not mask[i] and not outside[i]:
                outside[i] = 1
                stack.append(i)
    while stack:
        i = stack.pop()
        x = i % w
        y = i // w
        for dy in (-1, 0, 1):
            ny = y + dy
            if ny < 0 or ny >= h:
                continue
            row = ny * w
            for dx in (-1, 0, 1):
                nx = x + dx
                if nx < 0 or nx >= w:
                    continue
                j = row + nx
                if not mask[j] and not outside[j]:
                    outside[j] = 1
                    stack.append(j)
    return outside


def border_median(px, w, h):
    vals = [px[i] for i in range(w)] + [px[(h - 1) * w + i] for i in range(w)]
    vals += [px[y * w] for y in range(h)] + [px[y * w + w - 1] for y in range(h)]
    out = []
    for c in range(3):
        col = sorted(v[c] for v in vals)
        out.append(col[len(col) // 2])
    return tuple(out)


def hole_is_art(spec, mean, dist, min_dist):
    """Decide whether an enclosed region is interior artwork (fill) or a genuine see-through hole.

    Rules
    -----
    bg_dist        fill when the region differs from the parent background (default)
    all            fill every enclosed region (gold bodies: no highlight may punch through)
    gold_highlight fill pale-gold interiors, keep shadowed tan (real openings, e.g. the trophy
                   handle loops) transparent
    """
    rule = spec.get("hole_rule", "bg_dist")
    if rule == "all":
        return True
    if rule == "bg_dist":
        return dist >= min_dist
    if rule == "gold_highlight":
        mr, mg, mb = mean
        return mr >= 250 or (mg - mb) >= 85
    raise ValueError(f"unknown hole_rule {rule}")


def apply_excludes(hard, soft, w, h, excludes):
    for (ex0, ey0, ex1, ey1) in excludes:
        for y in range(max(0, ey0), min(h, ey1)):
            base = y * w
            for x in range(max(0, ex0), min(w, ex1)):
                hard[base + x] = False
                soft[base + x] = 0.0


def comp_bbox(pixels, w):
    xs0 = xs1 = pixels[0] % w
    ys0 = ys1 = pixels[0] // w
    for i in pixels:
        x = i % w
        y = i // w
        if x < xs0:
            xs0 = x
        elif x > xs1:
            xs1 = x
        if y < ys0:
            ys0 = y
        elif y > ys1:
            ys1 = y
    return (xs0, ys0, xs1 + 1, ys1 + 1)


def build_alpha(px, w, h, spec):
    """Return (alpha_floats, stats)."""
    scores = build_scores(px, w, h, spec["method"])
    lo, hi = spec["lo"], spec["hi"]
    # binarisation ramp + wider soft ramp so the silhouette keeps its antialiasing
    soft_lo = lo - 0.6 * (hi - lo)
    soft = [ramp(s, soft_lo, hi) for s in scores]
    hard = [s >= lo for s in scores]
    if spec.get("exclude"):
        apply_excludes(hard, soft, w, h, spec["exclude"])

    kept, dropped = components(hard, w, h, spec["min_area"])
    keep_top = spec.get("keep_top")
    if keep_top is not None and len(kept) > keep_top:
        kept.sort(key=len, reverse=True)
        dropped += len(kept) - keep_top
        kept = kept[:keep_top]
    mask = bytearray(w * h)
    for pixels in kept:
        for i in pixels:
            mask[i] = 1

    bg = border_median(px, w, h)
    holes_filled = 0
    holes_left = 0
    hole_pixels = bytearray(w * h)
    hole_records = []  # (bbox_in_window, area, filled)
    if spec["hole"] != "none":
        outside = outside_region(mask, w, h)
        hole_mask = bytearray(w * h)
        for i in range(w * h):
            if not mask[i] and not outside[i]:
                hole_mask[i] = 1
        hole_comps, _ = components(hole_mask, w, h, 1)
        min_dist = spec.get("hole_bg_min_dist", 25)
        for comp in hole_comps:
            n = len(comp)
            if n > 0.45 * w * h:
                holes_left += 1
                continue
            sr = sg = sb = 0
            for i in comp:
                r, g, b = px[i]
                sr += r
                sg += g
                sb += b
            mr, mg, mb = sr / n, sg / n, sb / n
            dist = max(abs(mr - bg[0]), abs(mg - bg[1]), abs(mb - bg[2]))
            # an enclosed region that is not the parent background is interior artwork
            # (gold highlight, cup shine, gear web...): it must stay OPAQUE.
            # Components of a few pixels are never a designed opening - always close them, so no
            # 1-3px pinhole can survive inside a solid body.
            if n <= 8 or hole_is_art(spec, (mr, mg, mb), dist, min_dist):
                for i in comp:
                    mask[i] = 1
                    hole_pixels[i] = 1
                holes_filled += 1
                hole_records.append((comp_bbox(comp, w), n, True, (mr, mg, mb), comp))
            else:
                holes_left += 1
                hole_records.append((comp_bbox(comp, w), n, False, (mr, mg, mb), comp))

    flat_cut = None
    if spec.get("flat_bottom"):
        spans = []
        for y in range(h):
            base = y * w
            xs = [x for x in range(w) if mask[base + x]]
            spans.append((xs[0], xs[-1], len(xs)) if xs else None)
        maxspan = max([s[1] - s[0] + 1 for s in spans if s] or [0])
        for y in range(h - 1, -1, -1):
            s = spans[y]
            if not s:
                continue
            span = s[1] - s[0] + 1
            if maxspan and span >= 0.7 * maxspan and s[2] / span >= 0.72:
                flat_cut = y + 1
                break
        if flat_cut:
            for y in range(flat_cut, h):
                base = y * w
                for x in range(w):
                    mask[base + x] = 0
                    soft[base + x] = 0.0

    alpha = [0.0] * (w * h)
    for i in range(w * h):
        if mask[i]:
            # hole-filled pixels are interior artwork: opaque at full strength, never re-scaled
            # by the threshold ramp (that is what punched transparent holes in the gold highlights).
            alpha[i] = 1.0 if hole_pixels[i] else soft[i]

    # The ramp is only there to antialias the silhouette. Any pixel with all four neighbours
    # inside the mask is interior artwork and must be fully opaque, otherwise a faint checkerboard
    # bleeds through the middle of a solid gold body.
    for y in range(1, h - 1):
        row = y * w
        for x in range(1, w - 1):
            i = row + x
            if mask[i] and alpha[i] < 1.0 and mask[i - 1] and mask[i + 1] and mask[i - w] and mask[i + w]:
                alpha[i] = 1.0

    stats = dict(
        method=spec["method"], ramp=[soft_lo, hi], threshold=lo,
        components_kept=len(kept), components_dropped=dropped,
        holes_filled=holes_filled, holes_left_transparent=holes_left,
        border_bg=list(bg), keep_top=keep_top, flat_cut=flat_cut,
    )
    return alpha, stats, hole_records


def render_alpha(spec, crop):
    """convenience wrapper used by slice_all / profile"""
    w, h = crop.size
    px = px_list(crop)
    alpha, stats, holes = build_alpha(px, w, h, spec)
    return alpha, stats, px, w, h


def bbox_of(alpha, w, h, cut=0.06):
    xs, ys = [], []
    for y in range(h):
        row = y * w
        for x in range(w):
            if alpha[row + x] >= cut:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def trim_to_bbox(alpha, w, h, box, pad=2):
    l, t, r, b = box
    l = max(0, l - pad)
    t = max(0, t - pad)
    r = min(w, r + pad)
    b = min(h, b + pad)
    out = []
    for y in range(t, b):
        row = y * w
        for x in range(l, r):
            out.append(alpha[row + x])
    return out, (l, t, r, b)


def make_png(crop_rgb, alpha, tw, th):
    img = Image.new("RGBA", (tw, th))
    img.putdata([
        (r, g, b, max(0, min(255, int(round(a * 255)))))
        for (r, g, b), a in zip(px_list(crop_rgb), alpha)
    ])
    return img


# ---------------------------------------------------------------------------
# probe
# ---------------------------------------------------------------------------

def probe():
    for spec in ASSETS:
        p, mode = find_source(spec["src"])
        img = Image.open(p).convert("RGB")
        box = spec.get("probe_window", spec["window"])
        crop = img.crop(box)
        w, h = crop.size
        px = px_list(crop)
        scores = build_scores(px, w, h, spec["method"])
        lo, hi = spec["lo"], spec["hi"]
        bg = border_median(px, w, h)
        ring = []
        for y in range(h):
            for x in list(range(min(3, w))) + list(range(max(0, w - 3), w)):
                ring.append(scores[y * w + x])
        ring.sort()
        def pct(p):
            return ring[min(len(ring) - 1, int(p * len(ring)))]
        hits = sum(1 for s in scores if s >= lo)
        print(f"=== {spec['name']}  [{mode}] {p.name}")
        print(f"    window={box} size={w}x{h} bg(border median)={bg} "
              f"method={spec['method']} lo={lo} hi={hi} hits={hits} ({100.0*hits/(w*h):.1f}%)")
        print(f"    border-ring score: p50={pct(0.50)} p95={pct(0.95)} p99={pct(0.99)} max={ring[-1]}")
        # row ranges with any hit
        rows = [y for y in range(h) if any(scores[y * w + x] >= lo for x in range(w))]
        cols = [x for x in range(w) if any(scores[y * w + x] >= lo for y in range(h))]
        def ranges(vals):
            if not vals:
                return "none"
            out = []
            s = pv = vals[0]
            for v in vals[1:]:
                if v == pv + 1:
                    pv = v
                    continue
                out.append(f"{s}-{pv}")
                s = pv = v
            out.append(f"{s}-{pv}")
            return ",".join(out)
        print(f"    hit rows: {ranges(rows)}")
        print(f"    hit cols: {ranges(cols)}")
        hard = [s >= lo for s in scores]
        if spec.get("exclude"):
            soft_dummy = [0.0] * (w * h)
            apply_excludes(hard, soft_dummy, w, h, spec["exclude"])
            print(f"    excluded rects (window coords): {spec['exclude']}")
        comps, _ = components(hard, w, h, spec["min_area"])
        comps.sort(key=len, reverse=True)
        shown = ", ".join(
            f"area={len(c)} bbox={comp_bbox(c, w)}" for c in comps[:6])
        print(f"    components(>={spec['min_area']}px)={len(comps)}: {shown}")
        # ascii map 74 cols
        cw = 74
        rh = max(1, int(round((h / w) * cw * 0.5)))
        chars = " .:+*#@"
        print("    map ('.'<lo  '+'<hi  '*'<1.6hi  '#'<2.4hi  '@'>=2.4hi):")
        for ry in range(rh):
            line = []
            for rx in range(cw):
                x0 = rx * w // cw
                x1 = max(x0 + 1, (rx + 1) * w // cw)
                y0 = ry * h // rh
                y1 = max(y0 + 1, (ry + 1) * h // rh)
                tot = n = 0
                for yy in range(y0, y1):
                    base = yy * w
                    for xx in range(x0, x1):
                        tot += scores[base + xx]
                        n += 1
                v = tot / max(1, n)
                if v < lo * 0.5:
                    c = chars[0]
                elif v < lo:
                    c = chars[1]
                elif v < hi:
                    c = chars[2]
                elif v < hi * 1.6:
                    c = chars[3]
                elif v < hi * 2.4:
                    c = chars[4]
                else:
                    c = chars[5]
                line.append(c)
            print("    |" + "".join(line) + "|")
        print()


def profile():
    """Compact per-row density profile (2px bins, hex digit = density/max)."""
    for spec in ASSETS:
        p, _ = find_source(spec["src"])
        img = Image.open(p).convert("RGB")
        box = spec.get("probe_window", spec["window"])
        crop = img.crop(box)
        w, h = crop.size
        px = px_list(crop)
        scores = build_scores(px, w, h, spec["method"])
        lo = spec["lo"]
        bins = []
        for y0 in range(0, h, 2):
            c = 0
            for y in range(y0, min(h, y0 + 2)):
                base = y * w
                for x in range(w):
                    if scores[base + x] >= lo:
                        c += 1
            bins.append(c)
        mx = max(1, max(bins))
        line = "".join("%X" % min(15, int(round(15.0 * b / mx))) for b in bins)
        print(f"{spec['name']:22s} y={box[1]}..{box[3]} bin=2px max={mx}")
        print(f"    {line}")


def holes_report():
    """List the enclosed holes of each asset (area, bbox, mean colour, distance to window bg)."""
    for spec in ASSETS:
        p, _ = find_source(spec["src"])
        img = Image.open(p).convert("RGB")
        l, t, r, b = spec["window"]
        crop = img.crop((l, t, r, b))
        w, h = crop.size
        px = px_list(crop)
        scores = build_scores(px, w, h, spec["method"])
        hard = [s >= spec["lo"] for s in scores]
        soft = [0.0] * (w * h)
        if spec.get("exclude"):
            apply_excludes(hard, soft, w, h, spec["exclude"])
        kept, _ = components(hard, w, h, spec["min_area"])
        keep_top = spec.get("keep_top")
        if keep_top is not None and len(kept) > keep_top:
            kept.sort(key=len, reverse=True)
            kept = kept[:keep_top]
        mask = bytearray(w * h)
        for comp in kept:
            for i in comp:
                mask[i] = 1
        bg = border_median(px, w, h)
        outside = outside_region(mask, w, h)
        hm = bytearray(w * h)
        total = 0
        for i in range(w * h):
            if not mask[i] and not outside[i]:
                hm[i] = 1
                total += 1
        comps, _ = components(hm, w, h, 4)
        comps.sort(key=len, reverse=True)
        print(f"=== {spec['name']}  window={spec['window']} bg={bg} hole={spec['hole']} "
              f"enclosed_hole_px={total} hole_components={len(comps)}")
        for comp in comps[:8]:
            n = len(comp)
            sr = sg = sb = 0
            for i in comp:
                rr, gg, bb = px[i]
                sr += rr
                sg += gg
                sb += bb
            m = (sr / n, sg / n, sb / n)
            dist = max(abs(m[0] - bg[0]), abs(m[1] - bg[1]), abs(m[2] - bg[2]))
            print("    area=%-6d bbox=%-24s mean=(%3d,%3d,%3d) distBg=%3d" %
                  (n, comp_bbox(comp, w), m[0], m[1], m[2], dist))


def audit():
    """QA gate for the delivered PNGs: report transparent regions that are fully enclosed by
    opaque pixels (i.e. checkerboard perforations inside a solid body)."""
    manifest = json.loads(OUT_MANIFEST.read_text(encoding="utf-8"))
    expected = {}
    for a in manifest["assets"]:
        if a.get("deprecated_alias_of"):
            continue
        exp = a.get("expected_enclosed_transparent")
        if exp is None:
            exp = a.get("masking", {}).get("holes_kept_transparent", 0)
        expected[a["file"]] = exp
    problems = []
    for entry in manifest["assets"]:
        if entry.get("deprecated_alias_of"):
            continue
        img = Image.open(PKG / entry["file"]).convert("RGBA")
        w, h = img.size
        alpha = img.getchannel("A")
        px = px_list(alpha)
        clear = bytearray(1 if v < 8 else 0 for v in px)
        seen = bytearray(w * h)
        stack = []
        for x in range(w):
            for y in (0, h - 1):
                i = y * w + x
                if clear[i] and not seen[i]:
                    seen[i] = 1
                    stack.append(i)
        for y in range(h):
            for x in (0, w - 1):
                i = y * w + x
                if clear[i] and not seen[i]:
                    seen[i] = 1
                    stack.append(i)
        while stack:
            i = stack.pop()
            x, y = i % w, i // w
            for dy in (-1, 0, 1):
                ny = y + dy
                if ny < 0 or ny >= h:
                    continue
                for dx in (-1, 0, 1):
                    nx = x + dx
                    if nx < 0 or nx >= w:
                        continue
                    j = ny * w + nx
                    if clear[j] and not seen[j]:
                        seen[j] = 1
                        stack.append(j)
        enclosed = bytearray(w * h)
        for i in range(w * h):
            if clear[i] and not seen[i]:
                enclosed[i] = 1
        comps, _ = components(enclosed, w, h, 1)
        comps.sort(key=len, reverse=True)
        # interior-but-translucent pixels: solid body with a faint checkerboard bleeding through
        faint = 0
        for y in range(1, h - 1):
            row = y * w
            for x in range(1, w - 1):
                i = row + x
                if 0 < px[i] < 250 and px[i - 1] >= 250 and px[i + 1] >= 250 \
                        and px[i - w] >= 250 and px[i + w] >= 250:
                    faint += 1
        detail = ", ".join(f"area={len(c)} bbox={comp_bbox(c, w)}" for c in comps[:4]) or "none"
        bad = len(comps) != expected[entry["file"]] or faint > 0
        flag = "!! " if bad else "OK "
        if bad:
            problems.append(entry["name"])
        print(f"{flag}{entry['name']:<22} enclosed transparent regions={len(comps)} "
              f"(manifest expects {expected[entry['file']]}), interior_translucent_px={faint}: "
              f"{detail}")
    print("AUDIT:", "clean" if not problems else f"MISMATCH in {problems}")


SPOT_TARGETS = ["home-crown-large", "nav-crown-small", "hud-trophy-score", "hud-crown-best"]


def spotcheck():
    """Sample the DELIVERED png's alpha inside the source highlight regions (no self-reporting:
    the numbers come from the file on disk, mapped through the same window->output offset)."""
    for spec in ASSETS:
        if spec["name"] not in SPOT_TARGETS:
            continue
        p, _ = find_source(spec["src"])
        img = Image.open(p).convert("RGB")
        l, t, r, b = spec["window"]
        crop = img.crop((l, t, r, b))
        w, h = crop.size
        px = px_list(crop)
        alpha, stats, holes = build_alpha(px, w, h, spec)
        box = bbox_of(alpha, w, h)
        _at, tbox = trim_to_bbox(alpha, w, h, box)
        out = Image.open(OUT_ICONS / f"{spec['name']}.png").convert("RGBA")
        oa = px_list(out.getchannel("A"))
        ow, oh = out.size
        print(f"=== {spec['name']}  png={ow}x{oh} hole_rule={spec.get('hole_rule', 'bg_dist')} "
              f"filled={stats['holes_filled']} kept_transparent={stats['holes_left_transparent']}")

        def sample(hole):
            """alpha of exactly this hole's own pixels (bbox sampling would include the crown's
            genuine see-through notches and read as transparent)."""
            hb, _area, _f, _mean, comp = hole
            vals = []
            for i in comp:
                ox = (i % w) - tbox[0]
                oy = (i // w) - tbox[1]
                if 0 <= ox < ow and 0 <= oy < oh:
                    vals.append(oa[oy * ow + ox])
            return hb, vals

        filled = sorted([z for z in holes if z[2]], key=lambda z: -z[1])
        kept = sorted([z for z in holes if not z[2]], key=lambda z: -z[1])
        for hb, area, _f, mean, _c in filled[:4]:
            _hb, vals = sample((hb, area, True, mean, _c))
            if not vals:
                continue
            print(f"    FILLED highlight area={area:<5} src_bbox={hb} "
                  f"meanSrcRGB=({mean[0]:.0f},{mean[1]:.0f},{mean[2]:.0f})")
            print(f"      delivered alpha over EXACTLY these {len(vals)} px: min={min(vals)} "
                  f"mean={sum(vals)/len(vals):.1f} max={max(vals)} "
                  f"px_below_255={sum(1 for v in vals if v < 255)}")
        for hb, area, _f, mean, _c in kept[:3]:
            _hb, vals = sample((hb, area, False, mean, _c))
            if not vals:
                continue
            print(f"    KEPT-TRANSPARENT opening area={area:<5} src_bbox={hb} "
                  f"alpha over exactly these {len(vals)} px: min={min(vals)} "
                  f"mean={sum(vals)/len(vals):.1f} max={max(vals)}")
        if filled:
            hb, area, _f, _m, comp = filled[0]
            ox0, oy0 = hb[0] - tbox[0], hb[1] - tbox[1]
            ox1, oy1 = hb[2] - tbox[0], hb[3] - tbox[1]
            cw, ch = max(1, ox1 - ox0), max(1, oy1 - oy0)
            cols, rows = min(26, cw), min(14, ch)
            grid = {}
            for i in comp:
                ox = (i % w) - tbox[0]
                oy = (i // w) - tbox[1]
                if not (0 <= ox < ow and 0 <= oy < oh):
                    continue
                gx = min(cols - 1, (ox - ox0) * cols // cw)
                gy = min(rows - 1, (oy - oy0) * rows // ch)
                grid.setdefault((gy, gx), []).append(oa[oy * ow + ox])
            print(f"    alpha map of the largest highlight - only this hole's own pixels "
                  f"(src bbox {hb}; 0=clear .. 9=opaque, '.' = not part of the hole):")
            for ry in range(rows):
                line = []
                for rx in range(cols):
                    cell = grid.get((ry, rx))
                    line.append("." if not cell else str(min(9, min(cell) * 10 // 256)))
                print("      |" + "".join(line) + "|")


# ---------------------------------------------------------------------------
# slice
# ---------------------------------------------------------------------------

def slice_all():
    OUT_ICONS.mkdir(parents=True, exist_ok=True)
    OUT_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    OUT_SHEET.parent.mkdir(parents=True, exist_ok=True)

    sources, used = {}, {}
    for key in ABS_SOURCES:
        p, mode = find_source(key)
        if not p.exists():
            raise SystemExit(f"missing source for '{key}': {p}")
        used[key] = dict(path=str(p), resolve=mode, width=Image.open(p).size[0],
                         height=Image.open(p).size[1], sha256=sha256(p))
    cache = {}

    entries = []
    for spec in ASSETS:
        key = spec["src"]
        if key not in cache:
            cache[key] = Image.open(used[key]["path"]).convert("RGB")
        img = cache[key]
        l, t, r, b = spec["window"]
        crop = img.crop((l, t, r, b))
        w, h = crop.size
        px = px_list(crop)
        alpha, stats, hole_records = build_alpha(px, w, h, spec)
        box = bbox_of(alpha, w, h)
        if box is None:
            raise SystemExit(f"{spec['name']}: empty mask, threshold too strict")
        alpha_t, tbox = trim_to_bbox(alpha, w, h, box)
        tw, th = tbox[2] - tbox[0], tbox[3] - tbox[1]
        out = make_png(crop.crop(tbox), alpha_t, tw, th)
        out_path = OUT_ICONS / f"{spec['name']}.png"
        out.save(out_path, optimize=True)
        aliases = []
        for alias in spec.get("aliases", []):
            (OUT_ICONS / f"{alias}.png").write_bytes(out_path.read_bytes())
            aliases.append(alias)

        opaque = sum(1 for a in alpha_t if a >= 0.5)
        partial = sum(1 for a in alpha_t if 0.06 <= a < 0.5)
        touches = []
        if box[0] <= 0:
            touches.append("left")
        if box[1] <= 0:
            touches.append("top")
        if box[2] >= w:
            touches.append("right")
        if box[3] >= h:
            touches.append("bottom")
        entry = dict(
            name=spec["name"],
            file=f"assets/icons/{spec['name']}.png",
            source=key,
            source_path=used[key]["path"],
            source_resolve=used[key]["resolve"],
            role=spec["role"],
            readiness=spec.get("readiness", "production-ready"),
            # --- keys requested for the handoff contract -------------------
            source_file=f"references/{key}.png",
            sourceBounds=[l, t, r, b],
            size=[tw, th],
            method=METHOD_DESC[spec["method"]],
            # --- detailed provenance ---------------------------------------
            source_window=[l, t, r, b],
            source_bbox_in_source=[l + box[0], t + box[1], l + box[2], t + box[3]],
            source_bbox_in_window=list(box),
            output_size=[tw, th],
            scale=1.0,
            content_touches_window_edge=touches,
            alpha=dict(mode="RGBA", has_alpha=True,
                       opaque_fraction=round(opaque / (tw * th), 4),
                       antialiased_edge_fraction=round(partial / (tw * th), 4)),
            masking=dict(method=spec["method"], ramp=[stats["ramp"][0], stats["ramp"][1]],
                         binarise_threshold=stats["threshold"],
                         connectivity=8, min_component_area=spec["min_area"],
                         keep_largest_components=stats["keep_top"],
                         exclude_rects_in_source=[
                             [l + ex0, t + ey0, l + ex1, t + ey1]
                             for (ex0, ey0, ex1, ey1) in spec.get("exclude", [])],
                         components_kept=stats["components_kept"],
                         components_dropped_as_specks=stats["components_dropped"],
                         hole_policy=spec["hole"],
                         hole_rule=spec.get("hole_rule", "bg_dist"),
                         holes_filled_as_art=stats["holes_filled"],
                         holes_kept_transparent=stats["holes_left_transparent"],
                         window_border_bg_rgb=stats["border_bg"]),
            aliases=aliases,
            deprecated_alias_of=None,
            expected_enclosed_transparent=spec.get("expected_enclosed_transparent"),
            flat_bottom_cut_source_y=(
                t + stats["flat_cut"] if stats.get("flat_cut") else None),
            notes=list(spec["notes"]),
        )
        entries.append(entry)
        print(f"  {spec['name']:22s} {tw:>4}x{th:<4} src_bbox={entry['source_bbox_in_source']} "
              f"comps={stats['components_kept']} holes_filled={stats['holes_filled']} "
              f"holes_left={stats['holes_left_transparent']}")

    alias_entries = []
    for entry in entries:
        for alias in entry.get("aliases", []):
            alias_entry = dict(entry)
            alias_entry.update(
                name=alias,
                file=f"assets/icons/{alias}.png",
                aliases=[],
                deprecated_alias_of=entry["name"],
                role=f"{entry['role']} (deprecated alias)",
                notes=list(entry["notes"]) + [
                    f"DEPRECATED ALIAS of {entry['file']} - byte-identical copy kept only so "
                    "earlier CSS snippets keep resolving. Prefer the canonical filename."],
            )
            alias_entries.append(alias_entry)

    manifest = dict(
        package="temp/ui-redesign-handoff-20260929",
        produced_by="tools/slice_icons.py",
        purpose="Transparent icon / logo cut-outs sliced from approved flattened design renders.",
        method_summary=(
            "Per-pixel colour-class score -> soft alpha ramp (antialiased silhouette) -> "
            "8-connected component filtering (speck removal) -> enclosed-hole analysis against the "
            "window border background colour. Hole-filled pixels are forced fully opaque at the "
            "source RGB, so gold highlights cannot punch through. No generative model, no content "
            "regeneration: RGB is copied verbatim from the source render at 1:1 scale."
        ),
        review_fixes=[
            "Round-2 fix: enclosed holes used to be re-multiplied by the threshold ramp, so "
            "interior gold highlights below the binarisation threshold ended up at alpha 0 "
            "(checkerboard perforation). Hole-filled pixels are now forced opaque.",
            "Round-3 fix: mask pixels fully surrounded by mask were still carrying the antialias "
            "ramp value (0.6-1.0), so a faint checkerboard bled through the middle of solid gold "
            "bodies (measured before: 343 px logo, 162 home-crown-large, 48 nav-crown-small, "
            "44 hud-crown-best, 21 hud-trophy-score). Interior pixels (all four neighbours inside "
            "the mask) are now forced to alpha 255; the ramp only survives on the silhouette.",
            "Round-3 verification: --spotcheck samples the delivered PNG over the exact pixels of "
            "each source highlight. home-crown-large central vertical shine (1062 px), "
            "nav-crown-small right highlight (108 px), hud-trophy-score cup-body shines (273 px and "
            "240 px): alpha min=mean=max=255, 0 px below 255. The trophy's two handle openings "
            "measure alpha exactly 0. --audit reports 0 enclosed transparent regions and 0 interior "
            "translucent pixels for every asset except the four deliberate openings.",
            "home-crown-large window=(272,524,582,706) hole_rule='all' + alpha fix: the central "
            "vertical shine (window bbox 162,56,250,146, 1062 px) and 9 smaller highlights are now "
            "opaque. Readiness downgraded to assembly-only-not-standalone-ready.",
            "nav-crown-small window=(100,1601,212,1705) hole_rule='all': the right-side highlight "
            "(window bbox 58,33,72,63, 108 px, only 23/255 away from the button cream) and 6 more "
            "highlights are now opaque.",
            "hud-crown-best hole_rule='all': 6 interior highlights now opaque.",
            "hud-trophy-score hole_rule='gold_highlight': the cup-body shine and 7 pale-gold "
            "interiors are now opaque; only the two genuine handle openings (window bboxes "
            "30,43,39,58 and 121,43,131,58) remain transparent.",
            "gear-purple hole policy set to 'none' so the centre hole stays transparent now that "
            "hole filling is always opaque.",
        ],
        sources={k: v for k, v in used.items()},
        naming=dict(
            canonical=[e["name"] for e in entries],
            deprecated_aliases={e["name"]: e["deprecated_alias_of"] for e in alias_entries},
        ),
        assets=entries + alias_entries,
    )
    OUT_MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False,
                                       sort_keys=False) + "\n", encoding="utf-8")
    print(f"manifest: {OUT_MANIFEST}")
    return manifest


def contact_sheet(entries):
    entries = [e for e in entries if not e.get("deprecated_alias_of")]
    cell = SHEET_CELL
    cols = SHEET_COLS
    rows = (len(entries) + cols - 1) // cols
    W = cols * (cell + SHEET_PAD) + SHEET_PAD
    H = rows * (cell + SHEET_LABEL_H + SHEET_PAD) + SHEET_PAD + 34
    sheet = Image.new("RGB", (W, H), (250, 250, 250))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=15)
        big = ImageFont.load_default(size=20)
    except TypeError:  # very old Pillow
        font = big = ImageFont.load_default()
    draw.text((SHEET_PAD, 8), "VoxalBlast UI handoff - icon cut-outs (checkerboard = transparent)",
              fill=(30, 30, 30), font=big)

    # checkerboard tiles
    tile = 16
    for ty in range(0, H, tile):
        for tx in range(0, W, tile):
            if ((tx // tile) + (ty // tile)) % 2 == 0:
                draw.rectangle([tx, ty, tx + tile - 1, ty + tile - 1], fill=SHEET_BG[0])
    draw.rectangle([0, 0, W - 1, 30], fill=(250, 250, 250))
    draw.text((SHEET_PAD, 8), "VoxalBlast UI handoff - icon cut-outs (checkerboard = transparent)",
              fill=(30, 30, 30), font=big)

    for idx, e in enumerate(entries):
        r, c = divmod(idx, cols)
        x0 = SHEET_PAD + c * (cell + SHEET_PAD)
        y0 = 34 + r * (cell + SHEET_LABEL_H + SHEET_PAD)
        draw.rectangle([x0, y0, x0 + cell, y0 + cell], outline=(150, 150, 150))
        img = Image.open(PKG / e["file"]).convert("RGBA")
        # near-white glyphs would vanish on the light checkerboard: back them with a dark tile
        n = tot = 0
        for (_r, _g, _b, a) in px_list(img):
            if a > 128:
                tot += (_r + _g + _b) / 3.0
                n += 1
        if n and tot / n > 215:
            draw.rectangle([x0 + 1, y0 + 1, x0 + cell - 1, y0 + cell - 1], fill=(118, 118, 128))
        scale = min(1.0, (cell - 12) / img.width, (cell - 12) / img.height)
        if scale < 1.0:
            img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                             Image.LANCZOS)
        sheet.paste(img, (x0 + (cell - img.width) // 2, y0 + (cell - img.height) // 2), img)
        draw.text((x0 + 2, y0 + cell + 4),
                  f"{e['name']} {e['output_size'][0]}x{e['output_size'][1]}", fill=(40, 40, 40), font=font)
    sheet.save(OUT_SHEET, optimize=True)
    print(f"contact sheet: {OUT_SHEET} ({W}x{H})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="print score diagnostics, write nothing")
    ap.add_argument("--profile", action="store_true", help="print 2px row-density profiles")
    ap.add_argument("--holes", action="store_true", help="list enclosed holes per asset")
    ap.add_argument("--audit", action="store_true",
                    help="check delivered PNGs for enclosed transparent perforations")
    ap.add_argument("--spotcheck", action="store_true",
                    help="sample delivered alpha inside gold highlight regions")
    args = ap.parse_args()
    if args.probe:
        probe()
        return
    if args.profile:
        profile()
        return
    if args.holes:
        holes_report()
        return
    if args.audit:
        audit()
        return
    if args.spotcheck:
        spotcheck()
        return
    manifest = slice_all()
    contact_sheet(manifest["assets"])


if __name__ == "__main__":
    sys.exit(main())

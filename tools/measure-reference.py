"""Measure the reference target with the SAME quantities R0 measured on our render.

Why this exists: BLOCK_REFERENCE_REWORK_HANDOFF §1.1 states the reference's size relations
are "视觉拆解与建议，不是对原图的精密参数反演", and §5.3 asks for the real CSS px FIRST.
So the handoff's scale claims (§3 P1 备选尺度, §5.3) have to be replaced by measurement
before R1 acts on them. Everything here is reported in the reference's own 941px width AND
normalised to a 390px frame, because a px figure without its frame width is not comparable
to our 390-wide capture.

  python tools/measure-reference.py <reference.png>

Colour classes are deliberately coarse and stated, not tuned per image:
  saturated  s > 0.50 and v > 0.55   -> a painted block face
  cream      v > 0.88 and s < 0.35   -> the tray panel / the bare timber blocks
"""
import colorsys
import sys
from PIL import Image

NORM_W = 390.0  # our R0 capture width


def classes(image):
    width, height = image.size
    pixels = image.load()
    hue = [[0.0] * width for _ in range(height)]
    sat = [[0.0] * width for _ in range(height)]
    val = [[0.0] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            r, g, b = (channel / 255.0 for channel in pixels[x, y])
            h, s, v = colorsys.rgb_to_hsv(r, g, b)
            hue[y][x], sat[y][x], val[y][x] = h, s, v
    return hue, sat, val


def bbox(hue, sat, val, region, predicate):
    x0, y0, x1, y1 = region
    min_x, min_y, max_x, max_y, count = x1, y1, x0, y0, 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            if predicate(hue[y][x], sat[y][x], val[y][x]):
                count += 1
                min_x, max_x = min(min_x, x), max(max_x, x)
                min_y, max_y = min(min_y, y), max(max_y, y)
    if not count:
        return None
    return {"x0": min_x, "y0": min_y, "x1": max_x, "y1": max_y,
            "w": max_x - min_x + 1, "h": max_y - min_y + 1, "px": count}


def in_hue(h, low, high):
    return (low <= h <= high) if low <= high else (h >= low or h <= high)


def show(label, box, frame_width, cols=None, rows=None, indent="     "):
    if not box:
        print(f"{indent}{label}: NOT FOUND")
        return
    scale = NORM_W / frame_width
    line = (f"{indent}{label}: x {box['x0']}..{box['x1']}  y {box['y0']}..{box['y1']}"
            f"  {box['w']}x{box['h']} px  ({box['px']} px hit)")
    if cols and rows:
        line += (f"\n{indent}    cell pitch {box['w'] / cols:.1f} x {box['h'] / rows:.1f} px"
                 f"  |  at 390px wide: {box['w'] / cols * scale:.2f} x {box['h'] / rows * scale:.2f} px")
    print(line)


def main():
    path = sys.argv[1]
    image = Image.open(path).convert("RGB")
    width, height = image.size
    print(f"reference {path}\n  {width}x{height}  (normalised to {NORM_W:.0f}px wide below)")
    hue, sat, val = classes(image)

    # ---- [1] the candidate tray panel --------------------------------------
    cream = lambda h, s, v: v > 0.88 and s < 0.35
    rows = []
    for y in range(int(height * 0.70), height):
        hits = sum(1 for x in range(width) if cream(hue[y][x], sat[y][x], val[y][x]))
        if hits > width * 0.60:
            rows.append(y)
    print(f"\n[1] candidate tray panel")
    if not rows:
        raise SystemExit("     tray not found")
    # The panel is contiguous; take the longest contiguous run so the grass below does
    # not get folded in.
    runs, start = [], rows[0]
    for previous, current in zip(rows, rows[1:]):
        if current != previous + 1:
            runs.append((start, previous))
            start = current
    runs.append((start, rows[-1]))
    tray_y0, tray_y1 = max(runs, key=lambda r: r[1] - r[0])
    tray_x = bbox(hue, sat, val, (0, tray_y0, width, tray_y1 + 1), cream)
    show("panel (cream interior rows)", {"x0": tray_x["x0"], "x1": tray_x["x1"], "y0": tray_y0,
                                         "y1": tray_y1, "w": tray_x["w"], "h": tray_y1 - tray_y0 + 1,
                                         "px": tray_x["px"]}, width)
    print(f"     panel height {(tray_y1 - tray_y0 + 1) / height * 100:.1f}% of frame; "
          f"tray bottom {tray_y1} vs frame {height}"
          f"  -> {(height - tray_y1) / height * 100:.1f}% of the frame sits below the tray")

    # ---- [2] the three candidate shapes ------------------------------------
    print(f"\n[2] candidate shapes (inside the tray band)")
    third = width // 3
    shapes = [("slot 1  blue L  (3 wide x 2 tall)", (0, third), (0.52, 0.63), 3, 2),
              ("slot 2  green S (3 wide x 2 tall)", (third, 2 * third), (0.28, 0.45), 3, 2),
              ("slot 3  purple 9 (3 x 3)", (2 * third, width), (0.68, 0.88), 3, 3)]
    pitches = []
    for label, (x0, x1), band, cols, rows_n in shapes:
        box = bbox(hue, sat, val, (x0, tray_y0, x1, tray_y1 + 1),
                   lambda h, s, v, b=band: s > 0.50 and v > 0.55 and in_hue(h, *b))
        show(label, box, width, cols, rows_n)
        if box:
            pitches.append(box["w"] / cols)
    if pitches:
        print(f"     cross-shape cell pitch spread: {min(pitches):.1f}..{max(pitches):.1f} px"
              f"  ({(max(pitches) - min(pitches)) / max(pitches) * 100:.1f}%)")

    # ---- [3] the cube silhouette -------------------------------------------
    # The backdrop is a busy illustration, so "not background" cannot be a colour test.
    # The cube is the only large HARD-EDGED opaque mass: per row, look for the longest run
    # of pixels that are either strongly saturated or pale cream, and require it to be wide.
    print(f"\n[3] cube silhouette (longest saturated/cream run per row)")
    solid = lambda h, s, v: (s > 0.50 and v > 0.55) or (v > 0.88 and s < 0.35)
    left, right, top, bottom = width, 0, 0, 0
    for y in range(int(height * 0.10), int(height * 0.72)):
        run = best = 0
        best_x = 0
        for x in range(width):
            if solid(hue[y][x], sat[y][x], val[y][x]):
                run += 1
                if run > best:
                    best, best_x = run, x
            else:
                run = 0
        if best > width * 0.30:
            left, right = min(left, best_x - best + 1), max(right, best_x)
            top = top or y
            bottom = y
    if right > left:
        print(f"     x {left}..{right} ({right - left + 1} px = {100 * (right - left + 1) / width:.1f}% of frame width)")
        print(f"     y {top}..{bottom} ({bottom - top + 1} px = {100 * (bottom - top + 1) / height:.1f}% of frame height)")

    # ---- [4] one block face, in profile ------------------------------------
    # §3 P1's claim about OUR blocks ("面中心大块泛白／颜色分成内外两层") has a measurable
    # form: the luminance spread across ONE flat face of one block. Report the reference's
    # spread over the same quantity so R1 can gate on a number.
    print(f"\n[4] single block face luminance profile (0-255, over one block)")
    # A blue board block on the front face: find a saturated blue region inside the cube band
    # and take a horizontal strip through its middle.
    blue = bbox(hue, sat, val, (0, int(height * 0.35), width, int(height * 0.70)),
                lambda h, s, v: s > 0.55 and v > 0.55 and in_hue(h, 0.55, 0.64))
    if blue:
        mid = (blue["y0"] + blue["y1"]) // 2
        strip = [sum(image.getpixel((x, mid))) / 3.0 for x in range(blue["x0"], blue["x1"] + 1)]
        strip.sort()
        print(f"     blue cluster {blue['w']}x{blue['h']} px; strip at y={mid}, {len(strip)} px wide")
        print(f"     min {strip[0]:.0f}  p10 {strip[len(strip) // 10]:.0f}  p50 {strip[len(strip) // 2]:.0f}"
              f"  p90 {strip[len(strip) * 9 // 10]:.0f}  max {strip[-1]:.0f}"
              f"   spread {strip[-1] - strip[0]:.0f}  (p10..p90 {strip[len(strip) * 9 // 10] - strip[len(strip) // 10]:.0f})")


main()

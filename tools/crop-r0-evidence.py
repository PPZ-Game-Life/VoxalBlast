"""R0 evidence crops for BLOCK_REFERENCE_REWORK_HANDOFF §9.

Crops the already-captured full frames into the four evidence classes the handoff asks
for (full screen / single block at 1:1 / candidates at 1:1 / rotation middle frames),
plus the 240px board thumbnail §4.3 grades first.

This script MEASURES nothing of its own: every box comes from the screenshot driver's
own DOM/geometry probe (artifacts/visual-r0/metrics-*.txt), so a crop cannot silently
disagree with the reported layout. Device pixel ratio is 1 on these captures, so CSS px
and PNG px are the same number -- asserted below rather than assumed.

  python tools/crop-r0-evidence.py
"""
import json
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R0 = os.path.join(ROOT, "artifacts", "visual-r0")
OUT = os.path.join(R0, "crops")


def load_probe(path, width):
    """The driver prints one JSON probe line per shot; keep the one at this viewport."""
    with open(path, encoding="utf-16") as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith("{"):
                continue
            probe = json.loads(line)
            if probe["viewport"]["width"] == width:
                return probe
    raise SystemExit(f"{path}: no probe at width {width}")


def box(rect, pad=0):
    return (round(rect["x"] - pad), round(rect["y"] - pad),
            round(rect["x"] + rect["width"] + pad), round(rect["y"] + rect["height"] + pad))


def crop(src, dest, rect, caption):
    image = Image.open(src)
    if image.width != image.height * 0 and image.mode != "RGB":
        image = image.convert("RGB")
    piece = image.crop(box(rect))
    piece.save(dest)
    print(f"OK   {os.path.relpath(dest, ROOT)}  {piece.width}x{piece.height}  {caption}")


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("mobile-color-a", "color-a", "metrics-color-a.txt", 390, "v0.9.32-mobile-board.png"),
        ("mobile-empty", "empty", "metrics-empty.txt", 390, "v0.9.32-mobile-board.png"),
        ("desktop-color-a", "color-a", "metrics-color-a.txt", 1440, "v0.9.32-desktop-board.png"),
    ]
    for label, folder, metrics, width, frame in jobs:
        probe = load_probe(os.path.join(R0, metrics), width)
        assert probe["devicePixelRatio"] == 1, f"{label}: DPR is not 1, CSS px != PNG px"
        frame_path = os.path.join(R0, folder, frame)

        # 1. candidates at 1:1 -- the tray, exactly as the layout reports it.
        crop(frame_path, os.path.join(OUT, f"candidates-1to1-{label}.png"), probe["trayMetrics"],
             f"{label} candidate tray at 1:1")

        # 2. single block at 1:1 -- three lattice cells square, centred on the play face,
        #    measured from the board's OWN on-screen cell pitch rather than eyeballed.
        cell = probe["boardCellPx"]
        solid = probe["framing"]["solid"]
        side = round(cell * 3)
        centre_x = (solid["minX"] + solid["maxX"]) / 2
        # The play face sits below the roof band; a third of the way down the silhouette is
        # inside the front face for this dock pose.
        centre_y = solid["minY"] + (solid["maxY"] - solid["minY"]) * 0.58
        rect = {"x": centre_x - side / 2, "y": centre_y - side / 2, "width": side, "height": side}
        crop(frame_path, os.path.join(OUT, f"block-1to1-{label}.png"), rect,
             f"{label} {side}px = {cell}px/cell x 3 cells at 1:1")

        # 3. the 240px board thumbnail §4.3 grades before the phone pixels.
        image = Image.open(frame_path).convert("RGB")
        thumb = image.crop((
            round(solid["minX"] - cell * 0.6), round(solid["minY"] - cell * 0.6),
            round(solid["maxX"] + cell * 0.6), round(solid["maxY"] + cell * 0.6)))
        thumb = thumb.resize((240, round(240 * thumb.height / thumb.width)), Image.LANCZOS)
        dest = os.path.join(OUT, f"board-240-{label}.png")
        thumb.save(dest)
        print(f"OK   {os.path.relpath(dest, ROOT)}  {thumb.width}x{thumb.height}  {label} board at 240px wide")

    # 4. rotation middle frames already exist as the reflection sweep's pose PNGs; report
    #    them rather than copying, so the sweep's own JSON stays the record of the pose.
    sweep = os.path.join(R0, "color-a-sweep")
    for name in sorted(os.listdir(sweep)):
        if "-reflection-" in name:
            size = Image.open(os.path.join(sweep, name)).size
            print(f"POSE {os.path.relpath(os.path.join(sweep, name), ROOT)}  {size[0]}x{size[1]}")


main()

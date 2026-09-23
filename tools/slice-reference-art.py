"""Slice generated UI art, preserving the source alpha. No runtime processing."""
from pathlib import Path
from PIL import Image
import json
import sys

source = Path(sys.argv[1])
target = Path(__file__).resolve().parents[1] / 'public/art/reference'
target.mkdir(parents=True, exist_ok=True)
atlas = Image.open(source).convert('RGBA')
# Authored bounds: generation preserved the rows but enlarged the two panels.
regions = {
    'refresh': (62, 50, 370, 357), 'hammer': (430, 50, 738, 357),
    'rocket': (799, 50, 1107, 357), 'bomb': (1167, 50, 1475, 357),
    'sound': (20, 390, 368, 699), 'help': (430, 390, 738, 699),
    'settings': (797, 390, 1180, 700), 'crown': (1200, 432, 1480, 670),
    'score-panel': (10, 701, 516, 996), 'tray': (515, 765, 1017, 950),
    'button': (1025, 744, 1270, 980), 'star': (1290, 753, 1509, 980),
}
manifest = {}
for name, bounds in regions.items():
    crop = atlas.crop(bounds)
    crop.save(target / f'{name}.png', optimize=True)
    manifest[name] = {'sourceBounds': bounds, 'size': crop.size}
(target / 'slices.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Saved {len(regions)} RGBA slices in {target}')

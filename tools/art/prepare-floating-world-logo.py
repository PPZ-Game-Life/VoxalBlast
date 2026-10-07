"""Prepare supplied original logo artwork; no network, game runtime or third-party API.
Usage: python tools/art/prepare-floating-world-logo.py <magenta-source.png>
Requires Pillow. Recreates only the three known logo outputs in this pack.
"""
from pathlib import Path
import sys
from PIL import Image

root = Path(__file__).resolve().parents[2]
source = Path(sys.argv[1])
image = Image.open(source).convert('RGB')
output = root / 'public/art/floating-world-v1/brand'
output.mkdir(parents=True, exist_ok=True)
pixels = []
data = image.get_flattened_data() if hasattr(image, 'get_flattened_data') else image.getdata()
for r, g, b in data:
    excess = min(r, b) - g
    alpha = 1.0 if excess <= 15 else max(0.0, (145.0 - excess) / 130.0)
    if alpha <= 0.005:
        pixels.append((0, 0, 0, 0))
    else:
        # Unmatte the generated magenta fringe; legitimate artwork has no magenta.
        rr = round(max(0, min(255, (r - (1-alpha)*255) / alpha)))
        gg = round(max(0, min(255, g / alpha)))
        bb = round(max(0, min(255, (b - (1-alpha)*255) / alpha)))
        pixels.append((rr, gg, bb, round(alpha*255)))
rgba = Image.new('RGBA', image.size)
rgba.putdata(pixels)
bounds = rgba.getchannel('A').getbbox()
if not bounds:
    raise RuntimeError('Keying removed all artwork')
rgba = rgba.crop(bounds)
pad = 24
padded = Image.new('RGBA', (rgba.width + pad*2, rgba.height + pad*2), (0, 0, 0, 0))
padded.alpha_composite(rgba, (pad, pad))
for width in (512, 1024):
    resized = padded.resize((width, round(padded.height * width / padded.width)), Image.Resampling.LANCZOS)
    resized.save(output / f'logo-{width}.png', optimize=True)
    if width == 1024:
        resized.save(output / 'logo-1024.webp', lossless=True, method=6)
    alpha = resized.getchannel('A')
    print(f'logo-{width}: {resized.size}, alpha range {alpha.getextrema()}')
print('Key source:', source)

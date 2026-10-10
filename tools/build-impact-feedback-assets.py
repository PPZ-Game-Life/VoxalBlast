#!/usr/bin/env python3
"""Build and deeply validate VoxalBlast Impact Feedback V2 production assets.

Editable SVG/JSON under docs/assets/impact-feedback-v2/sources are source of truth.
Raster output uses offline Edge at 4x followed by Pillow LANCZOS. --check is
strictly read-only and validates hashes, frame policy, animation cleanup, and GLB.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import deque
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps, __version__ as PILLOW_VERSION

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "docs" / "assets" / "impact-feedback-v2"
SOURCES = PACK / "sources"
RUNTIME = PACK / "runtime"
MANIFEST = PACK / "manifest.json"
CHECKS = PACK / "asset-checks.json"
PREVIEW = PACK / "preview.png"
CONTACT = PACK / "contact-sheet.png"
SAMPLER = PACK / "motion-sampler.webp"
SUPERSAMPLE = 4
BLEED = 4
CLEAR_BORDER = 4
PALETTE = {
    "navy": "#20334C", "blue": "#2F70E8", "teal": "#18BBA6",
    "pink": "#E65B86", "cream": "#FFF1CC", "warmGold": "#E2A62B",
    "sky": "#8ED8FF",
}
SEQUENCES = {
    "sweep-right": {
        "source": "sweep-right.svg", "frame": [256, 128], "count": 4,
        "durationsMs": [35, 35, 35, 35], "pivot": [0.92578125, 0.5],
        "frameIntervalsNormalized": [[0.0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.0]],
        "direction": "+X", "visibleHeightCells": 0.65, "designLengthCells": 1.4,
        "role": "filled fan-head directional clear brush; fixed head pivot follows branch travel progress",
    },
    "endpoint-pop": {
        "source": "endpoint-pop.svg", "frame": [128, 128], "count": 6,
        "durationsMs": [18, 22, 26, 26, 24, 24], "pivot": [0.5, 0.5],
        "role": "endpoint starburst one-shot; shape expands, breaks into rays, contracts",
    },
    "tap-feedback": {
        "source": "tap-feedback.svg", "frame": [128, 128], "count": 4,
        "durationsMs": [60, 35, 35, 30], "pivot": [0.5, 0.5],
        "reducedMotionFrame": 1, "reducedMotionHoldMs": 80,
        "role": "neutral default tap dot/ring; fixed center",
    },
}
MODEL_VARIANTS = {
    "blue": ["#62A5FF", "#2F70E8", "#1E54BE"],
    "teal": ["#55D9C8", "#18BBA6", "#0B877A"],
    "pink": ["#F38EAC", "#E65B86", "#B73E67"],
}
MODEL_FILES = ["cube.glb", "cube-blue.glb", "cube-teal.glb", "cube-pink.glb"]
RENDER_STATE: dict[str, Any] = {}


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.replace("\r\n", "\n").replace("\r", "\n"), encoding="utf-8", newline="\n")


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def canonical_bytes(path: Path) -> bytes:
    raw = path.read_bytes()
    if path.suffix.lower() in {".svg", ".json", ".md", ".py"}:
        return raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    return raw


def record(path: Path, kind: str) -> dict[str, Any]:
    raw = canonical_bytes(path)
    return {"path": path.relative_to(ROOT).as_posix(), "kind": kind, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def find_edge() -> Path:
    for candidate in (
        Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
        Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
    ):
        if candidate.exists():
            return candidate
    raise RuntimeError("Microsoft Edge offline SVG raster backend was not found")


def edge_version(edge: Path) -> str:
    try:
        result = subprocess.run([str(edge), "--version"], capture_output=True, text=True, timeout=8)
        return (result.stdout or result.stderr).strip() or "unknown"
    except subprocess.TimeoutExpired:
        return f"version query timed out; executableBytes={edge.stat().st_size}"


def raster_svg(source: Path, target_size: tuple[int, int]) -> Image.Image:
    edge = find_edge()
    hi_w, hi_h = target_size[0] * SUPERSAMPLE, target_size[1] * SUPERSAMPLE
    markup = source.read_text(encoding="utf-8")
    html = (
        "<!doctype html><meta charset='utf-8'><style>html,body{margin:0;background:transparent;overflow:hidden;}"
        f"html,body{{width:{hi_w}px;height:{hi_h}px}}svg{{display:block;width:{hi_w}px!important;height:{hi_h}px!important}}</style>" + markup
    )
    with tempfile.TemporaryDirectory(prefix="vox-impact-v2-") as td:
        td = Path(td)
        page, output, profile = td / "render.html", td / "render.png", td / "edge-profile"
        page.write_text(html, encoding="utf-8")
        command = [str(edge), "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--disable-extensions",
                   "--default-background-color=00000000", f"--user-data-dir={profile}", f"--window-size={hi_w},{hi_h}",
                   f"--screenshot={output}", page.resolve().as_uri()]
        done = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
        if done.returncode != 0 or not output.exists():
            raise RuntimeError(f"Edge SVG raster failed for {source.name}: exit {done.returncode}")
        with Image.open(output) as opened:
            hi = opened.convert("RGBA")
    if hi.size != (hi_w, hi_h):
        raise RuntimeError(f"Edge returned {hi.size}, expected {(hi_w, hi_h)}")
    RENDER_STATE.update({"backend": "Microsoft Edge headless SVG", "edgePath": str(edge), "edgeVersion": edge_version(edge),
                         "outputAt4x": [hi_w, hi_h], "pillow": PILLOW_VERSION})
    return hi.resize(target_size, Image.Resampling.LANCZOS)


def bleed_rgb(image: Image.Image, radius: int = BLEED) -> Image.Image:
    rgba = image.convert("RGBA")
    w, h = rgba.size
    pixels = list(rgba.get_flattened_data())
    alpha = [p[3] for p in pixels]
    distance = [-1] * len(pixels)
    queue: deque[int] = deque()
    for i, a in enumerate(alpha):
        if a:
            distance[i] = 0
            queue.append(i)
    neighbors = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))
    while queue:
        i = queue.popleft()
        if distance[i] >= radius:
            continue
        x, y = i % w, i // w
        rgb = pixels[i][:3]
        for dx, dy in neighbors:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                ni = ny * w + nx
                if distance[ni] == -1:
                    distance[ni] = distance[i] + 1
                    pixels[ni] = (*rgb, alpha[ni])
                    queue.append(ni)
    rgba.putdata(pixels)
    return rgba


def alpha_bounds(image: Image.Image) -> list[int] | None:
    box = image.getchannel("A").getbbox()
    return list(box) if box else None


def sequence_metadata(name: str, spec: dict[str, Any], frames: list[Image.Image]) -> dict[str, Any]:
    fw, fh = spec["frame"]
    measured = [alpha_bounds(frame) for frame in frames]
    union = [min(b[0] for b in measured), min(b[1] for b in measured),
             max(b[2] for b in measured), max(b[3] for b in measured)]
    entries = []
    for i, bounds in enumerate(measured):
        x = i * fw
        entry = {
            "index": i, "rect": {"x": x, "y": 0, "width": fw, "height": fh, "origin": "top-left pixels"},
            "pivot": spec["pivot"], "durationMs": spec["durationsMs"][i],
            "contentAlphaBoundsMeasuredOnly": bounds,
            "uvTopLeft": [x / (fw * len(frames)), 0.0, (x + fw) / (fw * len(frames)), 1.0],
            "uvBottomLeft": [x / (fw * len(frames)), 0.0, (x + fw) / (fw * len(frames)), 1.0],
        }
        if "frameIntervalsNormalized" in spec:
            entry["travelProgressInterval"] = spec["frameIntervalsNormalized"][i]
        entries.append(entry)
    metadata = {
        "schemaVersion": 3, "id": name, "image": f"{name}.png", "sheetSize": [fw * len(frames), fh],
        "layout": {"columns": len(frames), "rows": 1, "frameSize": [fw, fh], "order": "left-to-right"},
        "texture": {"colorSpace": "sRGB", "alphaMode": "straight/unassociated RGBA", "premultipliedAlpha": False,
                    "generateMipmaps": False, "minFilter": "LinearFilter", "magFilter": "LinearFilter",
                    "wrapS": "ClampToEdgeWrapping", "wrapT": "ClampToEdgeWrapping", "depthWrite": False},
        "normalization": {"unionAlphaBounds": union, "referenceAlphaBounds": union,
                          "policy": "fixed union bounds for every frame; never rescale or recenter from per-frame measured bounds"},
        "playback": {"loop": False, "cleanupAfterLastFrame": True, "totalDurationMs": sum(spec["durationsMs"])},
        "role": spec["role"], "frames": entries,
    }
    if name == "sweep-right":
        metadata["playback"] = {
            "loop": False, "cleanupAfterLastFrame": True, "driver": "branchTravelProgress",
            "frameIntervalsNormalized": spec["frameIntervalsNormalized"],
            "nominalArtCycleDurationMs": sum(spec["durationsMs"]),
            "nominalDurationsAreAuthoritative": False,
            "authority": "feedback.recipe.json sweep startMs/speedCellsPerSecond/endMaxMs and actual branch arrival",
        }
        metadata["placement"] = {
            "defaultDirection": "+X", "headAnchorNormalized": spec["pivot"], "headAnchorLocalPx": [237, 64],
            "leadingTipMaxLocalX": 240, "maxLeadingExtentFromAnchorPx": 3,
            "mirrorForNegativeDirection": True, "rotateAroundHeadAnchor": True,
            "visibleHeightNormalizationCells": spec["visibleHeightCells"], "designLengthCells": spec["designLengthCells"],
            "rayRevealClip": {"worldInterval": "branch origin..advancing leading tip", "localLeadingExtentPx": 3,
                              "purpose": "clip tail/ribs outside traveled interval so no branch appears behind the placement origin before arrival"},
            "scaleContract": "Scale from fixed normalization.referenceAlphaBounds to 1.4 cell wide x 0.65 cell high; do not compensate each frame and do not stretch to row length.",
        }
    if name == "tap-feedback":
        metadata["reducedMotion"] = {"frameIndex": spec["reducedMotionFrame"], "holdMs": spec["reducedMotionHoldMs"], "animate": False,
                                     "policy": "static frame 1; hold is separate from the 160ms animated sequence"}
    return metadata


def build_sequences() -> tuple[dict[str, list[Image.Image]], list[dict[str, Any]]]:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    all_frames: dict[str, list[Image.Image]] = {}
    source_records: list[dict[str, Any]] = []
    for name, spec in SEQUENCES.items():
        source = SOURCES / spec["source"]
        fw, fh = spec["frame"]
        sheet = raster_svg(source, (fw * spec["count"], fh))
        frames = []
        rebuilt = Image.new("RGBA", sheet.size)
        for i in range(spec["count"]):
            frame = bleed_rgb(sheet.crop((i * fw, 0, (i + 1) * fw, fh)))
            frames.append(frame)
            rebuilt.paste(frame, (i * fw, 0))
        png = RUNTIME / f"{name}.png"
        meta = RUNTIME / f"{name}.json"
        rebuilt.save(png, "PNG", optimize=True)
        write_text(meta, json_text(sequence_metadata(name, spec, frames)))
        all_frames[name] = frames
        source_records.append(record(source, "editable vector animation source"))
    return all_frames, source_records


def srgb_channel_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def linear_channel_to_srgb(value: float) -> float:
    return value * 12.92 if value <= 0.0031308 else 1.055 * (value ** (1 / 2.4)) - 0.055


def hex_rgb_linear(value: str) -> list[float]:
    value = value.lstrip("#")
    return [srgb_channel_to_linear(int(value[i:i + 2], 16) / 255.0) for i in (0, 2, 4)]


def rounded_cube_geometry(segments: int = 6, radius: float = 0.12) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]], list[list[int]]]:
    faces = [
        ((1, 0, 0), (0, 0, -1), (0, 1, 0), 2), ((-1, 0, 0), (0, 0, 1), (0, 1, 0), 2),
        ((0, 1, 0), (1, 0, 0), (0, 0, -1), 0), ((0, -1, 0), (1, 0, 0), (0, 0, 1), 2),
        ((0, 0, 1), (1, 0, 0), (0, 1, 0), 1), ((0, 0, -1), (-1, 0, 0), (0, 1, 0), 2),
    ]
    positions: list[tuple[float, float, float]] = []
    normals: list[tuple[float, float, float]] = []
    groups: list[list[int]] = [[], [], []]  # top/front/side tone
    inner = 0.5 - radius
    for normal, udir, vdir, material_group in faces:
        start = len(positions)
        for j in range(segments + 1):
            v = -0.5 + j / segments
            for i in range(segments + 1):
                u = -0.5 + i / segments
                p = tuple(normal[k] * 0.5 + udir[k] * u + vdir[k] * v for k in range(3))
                q = tuple(max(-inner, min(inner, c)) for c in p)
                d = tuple(p[k] - q[k] for k in range(3))
                length = math.sqrt(sum(c * c for c in d))
                n = tuple(c / length for c in d)
                out = tuple(q[k] + n[k] * radius for k in range(3))
                positions.append(out)
                normals.append(n)
        for j in range(segments):
            for i in range(segments):
                a = start + j * (segments + 1) + i
                b, c, d = a + 1, a + segments + 2, a + segments + 1
                groups[material_group].extend((a, b, c, a, c, d))
    return positions, normals, groups


def pad4(data: bytes, fill: bytes = b"\0") -> bytes:
    return data + fill * ((-len(data)) % 4)


def make_glb(variant: str, colors: list[str]) -> bytes:
    positions, normals, groups = rounded_cube_geometry()
    vertex_colors = [[1.0, 1.0, 1.0] for _ in positions]
    for tone_index, group in enumerate(groups):
        tone = hex_rgb_linear(colors[tone_index])
        for vertex_index in set(group):
            vertex_colors[vertex_index] = tone
    indices = [index for group in groups for index in group]
    chunks = [
        b"".join(struct.pack("<3f", *p) for p in positions),
        b"".join(struct.pack("<3f", *n) for n in normals),
        b"".join(struct.pack("<3f", *c) for c in vertex_colors),
        b"".join(struct.pack("<H", i) for i in indices),
    ]
    offsets, binary = [], b""
    for chunk in chunks:
        binary = pad4(binary)
        offsets.append(len(binary))
        binary += chunk
    views = [
        {"buffer": 0, "byteOffset": offsets[0], "byteLength": len(chunks[0]), "target": 34962},
        {"buffer": 0, "byteOffset": offsets[1], "byteLength": len(chunks[1]), "target": 34962},
        {"buffer": 0, "byteOffset": offsets[2], "byteLength": len(chunks[2]), "target": 34962},
        {"buffer": 0, "byteOffset": offsets[3], "byteLength": len(chunks[3]), "target": 34963},
    ]
    accessors = [
        {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3", "min": [-0.5] * 3, "max": [0.5] * 3},
        {"bufferView": 1, "componentType": 5126, "count": len(normals), "type": "VEC3"},
        {"bufferView": 2, "componentType": 5126, "count": len(vertex_colors), "type": "VEC3"},
        {"bufferView": 3, "componentType": 5123, "count": len(indices), "type": "SCALAR", "min": [min(indices)], "max": [max(indices)]},
    ]
    material = {"name": f"cube-{variant}-vertex-color", "pbrMetallicRoughness": {"baseColorFactor": [1.0, 1.0, 1.0, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.72}, "doubleSided": False, "alphaMode": "OPAQUE"}
    gltf = {
        "asset": {"version": "2.0", "generator": "VoxalBlast impact-feedback-v2 deterministic rounded-box generator"},
        "scene": 0, "scenes": [{"name": f"Cube {variant.title()} Variant", "nodes": [0]}],
        "nodes": [{"name": f"Cube_{variant.title()}", "mesh": 0}],
        "meshes": [{"name": f"RoundedCube_{variant.title()}", "primitives": [
            {"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "indices": 3, "material": 0, "mode": 4}
        ]}],
        "materials": [material], "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
        "extras": {"nominalUnitDimensions": [1, 1, 1], "pivot": [0, 0, 0], "cornerRadius": 0.12,
                   "variant": variant, "colorPolicy": "linear-light COLOR_0 converted from source sRGB hex; white linear baseColorFactor; no textures"},
    }
    json_chunk = pad4(json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), b" ")
    bin_chunk = pad4(binary)
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    return struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk + struct.pack("<I4s", len(bin_chunk), b"BIN\0") + bin_chunk


def build_models() -> None:
    for variant, colors in MODEL_VARIANTS.items():
        data = make_glb(variant, colors)
        (RUNTIME / f"cube-{variant}.glb").write_bytes(data)
        if variant == "blue":
            (RUNTIME / "cube.glb").write_bytes(data)


def font(size: int) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def checker(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], step: int = 12) -> None:
    x0, y0, x1, y1 = box
    for y in range(y0, y1, step):
        for x in range(x0, x1, step):
            draw.rectangle((x, y, min(x + step, x1), min(y + step, y1)), fill=(242, 242, 242, 255) if ((x-x0)//step+(y-y0)//step)%2 == 0 else (190, 202, 214, 255))


def draw_model(image: Image.Image, box: tuple[int, int, int, int], model_path: Path) -> None:
    """Software-project the actual GLB POSITION/indices/COLOR_0 resources."""
    gltf, binary = parse_glb(model_path)
    primitive = gltf["meshes"][0]["primitives"][0]
    positions = accessor_values(gltf, binary, primitive["attributes"]["POSITION"])
    colors_linear = accessor_values(gltf, binary, primitive["attributes"]["COLOR_0"])
    indices = accessor_values(gltf, binary, primitive["indices"])
    colors = [tuple(round(max(0.0, min(1.0, linear_channel_to_srgb(v))) * 255) for v in color) + (255,) for color in colors_linear]
    yaw, pitch = -0.68, 0.52
    transformed = []
    for x, y, z in positions:
        x1, z1 = x * math.cos(yaw) + z * math.sin(yaw), -x * math.sin(yaw) + z * math.cos(yaw)
        y2, z2 = y * math.cos(pitch) - z1 * math.sin(pitch), y * math.sin(pitch) + z1 * math.cos(pitch)
        transformed.append((x1, y2, z2))
    tris = []
    for k in range(0, len(indices), 3):
        ids = indices[k:k+3]
        tris.append((sum(transformed[i][2] for i in ids)/3, ids))
    tris.sort(reverse=True)
    draw = ImageDraw.Draw(image, "RGBA")
    x0, y0, x1, y1 = box
    scale, cx, cy = min(x1-x0, y1-y0) * 0.7, (x0+x1)/2, (y0+y1)/2
    for _, ids in tris:
        poly = [(cx + transformed[i][0]*scale, cy - transformed[i][1]*scale) for i in ids]
        signed_area = sum(poly[i][0]*poly[(i+1)%3][1]-poly[(i+1)%3][0]*poly[i][1] for i in range(3))
        if signed_area >= 0:
            continue
        fill = tuple(round(sum(colors[i][channel] for i in ids) / 3) for channel in range(4))
        draw.polygon(poly, fill=fill)


def create_contact(frames: dict[str, list[Image.Image]]) -> Image.Image:
    out = Image.new("RGBA", (1440, 650), "#FFF8E5")
    draw = ImageDraw.Draw(out)
    draw.text((30, 20), "Impact Feedback V2 / frame contact sheet", fill=PALETTE["navy"], font=font(30))
    y = 78
    for name, sequence in frames.items():
        draw.text((30, y + 46), name, fill=PALETTE["navy"], font=font(19))
        x = 200
        display = (192, 96) if name == "sweep-right" else (96, 96)
        for i, frame in enumerate(sequence):
            checker(draw, (x, y, x + display[0], y + display[1]), 10)
            thumb = frame.resize(display, Image.Resampling.LANCZOS)
            out.alpha_composite(thumb, (x, y))
            label = (f"f{i} / p{SEQUENCES[name]['frameIntervalsNormalized'][i][0]:.2f}-{SEQUENCES[name]['frameIntervalsNormalized'][i][1]:.2f}"
                     if name == "sweep-right" else f"f{i} / {SEQUENCES[name]['durationsMs'][i]}ms")
            draw.text((x, y + display[1] + 5), label, fill="#42566F", font=font(14))
            x += display[0] + 18
        y += 170
    draw.text((30, 625), "14 resource frames. Sweep labels are travel-progress intervals; endpoint totals 140ms; tap totals 160ms. Fixed pivots + union normalization.", fill="#607086", font=font(14))
    return out


def create_preview(frames: dict[str, list[Image.Image]]) -> Image.Image:
    out = Image.new("RGBA", (1440, 1080), "#FFF8E5")
    draw = ImageDraw.Draw(out)
    draw.text((32, 18), "VoxalBlast / Impact Feedback V2 / OFFLINE ART SAMPLE", fill=PALETTE["navy"], font=font(32))
    draw.text((32, 56), "NOT GAME CAPTURE - 96px-cell section is enlarged inspection, not a phone-actual-size claim", fill="#42566F", font=font(17))
    bgs = [("cream", "#FFF1CC"), ("sky", "#8ED8FF"), ("navy", "#20334C"), ("checker", None)]
    for i, (label, color) in enumerate(bgs):
        x0, y0, x1, y1 = 32 + i*348, 92, 360 + i*348, 300
        if color: draw.rounded_rectangle((x0, y0, x1, y1), radius=22, fill=color)
        else: checker(draw, (x0, y0, x1, y1), 18)
        draw.text((x0+12, y0+10), f"{label} / enlarged 96px cell", fill="#20334C" if color != "#20334C" else "#FFF1CC", font=font(14))
        sweep = frames["sweep-right"][2].resize((134, 62), Image.Resampling.LANCZOS)
        out.alpha_composite(sweep, (x0+92, y0+38))
        out.alpha_composite(frames["endpoint-pop"][2].resize((82,82), Image.Resampling.LANCZOS), (x0+46, y0+116))
        out.alpha_composite(frames["tap-feedback"][1].resize((64,64), Image.Resampling.LANCZOS), (x0+215, y0+126))
    draw.text((32, 320), "ACTUAL CSS-PIXEL COMPARISON / sweep 1.4 x 0.65 cell / cube visible edge 0.44 cell", fill=PALETTE["navy"], font=font(21))
    for i, cell in enumerate((24, 32, 48)):
        x0, y0 = 70 + i*455, 365
        draw.rounded_rectangle((x0, y0, x0+390, y0+168), radius=18, fill="#8ED8FF", outline="#D6C9A3", width=2)
        draw.text((x0+16, y0+12), f"cellPitch = {cell}px (1:1 pixels)", fill="#20334C", font=font(16))
        gx, gy = x0+30, y0+74
        for c in range(5):
            draw.rectangle((gx+c*cell, gy, gx+(c+1)*cell-1, gy+cell-1), fill="#FFF1CC", outline="#20334C", width=1)
        sw, sh = round(1.4*cell), round(0.65*cell)
        sprite = frames["sweep-right"][2].resize((sw, sh), Image.Resampling.LANCZOS)
        out.alpha_composite(sprite, (gx+2*cell-round(0.92578125*sw), gy+(cell-sh)//2))
        edge = round(0.44*cell)
        draw_model(out, (x0+315-edge//2, gy+cell//2-edge//2, x0+315+edge//2, gy+cell//2+edge//2), RUNTIME/"cube-blue.glb")
        draw.text((x0+16, y0+138), f"sweep {sw}x{sh}px / cube edge {edge}px", fill="#42566F", font=font(14))
    draw.text((32, 560), "ACTUAL GLB SOFTWARE PREVIEW / one primitive + one material + linear COLOR_0 / unit rounded geometry", fill=PALETTE["navy"], font=font(20))
    variant_x = [80, 500, 920]
    for name, x in zip(MODEL_VARIANTS, variant_x):
        draw.rounded_rectangle((x, 600, x+360, 935), radius=26, fill="#FFFFFF", outline="#D6C9A3", width=3)
        draw_model(out, (x+34, 620, x+326, 860), RUNTIME/f"cube-{name}.glb")
        draw.text((x+118, 882), f"Cube_{name.title()}", fill=PALETTE["navy"], font=font(20))
    draw.text((32, 968), "Fixed sweep pivot (237,64); measured leading alpha <=240 (max +3px). Normalize every frame from union bounds, never per-frame bounds.", fill="#42566F", font=font(16))
    draw.text((32, 1000), "Source: editable SVG + deterministic GLB. Reproduction: offline Edge 4x + Pillow LANCZOS; model panels project actual GLB buffers in software.", fill="#42566F", font=font(15))
    draw.text((32, 1048), "Inspection-only; no GPU, hardware, haptic, camera, or actual-game capture claim.", fill="#607086", font=font(14))
    return out


def board_base() -> Image.Image:
    out = Image.new("RGBA", (960, 540), "#8ED8FF")
    draw = ImageDraw.Draw(out)
    draw.rounded_rectangle((0, 390, 960, 540), radius=0, fill="#FFF1CC")
    draw.text((30, 22), "OFFLINE ART SAMPLE / NOT GAME CAPTURE", fill="#20334C", font=font(22))
    cell, ox, oy = 68, 310, 96
    draw.rounded_rectangle((ox-18, oy-18, ox+5*cell+18, oy+5*cell+18), radius=28, fill="#FFFFFFCC", outline="#20334C", width=5)
    for r in range(5):
        for c in range(5):
            x, y = ox+c*cell, oy+r*cell
            draw.rounded_rectangle((x+4,y+4,x+cell-4,y+cell-4), radius=12, fill="#FFF1CC", outline="#20334C", width=3)
    return out


SAMPLER_DURATIONS_MS = [400, 35, 20, 20, 20, 18, 18, 22, 26, 26, 24, 24, 140, 140, 350, 60, 35, 35, 30, 500]


def sampler_frame(index: int, frames: dict[str, list[Image.Image]]) -> Image.Image:
    out = board_base(); draw = ImageDraw.Draw(out)
    cell, ox, oy, row = 68, 310, 96, 2
    if index <= 14:
        for c, color in enumerate(("#2F70E8", "#18BBA6", "#E65B86", "#2F70E8", "#18BBA6")):
            x, y = ox+c*cell, oy+row*cell
            draw.rounded_rectangle((x+5,y+5,x+cell-5,y+cell-5), radius=11, fill=color, outline="#20334C", width=3)
    if index == 0:
        draw.text((30, 470), "REVIEW HOLD 400ms / BEFORE EFFECT", fill="#20334C", font=font(18))
    elif index == 1:
        draw.ellipse((ox+2.5*cell-8, oy+row*cell+cell/2-8, ox+2.5*cell+8, oy+row*cell+cell/2+8), fill="#FFF1CC", outline="#20334C", width=3)
        draw.text((30, 470), "PLACEMENT START DELAY 35ms / CENTER ORIGIN", fill="#20334C", font=font(18))
    elif 2 <= index <= 5:
        phase = index - 2
        progress = (phase + 1) / 4
        f = frames["sweep-right"][phase]
        sprite = f.resize((round(1.4*cell), round(0.65*cell)), Image.Resampling.LANCZOS)
        center = ox + 2.5*cell
        right_head = center + progress*2.5*cell
        out.alpha_composite(sprite, (round(right_head - 0.92578125*sprite.width), oy+row*cell+(cell-sprite.height)//2))
        left = ImageOps.mirror(sprite)
        left_head = center - progress*2.5*cell
        out.alpha_composite(left, (round(left_head - (1-0.92578125)*sprite.width), oy+row*cell+(cell-sprite.height)//2))
        draw.text((30, 470), "REAL SPEED: 2.5-cell branch / 32 cell/s = 78ms; frames follow travel progress", fill="#20334C", font=font(16))
    elif 6 <= index <= 11:
        phase = index - 6
        pop = frames["endpoint-pop"][phase].resize((96,96), Image.Resampling.LANCZOS)
        out.alpha_composite(pop, (ox-48, oy+row*cell-14)); out.alpha_composite(pop, (ox+5*cell-48, oy+row*cell-14))
        drift = phase * 5
        cube_specs = [
            (ox-72-drift, oy+row*cell-8-drift//2, "blue"), (ox-50-drift//2, oy+row*cell+48+drift//3, "teal"),
            (ox+5*cell+35+drift, oy+row*cell-10-drift//3, "pink"), (ox+5*cell+12+drift//2, oy+row*cell+48+drift//2, "blue"),
        ]
        for cx, cy, variant in cube_specs:
            draw_model(out, (cx-16, cy-16, cx+16, cy+16), RUNTIME/f"cube-{variant}.glb")
        draw.text((30, 470), "ENDPOINT POP: 6 resource frames / exact 140ms + actual-GLB cubes (0.47 cell)", fill="#20334C", font=font(16))
    elif 12 <= index <= 13:
        alpha_scale = 1.0 if index == 12 else 0.7
        for cx, cy, variant in ((ox-78,oy+row*cell,"blue"),(ox+5*cell+50,oy+row*cell,"pink")):
            layer=Image.new("RGBA",out.size); draw_model(layer,(cx-16,cy-16,cx+16,cy+16),RUNTIME/f"cube-{variant}.glb")
            layer.putalpha(layer.getchannel("A").point(lambda a: round(a*alpha_scale))); out.alpha_composite(layer)
        draw.text((30, 470), "CUBE TAIL: two 140ms samples; transient clear reaches 420ms single-clear end", fill="#20334C", font=font(16))
    elif index == 14:
        draw.text((30, 470), "REVIEW HOLD 350ms / SETTLED CLEAN 5x5 / ALL TRANSIENTS REMOVED", fill="#20334C", font=font(16))
    elif 15 <= index <= 18:
        tap = frames["tap-feedback"][index-15].resize((74,74), Image.Resampling.LANCZOS)
        draw.rounded_rectangle((70,145,250,335),radius=24,fill="#FFF8E5",outline="#20334C",width=3)
        draw.text((103,168),"TAP ONLY",fill="#20334C",font=font(18)); out.alpha_composite(tap,(123,218))
        draw.text((30,470),"ISOLATED TAP: 60+35+35+30 = 160ms / NOT A CLEAR EVENT",fill="#20334C",font=font(17))
    else:
        draw.text((30, 470), "REVIEW HOLD 500ms / LAST CLEAN FRAME / NO PERSISTENT SPRITES", fill="#20334C", font=font(16))
    draw.text((876, 24), f"{index+1:02d}/20", fill="#20334C", font=font(14))
    return out


def create_sampler(frames: dict[str, list[Image.Image]]) -> list[Image.Image]:
    return [sampler_frame(i, frames) for i in range(len(SAMPLER_DURATIONS_MS))]


def parse_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    data = path.read_bytes()
    if len(data) < 28:
        raise ValueError("too short")
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or total != len(data):
        raise ValueError("bad GLB header/version/length")
    json_len, json_type = struct.unpack_from("<I4s", data, 12)
    if json_type != b"JSON": raise ValueError("missing JSON chunk")
    gltf = json.loads(data[20:20+json_len].decode("utf-8"))
    pos = 20 + json_len
    bin_len, bin_type = struct.unpack_from("<I4s", data, pos)
    if bin_type != b"BIN\0": raise ValueError("missing BIN chunk")
    binary = data[pos+8:pos+8+bin_len]
    return gltf, binary


def accessor_values(gltf: dict[str, Any], binary: bytes, index: int) -> list[tuple[float, ...] | int]:
    acc = gltf["accessors"][index]; view = gltf["bufferViews"][acc["bufferView"]]
    component = acc["componentType"]; width = {"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4}[acc["type"]]
    fmt, size = {5123:("H",2),5125:("I",4),5126:("f",4)}[component]
    offset = view.get("byteOffset",0) + acc.get("byteOffset",0)
    stride = view.get("byteStride", size*width)
    out = []
    for i in range(acc["count"]):
        values = struct.unpack_from("<"+fmt*width, binary, offset+i*stride)
        out.append(values[0] if width == 1 else values)
    return out


def validate_glb(path: Path) -> dict[str, Any]:
    gltf, binary = parse_glb(path)
    errors = []
    if gltf.get("asset",{}).get("version") != "2.0": errors.append("asset.version")
    if gltf.get("buffers",[{}])[0].get("byteLength",0) > len(binary): errors.append("buffer byteLength")
    primitives = gltf["meshes"][0]["primitives"]
    materials = gltf.get("materials", [])
    if len(primitives) != 1: errors.append("must have exactly one primitive")
    if len(materials) != 1: errors.append("must have exactly one material")
    primitive = primitives[0]
    if "COLOR_0" not in primitive.get("attributes", {}): errors.append("missing COLOR_0")
    positions = accessor_values(gltf,binary,primitive["attributes"]["POSITION"])
    normals = accessor_values(gltf,binary,primitive["attributes"]["NORMAL"])
    colors = accessor_values(gltf,binary,primitive["attributes"]["COLOR_0"])
    indices = accessor_values(gltf,binary,primitive["indices"])
    if len(positions) != len(normals) or len(positions) != len(colors): errors.append("attribute count mismatch")
    if any(not math.isfinite(v) for p in positions for v in p): errors.append("position NaN/inf")
    if any(not math.isfinite(v) or v < 0 or v > 1 for c in colors for v in c): errors.append("COLOR_0 not finite linear [0,1]")
    if any(abs(math.sqrt(sum(v*v for v in n))-1)>1e-4 for n in normals): errors.append("non-unit normal")
    if any(i<0 or i>=len(positions) for i in indices): errors.append("index out of bounds")
    if len(indices)%3: errors.append("non-triangle index count")
    mins=[min(p[i] for p in positions) for i in range(3)]; maxs=[max(p[i] for p in positions) for i in range(3)]
    dims=[maxs[i]-mins[i] for i in range(3)]
    if any(abs(mins[i]+0.5)>1e-5 or abs(maxs[i]-0.5)>1e-5 for i in range(3)): errors.append("bbox must be [-.5,.5]")
    if any(abs(v-1.0)>1e-5 for v in dims): errors.append("not nominal unit size")
    if any(abs((mins[i]+maxs[i])/2)>1e-6 for i in range(3)): errors.append("pivot not centered")
    if any(key in gltf for key in ("textures","images","samplers")): errors.append("textures/images/samplers forbidden")
    pbr = materials[0].get("pbrMetallicRoughness", {}) if materials else {}
    if pbr.get("baseColorFactor") != [1.0,1.0,1.0,1.0] or any("Texture" in key for key in pbr): errors.append("linear white baseColorFactor/no texture")
    material_names=[m.get("name") for m in materials]
    if errors: raise ValueError(", ".join(errors))
    return {"bytes":path.stat().st_size,"vertexCount":len(positions),"triangleCount":len(indices)//3,"primitiveCount":len(primitives),
            "materialCount":len(materials),"colorAccessor":"COLOR_0 VEC3 float linear","colorFiniteAndInRange":True,"textureCount":0,
            "normalCount":len(normals),"allNormalsUnit":True,"indicesInBounds":True,"containsNaN":False,
            "bbox":{"min":mins,"max":maxs,"dimensions":dims},"pivot":[0,0,0],"materialNames":material_names}


def frame_border_zero(frame: Image.Image, border: int = CLEAR_BORDER) -> bool:
    a=frame.getchannel("A"); w,h=frame.size
    return all(a.getpixel((x,y))==0 for y in range(h) for x in range(w) if x<border or y<border or x>=w-border or y>=h-border)


def verify(check_manifest: bool = True) -> dict[str, Any]:
    errors=[]; sequence_results={}
    for name,spec in SEQUENCES.items():
        source=SOURCES/spec["source"]
        try:
            root=ET.parse(source).getroot(); vb=root.attrib.get("viewBox")
            if vb != f"0 0 {spec['frame'][0]*spec['count']} {spec['frame'][1]}": errors.append(f"{name}: SVG viewBox")
            low=source.read_text(encoding="utf-8").lower()
            if any(token in low for token in ("<image","<text","<filter","foreignobject")): errors.append(f"{name}: forbidden SVG feature")
        except Exception as exc: errors.append(f"{name}: SVG parse {exc}")
        png=RUNTIME/f"{name}.png"; meta_path=RUNTIME/f"{name}.json"
        if not png.exists() or not meta_path.exists(): errors.append(f"{name}: missing runtime sheet/metadata"); continue
        with Image.open(png) as opened:
            if opened.mode!="RGBA": errors.append(f"{name}: PNG mode {opened.mode}")
            sheet=opened.convert("RGBA")
        fw,fh=spec["frame"]
        if sheet.size != (fw*spec["count"],fh): errors.append(f"{name}: dimensions")
        meta=json.loads(meta_path.read_text(encoding="utf-8"))
        if meta.get("sheetSize")!=list(sheet.size) or meta.get("texture",{}).get("alphaMode")!="straight/unassociated RGBA": errors.append(f"{name}: metadata policy")
        if meta.get("playback",{}).get("cleanupAfterLastFrame") is not True: errors.append(f"{name}: cleanup contract")
        details=[]; measured_bounds=[]
        for i in range(spec["count"]):
            frame=sheet.crop((i*fw,0,(i+1)*fw,fh)); alpha=list(frame.getchannel("A").get_flattened_data()); pix=list(frame.get_flattened_data())
            bounds=alpha_bounds(frame); measured_bounds.append(bounds); partial=any(0<a<255 for a in alpha); bleed=sum(1 for r,g,b,a in pix if a==0 and (r or g or b))
            if bounds is None or not partial or not frame_border_zero(frame) or bleed==0: errors.append(f"{name} frame {i}: alpha/border/bleed")
            if meta["frames"][i].get("contentAlphaBoundsMeasuredOnly")!=bounds or meta["frames"][i].get("pivot")!=spec["pivot"]: errors.append(f"{name} frame {i}: bounds/pivot metadata")
            details.append({"index":i,"contentAlphaBoundsMeasuredOnly":bounds,"zeroAlphaBorderPx":CLEAR_BORDER,"hasPartialAlpha":partial,"transparentRgbBleedPixels":bleed})
        expected_union=[min(b[0] for b in measured_bounds),min(b[1] for b in measured_bounds),max(b[2] for b in measured_bounds),max(b[3] for b in measured_bounds)]
        normalization=meta.get("normalization",{})
        if normalization.get("unionAlphaBounds")!=expected_union or normalization.get("referenceAlphaBounds")!=expected_union: errors.append(f"{name}: fixed union normalization")
        if name=="sweep-right":
            placement=meta.get("placement",{}); playback=meta.get("playback",{})
            if placement.get("visibleHeightNormalizationCells")!=0.65 or placement.get("designLengthCells")!=1.4 or placement.get("headAnchorNormalized")!=[0.92578125,0.5]: errors.append("sweep placement contract")
            if placement.get("leadingTipMaxLocalX")!=240 or playback.get("driver")!="branchTravelProgress" or playback.get("nominalDurationsAreAuthoritative") is not False: errors.append("sweep travel/leading-tip contract")
            union=normalization.get("unionAlphaBounds",[0,0,0,0])
            if not (230 <= union[2]-union[0] <= 242 and 104 <= union[3]-union[1] <= 116): errors.append("sweep union target approximately 235x109")
        elif name=="endpoint-pop" and meta.get("playback",{}).get("totalDurationMs")!=140:
            errors.append("endpoint-pop must total 140ms")
        elif name=="tap-feedback" and meta.get("playback",{}).get("totalDurationMs")!=160:
            errors.append("tap-feedback must total 160ms")
        sequence_results[name]={"sheetSize":list(sheet.size),"frameCount":spec["count"],"unionAlphaBounds":expected_union,"frames":details}
    feedback_expected = {
        "schemaVersion": 1,
        "units": {"time":"ms","worldSize":"cell","screenSize":"CSSpx","normalizedAge":"0..1"},
        "proposalNotRuntimeVerified": True,
        "sweep": {"startMs":35,"speedCellsPerSecond":32,"endMaxMs":200,"visibleHeightCells":0.65,"lengthCells":1.4},
        "burst": {"burstDurationMs":140},
        "cube": {"visibleEdgeCells":[0.36,0.52],"holdScaleUntilNormalizedAge":0.45,"clearEndMs":{"single":420,"multi":480}},
        "tap": {"diameterCssPx":[24,36],"durationMs":160,"pressDotMs":60,"staticReducedMs":80,"maxConcurrent":2},
        "cameraShake": {"normalizedCurve":[[0,0],[0.12,1],[0.28,-0.55],[0.48,0.28],[0.72,-0.1],[1,0]],
            "maxDisplacementCssPx":{"place":0,"single":1.2,"double":2,"threePlus":3},
            "durationMs":{"single":90,"double":110,"threePlus":140},"reducedMotionDisabled":True,"compose":"max-not-sum"},
        "haptics": {"patternsMs":{"tap":[],"place":[6],"single":[12],"double":[18],"threePlus":[14,20,14]},
            "sourceCapTotalMs":48,"cancelOnScopeExit":True,"preferenceIndependentOfReducedMotion":True,
            "integrationPolicy":{"directVibrateCall":False,"ordinaryScreenTapRecommendedDisabledValue":0,
                "note":"Configuration delivery only. Route through the integration-owned haptics adapter; never call vibrate directly."}},
        "clearBudgets": {"schema":"severity-by-quality-v1","severityOrder":["single","double","threePlus"],
            "perClearEvent":{"cubes":{"standard":[4,6,8],"low":[2,3,4]},
                             "endpointPops":{"standard":[2,4,6],"low":[1,2,3]},
                             "secondarySprites":{"standard":[6,8,10],"low":[2,3,4]}},
            "maxClearEvents":2,
            "globalLiveCaps":{"cubes":{"standard":16,"low":8},"endpointPops":{"standard":12,"low":6},"secondarySprites":{"standard":20,"low":8}},
            "faceRays":{"maxPerEvent":120,"derivation":"6 faces * 60 raw lines * 2","countsAgainstDecorativePool":False}},
    }
    try:
        feedback_source=json.loads((SOURCES/"feedback.recipe.json").read_text(encoding="utf-8"))
        feedback_runtime=json.loads((RUNTIME/"feedback.recipe.json").read_text(encoding="utf-8"))
        if feedback_source != feedback_expected: errors.append("editable feedback recipe differs from approved contract")
        if feedback_runtime != feedback_source: errors.append("runtime feedback recipe differs from editable source")
    except Exception as exc: errors.append(f"feedback recipe: {exc}")
    recipe=json.loads((SOURCES/"cube-recipe.json").read_text(encoding="utf-8"))
    if recipe.get("geometry",{}).get("nominalDimensions") != [1.0,1.0,1.0]: errors.append("cube recipe nominal dimensions")
    model_results={}
    for filename in MODEL_FILES:
        try: model_results[filename]=validate_glb(RUNTIME/filename)
        except Exception as exc: errors.append(f"{filename}: {exc}")
    if (RUNTIME/"cube.glb").exists() and (RUNTIME/"cube-blue.glb").exists() and (RUNTIME/"cube.glb").read_bytes()!=(RUNTIME/"cube-blue.glb").read_bytes():
        errors.append("cube.glb must remain a byte-identical blue alias")
    for path,size in ((PREVIEW,(1440,1080)),(CONTACT,(1440,650))):
        try:
            with Image.open(path) as im:
                if im.size!=size: errors.append(f"{path.name}: dimensions")
        except Exception as exc: errors.append(f"{path.name}: decode {exc}")
    sampler_ok=False
    try:
        with Image.open(SAMPLER) as im:
            count=getattr(im,"n_frames",1)
            if im.size!=(960,540) or count!=len(SAMPLER_DURATIONS_MS): errors.append("motion sampler dimensions/frame count")
            im.seek(count-1); last=im.convert("RGBA")
            # Final frame is deterministic and contains no transient art in board center cell area.
            probe=(310+2*68+34,96+2*68+34)
            if last.getpixel(probe)[:3] != (255,241,204): errors.append("motion sampler final cleanup probe")
            sampler_ok=(im.size==(960,540) and count==len(SAMPLER_DURATIONS_MS))
    except Exception as exc: errors.append(f"motion sampler decode {exc}")
    manifest_hashes=False; runtime_bytes=0
    if check_manifest:
        try:
            manifest=json.loads(MANIFEST.read_text(encoding="utf-8")); manifest_hashes=True
            for item in manifest["files"]:
                p=ROOT/item["path"]
                if not p.exists(): manifest_hashes=False; errors.append(f"manifest missing {item['path']}"); continue
                actual=record(p,item["kind"])
                if actual["bytes"]!=item["bytes"] or actual["sha256"]!=item["sha256"]: manifest_hashes=False; errors.append(f"manifest hash mismatch {item['path']}")
            forbidden_manifest_tokens=("/references/","/ASSETS.md","/asset-checks.json","tools/build-impact-feedback-assets.py")
            if any(any(token in item["path"] for token in forbidden_manifest_tokens) for item in manifest["files"]): errors.append("docs/checks/builder/references included in manifest")
            runtime_bytes=sum(item["bytes"] for item in manifest["files"] if "/runtime/" in item["path"])
            if manifest.get("networkBytes",{}).get("runtimeTotal")!=runtime_bytes: errors.append("runtime network bytes")
            expected_excluded=["ASSETS.md","asset-checks.json","tools/build-impact-feedback-assets.py","references/**"]
            if manifest.get("scope",{}).get("excluded") != expected_excluded: errors.append("manifest exclusion policy")
        except Exception as exc: errors.append(f"manifest: {exc}")
    if errors: raise RuntimeError("Asset checks failed:\n- "+"\n- ".join(errors))
    return {"svgSourcesParsed":len(SEQUENCES),"sequenceSheets":sequence_results,"glbModels":model_results,
            "feedbackRecipe":{"approvedValuesExact":True,"sourceRuntimeExactMatch":True,"schemaVersion":1,
                              "units":{"time":"ms","worldSize":"cell","screenSize":"CSSpx"},"proposalNotRuntimeVerified":True,
                              "directVibrateCall":False,"clearBudgetSchema":"severity-by-quality-v1"},
            "previewDecoded":True,"contactSheetDecoded":True,
            "motionSampler":{"decoded":sampler_ok,"frames":len(SAMPLER_DURATIONS_MS),"realSpeedSweepMs":78,"burstMs":140,"tapMs":160,"finalCleanupProbe":True},
            "manifestBytesAndSha256":manifest_hashes,"runtimeNetworkBytes":runtime_bytes,"referencesExcluded":True}


def build() -> None:
    feedback_source = SOURCES / "feedback.recipe.json"
    feedback_recipe = json.loads(feedback_source.read_text(encoding="utf-8"))
    RUNTIME.mkdir(parents=True, exist_ok=True)
    write_text(RUNTIME / "feedback.recipe.json", json_text(feedback_recipe))
    frames, source_records = build_sequences()
    build_models()
    create_contact(frames).save(CONTACT,"PNG",optimize=True)
    create_preview(frames).save(PREVIEW,"PNG",optimize=True)
    sampler=create_sampler(frames)
    sampler[0].save(SAMPLER,"WEBP",save_all=True,append_images=sampler[1:],duration=SAMPLER_DURATIONS_MS,loop=0,lossless=True,method=6)
    files=[]
    files.extend(source_records)
    files.append(record(SOURCES/"cube-recipe.json","editable deterministic rounded-cube source recipe"))
    files.append(record(SOURCES/"feedback.recipe.json","editable proposed feedback timing/sizing configuration"))
    files.append(record(RUNTIME/"feedback.recipe.json","runtime proposed feedback timing/sizing configuration"))
    for name in SEQUENCES:
        files.append(record(RUNTIME/f"{name}.png","runtime transparent RGBA animation sheet"))
        files.append(record(RUNTIME/f"{name}.json","runtime animation metadata"))
    for filename in MODEL_FILES: files.append(record(RUNTIME/filename,"runtime GLB 2.0 rounded cube model"))
    files += [record(PREVIEW,"inspection preview; not runtime"),record(CONTACT,"animation frame contact sheet; not runtime"),record(SAMPLER,"offline animated WebP motion sampler; not runtime")]
    runtime_records=[item for item in files if "/runtime/" in item["path"]]
    texture_records=[item for item in runtime_records if item["path"].endswith((".png",".json"))]
    model_records=[item for item in runtime_records if item["path"].endswith(".glb")]
    manifest={
        "schemaVersion":2,"packId":"impact-feedback-v2","artSource":"Original deterministic SVG geometry and generated rounded-box mesh; no concept screenshot pixels are cut, traced, or shipped.",
        "scope":{"included":["sources/*.svg","sources/cube-recipe.json","sources/feedback.recipe.json","runtime/**","preview.png","contact-sheet.png","motion-sampler.webp"],"excluded":["ASSETS.md","asset-checks.json","tools/build-impact-feedback-assets.py","references/**"],
                 "referencesPolicy":"Builder never reads, hashes, copies, writes, or budgets references/**."},
        "palette":PALETTE,"rasterization":{"backend":RENDER_STATE,"supersample":SUPERSAMPLE,"downsample":"Pillow LANCZOS","transparentRgbDilationPx":BLEED,"alpha":"straight/unassociated","colorSpace":"sRGB"},
        "networkBytes":{"scope":"runtime/ only; source/docs/preview/contact/sampler/reference excluded","runtimeTotal":sum(i["bytes"] for i in runtime_records),
                        "spriteSheetsAndMetadata":sum(i["bytes"] for i in texture_records),"allFourGlbFilesIncludingDefaultAlias":sum(i["bytes"] for i in model_records),
                        "recommendedFullThreeColorExcludingAlias":sum(i["bytes"] for i in texture_records)+sum(i["bytes"] for i in model_records if not i["path"].endswith("/cube.glb")),
                        "typicalDefaultBlueOnly":sum(i["bytes"] for i in texture_records)+next(i["bytes"] for i in model_records if i["path"].endswith("/cube.glb"))},
        "sequences":{name:f"runtime/{name}.json" for name in SEQUENCES},
        "models":{"default":"runtime/cube.glb","blue":"runtime/cube-blue.glb","teal":"runtime/cube-teal.glb","pink":"runtime/cube-pink.glb","source":"sources/cube-recipe.json"},
        "feedbackRecipe":{"runtime":"runtime/feedback.recipe.json","source":"sources/feedback.recipe.json","proposalNotRuntimeVerified":True},
        "inspection":{"preview":"preview.png","contactSheet":"contact-sheet.png","motionSampler":"motion-sampler.webp","samplerIsGameIntegration":False},
        "files":files,
    }
    write_text(MANIFEST,json_text(manifest))
    verified=verify(True)
    checks={"schemaVersion":2,"command":"py -3.12 tools/build-impact-feedback-assets.py --check","passed":True,
            "environment":{"python":platform.python_version(),"pillow":PILLOW_VERSION,"rasterBackend":RENDER_STATE},"verified":verified,
            "limits":{"gameRuntimeIntegration":False,"GPUThreeJsLoad":False,"devicePerformance":False,"cameraAndHaptics":"configuration only; no hardware verification"}}
    write_text(CHECKS,json_text(checks))


def parse_args() -> argparse.Namespace:
    parser=argparse.ArgumentParser(description="Build/check VoxalBlast Impact Feedback V2 production art pack")
    mode=parser.add_mutually_exclusive_group(); mode.add_argument("--build",action="store_true"); mode.add_argument("--check",action="store_true")
    return parser.parse_args()


def main() -> int:
    args=parse_args()
    try:
        if args.check:
            result=verify(True); print(f"PASS: read-only validation of 3 sheets, 14 resource frames, {len(result['glbModels'])} GLBs, hashes, and {len(SAMPLER_DURATIONS_MS)}-frame cleanup sampler.")
        else:
            build(); print("PASS: built Impact Feedback V2 from editable SVG/JSON sources with offline Edge + 4x LANCZOS.")
        return 0
    except Exception as exc:
        print(str(exc),file=sys.stderr); return 1


if __name__=="__main__": raise SystemExit(main())

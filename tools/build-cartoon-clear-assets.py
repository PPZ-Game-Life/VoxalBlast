#!/usr/bin/env python3
"""Build and validate the VoxalBlast cartoon clear VFX asset pack.

The editable SVG files are the only art sources. The builder rasterizes each
source at 4x, downsamples with LANCZOS, adds a four-pixel RGB color bleed while
preserving alpha, and assembles the runtime atlas and inspection preview.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
import tempfile
from collections import deque
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

try:
    from PIL import Image, ImageDraw, ImageFont, __version__ as PILLOW_VERSION
except ImportError as exc:  # pragma: no cover - environment diagnostic
    raise SystemExit(f"Missing existing runtime module: {exc}. No dependency install is performed.")

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "docs" / "assets" / "cartoon-clear-v1"
SOURCES = PACK / "sources"
RUNTIME = PACK / "runtime"
SPRITES = RUNTIME / "sprites"
ATLAS_PNG = RUNTIME / "atlas.png"
ATLAS_JSON = RUNTIME / "atlas.json"
PREVIEW = PACK / "preview.png"
MANIFEST = PACK / "manifest.json"
CHECKS = PACK / "asset-checks.json"

TILE = 128
SUPERSAMPLE = 4
ATLAS_SIZE = (512, 256)
BLEED_PIXELS = 4
OUTER_CLEAR = 12

ASSETS = [
    ("confetti-blue", "rounded blue square confetti"),
    ("confetti-teal", "rounded teal square confetti"),
    ("confetti-pink", "rounded pink square confetti"),
    ("star-pop", "primary cream star pop with warm-gold edge"),
    ("sparkle-cream", "secondary four-point cream sparkle"),
    ("dot-blue", "small blue circular accent"),
    ("swoosh-cream", "short curved cream ejection trail, points +X"),
    ("dash-blue", "short blue ejection dash, points +X"),
]

PALETTE = {
    "outlineDeepBlue": "#20334C",
    "blue": "#2F70E8",
    "teal": "#18BBA6",
    "pink": "#E65B86",
    "cream": "#FFF1CC",
    "starWarmGoldEdge": "#E2A62B",
}

RENDER_STATE: dict[str, Any] = {
    "backend": None,
    "cairoSvgVersion": None,
    "cairoNativeAvailable": False,
    "cairoDiagnostic": None,
}


def write_text_lf(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text.replace("\r\n", "\n").replace("\r", "\n"))


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def canonical_bytes(path: Path) -> bytes:
    raw = path.read_bytes()
    if path.suffix.lower() in {".svg", ".json", ".md", ".py"}:
        text = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        return text.encode("utf-8")
    return raw


def file_record(path: Path, kind: str) -> dict[str, Any]:
    data = canonical_bytes(path)
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "kind": kind,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def bleed_transparent_rgb(image: Image.Image, radius: int = BLEED_PIXELS) -> Image.Image:
    """Expand nearest visible RGB into transparent pixels without changing alpha."""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = list(rgba.get_flattened_data())
    original_alpha = [pixel[3] for pixel in pixels]
    distance = [-1] * (width * height)
    queue: deque[int] = deque()

    for index, alpha in enumerate(original_alpha):
        if alpha > 0:
            distance[index] = 0
            queue.append(index)

    neighbours = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))
    while queue:
        index = queue.popleft()
        if distance[index] >= radius:
            continue
        x, y = index % width, index // width
        source_rgb = pixels[index][:3]
        for dx, dy in neighbours:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < width and 0 <= ny < height):
                continue
            neighbour_index = ny * width + nx
            if distance[neighbour_index] != -1:
                continue
            distance[neighbour_index] = distance[index] + 1
            pixels[neighbour_index] = (*source_rgb, original_alpha[neighbour_index])
            queue.append(neighbour_index)

    rgba.putdata(pixels)
    return rgba


def find_edge() -> Path:
    candidates = [
        Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
        Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError("Cairo native library is unavailable and Microsoft Edge fallback was not found")


def rasterize_with_edge(source: Path) -> Image.Image:
    edge = find_edge()
    size = TILE * SUPERSAMPLE
    svg_markup = source.read_text(encoding="utf-8")
    html = (
        "<!doctype html><meta charset=\"utf-8\">"
        f"<style>html,body{{margin:0;width:{size}px;height:{size}px;overflow:hidden;background:transparent}}"
        f"svg{{display:block;width:{size}px!important;height:{size}px!important}}</style>"
        + svg_markup
    )
    with tempfile.TemporaryDirectory(prefix="voxalblast-cartoon-clear-") as temp_dir_text:
        temp_dir = Path(temp_dir_text)
        html_path = temp_dir / "render.html"
        output_path = temp_dir / "render.png"
        profile_path = temp_dir / "edge-profile"
        html_path.write_text(html, encoding="utf-8")
        command = [
            str(edge),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--disable-extensions",
            "--default-background-color=00000000",
            f"--user-data-dir={profile_path}",
            f"--window-size={size},{size}",
            f"--screenshot={output_path}",
            html_path.resolve().as_uri(),
        ]
        completed = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        if completed.returncode != 0 or not output_path.exists():
            raise RuntimeError(f"Edge SVG rasterization failed with exit code {completed.returncode}")
        with Image.open(output_path) as opened:
            rendered = opened.convert("RGBA")
        if rendered.size != (size, size):
            raise RuntimeError(f"Edge raster size {rendered.size}, expected {(size, size)}")
        return rendered


def rasterize_svg(source: Path) -> Image.Image:
    import io

    high_res: Image.Image
    if RENDER_STATE["backend"] in (None, "CairoSVG"):
        try:
            import cairosvg

            png_bytes = cairosvg.svg2png(
                url=str(source),
                output_width=TILE * SUPERSAMPLE,
                output_height=TILE * SUPERSAMPLE,
            )
            high_res = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
            RENDER_STATE.update(
                backend="CairoSVG",
                cairoSvgVersion=getattr(cairosvg, "__version__", "unknown"),
                cairoNativeAvailable=True,
                cairoDiagnostic=None,
            )
        except (ImportError, OSError) as exc:
            RENDER_STATE.update(
                backend="Microsoft Edge headless SVG fallback",
                cairoNativeAvailable=False,
                cairoDiagnostic=f"{type(exc).__name__}: {exc}",
            )
            high_res = rasterize_with_edge(source)
    else:
        high_res = rasterize_with_edge(source)

    downsampled = high_res.resize((TILE, TILE), Image.Resampling.LANCZOS)
    return bleed_transparent_rgb(downsampled)


def alpha_bounds(image: Image.Image) -> list[int]:
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("image has no non-zero alpha")
    return list(bounds)  # left/top inclusive, right/bottom exclusive


def create_atlas(sprite_images: dict[str, Image.Image]) -> tuple[Image.Image, dict[str, Any]]:
    atlas = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
    entries: dict[str, Any] = {}
    atlas_width, atlas_height = ATLAS_SIZE

    for index, (asset_id, role) in enumerate(ASSETS):
        x = (index % 4) * TILE
        y = (index // 4) * TILE
        atlas.paste(sprite_images[asset_id], (x, y))
        top_v0 = y / atlas_height
        top_v1 = (y + TILE) / atlas_height
        entries[asset_id] = {
            "role": role,
            "rect": {"x": x, "y": y, "width": TILE, "height": TILE, "origin": "top-left pixels"},
            "pivot": [0.5, 0.5],
            "alphaBounds": alpha_bounds(sprite_images[asset_id]),
            "uvRectTopLeft": {
                "u0": x / atlas_width,
                "v0": top_v0,
                "u1": (x + TILE) / atlas_width,
                "v1": top_v1,
            },
            "uvBottomLeft": {
                "u0": x / atlas_width,
                "v0": 1.0 - top_v1,
                "u1": (x + TILE) / atlas_width,
                "v1": 1.0 - top_v0,
            },
        }

    metadata = {
        "schemaVersion": 1,
        "image": "atlas.png",
        "size": {"width": atlas_width, "height": atlas_height},
        "tileSize": {"width": TILE, "height": TILE},
        "layout": {"columns": 4, "rows": 2, "order": [item[0] for item in ASSETS]},
        "texture": {
            "colorSpace": "sRGB",
            "alphaMode": "straight/unassociated RGBA",
            "transparent": True,
            "premultipliedAlpha": False,
            "generateMipmaps": False,
            "minFilter": "LinearFilter",
            "magFilter": "LinearFilter",
            "wrapS": "ClampToEdgeWrapping",
            "wrapT": "ClampToEdgeWrapping",
            "blending": "NormalBlending; no additive blending",
            "depthWrite": False,
            "depthTest": True,
        },
        "uvConvention": {
            "uvRectTopLeft": "Normalized UVs measured from the atlas top-left.",
            "threeFlipYTrue": "For THREE.Texture flipY=true, convert top-left v as bottom-left v0=1-top.v1 and v1=1-top.v0; values are precomputed in uvBottomLeft.",
        },
        "frames": entries,
    }
    return atlas, metadata


def load_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    """Use Pillow's bundled font so preview generation never needs OS/web fonts."""
    del bold  # The preview is a raster inspection sheet; weight is non-semantic.
    return ImageFont.load_default(size=size)


def checker(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], step: int = 12) -> None:
    left, top, right, bottom = box
    colors = ("#F5F5F5", "#C9D1DA")
    for y in range(top, bottom, step):
        for x in range(left, right, step):
            color = colors[((x - left) // step + (y - top) // step) % 2]
            draw.rectangle((x, y, min(x + step - 1, right - 1), min(y + step - 1, bottom - 1)), fill=color)


def create_preview(sprite_images: dict[str, Image.Image]) -> Image.Image:
    width, height = 1152, 820
    preview = Image.new("RGBA", (width, height), "#FFFFFF")
    draw = ImageDraw.Draw(preview)
    title_font = load_font(28, bold=True)
    header_font = load_font(17, bold=True)
    id_font = load_font(17, bold=True)
    note_font = load_font(13)

    draw.text((24, 18), "VoxalBlast Cartoon Clear V1 - Production Texture Check", fill="#20334C", font=title_font)
    draw.text((24, 51), "Original editable SVG rebuild / 16 / 32 / 64 CSS px readability / straight RGBA", fill="#42566F", font=note_font)

    label_width = 184
    grid_left = 194
    cell_width = 232
    row_top = 100
    row_height = 88
    backgrounds = [
        ("cream", "#FFF1CC"),
        ("sky", "#8ED8FF"),
        ("ink", "#20334C"),
        ("checker / alpha", None),
    ]

    for column, (name, color) in enumerate(backgrounds):
        x = grid_left + column * cell_width
        draw.text((x + 8, 78), name, fill="#20334C", font=header_font)

    for row, (asset_id, _) in enumerate(ASSETS):
        y = row_top + row * row_height
        draw.text((24, y + 27), asset_id, fill="#20334C", font=id_font)
        for column, (_, color) in enumerate(backgrounds):
            left = grid_left + column * cell_width
            box = (left + 3, y + 3, left + cell_width - 5, y + row_height - 5)
            if color is None:
                checker(draw, box)
            else:
                draw.rounded_rectangle(box, radius=10, fill=color)
            x_cursor = left + 15
            for size in (16, 32, 64):
                scaled = sprite_images[asset_id].resize((size, size), Image.Resampling.LANCZOS)
                paste_y = y + (row_height - size) // 2
                preview.alpha_composite(scaled, (x_cursor, paste_y))
                draw.text((x_cursor, y + row_height - 18), str(size), fill="#20334C" if color != "#20334C" else "#FFF1CC", font=note_font)
                x_cursor += size + 14

    draw.text((24, 804), "Inspection sheet only - do not use as a runtime texture.", fill="#6A7686", font=note_font, anchor="ls")
    return preview


def build_assets() -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    SPRITES.mkdir(parents=True, exist_ok=True)

    sprite_images: dict[str, Image.Image] = {}
    for asset_id, _ in ASSETS:
        source = SOURCES / f"{asset_id}.svg"
        if not source.exists():
            raise FileNotFoundError(f"Missing art source: {source}")
        image = rasterize_svg(source)
        sprite_images[asset_id] = image
        image.save(SPRITES / f"{asset_id}.png", format="PNG", optimize=True)

    atlas, atlas_metadata = create_atlas(sprite_images)
    atlas.save(ATLAS_PNG, format="PNG", optimize=True)
    write_text_lf(ATLAS_JSON, json_text(atlas_metadata))
    create_preview(sprite_images).save(PREVIEW, format="PNG", optimize=True)

    sprite_entries = []
    for asset_id, role in ASSETS:
        image = sprite_images[asset_id]
        sprite_entries.append(
            {
                "id": asset_id,
                "role": role,
                "source": f"sources/{asset_id}.svg",
                "texture": f"runtime/sprites/{asset_id}.png",
                "size": [TILE, TILE],
                "pivot": [0.5, 0.5],
                "alphaBounds": alpha_bounds(image),
                "defaultDirection": "+X" if asset_id in {"swoosh-cream", "dash-blue"} else None,
            }
        )

    file_records = []
    for asset_id, _ in ASSETS:
        file_records.append(file_record(SOURCES / f"{asset_id}.svg", "editable SVG art source (LF canonical hash)"))
    for asset_id, _ in ASSETS:
        file_records.append(file_record(SPRITES / f"{asset_id}.png", "runtime transparent PNG texture"))
    file_records.extend(
        [
            file_record(ATLAS_PNG, "runtime transparent PNG atlas"),
            file_record(ATLAS_JSON, "runtime atlas metadata (LF canonical hash)"),
            file_record(PREVIEW, "inspection-only preview; not a runtime texture"),
        ]
    )

    runtime_files = [record for record in file_records if record["path"].startswith("docs/assets/cartoon-clear-v1/runtime/")]
    atlas_mode_paths = {
        "docs/assets/cartoon-clear-v1/runtime/atlas.png",
        "docs/assets/cartoon-clear-v1/runtime/atlas.json",
    }
    sprite_mode_paths = {
        record["path"] for record in runtime_files if "/runtime/sprites/" in record["path"]
    }

    manifest = {
        "schemaVersion": 1,
        "packId": "cartoon-clear-v1",
        "scope": {
            "audited": ["sources/*.svg", "runtime/sprites/*.png", "runtime/atlas.png", "runtime/atlas.json", "preview.png"],
            "excluded": ["references/**", "references/README.md", "ASSETS.md", "asset-checks.json", "tools/build-cartoon-clear-assets.py"],
            "referencesPolicy": "Parent-agent approved storyboard references are context-only, are not generated, hashed, copied, or overwritten by this builder, and are never part of runtime network budget.",
        },
        "runtimeNetworkBudget": {
            "scope": "runtime/ only; references/, sources/, preview, and documentation are excluded",
            "runtimeDirectoryBytes": sum(record["bytes"] for record in runtime_files),
            "atlasModeBytes": sum(record["bytes"] for record in runtime_files if record["path"] in atlas_mode_paths),
            "individualSpritesModeBytes": sum(record["bytes"] for record in runtime_files if record["path"] in sprite_mode_paths),
        },
        "artSource": "Original manually authored editable SVG geometry for VoxalBlast; not cropped, traced, or sliced from the supplied concept/storyboard image.",
        "license": {
            "status": "Original project asset",
            "owner": "VoxalBlast project",
            "source": "In-repository SVG reconstruction authored for this pack",
            "externalAssetLicense": "Not applicable",
        },
        "palette": PALETTE,
        "rasterization": {
            "sourceOfTruth": "SVG files under sources/",
            "backend": RENDER_STATE["backend"],
            "cairoNativeAvailable": RENDER_STATE["cairoNativeAvailable"],
            "cairoDiagnostic": RENDER_STATE["cairoDiagnostic"],
            "outputSize": [TILE, TILE],
            "supersample": SUPERSAMPLE,
            "downsample": "Pillow LANCZOS",
            "transparentRgbBleedPixels": BLEED_PIXELS,
            "outerTransparentPixelsMinimum": OUTER_CLEAR,
        },
        "sprites": sprite_entries,
        "atlas": "runtime/atlas.json",
        "preview": {
            "path": "preview.png",
            "runtimeTexture": False,
            "fontSource": "Pillow bundled default font rasterized into PNG",
            "externalOrNetworkFontDependency": False,
        },
        "files": file_records,
    }
    write_text_lf(MANIFEST, json_text(manifest))

    results = verify_assets(check_manifest=True)
    checks_payload = {
        "schemaVersion": 1,
        "command": "py -3.12 tools/build-cartoon-clear-assets.py --check",
        "passed": True,
        "environment": {
            "python": platform.python_version(),
            "pillow": PILLOW_VERSION,
            "rasterBackend": RENDER_STATE["backend"],
            "cairoSvgVersion": RENDER_STATE["cairoSvgVersion"],
            "cairoNativeAvailable": RENDER_STATE["cairoNativeAvailable"],
            "cairoDiagnostic": RENDER_STATE["cairoDiagnostic"],
        },
        "verified": results,
        "explicitlyNotVerified": {
            "GPUUploadOrRendering": True,
            "gameRuntimeIntegration": True,
            "devicePerformance": True,
        },
    }
    write_text_lf(CHECKS, json_text(checks_payload))


def verify_assets(check_manifest: bool = True) -> dict[str, Any]:
    errors: list[str] = []
    per_sprite: dict[str, Any] = {}
    sprite_images: dict[str, Image.Image] = {}

    for asset_id, _ in ASSETS:
        source = SOURCES / f"{asset_id}.svg"
        texture = SPRITES / f"{asset_id}.png"
        if not source.exists():
            errors.append(f"missing source: {source}")
            continue
        try:
            root = ET.parse(source).getroot()
            if root.attrib.get("viewBox") != "0 0 128 128":
                errors.append(f"{asset_id}: SVG viewBox must be 0 0 128 128")
            source_text = source.read_text(encoding="utf-8").lower()
            for forbidden in ("<text", "<filter", "feGaussianBlur".lower(), "<image"):
                if forbidden in source_text:
                    errors.append(f"{asset_id}: forbidden SVG feature {forbidden}")
        except Exception as exc:
            errors.append(f"{asset_id}: invalid SVG: {exc}")

        if not texture.exists():
            errors.append(f"missing texture: {texture}")
            continue
        with Image.open(texture) as opened:
            image = opened.convert("RGBA")
        sprite_images[asset_id] = image
        if image.size != (TILE, TILE):
            errors.append(f"{asset_id}: size is {image.size}, expected {(TILE, TILE)}")
        alpha = image.getchannel("A")
        bounds = alpha.getbbox()
        extrema = alpha.getextrema()
        alpha_values = list(alpha.get_flattened_data())
        antialiased = any(0 < value < 255 for value in alpha_values)
        clear_band = True
        for y in range(TILE):
            for x in range(TILE):
                if x < OUTER_CLEAR or y < OUTER_CLEAR or x >= TILE - OUTER_CLEAR or y >= TILE - OUTER_CLEAR:
                    if alpha_values[y * TILE + x] != 0:
                        clear_band = False
                        break
            if not clear_band:
                break
        pixels = list(image.get_flattened_data())
        bleed_count = sum(1 for r, g, b, a in pixels if a == 0 and (r != 0 or g != 0 or b != 0))
        if bounds is None:
            errors.append(f"{asset_id}: alpha is empty")
        if not antialiased:
            errors.append(f"{asset_id}: no partial-alpha antialiasing pixels")
        if not clear_band:
            errors.append(f"{asset_id}: outer {OUTER_CLEAR}px alpha band is not fully transparent")
        if bleed_count == 0:
            errors.append(f"{asset_id}: no transparent RGB bleed pixels found")
        per_sprite[asset_id] = {
            "size": list(image.size),
            "alphaBounds": list(bounds) if bounds else None,
            "alphaExtrema": list(extrema),
            "hasPartialAlphaAntialiasing": antialiased,
            "outer12pxAlphaZero": clear_band,
            "transparentRgbBleedPixelCount": bleed_count,
            "cornerAlpha": [alpha.getpixel((0, 0)), alpha.getpixel((127, 0)), alpha.getpixel((0, 127)), alpha.getpixel((127, 127))],
        }

    atlas_match = False
    if ATLAS_PNG.exists() and len(sprite_images) == len(ASSETS):
        with Image.open(ATLAS_PNG) as opened:
            atlas = opened.convert("RGBA")
        if atlas.size != ATLAS_SIZE:
            errors.append(f"atlas size is {atlas.size}, expected {ATLAS_SIZE}")
        else:
            atlas_match = True
            for index, (asset_id, _) in enumerate(ASSETS):
                x, y = (index % 4) * TILE, (index // 4) * TILE
                tile = atlas.crop((x, y, x + TILE, y + TILE))
                if tile.tobytes() != sprite_images[asset_id].tobytes():
                    atlas_match = False
                    errors.append(f"atlas tile mismatch: {asset_id}")
    else:
        errors.append("atlas missing or sprite set incomplete")

    metadata_ok = False
    if ATLAS_JSON.exists():
        metadata = json.loads(ATLAS_JSON.read_text(encoding="utf-8"))
        required_texture = metadata.get("texture", {})
        metadata_ok = (
            metadata.get("size") == {"width": 512, "height": 256}
            and required_texture.get("alphaMode") == "straight/unassociated RGBA"
            and required_texture.get("colorSpace") == "sRGB"
            and required_texture.get("generateMipmaps") is False
            and required_texture.get("minFilter") == "LinearFilter"
            and required_texture.get("wrapS") == "ClampToEdgeWrapping"
            and required_texture.get("depthWrite") is False
            and required_texture.get("depthTest") is True
            and set(metadata.get("frames", {})) == {item[0] for item in ASSETS}
        )
        if not metadata_ok:
            errors.append("atlas metadata policy mismatch")
    else:
        errors.append("atlas metadata missing")

    preview_ok = False
    if PREVIEW.exists():
        with Image.open(PREVIEW) as opened:
            preview_ok = opened.size == (1152, 820)
        if not preview_ok:
            errors.append("preview dimensions mismatch")
    else:
        errors.append("preview missing")

    manifest_hashes_ok = False
    manifest_scope_ok = False
    preview_font_offline = False
    runtime_budget_ok = False
    if check_manifest:
        if not MANIFEST.exists():
            errors.append("manifest missing")
        else:
            manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
            records = manifest.get("files", [])
            manifest_hashes_ok = True
            for record in records:
                path = ROOT / record["path"]
                if not path.exists():
                    manifest_hashes_ok = False
                    errors.append(f"manifest path missing: {record['path']}")
                    continue
                actual = file_record(path, record["kind"])
                if actual["bytes"] != record["bytes"] or actual["sha256"] != record["sha256"]:
                    manifest_hashes_ok = False
                    errors.append(f"manifest hash mismatch: {record['path']}")

            scope = manifest.get("scope", {})
            manifest_scope_ok = (
                "references/**" in scope.get("excluded", [])
                and not any("/references/" in record["path"] for record in records)
            )
            if not manifest_scope_ok:
                errors.append("manifest scope must explicitly exclude references/** and contain no reference records")

            preview_record = manifest.get("preview", {})
            preview_font_offline = preview_record.get("externalOrNetworkFontDependency") is False
            if not preview_font_offline:
                errors.append("preview must declare no external or network font dependency")

            runtime_records = [record for record in records if "/runtime/" in record["path"]]
            expected_runtime_bytes = sum(record["bytes"] for record in runtime_records)
            runtime_budget = manifest.get("runtimeNetworkBudget", {})
            runtime_budget_ok = (
                runtime_budget.get("runtimeDirectoryBytes") == expected_runtime_bytes
                and "references/" in runtime_budget.get("scope", "")
                and not any("/references/" in record["path"] for record in runtime_records)
            )
            if not runtime_budget_ok:
                errors.append("runtime network budget scope or byte total mismatch")

    if errors:
        raise RuntimeError("Asset checks failed:\n- " + "\n- ".join(errors))

    raster_record: dict[str, Any] = {}
    if MANIFEST.exists():
        raster_record = json.loads(MANIFEST.read_text(encoding="utf-8")).get("rasterization", {})

    return {
        "svgCount": len(ASSETS),
        "spritePngCount": len(sprite_images),
        "svgGeometryParsed": True,
        "rasterBackendRecorded": raster_record.get("backend"),
        "cairoNativeRasterizationExecutedDuringBuild": raster_record.get("cairoNativeAvailable", False),
        "supersampleFactor": SUPERSAMPLE,
        "lanczosDownsample": True,
        "transparentRgbBleedPixels": BLEED_PIXELS,
        "atlasExactTileByteMatch": atlas_match,
        "atlasMetadataPolicy": metadata_ok,
        "manifestBytesAndSha256": manifest_hashes_ok,
        "manifestScopeExcludesReferences": manifest_scope_ok,
        "runtimeNetworkBudgetExcludesReferences": runtime_budget_ok,
        "previewDimensionsAndDecode": preview_ok,
        "previewUsesNoExternalOrNetworkFont": preview_font_offline,
        "perSprite": per_sprite,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build or validate the original-SVG VoxalBlast cartoon clear VFX asset pack."
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--build", action="store_true", help="rebuild PNGs, atlas, preview, manifest, and checks (default)")
    mode.add_argument("--check", action="store_true", help="validate existing outputs without rebuilding or writing files")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.check:
            result = verify_assets(check_manifest=True)
            print(f"PASS: validated {result['spritePngCount']} sprites and exact 4x2 atlas; no files written.")
        else:
            build_assets()
            print(f"PASS: built {len(ASSETS)} sprites, atlas, preview, manifest, and checks from editable SVG sources.")
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

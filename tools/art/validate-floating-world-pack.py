"""Offline art-pack structural checks; not game integration tests."""
from pathlib import Path
import json
import re
import struct
import xml.etree.ElementTree as ET
from PIL import Image

root = Path(__file__).resolve().parents[2]
pack = root / 'public/art/floating-world-v1'
manifest = json.loads((pack / 'manifest.json').read_text(encoding='utf-8'))
recipe = json.loads((pack / 'scene.recipe.json').read_text(encoding='utf-8'))
actual = {p.relative_to(pack).as_posix() for p in pack.rglob('*') if p.is_file() and p.name != 'manifest.json'}
assert actual == {entry['path'] for entry in manifest['files']}, 'Manifest mismatch'
assert len(actual) == 39, len(actual)
for entry in manifest['files']:
    assert (pack / entry['path']).stat().st_size == entry['bytes'], entry['path']
svg_count = 0
for file in pack.rglob('*.svg'):
    svg = ET.parse(file).getroot()
    assert svg.attrib.get('viewBox'), file
    for element in svg.iter():
        name = element.tag.rsplit('}', 1)[-1]
        assert name not in {'script','foreignObject','image','text','filter','animate','animateTransform'}, (file,name)
        assert not any('href' in k for k in element.attrib), file
    svg_count += 1
assert svg_count == 28
for file in list((pack / 'brand').glob('*')) + list((pack / 'clouds').glob('*.png')):
    image = Image.open(file).convert('RGBA')
    assert image.getchannel('A').getextrema() == (0,255), file
    if file.parent.name == 'clouds': assert image.size == (512,192), file
    else:
        assert image.size in {(512,208),(1024,416)}, file
        data = image.get_flattened_data() if hasattr(image,'get_flattened_data') else image.getdata()
        assert not any(a>200 and r>180 and b>180 and g<60 for r,g,b,a in data), 'Magenta residue'
models = {}
for file in (pack / 'models').glob('*.glb'):
    binary = file.read_bytes()
    magic, version, total = struct.unpack_from('<4sII',binary,0)
    assert magic == b'glTF' and version == 2 and total == len(binary), file
    size, kind = struct.unpack_from('<II',binary,12)
    assert kind == 0x4E4F534A
    model = json.loads(binary[20:20+size])
    mesh_nodes = sum('mesh' in node for node in model['nodes'])
    expected = 1 if file.stem == 'block-unit' else len(recipe['prefabs'][file.stem]['cells'])
    assert mesh_nodes == expected, (file,mesh_nodes,expected)
    assert not any('uri' in buffer for buffer in model.get('buffers',[])), file
    models[file.name] = mesh_nodes
links = 0
for file in [root/'docs/Technical/FLOATING_WORLD_ART_HANDOFF.md', root/'docs/README.md']:
    text = file.read_text(encoding='utf-8')
    for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',text):
        if re.match(r'[a-zA-Z]+:', target) or target.startswith('#'): continue
        target = target.split('#')[0]
        assert (file.parent / target).exists(), (file,target)
        links += 1
report_path = root/'docs/Art/floating-world-v1/validation.json'
report = json.loads(report_path.read_text(encoding='utf-8'))
report['staticValidation'] = {'resourceFilesExcludingManifest':len(actual),'svgParsed':svg_count,'modelsMeshNodes':models,'localMarkdownLinks':links,'scope':'assets and documentation only; not runtime regression'}
report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report['staticValidation'], ensure_ascii=False))

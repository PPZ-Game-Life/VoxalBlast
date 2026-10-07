"""Create the portable, art-only Jeffy handoff ZIP; preserves repository paths."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import posixpath
import re

root = Path(__file__).resolve().parents[2]
files = [root / 'docs/Technical/FLOATING_WORLD_ART_HANDOFF.md']
for folder in ('public/art/floating-world-v1', 'docs/Art/floating-world-v1'):
    files.extend(path for path in (root / folder).rglob('*') if path.is_file())
for name in ('prepare-floating-world-logo.py', 'build-floating-world-pack.mjs',
             'floating-world-preview.mjs', 'capture-floating-world-preview.mjs',
             'validate-floating-world-pack.py', 'package-floating-world-pack.py'):
    files.append(root / 'tools/art' / name)
assert all(path.is_file() for path in files)
out = root / 'artifacts/handoff/voxalblast-floating-world-v1.zip'
out.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(out, 'w', compression=ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(files):
        archive.write(file, file.relative_to(root).as_posix())
with ZipFile(out) as archive:
    assert archive.testzip() is None, 'Archive integrity failure'
    names = set(archive.namelist())
    doc = archive.read('docs/Technical/FLOATING_WORLD_ART_HANDOFF.md').decode('utf-8')
    for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', doc):
        if re.match(r'[a-zA-Z]+:', target) or target.startswith('#'):
            continue
        relative = posixpath.normpath(posixpath.join('docs/Technical', target.split('#')[0]))
        assert relative in names, f'Missing ZIP-linked resource: {relative}'
print(f'ZIP: {out}\nFiles: {len(files)}\nBytes: {out.stat().st_size}\nIntegrity and internal links: PASS')

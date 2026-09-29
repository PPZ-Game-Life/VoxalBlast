"""Validate the local art handoff and generate its inventory/offline gallery.
No network, no runtime imports, no game state changes. Python + Pillow only.
"""
from pathlib import Path
from PIL import Image
import hashlib, json, re, html, datetime

ROOT=Path(__file__).resolve().parents[1]
errors=[]; warnings=[]; assets=[]; metadata={}

def fail(message):
    errors.append(message)

for sub in ['panels','icons']:
    path=ROOT/f'manifests/{sub}.json'
    if not path.is_file():
        fail(f'Missing component manifest: {path.name}')
        continue
    data=json.loads(path.read_text(encoding='utf-8-sig'))
    entries=data.get('assets',[])
    if isinstance(entries,dict): entries=[dict(v,name=k) for k,v in entries.items()]
    for rec in entries:
        filename=rec.get('file') or rec.get('path')
        if filename:
            filename=filename.replace('\\','/')
            rec=dict(rec)
            source_key=rec.get('source')
            if source_key in ('home','settings','score'):
                rec['sourceKey']=source_key
                rec['source']=f'references/{source_key}.png'
            if 'sourceBounds' not in rec and rec.get('source_window'):
                rec['sourceBounds']=rec['source_window']
            if 'method' not in rec:
                rec['method']=rec.get('masking',{}).get('method','source-derived icon alpha extraction')
            if isinstance(rec.get('notes'),list):rec['notes']=' '.join(rec['notes'])
            metadata[filename]=rec

for path in sorted((ROOT/'assets').rglob('*')):
    if not path.is_file():continue
    rel=path.relative_to(ROOT).as_posix()
    if path.suffix.lower() not in {'.png','.webp'}:
        fail(f'Unexpected runtime asset format: {rel}');continue
    try:
        with Image.open(path) as im:
            im.load(); mode=im.mode; size=list(im.size)
            item=dict(metadata.get(rel,{}))
            item.update({'file':rel,'size':size,'mode':mode,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
            if min(size)<=0:fail(f'Empty dimensions: {rel}')
            if path.suffix.lower()=='.png':
                if mode!='RGBA':fail(f'PNG must be RGBA: {rel} ({mode})')
                else:
                    alpha=im.getchannel('A');hist=alpha.histogram()
                    item['alphaExtrema']=list(alpha.getextrema())
                    item['alphaBounds']=list(alpha.getbbox() or (0,0,0,0))
                    item['transparentPixels']=hist[0]
                    item['opaquePixels']=hist[255]
                    item['edgePixels']=sum(hist[1:255])
                    if not hist[0]:fail(f'No transparent background: {rel}')
                    if not hist[255]:fail(f'No opaque foreground: {rel}')
                    if not sum(hist[1:255]):warnings.append(f'No fractional antialias alpha: {rel}')
                if rel not in metadata:fail(f'Missing per-asset provenance metadata: {rel}')
            else:
                item.update({'method':'reuse existing clean game background','source':f'public/art/reference/{path.name}','containsDynamicText':False,'notes':'Existing project artwork, not reconstructed occluded background from generated concept.'})
            nine=item.get('nineSliceTRBL')
            if nine:
                top,right,bottom,left=nine
                if top+bottom>=size[1] or left+right>=size[0]:fail(f'Invalid nine-slice centre: {rel}')
            sb=item.get('sourceBounds');source=item.get('source')
            if sb and source:
                src=Path(source)
                if not src.is_absolute():src=ROOT/src
                if src.is_file():
                    with Image.open(src) as original:
                        l,t,r,b=sb
                        if not (0<=l<r<=original.width and 0<=t<b<=original.height):fail(f'Source bounds outside image: {rel}')
                else:warnings.append(f'Source cannot be resolved in package: {rel} -> {source}')
            assets.append(item)
    except Exception as e:fail(f'{rel}: {type(e).__name__}: {e}')

if len(assets)<20:fail(f'Unexpectedly few delivered assets: {len(assets)}')
for name in ['home','settings','score']:
    p=ROOT/f'references/{name}.png'
    if not p.is_file():fail(f'Missing approved reference {name}')
for file in ['JEFFY_INTEGRATION.md','tools/slice_panels.py','tools/slice_icons.py']:
    if not (ROOT/file).is_file():fail(f'Missing required handoff file {file}')
for script in (ROOT/'tools').glob('*.py'):
    try:compile(script.read_text(encoding='utf-8-sig'),str(script),'exec')
    except SyntaxError as e:fail(f'Python syntax: {script.name}: {e}')

refs=[]
for name in ['home','settings','score']:
    p=ROOT/f'references/{name}.png'
    if p.is_file():
        with Image.open(p) as im:
            refs.append({'file':p.relative_to(ROOT).as_posix(),'size':list(im.size),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'usage':'design reference only; never load as a complete runtime UI'})

manifest={'schemaVersion':1,'package':'voxalblast-ui-redesign-handoff','date':'2026-09-29','reviewedCodeBaseline':'v0.9.24 / ef0139f (concurrent work excluded)','guide':'JEFFY_INTEGRATION.md','references':refs,'decisions':{'hudBest':'crown','hudScore':'trophy','homeBest':'crown','homeLeaderboard':'crown','homeCube':False,'newGame':'Keep current contextual branch: separate new-game action only when a saved game exists.','settings':'Preserve current 7 rows including language although approved concept depicts 6.'},'assets':assets,'sourceCoordinateConvention':'Pillow (left, top, right, bottom), right/bottom exclusive; nineSliceTRBL in source pixels.','readiness':'Offline sliced-art handoff reviewed on checkerboards; requires in-game layout/i18n/interaction acceptance. Flattened-source restoration is not original layered art.'}
(ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

# Offline asset gallery, no fetch/server/build required.
style='''body{font:15px system-ui,sans-serif;margin:24px;background:#f5f2e9;color:#362818}h1{font-size:24px}.controls{position:sticky;top:0;padding:10px;background:#fff8e6;border-radius:10px;z-index:2}button{padding:8px 12px;margin-right:8px;cursor:pointer}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}.card{padding:12px;border:1px solid #d2c4a8;border-radius:12px;background:#fff}.stage{height:190px;display:flex;align-items:center;justify-content:center;background-color:#f3f4f5;background-image:linear-gradient(45deg,#d3d9df 25%,transparent 25%),linear-gradient(-45deg,#d3d9df 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d3d9df 75%),linear-gradient(-45deg,transparent 75%,#d3d9df 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}body[data-theme=dark] .stage{background:#243345}body[data-theme=light] .stage{background:#fff}img{max-width:100%;max-height:185px;object-fit:contain}code{font-size:12px;word-break:break-all}small{display:block;margin-top:5px;color:#645744}.refs{display:flex;gap:16px}.refs img{max-height:360px}'''
parts=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VoxalBlast 切图验收</title><style>'+style+'</style><body data-theme="checker"><h1>VoxalBlast 新 UI 切图资源包</h1><p>透明切图检查页，不是可运行游戏。未提供的交互态由 CSS/真实状态实现；保留当前语言设置行。</p><div class="controls"><button onclick="document.body.dataset.theme=\'checker\'">棋盘格</button><button onclick="document.body.dataset.theme=\'light\'">白底</button><button onclick="document.body.dataset.theme=\'dark\'">深底</button><a href="../JEFFY_INTEGRATION.md">Jeffy 接入说明</a> · <a href="../manifest.json">manifest</a></div><h2>已确认设计</h2><div class="refs">']
for ref in refs:parts.append(f'<a href="../{ref["file"]}"><img src="../{ref["file"]}" alt="{html.escape(ref["file"])}"></a>')
parts.append('</div><h2>运行时候选资源</h2><main>')
for item in assets:
    f=html.escape(item['file']);note=html.escape(str(item.get('notes','')))
    parts.append(f'<article class="card"><div class="stage"><img src="../{f}" alt="{f}"></div><code>{f}</code><small>{item["size"][0]} × {item["size"][1]} · {item["mode"]}</small><small>{note}</small></article>')
parts.append('</main></body></html>')
(ROOT/'previews/asset-gallery.html').write_text('\n'.join(parts),encoding='utf-8')

counts={'allRuntimeImages':len(assets),'transparentPNG':sum(a['file'].endswith('.png') for a in assets),'reusedBackgrounds':sum(a['file'].endswith('.webp') for a in assets),'references':len(refs),'runtimeBytes':sum(a['bytes'] for a in assets)}
summary=f'''# 切图资源包摘要\n\n入口： [JEFFY_INTEGRATION.md](JEFFY_INTEGRATION.md)。\n\n- 运行时候选图片：{counts['allRuntimeImages']} 张，其中透明 PNG {counts['transparentPNG']} 张、复用干净背景 {counts['reusedBackgrounds']} 张。\n- 完整设计参考：3 张，不用于 runtime 整屏背景。\n- 图片资源合计：{counts['runtimeBytes']/1024/1024:.2f} MiB（不含参考图与预览）。\n- [离线资源查看页](previews/asset-gallery.html)：双击可看棋盘格／白底／深底透明效果。\n- [面板切图预览](previews/panels-contact-sheet.png)、[图标切图预览](previews/icons-contact-sheet.png)。\n- [汇总清单](manifest.json)、[资源验证](validation.json)。\n\n**最终图标：BEST／主页最高分／排行榜 = 皇冠；SCORE = 奖杯。**\n\n**功能差异：当前设置有语言行共七行，不能按六行概念图删掉；独立新游戏功能已存在，接现有按钮。**\n\n本包只做图像拆分、无字底修复、透明处理及交接文档；没有修改游戏代码。扁平图被遮挡的部分不是原始分层图，恢复方法及已知限制在 manifest 和接入指南逐项注明。\n'''
(ROOT/'PACKAGE_SUMMARY.md').write_text(summary,encoding='utf-8')

for md in ['JEFFY_INTEGRATION.md','PACKAGE_SUMMARY.md']:
    content=(ROOT/md).read_text(encoding='utf-8')
    for target in re.findall(r'\]\(([^)]+)\)',content):
        if '://' not in target and not target.startswith('#') and not (ROOT/target.split('#')[0]).exists():
            # validation.json is created immediately below.
            if target!='validation.json':fail(f'Broken markdown link in {md}: {target}')
report={'ok':not errors,'checkedAt':datetime.datetime.now().astimezone().isoformat(),'checks':['decoded every runtime image','verified PNG RGBA and real transparent/opaque pixels','recorded fractional-alpha edges','verified nine-slice centres','checked declared source coordinates','compiled helper scripts without writing pycache','verified package-relative Markdown links','recorded SHA-256 and sizes'],'counts':counts,'errors':errors,'warnings':warnings,'notTested':['gameplay','browser UI integration','mobile touch/keyboard','English layout','real-device alpha appearance'],'visualInspection':'Contact sheets reviewed separately; not a claim that the game has integrated this package.'}
(ROOT/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(0 if not errors else 1)

"""Freeze visual evidence for Jeffy's clipping diagnosis; no runtime changes."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import hashlib,json
ROOT=Path(__file__).resolve().parents[1]
PROJECT=ROOT.parents[1]
OUT=ROOT/'diagnostics';OUT.mkdir(exist_ok=True)
R=Image.Resampling.LANCZOS
FONTPATH=r'C:\Windows\Fonts\msyh.ttc'
def font(s):return ImageFont.truetype(FONTPATH,s)
def label(c,s,x,y,size=18,fill='#253345'):
    ImageDraw.Draw(c).text((x,y),s,font=font(size),fill=fill)
def check(c,box):
    d=ImageDraw.Draw(c);l,t,r,b=box
    for y in range(t,b,14):
        for x in range(l,r,14):d.rectangle((x,y,min(r-1,x+13),min(b-1,y+13)),fill='#f6f7f8' if ((x-l)//14+(y-t)//14)%2 else '#ccd2d9')
def image(c,im,box):
    im=im.convert('RGBA');im.thumbnail((box[2]-box[0],box[3]-box[1]),R)
    c.paste(im,(box[0]+(box[2]-box[0]-im.width)//2,box[1]+(box[3]-box[1]-im.height)//2),im)
def opened(rel):return Image.open(PROJECT/rel).convert('RGBA')

home_ref=Image.open(ROOT/'references/home.png').convert('RGBA')
home_live=opened('artifacts/visual/v0.9.29-desktop-home.png')
modal_live=opened('artifacts/visual/v0.9.29-desktop-settings.png')
modal=opened('public/art/ui-redesign/panels/settings-modal.png')
crown=opened('public/art/ui-redesign/icons/home-crown-large.png')
record=opened('public/art/ui-redesign/panels/home-record.png')

c=Image.new('RGB',(1260,660),'#f3f1ea')
label(c,'主页：参考图 → 当前实机截图 → 实际 PNG',22,16,24)
for x,s in [(22,'A  已确认设计：皇冠与底板相接'),(438,'B  v0.9.29 桌面截图：底沿外露'),(854,'C  已部署切图（棋盘格为透明）')]:label(c,s,x,66,17)
image(c,home_ref.crop((165,519,690,951)),(20,115,410,485))
marked=home_live.copy();ImageDraw.Draw(marked).rectangle((630,346,807,383),outline='#e23939',width=3)
image(c,marked.crop((557,243,886,529)),(436,110,826,486))
check(c,(850,104,1240,316));image(c,crown,(870,120,1220,302))
check(c,(850,330,1240,535));image(c,record,(864,339,1226,526))
label(c,'同一组装饰，本来通过遮挡形成完整轮廓。',22,515,15)
label(c,'红框：切口 + 间隙，不是浏览器裁掉了皇冠。',438,515,15)
label(c,'皇冠底部不是独立完整轮廓；花叶也有切边。',854,551,15)
label(c,'证据来源：references/home.png；artifacts/visual/v0.9.29-desktop-home.png；public/art/ui-redesign/ 对应 PNG。',22,608,14)
c.save(OUT/'home-clipping-evidence.png',optimize=True)

c=Image.new('RGB',(1260,820),'#f3f1ea')
label(c,'设置：先分清 PNG 硬接缝、CSS 底色与视口容纳',22,16,24)
label(c,'A  当前 settings-modal.png（非旧交付）',22,66,17)
check(c,(24,110,406,710));image(c,modal,(32,115,399,704))
label(c,'B  v0.9.29 实机设置（1440×900）',437,66,17)
image(c,modal_live.crop((526,148,915,752)),(434,110,822,710))
label(c,'C  原尺寸证据局部',852,66,17)
label(c,'PNG 顶部：硬横条 / 矩形修复接缝',852,110,15)
check(c,(851,145,1238,280));image(c,modal.crop((0,0,776,150)),(852,150,1236,270))
label(c,'PNG 底部：填色块压过原内圆角',852,321,15)
check(c,(851,353,1238,510));image(c,modal.crop((0,994,776,1148)),(852,360,1236,498))
label(c,'实机 Restart：圆角外仍是红色矩形',852,548,15)
image(c,modal_live.crop((558,650,883,723)),(852,581,1236,700))
label(c,'重要：这张实机图的七行控件都在画面内；边框破损不等于内容被视口裁掉。',22,750,18)
c.save(OUT/'settings-clipping-evidence.png',optimize=True)

names=['icons/logo-voxalblast.png','icons/home-crown-large.png','panels/home-record.png','panels/settings-modal.png','panels/settings-row.png','panels/settings-danger.png','panels/close-button.png']
rows=[]
for n in names:
    deployed=PROJECT/'public/art/ui-redesign'/n;handoff=ROOT/'assets'/n
    with Image.open(deployed) as im:
        a=im.getchannel('A') if im.mode=='RGBA' else None
        rows.append({'asset':n,'size':list(im.size),'mode':im.mode,'alphaExtrema':list(a.getextrema()) if a else None,'alphaBounds':list(a.getbbox()) if a else None,'deployedSha256':hashlib.sha256(deployed.read_bytes()).hexdigest(),'handoffSha256':hashlib.sha256(handoff.read_bytes()).hexdigest(),'sameAsOriginalHandoff':deployed.read_bytes()==handoff.read_bytes()})
report={'baseline':'v0.9.29 screenshots and current unchanged UI code; concurrent rendering edits not inspected as UI fixes','method':'source image inspection + current screenshots + byte comparison; no new browser capture','assets':rows,'screenshots':[{'file':f'artifacts/visual/v0.9.29-{s}.png','sha256':hashlib.sha256((PROJECT/f'artifacts/visual/v0.9.29-{s}.png').read_bytes()).hexdigest()} for s in ['desktop-home','mobile-home','desktop-settings','mobile-settings']]}
(OUT/'artwork-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Created two annotated evidence boards and asset/source fingerprint report.')

"""Offline visual assembly of the delivered slices; NOT a running game screenshot."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT=Path(__file__).resolve().parents[1]
R=Image.Resampling.LANCZOS

def load(p):return Image.open(ROOT/'assets'/p).convert('RGBA')
def font(n):return ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc',n)
def text(im,s,x,y,n=16,fill='#562c13',anchor='lt'):
    ImageDraw.Draw(im).text((x,y),s,font=font(n),fill=fill,anchor=anchor)
def paste(im,p,x,y,w,h=None):
    a=load(p)
    if h is None:h=round(w*a.height/a.width)
    im.alpha_composite(a.resize((w,h),R),(x,y))
def background(blur=0):
    a=load('backgrounds/valley-portrait.webp')
    scale=max(390/a.width,844/a.height)
    a=a.resize((round(a.width*scale),round(a.height*scale)),R)
    l=(a.width-390)//2;a=a.crop((l,0,l+390,844))
    return a.filter(ImageFilter.GaussianBlur(blur)) if blur else a

def nine(canvas,path,x,y,w,h,slices,display=0.4):
    a=load(path);t,r,b,l=slices
    ol,ot,orr,ob=[round(v*display) for v in (l,t,r,b)]
    sx=[0,l,a.width-r,a.width];sy=[0,t,a.height-b,a.height]
    dx=[0,ol,w-orr,w];dy=[0,ot,h-ob,h]
    out=Image.new('RGBA',(w,h))
    for yy in range(3):
        for xx in range(3):
            p=a.crop((sx[xx],sy[yy],sx[xx+1],sy[yy+1]))
            p=p.resize((dx[xx+1]-dx[xx],dy[yy+1]-dy[yy]),R)
            out.alpha_composite(p,(dx[xx],dy[yy]))
    canvas.alpha_composite(out,(x,y))

home=background()
paste(home,'icons/logo-voxalblast.png',18,92,354)
text(home,'立体消除 · 六面连爆',195,197,17,anchor='mt')
paste(home,'panels/home-record.png',91,299,208)
paste(home,'icons/home-crown-large.png',134,223,126)
text(home,'最高分',195,326,18,anchor='mt');text(home,'0',195,354,30,anchor='mt')
nine(home,'panels/home-primary.png',24,485,342,87,[78,82,78,82],.35)
paste(home,'icons/play-triangle.png',69,508,36)
text(home,'继续游戏',126,510,25)
text(home,'未完成的一局：0 分 · 0 格',195,588,11,anchor='mt')
nine(home,'panels/home-secondary.png',24,612,342,74,[65,80,65,80],.35)
paste(home,'icons/plus-gold.png',92,632,31);text(home,'新游戏',149,632,24)
for x,label,icon in [(23,'排行榜','nav-crown-small.png'),(202,'设置','gear-purple.png')]:
    nine(home,'panels/home-nav.png',x,710,165,72,[62,70,62,70],.34)
    paste(home,'icons/'+icon,x+20,732,33)
    text(home,label,x+66,733,18)

settings=background(2)
wash=Image.new('RGBA',settings.size,(62,56,40,35));settings.alpha_composite(wash)
nine(settings,'panels/settings-modal.png',17,65,356,721,[76,76,76,76],.37)
text(settings,'设置',39,89,27);paste(settings,'panels/close-button.png',308,83,42)
rows=[('语言','立即生效',None,'language'),('声音','放置与消除音效','settings-speaker.png','toggle'),('触感','触摸震动反馈','settings-vibration.png','toggle'),('拖块翻面','方块带出六面体即翻面','settings-turn.png','toggle'),('操作说明','键盘与旋转操作','settings-book.png','keys'),('回到主页','','settings-home.png','action'),('重新开始','','settings-restart.png','danger')]
for i,(label,note,icon,kind) in enumerate(rows):
    y=143+i*87
    path='panels/settings-danger.png' if kind=='danger' else 'panels/settings-row.png'
    nine(settings,path,35,y,320,76,[43,48,43,48],.4)
    if icon:paste(settings,'icons/'+icon,49,y+22,32)
    tx=91
    text(settings,label,tx,y+14 if note else y+25,16,fill='white' if kind=='danger' else '#56391a')
    if note:text(settings,note,tx,y+39,9,fill='#856743')
    if kind=='toggle':paste(settings,'panels/toggle-on.png',293,y+24,49)
    elif kind in ('language','keys'):
        nine(settings,'panels/keyboard-hint.png',263,y+26,78,25,[20,25,20,25],.35)
        text(settings,'简体中文' if kind=='language' else 'W A S D Q E',302,y+34,9,anchor='mt')

hud=Image.new('RGBA',(390,844),(211,235,248,255))
text(hud,'HUD 组合示意',195,76,24,anchor='mt')
paste(hud,'panels/score-panel.png',20,145,350)
# Placements are demo anchors only; real HUD needs geometry measurement in the guide.
paste(hud,'icons/hud-crown-best.png',74,195,39)
paste(hud,'icons/hud-trophy-score.png',74,253,39)
text(hud,'BEST',126,203,21);text(hud,'0',320,197,29,anchor='rt')
text(hud,'SCORE',126,265,21);text(hud,'0000',323,259,27,anchor='rt')
text(hud,'动态标签 / 数字 / 图标与底板分离',195,370,16,anchor='mt')
text(hud,'开关状态',195,446,19,anchor='mt')
paste(hud,'panels/toggle-on.png',76,495,95)
paste(hud,'panels/toggle-off.png',219,495,95)
text(hud,'ON',124,562,15,anchor='mt');text(hud,'OFF',267,562,15,anchor='mt')
text(hud,'仅资源装配预览，非实机运行截图',195,718,14,anchor='mt')
text(hud,'七行设置保留当前语言入口',195,747,14,anchor='mt')

proof=Image.new('RGB',(1170,902),'#f5f1e5')
for i,(im,label) in enumerate([(home,'主页：切图 + 文本装配'),(settings,'设置：保留当前七行'),(hud,'计分牌与状态资源')]):
    proof.paste(im.convert('RGB'),(i*390,42))
    ImageDraw.Draw(proof).text((i*390+195,10),label,font=font(17),fill='#453519',anchor='mt')
proof.save(ROOT/'previews/assembly-proof.png',optimize=True)
print('Created offline assembly proof (not gameplay validation).')

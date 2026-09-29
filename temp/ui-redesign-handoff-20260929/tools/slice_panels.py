"""Slice/restore reusable text-free UI surfaces from approved flattened concepts.
Pillow only. Deterministic; writes only inside this handoff package.
Clean-band reconstruction is documented in the manifest, not passed off as layered source.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance, ImageOps, ImageFont
import json, hashlib, statistics

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/panels'
OUT.mkdir(parents=True, exist_ok=True)
R = Image.Resampling.LANCZOS
sources = {n: Image.open(ROOT / f'references/{n}.png').convert('RGBA') for n in ['home','settings','score']}
records=[]


def rounded_mask(size, radius, inset=0):
    k=3
    m=Image.new('L',(size[0]*k,size[1]*k),0)
    ImageDraw.Draw(m).rounded_rectangle((inset*k,inset*k,(size[0]-1-inset)*k,(size[1]-1-inset)*k),radius=radius*k,fill=255)
    return m.resize(size,R)


def erase_band(image, box, sample_x, feather=2):
    """Replace lettering/icons with a same-row median from an empty source band."""
    im=image.copy()
    x0,y0,x1,y1=box
    sx0,sx1=sample_x
    p=im.load(); old=image.load()
    for y in range(max(0,y0),min(im.height,y1)):
        c=tuple(int(statistics.median([old[x,y][i] for x in range(sx0,sx1)])) for i in range(3))+(255,)
        for x in range(max(0,x0),min(im.width,x1)):
            a=min(1.0,(x-x0+1)/max(feather,1),(x1-x)/max(feather,1),(y-y0+1)/max(feather,1),(y1-y)/max(feather,1))
            p[x,y]=tuple(round(old[x,y][j]*(1-a)+c[j]*a) for j in range(4))
    return im


def save(name, im, source, bounds, method, insets=None, nine=None, note='', contains_glyph=False):
    im.save(OUT/name,optimize=True)
    a=im.getchannel('A')
    rec={'name':name,'file':f'assets/panels/{name}','source':f'references/{source}.png','sourceBounds':list(bounds),'size':list(im.size),'mode':im.mode,'alphaExtrema':list(a.getextrema()),'alphaBounds':list(a.getbbox() or (0,0,0,0)),'method':method,'containsDynamicText':False,'containsStaticGlyph':contains_glyph,'notes':note,'sha256':hashlib.sha256((OUT/name).read_bytes()).hexdigest()}
    if name in ('home-primary.png','home-secondary.png'):
        rec['sourceDependencies']=['assets/panels/home-nav.png']
        rec['notes'] += ' Endcaps/frame are resampled from the clean home-nav source (home bbox 435,1578,793,1734), not recovered hidden pixels.'
    if insets:rec['contentInsetsTRBL']=insets
    if nine:rec['nineSliceTRBL']=nine
    records.append(rec)
    return im


def restore_face(image, box, radius, sample_x):
    """Reconstruct the complete inner face, following its rounded boundary, with clean row colours."""
    x0,y0,x1,y1=box
    layer=Image.new('RGBA',image.size,(0,0,0,0))
    p=layer.load(); src=image.load()
    for y in range(y0,y1):
        c=tuple(int(statistics.median([src[x,y][i] for x in range(*sample_x)])) for i in range(3))+(255,)
        for x in range(x0,x1):p[x,y]=c
    mask=Image.new('L',image.size,0)
    mask.paste(rounded_mask((x1-x0,y1-y0),radius),(x0,y0))
    return Image.composite(layer,image,mask)


def stretch_shell(image,width,height,cap=72):
    ratio=height/image.height
    a=image.resize((round(image.width*ratio),height),R)
    edge=round(cap*ratio)
    out=Image.new('RGBA',(width,height))
    out.paste(a.crop((0,0,edge,height)),(0,0))
    out.paste(a.crop((edge,0,a.width-edge,height)).resize((width-2*edge,height),R),(edge,0))
    out.paste(a.crop((a.width-edge,0,a.width,height)),(width-edge,0))
    return out


# HOME: clean bands replace labels/icons, outer silhouette masks remove the scenic background.
h=sources['home']
# Side navigation is a clean unornamented capsule, suitable for true nine-slice stretching.
box=(435,1578,793,1734)
a=h.crop(box)
a=restore_face(a,(20,17,339,132),44,(173,183))
a.putalpha(rounded_mask(a.size,62,2))
nav=save('home-nav.png',a,'home',box,'source crop + clean vertical band + antialiased silhouette',[22,34,25,34],[62,70,62,70],note='Unlettered navigation shell; crown/gear and localized label are separate elements.')

box=(90,1410,764,1565)
a=stretch_shell(nav,674,155)
a.putalpha(rounded_mask(a.size,62,2))
secondary=save('home-secondary.png',a,'home',box,'source crop + clean band + matching clean endcap reconstruction',[22,38,25,38],[65,80,65,80],note='New Game background; no plus/label; floral trim omitted from stretchable base.')

box=(90,1150,765,1344)
original=h.crop(box)
a=stretch_shell(nav,675,194)
# Use the clean yellow face band from the primary artwork and the source-derived matching frame.
face=Image.new('RGBA',a.size,(0,0,0,0)); fd=ImageDraw.Draw(face)
for yy in range(a.height):
    c=tuple(int(statistics.median([original.getpixel((xx,yy))[i] for xx in range(575,585)])) for i in range(3))+(255,)
    fd.line((0,yy,a.width,yy),fill=c)
mask=Image.new('L',a.size,0);mask.paste(rounded_mask((625,142),55),(25,21))
a=Image.composite(face,a,mask)
a.putalpha(rounded_mask(a.size,77,2))
save('home-primary.png',a,'home',box,'source gold-face crop + clean band + matching endcaps',[28,42,29,42],[78,82,78,82],note='Continue background. No arrow or text. Endcaps are reconstructed; not pixel-identical to flower-covered concept.')

box=(206,716,647,936)
a=h.crop(box)
a=erase_band(a,(111,34,322,194),(83,96))
a.putalpha(rounded_mask(a.size,50,2))
save('home-record.png',a,'home',box,'source body crop + label/number removal with clean band',[35,45,32,45],None,note='Body-only high-score panel. Render large crown separately; use fixed aspect ratio, not nine-slice (internal number recess).')

# SETTINGS: restore a blank frame, avoiding the cropped illustration's embedded text and controls.
s=sources['settings']
box=(55,302,831,1450)
a=s.crop(box)
# Replace decorative overlap on the scalable frame with clean mirrored original frame sections.
a.paste(ImageOps.mirror(a.crop((a.width-155,0,a.width,56))),(0,0))
a.paste(ImageOps.mirror(a.crop((0,a.height-220,150,a.height))),(a.width-150,a.height-220))
a=erase_band(a,(44,47,a.width-43,a.height-49),(32,40))
a.paste(ImageOps.mirror(a.crop((0,60,44,a.height-80))),(a.width-44,60))
a.putalpha(rounded_mask(a.size,67,2))
save('settings-modal.png',a,'settings',box,'source frame + clean interior-band reconstruction + undecorated corner restoration',[50,45,48,45],[76,76,76,76],note='Empty scalable modal shell. Header, close, six/seven rows and corner ornaments are separate; never display this as a whole settings screenshot.')

box=(104,489,786,628)
a=s.crop(box)
a=erase_band(a,(28,15,a.width-22,a.height-20),(437,456))
a.putalpha(rounded_mask(a.size,40,1))
save('settings-row.png',a,'settings',box,'source row crop + clean-band restoration',[20,24,23,24],[43,48,43,48],note='Reusable empty row for sound/haptics/drag-turn/help/home and any existing language row.')

box=(104,1231,786,1370)
a=s.crop(box)
a=erase_band(a,(30,16,462,a.height-20),(498,518))
a.putalpha(rounded_mask(a.size,39,1))
save('settings-danger.png',a,'settings',box,'source coral action crop + clean-band restoration',[20,24,24,24],[43,48,43,48],note='Restart background; render restart glyph and localized label separately.')

box=(634,519,755,590)
a=s.crop(box)
a.putalpha(rounded_mask(a.size,32,1))
on=save('toggle-on.png',a,'settings',box,'source crop + antialiased rounded silhouette',[0,0,0,0],None,note='Entire ON toggle; scale uniformly, do not nine-slice. State remains controlled by real DOM button.')
thumb=s.crop((691,523,749,583))
mask=Image.new('L',(thumb.width*3,thumb.height*3),0)
ImageDraw.Draw(mask).ellipse((1,1,thumb.width*3-2,thumb.height*3-2),fill=255)
thumb.putalpha(mask.resize(thumb.size,R))
save('toggle-thumb.png',thumb,'settings',(691,523,749,583),'source thumb crop + elliptical alpha',note='Optional separate thumb; do not mirror it, preserve light direction.')
track=erase_band(on,(48,6,115,64),(25,39))
track.putalpha(rounded_mask(track.size,32,1))
track=ImageEnhance.Color(track).enhance(.12)
tint=Image.new('RGBA',track.size,(166,145,108,255))
track=Image.blend(track,tint,.35)
track.putalpha(rounded_mask(track.size,32,1))
track.alpha_composite(thumb,(6,4))
save('toggle-off.png',track,'settings',box,'derived OFF: desaturated source track + same unmirrored thumb moved left',note='OFF is reconstructed, not present in approved all-ON concept. Use muted track + left thumb so state is not encoded only by color.')

box=(580,973,763,1023)
a=s.crop(box)
a=erase_band(a,(13,8,a.width-13,a.height-10),(9,13))
a.putalpha(rounded_mask(a.size,24,1))
save('keyboard-hint.png',a,'settings',box,'source capsule + glyph removal',[8,14,9,14],[20,25,20,25],note='No WASDQE letters baked in; use real DOM kbd/text.')

box=(689,355,790,464)
a=s.crop(box)
# Exact geometric face shape retains the X as a static control symbol.
a.putalpha(rounded_mask(a.size,50,3))
save('close-button.png',a,'settings',box,'source crop + antialiased silhouette',note='Includes fixed X glyph. Button needs localized aria-label. Do not overlay a second X.',contains_glyph=True)

# HUD plaque: remove top crown/BEST/0 and bottom trophy/SCORE/0000; retain full decorative silhouette.
a=sources['score'].copy()
a=restore_face(a,(198,448,1063,620),69,(635,665))
a=restore_face(a,(198,665,1063,825),65,(635,665))
# Colour key the flat sky only; preserve white flower petals and warm highlight pixels.
pix=a.load()
for y in range(a.height):
    for x in range(a.width):
        r,g,b,old=pix[x,y]
        sky=max(0.0,min(1.0,(b-r-3)/18.0)) if b>=g-6 else 0.0
        alpha=round(255*(1-sky))
        pix[x,y]=(r,g,b,alpha)
bounds=a.getchannel('A').getbbox()
a=a.crop(bounds)
save('score-panel.png',a,'score',bounds,'source plaque + two clean-band restorations + pale-blue chroma matte',note='Fixed-aspect decorated plaque, NOT nine-slice. Both icons/labels/numbers are removed. BEST=crown, SCORE=trophy via separate DOM layers.')

(ROOT/'manifests').mkdir(exist_ok=True)
(ROOT/'manifests/panels.json').write_text(json.dumps({'schemaVersion':1,'generator':'tools/slice_panels.py','assets':records},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

# Checkerboard proof: shows actual alpha, not a flattened solid-colour preview.
font=ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf',15)
cellw,cellh=360,245
cols=3; rows=(len(records)+cols-1)//cols
proof=Image.new('RGB',(cols*cellw,rows*cellh),(243,244,247))
d=ImageDraw.Draw(proof)
for i,rec in enumerate(records):
    x=(i%cols)*cellw;y=(i//cols)*cellh
    for yy in range(y+30,y+cellh-16,12):
        for xx in range(x+12,x+cellw-12,12):
            fill='#d5dae0' if ((xx-x)//12+(yy-y)//12)%2 else '#f5f6f8'
            d.rectangle((xx,yy,min(xx+11,x+cellw-13),min(yy+11,y+cellh-17)),fill=fill)
    d.text((x+12,y+6),rec['name'],font=font,fill='#263342')
    im=Image.open(ROOT/rec['file']).convert('RGBA')
    im.thumbnail((cellw-32,cellh-64),R)
    proof.paste(im,(x+(cellw-im.width)//2,y+35+(cellh-65-im.height)//2),im)
    d.text((x+12,y+cellh-19),f"{rec['size'][0]} x {rec['size'][1]}",font=font,fill='#52606e')
(ROOT/'previews').mkdir(exist_ok=True)
proof.save(ROOT/'previews/panels-contact-sheet.png')
print(f'Created {len(records)} reusable panel assets and checkerboard proof.')

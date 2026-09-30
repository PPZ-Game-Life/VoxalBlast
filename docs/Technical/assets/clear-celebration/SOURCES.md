# 庆祝资源来源与使用边界

2026-09-30，Luna 为 `CLEAR_CELEBRATION_AUDIO_HANDOFF.md` 制作。全部位于文档目录，**没有接入运行时，不是最终美术或音频验收**。

## 文件分工

- `garden-celebration-reference.png`：原生 GPT 图片工具生成的风格参考，1536×1024 PNG；不是透明图集，不可逐格切图直接用作最终粒子。参考图里的蓝块偏哑光，仅示意消线方向，不覆盖方块材质交接的实心亮面标准。线带、星章在参考板中放大展示，实际尺寸以主文档为准。
- `celebration-shapes.svg`：Luna 本轮编写的可编辑路径模板，透明底，四个独立 symbol：`paper-chip`、`sparkle-four`、`seal-five`、`ribbon-short`；用于轮廓统一。整张 720×180 是查看用排布，不是按格自动切片的 atlas。可提取 symbol 作为 DOM SVG 或重建为 Three 几何，按主文档做实际尺寸、透明边缘与性能验收。
- `build-audio-previews.mjs`：离线 Node 标准库合成脚本，无外部采样／依赖／网络；不接入游戏，不使用发牌随机源。音符、谐波、衰减、纸声及随机种子全部可重现。
- `audio/*.wav`：17 个单事件原创合成小样与 1 个顺序试听文件；48kHz、16bit PCM、mono；**尚未人工听审、真机试听或做最终响度母带**。可作为试接入样音，但正式推荐把配方移植为运行时合成，保持零音频下载依赖。
- `audio-manifest.json`：所有 cue 的顺序、时长、采样峰值／未加权 RMS、音符配方、种子和包体；不是 LUFS、dBTP 或感知响度测量。
- `build-handoff-package.ps1`：显式按清单打包本文及资源，输出 `jeffy-celebration-handoff.zip`；不包含仓库其他文件，不把 ZIP 自身重复嵌入。可用 `pwsh -File docs/Technical/assets/clear-celebration/build-handoff-package.ps1` 重建，替换已有同名输出。ZIP 根目录含交接文档，附件保留 `assets/clear-celebration/` 相对结构，支持离线阅读。

## 授权与第三方依赖

本轮音频由数学振荡器和确定性噪声原创合成，没有使用竞品声音、商用素材库采样或第三方音乐。SVG 为本轮原始路径。本轮不引入第三方署名素材或外部 CDN。生成图片通过本机原生 GPT 图片工具完成，其使用遵循服务条款；本文不额外作商标／独占性法律保证。

不需要用户另外发送聊天参考图。Jeffy 应从主文档的仓库链接或 ZIP 获取这些资源；仓库访问权限仍需正常具备。

## 图像生成记录

- 路由：原生 `mcp__image__generate_image`（text-to-image，等价 images/generations 意图）。
- 参考处理：没有输入照片或参考文件；基于项目的花园庆祝视觉词汇原创制作，不是原游戏截图改图。
- 请求：1 张，1536×1024，high，PNG。
- 实际返回：1536×1024，medium，1,659,506 bytes；未声称 high 最终质量。
- SHA-256：`083b95d60dafd2ba6b6f738b5c72981dfe58e1a08a7b6c3cdc968370e020ec49`。
- 已目视检查：六格构图、无文案、纸彩／星章／空白中心方向成立。没有将该静态图当作时序、数量、遮挡或实机效果验证。

### 最终 revised prompt（工具返回原文）

```text
Create one original polished ART-DIRECTION REFERENCE SHEET for a warm casual garden block-puzzle game's celebration VFX. Landscape 3:2 composition. Exactly six equally sized panels in a clean 3 columns by 2 rows grid with generous ivory gutters on light cream background, subtle panel background separation, no hard decorative borders. NO WORDS, NO LETTERS, NO NUMBERS, NO LOGOS anywhere. A concept reference sheet, not a game screenshot or sprite atlas. Consistent upper-left soft sunlight, handcrafted stylized 3D matte paper/toy finish, calm low-detail surfaces, clear rounded silhouettes. Effects small, intentionally sparse, lots of negative space.
TOP LEFT PANEL: very narrow short cream-gold rounded horizontal highlight stroke above five small aligned blue rounded solid toy tiles, restrained single-line confirmation, only a few tiny rounded paper chips.
TOP MIDDLE PANEL: isolated palette of five small rounded rectangular paper confetti pieces spaced apart, muted rose #C98699, sky #8DBDD3, sage #A5BBA1, ivory #FFF1D4, warm gold #E7B75F; gentle paper edge shading, no shiny metallic finish. No palette labels.
TOP RIGHT PANEL: exactly three small rounded four-point sparkle stamps and one softly rounded five-point golden paper star seal, matte nonmetallic, no emissive aura.
BOTTOM LEFT PANEL: modest outward fan burst of about twelve paper chips around a small cream-gold star seal, keep generous empty space at center with tiny seal slightly below center, thin localized motion suggestions only, no smoke.
BOTTOM MIDDLE PANEL: two short curled paper ribbons, one close to left edge and one close to right edge, with a few outward-fanning paper chips near LEFT AND RIGHT panel edges only. The central 65 percent of this panel stays ENTIRELY clean empty ivory. Nothing crosses into central region. Sparse edge decoration.
BOTTOM RIGHT PANEL: a single blank cream paper award medallion with a warm wooden rim and small five-point star crest at its top; blank face, restrained side confetti celebration, no text or numbers.
Same matte paper/toy material, muted palette, rounded geometry and upper-left light across every panel. Cheerful subtle garden celebration without literal garden scenery, not birthday paraphernalia. Avoid candy jelly, glass, crystalline gems, glitter clouds, neon, lens flare, fire, explosions, long trails, gold coin rain, full-screen glow, dense particles, realistic textures. Do not draw cube board, characters, landscape, phone, UI labels. Beautiful professional sparse art direction presentation.
```

## 复现音频

```powershell
node docs/Technical/assets/clear-celebration/build-audio-previews.mjs
```

执行将覆盖此文件夹中的样音与清单，不改游戏；请先保留手工调整版。正式接入先试听小样与实际手机外放，再按主文档做并发混音与静音／恢复验证。试听顺序以 manifest 为准，间隔 0.70s，首段留白 0.50s。

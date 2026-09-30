# 六面体与备选区方块改版：R0 基线冻结记录

> **Jeffy → Luna／制作人｜2026-09-30｜R0 已完成；R1 未开工。**
> 依据 [六面体与备选区方块：参考图差距分析及 Jeffy 修改交接](BLOCK_REFERENCE_REWORK_HANDOFF.md) §9 R0。
> 本文只记录**冻结了什么、量到了什么、复现了什么**。**没有修改任何游戏实现、渲染参数、存档格式或玩法**，没有升级版本。
> R0 的两项输入仍缺（§6）：**参考原图**与**未提交渲染改动的归属确认**。R1 的验收要求「Luna 认可」，在此之前不开工。

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 固定条件可复现性 | **空盘手机帧与交接文档证据 A 逐字节相同**（sha256 `343d80fc…c80acb9`）；旋转 sweep 回到原位后与基准帧**像素零差异**（mean \|d\| = 0.000） |
| Luna §3 引用的源码数值 | 逐条核对，**15/15 全部复现**（§3） |
| §5.2「四格长条可能独自缩小」 | 在 390×844／1440×900 **未复现**：候选单格跨形状最大差 **≤1.2%**，远在文档自订 5% 门禁内（§4.3） |
| §3 P1「材质读作琉璃／果冻」 | **成立且已量化**：关闭四项体积响应仅改变像素幅度均值 2.6 级、其中 63% 的移动像素幅度 ≤8 级 —— 是**整面低幅雾化**，不是可读的内部体积（§5.2） |
| §3 P1「木块像圆角小垫片」「候选像亮边扁方片」 | 1:1 裁切**目视成立**（§5.3） |
| 候选尺度 | 候选单格块高 ≈**22.4px**，棋盘格距 **48.93px** → 候选读作棋盘的 **46%**；托盘槽高只用了 **69.0%**（§4.2） |

## 2. 基线核对（R0 第 1 项）

- 仓库／分支：`PPZ-Game-Life/VoxalBlast`，`main`。
- **HEAD：`4ec3c42`**「docs: add block reference gap analysis and Jeffy handoff」，其父 `ec6b855` 即交接文档 §1.2 的分析起点。`package.json` version **0.9.32**。
- **本地运行 URL：`http://127.0.0.1:5173/`**。⚠️ 接手时 **dev server 并未在跑**；本次以
  `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort` 起在 127.0.0.1（不能省 `--host`，否则 vite 监听 `[::1]` 而探针轮询 127.0.0.1）。
- **未提交渲染改动与 §1.2 完全一致，且不是我改的**（接手时就已存在，未 reset／未 stash／未覆盖）：

```text
 M docs/Technical/BOARD_SURFACES.md     M src/rendering/config.js
 M src/diagnostics.js                   M src/rendering/toyLights.js
 M src/rendering/blockResources.js      M tools/screenshot.mjs
 M src/rendering/boardView.js
?? src/rendering/gemMaterial.js (6287 B)   ?? tools/gem-material-tests.mjs (1695 B)
```

  合计 7 文件 `+77 / −17`。`gemMaterial.js` 由 `blockResources.js` 导入（`GemMaterial`／`clampGemSettings`），`npm test` 已覆盖 `gem-material-tests.mjs` 且通过。
- `npm test` **全绿**（exit 0）：`i18n / edge-turn / rule / game-session / deal-director / deal-core 146-146 / deal-dealer 61-61 / deal-session 56-56 / deal-worker 13-13 / gem-material` 全部通过。未跑 `npm run build`（R0 不要求；R4 统一跑）。

## 3. 源码数值复算（Luna §3 表逐条反证）

全部 15 项在 `src/rendering/config.js` 中**逐字复现**，无一项需要修正：

| §3 引用值 | 源码 | 行 |
| --- | --- | --- |
| `blockSize 0.95` / `blockRadius 0.13` / `blockSegments 3` | 同 | 54 / 55 / 56 |
| `woodRoughness 0.48` / `woodClearcoat 0.45` / `woodCrownHeight 0.012` | 同 | 65 / 66 / 70 |
| `paintRoughness 0.12` / `paintClearcoat 1` / `paintClearcoatRoughness 0.045` | 同 | 76 / 77 / 78 |
| `paintMetalness 0` / `paintEnvMapIntensity 0.85` | 同 | 80 / 81 |
| `paintCrownHeight 0.032` / `voxelEdgeOpacity 0` | 同 | 72 / 84 |
| `cameraDirection [0.429,0.208,0.879]` / `cameraFov 6` / `cameraFovMobile 7` | 同 | 120 / 111 / 112 |
| `reflectionGlintIntensity 16` | 同 | 205 |
| `GEM_STYLE`：density 2.1／scatter 1.0／coreAbsorption 0.42／internalReflection 0.4／environmentTransmission 0.28 | 同 | 221–227 |

运行时侧也一致：`rendering.materials.paint = { roughness: 0.12, envMapIntensity: 0.85, metalness: 0 }`，`rendering.materials.gem.model = "local-thickness-scattering"`、`singlePass: true`。

## 4. 冻结的采集条件（R0 第 3 项）

| 项 | 值 |
| --- | --- |
| 视口 | 390×844（手机）、1440×900（桌面） |
| DPR | **1**（driver 用 `--force-device-scale-factor=1` + `Emulation.setDeviceMetricsOverride deviceScaleFactor:1`）→ **CSS px == PNG px**，由探针 `devicePixelRatio` 断言 |
| 质量档 | 手机 `rendering.lowPower = true`（SSAO 关，走 surface AO）；桌面走 composer |
| 姿态 | 默认停靠，无拖拽；`framing.zoom = 1`，手机 `fov = 7`（`cameraFovMobile`） |
| 动画时点 | 由 driver 门禁保证：开场波 `introWave.active = false` 且 `plays ≥ 1`、`integrity` 无残差，再等 2 帧 rAF |
| 随机种子 | `SHOT_SEED=20260916`（全部四组共用同一个种子） |
| 存档 | 空盘（不注入）+ 三份固定彩色盘面夹具（同一盘面、三副手牌） |
| 采集工具 | `node tools/screenshot.mjs http://127.0.0.1:5173/ <outDir>` |

**四种状态的证据组**（每组均含手机与桌面）：

| 组 | 存档 | 候选形状 | 作用 |
| --- | --- | --- | --- |
| `artifacts/visual-r0/empty` | 不注入（真实新局） | 固定种子发牌 | 空盘基线；**与交接文档证据 A 同帧** |
| `artifacts/visual-r0/color-a` | `tools/fixtures/visual-color-board-a.json` | Dot / **Line 4** / L | 彩色盘面主对照 + 体积响应 A/B |
| `artifacts/visual-r0/color-b` | `…-b.json` | J / S / Z | 形状覆盖 |
| `artifacts/visual-r0/color-c` | `…-c.json` | Rect 6 / Block 9 / T | 形状覆盖（含最大件） |

→ R0 要求的候选覆盖 **Dot、Line 4、L／J、S／Z、Rect 6、Block 9 全部到位**，另外带 T。
三份夹具**共用同一张 65 格彩色盘面**，只有手牌不同 —— 这样跨批对照的变量只剩候选本身。

### 4.1 新增的 R0 工具（可复用，不触碰玩法）

| 文件 | 作用 |
| --- | --- |
| `tools/visual-fixtures.mjs` | 确定性生成三份彩色盘面夹具（无 `Math.random`）。盘面刻意留缝，让奶油木面在底带与右面仍可见，否则缝隙颜色无法与木面比对 |
| `tools/frame-diff.mjs` | 两张同姿态截图的像素差（>2/8/16/32 级像素数、mean/max、移动包围盒），可选 `--box` 限定区域。材质轮次「有没有变」必须量，不能靠 390px 目视 |
| `tools/crop-r0-evidence.py` | 按探针报出的真实矩形裁切（全屏／单块 1:1／候选 1:1／240px 缩略），DPR 非 1 时直接断言失败 |
| `tools/screenshot.mjs`（**增补，纯新增字段**） | 探针新增 `pieceMetrics`（每槽 slot／canvas／thumb 的 CSS 盒）、`trayMetrics`、`boardCellPx`、`devicePixelRatio`、`canvasPx`。**只读布局盒，不复制任何投影算法**（遵守 plan §2.1） |

## 5. 测量结果

### 5.1 棋盘（390×844，DPR 1）

| 量 | 值 |
| --- | --- |
| 棋盘格距 `boardCellPx` | **48.93 px**（块本体 ≈ 48.93 × 0.95 = **46.5 px**） |
| 立方体投影轮廓 | x 72.08‥322.07，y 207.98‥493.47 → **249.99 × 285.49 px** |
| 占位 | `fillX 0.661`、`fillY 0.612`、`widthShare 0.641` |
| 桌面格距 | **80.62 px** |
| 底部翻面余量 | `turnBandPx 225.6`；3 行触摸搬运后仍有 **140.2 px**；鼠标搬运 **215.6 px** |

### 5.2 体积响应 A/B（R1 第 1 轮的定量基线）

用文档 §4.1 的诊断接口关闭四项（`scatter / coreAbsorption / internalReflection / environmentTransmission = 0`），采集器在 **同一姿态、同一局面**下多拍一帧 `-surface-only.png`：

| 视口 | mean \|d\| | max \|d\| | >2 级 | >8 级 | >16 级 | >32 级 |
| --- | --- | --- | --- | --- | --- | --- |
| 手机 390×844 | **2.575** | 104 | 18.00% | 11.43% | 6.30% | 0.81% |
| 桌面 1440×900 | **1.730** | 138 | 11.90% | 7.57% | 4.25% | 0.59% |

**对照组**（同盘面、不同手牌 → 真实差异应有的量级）：>2 级 3.28%、>32 级 2.70%、max 252。

**读法**：四项体积响应**确实在改像素**（手机 18% 的像素动了），但 **63% 的移动像素幅度只有 2–8 级**、超过 32 级的只有 0.81%。也就是说它给出的是一层**铺满整面的低幅亮度变化**（雾感），而不是集中在面中心／薄边上的可读体积。这从两头支持 §3 P1：材质方向确实偏了，但**它并不是一个靠"更复杂"就能验收的效果** —— 在 390px 下两张图肉眼不可分辨。

> 该 A/B 由采集器的 `SHOT_GEM_COMPARE=1` 在拍完门禁帧后自动补拍并恢复原设置（未写入任何存档或玩家设置）。**本轮只采集证据，未改任何参数。**

### 5.3 1:1 裁切观察（每格 3 格宽，手机）

- **彩块**（`before-r0-block-1to1-color.png`，147px）：单个面被切成**左亮带 + 右暗带**两块，上沿近乎全白。读作光泽漆面／果冻，**不是实心玩具塑料**。对应 §3 P1「颜色被分成内外两层」。
- **木块**（`before-r0-block-1to1-wood.png`，147px）：典型**圆角软垫**——倒角占比大，面中心最亮、向四角衰减，4 块交汇处形成明显深色菱形。对应 §3 P1「木块更像圆角小垫片」。
- **候选**（`before-r0-candidates-1to1-color.png`，366×117）：三件都是**上沿一条亮边的扁片**，厚度几乎不可见。对应 §3 P1「候选像亮边扁方片」。

### 5.4 备选区尺度（R0 第 4 项 + §5.3 要求）

托盘 `.bottom-panel`：x 11.7，y 719.1，**366.6 × 116.5**。三槽各 **103.4 × 80.4**（y 735.4，x 30 / 143.3 / 256.6）。

| 量 | 390×844 | 1440×900 |
| --- | --- | --- |
| 槽内画布 | 103.4 × 80.4 | 211.2 × 99.4 |
| 槽高 ÷ 托盘高 | **69.0%** | 69.0% |
| 三槽宽 ÷ 托盘宽 | 84.6%（两侧共留 ~15.4%） | 84.6% |
| 候选单格**块高** | **22.45 / 22.35 / 22.19** px（Dot／Line 4／L） | 27.4 / 27.5 / 27.3 px |
| 候选单格 ÷ 棋盘格距 | **≈ 46%** | ≈ 34% |

**候选单格跨形状一致性（§5.2 的 P2 猜测）**：同一手牌内三件单格块高为 22.45 / 22.35 / 22.19 px，**最大偏差 1.2%**；另一副手牌（L 5 / Line 4 / Line 2）同样在 1% 内。

> 结论：**§5.2 的「四格长条可能独立缩小」在 390×844 与 1440×900 未复现。** 机理确实存在——`Line 4` 的 `size.x ≈ 3.18` 超过 `envelope 2.45`，使 `halfHeight` 由 1.3921 升到 1.4049（+0.9%），单格确实会小一点——但幅度比文档自订的 5% 门禁小一个数量级。**尚未验证**：320×740、横屏 844×390，以及含 5 格件的批次。

**尺度可行性**：槽内画布只有 **103.4 px** 宽，四格长条要达 28px／格需要 112px 净宽 —— **在现托盘内框下不可能**，与 §5.3 的预判一致。若要同批等大又更大，必须走「调整整条托盘布局」的独立提案。

## 6. 仍然缺的两项输入（阻塞 R1）

1. **参考原图未到手。** §1.1 明说交给 Jeffy 时需一并发原图（`sha256:b4bd6484…2d82`），且「没有看到原图前，Jeffy 不应仅凭材质关键词开工」。本轮只收到交接文档，**原图不在本次会话中**。
2. **未提交渲染改动的归属与冻结状态未确认。** §1.2 要求「实施前由 Jeffy 与这些改动的负责人确认基线」。这批改动是 `GemMaterial` 的主体，而 R1 第 1 轮正是把它关掉做对照 —— 需要确认它**已冻结**（还是仍有人在改），否则 R1 的 before/after 不可归属。

## 7. 本轮改动清单（全部为 R0 证据工具与文档，不含游戏实现）

新增：`tools/visual-fixtures.mjs`、`tools/frame-diff.mjs`、`tools/crop-r0-evidence.py`、`tools/fixtures/visual-color-board-{a,b,c}.json`、
`docs/Technical/BLOCK_REFERENCE_REWORK_R0.md`、`docs/Technical/assets/block-reference-review/before-r0-*.png`（8 张）。

修改：`tools/screenshot.mjs`（探针**纯新增**字段）、`docs/README.md`（导航）。

**未改**：`src/game/**`、`src/platform/**`、`src/rendering/**`、候选池／权重／存档 RGB、98 格拓扑、任何材质参数、版本号。

## 8. 归档证据

`docs/Technical/assets/block-reference-review/`（※ 旧的两张 `current-v0.9.32-mobile.png` / `historical-v0.9.21-colored.png` 保留不动）：

| 文件 | sha256（前 16） | 说明 |
| --- | --- | --- |
| `before-r0-block-1to1-color.png` | `d174292ba6ed1307` | 彩块 1:1（147px = 3 格 × 48.93px） |
| `before-r0-block-1to1-wood.png` | `d270158424dd4294` | 木块 1:1，同尺寸同位置 |
| `before-r0-candidates-1to1-color.png` | `c5881f49a9c865f7` | 候选托盘 1:1（366×117） |
| `before-r0-color-mobile.png` | `4a8594a667fddca3` | 彩色盘面手机全屏（批次 a） |
| `before-r0-color-mobile-surface-only.png` | `2fa19d0d47f84b3c` | 同上姿态，四项体积响应关闭 |
| `before-r0-color-mobile-rotation.png` | `0f6b2d6afd608e16` | 真实拖拽转动中间帧（yaw 0.311） |
| `before-r0-color-mobile-batch-b.png` | `174dba31926e431e` | 批次 b（J／S／Z） |
| `before-r0-color-mobile-batch-c.png` | `e33558c1c15fb3a5` | 批次 c（Rect 6／Block 9／T） |

**复现性证据**：`before-r0-color-mobile-rotation.png` 取自 sweep 的第 4 个姿态；sweep 回到 offset 0 的帧与基准帧**逐像素相同**（`tools/frame-diff.mjs` → mean \|d\| 0.000，max 0），全屏帧与证据 A 哈希一致。→ 固定条件下本基线**可复算**，R1 起的 before/after 归属成立。

## 9bis. 参考原图到手后的测量（2026-09-30 追加）

制作人已交付目标参考图（941×1672）。归档为 `assets/block-reference-review/reference-target-941x1672.png`，
测量脚本 `tools/measure-reference.py`（重跑即复现本文全部数字）。

### 9bis.1 先纠正一处溯源不符

交接文档 §1.1 记的目标图标识为 `sha256:b4bd6484…2d82`，但**实到文件的 sha256 是
`c2d6f929f906f8a54c94381512e72d80844e8778fa313cc19d2304fccab6467d`**（941×1672 RGB）。
本文所有数字都针对 `c2d6f929…` 这一份。两者若本是同一张的不同编码，需要 Luna 说明；否则 §1.1 的标识应更正。

### 9bis.2 参考图的尺寸关系（同一把尺子，归一化到 390px 宽）

| 量 | 参考图 @941 | 归一化 @390 | 本次实现 @390 | 差异 |
| --- | --- | --- | --- | --- |
| 棋盘单格 pitch | ≈ 75–80 px | **31.1–33.2 px** | **48.93 px** | 我们的棋盘单格是参考的 **1.47–1.57×** |
| 候选单格 pitch | ≈ 47.5–49 px | **19.7–20.3 px** | **≈ 22.9–23.6 px** | 我们的候选绝对值**略大** |
| **候选 ÷ 棋盘** | — | **≈ 59–65%** | **47–48%** | 我们的候选相对棋盘**小约 23%** |
| 立方体正面宽 | ≈ 400 px | 42.5% 画幅宽 | 244.65 px / **62.7%** 画幅宽 | 我们的立方体大得多 |

**两条结论**：

1. **「候选单格明显小于棋盘」成立，但根因不是候选太小，而是棋盘太大。** 参考图的候选单格
   按像素算比我们还小（19.7 vs 22.4 px @390），它是靠**棋盘只占画幅 42.5%** 才把比值做到 ~62%。
   我们现在是 62.7%。
2. **只改槽内留白到不了参考比值。** 要达 62%，候选 pitch 需 0.62 × 48.93 ≈ **30.3 px**；
   四格长条即需 ≈**121 px** 净宽，而槽内画布只有 **103.4 px**（§5.4 已测）。
   这与 §5.3 的判断一致：**要么把整条托盘布局当独立提案改，要么缩小立方体**——两者都超出
   方案 A「不改 camera／bearing／cubeLift」的范围，需制作人裁决。
3. 支持缩小立方体的旁证：v0.9.1 制作人已提过一次「竖屏六面体太大，缩小 10%」，
   `portraitCubeScale = 0.86`。方向一致，但**幅度需要重新裁决**（1.47× 是很大的量）。

### 9bis.3 参考图的材质读法（1:1 裁切目视 + 数值）

1:1 裁切见 `artifacts/visual-r0/ref-cube-1to1.png`、`ref-tray-1to1.png`（本机，未入库）。

- **完全不通透。** 参考的彩块是不透明实心块：一个平整饱和的正面 + 一条**柔和的宽高光**从左上铺下来，
  没有内部色芯、没有内外两层、没有果冻感。**这直接给出 R1 第 1 轮的判据**：四项体积响应应当**归零**，
  而不是调小——结合 §5.2 的量化（关掉后手机 18% 像素动了、其中 63% 幅度仅 2–8 级），
  这四项贡献的正是一层不属于参考的低幅雾化。
- **造型是「面平、边圆」。** 倒角半径目视约占棱长 12–16%，与本项目 `0.13/0.95 = 13.7%` **接近**；
  差异不在半径数值，而在**面内的光结构**：参考是近平面的宽柔高光，我们是硬的两段式分界 + 近白上沿。
- **候选块有真实厚度。** 参考里每个候选立方体都露出顶面（一条更亮的窄带），确实是同一系列积木的小号件 ——
  与 §5.1 一致；我们当前几乎看不到厚度。
- **木块更浅更平。** 参考的奶油木块接近 `#F0DEC0`，面内近平、纹理极弱；我们的木块偏暖棕
  （`blockColor 0xf3c99a`）且鼓面/色阶变化更明显 —— 对应 §3 P1「木块更像圆角小垫片」。
- **缝更细、更少棕。** 参考的块缝读作柔和阴影线，四块交汇处只有一个小暗点；我们的缝更宽、更暖
  （背后 `hullColor 0xad754c` 的沟槽色透出来）。
- **不变项**：HUD、道具条、石台、背景美术与参考同源（同一套 pastoral 资源）。
  参考的道具条**没有图标下方的文字标签**，我们有 —— 属 HUD 范畴，按 §0 **不在本轮范围**，仅记录。

### 9bis.4 R1 候选改动方向（待批准，尚未落码）

按 §4.2 的顺序，第 1 轮先只证材质方向：

| 组 | 当前 | R1 第 1 轮 | 依据 |
| --- | --- | --- | --- |
| `GEM_STYLE` 四项体积响应 | scatter 1.0／coreAbsorption 0.42／internalReflection 0.4／environmentTransmission 0.28 | **四项归零** | 参考完全不通透；§5.2 量化其贡献为低幅雾化 |

第 2 轮再动表面（**等第 1 轮被认可后才做**，且需先解决下方两份输入）：

| 组 | 当前 | 建议起点 | 目的 |
| --- | --- | --- | --- |
| `paintCrownHeight` | 0.032 | 0.008–0.016 | 去掉面内反射变形，让面回到近似平 |
| `paintRoughness` | 0.12 | 0.18–0.26 | 把「硬亮斑」摊成参考那样的宽柔高光 |
| `paintClearcoat`／`ClearcoatRoughness` | 1／0.045 | 0.7–1／0.09–0.16 | 保留倒角亮点，去掉近白上沿 |
| `paintEnvMapIntensity` | 0.85 | 仅在仍泛白时试 0.55–0.75 | 只影响彩块，不连带压暗木块与背景 |

**不动**：`blockSize`／`blockRadius`／`blockSegments`（倒角比例已接近参考）、camera／bearing／cubeLift、
`voxelEdgeOpacity`。

## 10. 每轮回执模板（按交接文档 §9）

```text
轮次／commit／工作区补丁：R0／4ec3c42 + 本轮 R0 工具与文档；未提交渲染改动原样保留（非本轮所改）
本轮唯一假设：无（R0 只冻结与测量，不改渲染）
只改了哪些参数／函数：无。仅新增探针只读字段 pieceMetrics/trayMetrics/boardCellPx/devicePixelRatio/canvasPx
未改的玩法与交互边界：全部未改（src/** 零改动）
Before / After 路径：本轮只有 Before（见 §8）；After 不存在
390px 手机实际尺寸观察：候选单格块高 22.4px，棋盘格距 48.93px，托盘 366.6×116.5，槽 103.4×80.4
工程检查／性能数据：npm test 全绿（含 gem-material-tests）；draw calls / program / 纹理数未另测（R4）
尚未验证与保留差异：参考原图未到手；320×740 与横屏未采；5 格件批次未采；物理手机未测
Luna 结论：待补 —— 请给 R0 通过／附条件通过／退回
下一轮最大的一个问题：R1 第 1 轮的「实心亮面」判据需要参考原图，请一并提供
```

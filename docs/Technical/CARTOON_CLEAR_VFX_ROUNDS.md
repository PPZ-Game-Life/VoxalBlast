# 卡通消除特效实施回执（R0–R4）

> 上游交接单：[CARTOON_CLEAR_VFX_HANDOFF.md](CARTOON_CLEAR_VFX_HANDOFF.md)（Luna，2026-10-09）。
> 本文按 R0–R4 逐轮记录**实际执行**的读数与证据路径。没有执行的项目一律写「未测」，不给建议值打勾。

## R0 — 冻结基线与现有 clear 证据

**基线**：HEAD `bf03464f`（= 交接单提交本身），`package.json` **0.13.2**，分支 `main`。
**他人改动**：工作区仅 1 个未跟踪文件 `public/__three-probe.html`（另一会话的临时 THREE 探针页，13 行，只暴露 `globalThis.__THREE_PROBE__`）。本轮**未**改动、未提交它。`git status` 无其它脏文件。
**本轮新增（工具与 DEV 只读钩子，不改外观、不改规则）**：
- `tools/cartoon-clear-probe.mjs` — 本轮唯一探针入口，`r0|r1|r2|r3` 分轮。
- `tools/cartoon-clear-fixtures.mjs` — §9.1 规则用例的会话快照夹具。
- `src/main.js` `devHandles.dropAt()` + `onDrop()` 返回结算记录；`src/diagnostics.js` 暴露 `__voxalblastDev.dropAt()`。

### 取证条件（同 URL / 同种子 / 同视口）

| 项 | 值 |
| --- | --- |
| URL | `http://localhost:5199/`（本轮自起的 Vite dev server，**非** 5173/5174 上他人残留的实例） |
| 视口 | 1440×900（desktop，DPR 1）、390×844（phone，DPR 1） |
| 种子/姿态钳制 | `__voxalblastDev.setBoardFloat({frozen:true,time:0})` + `setAmbient({frozen:true,time:0})`（§8.7 的两条世界时钟同时钳死） |
| 光栅化 | `--headless=new --use-angle=d3d11`（`CC_GPU=1`）。**帧节拍 p50=18ms ≈ 56fps**，因此 0/65/110/180/260/360/420/600ms 的节拍表是可信的；软件光栅（`--disable-gpu`）下同场景只有几帧/秒，节拍表会变成对采样器的描述，故不再采用 |
| 证据 | `artifacts/cartoon-clear-v1/r0/evidence.json` + 2×(1 静帧 + 8 节拍帧 + 9 夹具前帧) PNG |

### 基线读数

| 读数 | desktop 1440×900 | phone 390×844 |
| --- | ---: | ---: |
| 空闲帧 draw calls / triangles | **240 / 270,282** | **129 / 148,745** |
| `quality.lowPower` | false | **true**（窄屏 ≤700px 命中） |
| 98 格实体完整性（`intro().integrity`） | tiles 98，scale/position/material/opacity/shadow **offset 全 0**，maxErr 0 | 同左 |
| 六面体屏幕投影盒（`framing().solid`） | x 517.5→930.8，y 160.3→628.2 | x 57.7→337.5，y 254.0→572.2 |
| 计分基线 | score 0 / cells 0 / totalLines 0 | 同左 |
| 空闲 FX 存活 | liveChips 0 / systems 0 / transients 0 | 同左 |

### 现有 clear（`demoClear(1)`，单线）

| 读数 | desktop | phone |
| --- | ---: | ---: |
| 事件预算 / 实际发射 | 6 / 6 | 3 / 3 |
| 装饰数 | 1 | 1 |
| **全部清零时刻** | **466ms** | **467ms** |
| 节拍存活（chips/decorations/bands） | 65ms 6/1/1 → 360ms 6/1/1 → 420ms 6/1/**0** → 600ms 0/0/0 | 同上，数量 3 |

§5 对新方案的硬指标是「单线 360ms 前 0 存活、420ms 后本事件轮廓/闪点/粒子全为 0」。**现有实现单线要到 466ms 才收净**，超出 §5 的单线窗口 106ms —— 这正是本轮要替换的分支，不是已经达标的能力。

### 规则用例：raw face line ≠ 物理线（§4.1 的现行缺口）

用 9 个真实会话夹具各做**一次真实落子**（`__voxalblastDev.dropAt()` → 同一个 `onDrop()` → 同一个 `settlePlacement()`；候选是真实手牌，格坐标是输入层同一套 `currentCells → faceOrientedCells`）。所有夹具落子前 `fullLines` 均为 0（生成器硬断言），落子合法。

| 用例 | raw face lines（board.js 实际产出） | 物理线（§9.1 期望） | uniqueCells | 现有预算 | 计分 |
| --- | --- | ---: | ---: | ---: | ---: |
| single | 1 `+z:row2` | 1 | 5 | 6 | 0→135 |
| parallel | 2 `+z:row1 +z:row2` | 2 | 10 | 12 | 0→585 |
| cross | **3** `+x:row4 +z:row2 +z:col4` | 2 | 9 | 12 | 0→735 |
| shared-edge | **2** `+y:row4 +z:row4` | **1** | 5 | 6 | 0→335 |
| face-pair | 2 `+x:col2 +z:row2` | 2 | 9 | 12 | 0→735 |
| three | **4** `-y:row4 +z:row0/1/2` | 3 | 15 | 24 | 0→1965 |
| four | **6** `+x:row4 -y:row4 +z:row0/1/col3/col4` | 4 | 16 | **64** | 0→5915 |
| five | **7** `+x:row4 -y:row4 +z:row0/1/col2/col3/col4` | 5 | 19 | **64** | 0→12435 |
| legacy-single | 1 `+z:row2` | 1 | 5 | 6 | 0→135 |

三条由读数直接确立的事实：

1. **多报是系统性的，不是特例**。共享棱/共享角让同一段空间被两个面各报一次：`cross` 多 1 条、`three` 多 1 条、`four`/`five` 各多 2 条。`shared-edge` 是最干净的证明：raw 2、物理 1、unique 5。
2. **预算现在由 raw 条数决定，因此按重复计数超发**。`four`（物理 4 线）与 `five`（物理 5 线）都拿到 L5 的 64，因为 ladder 看到的是 raw 6/7。§4.3 要求 `physicalLineCount` 决定预算。
3. **装饰数同样跟着等级走**：`four`/`five` 各 6 个装饰（旧 `decorationCap.standard = 8`），§4.3 新表对 3+ 只给 4 个星/闪点。`wipedFaces` 在这些用例里全为空 —— 旧 FACE_CLEAR 面扫亮不参与，新方案不得据此推断面轮廓。

### R0 出门状态

- [x] HEAD / 版本 / 脏文件已冻结并写明
- [x] 现有 clear 的同 URL、同姿态钳制、同视口证据（读数 + 图像）
- [x] draw calls / 98 格实体 transform / 相机投影盒 / 计分 四项基线
- [x] raw-vs-physical 缺口用真实落子取证，而不是靠读代码推断
- [ ] 五个必要视口（1440×900 / 1280×720 / 390×844 / 844×390 / 2048×900）—— 本轮只跑 2 个，其余在 R2/R3 补
- [ ] 真机 —— R4

## R1 — 8 贴图真实采样 + 单线短反馈

**版本**：`0.13.3`（`package.json` + `package-lock.json` 同步）。
**只改文件**：
- 新增 `src/rendering/cartoonClearPlan.js`（纯规划器）、`tools/cartoon-clear-plan-tests.mjs`、`tools/cartoon-clear-probe.mjs`（R0 已建，本轮扩展）。
- 新增 `public/art/cartoon-clear-v1/atlas.png` + `atlas.json`（**只**复制 §3.1 允许的两件，参考大图/预览/SVG/报告均未入首包）。
- 改 `src/rendering/config.js`（新 `CARTOON_CLEAR` 参数块）、`src/rendering/effects.js`（新正常消除分支 + atlas 加载 + 采样门）、`src/main.js`（接线、可见面顺序、生命周期取消、DEV `atlasGate`）、`src/diagnostics.js`、`package.json`/`package-lock.json`。

### ⚠️ 施工中发现的上游缺陷（R0 读数已证实，本轮一并修掉）

**`emissionBursts[].count` 传 `ConstantValue` 等于一发都不发。**
`three.quarks` 0.10.8 自己的声明文件写的是 `interface BurstParameters { count: number }`，运行时 `ParticleSystem.spawn()` 直接 `for (i = 0; i < count; i++)` —— 传对象时比较结果为 `NaN`，**循环体一次都不进**，而本模块所有计数器（`liveChips`/`budget`/`spawned`）仍然报满额。
R0 实测（`artifacts/cartoon-clear-v1/r0/evidence.json`）：旧 `demoClear(1)` 报 `liveChips=6`，同时 `liveParticles`（`system.particleNum` 之和）**全程为 0**，棋盘区域一个像素都没变。也就是说交接单 §6.1 那句「当前 burst `count` 仍按已验证的 `ConstantValue` 方式构造」是错的，**旧消除实际上没有画出纸屑**。
本轮把两条路径（`spawnChips` 与新的卡通池）都改成传普通数字。修复后的 R1 读数里 `peakSprites=14` 且像素确有变化。

### 8 贴图采样门（§3.1 第一道门）

`__voxalblastDev.atlasGate()` 用**运行时的同一条 Quarks BillBoard 路径**（同一材质、同一 `startTileIndex`）把 8 个 tile 画成一排，然后探针对「门帧」与「静帧」做像素差，在**每个 tile 自己的四边形窗口**内量它的包围盒与 alpha 质量重心，再和交付的 `runtime/sprites/*.png` 逐个对比。判据三条，全部对交付物的独立测量：

| 判据 | 说明 |
| --- | --- |
| 图形包围盒（占 tile 的比例） | 选错 tile 会立刻改变它（星 0.80、短横 0.76×0.30、方片 0.62） |
| 重心 dx / dy（以半盒为单位） | 上下/左右翻转会把质量搬到中心另一侧；`swoosh`/`dash` 的 `+X` 朝向正是靠 dx 判定 |
| 窗口是否贴边 / 是否超 1.5 倍 | 测不了就报 UNMEASURED，不给打勾 |

**结果（desktop 1440×900）**：8/8 tile 全部画出。`confetti-blue` `confetti-teal` `sparkle-cream` `dot-blue` `swoosh-cream` **六项全部通过**，包围盒误差 ≤0.03、重心误差 ≤0.10：

| tile | 实测包围盒（占 tile） | 期望 | 实测 dx/dy | 期望 dx/dy |
| --- | --- | --- | --- | --- |
| confetti-blue | 0.621 × 0.621 | 0.625 × 0.625 | -0.008 / 0.000 | -0.011 / 0.004 |
| confetti-teal | 0.712 × 0.734 | 0.695 × 0.719 | -0.017 / 0.009 | -0.018 / 0.002 |
| sparkle-cream | 0.684 × 0.684 | 0.656 × 0.656 | -0.002 / 0.000 | -0.003 / 0.001 |
| dot-blue | 0.524 × 0.524 | 0.516 × 0.516 | 0.013 / 0.007 | 0.000 / 0.000 |
| swoosh-cream | 0.794 × 0.481 | 0.773 × 0.484 | 0.061 / -0.081 | -0.039 / -0.069 |
| **confetti-pink** | 0.732 × 0.610 | 0.609 × 0.617 | -0.022 / -0.006 | -0.018 / 0.005 |
| **star-pop** | 测不了（窗口被污染） | 0.797 × 0.797 | — | 0.001 / -0.002 |
| **dash-blue** | 0.758 × 0.670 | 0.758 × 0.305 | -0.052 / 0.390 | -0.041 / -0.033 |

**未决 2 项（不打勾）**：`star-pop` 的窗口里出现了超出图形本身的像素变化（90×86 的掩码填满窗口），`confetti-pink` 的包围盒宽度比 sprite 自身轮廓大 0.12（其余 6 项只大 0.00–0.03）。两者怀疑是后处理链（Bloom 阈值 1.35 / SMAA 边缘）在 tile 自身窗口内留下的晕边，**本轮没有把方法学到能排除它**，所以按「UNMEASURED」记录，不放进通过项。`dash-blue` 同理归入未决。
人眼核对 `artifacts/cartoon-clear-v1/r1/desktop-atlas-gate.png`：8 个 tile 依次为蓝圆角方片、青圆角方片、粉圆角方片、奶油金五角星、奶油四角闪星、蓝圆点、奶油短弯扫痕、蓝短拖尾，**无倒置、无串格、无黑边**。

### 单线短反馈（§5 时序）

`demoClear(1)`（同一 Quarks 路径、同一材质）在原位替换后：

| 读数 | desktop 1440×900 | phone 390×844 |
| --- | --- | --- |
| 物理线 / raw 线 / unique 格 | 1 / 1 / 5 | 1 / 1 / 5 |
| 预算（按 `physicalLineCount`） | 14 | 7（低配） |
| 实际发射 | 14 | 7 |
| **本事件收净时刻** | **352ms** | **349ms** |
| 对比：替换前同一用例 | 466ms | 467ms |

§5 的单线硬门是「360ms 前 0 存活」，替换前超 106ms，现在两项都在窗内（判定允许一帧采样粒度，本机一帧 18ms）。
另外 `渲染调用的差`：事件期间 desktop 240→243，即新增 3 个 draw call（轮廓 1 + 精灵 batch 2），在 §7.2 的 ≤4 目标内；三角面增量未单独取，R3 补前后同 fixture 取差。

### 本轮已实现 / 未实现

已实现：`CARTOON_CLEAR` 参数块（§4.3 预算表、§5 时间轴、§5.2 尺寸与颜色、全局 64/32、事件上限 2、发射上限 8）；纯规划器（物理线/面脚印/唯一格/交点/端点/预算/独立 VFX 种子）并在 **9 个真实盘面用例**上全绿；atlas 采样与失败兜底（`fallbackMaterial` 程序方片，绝不阻塞第一手）；贴面轮廓（合批、每事件 1 材质、`followCube` 转面 80ms 退场）；真实延迟发射（`paused` 到档点，不是 `setTimeout`）；`clearScopeEpoch` 作用域与 `cancelCartoonScope()`（设置/帮助/主页/hidden/局终/重开/恢复存档全部经 `syncPause` 与三处 reset 收口）。

未实现（留给 R2/R3）：多线/跨面的发射位按可见面分配仍是「frontFace 优先 + 稳定 face 排序」，**可见面遮挡下的取舍没有专项验证**；彩色残像（§5.1 扩展）未做，按交付单「不依赖该扩展才能开始施工」；`three.quarks` 的 layer3 合同仍是 layer0（`clearLayers` 已在构造处接入，等 gameScene 侧一起改）；`tools/celebration-audio-probe.mjs` 的预算断言**仍指向旧 `CELEBRATION` 表**，未按 §9.2 改到新权威配置 —— 这是下一轮必须还的账，本轮不宣称已过。

### 验证命令与结果

```
node tools/cartoon-clear-plan-tests.mjs   PASS  0 failures（9 用例 × 每条 17 项断言）
node tools/rule-tests.mjs                 554/554
node tools/game-session-tests.mjs         205/205
node tools/i18n-tests.mjs                 175/175
node tools/cartoon-clear-probe.mjs r1     2 failure（均为上表 UNMEASURED 的两项，未隐藏）
```

## R2 — 多线规划/去重/预算 + 卡通短弧

**只改文件**：`src/rendering/cartoonClearPlan.js`（脚印身份修正）、`src/rendering/effects.js`（事件记录补齐、轮廓贴面偏移）、`tools/cartoon-clear-probe.mjs`、`tools/celebration-audio-probe.mjs`、`tools/png-read.mjs`、本文档。版本仍 **0.13.3**（R1 同版内补完，未升版）。

### 本轮修掉的三个缺陷

1. **面脚印身份用错了键**。原实现用 `(face, axis, index)` 做脚印身份，而 `level`/`demoClear` 这类手工 descriptor **没有 `v`/`u` 字段**（§9.1 早已警告）。于是同一面的每一行都塌成同一个脚印：`demoClear(5)` 只报 raw=2、physical=2、unique=9，比数从 5 掉到 2，预算也跟着掉到 22。改成 `face + 该行真实格集合` 作为身份后，9 个真实盘面用例全部给出 §9.1 的物理线数。
2. **横屏手机的预算期望算错了**（探针侧）。`cramped` 与 `lowPower` 是两条独立降级（§4.3），只看 `lowPower` 会把横屏手机正确的 7 报成失败。探针现在同时套用两条。
3. **夹具的盘面会漏进后续取证**。夹具通过 `addScriptToEvaluateOnNewDocument` 注入，`onDrop()` 又会把这一局存进 `localStorage`，于是后面「空盘」的节拍帧全拍到了夹具盘面（第一版 `r2` 的 5 线截图就是这种）。现在注入脚本会被撤销、并追加一条「进入时清掉存档」的脚本，且每个视口开拍前**硬断言** `cells=0 / score=0`——这条守卫就是为了让这类泄漏以后不可能静默发生。

### §9.1 规则用例：9 个真实盘面，一次真实落子

`raw` 是 `board.js` 实际报出的面线；`physical` 是规划器去重后的物理线；预算按 `physicalLineCount` 选行。

| 用例 | raw 面线 | 物理线 | unique | 预算 | 计分 |
| --- | --- | ---: | ---: | ---: | ---: |
| single | 1 `+z:row2` | 1 | 5 | 14 | 0→135 |
| parallel | 2 | 2 | 10 | 22 | 0→585 |
| cross | **3** `+x:row4 +z:row2 +z:col4` | **2** | 9 | 22 | 0→735 |
| shared-edge | **2** `+y:row4 +z:row4` | **1** | 5 | **14** | 0→335 |
| face-pair | 2 `+x:col2 +z:row2` | 2 | 9 | 22 | 0→735 |
| three | **4** `-y:row4 +z:row0/1/2` | **3** | 15 | 32 | 0→1965 |
| four | **6** | **4** | 16 | **32** | 0→5915 |
| five | **7** | **5** | 19 | **32** | 0→12435 |
| legacy-single | 1 | 1 | 5 | 14 | 0→135 |

对照 R0 同一批用例：`shared-edge` 从 6 降到 14（不再为一段空间付两次），`four`/`five` 从 64 降到 32（§4.3 的 3+ 行封顶）。所有 `uniqueCells` 与夹具期望逐一相等，`planClear()` 的物理线数与 §9.1 表逐一相等。

### §5 时序：单线到 5 线

| 用量 | desktop 1440×900 | phone 390×844 | 横屏 844×390 |
| --- | --- | --- | --- |
| demoClear(1) 预算 / 收净 | 14 / 356ms | 7 / 357ms | 7（cramped 减半）/ 347ms |
| demoClear(2) | 22 / 409ms | 11 / 406ms | 11 / 413ms |
| demoClear(3) | 32 / 414ms | 16 / 415ms | 16 / 405ms |
| demoClear(4) | 32 / 418ms | 16 / 415ms | 16 / 404ms |
| demoClear(5) | 32 / 404ms | 16 / 416ms | 16 / 418ms |

单线 ≤360ms、多线 ≤420ms 全部在窗内（判定允许一帧采样粒度，本机 p50=18ms）。低配列严格是标准列的一半（7/11/16/16/16），横屏再减半。

### 卡通短弧与轮廓

- 短弧：`swoosh-cream`，65–140ms，按所在端点的屏幕方向做 billboard 旋转（`screenAngleDeg`），沿线轴向外、不超过 0.45 格；5 线用例给 4 条。
- 轮廓：每事件 1 个合并 mesh、1 个材质（不按格新增 material），逐面脚印一条丝带，`followCube` 转面 80ms 退场，`opacity ≤ 0.75` 一次亮起收净。
- **一处实测修正**：轮廓最初按 §6.2 的 0.005–0.012 格外偏放置，65ms 截图里**完全看不到**——壳层方块本身高出面平面，0.012 的丝带被埋在方块里面（计数器仍然说轮廓存在）。改成读 `BOARD_STYLE.feedbackSurfaceOffset`（与既有亮带同一个「离开方块面」的常量）后才画得出来。**但它的对比度/可读性尚未按 §5「格线始终能读」评级**，本轮只确认「画出来了」，不宣称视觉已验收，留给 R3 与真机一起定。

### 旧探针改指新权威（§9.2，R1 欠账已还）

`tools/celebration-audio-probe.mjs` 的预算/时长/池断言全部改指 `CARTOON_BUDGETS` / `clearTailSeconds` / `cartoon.liveSprites`，**原有负向断言一条未删**（reduced-motion 不飞、静音真的静音、一手一声主音、场景切换、语音上限）。过程中又发现并修掉三处探针自身的失效：

1. 旧像素判据用页内 `drawImage(webglCanvas)` 采样——未开 `preserveDrawingBuffer` 的 canvas 不可保证读得到，它对一个屏幕上看得见的 5 线特效报「0/1024 格变化」。改为对**合成后的 CDP 截图**在棋盘轮廓矩形内做前后差；现在读到 514/109120 像素变化。
2. `table[5]` 越界（新表只有 1/2/3 行），恒为 `undefined`。
3. 「关掉 reduced-motion 又飞起来」在**立即读**报告时必然读到尚未发射的暂挂系统——§5 的 110ms 是真实延迟。改为触发后等 180ms 再读。

**结果：`node tools/celebration-audio-probe.mjs <url>` 全绿。**

### R2 出门状态

- [x] 平行/交叉/3+/四线/五线/共享满棱/跨面/旧 v1 存档 8 类用例全部由真实盘面 + 一次合法落子产生
- [x] 粒子不随 raw 线数倍增；预算由 `physicalLineCount` 决定
- [x] 低配与 cramped 两档独立生效并各有读数
- [x] 单线 ≤360ms、多线 ≤420ms，三个视口各自实测
- [x] `probe:celebration` 改指新权威后全绿，负向断言未删
- [ ] 轮廓的视觉可读性未评级（见上）
- [ ] 彩色残像（§5.1 扩展）未做 —— 交付单允许不依赖它施工
- [ ] 快速连发/重叠事件（2 个上限、全局 64/32 上限）—— R3
- [ ] layer3 合同、性能前后同 fixture 取差 —— R3

## R3 — 生命周期 / 低配 / reduced-motion / 帧开销

**只改文件**：`src/rendering/effects.js`、`tools/cartoon-clear-probe.mjs`、本文档。版本仍 0.13.3。

探针新增一个 §7 生命周期段落（`r3` 轮，跑在 desktop 视口、节拍取证之后），每项都是**转变**而不是某一帧。

### 修掉的两个真缺陷

1. **几何体泄漏**：每事件的轮廓自建一个 `BufferGeometry`，移除时只 dispose 了 material。100 轮触发/清理后 renderer 几何体 **27 → 127**。现在 `addTransient({ ownGeometry: true })` 标记该事件私有几何体，`releaseTransient()` 统一释放（庆祝池的共享几何体仍然**不**释放）。复测 **19 → 19**。
2. **作用域取消只做标记、不做移除**：`cancelCartoonScope()` 原先把轮廓的 `until` 设成 now 就返回，靠帧循环压缩列表——可 §7.1 的每一个转变**同时也会暂停帧循环**（设置面板、主页封面），于是 `effects.update()` 根本不跑，被取消的轮廓会一直留在列表里。现在直接移除并释放。
3. reduced-motion **动态开启**（§7.1「当帧停飞行」）原先只在下一个事件生效。现在 `honourReducedMotionToggle()` 在 `update()` 里检测偏好翻转，当帧收掉飞行精灵；**轮廓不停**——它是确认不是装饰，允许把自己那一次淡出收完。

### §7 生命周期读数（desktop 1440×900）

| 用例 | 读数 | 判定 |
| --- | --- | --- |
| A 第三个重叠事件 | liveEvents **2**，最新事件轮廓仍在（`outlines=2`），计分未丢 | OK |
| B 两次 5 线事件相隔 40ms | liveSprites **48 / cap 64**，liveEvents 2 | OK |
| C 主页封面 | 转变前 live 24 → 转变中 **0 / outlines 0**，epoch 3→6，回来 **0（不补播）** | OK |
| D 飞行中打开 reduced-motion | liveSprites **24 → 0（120ms 内）**，无需刷新 | OK |
| E 100 轮触发/清理 | systems/sprites/events/transients **全 0**；98 格 tiles=98、scale/position 偏移 0；几何体 **19 → 19** | OK |
| E reduced-motion 静态确认 | 0 飞行 + 1 静态闪点（`probe:celebration` 亦覆盖） | OK |

### 未通过的项（按实测照报，未放宽）

**C-settings：打开设置面板没有关闭正常消除作用域。** 面板确实打开了（探针先断言 `settingsOpen=true`，避免把「按钮是 toggle、上一次没关」误判成打开），但 `scopeEpoch` 停在 6 不变，且因为帧循环被暂停，`outlines` 仍留在列表里（`duringLive=0` 只是 `until` 被标记后的读数，不是真的清掉了）。同一套探针里**主页封面是正常关闭的**（epoch +3）。所以这不是探针写法问题，而是 `#settings-button` 这条路径上 `syncPause()` 没看到「已打开」或 `onOpen` 没走到取消逻辑——**本轮未定位根因**，如实记为待查，不给它打勾。

**F：单线与 5 线的帧开销都是 +5 draw calls，比 §7.2 的 ≤4 目标多 1。** 两种事件同样是 5，说明它与精灵数量无关（1 个轮廓 mesh + 若干 batch）。本轮只记录「多 1」，**没有把 5 个额外调用归因清楚**；三角面 +126，远在 2500 以内。

### 未做

- layer3 合同（`clearLayers` 已在 `ParticleSystem` 构造处接入，但仍是 layer 0，等 gameScene 侧一起改）
- 拖拽/旋转时的 ≤80ms 退场（`retreatDecorations()` 已把 cartoon 池收到 80ms，但**没有驱动真实指针手势来取证**）
- hidden / 局终 / 重开 / 恢复存档 的取消（代码路径存在，探针只覆盖了主页与设置两条）
- 真机（R4）




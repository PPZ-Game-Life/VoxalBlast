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




## R4 — 五视口抽查、取消用例前置断言、文档与缺口

**只改文件**：`tools/cartoon-clear-probe.mjs`、`docs/Technical/KNOWN_GAPS.md`、本文档。版本仍 0.13.3（本轮无行为改动）。

### §9.2 的五个必要视口（全部跑完）

每个视口都**先断言开拍在空盘**（`cells=0 / score=0`），再跑 demoClear(1..3) 与 0/65/110/180/260/360/420/600ms 节拍帧。

| 视口 | 预算 1/2/3 | 收净 1/2/3 | 判定 |
| --- | --- | --- | --- |
| 1440×900 | 14 / 22 / 32 | 356 / 414 / 415 ms | 单线 ≤360、多线 ≤420 全在窗内 |
| 1280×720 | 14 / 22 / 32 | 358 / 410 / 419 ms | 同上 |
| 390×844（低配） | 7 / 11 / 16 | 352 / 407 / 413 ms | 同上 |
| 844×390（横屏，cramped） | 7 / 11 / 16 | 346 / 408 / 416 ms | 同上 |
| 2048×900 | 14 / 22 / 32 | 361 / 417 / 407 ms | 单线 361ms 落在「360 + 一帧(18ms) + 2ms」的采样粒度内 |

### 纠正上一轮的一个错误结论

R3 据设置面板用例写下「设置面板没有关闭正常消除作用域」。本轮给取消用例加了**前置断言**「转变前帧循环必须在跑」（用 `liveParticles` 判定——§5 的发射是真实 110ms 延迟，只有循环在跑时它才会变成非 0），结果：

```
OK   C home:     the frame loop is running before the transition  liveParticles=24
FAIL C settings: the frame loop is running before the transition  liveParticles=0
```

设置面板那个用例**一开始循环就已经暂停**，所以它测得的一切与设置面板无关——**上一轮的结论作废，改记为「用例无效」**，而不是产品缺陷。主页封面那条在同一个 run 里是明确的（epoch 3→6、回来不补播、0 sprites / 0 outlines）。**仍然未查清的是：主页用例走完之后循环为何停在暂停态**（已进 `KNOWN_GAPS`）。

### 本轮**没有**做的（R4 的核心项）

- **真实设备**：一条都没测。全部读数来自本机 `--headless=new --use-angle=d3d11`（帧节拍 p50=18ms）。没有物理手机、没有微信/QQ 内嵌环境、没有真机手感与真机帧率。§9.2 明写「物理手机至少一台，平台嵌入另验」。
- **录屏**：没有真机录屏，也没有可用作「手感」证据的录像。现有产物是**每个视口在每个命名节拍上的一张张静帧**（`artifacts/cartoon-clear-v1/r{1,2,3,4}/<viewport>-clear<N>-<beat>ms.png`）——它们是渲染时钟上的真实采样，但**单帧不能证明节奏**。按 §9.2 的要求，**不把无头截图拼成视频冒充真实帧率**，所以本轮不交付「录屏」这件东西。
- **layer3 合同**：`clearLayers` 已在 `ParticleSystem` 构造处接入（batch key 包含 `layers.mask`，事后改 mask 必须重建 batch），但仍设为 layer 0；`gameScene` 侧的 `enable(3)` / NormalPass 临时 `disable(3)` 未做。
- **拖拽/旋转 ≤80ms 退场**：`retreatDecorations()` 已把卡通池收到 80ms、轮廓 `followCube` 转面 80ms 退场，但**没有驱动真实指针手势取证**。
- **hidden / 局终 / 重开 / 恢复存档 的取消**：代码路径存在（`syncPause` + `resetGame` + `applySession`），探针只覆盖了主页与设置两条。

### §8 R4 出门条件逐条对账

| 出门条件 | 状态 |
| --- | --- |
| 关键帧 | ✅ 五视口 × 8 节拍帧 |
| 实际录屏 | ❌ 没有真机录屏；不拿无头截图冒充 |
| 读数 | ✅ 本机五视口读数（上表） |
| 分别记录通过 / 未测 / 待修 | ✅ 本文档 + `KNOWN_GAPS` 五行 |
| 不拿 build 成功代替美术通过 | ✅ 全程未把 `npm run build` 或探针全绿当作美术验收；轮廓对比度、三个 tile 的数值判据都明确留着未通过 |

### R4 补完：layer3 合同与帧开销归因（v0.13.3）

**只改文件**：`src/rendering/config.js`（新增 `CARTOON_CLEAR.fxLayer = 3`）、`src/rendering/gameScene.js`、`src/rendering/effects.js`、`src/diagnostics.js`、`tools/cartoon-clear-probe.mjs`、`docs/Technical/KNOWN_GAPS.md`、本文档。

§6.2 把 layer3 定义为**待新增合同**，并明说「必须有像素/层 mask 探针，不是当前已有能力」。本轮把它做成**三个可读出的数**，而不是一句注释：

| 读数 | 实测 | 含义 |
| --- | --- | --- |
| `layers.clearMask` | **8**（1 左移 3 位） | 精灵在**构造时**就带上这个 mask（quarks 的 batch key 含 `layers.mask`，事后改必须重建 batch）；轮廓逐对象设，因为父 Group 不会把层递归给子对象 |
| `layers.beautyMask` | **15**（bit 0/1/2/3） | 主画质通道确实带着消除层 |
| `layers.normalPassMask` | **1**（只留 bit 0，819 次采样） | 法线/深度预通道同时排除 layer 1（阴影接收体）、2（景物）与 3（消除 FX），透明 quad 不再写进 SSAO 读的缓冲 |
| `layers.layersRestored` | **true** | 收窄不会活过一次 pass —— 否则下一帧整块棋盘会被 blank 掉 |
| 像素复核 | **2765 px** 变化 | 只有 mask 对不算数：mask 把 quad 从预通道排除、又从主通道排除，同样会「合同完美而什么都不画」 |

**顺带关掉了 R3 留下的帧开销缺口。** 同一个事件（单线与 5 线）的额外 draw calls 从 **+5 降到 +3**（240→243），落进 §7.2 的 ≤4。归因明确：多出来的 2 个调用就是粒子被**主通道与法线预通道各画一遍**；把消除 FX 挪到独立层并从预通道排除后这两个调用消失。三角面 +68，远在 2500 以内。

**未关掉的三条**（照报）：`star-pop` / `confetti-pink` / `dash-blue` 的采样尺寸判据、轮廓对比度未评级、设置面板用例无效（前置断言实测 `liveParticles=0`，用例开始时循环已暂停）。

### R4 补完（二）：§7.1 的退场与取消，用真实输入取证（v0.13.3）

**只改文件**：`tools/cartoon-clear-probe.mjs`、本文档。无产品代码改动。

R4 收尾时这几条只做到「代码路径存在」，本轮用**真实指针事件与真实转变**补上读数。

| 用例 | 驱动方式 | 读数 | 判定 |
| --- | --- | --- | --- |
| 新拖拽收掉飞行装饰（§7.1 ≤80ms） | CDP 在 `#piece-slots button` 上按下 → 上移 70px | 8 个飞行精灵在**起手 40ms 内**归零 | OK |
| 转面收掉贴面轮廓（§7.1 ≤80ms） | CDP 在 `#scene-wrap` 上按下横向拖 6 步 | 轮廓 1 → **0**（120ms 后），偏航实测到 **26.01°**（手势真的转了） | OK |
| hidden 清作用域且回来不补播 | 替换 `document.hidden` 取值并派发真实 `visibilitychange` | 24 → **0**；epoch 6→7；恢复可见后仍 **0** | OK |
| 局终清作用域 | `__voxalblastDev.endGame()` | 24 → **0**，`outlines` 0；epoch 7→8 | OK |

转面那条特别值得记：轮廓是 `followCube` 的，`updateTransientEffects()` 在 `cubeGroup.quaternion` 与本事件出生时的姿态差超过 0.04rad 时把 `until` 收到 `now + 80ms`。本轮把偏航读数（26.01°）与轮廓归零放在同一条证据里，**证明这是真的转了面**，而不是因为事件自己到期了。

仍然没验证的：**重开**（`resetGame` 路径存在，未单独驱动）与**恢复存档**（`applySession` 路径存在，未单独驱动）——两条都只做过代码检查，不给它们打勾。

### R4 补完（三）：设置面板那条「缺陷」的根因，以及最后两条 §7.1 转变（v0.13.3）

**只改文件**：`tools/cartoon-clear-probe.mjs`、`docs/Technical/KNOWN_GAPS.md`、本文档。无产品代码改动。

#### 根因：不是产品缺陷，是用例跑在了开场波次的输入锁里

R3 据一个用例写了「打开设置面板没有关闭正常消除作用域」；R4 加了前置断言后发现该用例开始时帧循环已暂停、从而判它无效。本轮把根因查清：

- 任何新一局开始后，**开场创建波次会握住输入锁约 1.05s**（`introPlaying()` 是 `syncPause()` 的一个合法暂停源）；
- 该用例排在上一个用例之后约 1.1s 就开测，**正好落在锁里**；
- 所以 `liveParticles=0`：发射从未被释放，测到的与设置面板无关。

把「每个用例先等波次结束（`intro().active === false`）」做成 `settleUi()` 的一部分之后，同一条断言直接由 FAIL 变 OK，**产品代码一行没改**：

```
OK   C settings: the frame loop is running before the transition  liveParticles=24
OK   C settings: the transition clears the normal-clear scope     liveSprites=0 outlines=0
OK   C settings: the scope epoch advanced, so a late callback is stale  epoch 6 -> 7
```

**R3 与 R4 关于设置面板的结论一并作废。** 教训写进了 KNOWN_GAPS：取消/生命周期类用例必须先等到「游戏真的在跑」，否则测的是上一个动作留下的锁。

#### 最后两条 §7.1 转变

| 用例 | 驱动方式 | 读数 | 判定 |
| --- | --- | --- | --- |
| 重开（RESTART） | 真实面板：`#settings-button` → `#restart-setting` | 24 → **0**，outlines 0；epoch 9→11 | OK |
| 恢复存档（RESUME） | 真实存档：合法落子写入槽位 → 重新加载页面 → 在主页返回对局 | 存档键存在；返回后 `liveSprites=0 liveEvents=0`；再回来后仍 0、无补播 | OK |

至此 §7.1 的取消清单（设置 / 帮助（与设置同一面板）/ 主页 / hidden / 局终 / 重开 / 恢复存档）**全部有真实驱动与读数**。

#### 剩余失败项

`tools/cartoon-clear-probe.mjs r3` 现在只剩 **2 个 failure**，全部是 R1 起就挂着的三个 tile 的采样尺寸判据（`confetti-pink` 超 0.12、`star-pop` 窗口污染、`dash-blue` 归入 UNMEASURED）。

### R1/R2 遗留项：8-tile 判据的测量方法（v0.13.3）

**只改文件**：`tools/cartoon-clear-probe.mjs`、`src/rendering/effects.js`（只加了又撤掉的门板，净变化为零）、本文档。**容差一个字没动**（仍是包围盒 0.12 / 重心 0.20）。

做法：把渲染与 sprite 都按**两个强度**量一遍，判据读**同强度的那一对**。

- sprite 侧：`alphaMetrics(png, minAlpha)`——`alpha > 0` 是轮廓，`alpha > 96` 是实心核；
- 渲染侧：`windowMetrics(..., difference)`——48 是「看得见的全部」（含后处理晕边），110 是「实心核」。

**结果：`dash-blue` 由 UNMEASURED 变成通过**，而且是直接证据：它的 soft 高度是 `0.670`（期望 0.305，2.2 倍），core 高度是 `0.308`（期望 0.258）——多出来的那 0.36 格**就是晕边**，之前的判据把它算进了盒子里。

| tile | core 包围盒（占 tile） | 期望 core | soft（对照） | 判定 |
| --- | --- | --- | --- | --- |
| confetti-blue | 0.621 × 0.621 | 0.578 × 0.578 | 0.621 × 0.621 | OK |
| confetti-teal | 0.712 × 0.723 | 0.664 × 0.688 | 0.712 × 0.734 | OK |
| sparkle-cream | 0.672 × 0.672 | 0.625 × 0.625 | 0.684 × 0.684 | OK |
| dot-blue | 0.513 × 0.524 | 0.484 × 0.484 | 0.524 × 0.524 | OK |
| swoosh-cream | 0.794 × 0.481 | 0.742 × 0.453 | 0.794 × 0.481 | OK |
| **dash-blue** | **0.758 × 0.308** | 0.711 × 0.258 | 0.758 × **0.670** | **OK（本轮由 UNMEASURED 转通过）** |
| confetti-pink | 0.699 × 0.610 | 0.563 × 0.570 | 0.732 × 0.610 | **FAIL（+0.136）** |
| star-pop | 窗口被填满 | 0.797 × 0.797 | — | **UNMEASURED** |

**8 个 tile 里 7 个通过**（上一轮是 6 个），两侧数字都留在证据里，容差未动。

#### 剩下两个的诊断（都不是「阈值该放松」）

- **star-pop**：它是奶油色，而门板放在棋盘前面——**奶油星画在奶油棋盘上，差值本来就接近 0**，能测到的只有它那一圈暖金描边，于是掩码铺满整个窗口。这跟图形对不对无关，是**门板没有自己的背景**。
- **confetti-pink**：core 与 soft 的差值只有 0.03（比 blue/teal 还小），说明它不是软晕边，而是**实打实地铺开**了 0.136 格（每边约 4.4px）。原因本轮没查清。

#### 试过但撤回的做法（留给下一步）

方向很自然：给门板加一块**深色底板**，让所有 sprite 都有可比对比度。本轮按这个方向加了底板与 `backdropOnly` 模式（先拍「只有底板」当参考帧，再拍「底板 + 8 个 tile」做差），**结果 8 个 tile 全部变成「窗口内没有变化」**——两张帧一样了。也就是说底板确实进了参考帧，但第二张帧里那些 tile 没被画出来（或没插值出来），本轮**没查清，直接把这次尝试整体撤回**，不留半成品。下一步要从「两张帧必须共用同一块底板实例」入手，而不是各自新建。

### R4 的「录屏」：本机能给的最接近的东西（v0.13.3）

**只改文件**：`tools/cartoon-clear-probe.mjs`、本文档。无产品代码改动。

R4 原本写的是「没有录屏，也不拿无头截图拼成视频冒充」。本机也确认**没有 ffmpeg / 任何视频编码器**。但本仓库对「录下来」的既有做法不是编码视频，而是 **CDP screencast 帧序**（`tools/intro-probe.mjs` 把开场波次就是这么录的）。按同一做法补上：

```
OK   J the clear was recorded as a real frame sequence  52 frames over 906ms, mean gap 17.8ms
OK   J and it covers the whole event window, not just its start  last frame at 906ms
```

- 帧由浏览器**在合成时**推送，每帧带自己的时间戳，所以这个序列**自带真实节拍**（平均帧间隔 17.8ms ≈ 56fps，与探针采样到的 p50 一致）；
- 覆盖 0–906ms，也就是整个事件窗（420ms）加尾巴，不是只抓了开头；
- 产物：`artifacts/cartoon-clear-v1/r3/screencast/frame-000..051.png` + `timings.json`（帧号 / 毫秒 / 路径）。

**它是什么、不是什么**（写在证据里，不让它被误读）：这是**本机无头** d3d11、桌面 1440×900 视口、世界时钟钳死的录制；**不是手机、不是微信/QQ 内嵌、不是真机手感**。它比静帧多了「节奏」这一维，但仍然不能替代 §9.2 要求的真机录屏。

### 轮廓对比度：从「未评级」变成「已测量」（v0.13.3）

**只改文件**：本文档、`docs/Technical/KNOWN_GAPS.md`。无代码改动。

§5.2 要求贴面轮廓「一次亮起收净、格线始终能读」，但没给数值阈值；之前一直只写了「画出来了、未评级」。本轮用**已有的取证帧**做了一次客观测量（不需要再跑浏览器）：把 `desktop-quiet.png` 与同一视口的 `desktop-clear5-{065,260}ms.png` 逐像素比，只统计 luma 差 > 8 的像素，看它们往暗还是往亮偏。

| 采样时刻 | 变化像素 | 变暗 | 变亮 | 平均 luma 差 | 最暗 luma |
| --- | ---: | ---: | ---: | ---: | ---: |
| 65ms（只有轮廓，无粒子） | 6962 | **6384** | 578 | **−46.0** | 28 |
| 260ms（轮廓 + 粒子） | 862 | 831 | 31 | −73.8 | 34 |

- 轮廓**确实在压暗**，不是提亮：65ms 时 6384 个像素变暗、578 个变亮，平均压暗 **46 luma**。奶油棋盘本身的 luma 约 215，也就是约 **21% 的下降**。
- 顺带纠正一个我自己的误读：在 screencast 帧上我一度以为轮廓是「浅色线」，那是**棋盘块之间的深色缝**，不是轮廓。
- 这与材质一致：轮廓色是深蓝 `#20334C`，`NormalBlending`、`opacity ≤ 0.75`。

**仍然不下「通过」**：§5.2 没有给「可读」的数值门槛，46 luma（21%）是否够、1–1.5px 在真机 DPI 下是否够，是**制作人/美术的裁决**，不是我能自评的。所以这一条的措辞从「未评级」改成「已测量，待裁决」，读数留在上面。

### 最后两个 tile 的判据：用共享底板收掉（v0.13.3）

**只改文件**：`src/rendering/effects.js`、`tools/cartoon-clear-probe.mjs`、本文档、`docs/Technical/KNOWN_GAPS.md`。**容差仍未动**（包围盒 0.12 / 重心 0.20）。

上一轮把「给门板加深色底板」整体撤回，因为两张帧拍成了完全一样（tile 没进第二张）。**根因就是上一轮自己写进 KNOWN_GAPS 的那句**：两次拍摄各自新建了一块底板。改成**一次创建、两次共用**（先拍空底板当参考帧，再拍底板 + 8 个 tile，中间不清场）之后，**8 个 tile 全部通过**：

| tile | core 包围盒 | 期望 core | 判定 |
| --- | --- | --- | --- |
| confetti-blue | 0.552 × 0.552 | 0.578 × 0.578 | OK |
| confetti-teal | 0.632 × 0.655 | 0.664 × 0.688 | OK |
| **confetti-pink** | **0.532 × 0.544** | 0.563 × 0.570 | **OK（上轮 FAIL）** |
| **star-pop** | **0.817 × 0.806** | 0.766 × 0.766 | **OK（上轮 UNMEASURED）** |
| sparkle-cream | 0.614 × 0.614 | 0.625 × 0.625 | OK |
| dot-blue | 0.456 × 0.456 | 0.484 × 0.484 | OK |
| swoosh-cream | 0.649 × 0.403 | 0.742 × 0.453 | OK |
| dash-blue | 0.703 × 0.220 | 0.711 × 0.258 | OK |

8 个 tile 的形状与朝向判据也全部通过。为什么上一轮的两个会好：

- **star-pop**：奶油星原先画在奶油棋盘前，差值接近 0，只能测到描边；换到深色底板之后差值正常，包围盒 0.817 直接落在期望 0.766 的容差内。这就是「门板没有自己的背景」的直接验证。
- **confetti-pink**：它的 core 与 soft 只差 0.03，说明不是晕边；换底板后 core 由 0.699 收到 **0.532**（期望 0.563）。也就是说旧数值里多出来的那部分**不是图形、也不是晕边，而是「粉片叠在奶油/棋盘上时差值不够锐利」导致的边缘外扩**——底板把对比度拉起来，它自己就消失了。

底板的实现要点（都写进了代码注释）：`atlasGate({ plate: true, tiles: false })` 创建底板且不画 tile，`atlasGate()` 复用仍然活着的那一块；底板走 `addTransient`（`ownGeometry` 标记，会被 `clearCelebration()` 正常回收），深度上放在 tile 之后，`renderOrder` 让 alpha 批次仍然盖在它上面。

**`npm run probe:clear` 的 `r1` 与 `r3` 现在都是 0 failure。**

### 贴图 404 的兜底路径：从「有代码」变成「有取证」（v0.13.3）

**只改文件**：`tools/cartoon-clear-probe.mjs`、本文档。无产品代码改动。

§3.1 写得很清楚：「贴图未就绪/加载失败：使用简单程序方片/四角星或仅亮边反馈，**禁止阻塞第一手、进入无限 Loading 或吞掉分数反馈**。开发诊断记录 fallback」。这条兜底从 R1 就写在代码里，但**一次都没被真正触发过**。本轮用 CDP `Network.setBlockedURLs` 把 `atlas.png` 拦掉、重新加载页面来真跑一遍：

```
OK   K with the atlas blocked the loader reports a failure   atlas.status=failed error=[object Event]
OK   K the fallback still emits and really paints            spawned=32 pixels=4010
OK   K the event budget is unchanged by the failure          budget=32 physical=3
OK   K a normal move still settles and still scores with the atlas broken  drop.ok=true score 0 -> 50
```

四条正好对上 §3.1 的四句要求：

1. **失败被记录**（`status=failed`），不是静默降级；
2. **仍然画得出来**，而且是像素级证据（32 个精灵 / 4010 个像素变化），不是计数器自证；
3. **预算与物理线数不受影响**（仍是 32 / 3）—— 失败不改变规则层给的东西；
4. **不吞分数**：一次合法落子照常结算，score 0 → 50。

一个小瑕疵如实记下：`error` 字段是 `[object Event]`，因为 `TextureLoader` 的 onError 回一个 Event、没有 `message`，诊断里看不出是哪个 URL 失败（`status=failed` 本身是准的）。这属于开发诊断的可读性，不影响行为，未改。

**`npm run probe:clear` 的 `r1` 与 `r3` 现在都是 0 failure**，`r3` 一次覆盖：8-tile 采样门、§7 生命周期（重叠事件/全局上限/七类取消/reduced-motion 动态开启/100 轮泄漏/帧开销）、layer3 合同、真实帧序录制、以及本条失败路径。

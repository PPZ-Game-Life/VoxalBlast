# 落点驱动强化消除、点击与震动 — 实施回执（R0–R4）

> 交接单：[PLACEMENT_IMPACT_FEEDBACK_HANDOFF.md](PLACEMENT_IMPACT_FEEDBACK_HANDOFF.md)（Luna → Jeffy）。
> 本文件是**实施方**的回执，逐轮记录改了哪些文件、实测读数与未测项。交接口径的裁决权仍在制作人。
> 前一轮卡通消除的历史证据在 [CARTOON_CLEAR_VFX_ROUNDS.md](CARTOON_CLEAR_VFX_ROUNDS.md)，本单只替换其中
> 「正常消除的尺寸、刷光、起点、时间与震动目标」，不推翻已验收的去重/表面/隔离/分档结构。

## 冻结基线（R0 之前）

| 项 | 值 |
| --- | --- |
| 版本 | `0.13.3` |
| HEAD | `111d4f8dcc13e51b516b0f365d5a4629e8736250`（Regression sweep part three: the render and motion gates） |
| 交付物 | `docs/assets/impact-feedback-v2/`（24 个文件，含 `runtime/` 9 个可加载文件）、`tools/build-impact-feedback-assets.py`、本单交接文档 —— 由制作人交付，本轮**未修改** |
| 他人并发改动 | `README.md`、`docs/README.md`、`docs/Planning/05-美术方向与视觉规范.md`、`docs/Planning/09-特效设计与庆祝感升级.md`、`docs/Technical/CARTOON_CLEAR_VFX_HANDOFF.md`、`public/__three-probe.html` —— 本轮不碰、不提交 |

---

## R0 — 冻结基线、修 NaN、落点快照与纯 planner

**只改文件**：`src/rendering/cartoonClearPlan.js`、`src/rendering/effects.js`、`src/main.js`、
`tools/cartoon-clear-plan-tests.mjs`、本文件。（`docs/assets/**`、`tools/build-impact-feedback-assets.py` 首次入库，内容未改。）

### 1. §2「先修入口」：三个 NaN

`effects.js` 的 `lerp(range, t)` 要求 `[min,max]` 数组，但 `spawnCartoonSprites()` 里三处传的是**标量**
（`arc.minLength` / `arc.maxLength` / `dot.maxSize`），于是 `range[1]` 是 `undefined`，结果全是 `NaN`，
直接喂给 particle 的 size/velocity。实测（`node -e`，同一次调用序列、`random()=0.5`）：

| 调用式 | 改前 | 改后 |
| --- | ---: | ---: |
| `lerp(CARTOON_CLEAR.arc.minLength, r)` | `NaN` | — |
| `lerp(CARTOON_CLEAR.arc.maxLength, r)` | `NaN` | — |
| `lerp(CARTOON_CLEAR.dot.maxSize, r)` | `NaN` | — |
| `lerp([arc.minLength, arc.maxLength], r)` | — | `0.3`（cell） |
| `lerp([dot.minSize, dot.maxSize], r)` | — | `0.065`（cell） |

修法不是"补一个默认值"，而是把区间**命名成一处**（`ARC_LENGTH_RANGE` / `DOT_SIZE_RANGE`，同一个波段不能在
两个调用点各取一次），并让 `lerp` 对非数值对**直接抛错**、对非有限结果抛错；`visibleSize()` 加 `finite()`
断言，计数进 `report().cartoon.nanGuards`。理由是旧行为**静默**：NaN 矩阵会让整批粒子不画，而粒子计数照样
报满额（该文件 200 行处的 geometry 注释记着同一个坑）。用新贴图盖住 NaN 属于本单 §2 明确禁止的做法。

### 2. §3.1 落点快照（`main.js`）

`onDrop()` 在 `settlePlacement()` **之前**取一次 `snapshotPlacement()`：

- `placedCells` 由预览真正使用的 `{face, cells, origin}` 经 `faceLattice()` 求得，不是手指屏幕坐标、不是
  piece 中心、不是随机交点（§4.3）；
- `paintLookup` 是**结算前**棋盘的平铺克隆（≤98 格）并把本手颜色**合并**进去 —— 一手放下即消除的格在结算后
  已经不在棋盘上，没有这一步就没有颜色可退（§3.1「必须合并本次拼块」）；
- 只读克隆，不留可变引用；不进 Board、不进存档、不改存档格式；
- 只有合法 `onDrop` 会走到这里，非法落子在输入层就被拒（§3.1「失败：全部丢弃」）。

`spawnClearEffects(...)` / `spawnCartoonClear(...)` 多收一个 `placement`；没有它的旧调用（DEV demo、
legacy fixture）不会崩，只会把每条线标成 `originFallback` 并在 report 里说清楚。

### 3. §4 纯 planner：起点、双向、到达时间

`cartoonClearPlan.js` 新增（全部纯函数，不 import THREE / board / clock）：

- `SWEEP_CONTRACT`：`startMs 35` / `speedCellsPerSecond 32` / `endMaxMs 200` / 边界 `-0.5`、`4.5`；
- `linePropagation(line, placedKeys)`：`hits = placedCells ∩ line.cells` → `originT` 取**连续均值**
  （多格只有一个起点；非连续 hits 允许落在没人放的格上，实现不假设起点属于 placedCells）；
  `dMinus = originT - (-0.5)`、`dPlus = 4.5 - originT`；
  `arrivalMs = 35 + distanceCells / 32 * 1000`；hits 为空 → `originFallback`，数值仍然是有限的线中心；
- `lineOriginUv(line, originT)`：连续 face-local 坐标（晶格变换留给 boardView，本文件才能在 `node` 里直接断言）；
- `planPropagation(plan, placement)`：每物理线的 propagation、§5.2 的 `faceRays`（一 footprint × 一方向）、
  §4.6 按坐标去重的端点（同格取最早到达）、§5.1 的放置脉冲锚点（本手 placed 质心）、`earliestEndMs`。

**§4.5 表格逐项复算**（`node tools/cartoon-clear-plan-tests.mjs`，直接断言公式而非转录输出）：

| hits | `originT` | 负端到达 | 正端到达 |
| --- | ---: | ---: | ---: |
| `[2]` | 2 | `113.125ms` | `113.125ms` |
| `[0]` | 0 | `50.625ms` | `175.625ms` |
| `[0,1]` | 0.5 | `66.25ms` | `160ms` |
| `[0,4]`（非连续） | 2 | `113.125ms` | `113.125ms` |

### 4. 门禁读数

| 门禁 | 结果 |
| --- | --- |
| `node tools/cartoon-clear-plan-tests.mjs` | **PASS 0 failure**（新增 60+ 条 §4 断言 + 九个真实 fixture 的 propagation 行） |
| `node tools/rule-tests.mjs` | **554/554** |
| `node tools/game-session-tests.mjs` | **205/205** |
| `npm run build` | ✓ built（1.91s） |

九个真实 fixture（`single / parallel / cross / shared-edge / face-pair / three / four / five / legacy-single`）
全部 `fallbackLines=0`：**合法落子产生的每条物理线都含有本手放置的格**，且两个到达时间都在 200ms 内、都由同一个
公式算出。真实样例：`four` 的四条线 `66.25/160.000`、`160.000/66.250`、`160.000/66.250`、`66.250/160.000`
（靠端先到、远端后到）；`five` 的 `hits=2/3/3/2/2`。

### 5. 本轮**没有**做的事（明确保留）

- 未接入新贴图/GLB：刷光、端点爆点、六面体、paint echo、tap、震屏与触觉仲裁都还在 R1–R4。
- 未改结算、分数、发牌、存档、版本号。
- 未拍"改前/改后"实机截图对：R0 的可视差异只有 arc/dot 从 NaN 变成真实小图形，R1 会连同新视觉一起取证。
- 旧 `atlasGate` 仍然**只**证明 `cartoon-clear-v1` 的 8 个 tile，本包的新 `impactAssetGate` 在 R1 才存在。

---

## R1 — 正式贴图逐帧、GLB 姿态、单线从落点扫向两端

**只改文件**：`src/rendering/impactAssets.js`（新）、`src/rendering/impactFeedback.js`（新）、
`src/rendering/effects.js`、`src/rendering/config.js`、`src/rendering/cartoonClearPlan.js`（R0）、
`src/main.js`、`src/diagnostics.js`、`tools/placement-impact-probe.mjs`（新）、`tools/cartoon-clear-probe.mjs`、
`package.json`、`public/art/impact-feedback-v2/*`（新增）、本文件。

### 1. 发布资源

`public/art/impact-feedback-v2/` 共 **10 个文件 / 218166 字节**，逐字节等于 `ASSETS.md` 的
「推荐完整三色网络预算 218166 bytes」——即 `runtime/` 里除 `cube.glb` 蓝色别名之外的**全部被选用文件**：
`sweep-right` / `endpoint-pop` / `tap-feedback` 的 png+json、`feedback.recipe.json`、`cube-blue/teal/pink.glb`。
`sources/`、检查板、样片、`references/`、manifest 报告**未进首包**。

配置层的分工按 §5 办：**路径与结构**在 `config.js`（`IMPACT_FEEDBACK`），**所有可调数值**在
`runtime/feedback.recipe.json` 里运行时读取。理由是可复算：一个数字写在两处，迟早会不一致。

### 2. 资产契约（浏览器实测，非离线检查板）

| 行 | 实测 | 判据 |
| --- | --- | --- |
| sweep 帧序 | 4 帧、总 140ms、左→右 | 逐帧 `durationMs` 求和 |
| sweep 归一化框 | `[6,8,239,116]`，`unionIsReference = true` | 与 `referenceAlphaBounds` 全等，**没有**逐帧补偿 |
| sweep 可见尺寸 | `1.4 × 0.65 cell` | 与 §5.1 逐字相同 |
| sweep pivot | 距框中心 `0.65494 world` | `0.42578125 × frameWorld(1.53820)`，即 `headAnchorLocalPx 237` |
| sweep 方向契约 | `mirrorForNegativeDirection` / `rotateAroundHeadAnchor` 均 true | 负方向镜像绕 pivot，不绕几何中心 |
| endpoint-pop | 6 帧、总 140ms、一次性 | §5.1「不循环，不把不同形状当连续帧」 |
| GLB ×3 | 各 **1 primitive**、`COLOR_0` 在、法线在、`localEdge = 1.0000` | §8.1 的单 primitive/vertexColors 契约 |
| GLB 世界边 | `0.4420 cell` | 落在 §5.1 的 `0.36–0.52` 内 |
| GLB 共享 | 实例 `geometry === 资源 geometry` 且 `material ===` 同源 | 同色实例复用，不是逐粒子 clone |
| alias | 只有 blue/teal/pink 三个被请求 | `cube.glb` 未下载（§8.1「避免重复蓝色」） |

GLB 的 `visibleEdgeCells` 是**局部未旋转的一单位包围盒**换算出来的；实测 `localEdge = 1.0000`、
`edgeWorld = 0.4420`，没有按投影框逐帧反算，所以不会出现 §5.1 说的「体积呼吸」。

### 3. 落点驱动：把 148ms 的窗口按帧量出来

交接单 §9.1 的到达时刻、帧序、裁剪边都是关于一个 **148ms** 窗口的问题，而软件光栅化在这台机器上
一整个事件只能画出 5 帧——所以这一轮的浏览器断言**不靠 rAF 采样**，而是给 impact 层加了一个 DEV-only
的冻结时钟（`impactStep(tMs)`），把真机要跑的那条 `update()` 原样跑一遍，逐步读回来。基线（冻结）读数：

| 时刻 | 实测 | 对照 |
| --- | --- | --- |
| 0 / 10 / 34ms | 两条分支都**不可见** | §5.1「落点后 35ms 启动」 |
| 36ms | `["-1:2","1:2"]`，区间 `[-1:[1.95,2]、+1:[2,2.05]]` | 起点是**落点**（`originT=2`），且尾部在起始帧就**裁到原点**，没有把整条 1.4 格柔尾预先摆在原点两侧 |
| 60 / 90 / 112 / 114ms | travelled `0.80 / 1.76 / 2.46 / 2.50` | 32 cell/s；114ms 起停在整条线的端边界 |
| 全程 | 任何一帧的可见区间都没有越过原点 | §5.1 的裁剪合同 |
| 帧序 | `0,1,2,3` 全部出现 | 帧由 `travelProgress` 选，不是固定 205ms 播完 |
| 112 → 114ms | 端点爆点 `0 → ≥1` 可见 | 爆点等自己的到达 |
| 136 → 160ms | 两条分支都还在第 3 帧 → 全部释放 | 居中落子两端**同时**到（`113.125/113.125ms`），24ms 后收净 |
| 500ms | sweeps/bursts/cubes 全 0 | §5.1「5格线最长传播在200ms内结束」 |

实机尺寸：390×844 手机视口、DPR 3，对棋盘做 3 倍裁切拍摄（`artifacts/placement-impact-v2/r1/shots/zoom-070ms.png`）——
一格约 310px，扫光**半高约 0.69 格**、单侧**长约 1.35 格**，即 §5.1 的 `0.65 × 1.4 cell`；两个瓣的**尖端朝外、
捏口在落点**，方向正确（这一点必须靠图，计数说不出来）。

### 4. 截图抓出来的两个真问题

1. **材质没接贴图**：`MeshBasicMaterial` 没有 `map` 时会画**纯白方块**。第一版正是如此——端点爆点渲染成
   一个白正方形、扫光渲染成一条白带，而所有计数器都说"已生成"。贴图在 `load()` 成功后挂到两个共享材质上，
   重拍后 `zoom-070ms` 才出现带金边的奶油扇形。**这条记在这里的原因**：只跑计数门禁会全绿。
2. **首次消除卡 179ms**：第一个事件在两次 rAF 之间停了 179ms（着色器编译＋贴图上传），而这个事件本身只有
   148ms——即"第一次落子看不到效果"。现在包加载完成后会先在本盘外画一次三个角色的替身 quad 与各色实例
   （`warmUpShaders()`），把程序编在没人看的时候。实测同机对比（13 帧窗口）：空闲最差帧 **63ms**，
   一次真消除最差帧 **63ms** —— 消除不再比空闲更慢。

### 5. 门禁读数

| 门禁 | 结果 |
| --- | --- |
| `node tools/placement-impact-probe.mjs`（新） | **PASS 0 failure**（41 条断言） |
| `node tools/cartoon-clear-plan-tests.mjs` | **PASS 0 failure** |
| `node tools/cartoon-clear-probe.mjs r2` | **PASS 0 failure**（v1 正常消除全量回归） |
| `node tools/refactor-interaction-probe.mjs` | **52 ok / 0 failed / 0 skipped** |
| `node tools/refactor-churn-probe.mjs` | **44 ok / 0 failed / 1 skipped**（该 skip 为本轮之前既有） |
| `node tools/rule-tests.mjs` | **554/554** |
| `node tools/game-session-tests.mjs` | **205/205** |
| `node tools/i18n-tests.mjs` | **179/179** |
| `npm run build` | ✓ built（1.99s） |

成本与清理（同一台机、390×844 手机视口、软件光栅化）：

- draw calls：基准 **129** → 事件存活时 **136**（`delta = 7`）。**口径说明**：这 7 次是**整次消除**的增量
  （含 v1 的轮廓与方片），不是新包单独的增量；§8.3 的高档 ≤8 / 低档 ≤6 需要把两者分开量，留给 R4 的
  分项读数。
- 100 轮触发/清理后：live 全 0，calls 回到 129，`geometries 27(冷) → 36(50轮) → 36(100轮)`（池子按
  16 sweep + 8 burst 一次性预分配，不再逐轮长）。
- 一色一个 `InstancedMesh`（本轮低配只用 blue/teal，`meshes = 2`），不是逐粒子一个 mesh。

### 6. 与旧口径的两处**有意替换**（都在 §5.2 授权范围内）

1. **方片预算换成 `secondarySprites`**：v1 的 14/22/32（低配 7/11/16）是"方片＋闪点＋弧线＋点"的总表，
   而闪点/弧线/点已被扫光与端点爆点取代，所以现在用 §5.2 的 6/8/10（低配 2/3/4）。`cartoon-clear-probe`
   不再抄一份表，而是**问运行时**（`impactReport().caps.perEvent`）——包没加载时才回落到 v1 数字。
2. **「手机横屏/安全边距不足减半」保留**，只作用在方片这一层：新表没有这一列，但方片仍然是装饰，
   取消它会让横屏手机**悄悄变吵**。

### 7. 本轮**没有**做的事（明确保留）

- **paint echo 完全没有实现**（§3.2）：`placement.paintLookup` 已经在位、也进了 planner 的输入，但还没有
  任何一层消费它；"刷到哪里颜色退到哪里"、交叉格、150 面格上限、`paintEchoFallback` 都还没有代码。
- **多线/共享棱/交叉叠加亮度**只走了 planner 的纯断言（R0）与 v1 回归；新层的多线实机画面与预算分配未逐条取证。
- **tap 反馈**（§7）与**镜头震屏/触觉仲裁**（§6）仍是 v1 行为：`gameInput` 没有 tap owner，
  `triggerRewardShake` 仍是旧的正弦 scalar 出口，`playHaptic` 还没有 owner/token 与 no-method guard。
- **reduced-motion 的静态确认**：新层在 reduced 下整个停手（不画扫光/爆点/方块），§5.2 要的「≤120ms 静态确认」
  目前只有 v1 轮廓在承担，没有单独取证。
- **设备与平台**：Android 真机、微信/X5、CrazyGames 嵌入容器、iOS 降级均**未测**（沿用 `KNOWN_GAPS`）。
- 未改版本号（`0.13.3`），接入版本由实现轮按项目规则决定。


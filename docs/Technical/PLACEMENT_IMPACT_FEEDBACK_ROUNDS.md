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

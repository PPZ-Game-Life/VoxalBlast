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

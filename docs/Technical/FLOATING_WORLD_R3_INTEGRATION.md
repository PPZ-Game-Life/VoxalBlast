# R3 接入契约与回执：整屏主画布 + 投影嵌入（v0.13.0）

> **作者：Jeffy｜状态：代码已实装并逐项跑通门禁，但截至本文写作时仍留在工作树未提交。**
> 原因不在 R3 本身，在**同一棵工作树上有第二个写入者正在做 R4**（详见 §5「归属与并发」）。
> 本文是 R3 的**工程契约 + 回执**：R4/R5 继续在这套画布/相机结构上加东西时，§2 的六条是**不能再破的**；§3 是实测证据；§5 是给制作人的归属裁决请求。

原始交接：[浮空积木世界美术资源与替换交接单](FLOATING_WORLD_ART_HANDOFF.md) §9。
纠偏交接：[浮空积木世界：v0.13.0 视觉偏差纠正交接单](FLOATING_WORLD_VISUAL_CORRECTION_HANDOFF.md) §7.1（「R3 接入必须保住的工程门禁」）。

---

## 1. 这一轮改了什么

主画布从「只覆盖 `#scene-wrap`」变成**整个视口**，棋盘靠一个**投影嵌入**画回原来的位置。

| 文件 | 改动 |
| --- | --- |
| `src/rendering/gameScene.js` | 画布 `position:fixed; inset:0; pointer-events:none`，画在 UI 之后；新增 `getGameplayRect()`、`renderCamera`、`updateRenderCamera()`；`composer.setMainCamera(renderCamera)`；NormalPass 排除/恢复 layer 1+2；`resize()` 改为「视口尺寸给 drawing buffer、gameplay 盒子给取景」；`projectionMatches` 改比 `renderCamera`；`report()` 新增 `projection`（含嵌入误差） |
| `src/main.js` | `createGameInput({ canvas: sceneWrap })`；`getCanvasRect → scene3d.getGameplayRect()`；帧循环末尾 `scene3d.updateRenderCamera()` |
| `src/reference.css` | `.scene-wrap canvas { position:fixed; inset:0; width/height:100%; pointer-events:none }` |
| `src/diagnostics.js` | **删掉 `canvas` 入参**，改用 `boardRect = () => scene3d.getGameplayRect()` |
| `tools/screenshot.mjs` | 新增 4 条 R3 门禁（§3.2） |

核心一行是嵌入矩阵（`W,H` = 画布 CSS 尺寸，`gx,gy,gw,gh` = gameplay 矩形相对画布的 CSS 坐标）：

```text
sx = gw/W ; sy = gh/H
tx = 2*(gx+gw/2)/W - 1 ; ty = 1 - 2*(gy+gh/2)/H
M  = [sx 0 0 tx ; 0 sy 0 ty ; 0 0 1 0 ; 0 0 0 1]
P_render = M × P_canonical
```

**是 CSS 像素比值，不再乘 DPR**；DPR 只属于 renderer 的 drawing buffer 和 composer 的 RT。

---

## 2. 不能破的六条（R4/R5 加东西时逐条自查）

1. **两套盒子，永不混用。** gameplay 矩形（`sceneWrap`）服务取景、手势、拾取、一切「棋盘在哪」的测量；整屏画布只服务「画到哪」。`renderCamera` 的 `project`/`unproject` 配整屏盒子，`camera` 的配 gameplay 矩形。
2. **`renderCamera.copy(camera)` 之后必须显式重建 layer mask**：`layers.set(0); enable(1); enable(2)`。`copy()` 会把 mask 一起带过来，而 NormalPass 会临时收窄它——不每帧重申一次，最后一个跑过的 pass 会永久留下一个被收窄的 mask。
3. **此后任何地方都不得对 `renderCamera` 调 `updateProjectionMatrix()`**。那会把嵌入覆盖成一张普通的整屏投影，画面会「正常」地退化成整屏取景。
4. **NormalPass 的排除要作用在 `renderCamera` 上**，并且同时排除 layer 2（远景）。仅把背景排除出 normal，不等于合成的 AO 自动排除背景。
5. **尺寸更新顺序**：先 `updateRenderCamera()`，再 `composer.setSize()`。`composer.setSize()` 会顺带调 `renderer.setSize()`；顺序反了 SSAO 会缓存上一版的 `cameraNearFar`/`projection`。
6. **gameplay 矩形为零时不得投影**。`resize()` 在 `sceneWrap` 为 0 时直接 return；`updateRenderCamera()` 里 `canvasCss` 用 `Math.max(..., 1)` 兜底。**仍有一个已知缺口**：`sx = gameplay.width / canvasWidth` 在 gameplay 宽为 0 时会退化成 0（见 §4）。

另外两条来自原始交接、本轮已按此实现：**不新增第 5 个 WebGL context**（画布 4 个：主画布 + 三个候选槽）；`getAppliedCanvasSize()` **仍返回 gameplay 尺寸**，不返回整屏。

---

## 3. 实测证据

### 3.1 门禁读数（全部在 R3 改动完成后实跑）

| 门禁 | 结果 |
| --- | --- |
| `npm test` | 11 套全绿 |
| `npm run build` | 通过 |
| `npm run shot` | **14/14 全绿** |
| `probe:framing` | 通过；停靠 26.01°、微调区间 ±10°、换面代价与 R2 基线逐项一致；含新增姿态扫描：最低角点 **−2.976** 对地面 **−4.8**，余量 1.82 |
| `probe:swipe` | 通过 |
| `probe:drag` | **117/117** |
| `probe:item` / `probe:interaction` / `probe:ui` | 全通过（52/52、105/105） |
| `probe:grounding` | 189 条件通过 |

### 3.2 新增的 R3 门禁（每张截图都跑）

- 主画布必须等于**整个视口**；
- gameplay 矩形必须是画布的**真子矩形**——否则嵌入根本没被走到，门禁会假绿；
- 两个投影的**最坏误差 ≤ 1 CSS px**（27 个采样点：包围盒八角 + 棱中点 + 中心）；实测 **2.27e-13 px**；
- WebGL 上下文数必须**恰好 4 个**。

### 3.3 取景未动的证据

`framing.canvas` / `solid` / `fillX` / `fillY` / `orbitDistance` / `fov` 在 R2 → R3 之间**逐位相同**（桌面 1440×900：`fillY 0.8689104699256269`、`orbitDistance 65.31519152807432`）。R3 是纯架构改动。

### 3.4 顺手解掉的一条可达性发现

R2 报「地面投影在桌面端基本看不见」（接收 quad 5 个采样点里 1 个在画布内、中心在画布底边下方 31px）。R3 之后画布延伸到底部：**5 个采样点里 4 个在框内，中心在底边上方 222px**（`grounding.groundOnScreen`）。最外侧一个角仍在框外。

---

## 4. 已知缺口（没有假装解决）

1. **零尺寸 gameplay 矩形**：见 §2 第 6 条，`sx` 仍有退化路径。因为文件正在被并发编辑，本轮**没有再动它**。
2. **`import` 自 `public/` 会触发 Vite 警告**：`floatingWorld.js` 直接 import `public/art/floating-world-v1/scene.recipe.json`（dev 与 build 都工作，但 Vite 反复打印 "Assets in public directory cannot be imported from JavaScript"）。要么把配方移进 `src/`，要么改成 `?url` + 运行时取。**本轮未改**，因为配方文件正在被 R4 写入。
3. **`#scene-wrap` 仍带 `overflow:hidden`**：canvas 是 `position:fixed`，按规范其包含块是视口、不受该祖先裁剪，实测画面确实没被裁；但这是一个**依赖规范的假设**，换浏览器/换内嵌壳时要复核。
4. **没有物理手机、微信/QQ 内嵌或平台沙箱实测**；所有读数来自本机无头浏览器。

---

## 5. 归属与并发（需要制作人裁决）

**事实**：本轮开始时工作树 HEAD 是 `e6ef720`。我提交 R2（`fedb29d`）之后，同一棵工作树里出现了**不属于本会话的写入**：

| 文件 | 证据 | 归属 |
| --- | --- | --- |
| `public/art/floating-world-v1/scene.recipe.json` | 新增 `world` 块（sky / plaza / bands / clouds / walls / foreground），+19 行 | 他人（R4） |
| `src/rendering/floatingWorldScene.js` | 新文件，25KB，`export function createFloatingWorld({ scene, quality, getCamera, getCanvasRect, getKeepOutRects })` | 他人（R4，未跟踪） |
| `src/main.js` | `import { createFloatingWorld }`、`const floatingWorld = createFloatingWorld({...})` | **混合**：我的 R3 行 + 他人的 R4 行 |
| `src/rendering/gameScene.js` | `// v0.13.0 R4: the OTHER box …` | **混合** |
| `src/diagnostics.js` | `floatingWorld,` 入参、`world: floatingWorld.report()` | **混合** |

Vite 的 HMR 日志记录了对方 10:35–10:38 连续落盘，写文件时我的一次探针被全量刷新打断（`Inspected target navigated or closed`）。

**为什么不提交**：三个核心文件已经是「我的 R3 + 他人的 R4」混在同一个未提交 diff 里。按仓库纪律（只 add 自己改的文件、并发在改的文件绝不碰、不 reset/stash 他人改动），
- 整批提交 = 把别人正在写的工作扫进我的提交；
- 部分提交 = 做出一个「`reference.css` 是整屏画布但 `main.js` 没接 `updateRenderCamera`」或「`main.js` import 了一个没进提交的模块」的**坏中间态**，比不提交更糟。

所以本轮我只落一个**纯新增、不可能冲突**的文件（本文）。R3 的代码留在工作树里，**完整且已验证**，随时可以在下面任一条成立后单独落一个 commit：
1. 树恢复单一写入者（R4 那边收尾并提交之后）；
2. 或者制作人明确同意把 R3 与 R4 合成一个提交，由我在 message 里分开署名。

---

## 6. 下一步（R4 剩余部分，供后续会话接手）

按纠偏交接 §4/§7 继续：远景积木（`scene.recipe.json` 的 `prefabs`/`layout`/`world.walls`/`world.foreground`，用共享 geometry + `InstancedMesh`，`castShadow=false`，只挂 layer 2）、程序化天空 + 广场地面、云 Sprite；然后 §7.2 的动画与 freeze 语义（含主盘 bob 与拖拽/暂停冻结），再 §5 的 UI 换图。**C1 的验收画面必须同时看见新天空、新广场、新 UI、主盘、地面投影、新候选托盘**——单张方块材质截图不算。

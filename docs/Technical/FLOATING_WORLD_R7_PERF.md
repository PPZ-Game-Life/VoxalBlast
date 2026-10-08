# R7 读数：跨视口与双档的性能/结构证据（v0.13.0，v0.13.1 补 DPR/缓冲一节）

> **作者：Jeffy｜状态：读数已采集；§1/§2 是 v0.13.0 的 `npm run shot` 回执，§3 是 v0.13.1 补的
> DPR 上限与「实际缓冲尺寸」实测（`npm run probe:buffer`）。** 本文只记录这些工具自己的回执——
> 不另开测量口径、不重算第二遍。**没有物理手机、没有微信/QQ 内嵌、没有 CrazyGames 沙箱读数**，
> 表里全部是本机无头浏览器的软件渲染。

采集方式：`node tools/screenshot.mjs http://127.0.0.1:5173 artifacts/visual`，输出落盘后用
`artifacts/tmp/perf-table.mjs` 把每张的 payload 汇总成表。**17 张全绿，0 失败**，含本轮补上的
1280×720（原交接 §13.1 列的六个视口里唯一没有被任何门禁评过的那个）。

## 1. 跨视口读数

| 截图 | 视口 | 档 | draw calls | triangles | textures | programs | WebGL ctx | 嵌入误差 px | 建筑/散块/云 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| desktop-home | 1440×900 | high | 0 | 0 | 32 | 24 | 4 | 2.3e-13 | 3/3/6 |
| mobile-home | 390×844 | low | 0 | 0 | 23 | 19 | 4 | 1.1e-13 | 3/3/6 |
| desktop-home-return | 1440×900 | high | 0 | 0 | 32 | 24 | 4 | 2.3e-13 | 3/3/6 |
| desktop-board | 1440×900 | high | **336** | **211,784** | 32 | 24 | 4 | 2.3e-13 | 3/3/6 |
| desktop720-board | 1280×720 | high | 336 | 211,784 | 32 | 24 | 4 | 1.3e-13 | 3/3/6 |
| mobile-board | 390×844 | low | **230** | **153,565** | 23 | 19 | 4 | 1.1e-13 | 3/3/6 |
| small-mobile-board | 320×740 | low | 230 | 153,565 | 23 | 19 | 4 | 8.5e-14 | 3/3/6 |
| landscape-board | 844×390 | high | 335 | 207,884 | 32 | 24 | 4 | 1.3e-13 | 3/3/6 |
| widescreen-board | 2048×900 | high | 335 | 207,884 | 32 | 24 | 4 | 2.3e-13 | 3/3/6 |

（Game Over / 设置 / 排行榜各张与同视口的对局张同值，未重复列出。主页两张 `calls/triangles`
为 0：主页遮住画布时主循环直接 return，什么都不画——这是既有行为，不是失败。）

**结论**

- **上下文数恰好 4**（主画布 + 三个候选槽），**每一个视口都是 4**。R3 的全部理由就是让实景
  继续由这一个 renderer 画，这一条成立。
- **嵌入误差 8.5e-14 ~ 2.3e-13 px**，六个视口全部远低于 1 CSS px 的门禁——投影嵌入不是只在
  1440×900 凑巧对。
- 高档 336 calls / 211,784 tri；低档 230 / 153,565（−32% / −28%）。
- 低档少 9 张纹理、少 5 个 program，与「低档关 SSAO」一致。

## 2. 与 R0 基线的对照（1440×900，同一台机器）

| | R0 基线（`b7b7be4`，田园皮肤） | 现在 | 差 |
| --- | ---: | ---: | ---: |
| draw calls | 316 | 336 | **+20** |
| triangles | 174,070 | 211,784 | **+37,714** |
| textures | 41 | 32 | −9 |
| programs | 17 | 24 | +7 |

**背景三角形比交接单的估算高，必须写清楚**：原交接 §10 写的是「背景实例最大全部 35 块 + 3 散块，
每块 300 三角形；约 **11,400** 三角形增量」。实测增量是 **37,714**，约 3.3 倍。差额不是那 35 块
积木超编——按配方实例化的积木块本身仍在那里——而是**估算只算了积木，没算广场地面、天空穹与
前景体块**，而它们同样是实景层的一部分。也就是说 §10 的 11,400 是「积木」的子预算，不是背景的
总预算；**背景总预算至今没有单独定过**，这是一个需要制作人补的口径。

draw calls +20 与原交接「最终背景新增 draw calls 建议 ≤8（不含云）」相比也偏高。要判断这 20
里有多少来自云精灵、多少来自广场/天空，需要按对象拆一次——**本轮没做**。

## 3. DPR 上限与「实际缓冲尺寸」（v0.13.1 补测：`npm run probe:buffer`）

`screenshot.mjs` 固定 `deviceScaleFactor: 1`，在 DPR=1 下任何一个上限都是空操作，所以 §1 的表验不了它。
新探针 `tools/floating-world-tier-buffer-probe.mjs` 反过来做：在 §13.1 的六个视口上分别**模拟 dsf 1/2/3**
（每个组合重新加载，因为档位是每次加载解析一次的），直接比 `canvas.width / canvas.clientWidth`
与 `min(devicePixelRatio, tierSpec.dprCap)`——即**画布实际有的比例**对**报告里写明的上限**。

| 视口 | 档位 | cap | 装饰 组/散/云 | SSAO | dsf3 下实际 buffer | draw calls | triangles |
| --- | --- | ---: | --- | --- | --- | ---: | ---: |
| 1440×900 | high | 1.75 | 3/3/6 | on | 2520×1575 | 238 | 269,106 |
| 1280×720 | high | 1.75 | 3/3/6 | on | 2240×1260 | 238 | 269,106 |
| 390×844 | low | 1 | 1/1/3 | off | 390×844 | 131 | 153,263 |
| 320×740 | low | 1 | 1/1/3 | off | 320×740 | 131 | 153,263 |
| **844×390** | **high** | **1.75** | **3/3/6** | **on** | **1477×682** | **238** | **269,106** |
| 2048×900 | high | 1.75 | 3/3/6 | on | 3584×1575 | 237 | 263,706 |

（18 个组合全过；计数是在**主页封面**状态读的——世界在封面后照画、棋盘隐藏，所以**不要**把这些
draw calls 与 §1 对局状态的读数直接比。18 个组合里 12 个 `dsf > cap`，上限真的咬住了。）

**这一轮修掉的一个真问题**：交接单 §7.3 与纠偏单 §7.3 都写明「DPR 上限 1.75 / 1.5 / 1」，而
配方里的 `quality.*.dprCap` **只被读进 `rendering().world.tierSpec` 报告，从来没有作用到渲染器**——
渲染器用的是项目自己的 `pixelRatioMax`（2 / 1.35）。也就是说：报告里写着一个上限，画面按另一个数
子跑，而 DPR=1 的截图永远看不出来。现在 `gameScene.js` 取**两者中更严的**（`min(pixelRatioMax, dprCap)`），
并把「项目二值档 → 配方三档」的映射收进 `floatingWorld.js::floatingWorldTierFor`，让渲染器的上限与实景层
的装饰预算不可能落在不同档上。**截图门禁不受影响**：DPR=1 时 `min(1, cap)` 两种写法都是 1，`npm run shot` 17/17 仍全过。

### 3.1 v0.13.1 全量回归（R7 收口的那一轮）

改的是 renderer 的 pixel ratio（`gameScene.js`）与一处跨模块 import，所以按 §9.2 把交互面重跑了一遍。
DPR=1 下 `min(1, 1.75)` 与 `min(1, 2)` 都是 1，这也是为什么截图门禁本来就看不见这次改动：

| 门禁 | 结果 |
| --- | --- |
| `npm test` | 全绿（i18n 175/175、rules 554/554、session 205/205、deal 四件套、leaderboard 28/28） |
| `npm run build` | 通过（1.9s） |
| `npm run shot` | **17/17 OK**（含 1440×900 / 1280×720 / 390×844 / 320×740 / 844×390 / 2048×900） |
| `npm run probe:buffer` | **18/18 组合**（本页 §3 的表） |
| `npm run probe:drag` | **117 ok / 0 failed / 0 skipped** |
| `npm run probe:interaction` | 52 ok / 0 failed |
| `npm run probe:ui` | 105 ok / 0 failed |
| `npm run probe:churn` | 44 ok / 0 failed / **1 skipped**（既有的「换批未重发」D 案，非本轮引入） |
| `npm run probe:item` | 全过（07 §8） |
| `npm run probe:dialog` | 15 passed / 0 failed |
| `npm run probe:scroll` | 30 passed / 0 failed |
| `npm run probe:boot` | 6 ok / 0 failed（幕布 682ms） |
| `npm run probe:swipe` | 三个手势方向全过 |
| `npm run probe:framing` | 通过（**首跑崩过一次**：并发编辑令 dev server 重载页面、句柄短暂消失；复跑即过，不是产品问题——同一个现象已由 `evidence:motion` 的 `requireHandle` 显式报出来） |
| `npm run probe:ui-paint` | 可见控件全部真的画东西 |
| `npm run evidence:motion` | 运动/冻结/恢复/reduced-motion 全过（见 [C3 动态证据](FLOATING_WORLD_C3_ANIMATION_EVIDENCE.md)） |

**同一轮测出来的一个待裁决风险（不是缺陷，是口径问题）**：档位选择器是
`(max-width: 700px) || hardwareConcurrency <= 4`（`config.js::getRenderQuality`），所以**横屏手机**（844×390）
两项都不满足时落进 **high**：238 draw calls / 269k 三角形、SSAO 开、cap 1.75、buffer 1477×682 ≈ 100 万像素——
**这是手机能拿到的最重的一组**，而竖屏手机（390×844）反而是最轻的一组。现代手机普遍报 6–8 核，
只有 ≤4 核的老机型在横屏时才会掉到 low。是否要用「指针类型/`hardwareConcurrency` 更严格地判 + 用短边宽度」
替代纯宽度判定，属制作人口径（与 [KNOWN_GAPS](KNOWN_GAPS.md) 第 1 条同源，那份记录里「所有手机宽度都落进 low」
应改为「**竖屏**手机落进 low」）。

## 4. 仍然没有覆盖的（不要当成已通过）

1. **没有帧耗时读数**。原交接 §10 要求「测实际缓冲尺寸、draw calls、帧耗时和上下文数」，
   实际缓冲尺寸与上下文数已由 §3 补齐，**帧耗时没有**——本机软件渲染的帧时间也不能代表物理手机。
2. **三档表没有落地**：项目仍是二值 `lowPower`，原交接 §10 的 High/Medium/Low 三档与装饰数量**未接**，
   这是已知的待裁决项（见 [KNOWN_GAPS](KNOWN_GAPS.md) 第 1 条）。§3 的表报的是**实际发生了什么**。
3. **降级顺序未被检验**：§10 的「关 AO/real shadow → 降 DPR → 减远景组/云 → 冻结环境运动」
   目前只有前两步真实存在（§3 的表里能看到 SSAO 与 cap 随档变化，装饰数量没变）。
4. 所有读到 `3/3/6` 的档位都是同一个**有意偏离**的结果（低档不裁装饰），不是档位真的生效了。

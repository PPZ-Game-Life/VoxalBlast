# VoxalBlast 新手引导实施交接单

> **状态：待实施。** 本文是 [13 新手引导设计](../Planning/13-新手引导设计.md) 的施工口径，制作人 2026-10-01 已按 13 §11 全部拍板（A1 / B / E / F / G 通过，C / D 本期不做）。
> **本文只写实现口径，不改玩法**：发牌分布、形状池、可放置判定、消除、计分、难度分级、存档格式、平台上报一律不碰（02/07/08 是各自口径的唯一真源）。
> 建议落地版本 **v0.13.0**（功能轮次，由制作人定）；落地前本文与 13 都只是提案。

## 1. 交付物清单

| # | 交付物 | 位置 | 备注 |
| --- | --- | --- | --- |
| 1 | 说明卡升格 + 引导按钮 | `index.html` 的 `#controls-modal`；`src/ui/settings.js` | 见 §3.1；`controls.eyebrow` 改 `HELP / 帮助`，键盘图例三行原样不动 |
| 2 | 设置面板直达行 | `index.html` 的 `#settings-modal`；`src/ui/settings.js` | 见 §3.2；`#tutorial-setting`，排在 `#controls-setting` 之后 |
| 3 | 引导浮层 + 步骤机 | **新** `src/ui/tutorial.js`（`createTutorial({els, onOpen, onClose, ...})` + `bind()` + 只读 `report()`，形状对齐 `ui/settings.js` / `ui/home.js`） | 步骤状态、按钮、高亮 class、i18n 文本渲染 |
| 4 | 教学局脚本 | **新** `src/game/tutorialRun.js`（纯函数：预置布局 + 固定手牌 + 步骤可完成性自检） | 不依赖 `dealDirector`、不读随机流 |
| 5 | 编排 | `src/main.js` | 暂停/输入/焦点/Esc/存档抑制/退出还原，见 §6 |
| 6 | 文案 | `src/i18n/locales/en.js`、`zh-Hans.js` | 键表见 13 §12；`npm run test:i18n` 必须绿 |
| 7 | 探针 + 门禁 | **新** `tools/tutorial-probe.mjs`，`package.json` 加 `"probe:tutorial"` | 断言清单见 §7 |
| 8 | 文档对账 | 04 顶部「新手引导」段、`docs/README.md` 导航 | 落地时把 13 的状态从「待实施」改成「已实施 vX」 |

**不做**（长期口径，不只是本期）：深链 `?tutorial=1`、首局软提示、"引导已看过"偏好键、引导奖励、第三种语言。

## 2. 三条铁律（违反任何一条就是本轮的失败）

1. **不写盘、不清盘。** 引导期间 `saveSession()` 与 `clearSession()` 都必须被抑制（`clearSession()` 会清掉玩家的续玩槽——**这是最严重的一条**）。教学局只活在内存里。
2. **不进纪录、不上报。** 教学局不写 `src/game/records.js`、不提交分数、不调 `platform.gameplayStart/Stop`。
3. **退出即还原。** 退出后分数、三块候选、四类道具次数、相机姿态、棋盘占用逐项与进入前一致（§6.4 的还原路径）。

## 3. 入口

### 3.1 说明卡（主入口，桌面）

- `#controls-modal`（`index.html:224-258`）内、`.controls-note` 之后新增主按钮 `#tutorial-button`（`type="button"`，`data-i18n-text="tutorial.entry"`）。
- 卡片标题语义升格：`controls.eyebrow` 文案值改 `HELP`（en）/ `帮助`（zh-Hans）；`#controls-title` 保持 `controls.title`，`.controls-list` 三行与 `controls.note` **一个字不改**。
- 点击顺序（重要）：`closeControls()` → **再** `openTutorial({from: 'help'})`。说明卡开着时棋盘是暂停的（03 §2.2），先关它再开引导，暂停源才不会互相打架。
- 引导退出后焦点回到 `#controls-button`（桌面）——复用 `restoreControlsFocus()` 的既有写法，别新造一套。

### 3.2 设置面板（手机主入口）

- `#settings-modal`（`index.html:259-290`）的 `.settings-list` 里，`#controls-setting` 之后插入 `#tutorial-setting`：`setting-row` 同族，`data-i18n="tutorial.entry"` + 副文案 `tutorial.entryNote`。
- 点它**直接启动引导**（不经说明卡），并先 `hideSettings()`；退出后焦点回 `#tutorial-setting`。
- 排布理由见 13 §6.3（学习族续排，不扔到列表末尾）。**注意**：设置面板已成八行，手机本来要滚动才摸得到 Restart（KNOWN_GAPS 真机记录），所以新行**不得**再拉高整卡高度——沿用现有 `setting-row` 尺寸即可。

## 4. 教学局口径

| 项 | 口径 |
| --- | --- |
| 棋盘 | 空壳 + **脚本预置**（S3 需要在某一行放 4 格）。预置只存在于教学局，**不调用 `Board.seedOpening()`**（那条路是离线测量的，碰了会污染难度基线） |
| 手牌 | S1 固定一个三格直条；S3 固定一个单格块（`Dot`）；其余槽位给无干扰形状或留空。**不走 `session.deal()/dealAsync()`** |
| 道具 | 教学局计数：`refresh = 1`，`hammer / rocket / bomb = 0`（显示"None left"，不可点）。S5 只演示换批 |
| 计分 | 教学局照旧走渲染与反馈（消除看得见、有音效），但**分数不被引用**：不进纪录、不进 BEST、不上报 |
| 死局 | 脚本保证每步可完成；玩家乱放也不会触发 `checkStuckAndPrompt()` → `endGame()`。S5 的"没落点"是脚本摆出来的状态，不是真死局 |
| 荣誉 | 不开播报（教学局的消除按 L1 反馈即止） |
| 开场波次 | 进入引导**不播**开场波浪（`armIntroIfVisible()` 不参与）；`prefers-reduced-motion` 与既有口径一致 |

## 5. 步骤机

状态：`idle → intro(S0) → place(S1) → turn(S2) → clear(S3) → share(S4) → stuck(S5) → done(S6) → 退出`
事件与迁移（"宽进"判定，不做像素级校验）：

| 当前 | 事件 | 下一步 | 判定细节 |
| --- | --- | --- | --- |
| idle | `openTutorial()` | intro | 建教学局；`onOpen()` → `syncPause()` |
| intro | `start` | place | — |
| intro | `skip` | 退出 | 与任意步 `skip` 同路 |
| place | `placedLegal` | turn | **任何**一次合法落子（落哪都算），复用既有 `onDrop()` 成功分支 |
| turn | `turned` | clear | `cubeBase` 发生一次 90° 步进（拖背景 / 滑动 / WASD QE / 拖块翻面任一路径） |
| clear | `lineCleared` | share | 该行满线 → 真实结算 → 真实反馈 |
| share | `ack` / `next` | stuck | `ack` 与 `next` 同义 |
| stuck | `refreshUsed` → `ack` | done | 教学局换批成功即算过；也可直接 `ack` |
| done | `cta` / `skip` | 退出 | `cta` 后按 §6.5 决定落点 |
| 任意 | `skip` / `escape`(末步) / `hidden` | 退出 | 一步退出，不记完成 |
| S1–S5 | `back` | 上一步 | **只回看浮层，不回滚教学局状态**（棋盘不回退，避免又一套状态机） |

**输入白名单**：引导打开时**不套用"全局输入锁"**——S1/S2/S3 就是靠真实手势教的。允许的输入是：候选拖放、画布转面、S5 的换批按钮、浮层自己的按钮。**禁止**的输入：道具瞄准（教学局另外三件 0 次，天然不可用）、设置/主页/结算卡的打开（`isModalOpen()` 已有的接线要考虑把引导算进去，见 §6.2）。

## 6. main.js 接合点

### 6.1 暂停

`syncPause()`（`src/main.js:724`）的暂停源列表**增加**引导：`|| tutorialUi.isOpen()`。这样落子/道具/键盘的既有闸门、`status` 文案、道具条禁用态会一起跟上，不需要第二套锁。
**但**：引导期的棋盘输入必须是**开**的（§5 白名单）。所以实现要点是——把"引导"当作**暂停源之外的另一条状态**：`syncPause()` 里对引导特殊处理（引导打开时 `isPaused` 仍为 false，但走"教学局"分支），**不要**让 `isPaused=true` 把 S1 的拖放一起锁掉。这是本轮唯一一处需要改 `syncPause()` 语义的地方，改动前先与 03 §4 的暂停口径对账并在 03 里补一行。

### 6.2 Escape 链

`onEscapeBeforeGestures`（`src/main.js:427-433`）现在先处理 `settingsUi.isControlsOpen()`。引导的优先级排在它**之前**：Esc → 引导未到最后一步则**留在引导内**（可视为"退到上一步"的等价物，或直接退出，二选一，实现时定死一个并写进探针），已到末步或再次按 Esc → `exitTutorial()`。`isModalOpen()`（`src/main.js:438`）要把引导算进去，否则键盘映射会穿透。

### 6.3 键盘

`W/S`=X、`A/D`=Y、`Q/E`=Z 必须保持可用（S2 的教学点）。注意 03 §2.2 的既有边界：道具瞄准态下键盘不能转面——所以**同一步里不要同时要求"选道具"和"转面"**（S5 单独成步正是为此）。轴提示 `#axis-hint` 照旧工作。

### 6.4 存档抑制

- `saveSession()`（`src/main.js:1116`）与 `clearSession()`（`src/main.js:1121`）加同一条 guard：`if (tutorialUi.isOpen()) return false`。
- `document.visibilitychange` 那条编排（03 §4：保存未完局 + 结算开场波次 + 取消手势）在引导中要**跳过保存**，并按 13 §9 退出引导（`exitTutorial({reason:'hidden'})`），返回后不自动重开。
- 退出引导**不写盘**：进引导前的存档槽内容原样保留，教学局从未落盘。

### 6.5 进入与退出（还原路径）

```
进入：const back = sessionSnapshot()          // 纯内存，不落盘
      const entry = 'run' | 'home'            // 从哪一屏进来的
      resetGame() → 教学局预置 + 固定手牌
退出：applySession(back)                      // 复用 continueRun() 的恢复路径（main.js:1266）
      按 entry 决定落点：'run' → 回到原局；'home' → 回主页，绝不把玩家带进一局
```

- **必须复用 `applySession()`**：它已经处理了清特效、音频场景、`input.resetDrag()`、姿态从逻辑基底四元数还原、微调区间 clamp 等一整套事；手写一份"还原"必然漏项。
- S6 的 `开始游戏` 按钮：`entry === 'home'` → 走 `startFromHome()`；`entry === 'run'` → 就是"回到刚才那局"。
- 从主页进入时玩家可能本来就有续玩槽：退出后**不许**动它（引导不得替玩家开始或丢弃一局）。

### 6.6 诊断

`__voxalblast`（`src/main.js:1674`）新增只读 `tutorial()`：`{ open, step, entry, completed, skipped }`。只读、不参与逻辑，供探针对账。

## 7. 探针与门禁

`tools/tutorial-probe.mjs`（`npm run probe:tutorial`），复用仓库既有的无头 CDP 写法（参考 `tools/boot-frames.mjs` / `tools/item-interaction-probe.mjs`）：

| 组 | 断言 |
| --- | --- |
| A 入口 | `#tutorial-button` 在 `#controls-modal` 内且可见；≥641px 顶部 `#controls-button` 可见、点击后卡片打开且 `controls.eyebrow` 为 `HELP/帮助`；≤640px `#controls-button` 计算样式为 `display:none`，`#tutorial-setting` 存在且可点 |
| B 起手 | 点入口 → 说明卡关闭、`#tutorial-layer` 出现、`__voxalblast.tutorial().open === true`、`step === 'intro'` |
| C 步骤机 | 逐步推进：合法落子 → `turn`；转面 → `clear`；满线 → `share`；`ack` → `stuck`；换批 → `done`；`cta` → 关闭 |
| D 存档零副作用 | 进引导前读 `localStorage['voxalblast.session.v1']` 原文并哈希 → 引导全程（含一次满线消除与一次换批）→ 退出后再读，**字符串逐字节相同**；`clearSession()` 未被触发（槽存在） |
| E 还原 | 退出后 `__voxalblast` 的分数 / 候选三块 / 四道具次数 / 姿态与进入前逐项一致 |
| F 退出路径 | 任意步 `skip` 可退出；Esc 行为与实现选定的口径一致；`visibilitychange(hidden)` 退出且不写盘 |
| G 平台静默 | 全程无 `gameplayStart/Stop` 调用、无分数提交、无网络请求（沿用 `probe:ui` 的"无失败请求"写法） |
| H 可达性 | 浮层按钮 ≥44×44 CSS px；四个断点（390×844 / 360×640 / 1280×900 / 844×390）下浮层不覆盖候选区与棋盘落点区 |
| I 减动效 | `prefers-reduced-motion: reduce` 下无脉冲/演示动画，当前步仍读得懂 |

**回归门**（落地时全绿）：`npm test`、`npm run gates`、`npm run probe:tutorial`、`npm run probe:ui`、`npm run probe:item`、`npm run probe:drag`、`npm run shot`。
**验证边界**：以上全是无头与静态口径。真机手感、误触率、完成率、跳过率需要真人样本——**不许把"探针全绿"写成"引导有效"**。

## 8. 分轮建议与每轮 DoD

| 轮 | 内容 | DoD |
| --- | --- | --- |
| **R0** | 两个入口 + i18n 键 + 说明卡升格 + 空浮层与开关状态 + 存档抑制 guard | `npm run test:i18n` 绿；`probe:tutorial` A/B 段绿；`probe:ui` 不回归；引导可开可关、无副作用 |
| **R1** | 教学局（预置 + 固定手牌）+ S1/S2/S3 + 退出还原 | C/D/E 段绿；S1–S3 在真机尺寸下可完成 |
| **R2** | S4/S5/S6 + Esc/焦点/隐藏路径 + 减动效 | C/F/H/I 段绿 |
| **R3** | 真机自测（必要时录制）、04 与 README 对账、13 状态改「已实施」 | 制作人过一遍全流程；04 勾选带版本与环境 |

## 9. 风险与已知坑

1. **`clearSession()` 误触发 = 玩家丢档**。`endGame()` 会清槽，所以教学局必须**结构上**不可能走到 `endGame()`，不能只靠"脚本保证"。
2. **`syncPause()` 的语义**：引导既不是"暂停"也不是"正常局"，是全仓第一种"可操作但不算数"的状态。改之前先读懂 03 §4 与 `syncPause()` 的六个来源，改完在 03 里补一行说明。
3. **`#home-setting` / `#restart-setting` 是 `setting-action`，会直接把玩家带走**；引导中必须不可达（§5 的输入白名单）。
4. **S4 的棋盘高亮是可选项**：13 的 S4 描述的是表现目标；成本最低的做法是浮层里两张对照插图 + 真实棋盘上**复用 `pieceView` 既有的描边能力**做一次 2 秒强调。**不得**为此新增材质通道或第二套棋盘状态（03 §6 的开场动画就是靠"不写规则层"才收得住）。
5. **S5 不教瞄准手势**：道具拖出/取消属于 07 §8.10 的"首次进入清理道具引导"，两份引导不要互相抢教学内容（07 §13 记的那条缺口仍然独立存在）。
6. **探针别写成"读 class 猜状态"**：`__voxalblast.tutorial()` 与存档原文哈希是两个硬证据；KNOWN_GAPS 里那条"用 `__voxalblastDev.endGame()` 造真实空槽、不读 class 猜"的教训同样适用。
7. **窄屏入口**：`#controls-button` 在 ≤640px 是 `display:none`，桌面探针跑不到手机路径——A 段必须两条路都测。

## 10. 与既有文档的关系

- **13**：设计（为什么教这些、文案草案、边界）。本文与它冲突时，**以本文的实施口径为准**，并回头修 13。
- **02**：教学局预置是特例，已在 §4 末段写明边界。
- **03**：落地时需补一行"引导态"的输入/暂停口径。
- **07**：S5 与"首次进入清理道具引导"的关系见 §9.5。
- **04 / README**：落地时对账。

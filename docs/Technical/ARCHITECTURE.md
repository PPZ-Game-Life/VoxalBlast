# 技术结构与开发入口

> 结构章节（模块地图、状态归属、生命周期与资源释放、调试入口）同步至模块拆分重构（P0–P9）后的模块树，v0.8.23 / 2026-09-23；渲染章节同步至 v0.8.22 / 2026-09-22，依据仓库文件核对；非运行性能报告。

## 模块地图

| 位置 | 职责 |
| --- | --- |
| index.html | HUD、主页、候选容器、设置、操作说明与结算 DOM |
| src/main.js | 装配与启动：创建各模块、接线、`bind()`、boot 与唯一 rAF 主循环；`isPaused` 的唯一计算与 `syncPause()`；落子/结算/重开/续玩的流程胶水 |
| src/diagnostics.js | 装配 `__voxalblast` 只读接口与 DEV-only `__voxalblastDev`；只汇总各属主的只读 report，不复制投影或计分算法 |
| src/game/board.js | 外壳共享晶格、合法性、六面消除、开局预置、可放性 |
| src/game/shapes.js | 十类平面形状、归一化和辅助旋转 |
| src/game/scoring.js / honors.js | 纯计分、荣誉及反馈等级 |
| src/game/records.js / session.js | 已结束局纪录 / 单个未完成局，版本化校验与降级 |
| src/game/gameSession.js | 一局的唯一数据真源：棋盘、手牌、run 账本、runId、道具次数与工具规则、撤销窗口、救场判定、局终标志与存档数据半边（零 DOM / 零 Three） |
| src/game/tiers.js | 待标定的阶位阈值和映射 |
| src/rendering/config.js | 棋盘、手势、幽灵、质量与反馈参数 |
| src/rendering/blockResources.js | 共享几何与材质缓存的唯一属主（`blockGeometry` / `edgeGeometry` / `paintMaterial` / `toneIndexFor` 与 `sharedGeometries` 释放清单） |
| src/rendering/gameScene.js | 主场景：scene/camera/renderer/composer 与整条后处理链、取景解算、resize 与 ResizeObserver，以及 `cameraZoom` / `orbitDistance` / `appliedCanvasSize` |
| src/rendering/boardView.js | 立方体坐标系（`cubeVector` / `cellWorld`）、姿态模型（`cubeBase` / `cubeQuat` / 方位 / 吸附）、98 格与材质、开场两阶段波次 |
| src/rendering/pieceView.js | 三个候选预览（各自 renderer/scene/camera）、落点标记、拖拽幽灵（挂相机）、道具覆盖层 |
| src/rendering/effects.js | 粒子/线束/星星、`cameraShake`、慢放 dip 与音调/触感输出；相机静止位置归 gameScene，这里只出偏移 |
| src/rendering/toyLights.js | 主场景、候选与主页共用灯光与程序化线性 HDR 环境纹理 |
| src/rendering/woodTexture.js | AI 中性笔触底图生成原木 / 彩漆三组表面变体，独立色彩/高度/粗糙度；异步加载、程序兜底；UI 独立 CSS 木纹 |
| src/rendering/pastoralBackdrop.js | 加载随项目发布的田园 WebP；加载前/失败时保留程序 SVG，位于游戏画布之后的装饰层 |
| public/art/ | 背景与方块色素 WebP，以及来源、提示词、尺寸说明 |
| src/rendering/swipe.js / keyboard.js | 手势定轴（竖滑的侧带划分与自转的带符号）与键盘映射；实际由 `src/input/gameInput.js` 驱动 |
| src/input/gameInput.js | 全部指针与键盘输入：视角旋转手势、落子拖拽、道具瞄准、取消区与 click 抑制；只有只读查询与命名回调，不写游戏状态 |
| src/rendering/threeCompat.js | three.quarks / postprocessing 与 Three.js 的兼容桥，须先于粒子导入 |
| src/ui/icons.js | 代码生成的入口与道具 SVG 图标 |
| src/ui/dom.js | 静态 DOM 句柄一次性收集（缺失必需节点直接报选择器；动态节点不缓存） |
| src/ui/hud.js | HUD 展示（分数/连击/状态/toast/荣誉/道具条/轴选择）与候选槽 DOM 模板；预览的建与释放经回调交给 pieceView |
| src/ui/home.js | 主页封面与排行榜面板：封面 DOM、`homeOpen`、主页缩影 renderer、per-opener 焦点回位 |
| src/ui/gameOver.js | 结算卡展示（读 run 与结算摘要；不写纪录、不清续玩槽） |
| src/ui/settings.js | 设置面板、操作说明卡与键位提示；拥有 `settingsOpen` / `controlsOpen` / `soundOn` / `hapticsOn`，偏好经 platform/storage.js 读写 |
| src/styles.css / toy.css | 历史布局兼容 / 当前视觉覆盖 |
| src/platform/storage.js | 存储边界：`pickStorage()` / `probeStorage()` 与两个 `'on'/'off'` 偏好的转发；schema / `migrate()` / 内存降级仍留在各自 store |
| src/platform/crazygames.js | 可选平台 SDK 包装和降级路径 |

## 状态归属

每个可变状态只有一个写入者（重构计划 §2 的状态表）。「读」一栏写的是其它模块**实际**拿到它的方式：就地修改的 `const` 记录以同名解构绑回 main 只读使用，会被重新赋值的走访问器，其余一律走只读投影或命名回调。

| 状态 | 唯一写入模块 | 其它模块怎么读 |
| --- | --- | --- |
| board / pieces / run / runId / gameEnded / runLive / 道具次数 / 撤销窗口 | src/game/gameSession.js | `board`、`run` 是就地修改的 const 记录，main 直接绑定同名变量只读；`pieces`/`runId`/次数/局终标志走 `getPieces()` / `getRunId()` / `getItemCounts()` / `session.isEnded()` / `session.isSaveable()`；动作经解构的 `deal` / `settlePlacement` / `applyItem` / `openUndo` / `undoLast` / `stuckOutcome` 调用 |
| selectedPiece / drag / viewDrag / itemActive / itemTap / itemBusyUntil / suppressPieceClickUntil | src/input/gameInput.js | 只经只读查询 `input.getSelectedPiece()` / `input.dragReport()` / `input.getItemActive()` / `input.hasDrag()` / `input.hasItemActive()`；模块自己不读棋盘、分数与纪录，展示与结算全部经命名回调（`onDrop` / `onConfirmItem` / `onActivateItem` 等）回 main |
| cubeBase / cubeQuat / bearing / cubeLive / cubeSnapAnim / occupiedColors / tileFrontFace / intro | src/rendering/boardView.js | 就地修改的 const 对象（`cubeBase` / `cubeQuat` / `cubeSnapAnim`）以同名解构回 main；两个 `let`（方位与在飞手势）走 `getBearing()` / `setBearing()` / `getLive()` / `setLive()`；input 通过注入的 `beginAxisGesture` / `setLiveAngle` / `startCubeSnap` / `settleCubeSnap` 驱动姿态，自己不做四元数运算 |
| cameraZoom / orbitDistance / appliedCanvasSize | src/rendering/gameScene.js | `getCameraZoom()` / `getOrbitDistance()` / `getAppliedCanvasSize()`；改缩放只经 `zoomBy()`（滚轮的 clamp 跟着状态一起搬，shake 不再另存一份） |
| particleSystems / transientEffects / cameraShake / slowMo / audioContext | src/rendering/effects.js | main 只拿 `effects.timestep(raw)`（缩放后的 delta）、`effects.updateShake(delta)`（机位偏移）与只读 `effects.report()`；不读内部计数 |
| 候选预览 / 落点组 / 拖拽幽灵 / 道具覆盖层 | src/rendering/pieceView.js | 只经 `landingCells()` / `landingCount()` / `ghostReport()` / `candidateFrames()` 只读投影；建与画由 main 按参数调用（`showLanding` / `syncDragGhost` / `showItemOverlay`） |
| homeOpen | src/ui/home.js | `homeUi.isOpen()`；状态变化经 `onOpen` / `onClose` 回调通知 main 重算暂停锁 |
| settingsOpen / controlsOpen / soundOn / hapticsOn / controlSpin / axisHintTimer | src/ui/settings.js | `isOpen()` / `isControlsOpen()` / `getSoundOn()` / `getHapticsOn()`；effects 在发声/振动那一刻经 main 注入的实时 getter 读，不捕获布尔值 |
| isPaused | src/main.js（唯一计算点） | `syncPause()` 是唯一写者，以只读 getter 注入 input / boardView / effects，并由各 UI 的 `onOpen` / `onClose` 回调触发重算；没有第二个模块可以写它 |
| bestScore | src/main.js（显示缓存） | 真值是 `game/records.js` 的 `voxalblast.records.v1`；main 在 `endGame()` 后刷新缓存，hud 经 `getBest()` 读 |

## 生命周期与资源释放

**求值期不碰浏览器（模块层）。** 除入口 `src/main.js` 自己——它的下半部分就是 boot 本身：`installToyIcons()`、`installWoodSkin()`、`installPastoralBackdrop(appEl)`、`versionEl.textContent` 与 `document.visibilitychange` 的顶层注册——之外，没有任何模块在 ESM 求值期注册 DOM 监听、启动 `requestAnimationFrame` 或建立浏览器上下文：`blockSurfaceMaps()`、`createGameScene()` 这类会碰 document/WebGL 的构造都收在工厂里，由 main 显式调用，import 顺序因此不是承重结构。唯一的例外是刻意的副作用导入 `src/rendering/threeCompat.js`，它必须在 `three.quarks` 之前求值。

**顺序是 create → wire → bind → boot → animate：**

1. **create**：main 顶部 `installToyIcons()`，随后按依赖顺序建模块——`createGameSession()` → `createGameScene()`（其 `getCubeGroup` / `metrics` 是惰性 getter，所以工厂可以先于棋盘常量求值）→ `createBoardView()` → `createGameInput()` → `createBlockResources()` → `boardView.attachTiles()` → `createPieceView()` → `createEffects()` → `createGameOver()` / `createHud()`（`createHome()` 与 `createSettings()` 在它们的编排函数定义好之后才建，因为 `onOpen` / `onClose` 要接 `syncPause()`）。工厂只存闭包，活状态一律走 getter 或惰性回调。
2. **wire**：场景图由 main 组装一次（`scene.add(cubeGroup)`、`scene.add(camera)` —— 幽灵挂相机，所以相机必须进图，且只能加一次），`boardView.attachTiles()` 在原来那行调用，`cubeGroup` 的子节点顺序（cubeBody → gridGroup → landing → itemOverlay）是承重结构。
3. **bind**：`input.bind({ itemBar, axisPick, axisCancel, onActivateItem })` 与 `settingsUi.bind({...})` 在它们要调用的编排函数都已定义之后各调一次；两者都幂等并返回真正解绑的 disposer。`document.visibilitychange` 的编排刻意留在 main，按原粒度调 input 的三个取消方法，没有 `cancelAll()`。
4. **boot**：`scene3d.observeResize()` + `resize()` → 有快照 `continueRun()` / 无快照 `beginRun()` + `leaveHome()` → 再 `resize()` → `platform.initialize()`。
5. **animate**：`applyCubeRotation()` 后进入唯一的 rAF 循环。循环顺序：取 delta → `effects.timestep()` → 主页打开则提前返回 → `updateIntro(measure)`（**在 `!isPaused` 之外**，它自己就是暂停锁的来源）→ `effects.update()` / `updateCubeSnap()` → 需要时 `applyTileMaterials()` → `updatePiecePreviews()` → 由 gameScene 复位机位 + effects 叠加 shake 偏移 → `composer.render()`。各模块不自行驱动第二套主更新（hud 的一次性 rAF 动画不算）。

**谁拥有解绑入口：**

| 入口 | 属主 | 释放什么 |
| --- | --- | --- |
| `input.bind(...)` → disposer | src/input/gameInput.js | 画布 pointerdown / wheel、window 的 pointermove / pointerup / pointercancel / contextmenu / blur、document keydown、道具条的每个 `.item-button`、轴选择与轴取消按钮；幂等绑定 + 过期 disposer 守卫（候选槽自身的 `bindSlot()` 监听随 `renderPieceSlots()` 重建的槽 DOM 走，不在 disposer 清单里） |
| `settingsUi.bind(...)` → disposer | src/ui/settings.js | 设置面板与说明卡的 10 个监听器；同样幂等 + 守卫 |
| `scene3d.observeResize()` / `stopObservingResize()` | src/rendering/gameScene.js | 容器的 ResizeObserver（模块持有引用，供 disconnect） |
| `pieceView.disposePiecePreviews()` | src/rendering/pieceView.js | 三个候选各自的 renderer 与它们场景里的材质 |

**共享资源规则（不能被预览或缩影误伤）：** 唯一的 `blockGeometry`、`edgeGeometry` 与材质缓存由 `src/rendering/blockResources.js` 创建并持有，`sharedGeometries` 是释放前必须查的清单。棋盘的 98 格、三个候选预览、拖拽幽灵、落点标记、道具覆盖层与主页缩影**引用同一个实例**；`pieceView` 的节点释放（`disposeNode()`）与 `ui/home.js` 的缩影克隆都必须跳过清单里的几何，绝不 dispose 借来的共享实例——否则会释放掉棋盘正在绘制的几何。所有会碰 document/WebGL 的资源都通过工厂创建，不在模块求值期建立。

**重开一局不重建应用：** 「重新开始 / 再来一局」走 `resetGame()`——清特效与荣誉层、关榜、`board.clear()` + `seedOpening()`、重置道具次数与瞄准态、`resetRun()`、隐藏结算卡、清选中与拖拽、`resetCubeRotation()`、重新发牌、重画棋盘与 HUD、`syncPause()`。它不 dispose 模块、不重建 renderer、不重新 `bind()`（`churn` 探针的 8 次新局 / 10 次主页往返 / 12 次换批就是这条的探测器：监听器、canvas、renderer 与 mesh 数全部平线）。

**今天没有 app 级 `dispose()`。** 全 `src/` 检索 `dispose` 只有模块自己的解绑/释放入口（上表四个）与 `blockResources` / `effects` 内部的节点释放；main 不调用它们中的任何一个，也没有聚合它们的函数。重构计划 §6 P9 第 6 条要求的释放顺序因此只是**约定**，尚未实现成一个入口——真正需要它的是未来的 SPA 挂载/卸载或平台容器切换场景。

## 渲染与生命周期

Vite + 原生 ES modules，未使用 React 等 UI 框架。Three.js 主场景采用透视相机、圆角几何、阴影与程序环境反射；postprocessing 组织渲染、法线/深度、SSAO、Bloom、ACES、SMAA；three.quarks 批量处理粒子。v0.8.5 材质实现对照用户于 2026-09-17 指定的暖木彩漆参考图，未改变棋盘规则。

棋盘逻辑保持 5×5×5 外壳的 98 个唯一格，六面合计 150 个表面格。`buildFaceTiles()` 按晶格坐标去重，只创建 98 个 mesh；棱/角 mesh 的 `userData.faces` 同时记录相邻两面/三面，Three.js 场景树仍只有一个父 group。当前面提亮检查这一归属列表，放置按 cell 换材质，不再在每面叠放同一实体。棋盘、候选与拖拽共用 `RoundedBoxGeometry(0.94, 0.94, 0.94, 3, 0.085)`；`hullInset = 0.68` 指背板总边长减少量，背板为 4.32³，单侧缩进 0.34，不能当作单侧 0.68 使用。

`blockSurfaceMaps(painted, variant)` 为原木和彩漆各缓存三组 256×256 表面。`public/art/block-pigment.webp`（768×768，26,764 bytes）异步加载，按固定裁切/旋转取三组笔触，去除原图色偏和平均亮度后调制原木/彩漆；不烘焙方向光。`map` 为 sRGB，`bumpMap` 与 `roughnessMap` 为数据图；后者同时作为 `clearcoatRoughnessMap`。加载前/失败时保留程序纹理，成功后更新原 CanvasTexture 并重绘已有的主页场景，不重建 mesh。原木基色/当前面基色为 `#FF9C66 / #FFA16C`，按晶格坐标取确定性色调和变体。`MeshPhysicalMaterial` 的 `roughness / clearcoat / clearcoatRoughness / bumpScale`：原木 `0.43 / 0.65 / 0.18 / 0.009`，彩漆 `0.3 / 1 / 0.12 / 0.005`。背板和 UI 保留独立纹理入口。只读 `__voxalblast.rendering().surfaceArt` 返回 `loading / ready / fallback`，用于截图验收。

`toyLights.js` 生成共享的 256×128 HalfFloat 线性 HDR 等距柱状环境纹理，由各 WebGLRenderer 的 PMREM 分别处理，不跨 WebGL context 复用 GPU render target。`environmentIntensity = 0.7`；主反射光箱为软矩形，强度 14，切平面宽/高参数 `0.48 / 0.16`，轮廓反射光箱强度/集中指数为 `4 / 32`，方向与各自直接光一致。主 renderer 使用 `NoToneMapping`，composer 使用 HalfFloat 缓冲，并在最终效果链执行一次 `ACES_FILMIC`；候选与主页直接使用 renderer 的 `ACESFilmicToneMapping`，曝光统一取 `BOARD_STYLE.exposure = 1`。

主画布 pass 顺序为 `RenderPass → NormalPass → EffectPass(SSAO) → EffectPass(Bloom, ACES, SMAA)`。`NormalPass.renderTarget` 自持一个独立 `DepthTexture`（`UnsignedIntType`），先绘制本帧法线与深度，再由 `occlusionPass.setDepthTexture(contactDepth)` 提供给 AO；这是真实场景深度，不是占位纹理，也不需要 composer 的 stable-depth blit。AO 为暖褐 `#60422E`，主要参数 `radius 0.075 / intensity 1.65 / bias 0.012 / fade 0.018`，世界接近阈值/衰减 `0.35 / 0.45`，亮度影响 0.15。桌面采样/圈数/分辨率比例 `16 / 3 / 0.75`，移动或低性能档 `11 / 3 / 0.5`；采样数不取圈数的整倍数。主 composer 保留桌面 4× MSAA，低性能档为 0。

依赖实测版本：three 0.172.0、three.quarks 0.10.18、postprocessing 6.39.4、vite 6.4.3（package.json 里是 ^ 范围）。`src/rendering/threeCompat.js` 是引擎兼容桥，装两件事：

1. **quarks `updateRange`**：three r159 起用 `updateRanges`/`addUpdateRange()` 取代 `BufferAttribute.updateRange` 并在 r172 移除旧字段，而 quarks 0.10.18 仍写旧字段，缺桥时第一次消除或道具爆发就在 `animate()` 内抛错，画面冻结而逻辑继续。它必须在粒子导入之前执行；升级 three.quarks 到 0.17.x 后删除该桥并重跑 04 的停摆回归项。同一处坑还有 `emissionBursts[].count`：必须是 ValueGenerator（`new ConstantValue(n)`），传裸数字同样会抛错。
2. **postprocessing 深度纹理**：`SMAAEffect` 声明 `EffectAttribute.DEPTH`，但当前 COLOR 检边且 predication 关闭的配置不采样深度。composer 若应请求创建 stable depth，会通过 `DepthTexture.clone()` 与输入深度共享 `texture.source`；three r172 因而复用同一 GPU 深度图，blit 时触发 `Read and write depth stencil attachments cannot be the same image`。`skipComposerDepthBlit(effectPass)` 仅在最终 Bloom/ACES/SMAA pass 的 `addPass()` 之前设置占位深度，避免无用申请。**它不用于 SSAO：AO pass 在加入 composer 前绑定上述 NormalPass 的独立真实深度。** 两个 pass 均已有各自的深度来源，composer 不创建别名 stable target；无需为此关闭 HDR 或 MSAA。postprocessing 修复克隆深度别名后再评估删除兼容桥，新增真正读深度的效果必须绑定有效的场景深度。

三个候选各有透明 WebGLRenderer 与正交相机，主页另有静态按需渲染器。主页打开时主动画循环跳过场景绘制。质量档位初始化时选择，像素比/后处理/粒子与阴影作相应降级；不宣称已有运行时 FPS 自适应。

v0.8.20：主页 `.home-open` 令局内 `.topbar/.game-layout` 不可见且 `inert`，保留布局尺寸与相机状态，离开主页时恢复；主页独立 hero 与田园层照常显示。候选预览创建/尺寸变化时用实体包围盒的相机空间范围适配正交视野，宽高两轴保留约 10px 留白，最小半高 1.6；只读 `candidateFrames()` 返回各形状完整包围盒的 NDC 范围，截图检查相机裁切和 DOM 裁切。按钮用 CSS 多层木框/凹面和 SVG 渐变雕刻图标；渐变 ID 每个入口唯一。

背景从 `${import.meta.env.BASE_URL}art/pastoral-valley.webp` 加载，使用 `object-fit: cover` 中心裁切；成功后才隐藏原 SVG，失败时移除图片并保留 SVG。背景为 `aria-hidden`、不接收指针的独立 DOM 层，天空底色留在 `html`、`body` 透明。资产为随构建发布的本地 WebP，不依赖在线生图服务；尺寸和来源见 [资产说明](../../public/art/README.md)。

v0.8.22 开场两阶段动画（`src/rendering/boardView.js` 的 intro 区块 + `src/rendering/config.js` 的 `INTRO_STYLE`）。98 个格块先被造出来（第一阶段，穿一族三档冷灰蓝底漆，按格块高度分档），停 0.22s，再用同一道斜向波次刷成各自正式色（第二阶段，`color` 从底漆插值到该材质自己的 `color`，`roughness/clearcoat/bumpScale` 同步回位）。两阶段共用同一套屏幕对角线顺序与 26 个波带，只是波带步长不同（0.042s / 0.038s）。实现要点四条：**逐格材质 clone 由 `tile.userData.introMaterial` 复用**（`copy()` 按引用带入贴图，不产生 GPU 上传，结束时交还共享实例）；**变换与颜色在 arm 时逐格快照**，`settleIntro()` 显式还原而不是沿用末帧算术；**时钟只有 rAF 一个**，`updateIntro()` 取未钳制的 `clock.getDelta()`（游戏其余部分沿用 0.05s 钳制），没有 timer/tween，因此取消、隐藏、重开都不会留下残影；**布局稳定后允许重排一次**（启动时先 arm 再 `resize()`，`intro.scheduledSize` 与 `appliedCanvasSize` 不一致且 `elapsed < 0.08` 时重算一次排序，之后固定）。输入锁复用 `syncPause()`（`introPlaying()` 是它的一个来源），`armIntro()` 每次先 `settleIntro()`，所以任何时刻最多一轮，`introPlays` 记录本次加载的轮数。只读回读 `__voxalblast.intro()` 返回阶段、逐格进度（含 `primer`/`final` 标记）与结束后的完整性计数；`tools/intro-probe.mjs`（`npm run probe:intro`）据此断言启动入口、两阶段、波向、跨面、节奏、结束后位姿/颜色/材质/缩放零误差，并用跨导航的 CDP screencast 录下真实启动帧序。

启动入口（v0.8.22）：模块求值末尾先 `resize()`，随后**有快照 `continueRun()`、无快照 `beginRun()` + `leaveHome()`**（不再 `openHome()`），再补一次 `resize()`——`resetGame()`/`applySession()` 会填满候选与道具条，容器高度随之变化，ResizeObserver 会再触发一次重排与相机重取景。主页只由设置里的「回到主页」打开。

主画布由 ResizeObserver 追踪容器尺寸。resize 先更新 renderer 尺寸及相机 FOV/aspect/投影、重新取景，再调用 `composer.setSize()`，保证 SSAO 缓存的是新投影矩阵及其逆矩阵。NormalPass 的 render target 随 composer 调整尺寸，Three.js 在绑定时同步其独立深度纹理尺寸，无需替换 `contactDepth`。棋盘姿态采用四元数基准与展示偏摆；鼠标/触摸的面坐标通过投影换算，不从屏幕像素直接改规则格子。

## 存档边界

- voxalblast.records.v1：已结束局纪录、周最佳和最近十局。
- voxalblast.session.v1：棋盘、分数、三候选、道具、局内荣誉/链和姿态。

v0.8.19：`session.migrate()` 将历史棋盘 RGB 按原形状身份映射到现行 `SHAPES` 配色（涵盖 v0.7 前十色与 v0.8.17 前四个暖色）。不改变存档结构/键名和版本，不改棋盘占用或进度；读写均迁移且幂等，未知及现行颜色原样保留。恢复测试 fixture 为 `tools/fixtures/legacy-palette-session.json`，截图时设置 `SHOT_SESSION` 指向该文件、`SHOT_ONLY=desktop-board,mobile-board`；注入仅发生于截图工具的隔离浏览器。v0.8.19 的 278 项规则检查、生产构建、桌面/手机旧局恢复截图均通过。
- voxalblast-sound / voxalblast-haptics：独立声音/触感偏好。

records/session 有数据校验及存储失败后的内存降级；两个偏好自重构 P8 起经 `src/platform/storage.js` 这一窄门面转发（由 `src/ui/settings.js` 调用），而这条路径**刻意不做防护**——存储抛异常时仍然抛，安全降级仍是未做的缺口，见 [待办](KNOWN_GAPS.md)。存档不等于云存档。

## 开发和检查

npm run dev 启动开发；npm test 执行 tools/rule-tests.mjs（v0.5.0 时为 216/216，v0.8.1 起 236/236，新增 swipe 组；v0.8.23 起 300/300，新增 storage 组）与 tools/game-session-tests.mjs（v0.8.23 起串跑两套，单跑入口 `npm run test:rules` / `npm run test:session`，另一步到位跑完全部回归的是 `npm run gates`）；npm run build 生成 dist；npm run preview 检查正式产物；npm run shot 走无头 Edge 抓桌面+移动端实机截图；npm run probe:swipe 在无头 Edge 里走完三个手势并断言其世界轴方向；三个重构回归探针入口是 `npm run probe:interaction` / `probe:ui` / `probe:churn`；npm run reachability 运行较长的可达性分析，默认写出 tools/reachability-baseline.json（v0.3 样本保存在 tools/reachability-v0.3.json）；v0.8.2 起它还能在不改任何玩法代码的前提下试参数——`--pool=` 取形状子集（重名＝加权）、`--batch=` 改手牌大小、`--faces=` 换晶格尺寸（按 board.js 同一批公式重建，并在 5×5 时逐格比对，防止模拟一个游戏里没有的棋盘）、`--rng=` / `--seed=` 换随机源，输出里带本次实际使用的 lattice / pool / batch / rng / seed 与 `endedNaturallyPct`、`stepsWhenEnded`（撞 600 手上限＝没结束）。结果样本存 tools/reachability-pool-matrix.json 与 tools/reachability-lattice-matrix.json，结论与判读边界见 [难度与单局长度测量](DIFFICULTY_BASELINE.md)。注意默认随机源仍是老的 31 位 LCG：它会把整局按种子聚簇（同一配置不同种子可差 20pp），**结论性数字要用 `--rng=mulberry32` 加多种子**。

测量专用的 A/B/C/D 实验使用 `node tools/difficulty-abcd.mjs --games=200 --seeds=1,2,3 --strategies=noise --out=tools/results/difficulty-abcd.json`，独立于旧 reachability 命令。`tools/difficulty-model.mjs` 调用正式 `Board.seedOpening` 生成对照开局，在 Node 内使用四字位集加速结算；结构化开局与阶段发牌只存在于 tools，正式游戏不导入。`node tools/difficulty-tests.mjs` 验证与真实 Board 的差分一致性、随机流隔离、开局验证路径、阶段边界及右删失统计。JSON保存逐局记录、配对比较、源码SHA256和生存曲线，同时输出无需服务器即可打开的HTML图表。具体算法、样本量、局长判读和局限见 [A/B/C/D实验报告](DIFFICULTY_ABCD.md)。

同一支工具也能扫候选池与开局密度：`--arms=<池>/<uniform|staged>[/<开局>]`（例如 `--arms=e/staged,current/uniform/max --games=300 --seeds=1,2,3`）把因子拆开对照——只差一个因子的臂之间才做配对，因此同池不同发牌、同发牌不同池、同池同发牌不同开局分别给出独立的差值。每次运行还会输出**紧张度面板**：每步记录手上还有几种不同形状放得下、以及这些形状的合法物理落点总数，逐局汇总成"三块全可放占比""三块里只有一块放得下占比""本局最紧时刻""可选≤19格步数占比"。面板必须按手牌构成分层——每批最后一块天然只剩一种形状，不分层就会稳定报出 ~33% 的假"被迫落子"。池定义写在 `difficulty-model.mjs` 的 `POOL_SPECS`（相对权重；池 id 拼错即报错，不会静默退回正式池）：`current` 逐值等于正式十种等权重，`c`/`d`/`w90`/`e`/`e5` 是压缩候选。开局定义写在同一文件的 `OPENING_SPECS`：`current` 逐值等于正式 `config.js` 的 `OPENING_LAYOUT`（+z/+y/+x = 7/3/3），`empty` 复现 v0.2.31 之前的空棋盘，`mid`/`high`/`max` 是加重档（每面最多 16 格——17 格必然凑满一线，正式生成器会拒绝）。等概率臂按权重累计表抽取；阶段臂把阶段权重在"该池仍有成员的组"上**重新归一化**，所以池里没有小件时不会留下 20% 的空组配额。两种臂每槽都恰好消耗两个随机数，配对随机流因此保持对齐。`--groups` 与 `--arms` 互斥，前者仍是最早的四组。结论与局限见 [候选池测量](DIFFICULTY_POOL.md)、[开局密度测量](DIFFICULTY_OPENING.md) 与 [紧张度测量](DIFFICULTY_TENSION.md)。

不在 npm scripts 里、需要直接 node 运行的脚本：tools/tier-calibration.mjs 把分数样本换算成阶位切点；tools/png-stats.mjs 统计截图尺寸与像素分布，用来证明截图不是空白帧；tools/organize-docs.mjs 是 2026-09-14 文档整理的一次性脚本，整理完不再执行。tools/push.cmd 是受控推送脚本（`tools\push.cmd` 推 main，可带分支名与 `--pause`），只做提交推送、不参与构建。

`tools/screenshot.mjs` 走 CDP 而不是 `msedge --screenshot`：后者只截首帧，而游戏开在主页遮罩上，裸 flag 永远拍不到棋盘。该脚本先点掉主页、再截图，并收集 `window.onerror` / `unhandledrejection` —— 本轮就是靠它在一次运行里抓到一处改名遗漏导致的整盘空白。它同时把两个已知陷阱固化在代码里：headless 的布局视口有约 500px 最小宽度（竖屏只能用 500×1082），以及刚退出的 Edge 会短暂占住调试端口与 profile 锁（每次抓图独立端口 + 独立 `%TEMP%` user-data-dir）。

产物目录：artifacts/visual/ 存实机截图（`npm run shot` 输出），artifacts/ 整体不入库。

`tools/swipe-probe.mjs`（v0.8.1）测的是看不见的东西：一次手势到底把立方体往哪边转了。它用 CDP 的 `Input.dispatchMouseEvent` 在左右侧带与六面体范围内各滑一次，前后读 `__voxalblast.rotation()`，并把**网格姿态的旋转** `world = base1 * inverse(base0)` 解成轴角——这是与相机无关、与起手姿态无关的那个量，三条断言（左带 `+Z`、右带 `-Z`、范围内 `+X`）就是"跟手"的可执行定义。坑：用**姿态差** `inverse(pose0) * pose1` 会被当前网格姿态共轭，只有立方体未旋转时才等于世界轴——探针第一版因此在起点带 180° 滚转时把俯仰行的符号读反了，现在两个量都输出，姿态差只作对照。它需要一个在 5173 上的 dev server，脚本会自己起一个并故意留着（下次运行直接复用）。

## 调试入口

`__voxalblast`（只读，任何构建都挂载）与 `__voxalblastDev`（写入口，仅 DEV）自重构 P9 起由 `src/diagnostics.js` 装配。它只**汇总**各属主的只读 report，拼成原来的名字与字段顺序，自己不复制投影、不复制计分算法，也不被任何玩法路径调用；`src/main.js` 只把模块和 `import.meta.env.DEV` 下构建的 DEV 回调交给它。二者是调试设施，不是游戏对外 API——检查接口实际定义后再使用，不依赖历史稿的旧探针结构。

`__voxalblast` 每个键的内容与属主（以 `src/diagnostics.js` 的 `readOnly` 对象为准）：

| 键 | 内容 / 属主 |
| --- | --- |
| version | `package.json` 的版本 |
| rendering | boardView 的 98 格计数 + blockResources 的 `trianglesPerBlock` + woodTexture 的 `surfaceArt` + gameScene 的后处理读数 |
| rotation / faces / poseAxisScreen | boardView 的姿态、六面投影占比与旋转轴在屏幕上的朝向 |
| bounds / framing | gameScene 的方块屏幕包围盒与取景读数 |
| preview / placement / ghost | 落点预览（input 的 `dragReport()` + pieceView 的 `landingCells()`）、候选在正面上的朝向、拖拽幽灵的两半 |
| board / run / records / session | session 的棋盘与 run 账本、records 与 session 两个 store 的快照 |
| home | homeUi 的封面报告 + sessionStore 的 `persistent`；intro / candidateFrames / effects 分别是 boardView 的波次报告、pieceView 的候选包围盒、effects 的 `trackedSystems`/`transients`/`shake`/`slowMo` |
| keys / controls / shapes | keyboard 的键位表、settingsUi 的报告、shapes 的候选池 |

`__voxalblastDev` 只在 `import.meta.env.DEV` 为真时挂载（vite 在生产包里把该标志替换成 `false`，因此生产产物既没有这个对象也没有它背后的闭包）：`endGame` / `openLeaderboard` / `records` / `replayIntro` / `settleIntro` / `triggerSlowMo` / `setItems` / `items` / `jam` / `stuckCheck` / `showChain` / `showHonor` / `showScorePop`。回调本身在 `src/main.js` 里构建——`jam()` 会写满自由格、`showChain()` 会改 run 账本，它们是玩法动作而不是读出口，diagnostics 只负责把名字挂上去。

探针脚本与它们钉住的契约（`npm test` 现在串跑规则与会话两套；`npm run gates` 再串上三个重构回归探针，一次跑完下面这张表里的 1、2、4、5、6 行）：

| 脚本 | npm 入口 | 断言什么 |
| --- | --- | --- |
| `tools/rule-tests.mjs` | `npm test` / `npm run test:rules` | 规则层十组：六面共享格与跨面消除、计分、荣誉、已结束局纪录、阶位、存档、存储降级、键盘映射、手势定轴、发牌权重 |
| `tools/game-session-tests.mjs` | `npm test` / `npm run test:session` | 纯 Node 跑 `game/gameSession.js`（无 DOM / 无 Three）：发牌与 run token、落子与计分、道具作用范围且不计分、撤销还色还次数、三类救场、局终幂等、存档往返 |
| `tools/refactor-interaction-probe.mjs` | `npm run probe:interaction` | 落子端到端：合法落点=预览格、非法落点不改棋盘不留幽灵、短按选择、Esc/右键取消、设置打断、第二指不提交第一指来的一块、真实 reload 续玩、10 次拖拽无残留 |
| `tools/refactor-ui-probe.mjs` | `npm run probe:ui` | 面板与焦点：声音开关一次点击只翻一次（双绑定探测器）、两个入口的焦点回位、主页 `inert`、排行榜 per-opener 焦点、Escape 优先级、PLAY AGAIN 真起新局、10 次开关 churn 后仍只翻一次、偏好与本地纪录跨真 reload 不变 |
| `tools/refactor-churn-probe.mjs` | `npm run probe:churn` | 反复新局/返家/设置/换批后的**稳态**：活跃监听器、canvas 数、`rendering()` 的 meshes/uniqueCells/programs 与候选槽数不单调增长，且 churn 之后真实拖拽仍能附着 |
| `tools/swipe-probe.mjs` | `npm run probe:swipe` | 三个手势的世界轴方向（左带 +Z、右带 −Z、立方体上 +X），用网格姿态差而非姿态差解轴 |
| `tools/cube-framing-probe.mjs` | `npm run probe:framing` | 24 种标准朝向的停稳构图、面内偏斜与手势旋转轴在屏幕上的方向；正式验收不能加 `--quick` |
| `tools/intro-probe.mjs` | `npm run probe:intro` | 开局波次：入口、两阶段、波向、跨面、节奏与结束后的位姿/颜色/材质/缩放零误差（另存 CDP screencast 帧序） |
| `tools/rescue-probe.mjs` | `npm run probe:rescue` | 无块可放时的三条分支（Refresh → 清理挡路格 → 局终）与「装上道具再点一次卸下不花次数」 |
| `tools/screenshot.mjs` | `npm run shot` | 10 个视口/页面组合的实机截图 + `window.onerror`/`unhandledrejection` 收集 + 候选画布未被槽裁切 + 波次已收尾且完整性误差为 0 + 结算卡可见且 `#reset-modal` 命中自身 |

## 如何加东西（以及哪里不该动）

**加一个新动作（玩法 / 流程）**

1. 规则与数据进 `src/game/gameSession.js`，或它下面的纯模块（`board.js` / `scoring.js` / `honors.js` / `shapes.js`）。动作写成纯函数或「动作 → 明确结果对象」，**不碰 DOM、不弹窗、不放音效**；`stuckOutcome()` 返回的 `idle / playable / refresh / clear-path / end` 就是模板。
2. 结果回到 `src/main.js` 的一个命名回调里做展示与编排：落子走 `onDrop({ piece, face, cells, origin })`，道具走 `confirmItem()` / `activateItem(id)`。结算次序（本地纪录 → 清续玩槽 → 平台提交）固定留在 `endGame()`。
3. 输入触发进 `src/input/gameInput.js`，由它的 `bind()` 注册（幂等、返回 disposer）；模块只交出「玩家做了什么」，不改棋盘、分数与纪录。
4. 要一并更新的既有调用点：`syncPause()` 的暂停来源（新动作若上锁）、`sessionSnapshot()` / `saveSession()`（新状态若要能续玩）、`resetGame()` / `resetItems()`（新状态若要随新局复位）、`src/diagnostics.js` 的只读投影（若要被探针断言）、`tools/game-session-tests.mjs`（纯 Node 断言）。

**加一个新 UI / 新面板**

- 新建 `src/ui/<name>.js` 工厂：显式接收 DOM 句柄（静态节点从 `src/ui/dom.js` 的 `collectDom()` 解构）与命名回调；自己拥有 open 标志并暴露 `isOpen()`。`ui/*` 目前**不 import `main.js`、也不互相 import**，这一条要保持。
- 在 main 里创建它，并把模块的 `onOpen` / `onClose` 接回 `syncPause()`，同时把新的暂停来源加进那个布尔式——暂停只有 main 一个真源。
- 焦点按 opener 回位（点按钮进来就还给那个按钮，Escape 路径同理）；面板自己的监听器从模块的 `bind()` 注册一次并返回 disposer，不要在每次 open 时注册。
- 需要被自动化核对时，在 `src/diagnostics.js` 里加一条只读投影（如 `controls: () => settingsUi.report()`），不要在 main 里另算一份。
- **照抄样本**：`src/ui/settings.js` —— open 标志、`bind()` / `dispose()`、焦点回位、偏好经 `src/platform/storage.js` 读写、以及被 diagnostics 读的 `report()` 都在同一个文件里。

**加一个新效果**

- 粒子系统、线束/星星、屏幕震动、慢放、音调与触感都进 `src/rendering/effects.js`；数量、寿命、颜色、强度等参数进 `src/rendering/config.js`（`VFX_CONFIG` / `FEEDBACK_STYLE` / `HUD_STYLE`），**不在调用点硬编码**。
- 由 main 的流程按名字显式调用（`emitItemBurst()` / `spawnClearEffects()` / `playHonorSound()` / `triggerSlowMo()` 的现有形状）；effects 不改棋盘、不算分、不写 HUD。
- **不许起第二条 `requestAnimationFrame`**：更新挂在 main 唯一主循环的 `effects.update(delta)` / `effects.updateShake(delta)` 上；`effects.timestep()` 只缩放动画时钟，不缩放输入。
- 要能被断言就扩 `effects.report()` 的字段（`trackedSystems` / `transients` / `shake` / `slowMo` 就是模板），不要在 main 里留一份计数副本。

**不该改哪些模块 / 禁区**

- `src/game/board.js` 与 `shapes.js` / `scoring.js` / `honors.js` / `tiers.js`：纯规则，**不得新增 DOM / Three / storage 依赖**。
- `src/game/gameSession.js` 必须保持能纯 Node 跑（`npm run test:session`）：不得引入 DOM、Three、`window`、`localStorage`。
- 存档键与 schema 版本：`voxalblast.records.v1`（`RECORDS_VERSION = 1`）、`voxalblast.session.v1`（`SESSION_VERSION = 1`）、`voxalblast-sound` / `voxalblast-haptics`。改键名或版本就是丢玩家数据，必须单独立项；`src/platform/storage.js` 对两个偏好**刻意不做防护**，别顺手「补全」成静默降级。
- `src/rendering/blockResources.js` 的单一共享几何/材质缓存：棋盘 98 格、候选预览、拖拽幽灵、落点标记、道具覆盖层与主页缩影引用同一实例，预览或主页路径**绝不允许** dispose 共享资源。
- `index.html` 的 `#app-version` 留在 `.topbar` 内（v0.2.20 回归与 v0.8.21 的手机反馈）；main 只写它的 `textContent`，不按 `import.meta.env.DEV` 隐藏、也不给它加 `hidden`（`toy.css` 里 `.app-version[hidden]` 那条会真的把它藏掉），窄屏只缩到 `.5rem`。
- **任何模块都不得 import `src/main.js`**：main 是装配层，只由入口自己求值一次。
- `src/rendering/threeCompat.js` 必须继续早于 `three.quarks` 求值：`src/rendering/effects.js` 已把它放在自己第一条 import（quarks 在第 30 行），main 另保留一行副作用导入钉顺序——动 import 时先复查这条。

[部署事实](NETLIFY_DEPLOYMENT_BASELINE.md) · [当前回归清单](../Planning/04-MVP验收清单.md)

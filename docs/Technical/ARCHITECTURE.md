# 技术结构与开发入口

> v0.8.1 / 2026-09-16，依据仓库文件核对；非运行性能报告。

## 模块地图

| 位置 | 职责 |
| --- | --- |
| index.html | HUD、主页、候选容器、设置、操作说明与结算 DOM |
| src/main.js | Three.js 场景、输入、拖拽、UI 编排、当前局、粒子、存档调用 |
| src/game/board.js | 外壳共享晶格、合法性、六面消除、开局预置、可放性 |
| src/game/shapes.js | 十类平面形状、归一化和辅助旋转 |
| src/game/scoring.js / honors.js | 纯计分、荣誉及反馈等级 |
| src/game/records.js / session.js | 已结束局纪录 / 单个未完成局，版本化校验与降级 |
| src/game/tiers.js | 待标定的阶位阈值和映射 |
| src/rendering/config.js | 棋盘、手势、幽灵、质量与反馈参数 |
| src/rendering/toyLights.js | 主场景、候选与主页共用灯光与程序化线性 HDR 环境纹理 |
| src/rendering/woodTexture.js | 确定性的低对比原木 / 彩漆 `map` 与独立 `bumpMap`；UI 另用固定种子的 CSS 木纹 data URL |
| src/rendering/pastoralBackdrop.js | 加载随项目发布的田园 WebP；加载前/失败时保留程序 SVG，位于游戏画布之后的装饰层 |
| public/art/ | 背景 WebP 与来源、提示词、尺寸说明 |
| src/rendering/swipe.js / keyboard.js | 手势定轴（竖滑的侧带划分与自转的带符号）与键盘映射 |
| src/rendering/threeCompat.js | three.quarks / postprocessing 与 Three.js 的兼容桥，须先于粒子导入 |
| src/ui/icons.js | 代码生成的入口与道具 SVG 图标 |
| src/styles.css / toy.css | 历史布局兼容 / 当前视觉覆盖 |
| src/platform/crazygames.js | 可选平台 SDK 包装和降级路径 |

## 渲染与生命周期

Vite + 原生 ES modules，未使用 React 等 UI 框架。Three.js 主场景采用透视相机、圆角几何、阴影与程序环境反射；postprocessing 组织渲染、Bloom、ACES、SMAA；three.quarks 批量处理粒子。

棋盘逻辑保持 5×5×5 外壳的 98 个唯一格，六面合计 150 个表面格。`buildFaceTiles()` 按晶格坐标去重，只创建 98 个 mesh；棱/角 mesh 的 `userData.faces` 同时记录相邻两面/三面，Three.js 场景树仍只有一个父 group。当前面提亮检查这一归属列表，放置按 cell 换材质，不再在每面叠放同一实体。棋盘、候选与拖拽共用 `RoundedBoxGeometry(0.94, 0.94, 0.94, 3, 0.075)`；`hullInset = 0.68` 指背板总边长减少量，背板为 4.32³，单侧缩进 0.34，不能当作单侧 0.68 使用。

原木与彩漆分别使用低对比纹理、微弱凹凸和清漆参数；`map` 为 sRGB，`bumpMap` 保持数据色彩空间。`toyLights.js` 生成共享的 256×128 HalfFloat 线性 HDR 等距柱状环境纹理，由各 WebGLRenderer 的 PMREM 分别处理，不跨 WebGL context 复用 GPU render target。主 renderer 使用 `NoToneMapping`，composer 使用 HalfFloat 缓冲，并在最终效果链执行一次 `ACES_FILMIC`；候选与主页直接使用 renderer 的 `ACESFilmicToneMapping`，曝光统一取 `BOARD_STYLE.exposure`，避免主画布与小预览的色彩流程不同。

依赖实测版本：three 0.172.0、three.quarks 0.10.18、postprocessing 6.39.4、vite 6.4.3（package.json 里是 ^ 范围）。`src/rendering/threeCompat.js` 是引擎兼容桥，装两件事：

1. **quarks `updateRange`**：three r159 起用 `updateRanges`/`addUpdateRange()` 取代 `BufferAttribute.updateRange` 并在 r172 移除旧字段，而 quarks 0.10.18 仍写旧字段，缺桥时第一次消除或道具爆发就在 `animate()` 内抛错，画面冻结而逻辑继续。它必须在粒子导入之前执行；升级 three.quarks 到 0.17.x 后删除该桥并重跑 04 的停摆回归项。同一处坑还有 `emissionBursts[].count`：必须是 ValueGenerator（`new ConstantValue(n)`），传裸数字同样会抛错。
2. **postprocessing 深度纹理**：`SMAAEffect` 声明 `EffectAttribute.DEPTH`，于是承载它的 `EffectPass` 会向 composer 索取深度纹理；`EffectComposer.addPass()` 用 `DepthTexture.clone()` 造出「稳定深度目标」，而 three r172 按 `texture.source` 共享同一个 GPU 纹理，克隆体与输入缓冲的深度附件是同一张图。`RenderPass` 置 `needsDepthBlit` 后，composer 把这张图 blit 给自己，驱动直接拒绝：`GL_INVALID_OPERATION: glBlitFramebuffer: Read and write depth stencil attachments cannot be the same image`。画面本身看不出问题（本链效果都不读深度，`EffectPass` 只把 `depth` 转给片元着色器显式接收它的效果），但每次加载都会产生一次非法 GPU 调用，并被 `npm run shot` 判为失败。`skipComposerDepthBlit(effectPass)` 在 `addPass()` 之前给该 pass 一个占位深度纹理，使其 `needsDepthTexture === false`，composer 便不再创建这对别名目标。**postprocessing 不再克隆深度纹理后删除它；若链上加入真正读深度的效果（SSAO、景深、描边），这个替换不再成立。**

三个候选各有透明 WebGLRenderer 与正交相机，主页另有静态按需渲染器。主页打开时主动画循环跳过场景绘制。质量档位初始化时选择，像素比/后处理/粒子与阴影作相应降级；不宣称已有运行时 FPS 自适应。

背景从 `${import.meta.env.BASE_URL}art/pastoral-valley.webp` 加载，使用 `object-fit: cover` 中心裁切；成功后才隐藏原 SVG，失败时移除图片并保留 SVG。背景为 `aria-hidden`、不接收指针的独立 DOM 层，天空底色留在 `html`、`body` 透明。资产为随构建发布的本地 WebP，不依赖在线生图服务；尺寸和来源见 [资产说明](../../public/art/README.md)。

主画布由 ResizeObserver 追踪容器尺寸。棋盘姿态采用四元数基准与展示偏摆；鼠标/触摸的面坐标通过投影换算，不从屏幕像素直接改规则格子。

## 存档边界

- voxalblast.records.v1：已结束局纪录、周最佳和最近十局。
- voxalblast.session.v1：棋盘、分数、三候选、道具、局内荣誉/链和姿态。
- voxalblast-sound / voxalblast-haptics：独立声音/触感偏好。

records/session 有数据校验及存储失败后的内存降级；偏好的直接 localStorage 读取不在这一降级封装内，限制见 [待办](KNOWN_GAPS.md)。存档不等于云存档。

## 开发和检查

npm run dev 启动开发；npm test 执行 tools/rule-tests.mjs（v0.5.0 时为 216/216，v0.8.1 起 236/236，新增 swipe 组）；npm run build 生成 dist；npm run preview 检查正式产物；npm run shot 走无头 Edge 抓桌面+移动端实机截图；npm run probe:swipe 在无头 Edge 里走完三个手势并断言其世界轴方向；npm run reachability 运行较长的可达性分析，默认写出 tools/reachability-baseline.json（v0.3 样本保存在 tools/reachability-v0.3.json）；v0.8.2 起它还能在不改任何玩法代码的前提下试参数——`--pool=` 取形状子集（重名＝加权）、`--batch=` 改手牌大小、`--faces=` 换晶格尺寸（按 board.js 同一批公式重建，并在 5×5 时逐格比对，防止模拟一个游戏里没有的棋盘）、`--rng=` / `--seed=` 换随机源，输出里带本次实际使用的 lattice / pool / batch / rng / seed 与 `endedNaturallyPct`、`stepsWhenEnded`（撞 600 手上限＝没结束）。结果样本存 tools/reachability-pool-matrix.json 与 tools/reachability-lattice-matrix.json，结论与判读边界见 [难度与单局长度测量](DIFFICULTY_BASELINE.md)。注意默认随机源仍是老的 31 位 LCG：它会把整局按种子聚簇（同一配置不同种子可差 20pp），**结论性数字要用 `--rng=mulberry32` 加多种子**。

测量专用的 A/B/C/D 实验使用 `node tools/difficulty-abcd.mjs --games=200 --seeds=1,2,3 --strategies=noise --out=tools/results/difficulty-abcd.json`，独立于旧 reachability 命令。`tools/difficulty-model.mjs` 调用正式 `Board.seedOpening` 生成对照开局，在 Node 内使用四字位集加速结算；结构化开局与阶段发牌只存在于 tools，正式游戏不导入。`node tools/difficulty-tests.mjs` 验证与真实 Board 的差分一致性、随机流隔离、开局验证路径、阶段边界及右删失统计。JSON保存逐局记录、配对比较、源码SHA256和生存曲线，同时输出无需服务器即可打开的HTML图表。具体算法、样本量、局长判读和局限见 [A/B/C/D实验报告](DIFFICULTY_ABCD.md)。

同一支工具也能扫候选池：`--arms=<池>/<uniform|staged>`（例如 `--arms=e/staged,e5/staged,current/staged --games=200 --seeds=1,2,3`）把两个因子拆开对照——同池不同发牌、同发牌不同池，配对比较只落在"只差一个因子"的臂之间。池定义写在 `difficulty-model.mjs` 的 `POOL_SPECS`（相对权重；池 id 拼错即报错，不会静默退回正式池）：`current` 逐值等于正式十种等权重，`c`/`d`/`w90`/`e`/`e5` 是压缩候选。等概率臂按权重累计表抽取；阶段臂把阶段权重在"该池仍有成员的组"上**重新归一化**，所以池里没有小件时不会留下 20% 的空组配额。两种臂每槽都恰好消耗两个随机数，配对随机流因此保持对齐。`--groups` 与 `--arms` 互斥，前者仍是上一轮的四组。结论与局限见 [候选池测量](DIFFICULTY_POOL.md)。

不在 npm scripts 里、需要直接 node 运行的脚本：tools/tier-calibration.mjs 把分数样本换算成阶位切点；tools/png-stats.mjs 统计截图尺寸与像素分布，用来证明截图不是空白帧；tools/organize-docs.mjs 是 2026-09-14 文档整理的一次性脚本，整理完不再执行。tools/push.cmd 是受控推送脚本（`tools\push.cmd` 推 main，可带分支名与 `--pause`），只做提交推送、不参与构建。

`tools/screenshot.mjs` 走 CDP 而不是 `msedge --screenshot`：后者只截首帧，而游戏开在主页遮罩上，裸 flag 永远拍不到棋盘。该脚本先点掉主页、再截图，并收集 `window.onerror` / `unhandledrejection` —— 本轮就是靠它在一次运行里抓到一处改名遗漏导致的整盘空白。它同时把两个已知陷阱固化在代码里：headless 的布局视口有约 500px 最小宽度（竖屏只能用 500×1082），以及刚退出的 Edge 会短暂占住调试端口与 profile 锁（每次抓图独立端口 + 独立 `%TEMP%` user-data-dir）。

产物目录：artifacts/visual/ 存实机截图（`npm run shot` 输出），artifacts/ 整体不入库。

`tools/swipe-probe.mjs`（v0.8.1）测的是看不见的东西：一次手势到底把立方体往哪边转了。它用 CDP 的 `Input.dispatchMouseEvent` 在左右侧带与六面体范围内各滑一次，前后读 `__voxalblast.rotation()`，并把**网格姿态的旋转** `world = base1 * inverse(base0)` 解成轴角——这是与相机无关、与起手姿态无关的那个量，三条断言（左带 `+Z`、右带 `-Z`、范围内 `+X`）就是"跟手"的可执行定义。坑：用**姿态差** `inverse(pose0) * pose1` 会被当前网格姿态共轭，只有立方体未旋转时才等于世界轴——探针第一版因此在起点带 180° 滚转时把俯仰行的符号读反了，现在两个量都输出，姿态差只作对照。它需要一个在 5173 上的 dev server，脚本会自己起一个并故意留着（下次运行直接复用）。

main.js 保留 __voxalblast 只读观察接口和开发构建专用验证入口；它们是调试设施，不是游戏对外 API。检查接口实际定义后再使用，不依赖历史稿的旧探针结构。

[部署事实](NETLIFY_DEPLOYMENT_BASELINE.md) · [当前回归清单](../Planning/04-MVP验收清单.md)

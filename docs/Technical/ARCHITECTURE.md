# 技术结构与开发入口

> 渲染章节同步至 v0.8.5 / 2026-09-17，依据仓库文件核对；非运行性能报告。

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
| src/rendering/woodTexture.js | 原木 / 彩漆各三组确定性域扭曲云纹，独立 `map`、`bumpMap`、`roughnessMap`；UI 另用固定种子的 CSS 木纹 data URL |
| src/rendering/pastoralBackdrop.js | 加载随项目发布的田园 WebP；加载前/失败时保留程序 SVG，位于游戏画布之后的装饰层 |
| public/art/ | 背景 WebP 与来源、提示词、尺寸说明 |
| src/rendering/swipe.js / keyboard.js | 手势定轴（竖滑的侧带划分与自转的带符号）与键盘映射 |
| src/rendering/threeCompat.js | three.quarks / postprocessing 与 Three.js 的兼容桥，须先于粒子导入 |
| src/ui/icons.js | 代码生成的入口与道具 SVG 图标 |
| src/styles.css / toy.css | 历史布局兼容 / 当前视觉覆盖 |
| src/platform/crazygames.js | 可选平台 SDK 包装和降级路径 |

## 渲染与生命周期

Vite + 原生 ES modules，未使用 React 等 UI 框架。Three.js 主场景采用透视相机、圆角几何、阴影与程序环境反射；postprocessing 组织渲染、法线/深度、SSAO、Bloom、ACES、SMAA；three.quarks 批量处理粒子。v0.8.5 材质实现对照用户于 2026-09-17 指定的暖木彩漆参考图，未改变棋盘规则。

棋盘逻辑保持 5×5×5 外壳的 98 个唯一格，六面合计 150 个表面格。`buildFaceTiles()` 按晶格坐标去重，只创建 98 个 mesh；棱/角 mesh 的 `userData.faces` 同时记录相邻两面/三面，Three.js 场景树仍只有一个父 group。当前面提亮检查这一归属列表，放置按 cell 换材质，不再在每面叠放同一实体。棋盘、候选与拖拽共用 `RoundedBoxGeometry(0.94, 0.94, 0.94, 3, 0.085)`；`hullInset = 0.68` 指背板总边长减少量，背板为 4.32³，单侧缩进 0.34，不能当作单侧 0.68 使用。

`blockSurfaceMaps(painted, variant)` 为原木和彩漆各缓存三组 256×256 域扭曲云纹，将色彩、高度、粗糙度分开生成；`map` 为 sRGB，`bumpMap` 与 `roughnessMap` 保持数据色彩空间。纹理不烘焙方向光。原木基色/当前面基色为 `#E4A16D / #E7A773`，另按晶格坐标取确定性色调和变体。方块均用 `MeshPhysicalMaterial`：原木的 `roughness / clearcoat / clearcoatRoughness / bumpScale` 为 `0.46 / 0.38 / 0.3 / 0.022`，彩漆为 `0.31 / 0.85 / 0.17 / 0.011`；粗糙度图调制基础 roughness。背板和 UI 保留各自的纹理入口。

`toyLights.js` 生成共享的 256×128 HalfFloat 线性 HDR 等距柱状环境纹理，由各 WebGLRenderer 的 PMREM 分别处理，不跨 WebGL context 复用 GPU render target。`environmentIntensity = 0.7`；主反射光箱强度/集中指数为 `12 / 48`，轮廓反射光箱为 `4 / 32`，方向与各自直接光一致。主 renderer 使用 `NoToneMapping`，composer 使用 HalfFloat 缓冲，并在最终效果链执行一次 `ACES_FILMIC`；候选与主页直接使用 renderer 的 `ACESFilmicToneMapping`，曝光统一取 `BOARD_STYLE.exposure = 1`。

主画布 pass 顺序为 `RenderPass → NormalPass → EffectPass(SSAO) → EffectPass(Bloom, ACES, SMAA)`。`NormalPass.renderTarget` 自持一个独立 `DepthTexture`（`UnsignedIntType`），先绘制本帧法线与深度，再由 `occlusionPass.setDepthTexture(contactDepth)` 提供给 AO；这是真实场景深度，不是占位纹理，也不需要 composer 的 stable-depth blit。AO 为暖褐 `#60422E`，主要参数 `radius 0.075 / intensity 1.65 / bias 0.012 / fade 0.018`，世界接近阈值/衰减 `0.35 / 0.45`，亮度影响 0.15。桌面采样/圈数/分辨率比例 `16 / 3 / 0.75`，移动或低性能档 `11 / 3 / 0.5`；采样数不取圈数的整倍数。主 composer 保留桌面 4× MSAA，低性能档为 0。

依赖实测版本：three 0.172.0、three.quarks 0.10.18、postprocessing 6.39.4、vite 6.4.3（package.json 里是 ^ 范围）。`src/rendering/threeCompat.js` 是引擎兼容桥，装两件事：

1. **quarks `updateRange`**：three r159 起用 `updateRanges`/`addUpdateRange()` 取代 `BufferAttribute.updateRange` 并在 r172 移除旧字段，而 quarks 0.10.18 仍写旧字段，缺桥时第一次消除或道具爆发就在 `animate()` 内抛错，画面冻结而逻辑继续。它必须在粒子导入之前执行；升级 three.quarks 到 0.17.x 后删除该桥并重跑 04 的停摆回归项。同一处坑还有 `emissionBursts[].count`：必须是 ValueGenerator（`new ConstantValue(n)`），传裸数字同样会抛错。
2. **postprocessing 深度纹理**：`SMAAEffect` 声明 `EffectAttribute.DEPTH`，但当前 COLOR 检边且 predication 关闭的配置不采样深度。composer 若应请求创建 stable depth，会通过 `DepthTexture.clone()` 与输入深度共享 `texture.source`；three r172 因而复用同一 GPU 深度图，blit 时触发 `Read and write depth stencil attachments cannot be the same image`。`skipComposerDepthBlit(effectPass)` 仅在最终 Bloom/ACES/SMAA pass 的 `addPass()` 之前设置占位深度，避免无用申请。**它不用于 SSAO：AO pass 在加入 composer 前绑定上述 NormalPass 的独立真实深度。** 两个 pass 均已有各自的深度来源，composer 不创建别名 stable target；无需为此关闭 HDR 或 MSAA。postprocessing 修复克隆深度别名后再评估删除兼容桥，新增真正读深度的效果必须绑定有效的场景深度。

三个候选各有透明 WebGLRenderer 与正交相机，主页另有静态按需渲染器。主页打开时主动画循环跳过场景绘制。质量档位初始化时选择，像素比/后处理/粒子与阴影作相应降级；不宣称已有运行时 FPS 自适应。

背景从 `${import.meta.env.BASE_URL}art/pastoral-valley.webp` 加载，使用 `object-fit: cover` 中心裁切；成功后才隐藏原 SVG，失败时移除图片并保留 SVG。背景为 `aria-hidden`、不接收指针的独立 DOM 层，天空底色留在 `html`、`body` 透明。资产为随构建发布的本地 WebP，不依赖在线生图服务；尺寸和来源见 [资产说明](../../public/art/README.md)。

主画布由 ResizeObserver 追踪容器尺寸。resize 先更新 renderer 尺寸及相机 FOV/aspect/投影、重新取景，再调用 `composer.setSize()`，保证 SSAO 缓存的是新投影矩阵及其逆矩阵。NormalPass 的 render target 随 composer 调整尺寸，Three.js 在绑定时同步其独立深度纹理尺寸，无需替换 `contactDepth`。棋盘姿态采用四元数基准与展示偏摆；鼠标/触摸的面坐标通过投影换算，不从屏幕像素直接改规则格子。

## 存档边界

- voxalblast.records.v1：已结束局纪录、周最佳和最近十局。
- voxalblast.session.v1：棋盘、分数、三候选、道具、局内荣誉/链和姿态。
- voxalblast-sound / voxalblast-haptics：独立声音/触感偏好。

records/session 有数据校验及存储失败后的内存降级；偏好的直接 localStorage 读取不在这一降级封装内，限制见 [待办](KNOWN_GAPS.md)。存档不等于云存档。

## 开发和检查

npm run dev 启动开发；npm test 执行 tools/rule-tests.mjs（v0.5.0 时为 216/216，v0.8.1 起 236/236，新增 swipe 组）；npm run build 生成 dist；npm run preview 检查正式产物；npm run shot 走无头 Edge 抓桌面+移动端实机截图；npm run probe:swipe 在无头 Edge 里走完三个手势并断言其世界轴方向；npm run reachability 运行较长的可达性分析，默认写出 tools/reachability-baseline.json（v0.3 样本保存在 tools/reachability-v0.3.json）；v0.8.2 起它还能在不改任何玩法代码的前提下试参数——`--pool=` 取形状子集（重名＝加权）、`--batch=` 改手牌大小、`--faces=` 换晶格尺寸（按 board.js 同一批公式重建，并在 5×5 时逐格比对，防止模拟一个游戏里没有的棋盘）、`--rng=` / `--seed=` 换随机源，输出里带本次实际使用的 lattice / pool / batch / rng / seed 与 `endedNaturallyPct`、`stepsWhenEnded`（撞 600 手上限＝没结束）。结果样本存 tools/reachability-pool-matrix.json 与 tools/reachability-lattice-matrix.json，结论与判读边界见 [难度与单局长度测量](DIFFICULTY_BASELINE.md)。注意默认随机源仍是老的 31 位 LCG：它会把整局按种子聚簇（同一配置不同种子可差 20pp），**结论性数字要用 `--rng=mulberry32` 加多种子**。

测量专用的 A/B/C/D 实验使用 `node tools/difficulty-abcd.mjs --games=200 --seeds=1,2,3 --strategies=noise --out=tools/results/difficulty-abcd.json`，独立于旧 reachability 命令。`tools/difficulty-model.mjs` 调用正式 `Board.seedOpening` 生成对照开局，在 Node 内使用四字位集加速结算；结构化开局与阶段发牌只存在于 tools，正式游戏不导入。`node tools/difficulty-tests.mjs` 验证与真实 Board 的差分一致性、随机流隔离、开局验证路径、阶段边界及右删失统计。JSON保存逐局记录、配对比较、源码SHA256和生存曲线，同时输出无需服务器即可打开的HTML图表。具体算法、样本量、局长判读和局限见 [A/B/C/D实验报告](DIFFICULTY_ABCD.md)。

同一支工具也能扫候选池与开局密度：`--arms=<池>/<uniform|staged>[/<开局>]`（例如 `--arms=e/staged,current/uniform/max --games=300 --seeds=1,2,3`）把因子拆开对照——只差一个因子的臂之间才做配对，因此同池不同发牌、同发牌不同池、同池同发牌不同开局分别给出独立的差值。每次运行还会输出**紧张度面板**：每步记录手上还有几种不同形状放得下、以及这些形状的合法物理落点总数，逐局汇总成"三块全可放占比""三块里只有一块放得下占比""本局最紧时刻""可选≤19格步数占比"。面板必须按手牌构成分层——每批最后一块天然只剩一种形状，不分层就会稳定报出 ~33% 的假"被迫落子"。池定义写在 `difficulty-model.mjs` 的 `POOL_SPECS`（相对权重；池 id 拼错即报错，不会静默退回正式池）：`current` 逐值等于正式十种等权重，`c`/`d`/`w90`/`e`/`e5` 是压缩候选。开局定义写在同一文件的 `OPENING_SPECS`：`current` 逐值等于正式 `config.js` 的 `OPENING_LAYOUT`（+z/+y/+x = 7/3/3），`empty` 复现 v0.2.31 之前的空棋盘，`mid`/`high`/`max` 是加重档（每面最多 16 格——17 格必然凑满一线，正式生成器会拒绝）。等概率臂按权重累计表抽取；阶段臂把阶段权重在"该池仍有成员的组"上**重新归一化**，所以池里没有小件时不会留下 20% 的空组配额。两种臂每槽都恰好消耗两个随机数，配对随机流因此保持对齐。`--groups` 与 `--arms` 互斥，前者仍是最早的四组。结论与局限见 [候选池测量](DIFFICULTY_POOL.md)、[开局密度测量](DIFFICULTY_OPENING.md) 与 [紧张度测量](DIFFICULTY_TENSION.md)。

不在 npm scripts 里、需要直接 node 运行的脚本：tools/tier-calibration.mjs 把分数样本换算成阶位切点；tools/png-stats.mjs 统计截图尺寸与像素分布，用来证明截图不是空白帧；tools/organize-docs.mjs 是 2026-09-14 文档整理的一次性脚本，整理完不再执行。tools/push.cmd 是受控推送脚本（`tools\push.cmd` 推 main，可带分支名与 `--pause`），只做提交推送、不参与构建。

`tools/screenshot.mjs` 走 CDP 而不是 `msedge --screenshot`：后者只截首帧，而游戏开在主页遮罩上，裸 flag 永远拍不到棋盘。该脚本先点掉主页、再截图，并收集 `window.onerror` / `unhandledrejection` —— 本轮就是靠它在一次运行里抓到一处改名遗漏导致的整盘空白。它同时把两个已知陷阱固化在代码里：headless 的布局视口有约 500px 最小宽度（竖屏只能用 500×1082），以及刚退出的 Edge 会短暂占住调试端口与 profile 锁（每次抓图独立端口 + 独立 `%TEMP%` user-data-dir）。

产物目录：artifacts/visual/ 存实机截图（`npm run shot` 输出），artifacts/ 整体不入库。

`tools/swipe-probe.mjs`（v0.8.1）测的是看不见的东西：一次手势到底把立方体往哪边转了。它用 CDP 的 `Input.dispatchMouseEvent` 在左右侧带与六面体范围内各滑一次，前后读 `__voxalblast.rotation()`，并把**网格姿态的旋转** `world = base1 * inverse(base0)` 解成轴角——这是与相机无关、与起手姿态无关的那个量，三条断言（左带 `+Z`、右带 `-Z`、范围内 `+X`）就是"跟手"的可执行定义。坑：用**姿态差** `inverse(pose0) * pose1` 会被当前网格姿态共轭，只有立方体未旋转时才等于世界轴——探针第一版因此在起点带 180° 滚转时把俯仰行的符号读反了，现在两个量都输出，姿态差只作对照。它需要一个在 5173 上的 dev server，脚本会自己起一个并故意留着（下次运行直接复用）。

main.js 保留 __voxalblast 只读观察接口和开发构建专用验证入口；它们是调试设施，不是游戏对外 API。检查接口实际定义后再使用，不依赖历史稿的旧探针结构。

[部署事实](NETLIFY_DEPLOYMENT_BASELINE.md) · [当前回归清单](../Planning/04-MVP验收清单.md)

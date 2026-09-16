# 技术结构与开发入口

> v0.7.0，依据仓库文件核对；非运行性能报告。

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
| src/rendering/toyLights.js | 主场景、候选与主页共用灯光 |
| src/rendering/woodTexture.js | 程序化木纹：一张固定种子的 Canvas 纹理，同时供 3D 的 `map` 与 UI 的 CSS data URL |
| src/rendering/pastoralBackdrop.js | 程序化田园背景：启动时拼出的内联 SVG，插在画布之后的 `.pastoral-backdrop` 层 |
| src/rendering/swipe.js / keyboard.js | 手势定轴与键盘映射 |
| src/rendering/threeCompat.js | three.quarks 与 Three.js 兼容处理，需先于粒子导入 |
| src/ui/icons.js | 代码生成的入口与道具 SVG 图标 |
| src/styles.css / toy.css | 历史布局兼容 / 当前视觉覆盖 |
| src/platform/crazygames.js | 可选平台 SDK 包装和降级路径 |

## 渲染与生命周期

Vite + 原生 ES modules，未使用 React 等 UI 框架。Three.js 主场景采用透视相机、圆角几何、阴影、ACES；postprocessing 组织渲染、Bloom、SMAA；three.quarks 批量处理粒子。

依赖实测版本：three 0.172.0、three.quarks 0.10.18、postprocessing 6.39.4、vite 6.4.3（package.json 里是 ^ 范围）。`src/rendering/threeCompat.js` 是引擎兼容桥：three r159 起用 `updateRanges`/`addUpdateRange()` 取代 `BufferAttribute.updateRange` 并在 r172 移除旧字段，而 quarks 0.10.18 仍写旧字段，缺桥时第一次消除或道具爆发就在 `animate()` 内抛错，画面冻结而逻辑继续。它必须在粒子导入之前执行；升级 three.quarks 到 0.17.x 后删除该桥并重跑 04 的停摆回归项。同一处坑还有 `emissionBursts[].count`：必须是 ValueGenerator（`new ConstantValue(n)`），传裸数字同样会抛错。

三个候选各有透明 WebGLRenderer 与正交相机，主页另有静态按需渲染器。主页打开时主动画循环跳过场景绘制。质量档位初始化时选择，像素比/后处理/粒子与阴影作相应降级；不宣称已有运行时 FPS 自适应。

主画布由 ResizeObserver 追踪容器尺寸。棋盘姿态采用四元数基准与展示偏摆；鼠标/触摸的面坐标通过投影换算，不从屏幕像素直接改规则格子。

## 存档边界

- voxalblast.records.v1：已结束局纪录、周最佳和最近十局。
- voxalblast.session.v1：棋盘、分数、三候选、道具、局内荣誉/链和姿态。
- voxalblast-sound / voxalblast-haptics：独立声音/触感偏好。

records/session 有数据校验及存储失败后的内存降级；偏好的直接 localStorage 读取不在这一降级封装内，限制见 [待办](KNOWN_GAPS.md)。存档不等于云存档。

## 开发和检查

npm run dev 启动开发；npm test 执行 tools/rule-tests.mjs（2026-09-14 复核为 216/216）；npm run build 生成 dist；npm run preview 检查正式产物；npm run shot 走无头 Edge 抓桌面+移动端实机截图；npm run reachability 运行较长的可达性分析，默认写出 tools/reachability-baseline.json（v0.3 样本保存在 tools/reachability-v0.3.json）。

不在 npm scripts 里、需要直接 node 运行的脚本：tools/tier-calibration.mjs 把分数样本换算成阶位切点；tools/png-stats.mjs 统计截图尺寸与像素分布，用来证明截图不是空白帧；tools/organize-docs.mjs 是 2026-09-14 文档整理的一次性脚本，整理完不再执行。tools/push.cmd 是受控推送脚本（`tools\push.cmd` 推 main，可带分支名与 `--pause`），只做提交推送、不参与构建。

`tools/screenshot.mjs` 走 CDP 而不是 `msedge --screenshot`：后者只截首帧，而游戏开在主页遮罩上，裸 flag 永远拍不到棋盘。该脚本先点掉主页、再截图，并收集 `window.onerror` / `unhandledrejection` —— 本轮就是靠它在一次运行里抓到一处改名遗漏导致的整盘空白。它同时把两个已知陷阱固化在代码里：headless 的布局视口有约 500px 最小宽度（竖屏只能用 500×1082），以及刚退出的 Edge 会短暂占住调试端口与 profile 锁（每次抓图独立端口 + 独立 `%TEMP%` user-data-dir）。

产物目录：artifacts/visual/ 存实机截图（`npm run shot` 输出），artifacts/ 整体不入库。

main.js 保留 __voxalblast 只读观察接口和开发构建专用验证入口；它们是调试设施，不是游戏对外 API。检查接口实际定义后再使用，不依赖历史稿的旧探针结构。

[部署事实](NETLIFY_DEPLOYMENT_BASELINE.md) · [当前回归清单](../Planning/04-MVP验收清单.md)

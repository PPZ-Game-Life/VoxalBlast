# VoxalBlast

六面贴块消除小游戏。Vite + 原生 JavaScript + Three.js。积木使用实时 3D 几何、程序材质和灯光；UI 与图标由 CSS / SVG 绘制，田园布景使用随项目发布的 AI 绘制 WebP，加载前或失败时回退到程序 SVG。

```sh
npm install
npm run dev        # 开发服务器
npm test           # 规则层自测（tools/rule-tests.mjs）
npm run build      # 生产构建
npm run preview    # 预览产物
npm run shot       # 桌面 + 移动端实机截图（需先跑 dev）
npm run probe:swipe # 手势方向实机断言：左右侧带自转是否跟手（需先跑 dev）
```

当前版本 **0.8.3**：仍然是测量工具与文档——`tools/reachability.mjs` 新增 `--faces=`（换晶格尺寸）、`--seed=` / `--rng=mulberry32`（换随机源）与 `stepsWhenEnded` 指标，并据此复核了"缩小棋盘能不能加大难度"：**不能**，4×4（56 格）在同一套 4 格池下自然结束率 19.5%，低于现行 5×5 的 28.3%。同时修正了 v0.8.2 的随机源偏差（旧 LCG 按种子把整局聚簇，E 池的数字从 42.3% 修正为 28.3%）。矩阵与判读见 [难度与单局长度测量](docs/Technical/DIFFICULTY_BASELINE.md)。玩法、数值、画面与存档与 v0.8.2 相同。

2026-09-17 在同一工作树补了第二轮测量：新工具 `tools/difficulty-abcd.mjs` 做结构化开局 × 阶段发牌的 2×2 对照（2400 局 noise＋600 局 space）。结论是**阶段发牌**把弱机器人的自然结束率从 1.0% 抬到 12.5%（S(300) 100%→95.8%），**结构化开局**在本设置下没有分辨力（94.5% 的基线盘面本来就合格，配对差恒为 0），换成更强策略后阶段发牌的差异又归零——距"中位 60–120 步"的目标仍很远。报告见 [结构化开局 × 阶段发牌 A/B/C/D](docs/Technical/DIFFICULTY_ABCD.md)。本轮只加测量工具与文档，**未改玩法、未升版本号**。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/game/` | 规则层（棋盘、形状、计分、荣誉、排行、存档），不依赖渲染 |
| `src/rendering/` | 渲染与输入。`config.js` 是全部视觉/手感参数的单一真源 |
| `src/platform/` | CrazyGames SDK 适配（无 SDK 时自动降级） |
| `src/ui/` | 代码生成的矢量图标 |
| `src/main.js` | 场景装配、拖拽落子、旋转选面、HUD 联动 |
| `src/styles.css` | 布局与历史兼容 |
| `src/toy.css` | **当前视觉权威**（木质田园材质覆盖与文件末尾的桌面尺寸规则） |
| `public/art/` | 随构建发布的田园 WebP；`README.md` 记录生成来源、提示词与尺寸 |
| `tools/` | 开发脚本：规则自测、可达性、难度测量（`difficulty-*`）、截图、手势方向探针、PNG 统计、推送 |
| `docs/Planning/` | 01 立项 / 02 规则 / 03 交互 / 04 验收 / 05 美术 / 06 宣传 / 07 道具 / 08 荣誉 |
| `docs/Technical/` | 架构、已知缺口、部署基线 |
| `docs/Archive/` | 历次方向的历史版本 |
| `artifacts/` | 临时产物（不入库）：实机截图、一次性探针 |

## 关键约定

- **视觉改版先读 [05 美术方向与视觉规范](docs/Planning/05-美术方向与视觉规范.md)**，它写明现行几何、材质、光照、资产边界和历史模型的问题。
- 任何规则/数值/美术口径变更，须同步 `docs/Planning/01~08` 的对应条目与各自 `> 版本：` 行，并同步 `package.json` / `package-lock.json` 的 `version`。
- 视觉参数一律进 `src/rendering/config.js`，不在 `main.js` 散落魔法数字。
- 每批改动验证：`npm test` + `npm run build` + `npm run shot`；动了手势/方向再加 `npm run probe:swipe`（实机断言三个手势的世界轴方向）。
- 本轮验证记录：[v0.8.1 侧带自转方向修复验收](docs/Planning/04-MVP验收清单.md)；v0.8.0 渲染品质改版记录保留在 [04](docs/Planning/04-MVP验收清单.md)，旧版记录不代替本轮验证。
- 难度与单局长度：动候选池、棋盘尺寸或手牌大小之前先看 [v0.8.3 复核](docs/Technical/DIFFICULTY_BASELINE.md)（`npm run reachability` 加 `--pool=` / `--batch=` / `--faces=` / `--rng=` 可自行复现；结论性数字要用 `--rng=mulberry32` 加多种子）。
- 开局与发牌：讨论"结构化开局""阶段发牌""有限步数模式"之前先看 [A/B/C/D 测量](docs/Technical/DIFFICULTY_ABCD.md)，用 `node tools/difficulty-abcd.mjs`（参数拼错即报错，不给默认值兜底）复现；该实验只跑 tools，正式游戏不导入。

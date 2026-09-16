# VoxalBlast

六面贴块消除小游戏。Vite + 原生 JavaScript + Three.js。**运行时美术零外部素材**：木头、田园背景、UI、图标、粒子、光影全部由参数化几何、CSS、Canvas 动态纹理、代码生成内联 SVG 与 Shader 在启动时画出来。

```sh
npm install
npm run dev        # 开发服务器
npm test           # 规则层自测（tools/rule-tests.mjs）
npm run build      # 生产构建
npm run preview    # 预览产物
npm run shot       # 桌面 + 移动端实机截图（需先跑 dev）
```

当前版本 **0.7.4**：「木质田园」——5×5×5 棋盘由 150 个等大木方块拼成，田园草坡背景，木质 HUD。规则、计分与存档格式自 v0.5.0 起未变。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/game/` | 规则层（棋盘、形状、计分、荣誉、排行、存档），不依赖渲染 |
| `src/rendering/` | 渲染与输入。`config.js` 是全部视觉/手感参数的单一真源 |
| `src/platform/` | CrazyGames SDK 适配（无 SDK 时自动降级） |
| `src/ui/` | 代码生成的矢量图标 |
| `src/main.js` | 场景装配、拖拽落子、旋转选面、HUD 联动 |
| `src/styles.css` | 布局与历史兼容 |
| `src/toy.css` | **当前视觉权威**（木质田园在文件末尾的 v0.7 段） |
| `tools/` | 开发脚本：规则自测、可达性、截图、PNG 统计、推送 |
| `docs/Planning/` | 01 立项 / 02 规则 / 03 交互 / 04 验收 / 05 美术 / 06 宣传 / 07 道具 / 08 荣誉 |
| `docs/Technical/` | 架构、已知缺口、部署基线 |
| `docs/Archive/` | 历次方向的历史版本 |
| `artifacts/` | 临时产物（不入库）：实机截图、一次性探针 |

## 关键约定

- **视觉改版先读 [05 美术方向与视觉规范](docs/Planning/05-美术方向与视觉规范.md)**，它写明了现行参数、以及三种已被淘汰的方块模型（别再走回去）。
- 任何规则/数值/美术口径变更，须同步 `docs/Planning/01~08` 的对应条目与各自 `> 版本：` 行，并同步 `package.json` / `package-lock.json` 的 `version`。
- 视觉参数一律进 `src/rendering/config.js`，不在 `main.js` 散落魔法数字。
- 每批改动验证：`npm test` + `npm run build` + `npm run shot`。
- 本轮验证记录：[v0.7.0 ~ v0.7.3 美术改版验收](docs/Planning/04-MVP验收清单.md)。

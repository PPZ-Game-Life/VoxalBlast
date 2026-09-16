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

当前版本 **0.8.1**：在 v0.8.0「木质田园」品质升级之上修一处手势方向——左右侧带的上下滑动自转现在都跟手（右侧带下滑顺时针、左侧带下滑逆时针），此前两带共用一个方向符号，左侧带是反的。规则、计分、存档与画面与 v0.8.0 相同。

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
| `tools/` | 开发脚本：规则自测、可达性、截图、手势方向探针、PNG 统计、推送 |
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

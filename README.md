# VoxalBlast

六面贴块消除小游戏。Vite + 原生 JavaScript + Three.js，运行时美术由几何、CSS、SVG 和粒子程序化生成。

```sh
npm install
npm run dev
npm test
npm run build
npm run preview
```

当前版本 **0.5.0**：实体六面拼板、统一塑料积木光照、同源 3D 主页、厚底控件与原创矢量图标。规则、计分和存档格式未变。

- 规则入口：`src/game/board.js`、`src/game/scoring.js`
- 渲染与输入：`src/main.js`、`src/rendering/`
- UI：`index.html`、`src/styles.css`（布局与兼容）、`src/toy.css`（当前视觉）、`src/ui/icons.js`
- 当前美术裁决：[美术方向与视觉规范](docs/Planning/05-美术方向与视觉规范.md)
- 本轮验证：[v0.5.0 视觉升级验收](docs/Technical/VISUAL_REFRESH_050.md)

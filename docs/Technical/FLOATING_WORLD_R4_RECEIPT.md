# R4 回执：浮空积木世界实景层（v0.13.0）

> **作者：Jeffy（R4 写入者）｜状态：代码已实装并在真机视口跑通，留在工作树未提交。**
> 未提交的原因与 R3 同源：**同一棵工作树上有第二个写入者**。裁决请求见 §5，R3 侧的对应文档是
> [R3 接入契约与回执](FLOATING_WORLD_R3_INTEGRATION.md)（作者：另一个 Jeffy 会话，commit `eb3fe4e`）。

上游规格：[浮空积木世界：v0.13.0 视觉偏差纠正交接单](FLOATING_WORLD_VISUAL_CORRECTION_HANDOFF.md) §4 / §6.4 / §7.2。
视觉基准：`docs/Art/floating-world-v1/approved-concept-v4.png`。

---

## 1. 这一轮改了什么

旧田园插画（`valley-portrait/landscape.webp` + 树/房/柯基 SVG 的 DOM 层）**不再安装**，
背景换成场景图里的实时受光几何。

| 文件 | 改动 |
| --- | --- |
| `src/rendering/floatingWorldScene.js` | **新增**。`createFloatingWorld({ scene, quality, getCamera, getCanvasRect, getKeepOutRects, getBoardScreenBox })`；sky 渐变球 / plaza 广场板 / 12 个 InstancedMesh 装饰（3 中景 prefab + 2 墙段 + 2 前景体 + 3 散块）/ 6 云 Sprite / 主盘艺术软投影；只挂 layer 2 |
| `public/art/floating-world-v1/scene.recipe.json` | 新增 `world` 块（`sky` / `plaza` / `boardShadow` / `bands` / `clouds` / `walls` / `foreground`），并把 `layout.gameplay` 的三个 prefab 刻度按 V4 重新标定 |
| `src/main.js` | 删掉 `installPastoralBackdrop(appEl)`；创建 floatingWorld（位置在 `boardView` **之后**，见 §4.1）；帧循环注入 `floatingWorld.update(raw)`（在 home 早退之前）；`onSceneResize` 接到 gameScene 的 resize 末尾 |
| `src/rendering/gameScene.js` | 新增 `onResize` 回调钩子与 `getCanvasRect()`；`updateRenderCamera()` 里补 `camera.updateMatrixWorld()`（见 §3.2） |
| `src/diagnostics.js` | `rendering().world` = 背景实况（sky/plaza/装饰数/云贴图数/被剔除数/地平线落点） |

---

## 2. 三层与构图

按「anchor = 整幅 viewport 的 NDC」解析，**用 renderCamera**（不是 canonical）——两者相差一个嵌入变换，
用错相机时所有画面外装饰都会被挤到别处。

| 层次 | 实装 | 关键量 |
| --- | --- | --- |
| 远 | 渐变蓝天球（`radius 300`，BackSide，`depthTest:false`、`renderOrder -1000`）+ 3 种云贴图 / 6 个 Sprite | `palette.skyTop → skyBottom` 由 shader 按 camera 相对方向插值 |
| 中 | `floating-arch / stairs / ledge` 复用配方 `cells` 实例化 + 2 段墙 | `bands.mid = 1.02 ×` 主盘距离 |
| 近 | 奶油广场板（`cornerRadius` 圆角、2.2 世界单位铺装格）+ 2 块被画框裁切的大积木 | `bands.near = 0.92`，`zNear` 由 `-1.4 NDC` 反解 |

**地平线不是写死的世界坐标，而是反解出来的屏线。** 相机俯角约 12°、离地仅约 16 世界单位，
地面若无限延伸会盖满整幅画面，远层天空一分不剩；所以广场远边由 `plaza.horizonNdc` 定义，
`layout()` 用 renderCamera 的射线与该平面求交反解出 `zFar`。实测 `edgeFromTop = 0.390` 对
`requestedNdc = 0.22`，往返误差 < 1e-6。

广场板还要**随相机方位角偏航**：`cameraDirection` 与 z 轴差 26°，若广场与世界轴对齐，
远边不平行于像面，地平线会明显一边高一边低。`alignPlaza()` 把板的局部 +z 对到相机的地面方位。

---

## 3. 本轮修掉的三个真 bug（都不是"调参"）

### 3.1 `ExtrudeGeometry` 顶面在 local y = depth
板体旋转后挤出方向映射到 +y，顶面因此比 mesh 原点高一个 `thickness`。原写法把 mesh 放在
`floorY` 上，等于把地面抬高了 1.2 单位——软投影被埋进板体里，且画面上**没有任何线索**能看出
地面高了。改为 `plaza.position.y = floorY - thickness`。

### 3.2 `renderCamera.matrixWorld` 比 canonical 相机滞后一帧
`camera.position` / `lookAt()` 只改 position 与 quaternion；`matrixWorld` 是在 `renderer.render()`
里重算的，而 `updateRenderCamera()` 在它之前跑。于是 `renderCamera.matrixWorld` 永远复制到
**上一帧**的位姿。R3 阶段没有任何东西依赖它；R4 一旦用 renderCamera 打地面射线，就拿到一个
落在眼睛后面的交点（z ≈ +86，屏幕外）。修法：复制前先 `camera.updateMatrixWorld()`。

### 3.3 共享 scratch 向量被覆盖
`visibleHeightAt()` 内部会走两次 `_point`。软投影先算好射线方向存在 `_point`，再调
`visibleHeightAt()` 求世界每像素，回头读 `_point` 时读到的已经是**另一个 NDC 角点**的方向。
所有上报数字仍然自洽（往返检验照样 PASS），只有画面是错的。改用专用 `_shadowDir`。

> 三个都是"门禁全绿、画面不对"的类型，也都只有靠**实际画面**才能发现——这正是纠偏交接 §9.3
> 「所有探针绿了但画面仍像本次截图，依然不通过美术验收」的实例。

---

## 4. 已知缺口（没有假装解决）

1. **`needsUpdate` 的开关未接**：R3 的 `tools/screenshot.mjs` 门禁要求「blob 与 projected 恰有其一可见」，
   而 §6.4 允许的艺术软投影是**第三种**机制。目前低档（所有手机宽度）下 blob 是 ShadowMaterial、
   没有阴影贴图时根本不落笔，所以画面上只有艺术软投影；但高档下真实接收面会与它**同时存在**。
   §6.4「一时只开启一种主盘投影」需要在 R3 的门禁与 `boardShadows` 之间做一次所有权交接，
   涉及另一个写入者的文件，本轮未动，未验证。
2. **quality 档位只影响 dpr/阴影/AO，不影响装饰数量**：配方 `quality.low` 写的是 1 组/1 散块/3 云，
   但 `getRenderQuality()` 的 `lowPower` 是按宽度（≤700px）判的——**所有手机都会落到 low**，
   照它裁就会把 C1 要验收的那个视口本身裁空。因此装饰数量按美术稿固定为 3/3/6（122 格），
   降级仍作用在 dpr / 阴影 / SSAO 上。这是一个**有意识的偏离**，需要制作人确认。
3. **`import` 自 `public/`** 的 Vite 警告由 R3 文档 §4.2 记录，仍未处理。
4. **没有物理手机 / 微信内嵌实测**；本轮读数全部来自本机无头浏览器 390×844。
5. **`#scene-wrap` 的 `overflow:hidden` 是否裁剪 fixed canvas** 仍是 R3 §4.3 记录的规范依赖项。

---

## 5. 归属与并发（与 R3 同一件事，补上 R4 这一侧）

**事实**：R4 写入者（本会话）与 R3 写入者是**两个并行会话**，共用 `E:\WorkSpace\MiniGame\VoxalBlast`。
时间线（本机时钟）：

| 时刻 | 事件 |
| --- | --- |
| 10:07–10:11 | R3 侧落盘 `gameScene.js` / `main.js` / `diagnostics.js` / `reference.css` / 两个 tools |
| 10:13–10:27 | R3 侧跑验证批（npm test + build + 5 探针）；本会话此时只做只读 C0 |
| 10:35–10:38 | **R4 侧落盘** `floatingWorldScene.js` / recipe / main / diagnostics / gameScene |
| 10:41–10:46 | R3 侧在 `artifacts/visual-r3-merged` 拍图后提交 `eb3fe4e`（R3 契约与裁决请求）、`a79d266`（美术包前哨检查） |
| 10:48 起 | R3 侧转入 **R5（index.html / UI 换图）**，`index.html` 连续落盘 |

**当前混在一起的文件**：`main.js`、`gameScene.js`、`diagnostics.js` —— R3 的整屏画布/投影嵌入 +
R4 的实景层在同一个未提交 diff 里。`src/rendering/floatingWorldScene.js` 仍是未跟踪新文件。

**为什么不提交**：与 R3 侧同一理由——整批提交会把别人的在飞工作扫进本方署名；拆开提交会做出
「import 了一个没进提交的模块」这类坏中间态。所以本轮同样只落**纯新增、不可能冲突**的文件（本文）。

**给制作人的裁决选项**（两票独立提出同一件事，说明它确实卡住了）：

- **A｜单一写入者**：指定一方把 R3+R4 各自收尾并接连提交，另一方停在只读。风险最低。
- **B｜合成一个提交**：由一方一次落 R3+R4，message 里分段署名（R3 归实用契约、R4 归本文）。
- **C｜按文件划边界**：R3 侧独占 `index.html` / `reference.css` / 两个 tools；R4 侧独占
  `floatingWorldScene.js` / recipe；`main.js` / `gameScene.js` / `diagnostics.js` 由**先提交者**落一次，
  另一方之后 rebase 自己的增量。需要双方都不再"顺手改"这三个文件。

---

## 6. 下一步

- **C1（未完成）**：还需要新天空 + 新广场 + **新 UI** + 主盘 + 地面投影 + 新候选托盘出现在**同一张**截图里。
  本轮已交付前四项与地面投影（见 §7 读数）；新 UI 由 R3 侧正在做（`index.html` 10:48 起在改），
  尚未与本轮画面合拍一张。
- **C2（未做）**：空格仍偏灰土黄、彩块偏暗，属纠偏 §6.2/§6.3 的 A–E 排查序列。
- **C3（未做）**：云已在动、建筑 bob 已按 §7.2 接上，但**没有时间序列证据**，主页环境是否连续渲染也未验。
- **C4（未做）**：多视口 / i18n / 部署验收未跑。

## 7. 本轮读数（390×844，CSP，dpr 1）

```text
world.horizon      requestedNdc 0.22 → edgeNdc 0.2200，edgeFromTop 0.390（zFar -25.07）
world.plaza        halfWidth 60，floorY -4.80，铺装格 2.2
world 装饰         中景 3 / 墙 2 / 前景 2 / 散块 3 = 122 格，云 6（云贴图 3/3 就绪），被剔除 0
world.boardShadow  visible，中心屏幕 (194.8, 549.1)，宽 5.27 × 深 0.69 世界单位，opacity 0.20
rendering.projection  worstPx 1.14e-13（R3 门禁 ≤ 1 CSS px）
WebGL 上下文        4（未新增第 5 个）
console errors      0
```
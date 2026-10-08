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

---

## 8. C2：方块与光影校准（本轮追加）

### 8.1 诊断：这不是方块材质问题，是全局光量问题

按纠偏 §6.3 的 A–E 顺序，先用取像素把「猜」换成读数。同一张 390×844 里采两点：

| 采样 | 渲染值 | 靶值（albedo） | 比例（sRGB） |
| --- | --- | --- | --- |
| 空格正面（`#F4E4C0`） | `#CDBC94` | `#F4E4C0` | .84 / .83 / .77 |
| 广场地面（我自己写的 `#FFF1CE`） | `#D8C79E` | `#FFF1CE` | .85 / .83 / .77 |

**两点衰减完全相同。** 广场是 `MeshStandardMaterial`、空格是 `MeshPhysicalMaterial`（clearcoat
+ specular），两者衰减一致说明差异不来自材质链、也不来自 SSAO（广场在 layer 2、被排除出
NormalPass，AO 根本不该碰它）。结论是：**整台灯只有约 1/1.42 的光量**，且偏暖。

先排掉的两项：
- **不是双重 tone mapping**：renderer `toneMapping = NoToneMapping`（`style.exposure` 因此不生效），
  合成链只有末端 `ToneMappingEffect(NEUTRAL)` 一次。
- **不动 `blockColor`**：§6.2 明确禁止用改 baseColor 掩盖渲染链问题。albedo 一个字节没改。

### 8.2 改法：调光比，不改材质

`scene.recipe.json` 的 `lighting`（唯一的灯组来源）：

| 灯 | 原 | 现 |
| --- | --- | --- |
| key | `#FFF1DC` 1.8 | `#FFF4E4` 2.7 |
| hemisphere | 1.0（ground `#E6D3AB`） | 1.5（ground `#EADCC0`） |
| fill | 0.4 | 0.57 |
| rim | 0.2 | 0.28 |

基准色略降暖、地面反弹色去饱和，是为了收掉那个 **蓝通道落后红通道 7 个点**的暖偏
（垂直面各拿一半半球光，主要吃的是暖的地面反弹）。

**结果**（同视口同姿态）：

| 采样 | 改前 | 改后 | 靶值 | 达成 |
| --- | --- | --- | --- | --- |
| 空格正面 | `#CDBC94` | `#EDDCB2` | `#F4E4C0` | 97 / 96 / 93 % |
| 广场地面 | `#D8C79E` | `#F2E9C8` | `#FFF1CE` | 95 / 97 / 97 % |

剩下的 3–7% 是**方向性衰减**（正面对 key 的 dotNL 小于 1），不是灰化：受光面已经贴到 albedo，
背光面仍保有奶油色，符合 §6.2 第 1 条。提高的是灯，不是 exposure——UI 是 DOM、云与天空是
unlit，都不受影响，所以不会出现 §6.3-D 担心的「UI/云/空格一起发白」。

### 8.3 顺带修掉：云是两块白方块

天空里一直有两个**硬边白色矩形**。两个独立原因，都修在 `floatingWorldScene.js`：

1. **6 个云 Sprite 只有 3 个拿到贴图**（`index % cloudSpecs.length` 把 3 张贴图全给回了前三个槽），
   而 `SpriteMaterial.map = null` 会渲染成**纯白方块**。改为按 shape 轮转分配，并让
   opacity 从 0 起、贴图到达才淡入——404 的云现在是「没有云」，不是「一块白板」。
2. **贴图是 512×192（2.67:1），却按正方形缩放**，云被纵向拉伸 2.67 倍。`world.clouds.aspect`
   进配方，第一帧就是对的形状。

### 8.4 缺陷已定位（未修，交 UI 所有者落地）

**右上功能键（声音 / 帮助 / 设置）在 390×844 与 1280×720 下都不可见。** 根因已取到，不是
「未判明」：

`src/floatingWorldUi.css:42-43` 的新皮肤覆盖把**两族**按钮都清空了底板：

```css
#app .item-button,
#app .topbar .icon-button { border-radius: 0; background: none; }
```

随后只为 `.item-button .item-icon`（第 45-48 行）补回了 `icon-button.svg` + 工具 glyph，
**顶栏 `.topbar .icon-button` 没有对应的补回规则**。同一文件里也没有 `icon-sound-on/off /
icon-help / icon-settings` 的引用。

浏览器实测（390×844，`getComputedStyle`）：

```text
#sound-button     rect 231,6 47×40   display grid  visibility visible  backgroundImage: none
#controls-button  rect 283,6 40×40   display grid  visibility visible  backgroundImage: none
#settings-button  rect 328,6 50×40   display grid  visibility visible  backgroundImage: none
```

即：**DOM 在、命中区在、什么都没画**。`reference.css:34` 的 `background: var(--button-art)`
被上面的 `background: none` 覆盖，而 `reference.css:43` 又把按钮内的 `.toy-icon` 设为
`visibility: hidden`，所以既不画底板也不画字形。

修法（§5「顶部功能键」要求的正是这个）：按 `.item-button .item-icon` 的同一手法，为
`#app .topbar .icon-button` 补一层 `icon-button.svg` 底板 + 对应 `icon-sound-on/off`、
`icon-help`、`icon-settings` 的 glyph 变量（声音键还要按静音状态切 on/off）。
文件属于正在并行推进的 UI 一侧，本轮不越界改动。

### 8.5 C2 尚未做到

- **彩块（paint）未校准**：默认开局盘面是空的，本轮只测了空格。§6.2 第 2 条「蓝与紫可辨、
  青色不脏、正面不能大片近黑」需要一盘带彩块的画面才能量。
- **接缝/轮廓**（§6.2 第 3 条）本轮只做了目视：深蓝缝清楚、未出现浓黑橡胶隔条，但**没有 A/B**。

---

## 9. C4 多视口门禁（本轮实跑）

`node tools/screenshot.mjs http://127.0.0.1:5173 artifacts/visual-r4-c4`：

```text
OK desktop-home / mobile-home / desktop-home-return
OK desktop-board 1440×900   mobile-board 390×844   small-mobile-board 320×740
OK landscape-board 844×390  widescreen-board 2048×900
OK mobile-gameover / desktop-gameover
OK desktop-settings / mobile-settings
OK desktop-leaderboard / mobile-leaderboard / desktop-leaderboard-local / mobile-leaderboard-local
16/16 OK，0 FAIL
```

五个规定视口（390×844 / 320×740 / 844×390 / 1440×900 / 2048×900）全覆盖，§9.2 要求的
1280×720 短桌面由本会话单独补拍（`artifacts/fw/c2-cloudfix2-1280.png`）。这批同时跑过
R3 的投影嵌入断言与新的 R4 实景断言（layer 2 独占、sky 就绪、plaza floorY、3/3/6 构图、
云贴图 3/3、无第 5 个 WebGL 上下文）。

**地平线的视口无关性**（§4.3「不是照抄像素稿」的可复算证据）：`requestedNdc 0.22` 在
`390×844` 与 `1280×720` 两个朝向不同的视口上都解出 `edgeFromTop = 0.3900`——地平线不是被
钉在世界坐标上，所以它不会随画幅漂移。

---

## 10. C3 环境动画证据：同一次会话内的 t0 / t+8s 对照

两次独立启动浏览器会各自重开页面时钟，云的位置与经过时间无关地一致，**证明不了任何运动**。
所以对照必须在同一个页面会话内拍。`1280×720`，两帧相隔 8000ms，逐像素差（阈值 8/255）：

| 区域 | 变化像素占比 | 最大差值 | 说明 |
| --- | --- | --- | --- |
| 天空带（云） | **4.97 %** | 162 | §7.2「云真的移动」 |
| 左侧带（建筑群） | **3.39 %** | 154 | §7.2「建筑轻浮动」 |
| 主盘中心 | 2.25 % | 116 | 主盘 bob（R5 侧实装） |
| 广场下半（**对照**） | **0.00 %** | 1 | §7.2「地面不随主盘浮动」——控制组，应静止 |

控制组是这张表的关键：它证明差分测的是运动，不是抗锯齿或噪声。

产物：`artifacts/fw/c3-motion-1280.png` / `c3-motion-1280-t+8s.png`。

### 10.1 `prefers-reduced-motion` 静止（同一手法，同视口，同 8s 间隔）

用 CDP `Emulation.setEmulatedMedia` 把 `prefers-reduced-motion` 置为 `reduce` 后重拍同一组对照：

| 区域 | 变化像素占比 | 最大差值 |
| --- | --- | --- |
| 全画面 | **0.00 %** | **0** |
| 天空带（云） | 0.00 % | 0 |
| 左侧带（建筑群） | 0.00 % | 0 |
| 主盘中心 | 0.00 % | 0 |

`world.reducedMotion === true`，maxDelta 为 0 而不是"很小"——环境位移与主盘浮动的冻结都真的生效，
不是靠差分阈值掩盖。产物：`artifacts/fw/c3-reduced-1280.png` / `-t+8s.png`。

**尚未交**：拖拽/暂停期间冻结、恢复不跳动的片段（§7.2 第二条）。

---

## 11. C3 主页：世界没有延续，根因已定位到两行

§8 要求「主页必须有：…**延续对局的积木世界**」「主页沿用同一个世界，不另开一套渲染器」。
实测**未达成**：`desktop-home` / `mobile-home` 背景是一层纯 CSS 渐变，看不到广场、积木或天空球。
两个独立的水龙头，都要拧：

1. **画布被 `visibility: hidden` 掉了** — `src/toy.css:336`
   ```css
   .home-open > .topbar, .home-open > .game-layout { visibility: hidden; pointer-events: none; }
   ```
   `.scene-wrap` 在 `.game-layout` 里，画布虽然是 `position: fixed`，但 `position` 不隔离
   `visibility` 继承——所以整个 3D 画面在主页上根本不可见。看到的那层浅蓝是
   `.home-screen` 自己的半透明渐变（`reference.css:280`）盖在**空白底**上。
2. **主页上不渲染任何一帧** — `src/main.js:1796`
   ```js
   floatingWorld.update(raw)        // 环境时间在走
   if (homeUi.isOpen()) return      // ← 在 updateRenderCamera()/composer.render() 之前返回
   ```
   环境时间照常累加、却一帧都不画；从主页回到对局时云会按累积时间一次跳到位。

另：主页的**纪录牌仍是旧金冠＋花叶**（`desktop-home` 可见），§5 要求换 `record-panel` +
本包 crown/trophy——R6 主页部分尚未完成。

三处都在并行推进的 UI 一侧，本轮只定位、不改。

---

## 12. 接手 KNOWN_GAPS §3：实景侧的 `setAmbient`（§8.7 / §C0.4）

R6 侧把「静止模式只落了一半」作为待接手项挂在 `KNOWN_GAPS` 上，并指出实景侧跑在实时时钟上、
需要 `floatingWorldScene.js` 提供 `setAmbient({ time, frozen })`。本轮补上。

### 12.1 顺手把动画改成绝对时钟

原实现是**逐帧累加**（`sprite.position.x += speed * … * delta`）。累加有两个毛病，静止模式正好把它们
一起逼出来：它会累积浮点误差，而且**只能靠「不跑」来冻结**——一旦冻结，位置就依赖「冻在哪一帧」。
改成从 `t` 直接求位姿之后，冻结态与实时态走的是**同一条代码路径**，`{ frozen: true, time: 0 }`
是可复现的一个确定位姿，而不是「上次停下来时碰巧的样子」。

云的漂移同时修了一处口径错误：速度是「屏宽/秒」，换算必须用**水平**方向的世界每像素。
嵌入投影的 `sx = gw/W` 与 `sy = gh/H` 并不相等，所以水平与垂直的世界每像素不同；原来的
`size / canvasHeight` 是垂直量。现在由 `layout()` 记下该云深度上画框左右边的世界 x，
乘出真实的世界位移；循环用取模，因此也同样是 `t` 的函数。

### 12.2 验证：同一构建两次截图像素相同

| 检查 | 结果 |
| --- | --- |
| `world.ambient` | `{ frozen: true, pinned: true, time: 0 }` |
| 同一会话内相隔 8s 的两帧 | **SHA256 完全相同**（`dadfa81b…`） |
| **两遍全量门禁**（17 张 × 2 次独立启动）跨会话逐个 SHA256 | **16 / 17 完全相同**；唯一不同的 `desktop-leaderboard-local` 只有 **10 个像素**、最大差值 **3/255**（标题行文字抗锯齿），实景区域 0.00% 变化 |
| 两遍门禁的 FAIL 数 | run1 **0**，run2 **0** |
| `npm test` / `npm run build` | 11 套全绿 / ✓ built in 2.65s |

`npm run shot` 的门禁也加了反向断言：`world.ambient.pinned` 为假就报
「两次截图不可比（§C0.4）」——**读回来**而不是相信前面的 pin 调用，因为「pin 悄悄失效」正是当初
没被发现的原因。

接线不只是模块：`diagnostics.js` 是**逐个白名单挂载** dev handles 的，
`setAmbient` 必须在 `main.js` 的 `devHandles` **和** `diagnostics.js` 的挂载表里各写一行。
只写前者时句柄存在但 `__voxalblastDev.setAmbient` 是 `undefined`，pin 静默不生效——
本轮实际踩到过一次，是量到 `ambient.pinned === false` 才发现。

---

## 13. C1 交付：一张统一的完整对局画面

`artifacts/visual-c1/c1-before-after-v4.png`（before / after / V4 三联，同高并排）。

### 13.1 清单核对（§C1 要求「同时看见」）

| §C1 要求 | 状态 | 证据 |
| --- | --- | --- |
| 新天空 | ✅ | 渐变天空球 + 3 种云贴图 / 6 个 Sprite |
| 新积木广场 / 远景 | ✅ | 广场板（反解远边 + 铺装格）+ 3 中景 prefab + 2 墙段 + 2 前景体 + 3 散块 |
| 新 UI | ✅ | 记分牌 / 顶栏三键 / 四工具瓦片 / 候选托盘 全部本包 |
| 主盘 | ✅ | 空格 `#EDDCB2`（靶 `#F4E4C0` 的 97/96/93%） |
| 地面软投影 | ✅ | 艺术软椭圆，屏幕 (194.8, 549.1)，可见 |
| 新候选托盘 | ✅ | `candidate-tray.svg` 三槽 |
| **旧田园背景退出** | ✅ | `installPastoralBackdrop` 不再调用，柯基/草地/城堡/花叶消失 |

`npm run shot` **17/17 OK、0 FAIL**（含 R3 投影嵌入断言与 R4 实景断言）。

### 13.2 与 V4 并排比较：**仍有的差异**（§9.4 要求列差异而不是只列优点）

1. **盘面是空的，V4 有彩色块。** 默认开局就是空盘，这是 fixture 差异不是渲染缺陷；但它意味着
   **C2 的彩漆校准仍未验**（蓝/紫/青的明亮度与「正面不能大片近黑」无从判读）。
2. **可见天空比 V4 少。** 地平线解到 `edgeFromTop 0.390`，而 V4 的蓝天空带约占画面 45%。
   主盘上沿（24.6%）以上的天空只有约 25% 画面高。
3. **主盘占屏比与 V4 不同**：本实现约 33.8% 画面高（V4 约 38%）。§1.3 明确「不为了像参考图
   首先改 FOV / 相机角度」，所以这是**刻意保留的偏离**，不是待修项。
4. **两侧积木的数量与体量低于 V4。** 目前是 3 中景 + 2 墙段 + 2 前景体，V4 侧边是密集堆叠；
   广场中段因此显得空。
5. **软投影偏淡。** 目前 `opacity 0.20`、`heightFactor 0.11`；V4 的影子明显更重更宽。
   已在配方里留成待调项，未擅自加重。
6. **主页纪录牌与主/次按钮仍是旧金冠＋花叶＋金边**（`desktop-home`）。背景已成功延续积木世界
   （另一会话 `e6cea34` 落地），但 §5 要求的 `record-panel` / `button-primary` 尚未接。
7. **`import` 自 `public/` 的 Vite 警告**、`#scene-wrap` 的 `overflow` 规范依赖、**无物理手机 /
   微信内嵌实测** 三条仍未处理（R3 文档 §4 已记）。

### 13.3 这一项不是「整套设计完成」

按 §C4，「浮空积木世界设计实装完成」要 C1–C4 全过。当前：**C1 达标**；C2 只做完空格与光影的
校准（彩块未做）、C3 已交运动与静止证据但缺拖拽冻结片段、C4 门禁已过但部署验收与 §9.4 回执未做。

---

## 14. C2 彩漆校准：正面取像素 + 与 V4 的 A/B

默认开局是空盘，量不到彩漆。用仓库**现成的** fixture 工具造一盘（不改任何源码、不改新开局的真实路径）：

```text
node tools/visual-fixtures.mjs                 # → tools/fixtures/visual-color-board-a..d.json（65 格满盘）
VBFW_SESSION=tools/fixtures/visual-color-board-a.json   # 同 SHOT_SESSION 的注入方式，写进 localStorage 后启动
```

### 14.1 正面逐色读数（390×844，dpr 1，静止模式）

| 配方 albedo | 正面渲染 | 比值 R/G/B |
| --- | --- | --- |
| `#F4E4C0`（空格） | `#F2E9C8` | 0.99 / **1.02** / **1.04** |
| `#2F70E8`（蓝） | `#1365D7` | **0.40** / 0.90 / 0.93 |
| `#E65B86`（树莓） | `#DD4773` | 0.96 / 0.78 / 0.86 |
| `#F5C846`（黄） | `#EABB2A` | 0.96 / 0.94 / **0.60** |
| `#BE55C9`（品红） | `#B53FB7` | 0.95 / **0.74** / 0.91 |
| `#51B991`（绿） | `#3BAD7E` | **0.73** / 0.94 / 0.87 |

读数区域限制在**正面**（x 90..240 / y 250..450）；侧面与顶面拿的是另一套光，混进来会把结论带偏。

**规律很清楚：每个颜色的少数通道被压到 0.40–0.78，多数通道停在 0.86–1.04；而近中性的空格三种通道
都在 1.0 上。** 这不是「整体偏暗」，是**渲染结果比 albedo 更饱和**。所以 §6.2 第 2 条里
「不能正面大片变成近黑块」的硬检查是过的（正面饱和像素里亮度 < 70 的占 **0%**），
但**逐色保真度上存在系统性的饱和度抬升**，成因未定位到具体项（`GemMaterial` 的
crown/polish 项、环境反射、还是刻意为之，需要单变量 A/B 才能定性）。

### 14.2 与 V4 的 A/B（把 V4 概念图里同族的颜色也量出来）

| | V4 概念图盘面 | 本实现正面 | 配方 albedo |
| --- | --- | --- | --- |
| 蓝 | **`#1060F0`** | `#1365D7`（Δ26） | `#2F70E8`（Δ36） |
| 紫 | `#A040F0` | `#B53FB7`（Δ61） | `#BE55C9`（Δ54） |

**蓝：本实现比配方自己的 albedo 更接近 V4**（Δ26 对 Δ36）——也就是说上面那个「饱和度抬升」
目前在蓝色上把画面推向了美术稿而不是推离。**紫：本实现明显不够蓝**（B 183 对 V4 的 240），
这是真正待修的一处。

### 14.3 本轮没做到的

- **青色（§6.2 的「青色不脏」）没验**：`paintMapping` 里有 `0x217d6e → #18BBA6`，
  但四份 fixture 的调色板都没有这个身份，量不到。V4 的青色是 `#00D0B0`，很近，值得单独验。
- **蓝/紫/品红三者的可辨性没做区分度检查**：只各测了一个色，没有同框并列。
- **接缝未做 A/B**：实测最深的缝像素是 `#021E2B`（亮度 25），而配方给的背壳色 `#243A4A` 亮度 49
  ——缝比背壳暗了一半，占盘面像素约 1.2%。§6.2 第 3 条要的是「清楚但不厚重」，
  但这一条只能靠 A/B（暂关 AO/接触暗化）判定，本轮只留读数。
- **配方一个字节没改**：上面两条都需要制作人对着 V4 拍板方向（尤其「抬升的饱和度留不留」），
  本轮只交读数与 A/B，不擅自调参。
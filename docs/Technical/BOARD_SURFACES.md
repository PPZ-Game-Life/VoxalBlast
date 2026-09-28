# 棋盘表面、光照与接触阴影

2026-09-28 实现说明。旋转、放置、吸附、手牌布局和棋盘格点规则沿用现有实现。

## 模块与调参入口

| 模块 | 职责 |
| --- | --- |
| `src/rendering/blockResources.js` | 棋盘、手牌、拖拽共用圆角几何；浅木材与塑料材质工厂、缓存和开发调参 |
| `src/rendering/woodTexture.js` | 确定性程序纹理、三种木纹变体、静态贴图替换与失败回退 |
| `src/rendering/toyLights.js` | 共用主方向光、半球光、补光、轮廓光与程序 HDR 环境反射 |
| `src/rendering/boardShadows.js` | 底座透明投影接收面与柔和接触阴影贴片 |
| `src/rendering/gameScene.js` | 阴影层与 SSAO 通道、按性能档位降级 |
| `src/rendering/config.js` | `BOARD_STYLE`、`LIGHTING_STYLE`、`BLOCK_TEXTURES`、`SHADOW_STYLE` |

原实现已经使用 `RoundedBoxGeometry`，没有替换成新的棋盘体系。边长从 0.97 调至 0.95，格点间距仍为 1，缝隙从 0.03 增至 0.05。倒角半径 0.115、细分 3，每块 588 个三角形（原为 1452，减少约 59.5%）。圆角提供真实法线过渡，面保持平整，方便判断格子与落点。

彩色块采用 `MeshPhysicalMaterial` 的不透明玩具塑料：roughness 0.27、metalness 0、clearcoat 0.65、envMapIntensity 0.65。取消彩色块的木纹，用极弱微表面法线保持高光柔和。浅木块 roughness 0.68、clearcoat 0.12、envMapIntensity 0.35，带低对比长纤维与确定性色差。粗糙度贴图会与 roughness 参数相乘。

反射复用已有 256×128 半浮点环境纹理，各 renderer 自行缓存 PMREM，无 HDRI 下载。主光、半球光和补光适当降低强度，避免浅木块过曝。两类方块材质显式绑定同一环境纹理：Three r172 在材质 `envMap === null` 时会用 `scene.environmentIntensity` 覆盖材质值，单改 `envMapIntensity` 无效。

## 贴图替换

`BLOCK_TEXTURES.wood` / `.paint` 各提供 `baseColor`、`roughness`、`normal`、`ao`。默认 `null`，用程序纹理。需要替换时把资源放在 `public/art/`，将对应项设为 `art/文件名.webp`（相对于 Vite `BASE_URL`）。加载失败保留程序纹理，不阻塞游戏。材质持有同一个 CanvasTexture，资源解码后原位更新，无逐块重建。

- baseColor 使用 sRGB；其余为线性数据。
- normal 为 OpenGL 切线空间法线；roughness 读取绿色通道；AO 读取红色通道。
- 纹理统一重采样至 256×256，木纹三种变体共用缓存，塑料共用一种。
- 原有 `art/block-pigment.webp` 只补充木块笔触；资源失败时仍有完整木纹。塑料不依赖它。
- 程序生成适合当前小尺寸 H5 方块：无新增下载，变体固定可复现，四通道结构可直接接最终美术资源。

## 阴影与降级

底座继续使用原有 DOM 图片。三维场景增加两个透明面：方向光的真实投影，以及 128×128 径向接触阴影。投影透明度在圆形边缘渐隐，避免接收面的矩形边界落到背景上；两个面都不参与拾取，不修改棋盘姿态。底座面固定在静止棋盘底部下方 0.025 单位，随相机自然投影；翻转中接触贴片是柔和近似，不是逐格物理接触模拟。

| 项目 | 常规档 | lowPower 档 |
| --- | --- | --- |
| 主光阴影 | 1024² PCFSoft | 512² PCFSoft |
| SSAO / 法线预通道 | 沿用现有 SSAO | 禁用两个通道 |
| 表面 AO / 凹槽背板 | 保留 | 保留 |
| 底座投影 / 接触贴片 | 保留 | 保留 |

lowPower 判定沿用项目原有屏宽 / CPU 核数策略。桌面法线预通道通过相机 layer 排除底座透明面，避免把背景变成 AO 接收面。极低性能设备还可关闭 renderer 的 shadowMap，接触贴片与表面 AO 仍然有效。本轮未引入屏幕空间接触阴影、动态模糊或额外 HDRI，也未测量实体手机 GPU 帧率。

## 开发调参

开发服务器控制台可调用，刷新恢复配置值；生产包不暴露写入口：

```js
__voxalblastDev.tuneMaterials({
  paint: { roughness: 0.27, envMapIntensity: 0.65, metalness: 0 },
  wood: { roughness: 0.68, envMapIntensity: 0.35 },
})
__voxalblastDev.tuneShadows({ contactOpacity: 0.24, projectedOpacity: 0.18 })
__voxalblast.rendering() // 材质、几何、SSAO 档位、底座阴影诊断
```

数值限制在合理范围。调参会更新已有棋盘 / 手牌 / 拖拽塑料材质及之后新建材质；已释放的材质会从追踪集合移除。开场动画临时材质和主页克隆请在动画结束、重新进入主页后检查。若要永久生效，将值写回 `config.js`。

## 验证

- `npm run build`、`npm test`。
- `node tools/refactor-interaction-probe.mjs`：52 项通过，0 失败 / 跳过，覆盖落点、吸附、取消、多指、存档恢复、反复拖拽；探针仍报告既有 bearing 未持久化缺口，本轮不改存档语义。
- `node tools/swipe-probe.mjs`：三种旋转手势方向通过。
- 截图检查：桌面、手机、小屏手机、横屏，含已有彩色棋盘与纯木空棋盘；另屏蔽原有笔触资源验证程序纹理回退与主页共用材质。
- 截图工具增加材质粗糙度区分、显式环境绑定、几何预算、底座接触阴影和移动端 SSAO 降级检查。

本机对比图与日志位于 gitignored `artifacts/material-before`、`material-final`、`material-fallback` 等目录。构建保留现有大 bundle 警告；Windows 截图探针可能保留退出后仍被系统锁定的临时浏览器目录，不影响浏览器检查结果。

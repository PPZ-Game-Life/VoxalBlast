# Impact Feedback V2 — Production Art Pack

VoxalBlast 落点驱动强化反馈资源包。生产资源来自本包原创、可编辑 SVG 几何与确定性圆角立方体配方；未裁切、描摹或打包参考图像素。`references/**` 只提供方向语境，构建器不会读取、写入、哈希或计入预算。

> 本包交付可加载资源、配置与离线样片，尚未接入游戏运行时。`proposalNotRuntimeVerified=true`；没有实际游戏、GPU、摄像机、触觉硬件或设备性能验收声明。

## 布局、帧序与固定坐标

| 资源 | 精确布局 | Pivot / 播放 |
| --- | --- | --- |
| `runtime/sweep-right.png` + `.json` | 1024×128 RGBA；4×1；帧 256×128；从左到右 | 固定 head pivot `(237,64)` / `[0.92578125,0.5]`；帧区间 `[0,.25) [.25,.5) [.5,.75) [.75,1]` 由**分支 travel progress**选取 |
| `runtime/endpoint-pop.png` + `.json` | 768×128 RGBA；6×1；帧 128×128；从左到右 | `[0.5,0.5]`；`18+22+26+26+24+24=140ms`；一次性播放 |
| `runtime/tap-feedback.png` + `.json` | 512×128 RGBA；4×1；帧 128×128；从左到右 | `[0.5,0.5]`；`60+35+35+30=160ms`；reduced-motion 静态 frame 1，独立 hold 80ms |
| `runtime/cube.glb` | 默认蓝色稳定别名 | node `Cube_Blue` / mesh `RoundedCube_Blue` |
| `runtime/cube-blue.glb` | 蓝色正式变体 | node `Cube_Blue` / mesh `RoundedCube_Blue` |
| `runtime/cube-teal.glb` | 青色正式变体 | node `Cube_Teal` / mesh `RoundedCube_Teal` |
| `runtime/cube-pink.glb` | 粉色正式变体 | node `Cube_Pink` / mesh `RoundedCube_Pink` |
| `runtime/feedback.recipe.json` | schema v1；ms / cell / CSSpx / normalizedAge | source 的规范化副本；配置提案，不是实机证明 |

PNG 为 sRGB、straight/unassociated RGBA；每帧 4px transparent-RGB dilation，外圈至少 4px alpha=0。推荐 LinearFilter、禁 mipmap、ClampToEdge、`premultipliedAlpha=false`、`depthWrite=false`。

### Union normalization（禁止逐帧补偿）

每个序列 metadata 的 `normalization.unionAlphaBounds` 与 `referenceAlphaBounds` 是所有帧 alpha 的固定并集。布局、缩放、裁切都以这一个 reference bounds 为基准；`frames[].contentAlphaBoundsMeasuredOnly` 仅供审计，**不得**据此逐帧缩放或重心补偿，否则会抹掉真实扩张。

Sweep 是厚实填充的奶油色扇形光头，配暖金弧形 ribs 与收尖分叉尾，不是椭圆轮廓加分离圆点：

- 美术尺寸：固定 reference bounds 映射为 **1.4 cell 宽 × 0.65 cell 可见高**，不是按整行拉伸。
- 固定 head anchor `(237,64)` 位于实际 leading tip 附近；最大 leading alpha 为 local `x=240`，即 pivot 前最多 `3px`。frame canvas 与 pivot 始终不变。
- `+X` 原图；`-X` 围绕 pivot 镜像；其他方向围绕 pivot 旋转。不要围绕几何中心旋转。
- 运动由 `feedback.recipe.json` 控制：落点后 35ms 启动，32 cell/s 沿每条实际消除分支推进，到达即结束且不晚于 200ms。metadata 内 140ms art-cycle 只是非权威标称，不得启动独立计时器。
- 每个方向分支在世界/屏幕投影中裁切到 `branch origin..advancing leading tip`；禁止在 origin 后方预显尾巴或在 front 前方预显 ribs。到达后清理 sprite。

## GLB 颜色、几何与加载契约

四个 GLB 均为 GLB 2.0、单位包围盒 `[-0.5,0.5]³`、中心 pivot `[0,0,0]`、圆角半径 0.12、294 vertices / 432 triangles。每个文件严格是 **1 primitive + 1 material**：

- primitive attributes：POSITION、NORMAL、COLOR_0；索引三角形。
- top/front/side 三色写入 VEC3 float `COLOR_0`。源 hex 是 sRGB，生成器按标准 sRGB transfer function 转成 **linear-light [0,1]**。
- 唯一材质的 linear `baseColorFactor=[1,1,1,1]`，metallic 0、roughness 0.72、OPAQUE、非 double-sided；无 textures/images/samplers。
- `cube.glb` 字节等同 `cube-blue.glb`，只作默认 URL。全三色加载时排除 alias，避免重复蓝色。

```js
const gltf = await loader.loadAsync(urlForVariant);
const actualMesh = gltf.scene.getObjectByName('Cube_Blue'); // Cube_Teal / Cube_Pink
const edgeCells = 0.44; // recipe permits 0.36..0.52
actualMesh.scale.setScalar(cellPitch * edgeCells); // cellPitch must use the scene's units-per-cell
```

若场景中 1 world unit 已等于 1 cell，则 `cellPitch=1`。不要对 scene root 的未知辅助节点盲目缩放。`cube.glb`/`cube-blue.glb` 不可同时请求。GLB 无法加载时可显式降级到旧 v1 反馈；本包不新增另一套 fallback 资源。`preview.png` 与 sampler 中的立方体由 actual GLB buffer 软件投影，不是 GPU/Three.js 截图。

## 配方与预算 schema

`clearBudgets.schema = "severity-by-quality-v1"`：数组位置严格对应 `severityOrder=[single,double,threePlus]`，质量键为 `standard|low`。

- per event cubes：standard `[4,6,8]`，low `[2,3,4]`
- per event endpointPops：standard `[2,4,6]`，low `[1,2,3]`
- per event secondarySprites：standard `[6,8,10]`，low `[2,3,4]`
- `maxClearEvents=2`
- global live caps：cubes `16/8`、endpointPops `12/6`、secondarySprites `20/8`（standard/low）
- face rays：`120/event = 6 faces × 60 raw lines × 2`，独立于 decorative pool，不占 secondarySprites 配额

保留的已确认参数：sweep `35ms / 32cell/s / <=200ms / .65×1.4cell`；burst 140ms；cube `.36..52cell`、scale hold `.45`、clear end `420/480ms`；tap `24..36CSSpx / 160ms / press60 / static80 / max2`。Camera curve 为 `[[0,0],[.12,1],[.28,-.55],[.48,.28],[.72,-.1],[1,0]]`，幅度 single/double/threePlus `1.2/2/3px`，时长 `90/110/140ms`，reduced motion 禁用，重叠按 max-not-sum。Haptics 为 tap `[]`、place `[6]`、single `[12]`、double `[18]`、threePlus `[14,20,14]`，源时长 cap 48ms，scope exit 取消，偏好独立于 reduced motion，禁止直接调用 vibrate。

## 网络字节预算

- runtime/ 全量（含默认蓝 alias）：`232762` bytes
- 推荐完整三色（所有 sprite/metadata/recipe + blue/teal/pink，排除 `cube.glb` alias）：`218166` bytes
- 精确组成与 SHA-256：见 `manifest.json`。source、ASSETS、checks、builder、preview、contact、sampler、references 均不计入 runtime 网络预算。

## 构建与只读校验

```powershell
py -3.12 tools/build-impact-feedback-assets.py --build
py -3.12 tools/build-impact-feedback-assets.py --check
```

构建使用 Microsoft Edge headless 离线 4× SVG 栅格化，再由 Pillow LANCZOS 缩小；无网络、无外部字体、无新增依赖。`--check` 只读验证：SVG、PNG alpha/border/bleed、固定 pivot 与 union normalization、帧总时长、manifest bytes/SHA、GLB 单 primitive/单 material/COLOR_0 线性范围/无纹理/bbox/单位法线/index、sampler 解码与最终清场。`asset-checks.json` 是最终 build 后生成的检查报告。

## 检视输出与诚实性

- `preview.png` 1440×1080：96px cell 仅为**放大检视**；另有 24/32/48px 1:1 比较，明确 sweep 高 `.65cell` 与 cube edge `.44cell`。
- `contact-sheet.png` 1440×650：精确列出 4+6+4 共 14 帧；sweep 标 travel-progress interval，endpoint/tap 标资源时长。
- `motion-sampler.webp` 960×540：`OFFLINE ART SAMPLE / NOT GAME CAPTURE`；包含独立 review holds、35ms 启动、2.5cell/32cell/s=78ms 实速双向 sweep、140ms endpoint、actual-GLB cubes、420ms single-clear 尾段、settled 5×5、160ms 独立 tap、最后清场。

全部预览均为离线软件样片。未证明 Three.js GPU 上传、真实事件接入、摄像机震动、触觉硬件、真机性能或最终手感。

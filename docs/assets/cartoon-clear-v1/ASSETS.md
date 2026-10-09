# Cartoon Clear V1

VoxalBlast 卡通消除特效生产资产包。8 个图形均为本轮由 Luna **以可控几何原创构造的可编辑 SVG**；参考图只用于确认“彩色方形粒子、小星星、短弹射拖尾”的方向，未从参考图抠图、切片或描图。SVG 是唯一艺术源，`runtime/` 下 PNG 均由构建工具生成。

## 范围边界

`manifest.json` 只审计本资产构建器负责的 `sources/*.svg`、`runtime/`、`preview.png`。`references/` 下批准分镜及其 `README.md` 作为独立设计参考归档：构建器不会读取、复制、覆盖或哈希这些文件，也不会把它们计入 runtime 网络预算。网络预算仅统计 `runtime/`；manifest 同时列出 atlas 模式、独立 sprites 模式和完整 runtime 目录字节数。

## 资产用途

| ID | 用途 | 主色 | 默认方向 |
| --- | --- | --- | --- |
| `confetti-blue` | 蓝色圆润方形彩纸 | `#2F70E8` | 无 |
| `confetti-teal` | 青色圆润方形彩纸 | `#18BBA6` | 无 |
| `confetti-pink` | 粉色圆润方形彩纸 | `#E65B86` | 无 |
| `star-pop` | 主星形爆点 | `#FFF1CC`，暖金边 | 无 |
| `sparkle-cream` | 次级四角闪星 | `#FFF1CC` | 无 |
| `dot-blue` | 小圆点填充粒子 | `#2F70E8` | 无 |
| `swoosh-cream` | 短弯尖弹射扫痕 | `#FFF1CC` | `+X` |
| `dash-blue` | 短蓝色弹射拖尾 | `#2F70E8` | `+X` |

统一轻量深蓝轮廓为 `#20334C`；粉、青、蓝、奶油色分别为 `#E65B86`、`#18BBA6`、`#2F70E8`、`#FFF1CC`。不含模糊发光、烘焙阴影、文字或破碎立方体。

## Runtime 约定

- 每张 sprite：128×128 straight/unassociated RGBA、sRGB，pivot `[0.5, 0.5]`。
- 每 tile 外圈至少 12 px 的 alpha 为 0；透明像素 RGB 向外扩张 4 px，减少线性采样黑边。
- 图集：`runtime/atlas.png`，512×256，4×2；每格 128×128，无跨 tile 颜色扩张。
- `runtime/atlas.json` 的 `rect` 是左上角像素原点；`alphaBounds` 为 `[left, top, right, bottom]`，右/下边界不包含。
- `uvRectTopLeft` 从左上角归一化；Three.js `Texture.flipY = true` 时使用 `uvBottomLeft`，换算为 `v0 = 1 - top.v1`、`v1 = 1 - top.v0`。
- 建议：`LinearFilter`、禁 mipmap、ClampToEdge、NormalBlending（禁止 additive）、`transparent=true`、`depthWrite=false`、`depthTest=true`。

## 重新构建与校验

```powershell
# 默认行为就是 build
py -3.12 tools/build-cartoon-clear-assets.py

# 显式 build
py -3.12 tools/build-cartoon-clear-assets.py --build

# 只校验，绝不重建或写文件
py -3.12 tools/build-cartoon-clear-assets.py --check

# 参数帮助
py -3.12 tools/build-cartoon-clear-assets.py --help
```

构建流程优先使用当前环境已有的 CairoSVG；若 Cairo 原生 DLL 不可载入，则使用已安装的 Microsoft Edge headless 作为 SVG 栅格器。两条路径都会先生成 4× 图像，再由 Pillow 以 LANCZOS 缩小至 128×128，不新增项目依赖。实际后端与 Cairo DLL 诊断写入 `manifest.json` / `asset-checks.json`；manifest 同时记录 LF 规范化文本或二进制原字节的大小与 SHA-256。

## 误用警告

- `preview.png` 只是生产贴图检查板，不可作为游戏贴图或图集输入；文字由 Pillow 内置字体直接栅格化进 PNG，不依赖系统字体、外部字体文件或网络字体。
- 不要直接手改 `runtime/`；应编辑 `sources/*.svg` 后重新构建。
- 不要启用 additive blending、mipmap 或跨 tile 的颜色扩张。
- `swoosh-cream` 与 `dash-blue` 原始方向朝 `+X`，实例旋转应在运行时完成。
- 本轮只交付资产包与离线构建/校验工具，**尚未接入游戏运行时，也未做 GPU、设备或性能验证**。

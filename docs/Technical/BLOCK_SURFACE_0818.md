# 方块材质 v0.8.18 验证记录

2026-09-21，基于 v0.8.17；目标为用户指定的暖木彩漆参考图。本轮只调整方块表面与共享反射，不改候选池颜色、玩法、相机、几何尺寸或 UI。

实现：26.1 KiB AI 中性笔触底图取代纯云噪声，木色校准为暖蜜桃，降低大尺度凹凸，粗糙度同时调制清漆层，软矩形环境反射加强倒角亮边。资产来源与原始提示词见 `public/art/README.md`。

验证结果：

- `npm test`：255/255 通过。
- `npm run build`：通过；保留既有的 >500 kB bundle 提示。
- `node tools/screenshot.mjs http://127.0.0.1:5174 artifacts/block-study-final`：桌面主页、桌面/手机/宽屏棋盘、手机/桌面结算共六项通过，surfaceArt 均为 ready，无运行时/着色器错误。
- 设置 `SHOT_SURFACE=fallback`、`SHOT_ONLY=desktop-home,desktop-board,mobile-board`：阻断方块 WebP 的网络请求，三项均通过，surfaceArt 为 fallback。
- 棋盘仍为 98 个唯一 mesh、588 三角形/块，AO 独立深度与投影检查通过；没有增加几何或逐块 draw call。未作手机实机 FPS 基准。

本地截图目录：`artifacts/block-study-before`、`artifacts/block-study-final`、`artifacts/block-study-fallback`（均为 git-ignored）。已查看最终桌面/手机截图；相机与配色遵循现行交互可读性约束，因此整幅构图及颜色分布不会与参考插画逐像素一致。参考图中的不规则局部手绘高光仍比实时材质更丰富，不以本次测试通过代替用户美术验收。

截图工具支持 `SHOT_ONLY` 逗号分隔指定已有视图；`SHOT_SURFACE=fallback` 只阻断方块底图，并要求回退成功，其余运行时错误仍判失败。

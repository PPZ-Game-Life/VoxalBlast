# 强消除视觉参考

`strong-clear-style.png` 是 Luna 在本轮设计讨论中通过 DSH 原生图片编辑生成、并检查5×5结构后的强度参考。

- 原文件：`E:\WorkSpace\DSH\assets\images\voxalblast-clear-impact-v4-wide-sweep-final.png`
- 原图：1586×992 PNG；SHA-256 `aa2fb0e309594cd7b7c2c7cc7cd700bfb5734699c5d18b8a11bc336f846df2b3`。
- 本仓库副本不改像素；只作为刷光面积、六面体体积、端点爆点的美术方向。
- **方向修订**：图中从左向右的刷光已被用户后续确认的「由实际放置点向消除线两端传播」取代；生产时序以主交接单和 `runtime/feedback.recipe.json` 为准。
- 图中粒子为审阅而放大，数量、相对格宽和亮度不是性能计数或运行时精确标尺；不改变棋盘几何、镜头取景或规则。
- 不从这张图切运行贴图。正式刷光、爆点、点击序列、六面体模型在上级 `runtime/`；可编辑源在 `sources/`。
- 本目录不进资产构建manifest，不计入运行时网络预算，也不得复制进游戏首包。
- 静态振动符号并非实机震屏或设备触觉验收；本轮两种震动均为待实现配置。

主入口：[落点驱动强化消除、点击与震动交接](../../../Technical/PLACEMENT_IMPACT_FEEDBACK_HANDOFF.md)。

注意路径：本文件位于 `docs/assets/impact-feedback-v2/references/`，上行三层回到 `docs/`。

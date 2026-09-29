# 切图资源包摘要

入口： [JEFFY_INTEGRATION.md](JEFFY_INTEGRATION.md)。

- 运行时候选图片：30 张，其中透明 PNG 28 张、复用干净背景 2 张。
- 完整设计参考：3 张，不用于 runtime 整屏背景。
- 图片资源合计：1.70 MiB（不含参考图与预览）。
- [离线资源查看页](previews/asset-gallery.html)：双击可看棋盘格／白底／深底透明效果。
- [面板切图预览](previews/panels-contact-sheet.png)、[图标切图预览](previews/icons-contact-sheet.png)。
- [汇总清单](manifest.json)、[资源验证](validation.json)。

**最终图标：BEST／主页最高分／排行榜 = 皇冠；SCORE = 奖杯。**

**功能差异：当前设置有语言行共七行，不能按六行概念图删掉；独立新游戏功能已存在，接现有按钮。**

本包只做图像拆分、无字底修复、透明处理及交接文档；没有修改游戏代码。扁平图被遮挡的部分不是原始分层图，恢复方法及已知限制在 manifest 和接入指南逐项注明。

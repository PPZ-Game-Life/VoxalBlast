# 消除特效 × 庆祝元素 × 音效改版｜Jeffy 一份文档交接

> **Luna → Jeffy｜2026-09-30｜设计交接 v1.0，待实现／试听／实机验收。**
> 源码核对：VoxalBlast `package.json` **0.9.32**，任务起点 HEAD `4ec3c42`，包含已存在的未提交渲染改动；本轮不改游戏代码、不升版。
> **只转发本文即可**：下方有在线参考、试听与完整资源包，Jeffy 不需要寻找聊天附件。仓库链接需要正常的项目访问权限；完整包可离线阅读。

## 0. Jeffy 从这里开始

### 交付入口

- **[本文在线版](https://github.com/PPZ-Game-Life/VoxalBlast/blob/main/docs/Technical/CLEAR_CELEBRATION_AUDIO_HANDOFF.md)**。
- **[完整交接包 ZIP](https://github.com/PPZ-Game-Life/VoxalBlast/raw/refs/heads/main/docs/Technical/assets/clear-celebration/jeffy-celebration-handoff.zip)**：本文、参考图、可编辑形状模板、17 个音效小样、顺序试听、配方脚本与来源说明。解压后先读根目录同名 Markdown。
- **[19.89 秒顺序试听 WAV](https://github.com/PPZ-Game-Life/VoxalBlast/raw/refs/heads/main/docs/Technical/assets/clear-celebration/audio/audition-sequence.wav)**；浏览器不内嵌播放时下载播放。
- **[全部音效及单文件入口](https://github.com/PPZ-Game-Life/VoxalBlast/tree/main/docs/Technical/assets/clear-celebration/audio)** · **[配方与时间索引](https://github.com/PPZ-Game-Life/VoxalBlast/blob/main/docs/Technical/assets/clear-celebration/audio-manifest.json)**。
- **[可编辑 SVG 形状](https://github.com/PPZ-Game-Life/VoxalBlast/blob/main/docs/Technical/assets/clear-celebration/celebration-shapes.svg)** · **[资源来源／完整生图提示词](https://github.com/PPZ-Game-Life/VoxalBlast/blob/main/docs/Technical/assets/clear-celebration/SOURCES.md)**。

这些是设计资产与音色参考，**不是已接入的运行时产物**。正文中的参数、时序与遮挡规则优先于示意图；音效小样已做文件／采样检查，**没有人工听审、手机外放验收或最终母带处理**。

### 一句话方向

**让每次消除“啪嗒、刷、叮”地成立，让精彩操作像花园里的一次小庆典；不是爆破、发光玻璃或满屏烟花。**

本期做：正常落子／L1–L5 消除、跨面、连击里程碑、主荣誉、分数声音避让、四道具声音与局部效果、新纪录收束。先完成核心样板，再扩展。

本期不做：背景音乐、人声喝彩、角色动画、节庆活动、宝箱金币、奖励规则、全屏白闪、自动转镜头、相机取景重做、方块材质重做。主体方块仍按前一份方块交接处理，本方案不会用特效掩盖材质问题。

### 对旧方案的裁决

仓库已有 `docs/Planning/09-特效设计与庆祝感升级.md`，但混合 v0.8.22／v0.9.17 提案，且许多入口已拆分。本次延续其“木作花园庆典”方向，**本次实施范围、事件时序、音效和资源交付以本文为准**。

- 采用“一个主庆祝”：收起局内附属徽章行，分数跳字不再重复荣誉名；全部荣誉、奖金与结算页徽章仍保留。
- 主标题沿用已有 `honors.primary` 本地化词条，不在这轮重命名荣誉。
- 旧稿五档新命名、五格 pip、PERFECT_TWELVE 荣誉政策／等级即荣誉等未决内容**暂不实施，也不是本轮前置条件**。消除 L0–L5 仍是表现强度，不新增玩家成长等级。
- 普通消除与庆祝的相机震动目标值为 0；L5 旧 0.6×／400ms 动画慢放首轮保留，但 reduced-motion 下关闭。不延长任何现有输入限制。

## 1. 当前实现：不是从零加特效和声音

| 现状（静态核对） | 代码依据 | 本轮要解决 |
| --- | --- | --- |
| 每条消线生成光束、粒子和两颗黄橙星；高档增加粒子倍率与震屏 | `src/rendering/effects.js`：`spawnLineBeam`／`spawnClearStars`／`spawnClearEffects`；`config.js`：`FEEDBACK_STYLE` | 按整次落子分配预算，等级通过构图／节奏区分，不能按每条线无限倍增 |
| 粒子／光束为 AdditiveBlending，长短与星章叠加容易抢主体 | `effects.js`：`particleMaterial`、`spawnLineBeam` | 纸彩采用普通透明混合；只保留有限局部亮边，不能改全局曝光补亮 |
| 同一次消除同时调用 place、honor、chain；计分滚动另有 tick／settle 声 | `main.js:onDrop`；`effects.js:play*`；`ui/hud.js:SCORE_ROLL` | 一次落子一个主要声音，计分与连击让位，不再叠出多套旋律 |
| 音频只有 sine 振荡器＋短包络，未加载声音文件 | `effects.js:playTone` | 用可控木敲、木琴、纸声和轻铃替代统一电子短音 |
| 没有 master gain、活动声源取消和完整音频生命周期 | `effects.js:playTone` | 即时静音、后台停声、显式解锁、过期事件取消、并发限流 |
| 道具和新纪录没有专属声音；连击只有普通增长音，未实现里程碑专属声音 | `main.js:confirmItem/rerollPieces/undoItem/endGame` | 补齐成功／失败／撤销／纪录的准确入口，不能把无命中当成功 |
| `score.chainMilestone` 已由规则返回，5/10/15/20 是已有计分节点 | `src/game/scoring.js`：`SCORING.chainMilestones`／`moveScore` | 直接消费该字段，不在音效模块复制门槛或另发奖励 |
| 游戏暂停包含设置／帮助／主页／隐藏／局终／开场，但音频未随状态统一处理 | `main.js:syncPause`、visibility 路径 | 视听分别有状态通道；结算即使 gameplay paused，也能播放一次纪录声 |
| 粒子 Set 保留 autoDestroy 系统引用直至清理；旧 report 不是活跃粒子计数 | `effects.js:report/clearTransientEffects` | 新增真实 live count 与回收验证，不拿 trackedSystems 冒充并发预算 |

**不要误读**：L1 没有荣誉旋律不等于静音，它仍有 `playPlaceSound(1)`；L2 的配置虽有 small banner，但无 `honors.primary` 时现有函数不会显示主横幅。新纪录只认局终的 `summary.isNewBest`，不是局中分数超过 BEST。

当前工作区中 `config.js`、`effects` 所依赖的共享材质等存在其他任务改动；Jeffy 开始前核对 `git status`，仅修改本轮明确范围，不覆盖或代提交他人变更。

## 2. 美术参考与元素库

![本轮原创花园庆祝风格参考：六格从左到右、从上到下阅读](https://raw.githubusercontent.com/PPZ-Game-Life/VoxalBlast/main/docs/Technical/assets/clear-celebration/garden-celebration-reference.png)

离线包内：[打开本地参考图](assets/clear-celebration/garden-celebration-reference.png)。

六格解释：① 单线确认；② 纸彩形状与色板；③ 四角闪点／五角星章；④ 中档局部扇形；⑤ 顶档双侧短带，中心留空；⑥ 新纪录纸章装饰。**不是六帧动画，不按图里的粒子数量直接施工。**参考板里的蓝块仅示意方向，不替代游戏的亮面积木材质；放大的星章、光带不能按板面比例盖在棋盘上。

### 2.1 资源分工：明确可用与不可直接用

| 资源 | 本轮状态／用途 | Jeffy 接法 |
| --- | --- | --- |
| `garden-celebration-reference.png` | 已生成并目视检查的静态风格参考，不透明底，不是 sprite atlas | 只对齐轮廓、材料和留白；不要裁白底图当运行时粒子 |
| `celebration-shapes.svg` | 本轮原始路径模板，可编辑；四个 symbol：`paper-chip`／`sparkle-four`／`seal-five`／`ribbon-short` | HUD 可抽取路径；3D 可据此建共享几何。最终实际尺寸／透明边缘仍需验收 |
| `effects.js:particleGeometry/starGeometry` | 现有几何与共享机制 | 保留机制；小立方粒子替换为圆角薄纸片，五角星按 SVG 收圆，不新建一套模型加载系统 |
| `public/art/reference/star.png` | 现有可复用星形资产 | 适合 HUD 小星章；不要当整条线每格都会喷出的巨星，也不拉伸成长条 |
| `public/art/ui-redesign/panels/home-record.png` | 现有主页完整装饰模块 | **不直接搬进局中**：有封面专用比例和花叶，只参考木框／奶油底材质；新纪录沿用结算卡 DOM |
| `audio/*.wav` | 已制作 17 个原创合成小样＋顺序试听 | 首先试听；推荐将脚本配方移植 WebAudio，而非未经听审直接上线 WAV |
| `build-audio-previews.mjs`／`audio-manifest.json` | 可重复生成、逐 cue 配方与时长索引 | Node 标准库即可复现；离线参考不进入首包，不接触游戏随机数 |

运行时第一版不需要再等外包图片、购买音效包或生成序列帧。形状、颜色、节奏、音色起点都已给齐；没有一项必须靠口头找 Luna 补图才能开始。

### 2.2 可控视觉规格（首轮起点）

- 纸彩：圆角矩形，2:1／3:2 两种比例，最多两次轻翻转；3D 短边约 0.06～0.12 格，移动端表观目标约 3～7 CSS px。过小就减掉，不堆亚像素噪点。
- 四角闪点：用于动作收束，表观 6～12 CSS px，一亮一收；不是常驻发光星。
- 五角星章：局中以 18～28 CSS px 为起点；新纪录卡可 32～48px。其大小不随线数继续膨胀。
- 线带：从现有满线推导，长度不超真实线段两端各 0.03 格；厚度约 0.025～0.045 格，峰值透明度 0.28～0.40，单次变化，无高频闪烁。
- 短彩带：L4／L5 才使用，每次至多两条，长度约 0.5～1 格投影宽，最多两个弯折；不是长蛇形轨迹。
- 共用上左主光和低对比纸面，不用写实毛边、颗粒噪声、玻璃、金币或爆炸烟。

| 颜色 | 值 | 用途 |
| --- | --- | --- |
| 奶油纸 | `#FFF1D4` | 短确认／闪点／纸章底 |
| 蜜蜡金 | `#E7B75F` | 星章与少量亮点，非金属，不是新占用格色 |
| 玫瑰纸 | `#C98699` | 庆祝纸彩 |
| 晴空纸 | `#8DBDD3` | 庆祝纸彩 |
| 鼠尾草纸 | `#A5BBA1` | 辅助纸彩 |
| 树皮墨 | `#452E13` | 纸章文字／边缘 |

一次只选三种纸彩色＋奶油色；强饱和继续让给真实游戏方块。纸彩用普通混合、`depthWrite=false`，世界粒子保留遮挡；光带不以关闭 depthTest 换“看得清”。

## 3. 消除与庆祝分级

**等级必须直接使用 `feedbackLevel()` 返回的 level，不在 VFX 里重写规则。**下表条件仅帮助阅读，L5 向下优先命中。

| 等级 | 既有触发 | 主表现 | 飞行纸彩上限：标准／低配 | 最长装饰尾段（墙钟） | 主音 cue |
| --- | --- | --- | ---: | ---: | --- |
| L0 | 0 线 | 落子边短确认、安静加分，无纸彩／横幅 | 0／0 | 160ms | `place` |
| L1 | 1 线 | 一道窄线带，少量纸彩向两端散开 | 6／3 | 420ms | `clear-l1` |
| L2 | 2 线 | 双线同期确认，共用一枚小闪点 | 12／6 | 550ms | `clear-l2` |
| L3 | ≥3 线且未到更高档 | 局部扇形纸彩＋一个主荣誉 | 24／12 | 800ms | `clear-l3` |
| L4 | ≥4 线或 ≥3 面，且非 L5 | 可见面呼应＋短彩带＋星章 | 40／20 | 1100ms | `clear-l4` |
| L5 | ≥5 线，或 ≥4 线且 ≥3 面 | 一次双侧外扩礼花，中央操作区域留空 | 64／28 | 1400ms | `clear-l5` |
| 新纪录 | 局终 `summary.isNewBest` | 成绩卡星章＋双侧纸彩，仅一次 | 72／28 | 1600ms | `new-best` |

- 表中纸彩是**整个事件总数**，共享角格不翻倍，多线也不乘第二次等级系数。彩带／星章另有上限，但计入全局装饰对象预算。
- 相交满线、同一共享棱在两面计线：逻辑仍计两线；同一空间线段的亮度合并，单格退漆／散片只发生一次。
- 看不见的背面保留真实遮挡，不透过六面体播光束、不自动转镜头。`N LINES / M FACES` 仍说明真实结果。
- L1／L2 不增加大横幅；L3–L5 一个主横幅。其文字停留可沿用现有 name／large／full 时长 900／1400／2200ms，不能让粒子陪着撒到文字结束。
- CHAIN 普通增长只更新 HUD；`score.chainMilestone > 0` 时给 HUD 一次纸结／星点，复用已有链数，不自创计分。与 L3+ 同手时合并，不额外启动第二场礼花。

## 4. 关键分镜：时点、画面、声音同一张表

`t=0` 是**成功规则结算返回的时刻**，不是玩家按下、不是松手坐标未验证时。分数、占用、候选消耗、存档／补牌沿用现有流程，不等待演出。

### 4.1 L0／L1／L2：日常动作先做好

| 时间 | 图像 | 声音 | 输入与逻辑 |
| --- | --- | --- | --- |
| 0–50ms | 仅落子范围一次轻确认；有消除则满线短亮 | 木敲起音。clear cue 已内含落子音，不再额外播放 place | 结算已完成；不移动／缩放实际棋盘实体 |
| 50–140ms | 窄线带沿真实行／列短展开；多线同期、最多错峰 35ms | 一声轻扫纸声与木琴短音 | 空格已恢复木色；表现不把它写回占用态 |
| 100–240ms | 纸彩从线端或局部中心向外分散；不是每格爆炸 | L2 第二音在同一节奏内响应 | 新拖拽优先，落点附近残留立即淡出 |
| 160–420ms | 一个总分跳字收束，保留 N 线／M 面信息；无大横幅 | 计分 tick 被压低，主音尾声结束后可留一次小落定声 | 下一手照常；不新增等待条件 |

**不做“把实体炸飞后再补木块”**。棋盘依旧是完整 98 块；消除是占用彩漆的退场。第一版不强制彩块残像，短线确认＋纸片即可。若后续加退漆薄片，只能用独立可丢弃表现对象，不改棋盘 mesh transform，不假装格子仍被占用。

### 4.2 L3–L5：先说明结果，再喝彩

- 0–140ms：沿用单线确认，先让玩家知道哪里消了。
- 120–320ms：L3 的扇形、L4 的短彩带、L5 的双侧礼花进入；一次落子只发射一次庆祝。
- 160–280ms：主荣誉木牌／奶油字牌短出现，沿用现有本地化真实荣誉。分数跳字不再重复这个荣誉名，也不逐条播附属徽章。
- 300–1400ms：装饰向留白侧退场。分数、操作面、道具库存、候选、撤销按钮始终不被装饰覆盖。
- 手机没安全留白：自动降为 HUD 小星章＋短亮边，**不缩小棋盘为礼花腾位置**。横屏右侧已有候选时只用允许的左侧或完全取消飞行装饰。

主横幅位置由现有 UI 区域与实际 DOM rect 计算，不硬编码 `top:50%` 盖棋盘；空间不足用紧凑单行，不新增模态层。

### 4.3 四道具：成功才出声，效果如工具而非爆炸

| 事件 | 图像／时长起点 | 声音 | 硬边界 |
| --- | --- | --- | --- |
| Hammer 成功 | 单格短敲闪点，180～240ms | `item-hammer`：低木敲＋极轻亮点 | 只实际删除格；不把木方敲碎 |
| Rocket 成功 | 沿选定 row／col 一条窄纸带，220～320ms | `item-rocket`：轻纸扫＋短上行 | 保留真实行列作用域，不做火焰／激光 |
| Bomb 成功 | 有效 2×2 四角纸花短开，240～360ms | `item-bomb`：柔和纸扑＋低木音 | 不用圆冲击波暗示圆形伤害；按边界裁切 |
| Refresh 成功 | 候选纸托短扫／换页，180～240ms | `item-refresh`：两次轻翻纸 | 异步换批成功后才播；不承诺“好牌”或稀有奖励 |
| 空目标／无库存／非法释放 | 原有文字＋一次短提示 | 可用更轻 `cancel`，限流；不是警报 | 无成功音、无扣次数、无加分 |
| 主动取消／撤销 | 立即恢复稳定状态，取消对应尾效 | 主动取消默认静音；撤销可复用极轻 cancel | 不额外计分／CHAIN，不播反向纪录动画 |

工具不经过 L1–L5 庆祝。`emitItemBurst(cells, axisHint)` 当前第二参并未实现工具专属分流，Jeffy 必须显式消费 `id`／有效作用域／实际 removed，而不是只给通用粒子换声音。

### 4.4 新纪录：一次温暖收束，不庆祝失败

| 时间 | 表现 |
| --- | --- |
| 0–200ms | 结算卡与最终数字出现；按钮立即可用；清除局内庆祝尾效和旧音 |
| 150–400ms | `NEW BEST`／“新纪录”由真实 DOM 显示，星章一次压印；`new-best` 起音 |
| 220–1000ms | 卡片两侧纸彩外扩，不跨过分数／按钮 |
| 1000–1600ms | 全部飞行装饰结束，只留静态纪录标识 |

只在 `endGame()` 完成记录后消费 `summary.isNewBest`。重复 render、语言切换、窗口 resize 不再触发；重开／返回主页马上取消。普通结算只用淡入和轻收束 `game-over`，不播胜利曲，不下雨、不震屏。

## 5. 音效设计与小样表

### 5.1 音色词汇

**主体：干净木敲；奖励：短木琴；高光：克制轻铃；动作连接：弱纸声。**所有声音来自同一家族。无爆炸低频、赌场硬币、人声尖叫、持续电流、长混响；不新增 BGM，以免网页多任务环境一直出声。

L1 的旋律可记住，L2–L5 在其上逐步加音，不简单提高音量。L5 与新纪录可以更完整，但最长主题音约 1.12s，不为了“更爽”无限上移频率。

### 5.2 已交付小样（不是最终听审结论）

目录：`docs/Technical/assets/clear-celebration/audio/`。以下文件均可从文首音效目录／资源包取得。时长是本轮实际生成文件长度；音乐音名按 C4=261.63Hz。

| 文件 | 时长 | 设计用途／构成 |
| --- | ---: | --- |
| `place.wav` | 0.16s | L0，C4 干木敲，短促不抢分数 |
| `clear-l1.wav` | 0.42s | 木敲＋C5 木琴，轻纸扫 |
| `clear-l2.wav` | 0.50s | 木敲＋C5→E5 |
| `clear-l3.wav` | 0.62s | 木敲＋C5→E5→G5，末音轻铃 |
| `clear-l4.wav` | 0.76s | 木敲＋C5→E5→G5→C6 |
| `clear-l5.wav` | 0.92s | 同主题，尾部小和声／轻铃，不加倍音量 |
| `chain-milestone.wav` | 0.44s | G5→C6，作为里程碑尾句参考，不与主旋律盲目相加 |
| `new-best.wav` | 1.12s | 上行主题＋轻和弦，结算专用 |
| `item-hammer.wav` | 0.25s | 较低木敲，短而实 |
| `item-rocket.wav` | 0.34s | 纸扫＋轻上行，不像喷气／武器 |
| `item-bomb.wav` | 0.36s | 纸扑＋低木音，无低频爆破 |
| `item-refresh.wav` | 0.30s | 两次轻翻纸，非抽奖 |
| `cancel.wav` | 0.15s | 很轻的木触碰；非法释放可用，主动取消默认不播 |
| `chain-break.wav` | 0.34s | 两个柔和下行音，低于成功声；不羞辱失败 |
| `score-tick.wav` | 0.07s | 安静的计数参考，实际 runtime 可再缩短至 30～45ms |
| `score-settle.wav` | 0.28s | 小范围落定双音；主旋律未结束时可被合并／抑制 |
| `game-over.wav` | 0.46s | 温和收束，不是悲剧旋律 |

顺序试听按上表从上到下，首段前 0.50s 静音、每段后 0.70s 间隔，总长 **19.89s**。17 个单 cue 共 **719,788 bytes**，不含试听合辑。格式统一 48kHz／16bit／mono；最大采样峰值约 **−12.04dBFS**，留出混音余量，**不是已完成 LUFS／true-peak 母带**。由于未人工试听，文件存在与波形不削顶不能代替音色合格判断。

### 5.3 默认实现路线：按配方运行时合成

第一版推荐继续 WebAudio，使用离线脚本里的谐波／包络／确定性噪声配方预生成短 `AudioBuffer` 并缓存，再由 `AudioBufferSourceNode` 播放；也可用 oscillator 实时合成相同主题。共享一个 AudioContext，不为每 cue 建新 context。

优点：不需要下载音频，不依赖外部版权采样；可按手机试听调节；音色有确定来源。离线 WAV 是沟通／A-B 参考，默认不拷进 `public/` 增大首包。若 Jeffy 选择直接试接 WAV，要列为实现选择并遵守同样的调度和门禁，不能既播合成版又播 WAV。

纸声用受带宽约束的短噪声，初始化或首次手势时生成并缓存；不得在消除关键帧里重新生成大量样本。不要把特效噪声随机源接到游戏发牌 RNG。

## 6. 声音调度：不再“每个系统各唱各的”

### 6.1 一次结算一个主 cue

- `lineCount===0`：播 `place`。有断链时保留轻量下行，但音量让位，不另播荣誉。
- `lineCount>0`：只播一个 `clear-lN`，**它已包含落子敲击**；停用旧 place＋honor＋普通 chain 三路叠加。连击 HUD 正常更新。
- `score.chainMilestone>0`：L1／L2 可把里程碑两音替换／接在主 cue 的尾部，总长≤0.9s；L3+ 只在原主 cue 内加一个轻铃点，不另开第二条旋律。
- 分数滚动 `tick`：现状声音请求间隔 48ms、每次最多 14 次。本轮保留数字滚动节奏，但在音频层把主 cue 播放期 tick 压低约 **12dB**，声音请求改为全局不超过每 70ms 一次、每次计分滚动最多 8 次，作为待试听起点。**只节流声音，数字滚动与总分不受影响。**
- `score-settle`：主 cue 未结束则合并／抑制声音，仍保留 HUD 视觉落定；空闲时轻播。参数按本次滚动增量，不按累计总分。
- 道具成功只播对应工具声，不同时播放消线／荣誉；被取消、未命中、失败的异步 refresh 不播成功声。
- 新纪录开始时取消局内尾声，播一次 record cue；普通 game-over 声不再叠加。

### 6.2 总线、预算与避让

推荐路径：`source → category Gain → master Gain → soft safety compressor → destination`。compressor 只是保险，不代替合理音量。调度以“cue 组”为单位；一个 cue 可能包含多个音符，不把音符数误当事件数。

| 项目 | 首轮约束 |
| --- | --- |
| 主旋律组 | 同时 1 组；新事件替换旧尾句，15～30ms 淡出，拒绝长队列 |
| 音符／噪声声源总数 | 同时≤12（低配≤8）；超额优先取消旧尾音／tick，不吞掉新落子触感信息 |
| 最高优先级 | 用户静音／隐藏／重开／离开场景：立即取消相关排程 |
| 内容优先级 | 新纪录 > 当前消除 > 当前道具成功 > CHAIN 尾句 > 计数／UI |
| 边缘无效提示 | 最多 150ms 一次，仅失败释放时；不随悬停逐帧滴滴响 |
| 全局混音 | 目标峰值保留余量，试听混合也不削顶；实际 dBTP／响度在最终听审阶段测量 |

快速连放不延迟下一次动作声以“等上一曲播完”。旧旋律淡出，新事件立刻启动；可省掉装饰尾音，不得省掉视觉结果或修改落子时机。

### 6.3 静音、解锁、暂停：不要留下半套系统

- 保留存储键 `voxalblast-sound` 与现有开关语义，设置和 HUD 音量按钮仍控制同一状态。
- 第一有效用户手势显式创建／resume AudioContext，处理 Promise 成败；未解锁时静默丢弃该次声音，不阻止落子，不等到下次交互补播一串旧声音。
- 静音不只是拒绝后续音符：master 在≤20ms 内淡到 0，并取消已经排程／活跃的 cue；重新开启不补播，设置测试音只播一次。
- 页面隐藏、回主页、重开：取消声源与延迟事件；按需 suspend，恢复只接收新事件。不能依赖 RAF 停止来停止 WebAudio。
- **游戏暂停和音频场景不是同一个布尔量**：设置中禁止局内尾曲但允许显式试音；局终 gameplay 已停，仍允许一次 `new-best/game-over`。建议场景为 `gameplay/intro/settings/help/result/home/hidden`，与生命周期绑定。`intro` 保持安静、取消上一局尾声，本期不增加开场音乐，结束后只接受新的 gameplay 事件；`help` 停局内声音，不补播。设置显式试音可以解锁 AudioContext，但 intro 的输入锁或动画时钟不得决定音频解锁成功与否。隐藏／外部静音优先于所有场景。
- 当前平台适配没有完整广告回调音频接线，本轮预留 `externalMuteReason` 接口，但**不声称已经验证广告静音／CrazyGames 联调**，不为此改 SDK 规则。
- reduced-motion 只控制运动，不自动静音；关闭触感只影响触感。不得把三项偏好绑成一个开关。

## 7. 工程事件合同：表现读结果，不重新判断结果

### 7.1 建议只读描述（新增结构建议，非当前 API）

```js
{
  eventId, runEpoch,                 // 表现侧递增标识，去重/取消，不进存档
  kind: 'placement',
  level, lines, facesHit,            // settlePlacement 返回值
  uniqueClearedCells,               // 对 lines[].cells 按 x,y,z 去重，仅分配表现
  scoreTotal: score.total,
  chain: run.chain,
  chainMilestone: score.chainMilestone,
  primaryHonor: honors.primary,
  startedAt,                        // 同一墙钟起点
}
```

真实结算调用保持：`settlePlacement → 消耗候选/renderBoard/updateChainHud → 表现分发 → 原有 save／补牌／卡手判定`。不要把存档、Worker 发牌或 `checkStuckAndPrompt()` 挂到动画完成回调。

`Board.place()` 的 `cellsCleared` 是**数量**，不是带颜色的数组；实际消除坐标来自 `lines[].cells` 去重。不得误写 `result.cellsCleared.map(...)`。普通线带用真实 `face/axis/cells` 即可，不额外跑一次消线算法。

若后续要按来源色退漆，落子前只读抓取视觉颜色快照，并合入这次新落子的颜色／坐标；结算后按真实清除坐标读取。不得为了取色延迟规则删除、复制可写棋盘或改变 return 契约。本期彩纸使用统一装饰色，可不做该快照。

### 7.2 空间、遮挡和输入

- 当前 `fxGroup` 为世界空间。线带的初始坐标必须使用 `cubeVector/cellToWorld/cubeGroup.matrixWorld`；不得把 face-local 坐标直接加入 scene。
- 贴面确认时若开始翻面，旧贴面效果快速淡出（≤80ms）或正确跟随该面；不能冻结在世界里变成穿过方块的长条。纸彩发射后可世界空间自由运动。
- 同一 shared cell 的粒子／退漆按实体去重；双面共线可保留面语义，但空间重叠亮带应合并／限亮。
- 只要新的拖拽预览／工具范围出现，覆盖该范围的装饰优先退场。所有 DOM 装饰 `pointer-events:none`、`aria-hidden=true`、不可聚焦。
- 局中 HUD 仅一个主横幅；在新事件时替换／合并，不形成排队滚动字幕。去掉局内徽章生成段，**保留结算页仍在用的 `.honor-badge` CSS**。
- 现有消除后道具 `holdItemsFor(650)`、工具 busy、开场锁和 Worker dealing 输入门禁不在本轮改动范围；不把它们误写为“游戏从来没有输入限制”，也不新增／延长限制。

### 7.3 时钟、取消与资源所有权

- 本文时长按墙钟计。庆祝调度器使用原始 delta／时间戳；与既有 L5 动画慢放分开，不能让 1.4s 尾段因 0.6× 意外拖长。原有游戏动画时钟不随本轮重写。
- 效果注册到 eventId／runEpoch；重开、局终切场、隐藏、设置打开、回主页按作用域取消。撤销只取消相应工具效果。
- 旧 `setTimeout` 若继续用，必须可清理／过期保护；推荐统一 scheduler 或可取消的 Web Animations。
- 共享 geometry／material／texture 归资源池所有；单次事件只销毁实例，不 dispose 其他系统在用的共享对象。autoDestroy 的 quarks 系统需同步移出活动集合，避免 Set 持有历史引用。
- quarks burst `count` 仍用 `ConstantValue` 等 ValueGenerator，不传裸数字；保留 `threeCompat.js` 导入顺序。异常不得让主渲染循环停止。

## 8. 性能、低配与减少动态效果

| 项目 | 标准档 | lowPower | reduced-motion（与前两列独立） |
| --- | --- | --- | --- |
| 同屏飞行纸彩 | ≤96，含所有重叠事件 | ≤40 | 0 |
| 其他装饰对象 | ≤8（星章、闪点、彩带合计） | ≤4，无长彩带 | 静态小标识 |
| 纸彩发射频率 | L4/L5 侧边发射间隔≥1.2s | 同左或更少 | 不发射 |
| 主横幅／分数跳字 | 1 个主横幅；数字结果不丢 | 同左 | 100～180ms 淡入或静态，无位移弹跳 |
| 相机震动 | 目标 0 | 0 | 0 |
| L5 原有慢放 | 首轮保留 0.6×／≤400ms | 首轮保留，按性能复核 | 关闭 |
| 新增后处理 pass | 0 | 0 | 0 |
| 常驻粒子／BGM | 0／无 | 0／无 | 0／无 |

侧边发射冷却只省装饰，不吞掉线带、真实分数、当前事件主声音。新纪录进入先清空局内，不把 72 片与 L5 的 64 片叠满。

复用 BatchedRenderer 或 pooled mesh；不为每纸片建立 DOM，不每次创建纹理／音频 context。低配时先去长彩带、再减纸片、再缩尾段，不能牺牲输入采样／落点可读性。预算为目标，不是现有性能成绩；同设备脚本下建议标准档 P95 帧时增量≤2ms、低配≤3ms，基线本来低于 60fps 时同时报告基线与增量。

## 9. Jeffy 修改入口与测试陷阱

| 入口 | 工作内容 |
| --- | --- |
| `src/rendering/effects.js` | 替换逐线倍增为事件预算；纸彩／星花形状；清理与活动计数；音频入口迁移或归并 |
| `src/rendering/config.js` | 单次／全局预算、时序、motion policy、音量与并发常量；保留等级规则来源 |
| `src/main.js:onDrop` | 一次事件分发；取消旧 place/honor/chain 同时播；不改 settle／发牌／存档顺序 |
| `src/main.js:confirmItem/rerollPieces/undoItem/endGame/resetGame/syncPause` | 成功后分发对应 cue、result 场景、取消／静音生命周期 |
| `src/ui/hud.js` | 一个主横幅；去分数跳字重复荣誉／局内副徽章；计分 tick/settle 向音频仲裁请求，不直接强播 |
| `src/ui/gameOver.js` | 只渲染一次纪录演出的触发合同，普通结算不庆祝；resize／i18n 不重复启动 |
| `src/ui/settings.js` | 保持开关与存储键，向音频 master 发实时状态；显式试音 |
| `src/styles.css`／`src/reference.css`／`src/i18n/locales/*` | 新样式仅覆盖必要表现；补 reduced-motion；新增文案一律 i18n，不写进图片 |
| 建议新增 `src/rendering/celebration.js`／`src/audio/gameAudio.js` | 可选的小型表现调度／音频模块，当前并不存在；不借此大范围重构 |

**不改** `src/game/**`、`src/platform/**` 的规则／存档／SDK 行为；已有音效偏好与触感适配继续复用。所有计分、荣誉奖金、候选池、道具次数不变。

特别注意：`tools/score-roll-probe.mjs` 目前通过 `createOscillator` 次数检测出声。若采用预合成 AudioBuffer／采样，**不能删除断言来换通过**。应把探针改成音频事件／总线可观测检测，能证明开声有实际播放、静音无输出、数字滚动不受声音影响，并保留能抓住“根本没播”和“静音仍播”的负向用例。`playScoreSettle(points)` 的 points 是本次滚动差值，不是累计总分。

## 10. 分轮实施与验收

### R0｜证据与资产准备

- [ ] 拉取本文和包内全部资源；确认能打开参考图、SVG、19.89s 试听及 manifest。
- [ ] 记录当前 commit／未提交改动／浏览器／URL／视口／DPR／quality；不以本文起点代替 Jeffy 开工基线。
- [ ] 录制现有 L0/L1/L2、L3/L4/L5、跨面、道具与纪录样本；听原有叠音。固定局面、随机种子、姿态和时点。
- [ ] 人工试听小样，确认木敲／纸声／轻铃方向。未听审之前不把小样标成 final。

### R1｜核心样板：L0／L1／L2＋一次主声音

- [ ] 先只调整线带／少量纸彩；再独立改音色与音频仲裁，不同时重做所有 UI。
- [ ] 用一段实际输入录屏证明“确认→消除→分数”清楚；下一手操作不被拖慢。
- [ ] 单线不变成盛大庆典，双线比单线清楚但不靠震屏；声音无 place/honor/chain 重复主题。

### R2｜L3–L5 与跨面庆祝

- [ ] 所有等级并排录屏；相交线／共享棱格只退场一次，背面不穿模；统计整事件和同屏峰值。
- [ ] 手机低配与短横屏无留白时正常降级；主横幅不挡操作，副荣誉仍在结算页完整可查。
- [ ] L5 慢放与声音／墙钟演出同步，reduced-motion 不慢放、不震、不飞。

### R3｜道具、CHAIN 与结算

- [ ] 四道具成功／空目标／取消／撤销／refresh 异步失败逐一验证；不误播成功音，不假加分。
- [ ] 5/10/15/20 里程碑消费 `score.chainMilestone`；普通增长不每手叠旋律，断链仅轻提示。
- [ ] 普通结算、新纪录、重复 render、重开、续玩／返回主页；每局纪录只播一次，按钮全程可用。

### R4｜最终工程与真机门禁（全部尚待执行）

- [ ] 静音时未开始／正在播／已排程声音均被拦截；开启不补播；第一次手势解锁失败不阻塞玩法。
- [ ] 后台标签页／开场／设置／帮助／主页／局终／重开音频作用域正确；intro 安静且不补播，result 允许纪录声但不继续局内音乐。
- [ ] 快速连续操作 30s，无无限排队、爆音、分数遗漏或语义重播；每轮对象与声源回收。
- [ ] `npm test`、`npm run build`，以及涉及的 `probe:interaction`／`probe:drag`／`probe:item`／`probe:rescue`／`probe:score`／`probe:ui`／`probe:churn`；需要新增事件与音频生命周期探针。`npm run gates` 可一次覆盖其中的交互／UI／资源回收等既有门禁，不必与相同检查无意义重复执行。既有截图脚本不能自动证明所有新效果时序。
- [ ] 视口至少 390×844、320×740、844×390、1440×900，追加 1280×720／2048×900；以实际执行尺寸为准。
- [ ] 对关键效果采 0/80/160/320/700/1400ms 帧并录屏带系统音；静态图不能证明节奏与音画同步。
- [ ] 同设备记录 frame p50/p95、draw calls、live particles／transients／voices、内存／纹理数量、包体变化。正式音频混合无 clipping，手机外放不刺耳／不听不见。
- [ ] 至少一台 Android Chrome 与一台 iOS Safari 实机测首音、前后台、静音和连续触控；未覆盖写“未验证”，不以 headless 模拟替代。
- [ ] 更新相关实现文档与参数；`git diff --check`、资源／链接检查。规则测试不变，计分／存档／平台行为不改。

### 退回标准与回执

出现任一项退回：满屏白闪／浓烟／币雨；每次单线都大横幅；背面光束穿体；共享格爆多次；新拖拽仍被星章挡住；主旋律叠三套；静音后仍有已排程音；进入结算又补播局内荣誉；小样未经试听直接标终版。

每轮回执只写：本轮唯一问题 → 改动文件／参数 → 固定样本 Before/After 录屏路径 → 音频试听与设备 → 对象／声源／性能数据 → 未验证项 → Luna 放行或退回。实现承接本文不代表美术自动验收通过。

## 11. 本轮交付状态与离线阅读

- 已完成：源码静态核对、完整设计与合同、1 张原创参考图、1 份 SVG 形状模板、17 个原创合成 cue＋顺序试听、可复现脚本与配方清单、来源说明、ZIP 交接包。
- 尚未完成：游戏实现、运行时效果对照录屏、人工音频听审、混音母带、手机真机与平台联调。
- 未修改游戏运行文件，不把文档附件算作新增运行时下载。本文与资源包均无竞品音效采样／素材抄取，无在线生成调用依赖。
- 在线图打不开时，从 ZIP 解压后使用本地链接：[参考图](assets/clear-celebration/garden-celebration-reference.png)、[SVG](assets/clear-celebration/celebration-shapes.svg)、[试听 WAV](assets/clear-celebration/audio/audition-sequence.wav)、[全部配方](assets/clear-celebration/audio-manifest.json)、[生成脚本](assets/clear-celebration/build-audio-previews.mjs)、[来源说明](assets/clear-celebration/SOURCES.md)。**无需另外转发聊天里的图片。**

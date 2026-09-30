# 消除特效 × 庆祝元素 × 音效改版｜实现记录 v0.10.1

> **Jeffy → 制作人 / Luna｜2026-09-30｜承接 [CLEAR_CELEBRATION_AUDIO_HANDOFF.md](CLEAR_CELEBRATION_AUDIO_HANDOFF.md) v1.0**
> 起点基线：HEAD `12cabb3`（v0.10.0，工作区干净），核对后按本文实现。落地版本 **0.10.1**。
> 本文只写「改了什么 / 怎么验的 / 没验证什么」，设计口径以交接文档为准。

## 1. 一句话

一次落子 = **一个事件、一份预算、一个主声音**。旧的「每条线各喷一份、等级再乘一次」的加法被换成按事件分配；粒子从加色发光点变成花园纸彩；音效从 `playTone` 正弦短音换成一条有总线的音色家族（`gameAudio.js`），落子不再同时叠 place＋honor＋chain 三套旋律。

## 2. 改动文件

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `src/audio/gameAudio.js` | **新增** | 17 个 cue 的运行时合成（配方逐字移植自 `assets/clear-celebration/build-audio-previews.mjs`）＋总线 `source → category → master → 安全压缩 → analyser → out`；场景、静音、解锁、声源上限、避让、可观测 |
| `src/rendering/config.js` | 改 | 新增 `CELEBRATION`（纸彩/尺寸/预算/时序/尾段/震荡=0/窄视口降级）与 `AUDIO_STYLE`（混音与并发常量）；`FEEDBACK_STYLE` 去掉 `particleScale`、`shake`、`badges`，时长改按文档 |
| `src/rendering/effects.js` | 重写 | 事件预算、共享格去重、纸彩/线带/闪点/星章/短彩带、四道具分流、真实 live 计数、按墙钟调度、让位与取消 |
| `src/main.js` | 改 | 一次落子一个主 cue；道具/纪录/场景生命周期接线；首次手势解锁；`effects.update(raw)` |
| `src/ui/hud.js` | 改 | 去掉局内附属徽章行与分数跳字里的荣誉名；tick 节流与上限取自 `AUDIO_STYLE`；链数里程碑闪动 |
| `src/ui/gameOver.js` | 改 | 新纪录只演一次（按 summary 身份去重）＋卡片纸彩/星章 |
| `src/ui/settings.js` | 改 | 开关翻转实时通知总线（`onSoundChanged`），显式试音走总线 |
| `src/styles.css` | 改 | 链里程碑、换批托盘扫动、新纪录纸彩与印记；三条 `prefers-reduced-motion` 例外 |
| `src/diagnostics.js` | 改 | 新增只读 `__voxalblast.audio()` 与四个 DEV 句柄 |
| `tools/score-roll-probe.mjs` | 改 | 声音断言从「数 oscillator」改为**总线可观测**（cue 数＋主输出峰值），保留正/负用例 |
| `tools/celebration-audio-probe.mjs` | **新增** | 预算/共享格/一主 cue/减动效/窄视口/静音/场景/纪录，共 46 项 |
| `tools/celebration-frames.mjs` | **新增** | 按 §10 R4 的 0/80/160/320/700/1400ms 采帧（页内采，不经 CDP 截图） |

## 3. 验收读数

| 门禁 | 结果 |
| --- | --- |
| `npm test` | 163＋397＋145＋72＋146＋61＋56＋13＋（edge/gem）全通过 |
| `npm run build` | ✓ 1.78s；主包 1,045.63 kB（**+0.57 kB**，未拷入任何 WAV） |
| `npm run gates` | 52＋93＋44 通过；沿用既有 1 项 SKIP |
| `npm run probe:score` | 26 项全通过（含新总线断言：开声 5 cue／峰值 0.134；静音 0 cue／峰值 0.00000） |
| `npm run probe:celebration` | 46 项全通过 |
| `npm run probe:item` / `probe:drag` | 全通过 / 117 项全通过 |
| `npm run probe:rescue` | **2 项失败，均为改动前既有问题，见 §6** |
| 帧证据 | `artifacts/visual/celebration-L{1,5}-*.png`（桌面 1440×900 与移动 390×844 两套） |

关键读数：L1–L5 与纪录的纸彩预算 = 文档表；两条相交线（共享一格）唯一格 **9**；L3 一次事件只有 **1 个主 cue**；减动效下飞行纸彩 **0**、静态标识 **1**；视口 844×390 时预算减半（28→14）且棋盘尺寸不变。

## 4. 两个必须写下来的实现坑（都被证据抓过）

1. **纸彩一开始整批不渲染，而所有计数器都是对的。** `RotationOverLife` 在 `RenderMode.Mesh` 下写入的是标量角，而 three.quarks 该模式填的是**四元数**旋转属性 → 每个实例矩阵 NaN → 整个 batch 一张不画，但 `liveChips=64 / liveParticles=64` 全部正常。发现路径是**采帧看图**，不是探针。现在翻转烘进 chip 几何（每纸色一个静态倾角），并给探针加了**页内像素采样**断言（事件后棋盘区域变动格数 ≥20，尾段结束回 0）——这条断言是本轮唯一能抓住该缺陷的。
2. **纸彩原来生成在方块内部。** 格心 = 方块中心，深度测试下不可见；必须沿面法线外移到 `BOARD_STYLE.feedbackSurfaceOffset`（线带一直这么做，粒子没做）。

## 5. 与文档的差异（已实现但口径我拍板的）

- 纸声/音色走**预渲染 AudioBuffer**（文档 §5.3 的首选路线），因此 `audio-manifest.json` 里的 WAV **不进入首包**；离线小样仍是试听基准。
- 总线 `.ui` 分类下加了一个 duck 节点（-12dB，20ms 起/350ms 落），落在 tick/settle 上，主 cue 不受影响。
- 「新纪录」的卡片纸彩是 **DOM**（14 片，CSS 动画，1700ms 自卸）；棋盘上的新纪录没有 3D 爆发。
- 窄视口降级判据：`innerHeight ≤ 620 || innerWidth ≤ 360` → 预算 ×0.5、不发侧向彩带（文档只说「手机没安全留白」，没给判据）。

## 6. 未完成 / 未验证（不要当成已过）

- **§10 R4 真机与听审全部未做**：没有人工听审、没有 LUFS/true-peak 母带、没有 Android/iOS 实机首音与前后台、没有带系统声的录屏、没有 CrazyGames 广告静音联调（`externalMuteReason` 接口已留，未接线）。帧证据只是静态图，**不能证明节奏与音画同步**。
- 本轮**没有**跑 `probe:interaction/drag/...` 之外的新增性能采样（P95 帧时、draw calls、包体变化只给了包体）。
- `probe:rescue` 的 2 项失败**改动前即存在**，与本轮无关，如实报出、未修：
  1. `src/main.js` 调 `t('toast.noSpotClear')`，但 `toast.noSpotClear` 在 `src/i18n/locales/en.js` / `zh-Hans.js` 里**都不存在**（只有 `status.noSpotClear` 与 `toast.noRoomClearPath`）→ 卡死提示的 toast 会显示原始 key；
  2. 同一探针仍按 v0.8.16 的中文/精确文案断言（如「点选目标，再点使用」），而 v0.9.18 起默认语言是英文 → 断言本身过期。
  两者都在 `HEAD` 已复现（`git show HEAD:src/main.js` 同款调用、locale 里同款缺失），本轮未改。
- 沿用既有 1 项 SKIP：`probe:churn` D 换批「the refresh click did not re-deal (no-change)」，本轮未改换批逻辑，未深挖。

## 7. 下一轮建议顺序

1. 人工试听 17 个小样 → 定音色是否保留（`build-audio-previews.mjs` 与运行时配方同源，改一处即可双改）。
2. 真机录屏（带系统声）对 0/80/160/320/700/1400ms 的音画同步；补 P95 帧时与 draw calls。
3. 决定 `probe:rescue` 的两条：补 `toast.noSpotClear` 文案，或把断言的文案口径改成读 i18n 目录而非字面量。

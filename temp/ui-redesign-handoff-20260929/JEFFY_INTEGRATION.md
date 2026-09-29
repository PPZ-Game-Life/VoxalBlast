# VoxalBlast 新 UI 切图交接给 Jeffy

> 交付日期：2026-09-29。这里只交付资源与接入说明，**没有修改游戏运行代码**。
> 本包基于已确认的三张设计图；当前代码核对基线为 v0.9.24 / `ef0139f`，接入时以实际最新实现为准，不覆盖其他人的并发改动。

## 1. 先看这三项最终裁决

| 使用位置 | 最终图标 / 行为 |
|---|---|
| 局内 HUD：BEST（上排） | **皇冠** |
| 局内 HUD：SCORE（下排） | **奖杯** |
| 主页最高分 | **大皇冠** |
| 主页排行榜 | **小皇冠**，不是奖杯 |
| 主页主操作 | 有存档时同时出现「继续游戏」与独立「新游戏」；无存档时只保留一个「新游戏」入口 |
| 主页形象区域 | **不显示六面体**，包括原来的实时 WebGL hero，不是只从背景图中去掉方块 |

设计终稿：
- [主页](references/home.png)：皇冠最高分＋继续游戏＋新游戏＋皇冠排行榜＋设置。
- [设置](references/settings.png)：奶油金色框、六行概念稿。
- [计分牌](references/score.png)：BEST 皇冠／SCORE 奖杯。

### 当前实现与设计图之间必须保留的功能差异

**设置图是六行，但当前代码已经有七行：语言、声音、触感、拖块翻面、操作说明、回到主页、重新开始。**

- **不要为了像图而删除「语言」行**。复用 `settings-row.png` 排在首行；保留当前语言文字提示（English / 简体中文），不将它做成开关。
- 本包没有虚构一张「语言图标」：可以留空图标槽对齐，或沿用现有文本式语言指示；要新增图标需另做设计确认。
- 「新游戏」功能已存在于本轮查阅的代码，优先接现有 `#home-new`，不要再加第二套重开逻辑。
- `#haptics-note` 有设备不支持振动的第三态，设计图未画出但不能删除。

## 2. 资源范围与真实性说明

这些输入是 **GPT 生成的扁平 PNG，不是 PSD/Figma 分层工程**。本包没有再次调用生图，也没有把截图小矩形直接冒充透明组件。

处理分三类，详见每个资源 manifest 的 `method` / `notes`：
1. **图标 / 品牌图**：从终稿裁切，使用轮廓蒙版与背景分离形成 RGBA。
2. **无字面板 / 按钮**：保留原图边框与材质，从同一组件的干净色带修复被文字、图标覆盖的底色。被花叶遮挡的可拉伸端帽用同风格干净边框重建。
3. **补充状态 / 背景**：OFF 开关是从 ON 状态轨道与原按钮派生的美术补齐；干净场景背景直接复用项目已有素材，不声称恢复了终稿中被 UI 遮挡的像素。

**因此本包是可接入评审的切图包，不是逐像素还原的原始图层。** 先使用离线资产预览和真实页面对照验收，尤其是边缘、缩放和不同底色。

### 目录

```text
assets/
  icons/           # 透明图标、品牌 logo（品牌文字允许固定）
  panels/          # 无动态文字底板、行底、开关状态、关闭按钮
  backgrounds/     # 复用的干净田园竖屏/横屏背景
references/        # 3 张完整概念图，仅设计对照，禁止直接当游戏界面背景
manifests/         # 图标/面板来源坐标、尺寸、alpha、处理方式
previews/          # 棋盘格 alpha 检查图和资源查看页
manifest.json      # 汇总资源清单、来源、布局锚点与验证数据
validation.json    # 本包资源自动验证结果
JEFFY_INTEGRATION.md
PACKAGE_SUMMARY.md
 tools/            # Pillow 切图与验证脚本；不属于游戏 runtime
```

## 3. 接入资源与选择规则

### 3.1 背景与品牌

- `assets/backgrounds/valley-portrait.webp` / `valley-landscape.webp`：来自 `public/art/reference/` 的现有干净背景。
- **不要使用 `references/home.png` 当首页整屏背景**：里面已经画了分数、按钮和文字，会造成双重文字，且不能切换语言/数字/存档状态。
- logo 使用 `assets/icons/` 中的品牌切片（精确文件名见 `manifest.json`）；下方副标题仍使用 i18n DOM 文本。
- 背景层 `pointer-events:none`；用 `cover` 并分别检查手机和横屏裁切。背景的 corgi/城堡落点与概念稿可能略不同，这是复用旧干净背景的已知差异。

### 3.2 空白 UI 底板

| 文件（`assets/panels/`） | 用途 | 拉伸方式 |
|---|---|---|
| `home-primary.png` | 继续游戏金色底 | 九宫格；箭头与文字另放 |
| `home-secondary.png` | 新游戏奶油底 | 九宫格；加号与文字另放 |
| `home-nav.png` | 排行榜／设置 | 九宫格；不保留旧 SVG 叠影 |
| `home-record.png` | 主页最高分底板 | 固定纵横比；大皇冠单独叠上沿 |
| `score-panel.png` | 局内两行计分牌 | 固定纵横比，**不可九宫格拉扯花叶** |
| `settings-modal.png` | 设置外框 | 九宫格；内部不是整张截图 |
| `settings-row.png` | 通用设置行，包含语言行 | 九宫格 |
| `settings-danger.png` | 重新开始操作行 | 九宫格 |
| `toggle-on.png` / `toggle-off.png` | 开／关 | 等比缩放，勿九宫格；实际事件仍绑行按钮 |
| `toggle-thumb.png` | 可选分层滑块 | 仅在自行实现轨道动效时使用 |
| `keyboard-hint.png` | WASDQE / 语言提示胶囊底 | 九宫格，文字另写 |
| `close-button.png` | 设置关闭 | 等比缩放；**已包含静态 X，不要再叠一个 ×** |

- 九宫格裁线记录为 `nineSliceTRBL`（上、右、下、左，单位是**源 PNG 像素**）。`contentInsetsTRBL` 是推荐内边距，不是裁线。
- 固定比例资源的源尺寸见 manifest；CSS 使用 `aspect-ratio`，不把所有图片硬拉成同一比例。
- 普通、按下、禁用、焦点状态建议用 CSS 实现，不再为每个状态复制整张图片：短按位移 1–2px、轻微亮度变化、disabled 降饱和、独立可见焦点环。
- `close-button.png` 的静态 X 是图形符号；**其他按钮标签、分数、BEST/SCORE 字样、键盘提示、语言名称均不得烘焙进图片**。

### 3.3 图标绑定

精确图标文件与裁图坐标以 [manifest.json](manifest.json) 为准；不要按旧的 `best-trophy` 草稿文件名推断语义。

| 元素 | 应使用 |
|---|---|
| `.best-chip::before` | HUD 皇冠 |
| `.score-chip::before` | HUD 奖杯 |
| `.home-record` | 大皇冠 |
| `#home-leaderboard` | 小皇冠 |
| `#home-primary` | play 三角 |
| `#home-new` | plus 加号，不再是旧 refresh 箭头 |
| `#home-settings` | 紫色 gear |
| 声音／触感／拖块翻面／操作说明／回家／重开 | 对应设置图标 |

实际图标文件（`assets/icons/`）：

- 品牌：`logo-voxalblast.png`；最高分：`home-crown-large.png`；排行榜：`nav-crown-small.png`。
- HUD：`hud-crown-best.png`、`hud-trophy-score.png`。
- 按钮：`gear-purple.png`、`play-triangle.png`、`plus-gold.png`。
- 设置：`settings-speaker.png`、`settings-vibration.png`、`settings-turn.png`、`settings-book.png`、`settings-home.png`、`settings-restart.png`。
- 可选独立关闭符号：`settings-close-x.png`（与完整关闭按钮二选一）。

图标保持原比例，建议 `object-fit:contain`。装饰图标 `aria-hidden=true`；按钮本身保留本地化可访问名称。

大皇冠底部原本被花叶/高分底板遮挡，不应把这个裁片当成可悬浮四面完整的独立道具：装配时仍按终稿让底沿与 `home-record.png` 上沿相接/少量重叠，避免露出被遮挡区域的平切边。

## 4. 主页接入点：保持逻辑，替换表现

当前接口（不要随意改 id）：

- `index.html`：`#home`、`.home-inner`、`.home-brand`、`#home-hero`、`#home-title`、`.home-tagline`、`.home-record`、`#home-best`。
- 按钮：`#home-primary` / `#home-primary-label` / `.home-primary-icon`；`#home-resume-note`；`#home-new`；`#home-leaderboard`；`#home-settings`。
- `src/ui/home.js`：`refreshHome()`、`showCover()`、`hideCover()`、`focusPrimary()`、`renderHomeBoard()`、`report()`。
- `src/main.js`：`openHome()`、`leaveHome()`、`startFromHome()`、`startNewRunFromHome()`、`continueRun()`、`beginRun()`。

### 推荐顺序

1. 将选中的资源从本包 `assets/` 拷入一个正式目录，例如 `public/art/ui-redesign/`；只拷运行时使用的资源，不拷 references/tools/previews。
2. 保留现有 DOM id 与事件；在表现层绑定新图，不重写存档分支。
3. **停止主页 live cube 的创建／绘制，并去掉 `.home-hero::after` 的旧接触阴影。** 注意 home hero 使用克隆资源；不能误 dispose 游戏实际共享的材质/几何。若 `collectDom()` 仍要求 `#home-hero`，可先保留空容器作为装饰插槽；若删除节点，需同步 DOM 契约与清理订阅/ResizeObserver。
4. 大皇冠和空白 record 底板独立摆放，`#home-best` 继续格式化实时数字。
5. 有存档：继续＋备注＋新游戏；无存档：主按钮改新游戏、隐藏第二个新游戏及空备注。**不要机械照有存档概念图永远显示两个入口。**
6. 保留 `startFromHome()` 重新读取存档的逻辑，不根据 label 或 `.resume` 猜状态。
7. 更新排行榜/新游戏/设置图标时，处理 `src/ui/icons.js` 的 `installToyIcons()` 注入：防止旧木雕 SVG 与新 PNG 同时出现。只在具体新版按钮范围隐藏旧 SVG，不全局隐藏全部图标。
8. 主页显示时游戏区与顶栏仍保持原有 `inert`/可见性策略，不能让局内道具图标浮到主页上。

### 布局参考（以 853×1844 概念稿归一化，不是固定像素 CSS）

- logo：约屏宽 88%，上半部；安全留白随短屏收紧。
- 最高分：中部，皇冠与底板形成一组；不再预留六面体 hero 的固定大块高度。
- 下半部：继续 → 存档说明 → 新游戏 → 排行榜/设置双按钮。
- 手机最小可点击高度 44px；主操作建议 ≥52px。320px 宽和短横屏允许纵向滚动/双列重排，**不可缩小文字硬塞**。
- 完整原图的绝对坐标可以帮助对照，但布局由 flex/grid/min-height 控制，不直接按 1844px 全屏等比缩放。

## 5. 设置接入点：七行功能不退化

容器：`#settings-modal > .settings-card`；头部 `.settings-header` / `#settings-title` / `#settings-close`；列表 `.settings-list`。

保留当前顺序：
1. `#language-setting` + `#language-setting-value`：语言与当前值，**非开关**。
2. `#sound-setting`：声音；同步顶栏 sound 按钮。
3. `#haptics-setting` + `#haptics-note`：触感；不支持时 disabled 和替代说明保留。
4. `#drag-turn-setting`：拖块翻面；关闭时清掉已 armed 的 dwell，不能只切图片。
5. `#controls-setting`：操作说明；`W A S D Q E` 是文字提示，不是开关。
6. `#home-setting`：回到主页；不丢进行中的存档。
7. `#restart-setting.danger`：重新开始。

- `src/ui/settings.js:updateSettingsUi()` 驱动 `.enabled` / `aria-pressed`，**不要另建一份图像状态变量**。
- `.setting-row` 现在主要是文字块＋右侧控件。加入左图标要新增明确的图标槽，并同步 `.setting-row > span:first-child` 的样式，推荐三列 `icon / minmax(0,1fr) / control`，避免旧 first-child 规则落到图标上。
- 显示 OFF 使用 `toggle-off.png`；不支持振动用行 disabled 样式，读屏状态也保持 disabled。
- 关闭按钮至少 44×44px 命中区。若用完整 `close-button.png`，隐藏原可见字形但保留 aria-label。
- 操作说明在设置上方打开；关闭后焦点返回。设置面板 `pointerdown` 外部关闭逻辑不变。
- 七行比概念稿更长，优先 `max-height:calc(100dvh - safe-area - margin); overflow-y:auto`，不要删语言行，不要压小点击高度。

## 6. HUD：区分「只换图标」和「连底板也换」

**推荐先走 A：保留现有底板，只拆图标绑定。** 当前 `src/reference.css` 的共享选择器让 `.score-chip::before` 和 `.best-chip::before` 共用 crown，拆开为：

```css
/* A：仅换图标时可保留原行定位；文件名与本包实际交付一致 */
.best-chip::before { background-image: url('/art/ui-redesign/icons/hud-crown-best.png'); }
.score-chip::before { background-image: url('/art/ui-redesign/icons/hud-trophy-score.png'); }
```

**B：如果同时换本包 `score-panel.png`，必须重新推导几何，不能照搬 A 的「保留定位」。**

- 新图为 **1181×619，宽高比约 1.908**；原图 506×295，现行 `aspect-ratio:1.72`。同宽下新图高度减少约 10%，不是只换 URL 就能保持所有元素位置。
- 同步核对 `src/reference.css` 中 `.score-plaque` 的 `aspect-ratio`、顶栏对齐公式中的 `/ 1.72` 除数与 `--plaque-board-top`。建议统一为一个比例变量，不重复硬编码。
- 同步核对道具条 `#item-bar`、`.action-bars`、`.board-section`、`.chain-chip` 所依赖的 `--plaque-width * .56` 经验高度，以及桌面／竖屏 43vw／短横屏 190px 三档尺寸。不能全局盲目替换数字；应按新牌实际投影高度重推间距。
- BEST/SCORE 的行 y、标签与数值安全区也要按新牌重新量；透明像素 bounding box 不等于可放文字的内框。
- 当前 `tools/art-alpha-box.mjs` **把基址写死在 `public/art/reference/`**，不能直接传本包路径或 `public/art/ui-redesign/` 路径。测量时可临时用独立文件名拷入它支持的基址（不要覆盖旧底板），或先明确扩展工具的路径参数支持；随后同步正式资源与截图探针的路径。
- `tools/screenshot.mjs` 会检查素材导出的顶边与 CSS 参数。资源迁到新目录后探针也要读新图，不能继续测旧 `score-panel.png` 假通过；不得删断言绕过。
- 行序仍为 **上 BEST，下 SCORE**。`#score` / best 数字沿用真实 DOM 与动画，不烘进图。
- 在 390px 竖屏、桌面、短横屏检查 HUD 与棋盘的关系；额外触发连锁状态检查 `.chain-chip`，普通静态开局截图看不到这个问题。
- 新图标 alpha 空白与旧图不同，视觉大小需实际检查，不能只比较 PNG 宽高。

## 7. CSS / i18n / 无障碍注意事项

### 接入评审补充：不要按文件名猜 CSS，也不要留下空 hero

- `home-secondary.png` 的“secondary”指本设计的次级整宽按钮 **`#home-new`**；现行 CSS 类 `.home-secondary` 实际属于排行榜/设置，用的是 `home-nav.png`，不能按同名直接映射。
- `assets/icons/settings-close-x.png` 是可选独立 X 图标；选择它时应自行提供空白关闭底；若使用已包含 X 的 `panels/close-button.png`，**不要再叠此图标或原 `×` 文本**。
- §4 中 `renderHomeBoard()` 是需要停用/移除的主页绘制入口，不是要求继续保留绘制行为。保留 `#home-hero` 空节点仅是 DOM 契约过渡，不是保留占位高度：同步检查 `toy.css` 的默认 `clamp(150px,31vh,285px)`、短屏 `140px`、短横屏 `180px` 三处，将空 hero 折叠，或由新的实际皇冠/品牌布局明确接管高度。
- `#home` 的 `aria-labelledby="home-title"` 依赖 `#home-title`。换 logo 切片时保留该标题节点（可视觉隐藏），不要直接删标题只放 `<img>`。
- **局内顶栏齿轮 `#settings-button` 本轮不包含在主页换皮范围**；先保留现有资产，若要统一成主页紫色齿轮，应单独确认并测量顶栏布局，不能顺手全局替换。

- CSS 顺序：`styles.css → toy.css → reference.css`；后者优先。检查 wood gradient、border-bottom、inset highlight 是否还叠在图片上导致双层描边/过厚阴影。
- 本包图片已经含材质和阴影；具体采用完整切片时应取消重复底纹，但若选择只换图标、不换底板，原木纹仍保留。不要一刀切全局关掉 wood texture。
- `data-i18n` 会清空所有子节点；带图标的按钮继续使用 `data-i18n-text` 或独立 label 子节点，不能语言切换后把 PNG 删除。
- UI 新文案写 `src/i18n/locales/en.js` 与 `zh-Hans.js`，不在 `src/` / `index.html` 硬写中文。
- `.home-screen` z-index 9，`.modal` 10；保持 game-over 关闭顺序与 modal 层级。
- 使用真实 `<button>`，不能用 `<img onclick>` 代替；可见焦点环不能被图片遮住；装饰层 `pointer-events:none`。
- `prefers-reduced-motion` 下保留原有减动画策略。

### 九宫格示意（不是直接覆盖全部组件的补丁）

```css
.ui-skin-nav {
  border-style: solid;
  border-color: transparent;
  border-width: 16px 28px;
  border-image-source: url('/art/ui-redesign/panels/home-nav.png');
  border-image-slice: 62 70 62 70 fill; /* 源像素，不是 62% */
  border-image-repeat: stretch;
  background: none;
  min-height: 56px;
}
```

应在目标尺寸与 2×DPR 实际检查端帽形变；若不适合当前按钮形状，可以使用固定比例图片伪元素，不要无限拉伸带花叶的底板。

## 8. 验收清单（接入后由 Jeffy 执行）

先看 [切图实际装配预览](previews/assembly-proof.png)：使用交付 PNG＋示例文字离线装配，包含当前七行设置与 ON/OFF；**不是游戏运行截图，也不取代 references 中的美术终稿**。

**尚未分离的装饰**：没有交付独立雏菊/花叶角饰。扁平图中的这些装饰与边框相互遮挡，不能把带金色边框的矩形冒充独立花簇。logo、计分牌与 record 切片保留各自可用装饰；可拉伸 `settings-modal.png` 为去角饰干净版。若要求设置卡四角完全复现终稿，需要另行提供独立装饰素材或人工描绘，不在此次切图中假造恢复。

### 本包已经做的检查
- PNG 可解码、尺寸合法、RGBA 与透明/半透明边缘检查。
- 面板与图标棋盘格预览；图片源与 hash 清单；相对链接和必需文件检查。
- 动态文字未作为可复用底图交付；OFF/背景复用等派生来源已注明。
- **本轮没有启动/测试新的游戏实现**，不把资源检查冒充功能回归。

### 接入后必须补的检查
- [ ] BEST 皇冠 / SCORE 奖杯 / 主页最高分皇冠 / 排行榜皇冠，四处无混用。
- [ ] 主页没有 live cube，也没有隐藏但持续绘制的 hero；局内六面体完全不受影响。
- [ ] 有存档：继续和新游戏均可用；无存档：不重复显示两个新游戏。
- [ ] 继续不清盘，新游戏走当前独立开局逻辑；排行榜与设置返回焦点正常。
- [ ] 语言行仍可切换；中英双语长文案不溢出；locale 切换不删除图标。
- [ ] 三个开关 ON/OFF 与偏好一致；声音与顶栏同步；无振动器设备显示 disabled；拖块翻面立即响应开关。
- [ ] 七行设置在 320×568、390×844、430×900 可达；844×390 短横屏不卡按钮；桌面 1440×900 不照搬竖屏绝对坐标。
- [ ] PNG 在浅底、深底和场景底均无明显矩形残底/边缘串色；九宫格不会拉长皇冠、花朵或开关。
- [ ] 键盘 Tab/Enter/Space/Escape 可用，44px 命中区，焦点环、读屏名称、reduced-motion 不回归。
- [ ] 按最新项目脚本执行 `npm test`、`npm run build` 与针对 home/settings/HUD 的截图检查，必要时重测 `--plaque-board-top`；不要用构建代替视觉验收。
- [ ] 版本与正式资源索引按接入范围更新；仅提交自己实际改动，避免带入并发渲染开发。

## 9. 如何重新切图

环境：Python 3 + Pillow。无需 npm 安装、无需联网、无需再次消耗 GPT 生图配额。

```powershell
python temp/ui-redesign-handoff-20260929/tools/slice_icons.py
python temp/ui-redesign-handoff-20260929/tools/slice_panels.py
python temp/ui-redesign-handoff-20260929/tools/slice_icons.py --audit
python temp/ui-redesign-handoff-20260929/tools/preview_assembly.py
python temp/ui-redesign-handoff-20260929/tools/validate_package.py
```

脚本以本包 `references/` 为输入；不要把多次重新生图叠加到这套坐标上。换源图后需重新检查所有 sourceBounds 和 alpha。

## 10. 交付边界

- `temp/` 默认被 `.gitignore` 忽略。本包作为本轮明确交付文件单独入库时不改忽略规则；其余临时文件与并发修改不纳入。
- 本包文件暂存于 temp，**不等于已经被游戏加载**；Jeffy 决定通过验收的素材再迁入 public。
- 完整参考图中的场景背景被 UI 遮挡区域无法通过切图还原。本包提供的是已有干净场景的明确复用，不把它称为本次新生成的背景。
- 开关 OFF、无字底板和可拉伸端帽是有记录的源图派生；PNG 不是矢量，放大超过源像素时会变软。

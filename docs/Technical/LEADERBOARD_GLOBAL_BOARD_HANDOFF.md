# 全局榜单 tab 交接单（v0.12.0，2026-10-02）

> 制作人口径：**「排行榜用假数据，做成最终的形式，加一个全球榜单的 tab。后面接入平台以后替换为真数据。」**
> 本单记录这一轮交付了什么、假数据在哪、真数据从哪里接进来、以及**现在还不能宣称什么**。

## 1. 交付了什么

排行榜面板从「一屏本地纪录墙」改成**两个 tab**：

| tab | 内容 | 数据来源 |
| --- | --- | --- |
| **GLOBAL 全球榜**（打开时默认） | 赛季行（`赛季 2026-W40` + 「示例数据」chip）、20 行带名次/头像/昵称/分数的榜单（前三名金属色）、固定的「我的排名」行、示例数据说明 | `src/platform/leaderboardFeed.js`（今天 = `platform/leaderboardMock.js` 的示例名单，见 §3） |
| **MY RECORDS 我的纪录** | **原封不动的 Layer 1 纪录墙**：阶位徽章、最近 N 局条形图、个人最佳、奖励统计、荣誉收集 | `src/game/records.js`（本机 `voxalblast.records.v1`） |

两个面板**都常驻 DOM**，tab 只切 `.hidden`：切换是瞬时的，任何读取其中一个面板的检查都不依赖"当前选中的是哪个 tab"，也**不会**因为切 tab 重新拉一次榜单。

涉及文件：`index.html`（面板结构 + tablist）、`src/styles.css`（tab 与榜单样式）、`src/ui/home.js`（两个面板的渲染、tab 状态、`selectTab`）、`src/ui/dom.js` + `src/main.js`（新句柄与注入）、`src/game/leaderboardRanking.js`（**纯函数**排名）、`src/platform/leaderboardFeed.js`（**取数缝**）、`src/platform/leaderboardMock.js`（示例名单）、`src/i18n/locales/*`（11 条新词条，并删掉已无用的 `leaderboard.comingSoon`）、`tools/leaderboard-tests.mjs`（新增）、`tools/refactor-ui-probe.mjs` D 段（新增 9 项）、`tools/screenshot.mjs`（新增 `leaderboard-local` 两种截图）。

## 2. 面板形态（最终形态即此形状，换真数据不改形态）

```
RANKINGS / Leaderboard
[ Global ]  [ My records ]                      ← tablist，roving tabindex，←/→ 可切
赛季 2026-W40                        [示例数据]   ← 赛季取自 records.weekKey()（周一 09:00 UTC）
 1  C  CubeKing                     76,480       ← 名次 / 头像 / 昵称 / 分数
 2  T  Tetsuya                      71,905
 3  M  Mira                         68,340
…（共 20 行；前三名金/银/铜色，其余隔行浅底）
 示例成绩为示例数据，接入平台后替换为真实数据。
我的排名  第 7 名 / 暂未上榜              12,340   ← sticky 贴底，永远不用滚才看得到
[ 打开平台榜单 ]                                  ← 仅在平台真的可打开时出现
```

三条口径写死在实现里，换真数据后**不应**改变：

1. **一个排序**：玩家的分数是**插进**榜单再排序的（`src/game/leaderboardRanking.js`），不是"榜单先排好、再单独算一次我的名次"。插进去会让下方每行名次 +1、最后一行掉出榜单 —— 这是真实服务器会有的行为，也让"两行都写着第 16 名"这种 bug 不可能出现。
2. **并列不算赢**：`Array.prototype.sort` 是稳定的，玩家行永远追加在末尾，**同分落在已经在榜的那一行之后**。并列时不给玩家虚高的名次。
3. **脏分数是 0，不是 NaN**：`name`/`score` 来自 feed（接平台后是**远端**数据），缺失、负数、非数字一律归零并在渲染前转义；NaN 会让排序不确定、并直接把 `NaN` 印到榜上。

## 3. 假数据在哪、怎么换成真数据

**假数据只有一个地方**：`src/platform/leaderboardMock.js` 的 20 个名字与分数（手工调成"按现行 v2 计分大致像真的"，**不是测量值**，`docs/Technical/DIFFICULTY_*.md` 里没有任何数字来自它）。赛季**不是**假的：它由 `records.weekKey()` 计算，和平台周赛、玩家自己的"本周最佳"同一套边界。

面板**不读这个文件**，它只读 `createLeaderboardFeed(...)`。`leaderboardFeed.global()` 的**第一个分支就是替换点**：

```js
if (typeof platform?.fetchLeaderboard === 'function') { … return { entries, season, me, sample: false } }
return { entries: board.slice(0, limit), season: weekKey(), me: null, sample: true }   // 今天
```

所以接入平台只需要：

1. 在平台适配层（`src/platform/crazygames.js` 或自建后端适配）实现 `fetchLeaderboard({ limit })`，返回 `{ entries: [{ name, score }], season?, me?: { name, score } }`；
2. 平台知道玩家的真实名次时一并返回 `me`，面板会**优先用它**（不知道就退回"本机最高分 + 榜内排名"，这条回退是真数据上线后也保留的降级路径）；
3. `sample: false` 会自动让「示例数据」chip 与说明消失 —— **面板不是被构建开关告知真假的**，是每次取数由 feed 声明的，因此"真榜单被标成示例"或"示例榜单冒充真数据"都不会发生；
4. 删除 `src/platform/leaderboardMock.js` 并把 `leaderboardFeed.js` 的默认 `board` 参数去掉即可（词条 `leaderboard.sample` / `leaderboard.sampleNote` 随之可删）。

`global()` **不 reject**：平台取数失败就静默落回示例榜单，并在面板上继续标注它是示例（面板永远不会因为网络问题空白）。

## 4. 验收证据（本轮实际跑过）

| 门禁/产物 | 结果 |
| --- | --- |
| `npm test`（含 `npm run test:i18n`） | **171/171**（键集对齐、占位符一致、无硬编码文案、无词条表外英文）；规则/存档/发牌各套全绿（554 / 205 / 72 / 146 / 61 / 56 / 13） |
| `npm run test:leaderboard`（新） | **28/28**：空榜、1..n 无缺号、插入后名次顺延且末位掉出、并列不占先、榜外仍给真名次、脏分数归零、不改调用方数组、`you` 标记不漏进榜单行 |
| `npm run probe:ui`（D 段新增 9 项） | **105 ok / 0 failed / 0 skipped**：打开即 GLOBAL、两个面板互斥、榜单 1..n、赛季非空、示例 chip+说明俱在、隐藏面板仍已渲染、我的排名与纪录本一致、点 tab 切换 + 焦点、←/→ 键切换 |
| `npm run shot`（`SHOT_ONLY=desktop-leaderboard,mobile-leaderboard,desktop-leaderboard-local,mobile-leaderboard-local`） | 4 张全绿，落 `artifacts/visual/v0.12.0-*.png`（桌面 1440×900 / 竖屏 390×844，两个 tab 各一套） |
| `npm run build` | 通过 |

截图：`artifacts/visual/v0.12.0-desktop-leaderboard.png`（全球榜）、`v0.12.0-mobile-leaderboard.png`、`v0.12.0-desktop-leaderboard-local.png`、`v0.12.0-mobile-leaderboard-local.png`。

## 5. 现在**不能**宣称什么（边界）

1. **榜单成绩是假的**。名字、分数、名次都用于确认形态，不是任何真实玩家的成绩；面板上用「示例数据」chip 与一行说明如实标注。
2. **没有读过任何平台榜单**：CrazyGames 的客户端**没有读取接口**（`showLeaderboard()` 是平台自己画），所以"真数据"要么等平台开放读取，要么走自建后端；本轮的 `fetchLeaderboard` 是**约定的接口形状**，不是已验收的 API。
3. **没有账号体系**：玩家自己的那行显示"你"，用的是本机最高分，没有昵称、头像、国家；`me` 只在平台给得出时才更准。
4. **没有周榜/总榜切换**：只有一个赛季维度（跟 `weekKey()` 平台周赛一致）。
5. **没有服务端校验/反作弊**：本机分数可以改，榜上的名次因此不能当作可发奖的依据。
6. **真机未复核**：桌面与竖屏无头浏览器截图各一套（`390×844` 与 headless 的 500px 视口下限问题见截图 skill），**没有**物理手机、微信/QQ 内嵌或平台沙箱的实测；中文文案在真机字重下的换行同样没看过。
7. 面板宽度 440px、榜 20 行、`max-height: 86vh` 的观感来自本机截图；手机上"我的排名"行贴底显示、榜身可滚动是**刻意**的（20 行不可能全屏放下），制作人若希望一屏看全，把 feed 的 `BOARD_LIMIT` 调小即可（一处改动）。

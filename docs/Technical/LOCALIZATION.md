# 本地化标准（Localization）

> 状态：**现行标准**，自 v0.9.18 起。默认语言 **英文**，首发第二语言 **简体中文（zh-Hans）**。
> 入口代码：`src/i18n/`；守卫测试：`tools/i18n-tests.mjs`（`npm test` / `npm run gates` 的第一道门）。

## 1. 为什么立这条规矩

v0.9.17 之前，游戏是"双语"的，但不是"本地化"的：设置/排行榜/结算面板是中文，状态行与提示条是英文，
道具文案又单独躺在一个 `ITEM_LANG = 'zh'` 的常量里。三个后果在真机上都是可见缺陷：

1. **同屏两种语言**：一句「Pick a shape」配一个「换批」按钮，玩家读起来像两个游戏。
2. **改一处要满仓库找**：新增一句文案要翻五个模块，改语言要改一个常量再重新构建。
3. **多语言无从下手**：每多一个语言，代价是又一轮全仓库扫描。

所以本标准的**唯一硬约束**是：**任何用户可见文本都不是字面量**，它只能来自 `src/i18n/locales/*`，
并且只能通过 `t(key)` 取。这不是"翻译工作"，是"把文案从代码里搬出去"——翻译是搬出去之后才可能的事。

## 2. 文件与职责

| 路径 | 职责 |
| --- | --- |
| `src/i18n/index.js` | 语言解析、`t()`、`formatNumber()`、静态标记重写、切换与订阅。**唯一的语言状态持有者。** |
| `src/i18n/locales/en.js` | 英文词条表。**默认语言**，也是任何缺失键的兜底。 |
| `src/i18n/locales/zh-Hans.js` | 简体中文词条表。键集必须与 en 完全一致。 |
| `index.html` | 静态文案：内联**英文**（默认语言）+ `data-i18n*` 标记。 |
| `src/ui/itemCopy.js` | 道具子系统的取词门面（getter 形式），调用点因此不需要改。 |
| `src/platform/storage.js` | `voxalblast-locale` 偏好键（字符串偏好，带兜底）。 |
| `tools/i18n-tests.mjs` | 守卫：键集对齐、id→键存在、标记合法、无游离字面量。 |
| `tools/refactor-ui-probe.mjs` H 段 | 浏览器验收：默认英文、单键切换、深链、无键泄漏。 |

## 3. 语言解析顺序（`resolveInitialLocale()`）

1. URL 查询参数 `?lang=`（QA / 商店深链 / 截图工具用），支持别名 `zh` `zh-CN` `zh_CN` `en-US` 等；
2. 本机偏好 `voxalblast-locale`（玩家在设置里选过）；
3. **`DEFAULT_LOCALE = 'en'`**。

**故意不嗅探 `navigator.language`**。「默认英文」是产品决定，不能被浏览器头静默覆盖；而且一个可预测的
默认值才是无头门能断言的东西。要开启自动探测，就是在第 1、2 步之间插一行 `normalizeLocale(navigator.language)`，
代码里已标注位置。

## 4. 加一条文案（日常动作）

```js
// en.js
'toast.saved': 'Saved',
'pop.faces': ({ n }) => `${n} FACE${n === 1 ? '' : 'S'}`,
// zh-Hans.js
'toast.saved': '已保存',
'pop.faces': ({ n }) => `${n} 面`,
```

```js
import { t } from '../i18n/index.js'
setStatus(t('toast.saved'))
setStatus(t('pop.faces', { n: count }))
```

规则：

- **键名分层**：`区域.用途`（`status.*` `toast.*` `item.*` `home.*` `settings.*` `controls.*`
  `gameover.*` `leaderboard.*` `honor.<ID>.*` `record.<key>` `tier.<n>.*` `hud.*` `a11y.*`）。
- **值可以是字符串或函数**。单复数、量词、语序**留在语言文件里**：英文 `1 block / 2 blocks`
  是英语的语法，不是调用方该知道的事，中文那份直接忽略 `{n === 1}`。
- **占位符必须两边一致**：`{n}` / `{points}` 的名字写错不会报错，只会把 `{points}` 印在屏幕上，
  所以守卫把两边的占位符集合逐键比对。
- **未知键会原样返回键名**（`t('item.zzz') === 'item.zzz'`），这是故意的：漏翻译在截图里一眼可见，
  而空字符串没人看得见。守卫另有一条"页面上不得出现任何键名"的检查。

## 5. 加一种语言

1. 复制 `en.js` 为 `locales/<id>.js`，逐键翻译（键集不许增删）。
2. 在 `src/i18n/index.js` 的 `LOCALES` 里加一行 `{ id, label: '<该语言的自称>', htmlLang }`，
   在 `ALIASES` 里补别名（`zh-Hant` `ja` `ko` …）。
   行里的 `label` 用**自称**（中文显示「简体中文」而不是 "Chinese"）——语言选择器用一个外语词
   命名语言是经典错误。
3. 跑 `npm test`（守卫会替你找出漏键、空值、占位符漂移）。
4. 出该语言的截图：`node tools/screenshot.mjs "http://127.0.0.1:5173/?lang=<id>" artifacts/visual-<id>`。

## 6. 运行时切换：**不许捕获**

玩家在设置面板里点一下语言行就要立刻生效，所以任何模块级常量都是 bug：

```js
// ✗ 导入时求值 → 切换后永远是旧语言
const HINT = t('item.tapHint')
// ✓ 渲染时求值
function render() { el.textContent = t('item.tapHint') }
```

需要"表"形态的地方用 **getter**，`src/ui/itemCopy.js` 是范例（`Object.defineProperty` 定义 getter；
`Object.assign` 会把 getter 当场求值成一个死字符串，这正是它要避免的）。

切换后的重绘分工：

- **静态标记**：`applyStatic()` 自己重写（`data-i18n` / `data-i18n-text` / `data-i18n-aria-label` /
  `data-i18n-title`）。
- **动态文本**：`src/main.js` 的 `onLocaleChange()` 订阅里重绘——状态行按暂停状态**重算**（而不是记住），
  候选槽、道具条、主页、排行榜、结算卡各自用现有的渲染函数重画一遍。不新增第二套渲染路径。

`data-i18n-text` 只改元素自己的文字节点，用于**按钮里已经有图标 `<span>`** 的场合：给标签再套一层
`<span>` 会多出一个 flex gap，图标会被推走。

## 7. 数字与格式

`toLocaleString('en-US')` 一律换成 `formatNumber(value)`：`1,234.5` 与 `1 234,5` 是同一个数。
分数补零（`padStart(4,'0')`）是显示规格，不随语言变。

## 8. 数据模块里不许有显示文案

`src/game/honors.js`、`tiers.js`、`records.js` 只存 **id / 键**，不存显示文本：

- 荣誉 → `honor.<id>.label` / `honor.<id>.title`，结算卡与荣誉墙按 id 取词；
- 阶位 → `tier.<n>.name` / `tier.<n>.title`；
- 个人最佳 → `RECORD_FIELDS[].labelKey`。

理由有两条，缺一不可：这些模块被 Node 规则测试在**没有 DOM** 的环境里导入（带不出语言状态），
而且一份中文标签躺在数据里就是**第二个真源**——语言切换永远够不到它。v0.9.18 顺手删掉了
`gameSession.js` 里 `ITEM_TOOLS[].name`（同样是从没被读过的第二份道具名）。

唯一豁免：`src/game/dealConfig.js` / `dealDirector.js` 里的**发牌分析词汇**（「恢复：几乎总能找到出路」等）。
它们是策划自己的分析分类，只出现在离线报告与 DEV 只读钩子里，没有任何 `t()` 调用点能到达它们；
翻译它们等于翻译分析口径而不是界面。守卫里以显式白名单 + 理由记录在案。

## 9. 守卫（`tools/i18n-tests.mjs`）

| # | 检查 | 防的是什么 |
| --- | --- | --- |
| 1 | 两份词条表键集完全相同、无空值、值类型合法、占位符一致 | 漏译、错译参数名 |
| 2 | 荣誉 / 纪录 / 阶位 / 道具的 id 都能取到词 | 数据与词条表脱节 |
| 3 | `index.html` 里每个 `data-i18n*` 都指向真键 | 标记打错字 |
| 4 | `src/**/*.js` 与 `index.html` 里没有硬编码中文（注释除外，词条表除外） | 中文文案回流到代码 |
| 5 | 英文词条表里的每个值都不得在词条表之外以字面量出现 | **英文**文案回流（第 4 条看不见这一种） |

第 4、5 条靠一个真正的 JS 词法扫描器（区分注释/字符串/模板串），不是正则：这个仓库里满是
"引用被替换掉的旧文案"的注释，正则分不清两者。

浏览器侧验收在 `tools/refactor-ui-probe.mjs` 的 H 段：默认英文 → 点语言行 → HUD/道具条/状态行/主页
整体变中文 → 偏好落盘 → 再点回来 → `?lang=zh-Hans` 首帧即中文 → 两处都断言**页面上没有键名泄漏**。

## 10. 常见错误

| 症状 | 原因 |
| --- | --- |
| 屏幕上出现 `item.tapHint` | 键名写错或该键只在另一份语言里存在；跑 `npm run test:i18n` |
| 切了语言，某块文字没变 | 那里是导入时捕获的常量，改成渲染时 `t()` |
| 中文里出现 `{points}` | 两份占位符名字不一致 |
| 按钮文字把图标挤走 | 用了 `data-i18n`（会清空子元素），该用 `data-i18n-text` |
| 守卫报「literal duplicated from the catalogue」 | 又把英文文案写回了代码，改成 `t()` |

// Every string the item interaction puts on screen (07-道具系统设计.md §8.10), read from the
// shared i18n catalogue (docs/Technical/LOCALIZATION.md).
//
// Why this file still exists now that src/i18n owns the text: the item interaction is the one
// subsystem whose copy table is a DESIGN ARTEFACT (07 §8.10 ships both columns, 中文策划文案 and
// 英文界面建议) and its 25 strings are reviewed as a table, not one call site at a time. The
// facade keeps that review surface readable while the strings themselves live in the locale
// files, where every other string lives.
//
// READ IT LIVE, NEVER CAPTURE IT. The player can switch language from the settings panel, so
// `const hint = ITEM_COPY.tapHint` would freeze the old language. Every plain property below is
// a GETTER and every function reads the active locale at call time — which is why the two call
// sites in ui/hud.js and the four in input/gameInput.js never had to change.
import { hasKey, t } from '../i18n/index.js'

// key -> catalogue key, one table for the whole subsystem. A missing entry throws at import
// (see the check at the bottom) rather than printing `undefined` under an icon.
const ITEM_COPY_KEY = Object.freeze({
  // 8.2 / 8.4 — the two paths, told apart by where the gesture started.
  dragHint: 'item.dragHint',
  dragHintRocket: 'item.dragHintRocket',
  tapHint: 'item.tapHint',
  // 8.5.2 — the aiming pointer has left the front face's own grid.
  offFace: 'item.offFace',
  // 8.5.5 — the whole scope is empty: previewable, not submittable.
  noTarget: 'item.noTarget',
  // 8.8 — the refresh confirmation, asked inside the tray.
  refreshConfirm: 'item.refreshConfirm',
  refreshKeep: 'item.refreshKeep',
  refreshGo: 'item.refreshGo',
  // 8.3 — the strip and the status bar.
  cancel: 'item.cancel',
  dragCancelTitle: 'item.dragCancelTitle',
  dragCancelNote: 'item.dragCancelNote',
  pieceCancelTitle: 'item.pieceCancelTitle',
  pieceCancelNote: 'item.pieceCancelNote',
  empty: 'item.empty',
  // 8.4 — the sacrifice the mode makes, said out loud instead of silently ignored.
  lockedRotate: 'item.lockedRotate',
  // 8.9 — a failed snapshot check: the release happened on a frame the player never saw.
  stale: 'item.stale',
  // The undo bar. 取消 ≠ 撤销, so the two never share a word.
  undo: 'item.undo',
})

// The parameterised entries: they are called as ITEM_COPY.clearN(3), so they are plain
// functions. Each one reads the active locale per call.
const ITEM_COPY_FN = Object.freeze({
  // 8.5.4 — N is the unique-lattice count that will actually disappear.
  clearN: (n) => t('item.clearN', { n }),
  clearRelease: (n) => t('item.clearRelease', { n }),
  // 8.6 — the bomb's scope was cut by the face edge instead of being slid inwards.
  clipped: (area, n) => t('item.clipped', { area, n }),
  use: (n) => t('item.use', { n }),
  clearedN: (n) => t('item.clearedN', { n }),
  restoredN: (n) => t('item.restoredN', { n }),
})

// Built with defineProperty rather than Object.assign: Object.assign would INVOKE each getter
// once and copy the resulting string, which is exactly the stale capture this file exists to
// avoid. Every plain name stays a live getter; the parameterised ones are functions.
const live = {}
for (const [name, key] of Object.entries(ITEM_COPY_KEY)) {
  Object.defineProperty(live, name, { get: () => t(key), enumerable: true })
}
Object.assign(live, ITEM_COPY_FN)
Object.defineProperty(live, 'shared', { get: () => t('item.shared'), enumerable: true })

export const ITEM_COPY = Object.freeze(live)

// The four tools' display names. The picker strip shows them under the icons (07 §8.3: 「四个
// 图标始终配名称与次数，不让玩家仅凭 emoji 猜功能」); the ids themselves never change. Also
// live getters, for the same reason as above — renderItemBar() repaints them on a switch.
export const ITEM_NAME = Object.freeze({
  get refresh() { return t('item.name.refresh') },
  get hammer() { return t('item.name.hammer') },
  get rocket() { return t('item.name.rocket') },
  get bomb() { return t('item.name.bomb') },
})

export function itemName(id) { return ITEM_NAME[id] || id }

// A typo in either table is a build-time failure, not a blank caption on a live board: this
// runs on import wherever the module is loaded, and tools/i18n-tests.mjs imports it directly.
for (const key of [...Object.values(ITEM_COPY_KEY), 'item.shared']) {
  if (!hasKey(key)) throw new Error(`itemCopy: missing i18n key "${key}"`)
}
for (const id of ['refresh', 'hammer', 'rocket', 'bomb']) {
  if (!hasKey(`item.name.${id}`)) throw new Error(`itemCopy: missing i18n key "item.name.${id}"`)
}

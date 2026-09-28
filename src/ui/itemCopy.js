// Every string the item interaction v1 puts on screen (07-道具系统设计.md §8.10).
//
// Why a file of its own: the doc's copy table ships BOTH columns — 中文策划文案 and
// 英文界面建议 — and the rest of the game is bilingual for historical reasons (the modals read
// 设置/排行榜/操作说明, the in-game status line and toasts read "Pick a shape" / "No spot -
// clear a path"). Deciding which language a NEW string is born in should be one edit in one
// place, not a hunt through five modules; and the copy is a design artefact that the producer
// owns, so it must be reviewable without reading any logic.
//
// The doc's Chinese column is the planning source (`中文策划文案`), the English one is a
// suggestion (`英文界面建议`), so Chinese is the default. Switching the whole item interaction
// to English is `ITEM_LANG = 'en'` and nothing else.
const ITEM_LANG = 'zh'

const COPY = Object.freeze({
  zh: Object.freeze({
    // 8.2 / 8.4 — the two paths, told apart by where the gesture started.
    dragHint: '拖到棋盘，松手使用',
    dragHintRocket: '拖到棋盘，松手使用 · 可先选方向',
    tapHint: '点选目标，再点使用',
    // 8.5.2 — the aiming pointer has left the front face's own grid.
    offFace: '移到正面棋格',
    // 8.5.5 — the whole scope is empty: previewable, not submittable.
    noTarget: '这里没有可清除方块',
    // 8.5.4 — N is the unique-lattice count that will actually disappear.
    clearN: (n) => `将清除 ${n} 格`,
    clearRelease: (n) => `将清除 ${n} 格 · 松手使用`,
    // 8.5.6 — an edge/corner cell is shared with a neighbouring face.
    shared: '边缘共享格会同步清除',
    // 8.6 — the bomb's scope was cut by the face edge instead of being slid inwards.
    clipped: (area, n) => `边缘裁切 · 范围 ${area} 格 / 将清除 ${n} 格`,
    // 8.8 — the refresh confirmation, asked inside the tray.
    refreshConfirm: '替换当前整批候选，消耗 1 次；新批不保证可放。',
    refreshKeep: '保留当前',
    refreshGo: '换一批 · −1',
    // 8.3 — the strip and the status bar.
    use: (n) => `使用 · −${n}`,
    cancel: '✕ 取消',
    dragCancelTitle: '拖到这里取消',
    dragCancelNote: '松手取消',
    pieceCancelTitle: 'Cancel',
    pieceCancelNote: 'placement',
    empty: '本局已用完',
    // 8.4 — the sacrifice the mode makes, said out loud instead of silently ignored.
    lockedRotate: '需换面？取消后转动棋盘',
    // 8.9 — a failed snapshot check: the release happened on a frame the player never saw.
    stale: '未使用，请重新瞄准',
    // The undo bar. 取消 ≠ 撤销, so the two never share a word.
    clearedN: (n) => `已清除 ${n} 格`,
    undo: '撤销',
    restoredN: (n) => `已恢复 ${n} 格`,
  }),
  en: Object.freeze({
    dragHint: 'Drag to the board. Release to use.',
    dragHintRocket: 'Drag to the board. Release to use · pick a direction first',
    tapHint: 'Pick a target, then tap Use',
    offFace: 'Move onto the front grid',
    noTarget: 'Nothing to clear here',
    clearN: (n) => `Clear ${n} block${n === 1 ? '' : 's'}`,
    clearRelease: (n) => `Clear ${n} block${n === 1 ? '' : 's'} · Release to use`,
    shared: 'Edge-shared cells clear too',
    clipped: (area, n) => `Clipped at edge · Area: ${area} cells / Clear ${n} blocks`,
    refreshConfirm: 'Replace the whole batch? Costs 1. The new batch may not fit.',
    refreshKeep: 'Keep current',
    refreshGo: 'Refresh · −1',
    use: (n) => `Use · −${n}`,
    cancel: '✕ Cancel',
    dragCancelTitle: 'Drag here to cancel',
    dragCancelNote: 'Release to cancel',
    pieceCancelTitle: 'Cancel',
    pieceCancelNote: 'placement',
    empty: 'None left this run',
    lockedRotate: 'Cancel to turn the cube',
    stale: 'Not used — aim again',
    clearedN: (n) => `Cleared ${n}`,
    undo: 'Undo',
    restoredN: (n) => `Restored ${n}`,
  }),
})

export const ITEM_COPY = COPY[ITEM_LANG]

// The four tools' display names. The picker strip shows them under the icons (07 §8.3: 「四个
// 图标始终配名称与次数，不让玩家仅凭 emoji 猜功能」); the ids themselves never change.
export const ITEM_NAMES = Object.freeze({
  zh: Object.freeze({ refresh: '换批', hammer: '锤子', rocket: '火箭', bomb: '炸弹' }),
  en: Object.freeze({ refresh: 'Refresh', hammer: 'Hammer', rocket: 'Rocket', bomb: 'Bomb' }),
})

export const ITEM_NAME = ITEM_NAMES[ITEM_LANG]

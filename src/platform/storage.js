// Storage boundary — 执行计划 §2「platform/storage.js：local storage 访问边界；不新增云存档行为」.
//
// Three things live here, and nothing else:
//   1. pickStorage()  — is there a global localStorage we are allowed to touch at all?
//   2. probeStorage() — does a given Storage-like object really accept a write?
//   3. the two boolean preferences the UI owns, in their shipped 'on'/'off' form.
//
// What deliberately does NOT live here (计划 §6 P8):
//   - Schema, migrate() and the memory fallback stay in records.js / session.js. This is
//     the boundary, not a second implementation — a fallback copied here would be a
//     second place for it to drift (第 3 条).
//   - Cloud sync, async writes, the CrazyGames data module (第 5 条). The platform's data
//     API is unverified (08 §7.2), so calling it here would put an untestable guess on a
//     live path. Future extension point, not a call.
//   - Any guarding of the preference path (第 4 条): readPreferenceOn/writePreferenceOn
//     forward localStorage exactly as ui/settings.js used it — the same 'on'/'off' strings,
//     the same default ON when the key is absent, and the same throw when storage is
//     disabled. Safe degradation for preferences is a separate fix, not a refactor side
//     effect (docs/Technical/KNOWN_GAPS.md「偏好存储」).
//
// The two probe keys the old code carried ('voxalblast.records.probe' and
// 'voxalblast.records.v1.probe') collapse into PROBE_KEY below. Both were written and
// removed inside the same call, so nothing observable changes except the name of the
// stray key left behind if removeItem is itself the thing that throws.
const PROBE_KEY = 'voxalblast.storage.probe'

// The preference keys, one place for both literals. These values are shipped: renaming
// one would silently reset every existing player's sound/haptics choice.
const PREFERENCE_KEYS = Object.freeze({
  sound: 'voxalblast-sound',
  haptics: 'voxalblast-haptics',
})

// The global storage, or null when there is none or it throws on access: Safari private
// mode, storage disabled, an embedded webview that throws instead of returning null.
export function pickStorage() {
  try {
    const storage = globalThis.localStorage
    if (!storage) return null
    storage.setItem(PROBE_KEY, '1')
    storage.removeItem(PROBE_KEY)
    return storage
  } catch {
    return null
  }
}

// A storage that lies about being usable (setItem throwing, quota gone, an embedded
// webview that throws on access instead of returning null) is treated as no storage at
// all, so `persistent` reports the truth and every write goes to memory.
export function probeStorage(storage) {
  if (!storage) return null
  try {
    storage.setItem(PROBE_KEY, '1')
    storage.removeItem(PROBE_KEY)
    return storage
  } catch {
    return null
  }
}

// A boolean preference as the settings panel stores it: 'off' is the only value that
// means off, anything else — including a missing key — reads as on. `storage` is a test
// seam in the same shape as createRecordStore(rawStorage); the game calls both of these
// with the default.
export function readPreferenceOn(name, storage = globalThis.localStorage) {
  return storage.getItem(PREFERENCE_KEYS[name]) !== 'off'
}

export function writePreferenceOn(name, on, storage = globalThis.localStorage) {
  storage.setItem(PREFERENCE_KEYS[name], on ? 'on' : 'off')
}

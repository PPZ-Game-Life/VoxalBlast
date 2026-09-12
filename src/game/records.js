// Local records — docs/Planning/08-荣誉与排行榜系统.md §7.3 (Layer 1).
//
// Layer 1 is the one leaderboard layer that needs no backend and no CrazyGames
// invitation, so it is the layer that must always work. Three things drive the
// shape of this file:
//
//  1. THE WEEK BOUNDARY IS NOT OURS. CrazyGames weekly seasons reset Monday 09:00
//     UTC; a local "this week" computed any other way drifts a day against the
//     platform season the player sees. weekKey() shifts 9h, then bins by ISO week,
//     so both agree by construction.
//  2. STORAGE CAN BE MISSING AND THAT IS NOT AN ERROR. Private mode, disabled
//     storage, an embedded webview — every read and write here is guarded, and a
//     failure degrades to an in-memory record set. A records layer that can throw
//     would take the first frame down with it.
//  3. VERSIONED SNAPSHOT, MIGRATED ON READ. `v` + migrate() means adding a field
//     later never wipes a player's history.
const STORAGE_KEY = 'voxalblast.records.v1'
export const RECORDS_VERSION = 1
const RECENT_LIMIT = 10
// CrazyGames weekly season boundary: Monday 09:00 UTC. Shifting the timestamp by
// the offset lets a plain ISO-week binning land on the platform's week.
const WEEK_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// Personal bests, with the label the UI prints. Keeping the labels here means a
// new dimension is one entry, not one entry plus a switch in main.js.
export const RECORD_FIELDS = Object.freeze([
  Object.freeze({ key: 'maxChain', label: '最长链' }),
  Object.freeze({ key: 'maxLinesOneMove', label: '单次最多线数' }),
  Object.freeze({ key: 'maxFacesOneMove', label: '单次最多面数' }),
  Object.freeze({ key: 'facesLitBest', label: '点亮面数' }),
  Object.freeze({ key: 'faceWipes', label: '净面' }),
  Object.freeze({ key: 'pureCubes', label: '净体' }),
])

const RECORD_KEYS = RECORD_FIELDS.map((field) => field.key)

function emptyRecords() {
  return {
    v: RECORDS_VERSION,
    best: { score: 0, at: 0 },
    weekly: { key: null, score: 0 },
    records: {
      maxChain: 0,
      maxLinesOneMove: 0,
      maxFacesOneMove: 0,
      faceWipes: 0,
      pureCubes: 0,
      facesLitBest: 0,
      gamesPlayed: 0,
    },
    honors: {},
    recent: [],
  }
}

const toCount = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)

// ISO-8601 week id ("2026-W37") for the CrazyGames week (Mon 09:00 UTC boundary).
export function weekKey(now = new Date()) {
  const shifted = new Date((Number.isFinite(now) ? now : now.getTime()) - WEEK_OFFSET_MS)
  const dayFromMonday = (shifted.getUTCDay() + 6) % 7
  const thursday = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - dayFromMonday + 3,
  ))
  const year = thursday.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4FromMonday = (jan4.getUTCDay() + 6) % 7
  const week1Monday = Date.UTC(year, 0, 4 - jan4FromMonday)
  const week = Math.round((thursday.getTime() - week1Monday) / (7 * DAY_MS)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

// Everything the store needs to survive a snapshot that is old, partial or from a
// future version: unknown versions keep whatever fields we still recognise rather
// than resetting the player's history (08 §7.3 — never clear the save to add a
// field).
export function migrate(raw) {
  const records = emptyRecords()
  if (!raw || typeof raw !== 'object') return records
  const best = raw.best || {}
  records.best = { score: toCount(best.score), at: toCount(best.at) }
  const weekly = raw.weekly || {}
  records.weekly = { key: typeof weekly.key === 'string' ? weekly.key : null, score: toCount(weekly.score) }
  const stats = raw.records || {}
  RECORD_KEYS.forEach((key) => { records.records[key] = toCount(stats[key]) })
  records.records.gamesPlayed = toCount(stats.gamesPlayed)
  if (raw.honors && typeof raw.honors === 'object') {
    Object.entries(raw.honors).forEach(([id, times]) => {
      const count = toCount(times)
      if (count > 0) records.honors[id] = count
    })
  }
  if (Array.isArray(raw.recent)) {
    records.recent = raw.recent
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        score: toCount(entry.score),
        lines: toCount(entry.lines),
        chain: toCount(entry.chain),
        facesLit: toCount(entry.facesLit),
        honors: Array.isArray(entry.honors) ? entry.honors.filter((id) => typeof id === 'string') : [],
        at: toCount(entry.at),
      }))
      .slice(0, RECENT_LIMIT)
  }
  records.v = RECORDS_VERSION
  return records
}

function pickStorage() {
  try {
    const storage = globalThis.localStorage
    if (!storage) return null
    const probe = 'voxalblast.records.probe'
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return storage
  } catch {
    // Safari private mode, storage disabled, or an embedded webview that throws
    // on access instead of returning null.
    return null
  }
}

// A storage that lies about being usable (setItem throwing, quota gone, an embedded
// webview that throws on access instead of returning null) is treated as no storage
// at all, so `persistent` reports the truth and every write goes to memory.
function probeStorage(storage) {
  if (!storage) return null
  try {
    const probe = `${STORAGE_KEY}.probe`
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return storage
  } catch {
    return null
  }
}

// A store over some Storage-like object. `createRecordStore(fakeStorage)` is what
// the tests use; the game uses the default instance below.
export function createRecordStore(rawStorage = pickStorage()) {
  const storage = probeStorage(rawStorage)
  let memory = emptyRecords()

  const read = () => {
    if (!storage) return memory
    try {
      const raw = storage.getItem(STORAGE_KEY)
      return raw ? migrate(JSON.parse(raw)) : emptyRecords()
    } catch {
      // Corrupt JSON, quota errors, a storage revoked mid-session: fall back to
      // whatever this session already recorded rather than dropping to zero.
      return memory
    }
  }

  const write = (records) => {
    memory = records
    if (!storage) return false
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(records))
      return true
    } catch {
      return false
    }
  }

  return {
    persistent: Boolean(storage),
    all: read,
    // One finished run. `facesLit` is how many distinct faces cleared at least
    // once (§8.4's 六面制霸 progress); `faceWipes` is the count of moves that
    // emptied a face. Returns everything the Game Over panel and the record wall
    // need, so neither has to re-read storage to render.
    recordRun(run = {}) {
      const records = read()
      const score = toCount(run.score)
      const at = Number.isFinite(run.at) ? run.at : Date.now()
      const previousBest = records.best.score
      const isNewBest = score > previousBest
      const gapToBest = isNewBest ? 0 : previousBest - score
      const gapRatio = previousBest > 0 ? gapToBest / previousBest : 1

      const broken = []
      RECORD_KEYS.forEach((key) => {
        const value = toCount(run[key])
        if (value <= 0) return
        if (value > records.records[key]) {
          broken.push({ key, label: RECORD_FIELDS.find((field) => field.key === key).label, value, previous: records.records[key] })
          records.records[key] = value
        }
      })
      records.records.gamesPlayed += 1

      const ids = Array.isArray(run.honors) ? run.honors.filter((id) => typeof id === 'string') : []
      ids.forEach((id) => { records.honors[id] = toCount(records.honors[id]) + 1 })

      const weeklyKey = weekKey(at)
      let weeklyImproved = false
      if (records.weekly.key !== weeklyKey) {
        records.weekly = { key: weeklyKey, score }
        weeklyImproved = score > 0
      } else if (score > records.weekly.score) {
        records.weekly.score = score
        weeklyImproved = true
      }

      records.recent.unshift({
        score,
        lines: toCount(run.lines),
        chain: toCount(run.chain),
        facesLit: toCount(run.facesLit),
        honors: ids,
        at,
      })
      records.recent = records.recent.slice(0, RECENT_LIMIT)
      if (isNewBest) records.best = { score, at }

      const saved = write(records)
      return {
        isNewBest,
        previousBest,
        bestScore: records.best.score,
        gapToBest,
        gapRatio,
        weeklyBest: records.weekly.score,
        weeklyKey,
        weeklyImproved,
        broken,
        honors: { ...records.honors },
        recent: records.recent.slice(),
        persistent: saved,
      }
    },
    weeklyBest(at = Date.now()) {
      const records = read()
      return records.weekly.key === weekKey(at) ? records.weekly.score : 0
    },
    best: () => read().best,
  }
}

export const recordStore = createRecordStore()

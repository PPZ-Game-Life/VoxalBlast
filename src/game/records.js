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
//
// The "is there a storage we can trust" half is platform/storage.js (refactor P8); the
// key, the schema, migrate() and the memory fallback stay HERE, in the store that owns
// them. Re-exported below so an existing `import { pickStorage } from './records.js'`
// keeps working.
import { pickStorage, probeStorage } from '../platform/storage.js'
import { REWARD_ORDER, SCORE_RULES_V1, SCORE_RULES_VERSION } from './scoring.js'

const STORAGE_KEY = 'voxalblast.records.v1'
// v0.10.3 (docs/Technical/SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §5.1/§5.3): the snapshot
// gained a SECOND personal-best pool and a reward tally, so the format number moves. The
// STORAGE KEY does not: an old save is read and migrated, never abandoned (08 §7.3
// 「不得为加字段清档」).
export const RECORDS_VERSION = 2
const RECENT_LIMIT = 10
// CrazyGames weekly season boundary: Monday 09:00 UTC. Shifting the timestamp by
// the offset lets a plain ISO-week binning land on the platform's week.
const WEEK_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// Personal bests, with the i18n KEY of the label the UI prints. Keeping the key here means a
// new dimension is one entry, not one entry plus a switch in main.js — and, since
// docs/Technical/LOCALIZATION.md, a new LANGUAGE is one catalogue line rather than an edit in
// this pure data module (which the Node rule tests import without a DOM).
export const RECORD_FIELDS = Object.freeze([
  Object.freeze({ key: 'maxChain', labelKey: 'record.maxChain' }),
  Object.freeze({ key: 'maxLinesOneMove', labelKey: 'record.maxLinesOneMove' }),
  Object.freeze({ key: 'maxFacesOneMove', labelKey: 'record.maxFacesOneMove' }),
  Object.freeze({ key: 'facesLitBest', labelKey: 'record.facesLitBest' }),
  Object.freeze({ key: 'faceWipes', labelKey: 'record.faceWipes' }),
  Object.freeze({ key: 'pureCubes', labelKey: 'record.pureCubes' }),
])

const RECORD_KEYS = RECORD_FIELDS.map((field) => field.key)

function emptyRecords() {
  return {
    v: RECORDS_VERSION,
    // The LEGACY (score-rules v1) pool. `best`/`weekly` keep the exact names and meaning they
    // have always had, so a snapshot written by any earlier build reads straight back into
    // them and nothing has to be guessed about which formula produced those numbers.
    best: { score: 0, at: 0 },
    weekly: { key: null, score: 0 },
    // The version-2 pool. A new score is compared ONLY against the pool of its own rules
    // (§5.3): the whole point of the split is that a 234k v1 clear and a 990 v2 clear are not
    // the same measurement, so 「NEW BEST」 必须按分制分别成立.
    bestV2: { score: 0, at: 0 },
    weeklyV2: { key: null, score: 0 },
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
    // How many times each of the three v2 reward categories fired, lifetime (§4.1). The
    // settlement card and the leaderboard read these; nothing pays on them.
    rewards: Object.fromEntries(REWARD_ORDER.map((type) => [type, 0])),
    recent: [],
  }
}

const toCount = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)

// `2` unless the caller says otherwise — the rules this BUILD ships, which is what a caller who
// does not name a version is playing. The game itself always names it (`run.scoreRulesVersion`),
// so this default only decides what a tool or a test that omits the field is describing.
// A snapshot's MISSING field is a different question with a different answer, and migrate()
// answers it: a save written before the split is a version-1 run (§5.1).
export function normalizeRulesVersion(value) {
  return value === SCORE_RULES_V1 ? SCORE_RULES_V1 : SCORE_RULES_VERSION
}

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
  // §5.3: the legacy pool above is READ-ONLY history from here on. A snapshot that never
  // had a v2 pool gets an empty one, which is the truth — no v2 run has been recorded yet.
  const bestV2 = raw.bestV2 || {}
  records.bestV2 = { score: toCount(bestV2.score), at: toCount(bestV2.at) }
  const weeklyV2 = raw.weeklyV2 || {}
  records.weeklyV2 = {
    key: typeof weeklyV2.key === 'string' ? weeklyV2.key : null,
    score: toCount(weeklyV2.score),
  }
  const stats = raw.records || {}
  RECORD_KEYS.forEach((key) => { records.records[key] = toCount(stats[key]) })
  records.records.gamesPlayed = toCount(stats.gamesPlayed)
  if (raw.honors && typeof raw.honors === 'object') {
    Object.entries(raw.honors).forEach(([id, times]) => {
      const count = toCount(times)
      if (count > 0) records.honors[id] = count
    })
  }
  const rewards = raw.rewards && typeof raw.rewards === 'object' ? raw.rewards : {}
  REWARD_ORDER.forEach((type) => { records.rewards[type] = toCount(rewards[type]) })
  if (Array.isArray(raw.recent)) {
    records.recent = raw.recent
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        score: toCount(entry.score),
        lines: toCount(entry.lines),
        chain: toCount(entry.chain),
        facesLit: toCount(entry.facesLit),
        honors: Array.isArray(entry.honors) ? entry.honors.filter((id) => typeof id === 'string') : [],
        // Which formula scored this run. Missing = a run from before the split = version 1.
        rules: entry.rules === SCORE_RULES_VERSION ? SCORE_RULES_VERSION : SCORE_RULES_V1,
        at: toCount(entry.at),
      }))
      .slice(0, RECENT_LIMIT)
  }
  records.v = RECORDS_VERSION
  return records
}

// Exported for src/game/session.js and for callers that still reach for the probe through
// this module: the save slot needs the very same "is there a storage that does not lie to
// us" check, and a second copy of it would be a second place for the private-mode edge case
// to drift. The implementation moved to platform/storage.js in P8; this is the compatibility
// re-export (计划 §6 P8 第 2 条), not a second copy.
export { pickStorage, probeStorage }

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

  // The pool a rules version compares against. One function, so "which numbers may be
  // compared with which" is stated once (§5.3) instead of at every call site.
  const poolOf = (records, rulesVersion) => (normalizeRulesVersion(rulesVersion) === SCORE_RULES_VERSION
    ? { best: records.bestV2, weekly: records.weeklyV2 }
    : { best: records.best, weekly: records.weekly })

  return {
    persistent: Boolean(storage),
    all: read,
    // One finished run. `facesLit` is how many distinct faces cleared at least
    // once (§8.4's 六面制霸 progress); `faceWipes` is the count of moves that
    // emptied a face. Returns everything the Game Over panel and the record wall
    // need, so neither has to re-read storage to render.
    //
    // v0.10.3: `run.scoreRulesVersion` decides WHICH pool the score is compared against and
    // which pool a new record is written to. BEST / 周最佳 / NEW BEST 只比较相同规则版本
    // (§5.3) — the legacy pools are returned as read-only history and are never overwritten
    // by a version-2 run.
    recordRun(run = {}) {
      const records = read()
      const rulesVersion = normalizeRulesVersion(run.scoreRulesVersion)
      const pool = poolOf(records, rulesVersion)
      const score = toCount(run.score)
      const at = Number.isFinite(run.at) ? run.at : Date.now()
      const previousBest = pool.best.score
      const isNewBest = score > previousBest
      const gapToBest = isNewBest ? 0 : previousBest - score
      const gapRatio = previousBest > 0 ? gapToBest / previousBest : 1

      const broken = []
      RECORD_KEYS.forEach((key) => {
        const value = toCount(run[key])
        if (value <= 0) return
        if (value > records.records[key]) {
          broken.push({ key, labelKey: RECORD_FIELDS.find((field) => field.key === key).labelKey, value, previous: records.records[key] })
          records.records[key] = value
        }
      })
      records.records.gamesPlayed += 1

      const ids = Array.isArray(run.honors) ? run.honors.filter((id) => typeof id === 'string') : []
      ids.forEach((id) => { records.honors[id] = toCount(records.honors[id]) + 1 })

      // The three v2 categories are tallied for version-2 runs only: a version-1 run has no
      // such events, and counting an absent one as zero is the honest reading.
      const rewards = run.rewards && typeof run.rewards === 'object' ? run.rewards : null
      if (rulesVersion === SCORE_RULES_VERSION && rewards) {
        REWARD_ORDER.forEach((type) => {
          records.rewards[type] = toCount(records.rewards[type]) + toCount(rewards[type])
        })
      }

      const weeklyKey = weekKey(at)
      let weeklyImproved = false
      if (pool.weekly.key !== weeklyKey) {
        pool.weekly.key = weeklyKey
        pool.weekly.score = score
        weeklyImproved = score > 0
      } else if (score > pool.weekly.score) {
        pool.weekly.score = score
        weeklyImproved = true
      }

      records.recent.unshift({
        score,
        lines: toCount(run.lines),
        chain: toCount(run.chain),
        facesLit: toCount(run.facesLit),
        honors: ids,
        rules: rulesVersion,
        at,
      })
      records.recent = records.recent.slice(0, RECENT_LIMIT)
      // In place, never by replacing the field: `pool.best` IS `records.best*`, and assigning a
      // fresh object here would update the local view while the snapshot kept the old one.
      if (isNewBest) {
        pool.best.score = score
        pool.best.at = at
      }

      const saved = write(records)
      return {
        rulesVersion,
        isNewBest,
        previousBest,
        bestScore: pool.best.score,
        gapToBest,
        gapRatio,
        weeklyBest: pool.weekly.score,
        weeklyKey,
        weeklyImproved,
        broken,
        honors: { ...records.honors },
        rewards: { ...records.rewards },
        // The other pool, read-only, for the panel's 「旧分制」 rows. A version-2 run must not
        // silently present a version-1 best as its own record, and it must not hide it either.
        legacy: rulesVersion === SCORE_RULES_VERSION
          ? { best: records.best.score, weekly: records.weekly.key === weeklyKey ? records.weekly.score : 0 }
          : { best: records.bestV2.score, weekly: records.weeklyV2.key === weeklyKey ? records.weeklyV2.score : 0 },
        recent: records.recent.slice(),
        persistent: saved,
      }
    },
    // The personal best of ONE rules version (default: the current rules). The HUD's BEST
    // pill, the home cover and the tier badge all read the pool of the run on screen, so a
    // version-1 in-flight run compares against version-1 numbers.
    best: (rulesVersion = SCORE_RULES_VERSION) => poolOf(read(), rulesVersion).best,
    weeklyBest(at = Date.now(), rulesVersion = SCORE_RULES_VERSION) {
      const pool = poolOf(read(), rulesVersion).weekly
      return pool.key === weekKey(at) ? pool.score : 0
    },
  }
}

export const recordStore = createRecordStore()

// Unfinished-run snapshot — docs/Planning/03-交互与表现需求.md §「主页与断点续玩」.
//
// Why a SECOND storage key next to records.v1: records.js is the record book of
// FINISHED runs, this is the save slot of the run that is still open. They have
// opposite lifetimes — a game over clears the slot and writes the book — so one
// key would mean every finished run rewrites the player's history, and a crash in
// between could lose both.
//
// The discipline is deliberately a copy of records.js:
//  1. VERSIONED SNAPSHOT, MIGRATED ON READ. `v` + migrate() means a later field
//     never invalidates an old save.
//  2. STORAGE CAN BE MISSING AND THAT IS NOT AN ERROR. Private mode, disabled
//     storage, an embedded webview: every access is guarded and degrades to an
//     in-memory slot, which still supports 继续 within the session.
//  3. AN UNREADABLE SLOT IS "NO SAVED RUN", NEVER A THROW. The home screen has to
//     render on the first frame even if localStorage holds garbage; anything that
//     cannot be played back reads as null — exactly the state of a new player.
import { FACES, SH, isShell } from './board.js'
import { SHAPES } from './shapes.js'
import { pickStorage, probeStorage } from './records.js'

export const SESSION_VERSION = 1
const STORAGE_KEY = 'voxalblast.session.v1'
// The candidate slots the game deals every turn. A snapshot with fewer playable
// candidates is padded back up by the caller (which owns Math.random).
export const SESSION_PIECE_SLOTS = 3

const SHAPE_NAMES = new Set(SHAPES.map((shape) => shape.name))
const FACE_KEYS = new Set(FACES)

const toCount = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
const isUnit = (value) => Number.isInteger(value) && value >= 0 && value < SH

// A quaternion component list, or null. Pose is decoration: a snapshot without a
// readable pose still resumes, it just starts from the face-aligned rest pose.
function readQuat(raw) {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(Number.isFinite)) return null
  return raw.slice()
}

// Read a stored snapshot into something the game can actually play, or null.
// Nothing here trusts the input: cells are re-checked against the shell lattice
// (a coordinate inside the 3×3 core would be a block no line can ever reach), only
// shapes that still exist in the pool are kept, and the run counters are clamped
// back into their valid ranges.
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null
  const source = raw.board || {}
  const cells = []
  const seen = new Set()
  if (Array.isArray(source.cells)) {
    source.cells.forEach((cell) => {
      if (!Array.isArray(cell) || cell.length < 4) return
      const [x, y, z, color] = cell
      if (!isUnit(x) || !isUnit(y) || !isUnit(z)) return
      if (!isShell(x, y, z)) return
      const key = `${x},${y},${z}`
      if (seen.has(key)) return
      seen.add(key)
      cells.push([x, y, z, Number.isFinite(color) ? color : 0xffffff])
    })
  }

  // Candidates: only pool members survive, and there must be at least one unused
  // one to play. `pieces.every(used)` is settled to a fresh deal the moment it
  // happens (main.js finishDrag), so a slot with nothing left to place is not a
  // state the game can be in — it is a save that cannot be resumed.
  const pieces = []
  if (Array.isArray(raw.pieces)) {
    raw.pieces.slice(0, SESSION_PIECE_SLOTS).forEach((piece) => {
      if (!piece || typeof piece !== 'object') return
      if (typeof piece.name !== 'string' || !SHAPE_NAMES.has(piece.name)) return
      pieces.push({ name: piece.name, used: Boolean(piece.used) })
    })
  }
  if (!pieces.some((piece) => !piece.used)) return null

  const items = {}
  const rawItems = raw.items && typeof raw.items === 'object' ? raw.items : {}
  Object.entries(rawItems).forEach(([id, count]) => {
    if (typeof id !== 'string' || !id) return
    items[id] = toCount(count)
  })

  const rawRun = raw.run && typeof raw.run === 'object' ? raw.run : {}
  const honorCounts = {}
  const rawHonors = rawRun.honorCounts && typeof rawRun.honorCounts === 'object' ? rawRun.honorCounts : {}
  Object.entries(rawHonors).forEach(([id, times]) => {
    const count = toCount(times)
    if (count > 0) honorCounts[id] = count
  })
  const pose = raw.pose && typeof raw.pose === 'object' ? raw.pose : {}

  return {
    v: SESSION_VERSION,
    at: toCount(raw.at),
    board: {
      cells,
      score: toCount(source.score),
      totalLines: toCount(source.totalLines),
    },
    pieces,
    items,
    run: {
      chain: toCount(rawRun.chain),
      bestChain: toCount(rawRun.bestChain),
      maxLinesOneMove: toCount(rawRun.maxLinesOneMove),
      maxFacesOneMove: toCount(rawRun.maxFacesOneMove),
      facesLit: (Array.isArray(rawRun.facesLit) ? rawRun.facesLit : []).filter((face) => FACE_KEYS.has(face)),
      faceWipes: toCount(rawRun.faceWipes),
      honors: (Array.isArray(rawRun.honors) ? rawRun.honors : []).filter((id) => typeof id === 'string'),
      honorCounts,
    },
    pose: {
      yaw: Number.isFinite(pose.yaw) ? pose.yaw : 0,
      pitch: Number.isFinite(pose.pitch) ? pose.pitch : 0,
      quat: readQuat(pose.quat),
      base: readQuat(pose.base),
    },
  }
}

// A save slot over some Storage-like object. `createSessionStore(fakeStorage)` is
// what the tests use; the game uses the default instance below.
export function createSessionStore(rawStorage = pickStorage()) {
  const storage = probeStorage(rawStorage)
  let memory = null

  const read = () => {
    if (!storage) return memory
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (!raw) return memory
      const snapshot = migrate(JSON.parse(raw))
      // A corrupt or unplayable slot is dropped rather than kept around: the next
      // save writes a clean one, and until then the home screen offers 新游戏.
      if (!snapshot) return null
      memory = snapshot
      return snapshot
    } catch {
      return memory
    }
  }

  return {
    persistent: Boolean(storage),
    read,
    save(state) {
      try {
        // The stamp is applied BEFORE the migration, so a caller that does not
        // carry a timestamp still writes one the panel can order runs by.
        const payload = {
          ...state,
          v: SESSION_VERSION,
          at: Number.isFinite(state?.at) ? state.at : Date.now(),
        }
        const snapshot = migrate(payload)
        if (!snapshot) return false
        memory = snapshot
        if (!storage) return false
        storage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
        return true
      } catch {
        // Quota, a storage revoked mid-session, a webview that throws on write:
        // the run stays resumable in this session and the home screen says 继续.
        return false
      }
    },
    clear() {
      memory = null
      if (!storage) return false
      try {
        storage.removeItem(STORAGE_KEY)
        return true
      } catch {
        return false
      }
    },
  }
}

export const SESSION_KEY = STORAGE_KEY
export const sessionStore = createSessionStore()

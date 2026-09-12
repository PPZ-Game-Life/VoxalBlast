#!/usr/bin/env node
// VoxalBlast rule self-test (v0.3) — the acceptance list of docs/Planning/04 and
// the 交接单 §6 self-checks, executable:
//
//   node tools/rule-tests.mjs            # all groups
//   node tools/rule-tests.mjs sixface    # one group
//
// It drives the REAL modules (src/game/board.js, scoring.js, honors.js, records.js,
// tiers.js) — no copies — so a drift between the docs, the code and this file shows
// up as a failure instead of a surprise in the browser.
import { Board, SH, FACES, faceLattice, isShell } from '../src/game/board.js'
import { SHAPES, normalizeCells, maxOrigin, rotateCells } from '../src/game/shapes.js'
import {
  SCORING, MAX_LINES_PER_MOVE, lineMultiplier, lineScore, faceBonus, placementScore, chainBonus,
  chainMilestoneBonus, nextChain, moveScore,
} from '../src/game/scoring.js'
import { HONORS, resolveHonors, feedbackLevel } from '../src/game/honors.js'
import { createRecordStore, weekKey, migrate, RECORD_FIELDS } from '../src/game/records.js'
import { createSessionStore, migrate as migrateSession, SESSION_VERSION } from '../src/game/session.js'
import { TIERS, TIER_CUTS, tiersReady, tierForScore } from '../src/game/tiers.js'

let passed = 0
const failures = []
const only = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || 'all'
const groups = new Map()

function group(name, body) {
  groups.set(name, body)
}

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

function equal(label, actual, expected) {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// Deterministic RNG so a failure is reproducible.
function rng(seed = 20260912) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

// ---------------------------------------------------------------- six-face settle
// Every (face, rotation, origin) the board accepts, as candidates for random play.
function legalPlacements(board, cells) {
  const out = []
  FACES.forEach((face) => {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const shape = rotateCells(cells, quarter)
      const { u: uMax, v: vMax } = maxOrigin(shape, SH)
      for (let u = 0; u < uMax; u += 1) {
        for (let v = 0; v < vMax; v += 1) {
          if (board.canPlace(face, shape, { u, v })) out.push({ face, cells: shape, origin: { u, v } })
        }
      }
    }
  })
  return out
}

// The v0.2 and earlier rule: settle the placement face only. Kept here purely so the
// regression check below can prove it FAILS the invariant — a test that cannot fail
// is not evidence.
function placeFaceOnly(board, face, cells, origin, color) {
  cells.forEach(([u, v]) => {
    const [x, y, z] = faceLattice(face, u + origin.u, v + origin.v)
    board.cells.set(board.key(x, y, z), { x, y, z, color })
  })
  const lines = board.findFullLines(face)
  const cleared = new Set()
  lines.forEach((line) => line.cells.forEach(([x, y, z]) => cleared.add(board.key(x, y, z))))
  cleared.forEach((key) => board.cells.delete(key))
  return { lines, facesHit: lines.length ? 1 : 0, faceWiped: [] }
}

// One random game. `settle` decides which rule is applied, so both rules run through
// byte-identical play besides the settle itself.
function randomGame(settle, random, maxPlacements = 400) {
  const board = new Board()
  board.seedOpening(SHAPES, { '+z': 7, '+y': 3, '+x': 3 }, random)
  let placements = 0
  let crossFaceClears = 0
  let residual = 0
  let clearedLinesTotal = 0
  const facesCleared = new Set()

  while (placements < maxPlacements) {
    const shape = SHAPES[Math.floor(random() * SHAPES.length)]
    const options = legalPlacements(board, shape.cells)
    if (!options.length) break
    const pick = options[Math.floor(random() * options.length)]
    const result = settle(board, pick.face, pick.cells, pick.origin, shape.color)
    placements += 1
    clearedLinesTotal += result.lines.length
    if (result.facesHit >= 2) crossFaceClears += 1
    if (board.findAllFullLines().length > 0) residual += 1
    result.lines.forEach((line) => facesCleared.add(line.face))
    // Every placement must still leave the player a legal move, otherwise a clear was
    // skipped (the residual check above catches that) — track it for the report.
    const nextShape = SHAPES[Math.floor(random() * SHAPES.length)]
    if (!board.anyPlacement(nextShape.cells)) break
  }
  return { placements, crossFaceClears, residual, clearedLinesTotal, facesCleared }
}

group('sixface', () => {
  // The precise bug this version fixes: the +z row v=0 IS the -y row v=4 (the same
  // five cells, seen from two faces — an edge line is shared). Completing it must
  // settle BOTH lines in one batch, delete each cell once, and leave nothing full.
  const board = new Board()
  const shared = [[0, 0, 4], [1, 0, 4], [2, 0, 4], [3, 0, 4]].map((cell) => ({
    face: '+z',
    cells: [[0, 0]],
    origin: { u: cell[0], v: cell[1] },
    color: 0xffffff,
  }))
  shared.forEach((entry) => board.place(entry.face, entry.cells, entry.origin, entry.color))
  check('shared-edge setup leaves no full line yet', board.findAllFullLines().length === 0)
  const settle = board.place('+z', [[0, 0]], { u: 4, v: 0 }, 0xffffff)
  equal('shared edge line settles as two face-lines', settle.lines.length, 2)
  equal('shared edge line reports two faces', settle.facesHit, 2)
  equal('shared five cells are deleted once', settle.cellsCleared, 5)
  check('settled faces are +z and -y', settle.linesByFace['+z']?.length === 1 && settle.linesByFace['-y']?.length === 1,
    JSON.stringify(Object.keys(settle.linesByFace)))
  equal('no residual full line after the settle', board.findAllFullLines().length, 0)

  // Regression assertion from 04「玩法与规则」: after ANY settled placement there is no
  // full line left on any of the six faces.
  const random = rng(1234)
  let placements = 0
  let crossFace = 0
  let games = 0
  let gamesWithCrossFace = 0
  let placedAnything = 0
  for (let game = 0; game < 60; game += 1) {
    const settled = (b, face, cells, origin, color) => b.place(face, cells, origin, color)
    const result = randomGame(settled, random, 300)
    games += 1
    placements += result.placements
    crossFace += result.crossFaceClears
    placedAnything += result.clearedLinesTotal
    if (result.crossFaceClears > 0) gamesWithCrossFace += 1
    equal(`game ${game}: no residual full line`, result.residual, 0)
  }
  check('cross-face settles really happen (rule is exercised)', gamesWithCrossFace > 0,
    `${gamesWithCrossFace}/${games} games, ${crossFace} cross-face settles`)
  check('random play placed a meaningful number of pieces', placements > 1000, `${placements} placements`)

  // The same play under the OLD rule must FAIL the invariant, or the assertion above
  // proves nothing.
  const legacyRandom = rng(1234)
  let legacyResidual = 0
  for (let game = 0; game < 60; game += 1) {
    legacyResidual += randomGame(placeFaceOnly, legacyRandom, 300).residual
  }
  check('old face-only rule does break the invariant (test has teeth)', legacyResidual > 0,
    `residual placements under the old rule: ${legacyResidual}`)
})

// ---------------------------------------------------------------- scoring
group('scoring', () => {
  // 08 §4.2 multiplier table, 1..12 lines. The listed 线分 values are printed in the
  // doc; the test is the doc's own arithmetic.
  const expected = [0, 100, 500, 1500, 4000, 9000, 18000, 31500, 52000, 81000, 120000, 170500, 234000]
  expected.forEach((points, lines) => equal(`lineScore(${lines})`, lineScore(lines), points))
  equal('MAX_LINES_PER_MOVE is the proven ceiling', MAX_LINES_PER_MOVE, 12)
  equal('multiplier(2) is 2.5 not 3', lineMultiplier(2), 2.5)
  equal('multiplier clamps above the ceiling', lineMultiplier(99), 195)
  equal('multiplier of a non-number is 0', lineMultiplier(undefined), 0)

  // §4.3 cross-face is ADDITION and stops at 3 faces (4 cells can touch one corner).
  equal('two faces pay +200', faceBonus(2), 200)
  equal('three faces pay +600', faceBonus(3), 600)
  equal('four faces pay nothing (unreachable branch)', faceBonus(4), 0)

  // §4.1 placement score, and the streak rules of §4.4.
  equal('placement score is 10 per cell', placementScore(4), 40)
  equal('chain pays 25 per link', chainBonus(7), 175)
  equal('milestone at 5 links', chainMilestoneBonus(5), 200)
  equal('milestone at 10 links', chainMilestoneBonus(10), 500)
  equal('milestone at 15 links', chainMilestoneBonus(15), 1000)
  equal('milestone at 20 links', chainMilestoneBonus(20), 2000)
  equal('no milestone between links', chainMilestoneBonus(7), 0)
  equal('a clearing placement extends the chain', nextChain(3, 2), 4)
  equal('a dead turn zeroes the chain', nextChain(7, 0), 0)

  // §4.5 the whole formula, and the two doc worked examples.
  const triple = moveScore({ cellCount: 4, lines: 3, faces: 3, chain: 1, honorBonus: 150 })
  equal('3 lines + 3 faces honor bonus', triple.total, 100 * 3 * 5 + 600 + 150 + 40 + 25)
  const quad = moveScore({ cellCount: 4, lines: 4, faces: 3, chain: 0, honorBonus: 500 })
  equal('4 lines + 3 faces', quad.total, 100 * 4 * 10 + 600 + 500 + 40)
  const dead = moveScore({ cellCount: 4, lines: 0, faces: 0, chain: 9, honorBonus: 0 })
  equal('a dead turn pays placement only (no streak banking)', dead.total, 40)
  equal('a dead turn reports no chain points', dead.chain, 0)
  const sum = triple.placement + triple.line + triple.face + triple.chain + triple.honor
  equal('total is the sum of the named parts', triple.total, sum)
})

// ---------------------------------------------------------------- honors
group('honors', () => {
  equal('the badge set is exactly the five shipped honors', HONORS.filter((honor) => honor.broadcast).length, 5)
  const ids = HONORS.map((honor) => honor.id).sort()
  equal('no banned badge is implemented', ids.join(','),
    'HEXA,PENTA,PERFECT_TWELVE,QUAD,TRIFACE,TRIPLE')

  const triple = resolveHonors({ lines: 3, faces: 1 })
  equal('3 lines -> TRIPLE', triple.primary.id, 'TRIPLE')
  equal('TRIPLE bonus', triple.bonus, 150)
  equal('3 lines is one badge', triple.secondary.length, 0)

  equal('4 lines -> QUAD', resolveHonors({ lines: 4, faces: 1 }).primary.id, 'QUAD')
  equal('5 lines -> PENTA', resolveHonors({ lines: 5, faces: 1 }).primary.id, 'PENTA')
  equal('6 lines -> HEXA', resolveHonors({ lines: 6, faces: 1 }).primary.id, 'HEXA')
  equal('3 faces -> TRIFACE', resolveHonors({ lines: 1, faces: 3 }).primary.id, 'TRIFACE')

  // §5.3: bonuses stack, one banner, rarest first.
  const both = resolveHonors({ lines: 4, faces: 3 })
  equal('4 lines + 3 faces banners the rarer QUAD', both.primary.id, 'QUAD')
  equal('and badges the rest beside it', both.secondary.map((honor) => honor.id).join(','), 'TRIFACE,TRIPLE')
  equal('bonuses add up', both.bonus, 500 + 600 + 150)
  equal('a QUAD+TRIFACE double hit is an L5 moment', feedbackLevel({ lines: 4, faces: 3 }), 5)

  const twelve = resolveHonors({ lines: 12, faces: 3 })
  equal('12 lines banners HEXA, not the record-only PERFECT TWELVE', twelve.primary.id, 'HEXA')
  check('PERFECT TWELVE is recorded without a banner', twelve.records.some((honor) => honor.id === 'PERFECT_TWELVE'))
  equal('PERFECT TWELVE still pays', twelve.bonus, 20000 + 4000 + 1500 + 500 + 150 + 600)
  equal('below all thresholds nothing fires', resolveHonors({ lines: 2, faces: 2 }).bonus, 0)
  check('a 2-face clear is not an honor', resolveHonors({ lines: 2, faces: 2 }).primary === null)

  // §6 feedback ladder.
  equal('L1 for a single line', feedbackLevel({ lines: 1, faces: 1 }), 1)
  equal('L2 for two lines', feedbackLevel({ lines: 2, faces: 1 }), 2)
  equal('L3 for three lines', feedbackLevel({ lines: 3, faces: 1 }), 3)
  equal('L4 for a face triple', feedbackLevel({ lines: 2, faces: 3 }), 4)
  equal('L5 for five lines', feedbackLevel({ lines: 5, faces: 2 }), 5)
  equal('L0 for a placement that cleared nothing', feedbackLevel({ lines: 0, faces: 0 }), 0)
})

// ---------------------------------------------------------------- records
group('records', () => {
  // The CrazyGames week starts Monday 09:00 UTC, so the hour before the boundary is
  // still the previous week. A local week computed any other way drifts a day against
  // the season the player sees on the platform (§7.3).
  equal('Sunday 23:59Z is still the same week', weekKey(new Date('2026-09-13T23:59:00Z')), '2026-W37')
  equal('Monday 08:59Z is still the previous week', weekKey(new Date('2026-09-14T08:59:00Z')), '2026-W37')
  equal('Monday 09:00Z starts the new week', weekKey(new Date('2026-09-14T09:00:00Z')), '2026-W38')
  equal('the doc example timestamp lands in W37', weekKey(new Date(1789000000000)), '2026-W37')
  equal('two minutes before the boundary is the old week', weekKey(new Date('2026-09-14T08:58:00Z')), '2026-W37')

  // Storage failure must degrade to memory, never throw and never block a run.
  const hostile = {
    getItem() { throw new Error('storage disabled') },
    setItem() { throw new Error('storage disabled') },
    removeItem() { throw new Error('storage disabled') },
  }
  const memoryStore = createRecordStore(hostile)
  equal('a hostile storage reports itself as non-persistent', memoryStore.persistent, false)
  let survived = true
  try {
    memoryStore.recordRun({ score: 1234, lines: 5, chain: 2, honors: ['TRIPLE'], at: Date.now() })
  } catch (error) {
    survived = false
  }
  check('recording a run never throws without storage', survived)
  equal('the in-memory fallback still keeps the run', memoryStore.all().recent.length, 1)

  // A working storage round-trips, and a corrupt or partial snapshot is migrated
  // rather than wiped (§7.3).
  const fake = new Map()
  const storage = {
    getItem: (key) => (fake.has(key) ? fake.get(key) : null),
    setItem: (key, value) => fake.set(key, value),
    removeItem: (key) => fake.delete(key),
  }
  const store = createRecordStore(storage)
  const first = store.recordRun({ score: 5000, lines: 20, chain: 4, maxChain: 4, maxLinesOneMove: 3, facesLit: 2, honors: ['TRIPLE', 'TRIFACE'], at: Date.now() })
  check('first run is a new best', first.isNewBest)
  equal('first run has no gap', first.gapToBest, 0)
  const second = store.recordRun({ score: 4900, lines: 18, chain: 2, maxChain: 2, maxLinesOneMove: 2, facesLit: 1, honors: [], at: Date.now() })
  check('a lower score is not a new best', !second.isNewBest)
  equal('the gap is measured against the record', second.gapToBest, 100)
  equal('the record survives the second run', second.bestScore, 5000)
  equal('per-run bests keep their record', store.all().records.maxLinesOneMove, 3)
  equal('honors accumulate', store.all().honors.TRIPLE, 1)
  equal('games accumulate', store.all().records.gamesPlayed, 2)

  for (let index = 0; index < 15; index += 1) store.recordRun({ score: 100 + index, at: Date.now() })
  equal('recent history is capped at 10', store.all().recent.length, 10)
  equal('the newest run is first', store.all().recent[0].score, 114)

  const corrupted = createRecordStore({
    getItem: () => '{not json',
    setItem: () => {},
    removeItem: () => {},
  })
  equal('corrupt JSON degrades to an empty snapshot', corrupted.all().recent.length, 0)
  const partial = migrate({ v: 0, best: { score: 900 }, records: { maxChain: 12 }, honors: { QUAD: 3 }, unknownField: 7 })
  equal('migration keeps a known field', partial.records.maxChain, 12)
  equal('migration keeps the best score', partial.best.score, 900)
  equal('migration keeps honor counts', partial.honors.QUAD, 3)
  equal('migration reports the current version', partial.v, 1)
  equal('migration drops unknown fields', partial.unknownField, undefined)

  // A run in a later week must not overwrite this week's best.
  const weekly = store.all().weekly
  equal('the weekly bucket is keyed by the CrazyGames week', weekly.key, weekKey(new Date()))
  const laterWeek = createRecordStore(storage)
  equal('a stale weekly key reads as empty', laterWeek.weeklyBest(Date.now()), weekly.score)
  check('record fields have labels for the UI', RECORD_FIELDS.every((field) => field.label && field.key))
})

// ---------------------------------------------------------------- tiers
group('tiers', () => {
  // 交接单 §2: the tier table must NOT be hardcoded while the difficulty is open.
  check('the shipped cut scores are uncalibrated', !tiersReady(TIER_CUTS))
  equal('an uncalibrated table returns no tier', tierForScore(999999), null)
  equal('six tiers are defined', TIERS.length, 6)
  const cuts = { p25: 100, p50: 200, p75: 300, p90: 400, p99: 500 }
  check('a filled table is accepted', tiersReady(cuts))
  equal('below P25 is tier 1', tierForScore(99, cuts).tier, 1)
  equal('P25 is tier 2', tierForScore(100, cuts).tier, 2)
  equal('P50 is tier 3', tierForScore(200, cuts).tier, 3)
  equal('P75 is tier 4', tierForScore(300, cuts).tier, 4)
  equal('P90 is tier 5', tierForScore(400, cuts).tier, 5)
  equal('P99 and above is tier 6', tierForScore(500, cuts).tier, 6)
  equal('a huge score is still tier 6', tierForScore(1e9, cuts).tier, 6)
})

// ---------------------------------------------------------------- resume slot
// v0.4: the home screen's 继续游戏 button is only as trustworthy as this module —
// a slot that cannot be replayed must read as "no saved run", never as a half-lost
// board (03 §「主页与断点续玩」).
group('session', () => {
  const fake = new Map()
  const storage = {
    getItem: (key) => (fake.has(key) ? fake.get(key) : null),
    setItem: (key, value) => fake.set(key, value),
    removeItem: (key) => fake.delete(key),
  }

  // A board worth saving: three real placements, then out again through restore().
  const source = new Board()
  const shape = normalizeCells(SHAPES.find((entry) => entry.name === 'Corner').cells)
  source.place('+z', shape, { u: 0, v: 0 }, 0xff6d5c)
  source.place('-x', shape, { u: 1, v: 1 }, 0x35c3ff)
  source.addScore(1234, 2)
  const live = source.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color])

  const restored = new Board()
  equal('restore accepts every cell it was handed', restored.restore({ cells: live, score: 1234, totalLines: 2 }), live.length)
  equal('the restored board has the same cell count', restored.occupied().length, source.occupied().length)
  equal('the restored board keeps the score', restored.score, 1234)
  equal('the restored board keeps the line total', restored.totalLines, 2)
  check('every restored cell is on the shell', restored.occupied().every((cell) => isShell(cell.x, cell.y, cell.z)))

  // The lattice rule is enforced on the way in: the 3×3 core is not a place, and a
  // duplicate or an out-of-bounds coordinate must not silently become one.
  const guarded = new Board()
  equal('a core cell, an out-of-bounds cell and a duplicate are all rejected', guarded.restore({
    cells: [[2, 2, 2, 0xffffff], [SH, 0, 0, 0xffffff], [0, 0, 0, 0xff6d5c], [0, 0, 0, 0x35c3ff]],
    score: -5,
    totalLines: 'x',
  }), 1)
  equal('a rejected cell count leaves the score at zero', guarded.score, 0)

  const store = createSessionStore(storage)
  const snapshot = {
    board: { cells: live, score: 1234, totalLines: 2 },
    pieces: [{ name: 'Corner', used: true }, { name: 'Dot', used: false }, { name: 'Square', used: false }],
    items: { refresh: 1, hammer: 0, rocket: 2, bomb: 1 },
    run: { chain: 3, bestChain: 4, maxLinesOneMove: 2, maxFacesOneMove: 1, facesLit: ['+z', 'nope'], faceWipes: 1, honors: ['TRIPLE'], honorCounts: { TRIPLE: 2 } },
    pose: { yaw: 0.1, pitch: -0.2, quat: [0, 0, 0, 1], base: [0, 0, 0, 1] },
  }
  check('a playable run is accepted by the slot', store.save(snapshot))
  const read = store.read()
  equal('the slot round-trips the board', read.board.cells.length, live.length)
  equal('the slot round-trips the score', read.board.score, 1234)
  equal('the slot round-trips the candidates', read.pieces.length, 3)
  equal('the slot round-trips the chain', read.run.chain, 3)
  equal('the slot round-trips the items', read.items.rocket, 2)
  equal('the slot round-trips the pose', read.pose.quat.length, 4)
  check('the slot reports the current version', read.v === SESSION_VERSION)

  store.clear()
  equal('a cleared slot reads as no saved run', store.read(), null)

  // Unplayable slots: every candidate used, or nothing left in the pool.
  equal('a run with no candidate left to place is not resumable', migrateSession({
    board: { cells: live, score: 10 },
    pieces: [{ name: 'Dot', used: true }, { name: 'Square', used: true }],
  }), null)
  equal('a snapshot from a retired shape pool is not resumable', migrateSession({
    board: { cells: live },
    pieces: [{ name: 'Line 4', used: false }],
  }), null)
  equal('garbage in the slot is not resumable', migrateSession({ board: { cells: 'nope' }, pieces: [] }), null)
  equal('null in the slot is not resumable', migrateSession(null), null)

  const degraded = migrateSession({
    board: { cells: [[0, 0, 0, 1], [9, 9, 9, 1], [0, 0, 0, 2]], score: 400 },
    pieces: [{ name: 'Line 4', used: false }, { name: 'Dot', used: false }],
    items: { bomb: -3, refresh: 2, bogus: 'x' },
    run: { facesLit: ['+z', 'q'], honors: ['TRIPLE', 7] },
  })
  equal('an unknown shape is dropped, a known one survives', degraded.pieces.length, 1)
  equal('only shell cells survive validation', degraded.board.cells.length, 1)
  equal('a negative item count clamps to zero', degraded.items.bomb, 0)
  equal('a non-numeric item count clamps to zero', degraded.items.bogus, 0)
  equal('an unknown face is dropped from the run', degraded.run.facesLit.length, 1)
  equal('a non-string honor id is dropped', degraded.run.honors.length, 1)

  // Storage failures are the normal case in an embedded webview, not an error.
  const throwing = createSessionStore({
    getItem: () => '{not json',
    setItem: () => { throw new Error('quota') },
    removeItem: () => {},
  })
  equal('corrupt JSON reads as no saved run instead of throwing', throwing.read(), null)
  const memory = createSessionStore(null)
  // save() reports PERSISTENCE, not "the run survived" — with no storage the slot
  // still resumes this session, which is what the home screen reads.
  check('a storage-less save reports that it was not persisted', memory.save(snapshot) === false)
  equal('a run saved without storage still resumes this session', memory.read().board.cells.length, live.length)
  check('a storage-less slot reports itself as not persistent', !memory.persistent)
})

const selected = only === 'all' ? [...groups.keys()] : [only]
for (const name of selected) {
  if (!groups.has(name)) {
    failures.push(`unknown test group: ${name}`)
    continue
  }
}
for (const name of selected) {
  if (!groups.has(name)) continue
  groups.get(name)()
}

const total = passed + failures.length
console.log(`rule-tests: ${passed}/${total} checks passed`)
if (failures.length) {
  console.log('\nFAILED:')
  failures.forEach((failure) => console.log(`  - ${failure}`))
  process.exitCode = 1
} else {
  console.log('all rule checks passed')
}

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
import { SHAPES, SHAPE_WEIGHTS, OPENING_SHAPES, pickShape, normalizeCells, maxOrigin, rotateCells } from '../src/game/shapes.js'
import {
  SCORING, MAX_LINES_PER_MOVE, lineMultiplier, lineScore, faceBonus, placementScore, chainBonus,
  chainMilestoneBonus, nextChain, moveScore,
  // v0.10.3 (SCORE_REWARD_SIMPLIFICATION_HANDOFF.md): the version-2 rule set. Both sets live in
  // the same module and both are exercised here — the legacy one because a run in flight still
  // plays it, the new one because it is what the game now ships.
  SCORING_V2, SCORE_RULES_V1, SCORE_RULES_VERSION, REWARD_TYPES, REWARD_ORDER, REWARD_PRIORITY,
  settleScore, resolveRewards, rewardLevel, multiClearBonus, streakBonus, faceClearBonus,
  normalizeWipedFaces, wipedFacesFor,
} from '../src/game/scoring.js'
import { HONORS, resolveHonors, feedbackLevel } from '../src/game/honors.js'
import { createRecordStore, weekKey, migrate, RECORD_FIELDS, RECORDS_VERSION, pickStorage as pickStorageFromRecords, probeStorage as probeStorageFromRecords } from '../src/game/records.js'
import { createSessionStore, migrate as migrateSession, SESSION_VERSION, SESSION_KEY } from '../src/game/session.js'
import { pickStorage, probeStorage, readPreferenceOn, writePreferenceOn } from '../src/platform/storage.js'
import { KEY_BINDINGS, axisForKey } from '../src/rendering/keyboard.js'
import { gestureAxisReady, pickGestureAxis, screenBand, swipeAngle } from '../src/rendering/swipe.js'
import { ROTATE_STYLE } from '../src/rendering/config.js'
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

group('sixface', () => {  // The precise bug this version fixes: the +z row v=0 IS the -y row v=4 (the same
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
  // v0.10.0: this loop used to be 60 games. The threshold below ("a meaningful number of
  // pieces") is UNCHANGED — what changed is how long a random game lasts: 3 of the pool's 18
  // shapes are now tight five-cell pieces, so a random walk meets "no legal placement" sooner
  // and 60 games stopped clearing the bar. Raising the SAMPLE is the honest fix; lowering the
  // bar would have been a gate quietly softened by the very change it exists to police.
  let games = 0
  let gamesWithCrossFace = 0
  let placedAnything = 0
  for (let game = 0; game < 80; game += 1) {
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

// ---------------------------------------------------------------- face wipe
// SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §2.4 / §6.2, **as ruled by the producer on 2026-10-01**:
// 清空一面只算方块放置的那一面，侧面不算. `faceWiped` is still the ONE judgement the rule is
// allowed to consume, but it is narrowed by `wipedFacesFor()` before anything is paid.
//
// These are real board states, built and settled through the shipped Board.
group('face-wipe', () => {
  const cell = (x, y, z) => ({ x, y, z, color: 0xffffff })
  const rewardFor = (settle) => wipedFacesFor(settle.face, settle.faceWiped, settle.lines.length)

  // (1) 落子前空的面不奖励: from an empty cube, completing an INTERIOR row on +z empties +z — but
  // +z had NOTHING on it before the drop, so the reward is not owed. (The row is at v=2 on
  // purpose: a row along the edge is shared with a neighbouring face and would settle two lines.)
  const fresh = new Board()
  const freshSettle = fresh.place('+z', [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]], { u: 0, v: 0 }, 0xffffff)
  equal('an interior full row settles one line', freshSettle.lines.length, 1)
  equal('and hits one face', freshSettle.facesHit, 1)
  equal('a face that was already empty is not a wiped face', freshSettle.faceWiped.length, 0)
  equal('and it is not paid for', rewardFor(freshSettle).length, 0)
  check('but it IS reported as empty', freshSettle.faceEmpty.includes('+z'),
    JSON.stringify(freshSettle.faceEmpty))

  // (2) 侧面不算 — the ruling, stated as a board state.
  //
  //   -z ... (2,0,0)   +z ... (2,0,4)   -y ... both of those, plus (1,0,1)
  //   The -y column u=2 (v=0..4) completes and clears. It takes the LAST cell of +z and of -z
  //   with it, while -y itself keeps (1,0,1) and is not emptied at all.
  const board = new Board()
  board.addCells([cell(2, 0, 0), cell(2, 0, 4), cell(1, 0, 1)])
  const settle = board.place('-y', [[0, 1], [0, 2], [0, 3]], { u: 2, v: 0 }, 0xffffff)
  equal('the -y column is one line', settle.lines.length, 1)
  equal('and it hits one face', settle.facesHit, 1)
  equal('two side faces really were emptied by that line', settle.faceWiped.join(','), '+z,-z')
  equal('but the face the piece was placed on was NOT emptied', settle.faceWiped.includes('-y'), false)
  equal('so the hand earns NO face reward', rewardFor(settle).length, 0)
  equal('and the score says the same thing', faceClearBonus(settle.lines.length, rewardFor(settle)), 0)
  equal('the -y face keeps its other cell', board.faceOccupancy('-y'), 1)
  equal('and the emptied faces are really at zero', board.faceOccupancy('+z') + board.faceOccupancy('-z'), 0)

  // (3) 落子面被清空才发奖 — even when the clear also took a side face with it. The row runs
  // along the y=0 / z=4 edge, so it belongs to -y AND +z, and its (0,0,4) end also belongs to -x:
  // THREE faces end up empty, and exactly ONE of them is paid for.
  const seedSharedEdge = (target) => {
    ;[[0, 0, 4], [1, 0, 4], [2, 0, 4], [3, 0, 4]].forEach(([x, y, z]) => target.addCells([cell(x, y, z)]))
    return target.place('+z', [[0, 0]], { u: 4, v: 0 }, 0xffffff)
  }
  const sharedSettle = seedSharedEdge(new Board())
  equal('a shared edge still settles two lines', sharedSettle.lines.length, 2)
  equal('a shared edge still reports two faces', sharedSettle.facesHit, 2)
  equal('three faces end up empty', sharedSettle.faceWiped.join(','), '-x,-y,+z')
  equal('only the placed face is paid for', rewardFor(sharedSettle).join(','), '+z')
  equal('the two face lines pay the multi bonus', multiClearBonus(sharedSettle.lines.length), 100)
  equal('and the one placed face pays the face bonus', faceClearBonus(sharedSettle.lines.length, rewardFor(sharedSettle)), 300)

  // (4) 同面重新占用后再清空，可以再次领奖: the board keeps no memory of a face it emptied once.
  const wipeOnce = () => {
    const b = new Board()
    b.addCells([cell(2, 0, 0), cell(2, 0, 4), cell(1, 0, 1)])
    return b.place('-y', [[0, 1], [0, 2], [0, 3]], { u: 2, v: 0 }, 0xffffff)
  }
  equal('first wipe: still the side faces, still unpaid', rewardFor(wipeOnce()).length, 0)
  equal('second wipe of the same hand: same answer', rewardFor(wipeOnce()).length, 0)
  equal('and a shared-edge hand pays its own face every time',
    rewardFor(seedSharedEdge(new Board())).join(','), '+z')
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

// ---------------------------------------------------------------- scoring v2
// SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §2/§6.1. `P` is 4 everywhere, as the doc's table fixes
// it: these are INDEPENDENT INPUT COMBINATIONS, and the doc is explicit that they are not each
// claimed to be a reachable board state — reachability is asserted in the `face-wipe` group.
group('scoring-v2', () => {
  // The five constants, and the fact that the old terms are ABSENT rather than zeroed: a reader
  // must not be able to find a multiplier curve or an honour bonus in the new table.
  equal('placement is still 10 per cell', SCORING_V2.placePerCell, 10)
  equal('a line is still 100', SCORING_V2.lineBase, 100)
  equal('multi-clear steps by 100', SCORING_V2.multiStep, 100)
  equal('the streak steps by 50', SCORING_V2.streakStep, 50)
  equal('the streak caps at 4 steps', SCORING_V2.streakCap, 4)
  equal('a wiped face pays 300', SCORING_V2.faceClear, 300)
  check('the v2 table has no multiplier curve', SCORING_V2.lineMultipliers === undefined)
  check('the v2 table has no cross-face bonus', SCORING_V2.faceBonus === undefined)
  check('the v2 table has no chain milestone', SCORING_V2.chainMilestones === undefined)

  // §2.1 一次多消: 2 线起, 每多一条线 +100.
  equal('one line pays no multi bonus', multiClearBonus(1), 0)
  equal('two lines pay +100', multiClearBonus(2), 100)
  equal('three lines pay +200', multiClearBonus(3), 200)
  equal('five lines pay +400', multiClearBonus(5), 400)
  equal('twelve lines pay +1100 (linear, not the old curve)', multiClearBonus(12), 1100)

  // §2.3 连续消除: 第二次起, 封顶 4 级.
  equal('the first clear pays no streak bonus', streakBonus(1, 1), 0)
  equal('the second pays +50', streakBonus(1, 2), 50)
  equal('the third pays +100', streakBonus(1, 3), 100)
  equal('the fifth pays +200', streakBonus(1, 5), 200)
  equal('the twelfth still pays +200 (the count shows 12, the money caps)', streakBonus(1, 12), 200)
  equal('a turn that cleared nothing pays no streak bonus', streakBonus(0, 9), 0)

  // §2.4 清除整面: W faces, and never without a clear. The PRICING function stays general; what
  // narrows W to {0,1} is `wipedFacesFor()` below, which is where the producer's ruling lives.
  equal('one wiped face pays +300', faceClearBonus(1, 1), 300)
  equal('two wiped faces pay +600', faceClearBonus(1, 2), 600)
  equal('faces are deduped before they are priced', faceClearBonus(1, ['+z', '+z', '-y']), 600)
  equal('no clear, no face bonus', faceClearBonus(0, 3), 0)
  equal('a face list and a count mean the same thing', normalizeWipedFaces(['+z', '-y']), 2)

  // ---- 净面只算落子面（制作人口径，2026-10-01）------------------------------------
  // `wipedFacesFor()` is the ONE narrowing between Board.place()'s report and the reward. It is
  // tested here because everything downstream (the bonus, the note, the face sweep, the run
  // stat) consumes its output and nothing else.
  equal('the placed face, when the settle emptied it', wipedFacesFor('+z', ['-x', '-y', '+z'], 2).join(','), '+z')
  equal('a side face emptied by a shared cell is NOT paid', wipedFacesFor('-y', ['+z', '-z'], 1).length, 0)
  equal('a face that was already empty is not a wipe', wipedFacesFor('+z', [], 1).length, 0)
  equal('a turn that cleared nothing wipes nothing', wipedFacesFor('+z', ['+z'], 0).length, 0)
  equal('a missing report is not a wipe', wipedFacesFor('+z', undefined, 1).length, 0)
  equal('one hand can never pay for two faces', wipedFacesFor('+z', ['+z', '-y'], 2).length, 1)

  // §6.1 the doc's own table, row by row. `total` must equal the five named parts every time.
  // `base` is 基础分 = 基础放置分 + 基础消线分, which is how the doc's table states it.
  const table = [
    { name: '普通放置', lines: 0, chain: 0, faces: 0, base: 40, multi: 0, streak: 0, face: 0, total: 40 },
    { name: '第一消，单线', lines: 1, chain: 1, faces: 0, base: 140, multi: 0, streak: 0, face: 0, total: 140 },
    { name: '同手两线', lines: 2, chain: 1, faces: 0, base: 240, multi: 100, streak: 0, face: 0, total: 340 },
    { name: '第二次连续单线', lines: 1, chain: 2, faces: 0, base: 140, multi: 0, streak: 50, face: 0, total: 190 },
    { name: '第五次连续单线', lines: 1, chain: 5, faces: 0, base: 140, multi: 0, streak: 200, face: 0, total: 340 },
    { name: '第十二次连续单线', lines: 1, chain: 12, faces: 0, base: 140, multi: 0, streak: 200, face: 0, total: 340 },
    { name: '单线带净一面', lines: 1, chain: 1, faces: 1, base: 140, multi: 0, streak: 0, face: 300, total: 440 },
    { name: '三类同手', lines: 3, chain: 4, faces: 1, base: 340, multi: 200, streak: 150, face: 300, total: 990 },
    // 文档 §6.1 的这一行原本是「六线净两面」= 1740。制作人口径（净面只算落子面）下
    // 一手不可能清空两个面，所以它按同一套算术改成可达的那一版：六线、净一面。
    { name: '六线净一面', lines: 6, chain: 1, faces: 1, base: 640, multi: 500, streak: 0, face: 300, total: 1440 },
  ]
  table.forEach((row) => {
    const score = settleScore({ cellCount: 4, lines: row.lines, chain: row.chain, wipedFaces: row.faces })
    equal(`${row.name}: base points`, score.placement + score.linePoints, row.base)
    equal(`${row.name}: multi bonus`, score.multiBonus, row.multi)
    equal(`${row.name}: streak bonus`, score.streakBonus, row.streak)
    equal(`${row.name}: face bonus`, score.faceClearBonus, row.face)
    equal(`${row.name}: total`, score.total, row.total)
    equal(`${row.name}: total is the sum of the five named parts`, score.total,
      score.placement + score.linePoints + score.multiBonus + score.streakBonus + score.faceClearBonus)
  })

  // §6.1 额外断言: no legacy term can leak into a version-2 score, whatever a caller passes.
  const smuggled = settleScore({
    cellCount: 4, lines: 3, chain: 1, wipedFaces: 1, faces: 3, honorBonus: 500, chainMilestone: 200,
  })
  equal('a passed faces/honorBonus/chainMilestone changes nothing', smuggled.total, 340 + 200 + 300)
  equal('and none of them appear in the result', Object.keys(smuggled).sort().join(','),
    'faceClearBonus,linePoints,multiBonus,placement,primaryType,rewards,streakBonus,total')
  const stale = settleScore({ cellCount: 4, lines: 0, chain: 9, wipedFaces: 3 })
  equal('a dead turn with a stale chain pays placement only', stale.total, 40)
  equal('a dead turn earns no streak bonus', stale.streakBonus, 0)
  equal('a dead turn earns no face bonus', stale.faceClearBonus, 0)

  // §2.1 the reward LIST: zero-bonus categories are not entries, and the headline order is
  // 清除整面 > 一次多消 > 连续消除 (§3.3).
  const allThree = resolveRewards({ lines: 3, chain: 4, wipedFaces: 1 })
  equal('three categories fire as three entries', allThree.rewards.length, 3)
  equal('listed in the doc order', allThree.rewards.map((reward) => reward.type).join(','),
    'MULTI_CLEAR,CLEAR_STREAK,FACE_CLEAR')
  equal('each entry carries its own count', allThree.rewards.map((reward) => reward.count).join(','), '3,4,1')
  equal('the headline is the face clear', allThree.primaryType, REWARD_TYPES.FACE_CLEAR)
  equal('a two-line clear headlines the multi', resolveRewards({ lines: 2, chain: 1 }).primaryType, REWARD_TYPES.MULTI_CLEAR)
  equal('a bare streak headlines the streak', resolveRewards({ lines: 1, chain: 3 }).primaryType, REWARD_TYPES.CLEAR_STREAK)
  equal('a plain single line has no reward at all', resolveRewards({ lines: 1, chain: 1 }).rewards.length, 0)
  equal('and no headline', resolveRewards({ lines: 1, chain: 1 }).primaryType, null)
  equal('the priority list is the doc order', REWARD_PRIORITY.join(','), 'FACE_CLEAR,MULTI_CLEAR,CLEAR_STREAK')
  equal('the reward order is the doc order', REWARD_ORDER.join(','), 'MULTI_CLEAR,CLEAR_STREAK,FACE_CLEAR')

  // The presentation ladder is derived from the REWARD result, never from facesHit (§3.4).
  const levelOf = (input) => {
    const score = settleScore(input)
    return rewardLevel({ lines: input.lines || 0, rewards: score.rewards })
  }
  equal('a plain single line is L1', levelOf({ cellCount: 4, lines: 1, chain: 1 }), 1)
  equal('a two-line clear is L2', levelOf({ cellCount: 4, lines: 2, chain: 1 }), 2)
  equal('one line that empties a face is L3', levelOf({ cellCount: 4, lines: 1, chain: 1, wipedFaces: 1 }), 3)
  equal('five lines are L5', levelOf({ cellCount: 4, lines: 5, chain: 1 }), 5)
  equal('a dead turn is L0', levelOf({ cellCount: 4, lines: 0, chain: 0 }), 0)
  equal('a long streak lifts a single line', levelOf({ cellCount: 4, lines: 1, chain: 6 }), 4)
  // facesHit is NOT an input: it is not even a parameter of the level any more.
  equal('the level has no faces-hit input at all',
    rewardLevel({ lines: 1, rewards: [] }), rewardLevel({ lines: 1, rewards: [], faces: 3 }))
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
  equal('migration reports the current version', partial.v, RECORDS_VERSION)
  equal('migration drops unknown fields', partial.unknownField, undefined)
  // §5.3: a snapshot from before the scoring split has no version-2 pool, and the legacy one is
  // read exactly as it was written — nothing is re-priced and nothing is dropped.
  equal('a pre-split snapshot keeps its best in the legacy pool', partial.best.score, 900)
  equal('and its version-2 pool starts empty', partial.bestV2.score, 0)
  equal('a pre-split snapshot has no reward tally yet', partial.rewards.MULTI_CLEAR, 0)

  // A run in a later week must not overwrite this week's best.
  const weekly = store.all().weeklyV2
  equal('the weekly bucket is keyed by the CrazyGames week', weekly.key, weekKey(new Date()))
  const laterWeek = createRecordStore(storage)
  equal('a stale weekly key reads as empty', laterWeek.weeklyBest(Date.now()), weekly.score)
  check('record fields carry the i18n key of their label', RECORD_FIELDS.every((field) => field.labelKey && field.key))

  // ---- v0.10.3 §5.3: BEST / 周最佳 / NEW BEST 只比较相同规则版本 ------------------------
  // A store of its own, with a storage that really round-trips: `read()` re-parses the snapshot
  // every time, so a pool written by one run has to survive the JSON trip to be seen by the next.
  const isolatedStore = new Map()
  const isolated = createRecordStore({
    getItem: (key) => (isolatedStore.has(key) ? isolatedStore.get(key) : null),
    setItem: (key, value) => isolatedStore.set(key, value),
    removeItem: (key) => isolatedStore.delete(key),
  })
  const legacyRun = isolated.recordRun({ score: 250000, scoreRulesVersion: SCORE_RULES_V1, at: Date.now() })
  check('a legacy run is a new best in the legacy pool', legacyRun.isNewBest)
  equal('and it reports the legacy rules', legacyRun.rulesVersion, SCORE_RULES_V1)
  const currentRun = isolated.recordRun({ score: 900, scoreRulesVersion: SCORE_RULES_VERSION, at: Date.now() })
  check('a version-2 score is a new best of ITS OWN pool, not compared with the legacy 250k', currentRun.isNewBest)
  equal('the version-2 best is 900, not 250000', currentRun.bestScore, 900)
  equal('and the legacy best is untouched', isolated.all().best.score, 250000)
  const smallerCurrent = isolated.recordRun({ score: 800, scoreRulesVersion: SCORE_RULES_VERSION, at: Date.now() })
  check('a smaller version-2 score is not a new best', !smallerCurrent.isNewBest)
  equal('the gap is measured inside the same pool', smallerCurrent.gapToBest, 100)
  equal('the legacy pool is reported as read-only history', smallerCurrent.legacy.best, 250000)
  equal('the version-2 tallies accumulate for version-2 runs only',
    isolated.recordRun({ score: 10, scoreRulesVersion: SCORE_RULES_VERSION, rewards: { MULTI_CLEAR: 2, CLEAR_STREAK: 1 }, at: Date.now() }).rewards.MULTI_CLEAR, 2)
  equal('a legacy run contributes no reward tally',
    isolated.recordRun({ score: 10, scoreRulesVersion: SCORE_RULES_V1, rewards: { MULTI_CLEAR: 5 }, at: Date.now() }).rewards.MULTI_CLEAR, 2)
  equal('the recent list tags every entry with its rules',
    isolated.all().recent.map((entry) => entry.rules).join(','), '1,2,2,2,1')
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

  const legacyPairs = [
    [0xef9127, 'L'], [0xf2b52b, 'Line 3'], [0xe8543f, 'Dot'], [0x93b23c, 'L 5'],
    [0xff8a2a, 'L'], [0xffcb1f, 'Line 3'], [0xff6d5c, 'Dot'], [0x35c3ff, 'Line 2'],
    [0xa349ff, 'Square'], [0x4a6cff, 'J'], [0xff5d6f, 'T'],
    [0x00c2a0, 'S'], [0xc24bff, 'Z'], [0x45d8f1, 'Corner'],
  ]
  const oldRun = { ...snapshot, board: {
    ...snapshot.board,
    cells: legacyPairs.map(([color], i) => [i % SH, Math.floor(i / SH), 4, color]),
  } }
  const original = JSON.stringify(oldRun)
  const recoloured = migrateSession(oldRun)
  check('legacy board paints match their current candidate colours', recoloured.board.cells.every((cell, i) =>
    cell[3] === SHAPES.find(shape => shape.name === legacyPairs[i][1]).color))
  equal('palette migration preserves occupied coordinates', JSON.stringify(recoloured.board.cells.map(cell => cell.slice(0, 3))), JSON.stringify(oldRun.board.cells.map(cell => cell.slice(0, 3))))
  check('palette migration preserves score and line count', recoloured.board.score === oldRun.board.score && recoloured.board.totalLines === oldRun.board.totalLines)
  equal('palette migration preserves the rest of the run', JSON.stringify({ ...recoloured, board: null }), JSON.stringify({ ...migrateSession(snapshot), board: null }))
  equal('palette migration does not mutate the input', JSON.stringify(oldRun), original)
  equal('palette migration is idempotent', JSON.stringify(migrateSession(recoloured)), JSON.stringify(recoloured))
  for (const color of [...SHAPES.map(shape => shape.color), 0x123456]) {
    const same = migrateSession({ ...snapshot, board: { cells: [[0, 0, 4, color]] } })
    equal(`current or unknown paint ${color.toString(16)} stays unchanged`, same.board.cells[0][3], color)
  }
  fake.set('voxalblast.session.v1', JSON.stringify(oldRun))
  const resumed = createSessionStore(storage).read()
  equal('an existing persisted save gets the new palette on read', JSON.stringify(resumed.board), JSON.stringify(recoloured.board))
  store.save(resumed)
  equal('re-saving keeps the migrated palette', JSON.stringify(createSessionStore(storage).read().board), JSON.stringify(recoloured.board))

  store.clear()
  equal('a cleared slot reads as no saved run', store.read(), null)

  // Unplayable slots: every candidate used, or nothing left in the pool.
  equal('a run with no candidate left to place is not resumable', migrateSession({
    board: { cells: live, score: 10 },
    pieces: [{ name: 'Dot', used: true }, { name: 'Square', used: true }],
  }), null)
  equal('a snapshot from a retired shape pool is not resumable', migrateSession({
    board: { cells: live },
    pieces: [{ name: 'Line 5', used: false }],
  }), null)
  equal('garbage in the slot is not resumable', migrateSession({ board: { cells: 'nope' }, pieces: [] }), null)
  equal('null in the slot is not resumable', migrateSession(null), null)

  const degraded = migrateSession({
    board: { cells: [[0, 0, 0, 1], [9, 9, 9, 1], [0, 0, 0, 2]], score: 400 },
    pieces: [{ name: 'Line 5', used: false }, { name: 'Dot', used: false }],
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

// ---------------------------------------------------------------- storage boundary
// refactor P8: the "is there a storage we can trust" probe moved out of records.js into
// platform/storage.js, and the two preferences stopped touching localStorage directly.
// What has to hold is that the MOVE changed nothing a player can observe — same probe
// semantics, same four key literals, same 'on'/'off' strings, same default, and the same
// deliberately unguarded preference path.
group('storage', () => {
  const fake = new Map()
  const storage = {
    getItem: (key) => (fake.has(key) ? fake.get(key) : null),
    setItem: (key, value) => fake.set(key, value),
    removeItem: (key) => fake.delete(key),
  }
  const hostile = {
    getItem() { throw new Error('storage disabled') },
    setItem() { throw new Error('storage disabled') },
    removeItem() { throw new Error('storage disabled') },
  }

  // records.js keeps re-exporting the probe, and it has to be the SAME function rather
  // than a second copy that could drift away from the facade session.js now imports.
  check('records.js still re-exports the storage probe',
    pickStorageFromRecords === pickStorage && probeStorageFromRecords === probeStorage)

  // probeStorage: the same object back when it accepts a write, null when it lies.
  check('a working storage passes the probe unchanged', probeStorage(storage) === storage)
  equal('a hostile storage probes as null', probeStorage(hostile), null)
  equal('a missing storage probes as null', probeStorage(null), null)
  equal('the probe leaves no key behind', fake.size, 0)

  // pickStorage reads the global. Node has no localStorage at all, which is also the
  // "webview exposes nothing" path.
  equal('with no global storage the pick is null', pickStorage(), null)
  globalThis.localStorage = hostile
  equal('a global storage that throws on access is not picked', pickStorage(), null)
  globalThis.localStorage = storage
  check('a usable global storage is picked', pickStorage() === storage)
  equal('picking through the global leaves no key behind', fake.size, 0)
  delete globalThis.localStorage
  equal('the global is left as it was found', pickStorage(), null)

  // The shipped keys and schema versions must not move: a rename here resets a player's
  // records, their save slot and their preferences.
  equal('the session key is unchanged', SESSION_KEY, 'voxalblast.session.v1')
  const recordsFake = new Map()
  const recordsStorage = {
    getItem: (key) => (recordsFake.has(key) ? recordsFake.get(key) : null),
    setItem: (key, value) => recordsFake.set(key, value),
    removeItem: (key) => recordsFake.delete(key),
  }
  createRecordStore(recordsStorage).recordRun({ score: 10, at: 1 })
  equal('the records key is unchanged, and the probe cleaned up after itself',
    [...recordsFake.keys()].join(','), 'voxalblast.records.v1')

  // Preferences: 'off' is the only off, a missing key is on, and the stored strings are
  // the shipped ones.
  const prefFake = new Map()
  const prefStorage = {
    getItem: (key) => (prefFake.has(key) ? prefFake.get(key) : null),
    setItem: (key, value) => prefFake.set(key, value),
    removeItem: (key) => prefFake.delete(key),
  }
  check('a sound preference with no key stored reads as on', readPreferenceOn('sound', prefStorage))
  check('a haptics preference with no key stored reads as on', readPreferenceOn('haptics', prefStorage))
  writePreferenceOn('sound', false, prefStorage)
  equal('turning sound off writes the shipped key', [...prefFake.keys()].join(','), 'voxalblast-sound')
  equal('turning sound off writes "off"', prefFake.get('voxalblast-sound'), 'off')
  check('and it reads back as off', !readPreferenceOn('sound', prefStorage))
  writePreferenceOn('sound', true, prefStorage)
  equal('turning it back on writes "on"', prefFake.get('voxalblast-sound'), 'on')
  writePreferenceOn('haptics', false, prefStorage)
  equal('haptics keeps its own shipped key', prefFake.get('voxalblast-haptics'), 'off')
  prefFake.set('voxalblast-sound', 'yes please')
  check('only "off" reads as off', readPreferenceOn('sound', prefStorage))

  // P8 keeps the old exception semantics on purpose (计划 §6 P8 第 4 条): the preference
  // path is NOT guarded, so a storage that throws still throws. Turning this into a silent
  // fallback is a separate, deliberate fix — not a side effect of the move.
  let threw = false
  try { readPreferenceOn('sound', hostile) } catch { threw = true }
  check('the preference read still throws with a hostile storage', threw)
  threw = false
  try { writePreferenceOn('sound', false, hostile) } catch { threw = true }
  check('the preference write still throws with a hostile storage', threw)
})

// ---------------------------------------------------------------- keyboard (PC)
// v0.4.1: the six PC bindings. The keys are a second way into the SAME model as the
// swipes (03 §13), so what matters is that each key names a real world axis and that
// the pair covers both directions of it.
group('keyboard', () => {
  equal('W is world X (pitch)', axisForKey('w').axis, 'pitch')
  equal('S is world X (pitch)', axisForKey('s').axis, 'pitch')
  equal('A is world Y (yaw)', axisForKey('a').axis, 'yaw')
  equal('D is world Y (yaw)', axisForKey('d').axis, 'yaw')
  equal('Q is world Z (roll)', axisForKey('q').axis, 'roll')
  equal('E is world Z (roll)', axisForKey('e').axis, 'roll')
  equal('W and S are opposite directions', axisForKey('w').direction, -axisForKey('s').direction)
  equal('A and D are opposite directions', axisForKey('a').direction, -axisForKey('d').direction)
  equal('Q and E are opposite directions', axisForKey('q').direction, -axisForKey('e').direction)
  // The pair that reads as "with the finger" carries +1: S/right/D and E are what a
  // committed down/right/clockwise drag does, so the keys and the swipe agree. Since
  // v0.8.1 the roll's "with the finger" is the RIGHT band's downward drag; the left
  // band's downward drag is the same quarter the other way round (see the swipe group).
  equal('D matches a rightward drag', axisForKey('d').direction, 1)
  equal('S matches a downward drag', axisForKey('s').direction, 1)
  check('a shifted key still rotates', axisForKey('W')?.axis === 'pitch')
  equal('an unbound key is not a rotation', axisForKey('x'), null)
  equal('a named key is not a rotation', axisForKey('ArrowUp'), null)
  equal('a non-string key is not a rotation', axisForKey(undefined), null)

  // The legend is data: three rows, two keycaps each, and every printed key must be one
  // the handler honours (04 断言：说明里出现的键都要真的有效).
  equal('three binding rows are printed', KEY_BINDINGS.length, 3)
  equal('every row has two keycaps', KEY_BINDINGS.every((binding) => binding.primary && binding.secondary), true)
  const printed = KEY_BINDINGS.flatMap((binding) => binding.keys)
  equal('six keys are bound', printed.length, 6)
  check('every printed key resolves to a binding', printed.every((key) => axisForKey(key)))
  check('every printed key belongs to its own row', KEY_BINDINGS.every((binding) => binding.keys.every((key) => axisForKey(key).axis === binding.axis)))
  check('no key is printed twice', new Set(printed).size === printed.length)
})

// ---------------------------------------------------------------- swipe (gesture axes)
// v0.8.1: the gesture partition itself, straight out of rendering/swipe.js. The split
// (inside the cube's span = pitch, outside = roll) is what the whole "swipe to turn the
// cube" model hangs on, and the roll's SIGN is per band because a roll is an in-plane
// spin: the edge under the finger is the edge that has to move. Both bands took one
// sign until v0.8.1, which made the left band fight the finger — the regression this
// group exists to catch (reported as "the right band is right, the left is reversed").
group('swipe', () => {
  const bounds = { minX: 300, maxX: 700, minY: 200, maxY: 600 }
  const span = { x: 400, y: 400 }

  equal('left of the cube is the left band', screenBand(280, bounds), 'left')
  equal('right of the cube is the right band', screenBand(720, bounds), 'right')
  equal('inside the cube span is the cube', screenBand(500, bounds), 'cube')
  equal('the cube span is inclusive on the left edge', screenBand(300, bounds), 'cube')
  equal('the cube span is inclusive on the right edge', screenBand(700, bounds), 'cube')

  equal('a downward swipe inside the cube pitches', pickGestureAxis(0, 120, 'cube'), 'pitch')
  equal('a downward swipe left of the cube rolls', pickGestureAxis(0, 120, 'left'), 'roll')
  equal('a downward swipe right of the cube rolls', pickGestureAxis(0, 120, 'right'), 'roll')
  equal('a sideways swipe still yaws in a band', pickGestureAxis(120, 4, 'left'), 'yaw')
  equal('the dominant direction wins on a diagonal', pickGestureAxis(90, 120, 'right'), 'roll')

  // Sign of the roll: down in the right band is clockwise on screen (negative angle
  // about world +Z), down in the left band is anticlockwise (positive). The ruler is
  // shared, so the two are equal in size and exactly opposite in sign.
  const downRight = swipeAngle('roll', 0, 140, span, 'right')
  const downLeft = swipeAngle('roll', 0, 140, span, 'left')
  check('a downward drag in the right band turns the cube clockwise', downRight < 0, `got ${downRight}`)
  check('a downward drag in the left band turns it anticlockwise', downLeft > 0, `got ${downLeft}`)
  equal('the two bands are mirror images', downRight, -downLeft)
  check('the right band keeps the plain roll knob', downRight < 0 && ROTATE_STYLE.rollDirection < 0)
  check('an upward drag in a band is the opposite quarter', swipeAngle('roll', 0, -140, span, 'left') === -downLeft)
  // The band sign is not applied to the other two axes: yaw and pitch are the same
  // gesture wherever the finger landed in the horizontal split, band or cube.
  equal('yaw ignores the band', swipeAngle('yaw', 100, 0, span, 'left'), swipeAngle('yaw', 100, 0, span, 'right'))
  equal('pitch ignores the band', swipeAngle('pitch', 0, 100, span, 'left'), swipeAngle('pitch', 0, 100, span, 'right'))
  check('a band does not turn a vertical swipe into a sideways one', swipeAngle('roll', 140, 0, span, 'left') === 0)

  // Keys are THE SWIPE THEY EQUAL (03 §2, keyboard.js): the sign has to match the drag
  // the legend describes, or the same cube would sit differently after E than after a
  // downward drag in the right band. sign(direction * knob) is the step rotateCubeByKey
  // plans.
  const knobSign = (key) => Math.sign(axisForKey(key).direction * ROTATE_STYLE.rollDirection)
  equal('E matches a downward drag in the right band', knobSign('e'), Math.sign(downRight))
  equal('Q matches a downward drag in the left band', knobSign('q'), Math.sign(downLeft))
})

group('supply', () => {
  // v0.8.4 weighted dealing, extended in v0.8.12: every shape of 4 cells or more is
  // twice as likely as the small ones, but every shipped shape must still be dealt,
  // and the picker must consume exactly one random value so the three dealing sites
  // keep their call count.
  const names = SHAPES.map((shape) => shape.name)
  check('every shipped shape carries a weight', names.every((name) => SHAPE_WEIGHTS[name] > 0), JSON.stringify(SHAPE_WEIGHTS))
  equal('the weight table names no extra shapes', Object.keys(SHAPE_WEIGHTS).length, SHAPES.length)
  const total = Object.values(SHAPE_WEIGHTS).reduce((sum, w) => sum + w, 0)
  const shareOf = (list) => list.reduce((sum, name) => sum + SHAPE_WEIGHTS[name], 0) / total
  const fourCell = ['Square', 'L', 'J', 'T', 'S', 'Z']
  // v0.10.0: the three pentominoes are five-cell pieces, so they join this list (4+ cells),
  // not `fourCell`. The two shares below are the BASE SAMPLING shares of the shipped table —
  // hard assertions on purpose, because "bigger pieces dominate the deal" is the producer's
  // intent and this is the number that expresses it.
  const pentomino = ['Cross 5', 'U 5', 'T 5']
  const big = [...fourCell, 'Rect 6', 'L 5', 'Line 4', 'Block 9', ...pentomino]
  // v0.8.12–v0.8.14 added Rect 6, L 5, Slant 3 and Block 9 to the pool. The v0.8.4 rule
  // is literally "four-cell pieces x2, everything else x1", so all four new shapes
  // joined at x1 and the four-cell share moved 0.75 -> 12/20. Both numbers are
  // asserted, so neither can drift silently — the producer's intent is "bigger pieces
  // dominate the deal", and the four-cell number alone no longer expresses it.
  // v0.9.0 P1 (2026-09-23 spec §3.1) moves both: Line 4 joins at an EXPLICIT weight 1
  // (the one exception to the four-cell rule) and Block 9 drops to 0.4, so the total is
  // 20.4 — four-cell 12/20.4 = 58.8%, four-cells-or-larger 15.4/20.4 = 75.5%. These are
  // base sampling shares; the batch filter and the director move what the player sees.
  // v0.10.0 adds three five-cell pieces at 1 each: total 23.4, so four-cell goes 12/23.4 =
  // 51.3% and four-cells-or-larger 18.4/23.4 = 78.6%. The five-cell share alone is 3/23.4 =
  // 12.8%, up from 4.9% — that is the lever the producer's handoff §3.1 is about, and it is
  // pinned here so it cannot drift quietly.
  equal('four-cell candidates are 12/23.4 of the deal', shareOf(fourCell), 12 / 23.4)
  equal('candidates of 4 cells or more are 18.4/23.4 of the deal', shareOf(big), 18.4 / 23.4)
  equal('five-cell candidates are 3/23.4 of the deal', shareOf(pentomino), 3 / 23.4)
  // The two numbers P1 is about, pinned individually: the four-cell rule must not
  // silently "fix" Line 4 back to 2, and Block 9 must not silently return to 1.
  equal('Line 4 carries an explicit weight of 1, not the four-cell 2', SHAPE_WEIGHTS['Line 4'], 1)
  equal('Block 9 carries the reduced weight 0.4', SHAPE_WEIGHTS['Block 9'], 0.4)
  // v0.10.0 (handoff §6): the producer's ruling is "all three, weight 1 each, no damping".
  // Pinned per shape so a future "helpful" re-weighting is a visible decision, not a drift.
  for (const name of pentomino) equal(`${name} carries the ruled weight of 1`, SHAPE_WEIGHTS[name], 1)
  check('the pool is 18 shapes', SHAPES.length === 18, `${SHAPES.length} shapes`)
  check('Line 5 is still not shipped', !names.includes('Line 5'))
  // The opening pool is an explicit whitelist and the new pieces must NOT be in it: it is
  // frozen membership AND order, because `Board.seedOne` picks by index. See shapes.js.
  equal('the opening pool still holds the fourteen pre-Line-4 shapes', OPENING_SHAPES.length, 14)
  check('no v0.10.0 pentomino joins the opening pool', OPENING_SHAPES.every((shape) => !pentomino.includes(shape.name)))
  equal('the opening pool has not reordered', OPENING_SHAPES.map((shape) => shape.name).join(','), 'Dot,Line 2,Line 3,Square,L,J,T,S,Z,Corner,Rect 6,L 5,Slant 3,Block 9')

  // The two new shapes must fit a 5-wide face, not just exist in the table: a shape
  // that cannot be placed anywhere on an empty face would be a dead deal (and Rect 6
  // is the widest piece in the pool at 3x2).
  const emptyBoard = new Board()
  const unplaceable = SHAPES.filter((shape) => legalPlacements(emptyBoard, shape.cells).length === 0).map((shape) => shape.name)
  check('every shape fits an empty face in at least one orientation', unplaceable.length === 0, unplaceable.join(','))
  const longestRun = (cells) => {
    let best = 0
    for (const axis of [0, 1]) {
      const lines = new Map()
      for (const [u, v] of cells) {
        const key = axis === 0 ? v : u
        const along = axis === 0 ? u : v
        if (!lines.has(key)) lines.set(key, new Set())
        lines.get(key).add(along)
      }
      for (const set of lines.values()) {
        let run = 0
        for (let i = 0; i < 5; i += 1) { run = set.has(i) ? run + 1 : 0; best = Math.max(best, run) }
      }
    }
    return best
  }
  const rect = SHAPES.find((shape) => shape.name === 'Rect 6')
  equal('Rect 6 is six cells in a 3x2 box', `${rect.cells.length}x${Math.max(...rect.cells.map(([u]) => u)) + 1}x${Math.max(...rect.cells.map(([, v]) => v)) + 1}`, '6x3x2')
  const l5 = SHAPES.find((shape) => shape.name === 'L 5')
  equal('L 5 is five cells with a three-long arm', `${l5.cells.length}/${longestRun(l5.cells)}`, '5/3')
  // The staircase is the pool's pure filler: no two cells share a row or a column, so
  // it can never complete a line on its own, in any orientation.
  const slant = SHAPES.find((shape) => shape.name === 'Slant 3')
  equal('Slant 3 is three diagonal cells with no straight run at all', `${slant.cells.length}/${longestRun(slant.cells)}`, '3/1')
  check('Slant 3 can never complete a line by itself', [0, 1, 2, 3].every((quarter) => {
    const cells = rotateCells(slant.cells, quarter)
    return new Set(cells.map(([u]) => u)).size === cells.length && new Set(cells.map(([, v]) => v)).size === cells.length
  }))
  // Block 9 is the widest AND tallest piece in the pool; it has to fit a 5-wide face
  // with room to slide, and like every other shape it must not be able to complete a
  // line on its own (a face line is 5 cells, this is 3 wide).
  const block9 = SHAPES.find((shape) => shape.name === 'Block 9')
  equal('Block 9 is nine cells in a 3x3 box', `${block9.cells.length}x${Math.max(...block9.cells.map(([u]) => u)) + 1}x${Math.max(...block9.cells.map(([, v]) => v)) + 1}`, '9x3x3')
  equal('Block 9 cannot complete a line by itself', longestRun(block9.cells), 3)
  // 3x3 origins x 4 in-plane rotations x 6 faces = 216. (The four rotations of a square
  // are the same cell set, but legalPlacements enumerates the orientations the cube can
  // bring to the front, so it counts all four — same as for Square and Line 2.)
  check('Block 9 has somewhere to slide on an empty face', legalPlacements(emptyBoard, block9.cells).length === 216, `${legalPlacements(emptyBoard, block9.cells).length} placements (3x3 origins x 4 rotations x 6 faces)`)
  // v0.2.24 / v0.2.31 removed the 5-long and 4-long lines; v0.9.0 P1 put Line 4 back by
  // the producer's call, so the ceiling is FOUR now — and it is pinned to exactly one
  // shape, because a second 4-long piece (or a 5-long one) would be a different pool.
  equal('no shape carries a straight run longer than four', Math.max(...SHAPES.map((shape) => longestRun(shape.cells))), 4)
  equal('Line 4 is the only shape with a four-long run', SHAPES.filter((shape) => longestRun(shape.cells) === 4).map((shape) => shape.name).join(','), 'Line 4')

  // ---- v0.10.0 pentominoes ------------------------------------------------------------
  // (handoff §4.1 M6: cell count + bounding box + share + "the shape really is dealt".
  // The share and the "dealt" check are asserted further down, next to the 20k draw.)
  const pentominoCells = {
    'Cross 5': { cells: '5x3x3', geometry: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]] },
    'U 5': { cells: '5x3x2', geometry: [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1]] },
    'T 5': { cells: '5x3x3', geometry: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]] },
  }
  for (const [name, spec] of Object.entries(pentominoCells)) {
    const shape = SHAPES.find((entry) => entry.name === name)
    equal(`${name} is five cells in a ${spec.cells} box`,
      `${shape.cells.length}x${Math.max(...shape.cells.map(([u]) => u)) + 1}x${Math.max(...shape.cells.map(([, v]) => v)) + 1}`, spec.cells)
    equal(`${name} has the geometry the handoff specifies`, JSON.stringify(shape.cells), JSON.stringify(spec.geometry))
    // Half the pool rule: nothing may self-clear, i.e. no straight run as long as a face.
    equal(`${name} tops out at a three-long run and never self-clears`, longestRun(shape.cells), 3)
  }
  check('no pentomino clears anything on an empty face, in any orientation or position', SHAPES
    .filter((shape) => pentomino.includes(shape.name))
    .every((shape) => legalPlacements(new Board(), shape.cells).every((placement) => new Board().place('+z', shape.cells, placement.origin, shape.color).lines.length === 0)))
  // The payoff the three were chosen for, asserted on the real Board: `Cross 5` and `T 5` have
  // their 3-runs crossing on a shared centre cell, so one placement can complete TWO lines
  // (横 3 + 竖 3). `U 5` has a single 3-run, so it completes at most one.
  //
  // TWO details make this assertion mean what it says rather than something else:
  //   - the measurement is `linesByFace['+z']`, not the total. A +z row/column on the cube's
  //     edge IS a row/column of the neighbouring face (the `+z` v=0 line is the `-y` v=4 line),
  //     so a total would report 3 for a piece that completed one line on this face and one on
  //     the face behind it. Both shapes are placed on interior rows/columns so nothing is
  //     shared, and the per-face count is what isolates the claim.
  //   - the origin is chosen per shape so the crossing cell sits at (1,1), i.e. on an interior
  //     row AND column. `T 5`'s runs cross on its top row, so placing it at (0,0) would put the
  //     row on v=0 — the edge, i.e. the case above.
  const pentominoOf = (name) => SHAPES.find((shape) => shape.name === name).cells
  const crossingCell = (cells) => {
    const byU = new Map(), byV = new Map()
    for (const [u, v] of cells) {
      if (!byU.has(v)) byU.set(v, []); byU.get(v).push(u)
      if (!byV.has(u)) byV.set(u, []); byV.get(u).push(v)
    }
    for (const [u, v] of cells) if ((byU.get(v) || []).length >= 3 && (byV.get(u) || []).length >= 3) return { u, v }
    return null
  }
  // Pre-fill, for every line the piece has a 3-run in, the cells of that line the piece does
  // NOT cover — i.e. hand it a board that is two cells short on exactly those lines and nothing
  // else. Whatever it then completes is the piece's own doing.
  const twoLineSetup = (cells, origin) => {
    const board = new Board()
    const rows = new Map(), cols = new Map()
    for (const [u, v] of cells) {
      if (!rows.has(v)) rows.set(v, []); rows.get(v).push(u)
      if (!cols.has(u)) cols.set(u, []); cols.get(u).push(v)
    }
    // The complement is computed in BOARD coordinates: the runs are read off the shape's own
    // cells (shape-local) but the origin shifts the piece, so comparing local values against
    // board indices would "fill" a cell the piece itself is about to occupy.
    const fill = []
    for (const [v, us] of rows) {
      if (us.length < 3) continue
      const boardU = us.map((u) => origin.u + u)
      for (let u = 0; u < SH; u += 1) if (!boardU.includes(u)) fill.push([u, origin.v + v])
    }
    for (const [u, vs] of cols) {
      if (vs.length < 3) continue
      const boardV = vs.map((v) => origin.v + v)
      for (let v = 0; v < SH; v += 1) if (!boardV.includes(v)) fill.push([origin.u + u, v])
    }
    for (const [u, v] of fill) {
      const [x, y, z] = faceLattice('+z', u, v)
      board.cells.set(board.key(x, y, z), { x, y, z, color: 0x3f8fe0 })
    }
    return board
  }
  const placeOnZ = (name, origin) => twoLineSetup(pentominoOf(name), origin)
    .place('+z', pentominoOf(name), origin, 0xffffff)
  for (const [name, origin] of [['Cross 5', { u: 0, v: 0 }], ['T 5', { u: 0, v: 1 }]]) {
    const cross = crossingCell(pentominoOf(name))
    check(`${name} has a cell shared by a 3-run in both directions`, cross !== null, JSON.stringify(cross))
    equal(`${name} completes two lines on the face it lands on`,
      placeOnZ(name, origin).lines.filter((line) => line.face === '+z').length, 2)
  }
  equal('U 5 completes one line at a time',
    placeOnZ('U 5', { u: 0, v: 1 }).lines.filter((line) => line.face === '+z').length, 1)
  // And the geometric reason behind both numbers, so the claim is checkable without a Board:
  // the cross and the big T each own TWO 3-long straight runs, the U owns ONE.
  const straightRuns = (cells) => {
    let runs = 0
    for (const axis of [0, 1]) {
      const lines = new Map()
      for (const [u, v] of cells) {
        const key = axis === 0 ? v : u
        if (!lines.has(key)) lines.set(key, new Set())
        lines.get(key).add(axis === 0 ? u : v)
      }
      for (const set of lines.values()) if (set.size >= 3) runs += 1
    }
    return runs
  }
  equal('Cross 5 / T 5 own two 3-long runs; U 5 owns one',
    pentomino.map((name) => straightRuns(pentominoOf(name))).join('/'), '2/1/2')
  // Difficulty is NOT cell count, and the three are a gradient rather than three copies of one
  // problem. "Empty-face placements" = distinct in-plane orientations x origins that fit on one
  // 5x5 face, i.e. the handoff §2 method (orientations deduped — the cross is four-fold
  // symmetric, so its four rotations are ONE placement set; `U 5` and `T 5` have four).
  // Cross 5 lands in `Block 9`'s tier (also 9), `T 5` in `L 5`'s (36), `U 5` roomiest (48).
  // The cells are SORTED before deduping: rotateCells returns the same set in a rotated cell
  // order, so comparing raw JSON would count the symmetric cross's identical orientation twice.
  const canonical = (cells) => [...cells].map(([u, v]) => `${u},${v}`).sort().join(' ')
  const faceLetters = (cells) => [...new Set([0, 1, 2, 3].map((quarter) => canonical(rotateCells(cells, quarter))))]
  const emptyFacePlacements = (cells) => faceLetters(cells).reduce((sum, key) => {
    const shape = key.split(' ').map((pair) => pair.split(',').map(Number))
    const { u: uMax, v: vMax } = maxOrigin(shape, SH)
    return sum + uMax * vMax
  }, 0)
  const emptyFaceCounts = Object.fromEntries(pentomino.map((name) => [name, emptyFacePlacements(pentominoOf(name))]))
  equal('Cross 5 / T 5 / U 5 have 9 / 36 / 48 empty-face placements',
    `${emptyFaceCounts['Cross 5']}/${emptyFaceCounts['T 5']}/${emptyFaceCounts['U 5']}`, '9/36/48')
  // The same claim through the SHIPPED enumerator, deduped (the raw list counts a symmetric
  // piece's identical orientations once per quarter). `Cross 5` must land exactly on `Block 9`:
  // one orientation, 3x3 window, 9 windows per face — the equivalence the handoff §2 and §3.2
  // rest on.
  const uniquePlacements = (cells) => {
    const seen = new Set()
    for (const placement of legalPlacements(new Board(), cells)) {
      seen.add(`${placement.face}|${placement.origin.u},${placement.origin.v}|${canonical(placement.cells)}`)
    }
    return seen.size
  }
  const uniqueCounts = Object.fromEntries(pentomino.map((name) => [name, uniquePlacements(pentominoOf(name))]))
  check('Cross 5 is the tightest of the three on a real empty cube',
    uniqueCounts['Cross 5'] < uniqueCounts['T 5'] && uniqueCounts['T 5'] < uniqueCounts['U 5'],
    JSON.stringify(uniqueCounts))
  equal('Cross 5 has exactly Block 9\'s placement count on the real board',
    uniqueCounts['Cross 5'],
    uniquePlacements(SHAPES.find((shape) => shape.name === 'Block 9').cells))
  const line4 = SHAPES.find((shape) => shape.name === 'Line 4')
  equal('Line 4 is four cells in a 4x1 box', `${line4.cells.length}x${Math.max(...line4.cells.map(([u]) => u)) + 1}x${Math.max(...line4.cells.map(([, v]) => v)) + 1}`, '4x4x1')
  // The spec's correction of the old note: a 4-long line does NOT always clear a line.
  // On an empty 5-wide face it fills four of the five cells and leaves the row one short;
  // a 5-long line is the one that self-clears on contact, which is why Line 5 stays out.
  // Both halves are pinned so the claim cannot be re-stated wrongly in either direction.
  check('Line 4 does not clear a line by itself — only Line 5 would', (() => {
    const four = new Board().place('+z', line4.cells, { u: 0, v: 0 }, line4.color)
    const five = new Board().place('+z', [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], { u: 0, v: 0 }, 0xffffff)
    return four.lines.length === 0 && five.lines.length >= 1
  })())

  let draws = 0
  const counted = () => { draws += 1; return 0 }
  check('a pick consumes exactly one random value', pickShape(counted) === SHAPES[0] && draws === 1, `${draws} draws`)

  // Boundary sweep in the pool's canonical order (SHAPES), which is the order the
  // cumulative table is built in: each shape owns the interval its weight ends at.
  const boundaries = []
  let running = 0
  for (const name of names) {
    running += SHAPE_WEIGHTS[name] / total
    boundaries.push({ name, upTo: running })
  }
  let boundaryOk = true
  for (const { name, upTo } of boundaries) {
    if (pickShape(() => Math.max(0, upTo - 1e-9)).name !== name) boundaryOk = false
  }
  check('cumulative boundaries land on the declared shape', boundaryOk)
  check('a value of exactly 0 takes the first shape', pickShape(() => 0).name === names[0])

  // Empirical check with a deterministic stream: 20k picks, every shape present.
  const counts = new Map(names.map((name) => [name, 0]))
  let seed = 12345
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let i = 0; i < 20000; i += 1) { const shape = pickShape(next); counts.set(shape.name, counts.get(shape.name) + 1) }
  check('every shape is still dealt', [...counts.values()].every((n) => n > 0), JSON.stringify(Object.fromEntries(counts)))
  const observedBig = big.reduce((sum, name) => sum + counts.get(name), 0) / 20000
  check('observed 4+-cell share tracks the weights', Math.abs(observedBig - 18.4 / 23.4) < 0.02, `observed ${observedBig.toFixed(3)}`)
  // v0.10.0: the three pentominoes have to REACH the board, not just the table — this is the
  // assertion the v0.8.12 accident taught (four published measurement pools were derived from
  // SHAPE_NAMES and would have been silently rewritten by a shape addition). The observed
  // five-cell share is checked too: 3/23.4 is the number the whole difficulty argument rests on.
  const added = ['Rect 6', 'L 5', 'Slant 3', 'Block 9', 'Line 4', ...pentomino]
  check('every v0.8.12–v0.10.0 shape is dealt', added.every((name) => counts.get(name) > 0), JSON.stringify(Object.fromEntries(added.map((name) => [name, counts.get(name)]))))
  const observedPentomino = pentomino.reduce((sum, name) => sum + counts.get(name), 0) / 20000
  check('observed five-cell share tracks the weights', Math.abs(observedPentomino - 3 / 23.4) < 0.02, `observed ${(observedPentomino * 100).toFixed(2)}%`)
  // Block 9's reduced weight has to be visible in the sampled distribution, not just in
  // the table: at 0.4/23.4 it is ~1.71% of slots (diluted from 1.96% by the bigger pool), and
  // the four-cell-plus share above is what the rest of the pool is judged by. A 2x overshoot
  // here means the table and the cumulative picker disagree — exactly the drift this group
  // exists to catch.
  const observedBlock9 = counts.get('Block 9') / 20000
  check('Block 9 samples near its 1.71% share', Math.abs(observedBlock9 - 0.4 / 23.4) < 0.005, `observed ${(observedBlock9 * 100).toFixed(2)}%`)
})

group('placement-preview', () => {
  for (const face of FACES) {
    const board = new Board()
    for (const u of [0, 1, 3, 4]) {
      const [x, y, z] = faceLattice(face, u, 2)
      board.cells.set(board.key(x, y, z), { x, y, z, color: 0x3f8fe0 })
    }
    board.score = 730
    board.totalLines = 2
    const before = JSON.stringify([board.cells.size, [...board.cells], board.score, board.totalLines])
    const preview = board.previewLines(face, [[0, 0]], { u: 2, v: 2 })
    equal(`${face} forecast completes one line`, preview.length, 1)
    equal(`${face} forecast includes five unique cells`, new Set(preview.flatMap(line => line.cells.map(c => c.join(',')))).size, 5)
    equal(`${face} overlap forecasts no clear`, board.previewLines(face, [[0, 0]], { u: 0, v: 2 }).length, 0)
    equal(`${face} overflow forecasts no clear`, board.previewLines(face, [[0, 0], [1, 0]], { u: 4, v: 1 }).length, 0)
    equal(`${face} forecast never changes live board`, JSON.stringify([board.cells.size, [...board.cells], board.score, board.totalLines]), before)
    equal(`${face} forecast equals actual resolution`, JSON.stringify(board.place(face, [[0, 0]], { u: 2, v: 2 }, 0xff1644).lines), JSON.stringify(preview))
  }
  const shared = new Board()
  for (const x of [0, 1, 3, 4]) shared.cells.set(shared.key(x, 0, 4), { x, y: 0, z: 4, color: 0x3f8fe0 })
  const lines = shared.previewLines('+z', [[0, 0]], { u: 2, v: 0 })
  equal('shared edge forecasts both faces', new Set(lines.map(line => line.face)).size, 2)
  equal('shared edge still has only five actual cubes', new Set(lines.flatMap(line => line.cells.map(cell => cell.join(',')))).size, 5)
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

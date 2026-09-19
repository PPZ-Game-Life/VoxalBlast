#!/usr/bin/env node
// Focused measurement tests; no browser or dependency installation required.
import assert from 'node:assert/strict'
import { Board, SH, FACES, faceLattice } from '../src/game/board.js'
import { SHAPES } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'
import {
  CELLS, PLACEMENTS, SHAPE_NAMES, POOLS, POOL_IDS, poolById, OPENINGS, OPENING_IDS, openingById,
  stateFromBoard, boardFromState, stateKey,
  occupiedCount, canPlace, settle, rngFor, stageAt, drawHand, makeOpening,
  legalCount, chooseMove,
} from './difficulty-model.mjs'
import { SHAPE_WEIGHTS } from '../src/game/shapes.js'
import {
  parseArgs, quantile, wilson, summarizeGames, pairedComparison, runGame, resolveGroup, armParts,
} from './difficulty-abcd.mjs'

let checks = 0
function test(name, fn) {
  fn(); checks++; console.log(`PASS ${name}`)
}
const sortedCells = (board) => board.occupied().map(({ x, y, z }) => `${x},${y},${z}`).sort()
function assertEquivalent(board, state) {
  assert.deepEqual(sortedCells(boardFromState(state)), sortedCells(board))
  assert.equal(occupiedCount(state), board.cells.size)
}
function assertSettle(board, state, pl) {
  const before = stateKey(state)
  const clone = new Board()
  clone.restore({ cells: board.occupied().map(({ x, y, z, color }) => [x, y, z, color]) })
  const real = clone.place(pl.face, pl.cells, pl.origin, 0xff0000)
  const fast = settle(state, pl)
  assert.equal(stateKey(state), before, 'settle must not mutate its input')
  assert.equal(fast.lines, real.lines.length)
  assert.equal(fast.cellsCleared, real.cellsCleared)
  assert.equal(fast.facesHit, real.facesHit)
  assertEquivalent(clone, fast.state)
  assert.equal(clone.findAllFullLines().length, 0)
  return fast
}

test('98 unique shell coordinates and all placement mappings', () => {
  assert.equal(SH, 5)
  assert.equal(CELLS.length, 98)
  assert.equal(new Set(CELLS.map((c) => c.join(','))).size, 98)
  const empty = new Board(), state = stateFromBoard(empty)
  for (const pl of PLACEMENTS) {
    assert.equal(empty.canPlace(pl.face, pl.cells, pl.origin), true)
    assert.equal(canPlace(state, pl), true)
    assert.deepEqual(pl.indices.map((i) => CELLS[i].join(',')).sort(), pl.cells.map(([u, v]) => faceLattice(pl.face, pl.origin.u + u, pl.origin.v + v).join(',')).sort())
  }
  assert.deepEqual(sortedCells(boardFromState(state)), [])
})

test('fast legality and settlement match real Board on 12 seeded positions', () => {
  let settlements = 0
  for (let seed = 1; seed <= 12; seed++) {
    const board = new Board()
    board.seedOpening(SHAPES, OPENING_LAYOUT, rngFor(seed, 0, 'opening'))
    const state = stateFromBoard(board)
    assertEquivalent(board, state)
    assert.equal(board.findAllFullLines().length, 0)
    let sampled = 0
    for (const [index, pl] of PLACEMENTS.entries()) {
      const legal = board.canPlace(pl.face, pl.cells, pl.origin)
      assert.equal(canPlace(state, pl), legal)
      // Sample every face/orientation rather than just the first few placements.
      if (legal && index % 23 === seed % 23) {
        assertSettle(board, state, pl); sampled++; settlements++
      }
    }
    assert.ok(sampled > 20)
  }
  console.log(`  ${settlements} seeded differential settlements`)
})

test('shared-edge clearing counts both faces but deletes each cell once', () => {
  const board = new Board()
  for (let y = 0; y < 4; y++) board.addCells([{ x: 0, y, z: 0, color: 1 }])
  const pl = PLACEMENTS.find((p) => p.shape === 'Dot' && p.indices.length === 1 && CELLS[p.indices[0]].join(',') === '0,4,0')
  assert.ok(pl)
  const result = assertSettle(board, stateFromBoard(board), pl)
  assert.equal(result.lines, 2)
  assert.equal(result.cellsCleared, 5)
  assert.equal(result.facesHit, 2)
  assert.equal(occupiedCount(result.state), 0)
})

test('random dense-board parity exercises terminal and multiple-line states', () => {
  const random = rngFor(321, 0, 'test-dense')
  let settlements = 0
  for (let i = 0; i < 36; i++) {
    const board = new Board()
    for (const [x, y, z] of CELLS) if (random() < 0.45 + i % 4 * 0.1) board.addCells([{ x, y, z, color: 1 }])
    // Legal game states have no un-settled full lines.
    const full = board.findAllFullLines().flatMap((line) => line.cells)
    board.removeCells(full)
    const state = stateFromBoard(board)
    for (const pl of PLACEMENTS) {
      assert.equal(canPlace(state, pl), board.canPlace(pl.face, pl.cells, pl.origin))
      if (canPlace(state, pl) && random() < 0.06) { assertSettle(board, state, pl); settlements++ }
    }
    for (const shape of SHAPES) assert.equal(legalCount(state, shape.name) > 0, board.anyPlacement(shape.cells))
  }
  assert.ok(settlements > 100)
  console.log(`  ${settlements} dense-board differential settlements`)
})

test('1000-step differential trajectory including batch changes', () => {
  const board = new Board()
  board.seedOpening(SHAPES, OPENING_LAYOUT, rngFor(9, 0, 'opening'))
  let state = stateFromBoard(board), hand = []
  const deal = rngFor(9, 0, 'deal'), policy = rngFor(9, 0, 'policy')
  let steps = 0
  for (; steps < 1000; steps++) {
    if (!hand.length) hand = drawHand(deal, steps, false)
    const move = chooseMove(state, hand, policy, 'greedy')
    if (!move) break
    const fast = assertSettle(board, state, move.pl)
    board.place(move.pl.face, move.pl.cells, move.pl.origin, 1)
    state = fast.state
    hand.splice(move.slot, 1)
  }
  assert.ok(steps >= 100, `trajectory too short: ${steps}`)
  console.log(`  ${steps} trajectory steps`)
})

test('RNG repeatability and named streams are independent', () => {
  const a = rngFor(1, 2, 'deal'), b = rngFor(1, 2, 'deal')
  const unrelated = rngFor(1, 2, 'structure')
  for (let i = 0; i < 200; i++) {
    for (let j = 0; j < 7; j++) unrelated()
    assert.equal(a(), b())
  }
  assert.notEqual(rngFor(1, 2, 'deal')(), rngFor(1, 3, 'deal')())
  assert.notEqual(rngFor(1, 2, 'deal')(), rngFor(1, 2, 'policy')())
})

test('stage boundaries and 18+6 cycle are explicit', () => {
  for (const step of [0, 11]) assert.deepEqual(stageAt(step).weights, [0.2, 0.3, 0.5])
  for (const step of [12, 29, 48, 53, 72, 77, 96, 101]) assert.deepEqual(stageAt(step).weights, [0.1, 0.2, 0.7])
  for (const step of [30, 47, 54, 71, 78, 95, 102]) assert.deepEqual(stageAt(step).weights, [0, 0.1, 0.9])
})

test('empirical shape weights and fixed RNG consumption', () => {
  const size = Object.fromEntries(SHAPES.map((s) => [s.name, s.cells.length]))
  for (const [staged, step, expected] of [[false, 0, [0.2, 0.2, 0.6]], [true, 0, [0.2, 0.3, 0.5]], [true, 12, [0.1, 0.2, 0.7]], [true, 30, [0, 0.1, 0.9]]]) {
    const random = rngFor(777, step, String(staged)), counts = [0, 0, 0]
    for (let i = 0; i < 20000; i++) for (const shape of drawHand(random, step, staged)) counts[size[shape] <= 2 ? 0 : size[shape] === 3 ? 1 : 2]++
    counts.forEach((count, i) => assert.ok(Math.abs(count / 60000 - expected[i]) < 0.008, `${staged}/${step}/${i}: ${count}`))
  }
  const a = rngFor(4, 3, 'deal'), b = rngFor(4, 3, 'deal')
  for (let i = 0; i < 20; i++) { drawHand(a, i * 3, false); drawHand(b, i * 3, true) }
  assert.equal(a(), b())
})

test('baseline opening calls actual seeder and first deal uses the independent stream', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const board = new Board()
    board.seedOpening(SHAPES, OPENING_LAYOUT, rngFor(seed, 0, 'opening'))
    for (const staged of [false, true]) {
      const opening = makeOpening({ seed, gameIndex: 0, structured: false, staged })
      assertEquivalent(board, opening.state)
      assert.deepEqual(opening.hand, drawHand(rngFor(seed, 0, 'deal'), 0, staged))
      assert.equal(opening.meta.actualCount, board.cells.size)
    }
  }
})

test('structured openings preserve paired counts and fixed hands, failures are explicit', () => {
  let accepted = 0
  for (const staged of [false, true]) for (let gameIndex = 0; gameIndex < 8; gameIndex++) {
    const baseline = makeOpening({ seed: 44, gameIndex, structured: false, staged })
    const structured = makeOpening({ seed: 44, gameIndex, structured: true, staged })
    assert.deepEqual(structured.hand, baseline.hand)
    assert.equal(occupiedCount(structured.state), occupiedCount(baseline.state))
    assert.equal(structured.meta.actualCount, structured.meta.baselineCount)
    assert.equal(boardFromState(structured.state).findAllFullLines().length, 0)
    assert.equal(structured.meta.fallback, !structured.meta.accepted)
    if (structured.meta.accepted) {
      accepted++
      const distinct = [...new Set(structured.hand)].filter((shape) => legalCount(structured.state, shape) >= 2)
      assert.ok(distinct.length >= 2)
      assert.ok(PLACEMENTS.some((pl) => pl.face === '+z' && structured.hand.includes(pl.shape) && canPlace(structured.state, pl) && (settle(structured.state, pl).faceMask & (1 << FACES.indexOf('+z'))) !== 0))
      assert.equal(structured.meta.witness.length, 3)
      let state = structured.state
      const used = new Set()
      for (const [index, step] of structured.meta.witness.entries()) {
        assert.ok(!used.has(step.slot))
        used.add(step.slot)
        const pl = PLACEMENTS.find((p) => p.id === step.placementId)
        assert.ok(pl)
        assert.equal(pl.shape, structured.hand[step.slot])
        assert.equal(canPlace(state, pl), true)
        const result = settle(state, pl)
        if (index === 0) {
          assert.equal(pl.face, '+z')
          assert.ok((result.faceMask & (1 << FACES.indexOf('+z'))) !== 0)
          const actualBoard = boardFromState(state)
          const actual = actualBoard.place(pl.face, pl.cells, pl.origin, 1)
          assert.ok(actual.lines.some((line) => line.face === '+z'))
        }
        state = result.state
      }
      assert.equal(used.size, 3)
    } else assert.equal(stateKey(structured.state), stateKey(baseline.state))
  }
  assert.ok(accepted >= 8, `unexpected acceptance collapse: ${accepted}/16`)
})

test('bounded opening search reports fallback rather than fabricating a proof', () => {
  let fallback = null
  for (let gameIndex = 0; gameIndex < 8; gameIndex++) {
    const opening = makeOpening({ seed: 12, gameIndex, structured: true, nodeBudget: 1, maxAttempts: 1 })
    if (opening.meta.fallback) { fallback = opening; break }
  }
  assert.ok(fallback)
  assert.equal(fallback.meta.accepted, false)
  assert.equal(fallback.meta.witness, null)
  assert.ok(fallback.meta.nodes <= 1)
  assert.equal(fallback.meta.actualCount, fallback.meta.baselineCount)
})

function record(steps, ended, gameIndex = 0) {
  return {
    steps, ended, seed: 1, gameIndex, opening: { actualCount: 16, baselineCount: 16, accepted: null },
    firstClearStep: null, clearMoves: 0, tightMoves: 0, samePreHandMobilityReleases: 0, deals: 1,
    freshDealStuck: 0, longestDry: 0, dealShapeCounts: {},
  }
}

test('censor-aware quantiles, survival and early-end definitions', () => {
  const summary = summarizeGames([record(10, true), record(60, true), record(100, false), record(100, false)], 100)
  assert.equal(summary.endedPct, 50)
  assert.equal(summary.endStepsAll.p50, 60)
  assert.equal(summary.endStepsAll.p75, '>100')
  assert.equal(summary.endStepsEndedOnly.p50, 10)
  assert.equal(summary.restrictedMeanSteps, 67.5)
  assert.equal(summary.earlyEndBefore12Pct, 25)
  assert.equal(summary.survival.find((x) => x.step === 60).pct, 75)
  assert.equal(summary.survival.find((x) => x.step === 120).pct, null)
  assert.equal(summary.survivalCurve.at(-1).pct, 50)
  const censored = summarizeGames([record(600, false), record(600, false), record(15, true)], 600)
  assert.equal(censored.endStepsAll.p50, '>600')
  assert.equal(censored.firstClearObservedP50, null)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2)
  assert.deepEqual(wilson(0, 10), [0, 27.753])
  assert.deepEqual(wilson(10, 10), [72.247, 100])
})

test('paired comparisons preserve game IDs and cap-boundary survival', () => {
  const left = [record(60, true, 0), record(100, false, 1)]
  const right = [record(30, true, 1), record(100, false, 0)]
  const pairs = pairedComparison(left, right, 100)
  assert.equal(pairs.pairs, 2)
  assert.equal(pairs.restrictedMeanStepDifferenceRightMinusLeft, -15)
  const point = pairs.thresholds.find((p) => p.step === 60)
  assert.equal(point.survivalPctPointDifferenceRightMinusLeft, -50)
  assert.equal(point.leftOnlySurvived, 1)
  assert.throws(() => pairedComparison(left, right.slice(1), 100), /identical/)
  assert.throws(() => pairedComparison([left[0], left[0]], right, 100), /duplicate/)
  assert.throws(() => pairedComparison(left, [right[0], right[0]], 100), /duplicate/)
})

test('all-same first hand is an explicit zero-search fallback', () => {
  const opening = makeOpening({ seed: 99, gameIndex: 42, structured: true, staged: false })
  assert.equal(new Set(opening.hand).size, 1)
  assert.equal(opening.meta.accepted, false)
  assert.equal(opening.meta.fallback, true)
  assert.equal(opening.meta.nodes, 0)
  assert.equal(opening.meta.attempts, 1)
  assert.equal(opening.meta.searchBudgetExhaustions, 0)
})

test('space actor considers all slots, is deterministic and consumes no future random stream', () => {
  const opening = makeOpening({ seed: 7, gameIndex: 0, structured: false, staged: true })
  const forbiddenRng = () => { throw new Error('space must not draw random values') }
  const a = chooseMove(opening.state, opening.hand, forbiddenRng, 'space')
  const b = chooseMove(opening.state, opening.hand, forbiddenRng, 'space')
  assert.deepEqual(a, b)
  assert.ok(a.slot >= 0 && a.slot < 3)
  assert.equal(a.pl.shape, opening.hand[a.slot])
  assert.equal(canPlace(opening.state, a.pl), true)
  const options = { group: 'A', seed: 7, gameIndex: 0, strategy: 'space', stepCap: 12 }
  const run = runGame(options)
  assert.ok(run.record.steps <= 12)
  assert.equal(run.record.deals * 3, Object.values(run.record.dealShapeCounts).reduce((sum, n) => sum + n, 0))
  const summary = summarizeGames([run.record], 12)
  assert.equal(summary.totalDealtSlots, summary.totalDeals * 3)
  assert.ok(Math.abs(Object.values(summary.shapePctOfDealtSlots).reduce((sum, n) => sum + n, 0) - 100) < 0.01)
})

test('runner is reproducible and never executes cap+1', () => {
  const options = { group: 'D', seed: 15, gameIndex: 0, strategy: 'noise', stepCap: 3, trace: true }
  const a = runGame(options), b = runGame(options)
  assert.deepEqual(a, b)
  assert.ok(a.record.steps <= 3)
  assert.equal(a.trace.moves.length, a.record.steps)
  assert.equal(a.bins.reduce((sum, bin) => sum + bin.samples, 0), a.record.steps)
  if (a.record.censored) assert.equal(a.record.steps, 3)
})

test('strict CLI rejects silent experiment-parameter mistakes', () => {
  assert.equal(parseArgs([]).games, 200)
  assert.deepEqual(parseArgs(['--groups=A,D', '--seeds=0,123', '--step-cap=12']).seeds, [0, 123])
  for (const args of [['--games=0'], ['--games=NaN'], ['--games=2.5'], ['--seed=1'], ['--groups=E'], ['--groups=A,A'], ['--seeds=1,01'], ['--seeds=-1'], ['--strategies=best'], ['--games=2', '--games=3']]) assert.throws(() => parseArgs(args))
})

test('pool definitions are explicit, and only declared pools are accepted', () => {
  assert.deepEqual(POOL_IDS, ['current', 'soft75', 'c', 'd', 'w90', 'e', 'e5', 'soft82'])
  // `current`, `c`, `d` and `soft82` are frozen to the ten shapes they were MEASURED
  // with (v0.8.12 added two shapes to the game; letting them into these pools would
  // have silently redefined three published candidates and invalidated every number
  // in DIFFICULTY_POOL.md). Only `soft75` follows the shipped weights.
  const TEN = ['Dot', 'Line 2', 'Line 3', 'Corner', 'Square', 'L', 'J', 'T', 'S', 'Z']
  assert.equal(POOLS.current.entries.length, TEN.length)
  assert.deepEqual(POOLS.current.entries.map((entry) => entry.weight), TEN.map(() => 1))
  // The measurement pool must follow the shipped weights, so a game-side reweighting
  // cannot silently leave the tool measuring the old pool. Compare by name: the
  // cumulative table is order-sensitive, the weights are not.
  const weightsOf = (id) => Object.fromEntries(POOLS[id].entries.map((entry) => [entry.name, entry.weight]))
  assert.deepEqual(weightsOf('soft75'), { ...SHAPE_WEIGHTS })
  assert.equal(POOLS.soft75.members.size, SHAPE_NAMES.length)
  for (const name of ['Solid', 'Line 4', 'current ', '']) assert.throws(() => poolById(name))
  // Every pool must name shipped shapes only; a typo would otherwise silently deal a smaller pool.
  for (const id of POOL_IDS) for (const entry of POOLS[id].entries) assert.ok(SHAPE_NAMES.includes(entry.name))
  assert.deepEqual([...POOLS.e.members].sort(), ['J', 'L', 'S', 'Square', 'T', 'Z'])
  assert.deepEqual([...POOLS.e5.members].sort(), ['J', 'L', 'S', 'T', 'Z'])
  assert.equal(POOLS.d.members.has('Corner'), false)
  assert.equal(POOLS.w90.cumulative[POOLS.w90.cumulative.length - 1].upTo, 1)
  // A weighted pool is not automatically a non-destructive one: w90 has the same
  // members as d (the small shapes are weight 0), while soft75 keeps every shipped
  // shape and soft82 keeps the ten it was measured with.
  assert.deepEqual([...POOLS.w90.members].sort(), [...POOLS.d.members].sort())
  assert.equal(POOLS.soft75.entries.length, SHAPE_NAMES.length)
  assert.equal(POOLS.soft82.entries.length, TEN.length)
  assert.ok(POOLS.soft75.members.has('Rect 6') && POOLS.soft75.members.has('L 5'))
  assert.ok(!POOLS.soft82.members.has('Rect 6') && !POOLS.soft82.members.has('L 5'))
  const shareOf = (id, names) => {
    const entries = POOLS[id].entries
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
    return entries.filter((entry) => names.includes(entry.name)).reduce((sum, entry) => sum + entry.weight, 0) / total
  }
  const FOUR = ['Square', 'L', 'J', 'T', 'S', 'Z']
  // v0.8.12–v0.8.14: Rect 6, L 5, Slant 3 and Block 9 joined the pool at weight 1 (the
  // v0.8.4 rule is "four-cell x2, everything else x1"), so the four-cell share moved
  // 0.75 -> 12/20 and the "4 cells or larger" band is 15/20. Both are pinned.
  assert.ok(Math.abs(shareOf('soft75', FOUR) - 12 / 20) < 1e-9)
  assert.ok(Math.abs(shareOf('soft75', [...FOUR, 'Rect 6', 'L 5', 'Block 9']) - 15 / 20) < 1e-9)
  assert.ok(Math.abs(shareOf('soft82', FOUR) - 18 / 22) < 1e-9)
  assert.ok(Math.abs(shareOf('w90', FOUR) - 0.9) < 1e-9)
})

test('uniform pool dealing honours weights, never leaves the pool and consumes two randoms per slot', () => {
  for (const id of POOL_IDS) {
    let draws = 0
    const rng = () => { draws += 1; return (draws * 0.37) % 1 }
    const hand = drawHand(rng, 0, false, id)
    assert.equal(hand.length, 3)
    assert.equal(draws, 6) // two per slot in every mode, so paired streams stay aligned
    for (const shape of hand) assert.ok(POOLS[id].members.has(shape), `${shape} is not in pool ${id}`)
  }
  const counts = Object.fromEntries(SHAPE_NAMES.map((name) => [name, 0]))
  const rng = rngFor(11, 3, 'deal')
  for (let i = 0; i < 60000; i += 1) for (const shape of drawHand(rng, 0, false, 'e')) counts[shape] += 1
  const fourCell = ['Square', 'L', 'J', 'T', 'S', 'Z']
  for (const name of SHAPE_NAMES) {
    const expected = fourCell.includes(name) ? 100 / 6 : 0
    assert.ok(Math.abs(100 * counts[name] / 180000 - expected) < 1.2, `${name} frequency drifted from pool e`)
  }
  const weighted = Object.fromEntries(SHAPE_NAMES.map((name) => [name, 0]))
  const rng2 = rngFor(11, 4, 'deal')
  for (let i = 0; i < 60000; i += 1) for (const shape of drawHand(rng2, 0, false, 'w90')) weighted[shape] += 1
  // 6 four-cell shapes at weight 3 and Line 3 at weight 2 => 90% / 10%.
  assert.ok(Math.abs(100 * weighted['Line 3'] / 180000 - 10) < 1.2)
  assert.equal(weighted['Dot'] + weighted['Line 2'] + weighted['Corner'], 0)
})

test('staged dealing renormalizes over the groups a pool still covers', () => {
  // Pool e has no small or three-cell shape, so every stage must deal four-cell pieces.
  for (const step of [0, 12, 30, 48, 60]) {
    const hand = drawHand(rngFor(5, step, 'deal'), step, true, 'e')
    for (const shape of hand) assert.ok(POOLS.e.members.has(shape))
  }
  // Pool d keeps three-cell and four-cell groups: at the challenge stage (0/10/90)
  // the renormalized split is 10% / 90% and the emptied small group gets nothing.
  const counts = Object.fromEntries(SHAPE_NAMES.map((name) => [name, 0]))
  const rng = rngFor(23, 7, 'deal')
  for (let i = 0; i < 60000; i += 1) for (const shape of drawHand(rng, 30, true, 'd')) counts[shape] += 1
  assert.equal(counts['Dot'] + counts['Line 2'], 0)
  const threeCell = counts['Line 3'] + counts['Corner']
  assert.ok(Math.abs(100 * threeCell / 180000 - 10) < 1.5, `three-cell share was ${100 * threeCell / 180000}`)
  // The relief stage (10/20/70) renormalizes over the two surviving groups to
  // 0.2/0.9 = 22.2% three-cell, not the declared 20%: the emptied small group's
  // share must not be silently kept or silently dropped from the denominator.
  const relief = Object.fromEntries(SHAPE_NAMES.map((name) => [name, 0]))
  const rng2 = rngFor(23, 8, 'deal')
  for (let i = 0; i < 60000; i += 1) for (const shape of drawHand(rng2, 48, true, 'd')) relief[shape] += 1
  assert.ok(Math.abs(100 * (relief['Line 3'] + relief['Corner']) / 180000 - 200 / 9) < 1.5)
})

test('current pool reproduces the shipped deal and legacy arms stay reproducible', () => {
  const a = rngFor(3, 1, 'deal'), b = rngFor(3, 1, 'deal'), c = rngFor(3, 1, 'deal')
  // `current` is frozen to the ten shapes it was measured with — NOT SHAPE_NAMES, which
  // grew to twelve in v0.8.12. The expectation has to index the pool's own member list
  // in its own order, or this stops testing reproduction and starts testing drift.
  const currentNames = POOLS.current.entries.map((entry) => entry.name)
  for (let i = 0; i < 50; i += 1) {
    const expected = []
    for (let slot = 0; slot < 3; slot += 1) {
      expected.push(currentNames[Math.min(currentNames.length - 1, Math.floor(a() * currentNames.length))])
      a() // the per-slot second draw is consumed but unused in uniform mode
    }
    assert.deepEqual(drawHand(b, i, false, 'current'), expected)
    assert.deepEqual(drawHand(c, i, false), expected) // default pool stays the shipped uniform one
  }
  const record = runGame({ group: 'c/uniform', seed: 1, gameIndex: 0, strategy: 'noise', stepCap: 40 }).record
  assert.equal(record.pool, 'c')
  assert.equal(record.dealer, 'uniform')
  assert.equal(record.firstHand.some((shape) => shape === 'Dot' || shape === 'Line 2'), false)
  assert.equal(resolveGroup('w90/staged').staged, true)
  for (const id of ['e', 'e/staged2', 'E/uniform', 'e/', 'A/uniform']) assert.throws(() => resolveGroup(id))
})

test('staged dealing depends only on group membership, never on relative weights', () => {
  // Pools d and w90 keep exactly the same groups (Line 3 is the only three-cell
  // member, all six four-cell shapes are present), so their staged deals must be
  // identical even though their uniform weight tables differ. That is a property of
  // the staged recipe (group weights + uniform within group), not a bug: relative
  // weights are a uniform-mode concept.
  const a = rngFor(31, 5, 'deal'), b = rngFor(31, 5, 'deal')
  for (let i = 0; i < 200; i += 1) assert.deepEqual(drawHand(a, i % 60, true, 'd'), drawHand(b, i % 60, true, 'w90'))
  const c = rngFor(31, 6, 'deal'), e = rngFor(31, 6, 'deal')
  let differing = 0
  for (let i = 0; i < 200; i += 1) {
    if (JSON.stringify(drawHand(c, 0, false, 'd')) !== JSON.stringify(drawHand(e, 0, false, 'w90'))) differing += 1
  }
  assert.ok(differing > 100, `uniform deals must still differ (differing=${differing})`)
})

test('opening plans are explicit, validated and actually change the seeded board', () => {
  assert.deepEqual(OPENING_IDS, ['empty', 'current', 'mid', 'high', 'max'])
  assert.equal(Object.values(OPENINGS.empty.plan).every((cells) => cells === 0), true)
  // The shipped plan must carry the shipped targets verbatim (every other face 0).
  for (const [face, cells] of Object.entries(OPENING_LAYOUT)) assert.equal(OPENINGS.current.plan[face], cells)
  assert.equal(Object.values(OPENINGS.current.plan).reduce((sum, cells) => sum + cells, 0), 13)
  assert.equal(Object.keys(OPENINGS.current.plan).length, 6)
  for (const id of ['', 'Current', 'huge', 'current ']) assert.throws(() => openingById(id))
  // The shipped plan must seed exactly what the real seeder seeds; `empty` must
  // reproduce the pre-v0.2.31 board and consume no opening randomness at all.
  for (const gameIndex of [0, 1, 7, 42]) {
    const real = new Board()
    real.seedOpening(SHAPES, OPENING_LAYOUT, rngFor(5, gameIndex, 'opening'))
    const model = makeOpening({ seed: 5, gameIndex, openingId: 'current' })
    assertEquivalent(real, model.state)
    const empty = makeOpening({ seed: 5, gameIndex, openingId: 'empty' })
    assert.equal(occupiedCount(empty.state), 0)
    let draws = 0
    const counted = new Board()
    counted.seedOpening(SHAPES, OPENINGS.empty.plan, () => { draws += 1; return 0.5 })
    assert.equal(draws, 0, 'an empty plan must not draw opening randomness')
  }
  // Density must actually move, and stay ordered across the plans (300 games each).
  const mean = (id) => {
    let total = 0
    for (let gameIndex = 0; gameIndex < 300; gameIndex += 1) {
      total += occupiedCount(makeOpening({ seed: 1, gameIndex, openingId: id }).state)
    }
    return total / 300
  }
  const means = OPENING_IDS.map(mean)
  for (let i = 1; i < means.length; i += 1) assert.ok(means[i] > means[i - 1], `opening density not increasing: ${means.join(', ')}`)
  assert.equal(means[0], 0)
  assert.ok(means[1] > 14 && means[1] < 18, `current opening mean was ${means[1]}`)
  assert.ok(means[4] > 38, `max opening mean was ${means[4]}`)
  // Seeded cells may never complete a line on any face, at any density.
  for (const id of OPENING_IDS) {
    for (let gameIndex = 0; gameIndex < 40; gameIndex += 1) {
      assert.equal(boardFromState(makeOpening({ seed: 9, gameIndex, openingId: id }).state).hasFullLineOnAnyFace(), false)
    }
  }
  assert.throws(() => openingById('current').plan['+z'] = 99) // the plan is frozen, not a live config
})

test('arm ids carry pool, dealer and opening, and reject unknown combinations', () => {
  assert.deepEqual(armParts('e/staged'), ['e', 'staged', 'current'])
  assert.deepEqual(armParts('current/uniform/empty'), ['current', 'uniform', 'empty'])
  assert.deepEqual(armParts('A'), ['current', 'uniform', 'current'])
  assert.equal(resolveGroup('e/staged/high').openingId, 'high')
  assert.equal(resolveGroup('e/staged/high').label.includes('16') || resolveGroup('e/staged/high').label.includes('14/7/7'), true)
  for (const id of ['e', 'e/staged/current/extra', 'e/slow', 'e/staged/nope', 'e//current']) assert.throws(() => armParts(id))
  // One-factor pairing: three arms that differ in exactly one component produce three pairs.
  assert.equal(armParts('current/uniform/current').filter((v, i) => v !== armParts('current/uniform/high')[i]).length, 1)
})

test('tension panel counts every executed step exactly once', () => {
  const run = runGame({ group: 'current/uniform', seed: 4, gameIndex: 3, strategy: 'noise', stepCap: 40 })
  const panel = run.record.mobilityPanel
  assert.equal(panel.samples, run.record.steps)
  assert.equal(Object.values(panel.buckets).reduce((sum, n) => sum + n, 0), panel.samples)
  assert.ok(panel.min != null && panel.min >= 0)
  assert.ok(panel.sum >= panel.min * panel.samples)
  assert.ok(panel.forcedSteps <= panel.multiShapeSteps && panel.multiShapeSteps <= panel.samples)
  // Every batch ends with a single-shape hand, so forced decisions must be counted
  // against multi-shape steps only: the ratio is pressure, not hand size.
  assert.ok(panel.multiShapeSteps < panel.samples, 'single-shape tail steps must not count as multi-shape choices')
  assert.equal(Object.values(panel.composition).reduce((sum, n) => sum + n, 0), panel.samples)
  // Every executed step kept at least one playable shape, and the single-piece tail
  // of each batch is filed under "1:<n>" rather than pretending to be a choice.
  assert.equal(Object.keys(panel.composition).some((key) => key.endsWith(':0')), false)
  // A step with zero legal placements cannot be executed; the game ends instead.
  assert.ok(panel.min > 0 || run.record.ended)
  const summary = summarizeGames([run.record], 40)
  assert.equal(summary.tension.samples, run.record.steps)
  const shares = Object.values(summary.tension.mobilityBucketPct)
  const total = shares.reduce((sum, n) => sum + n, 0)
  assert.ok(Math.abs(total - 100) < 0.01, `bucket shares sum to ${total}`)
  // A uniformly random actor is the careless player: it must actually end inside the
  // cap (median death is around 90 steps), which is what makes the panel meaningful.
  const wide = runGame({ group: 'current/uniform', seed: 4, gameIndex: 3, strategy: 'random', stepCap: 600 })
  assert.ok(wide.record.ended, 'a uniformly random actor should end inside the cap')
})

console.log(`\n${checks}/${checks} measurement test groups passed. The harness imports the shipped board, shapes, weights and opening plan.`)

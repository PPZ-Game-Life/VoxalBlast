#!/usr/bin/env node
// Focused measurement tests; no browser or dependency installation required.
import assert from 'node:assert/strict'
import { Board, SH, FACES, faceLattice } from '../src/game/board.js'
import { SHAPES } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'
import {
  CELLS, PLACEMENTS, SHAPE_NAMES, stateFromBoard, boardFromState, stateKey,
  occupiedCount, canPlace, settle, rngFor, stageAt, drawHand, makeOpening,
  legalCount, chooseMove,
} from './difficulty-model.mjs'
import { parseArgs, quantile, wilson, summarizeGames, pairedComparison, runGame } from './difficulty-abcd.mjs'

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

console.log(`\n${checks}/${checks} measurement test groups passed. Official gameplay files were not edited.`)

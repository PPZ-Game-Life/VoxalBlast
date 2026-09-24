#!/usr/bin/env node
// Deal-core self-test (v0.9.0 P2 — §5/§6 of the producer's 2026-09-23 dealing spec).
//
//   node tools/deal-core-tests.mjs
//
// placementModel.js / boardPressure.js / handSolver.js are a SECOND implementation of
// rules that already exist in board.js. A second implementation is only worth having if
// it is checked against the first, so the first group below is a differential test: for
// thousands of (position, shape) pairs it asserts that the fast model finds exactly the
// placements Board.canPlace accepts and settles exactly the way Board.place settles —
// including the two behaviours the extraction is most likely to lose, the six-face
// batch clear and the shared edge/corner lattice cell.
//
// The remaining groups pin the properties the dealing director is going to trust:
// deduplication of physical placements, the solver's three-valued answer (and, above
// all, that a budget exhaustion is never reported as UNSOLVABLE), the monotonicity of
// R, and the A_lower/A_upper bounds narrowing as the node budget rises.
import { Board, SH, FACES, faceLattice } from '../src/game/board.js'
import { SHAPES, SHAPE_WEIGHTS, rotateCells, maxOrigin } from '../src/game/shapes.js'
import {
  CELL_COUNT, LINE_COUNT, createOccupancy, fromBoard, cloneOccupancy, occupancyCount, occupiedCoords,
  enumeratePlacements, placementsFor, applyPlacement, completionInfo, latticeIndex,
} from '../src/game/placementModel.js'
import {
  AVAILABILITY_CAP, PRESSURE_MIX, REFERENCE_POOL, REFERENCE_SHAPES, availability, occupancyRatio, placementCount,
  pressure, pressureDetail, room,
} from '../src/game/boardPressure.js'
import { LOW_BRANCH_THRESHOLD, PATHS_PER_FIRST_MOVE, SOLVE_STATUS, analyzeBatch, solveHand } from '../src/game/handSolver.js'

let passed = 0
const failures = []
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

// Deterministic RNG, so a failure is reproducible. `pick` clamps: the generator's top
// value is exactly 1.0 once in a while, and an unclamped index would be `undefined`.
function rng(seed = 20260923) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

function pick(random, list) {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))]
}

const SHAPE_BY_NAME = new Map(SHAPES.map((shape) => [shape.name, shape]))
const cellsOf = (name) => SHAPE_BY_NAME.get(name).cells
const dot = SHAPE_BY_NAME.get('Dot')
const line2 = SHAPE_BY_NAME.get('Line 2')
const square = SHAPE_BY_NAME.get('Square')
const block9 = SHAPE_BY_NAME.get('Block 9')

// ---------------------------------------------------------------- shared helpers

function boardKeys(board) {
  return new Set(board.occupied().map((cell) => `${cell.x},${cell.y},${cell.z}`))
}

function occKeys(occ) {
  return new Set(occupiedCoords(occ).map((cell) => cell.join(',')))
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((key) => b.has(key))
}

function cloneBoard(board) {
  const copy = new Board()
  copy.restore({ cells: board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]), score: board.score, totalLines: board.totalLines })
  return copy
}

function boardFromOccupancy(occ) {
  const board = new Board()
  board.restore({ cells: occupiedCoords(occ).map((cell) => [...cell, 0xffffff]) })
  return board
}

// Ground truth: every (face, rotation, origin) Board.canPlace accepts, deduplicated by
// the cell set it covers — exactly the set the fast model has to reproduce.
function boardPlacements(board, cells) {
  const out = new Map()
  for (const face of FACES) {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const shape = rotateCells(cells, quarter)
      const { u: uMax, v: vMax } = maxOrigin(shape, SH)
      for (let u = 0; u < uMax; u += 1) {
        for (let v = 0; v < vMax; v += 1) {
          if (!board.canPlace(face, shape, { u, v })) continue
          const key = shape
            .map(([du, dv]) => faceLattice(face, u + du, v + dv).join(','))
            .sort()
            .join(';')
          if (!out.has(key)) out.set(key, { face, cells: shape, origin: { u, v } })
        }
      }
    }
  }
  return out
}

// The same key for a placement object, so the two sides are comparable.
function modelKey(placement) {
  return placement.coords.map((cell) => cell.join(',')).sort().join(';')
}

// A position reached the way the game reaches one: legal drops, settled every time.
function playedPosition(random, drops) {
  const board = new Board()
  for (let i = 0; i < drops; i += 1) {
    const shape = pick(random, SHAPES)
    const legal = boardPlacements(board, shape.cells)
    if (legal.size === 0) continue
    const move = pick(random, [...legal.values()])
    board.place(move.face, move.cells, move.origin, shape.color)
  }
  return board
}

// A position no game reaches, but a legal one all the same: shell cells set directly.
// This is the half of the differential that catches "clears only what the piece
// touched" — a raw position can already hold a full line somewhere else on the cube,
// and Board.place clears that too (it scans all 60 lines after the drop).
function rawPosition(random, cells) {
  const board = new Board()
  const used = new Set()
  for (let i = 0; i < cells * 3; i += 1) {
    const x = Math.floor(random() * SH)
    const y = Math.floor(random() * SH)
    const z = Math.floor(random() * SH)
    if (x !== 0 && x !== SH - 1 && y !== 0 && y !== SH - 1 && z !== 0 && z !== SH - 1) continue
    used.add(`${x},${y},${z}`)
    if (used.size >= cells) break
  }
  board.restore({ cells: [...used].map((key) => key.split(',').map(Number)) })
  return board
}

// A board that is FULL except for `free` (lattice coordinates). The nearly-full
// positions the "provably impossible" checks need cannot be reached by play — a played
// board that crowded is already over — so they are constructed directly.
function almostFullBoard(free) {
  const freeKeys = new Set(free.map((cell) => cell.join(',')))
  const filled = []
  for (let x = 0; x < SH; x += 1) {
    for (let y = 0; y < SH; y += 1) {
      for (let z = 0; z < SH; z += 1) {
        if (x !== 0 && x !== SH - 1 && y !== 0 && y !== SH - 1 && z !== 0 && z !== SH - 1) continue
        if (freeKeys.has(`${x},${y},${z}`)) continue
        filled.push([x, y, z])
      }
    }
  }
  const board = new Board()
  board.restore({ cells: filled })
  return board
}

// ------------------------------------------------------------------ 1. differential
// The gate the spec asks for: "提取后六面消除和共享晶格行为一致".
const DIFFERENTIAL_PLAYED = 170
const DIFFERENTIAL_RAW = 70
const SETTLE_SAMPLES = 6

{
  const random = rng(4711)
  let pairs = 0
  let roundTripFailures = 0
  let enumerationFailures = 0
  let settleFailures = 0
  let settleCompared = 0
  let firstEnumerationFailure = ''
  let firstSettleFailure = ''

  const positions = []
  for (let i = 0; i < DIFFERENTIAL_PLAYED; i += 1) positions.push(playedPosition(random, 4 + (i % 16)))
  for (let i = 0; i < DIFFERENTIAL_RAW; i += 1) positions.push(rawPosition(random, 12 + Math.floor(random() * 55)))

  for (const board of positions) {
    const occ = fromBoard(board)
    // The occupancy round-trips: the differential is meaningless if it does not.
    if (!sameSet(occKeys(occ), boardKeys(board)) || occupancyCount(occ) !== board.cells.size) roundTripFailures += 1
    for (const shape of SHAPES) {
      pairs += 1
      const truth = boardPlacements(board, shape.cells)
      const model = enumeratePlacements(occ, shape.cells)
      const modelKeys = new Set(model.map(modelKey))
      if (modelKeys.size !== truth.size || [...truth.keys()].some((key) => !modelKeys.has(key))) {
        enumerationFailures += 1
        if (!firstEnumerationFailure) firstEnumerationFailure = `${shape.name} on ${board.cells.size} cells: model ${modelKeys.size}, Board ${truth.size}`
        continue
      }
      // Settle comparison on a deterministic slice of the legal moves.
      for (let i = 0; i < model.length && i < SETTLE_SAMPLES; i += 1) {
        const placement = model[i]
        const replay = cloneBoard(board)
        const settled = replay.place(placement.face, placement.cells, placement.origin, 0xffffff)
        const applied = applyPlacement(occ, placement)
        settleCompared += 1
        if (settled.cellsCleared !== applied.cellsCleared || settled.lines.length !== applied.lines.length
          || settled.facesHit !== applied.facesHit || !sameSet(boardKeys(replay), occKeys(applied.occ))) {
          settleFailures += 1
          if (!firstSettleFailure) {
            firstSettleFailure = `${shape.name} ${placement.face} q${placement.quarter} @${placement.origin.u},${placement.origin.v}: `
              + `cleared ${applied.cellsCleared}/${settled.cellsCleared}, lines ${applied.lines.length}/${settled.lines.length}, `
              + `faces ${applied.facesHit}/${settled.facesHit}, cells ${occKeys(applied.occ).size}/${boardKeys(replay).size}`
          }
        }
      }
    }
  }

  check('the occupancy round-trips against Board on every position', roundTripFailures === 0, `${roundTripFailures} positions disagreed`)
  check('the differential ran a few thousand (position, shape) pairs', pairs >= 3000, `${pairs} pairs`)
  check('enumeratePlacements matches Board.canPlace on every pair', enumerationFailures === 0, firstEnumerationFailure)
  check('applyPlacement settles exactly like Board.place', settleFailures === 0, firstSettleFailure)
  check('the settle half of the differential is non-trivial', settleCompared >= 8000, `${settleCompared} settles compared`)

  // A clear that only the far side of the cube can see: the piece lands on +z and the
  // completed line is on -y, sharing the edge cells (x, 0, 4). Board.place clears it
  // because it settles all six faces; a model that settled the played face alone would
  // leave the line standing — the exact v0.3 bug this pair guards.
  const crossing = new Board()
  const seeded = []
  for (let x = 0; x < SH; x += 1) {
    for (let z = 0; z < SH; z += 1) {
      if (z === SH - 1 && x >= 1) continue // leave the +z row v=4 free for the drop below
      seeded.push([x, 0, z])
    }
  }
  crossing.restore({ cells: seeded })
  const crossingOcc = fromBoard(crossing)
  const drop = [...boardPlacements(crossing, line2.cells).values()].find((move) => move.face === '+z' && move.origin.v === 0)
  if (!drop) {
    check('a cross-face clear setup exists to test', false, 'no +z Line 2 placement found')
  } else {
    const replay = cloneBoard(crossing)
    const settled = replay.place(drop.face, drop.cells, drop.origin, 0xffffff)
    const placement = enumeratePlacements(crossingOcc, line2.cells)
      .find((candidate) => candidate.face === drop.face && candidate.origin.u === drop.origin.u && candidate.origin.v === drop.origin.v)
    const applied = applyPlacement(crossingOcc, placement)
    check('a drop on +z clears a line on -y through the shared edge',
      settled.lines.some((line) => line.face === '-y') && applied.lines.some((line) => line.face === '-y'))
    equal('cross-face clear agrees on the cleared cell count', applied.cellsCleared, settled.cellsCleared)
    equal('cross-face clear agrees on the faces hit', applied.facesHit, settled.facesHit)
    equal('cross-face clear agrees on the line count', applied.lines.length, settled.lines.length)
  }

  // completionInfo is the ordering shortcut. It may only be trusted on a state that has
  // no already-full line, so it is checked exactly there — against the full settle.
  const shortcut = rng(606)
  let shortcutChecked = 0
  let shortcutFailures = 0
  for (let i = 0; i < 40; i += 1) {
    const board = playedPosition(shortcut, 4 + (i % 14))
    const occ = fromBoard(board)
    for (const shape of SHAPES) {
      for (const placement of enumeratePlacements(occ, shape.cells).slice(0, 2)) {
        const applied = applyPlacement(occ, placement)
        const shortcutInfo = completionInfo(occ, placement)
        shortcutChecked += 1
        if (shortcutInfo.lines !== applied.lines.length || shortcutInfo.cellsCleared !== applied.cellsCleared) shortcutFailures += 1
      }
    }
  }
  check('the ordering shortcut agrees with the full settle on clean states', shortcutFailures === 0, `${shortcutFailures}/${shortcutChecked}`)
  check('the ordering shortcut was actually exercised', shortcutChecked >= 500, `${shortcutChecked}`)
}

// -------------------------------------------------------------------- 2. dedup
// A Dot on a shared edge/corner cell is ONE physical placement. The naive
// face-by-face enumeration counts it once per face that can see it, which is what makes
// this check able to fail.
{
  const empty = createOccupancy()
  const dotPlacements = enumeratePlacements(empty, dot.cells)
  equal('a Dot has exactly one placement per shell cell', dotPlacements.length, CELL_COUNT)
  equal('the model knows all 98 shell cells', CELL_COUNT, 98)
  equal('the model knows all 60 face lines', LINE_COUNT, 60)

  const corner = [0, 0, 0]
  const edge = [0, 0, 2]
  const inner = [0, 2, 2]
  const covering = (coords) => dotPlacements.filter((placement) => placement.coords.some((cell) => cell.join(',') === coords.join(',')))

  equal('the corner cell is reachable from three faces but is one placement', covering(corner).length, 1)
  equal('a shared edge cell is reachable from two faces but is one placement', covering(edge).length, 1)
  equal('a non-shared cell is one placement', covering(inner).length, 1)

  // Proof the check above can fail: the naive face-by-face count for the same cells.
  const naive = (coords) => {
    let count = 0
    for (const face of FACES) {
      for (let u = 0; u < SH; u += 1) {
        for (let v = 0; v < SH; v += 1) {
          if (faceLattice(face, u, v).join(',') === coords.join(',')) count += 1
        }
      }
    }
    return count
  }
  equal('the corner really is reachable from 3 faces', naive(corner), 3)
  equal('the edge cell really is reachable from 2 faces', naive(edge), 2)
  equal('the deduplicated list still covers every cell', new Set(dotPlacements.map(modelKey)).size, CELL_COUNT)

  // A Dot on the corner has exactly one placement in the model, and it is legal to
  // apply exactly once: placing it must set one cell, not three.
  const placed = applyPlacement(empty, covering(corner)[0])
  equal('the corner placement fills one lattice cell', occupancyCount(placed.occ), 1)

  // placementsFor is stable and frozen: the dealer holds these objects across calls.
  check('placementsFor returns the same list for the same shape', placementsFor(dot.cells) === placementsFor(dot.cells))
  check('placement records are frozen', Object.isFrozen(placementsFor(square.cells)[0]))
}

// -------------------------------------------------------------------- 3. solver
{
  // SOLVABLE, with a witness that replays on a real Board.
  const random = rng(90210)
  const board = playedPosition(random, 9)
  const occ = fromBoard(board)
  const hand = ['Line 3', 'Square', 'Dot'].map(cellsOf)
  const solved = solveHand(occ, hand, { nodeBudget: 20000 })
  equal('solveHand proves a plainly solvable batch', solved.status, SOLVE_STATUS.SOLVABLE)
  check('the witness places every piece exactly once', solved.witness !== null
    && solved.witness.length === hand.length
    && new Set(solved.witness.map((entry) => entry.pieceIndex)).size === hand.length)
  check('the witness names the pieces the caller handed in', solved.witness.every((entry) => entry.pieceIndex >= 0 && entry.pieceIndex < hand.length))

  const replay = cloneBoard(board)
  let replayOk = true
  for (const entry of solved.witness) {
    // The witness must be replayable through the REAL board, not just through the model.
    if (!replay.canPlace(entry.face, entry.cells, entry.origin)) { replayOk = false; break }
    replay.place(entry.face, entry.cells, entry.origin, 0xffffff)
  }
  check('every witness move is legal on a real Board', replayOk)
  const ending = occKeys(solved.states[0])
  check('the replayed witness lands on the state the solver promised', replayOk && sameSet(ending, boardKeys(replay)))
  check('the batch really changed the board', replayOk && !sameSet(ending, boardKeys(board)))
  check('the solver reports the node count it used', solved.nodes > 0 && solved.nodes < 20000, `${solved.nodes}`)

  // UNSOLVABLE, the spec's own example: three Block 9 on a nearly-full board.
  const nearlyFull = almostFullBoard([[0, 0, 4], [2, 0, 4], [4, 0, 4], [0, 2, 4], [4, 2, 4], [0, 4, 4], [2, 4, 4], [4, 4, 4]])
  const nearlyFullOcc = fromBoard(nearlyFull)
  equal('the nearly-full board has fewer than nine free cells', CELL_COUNT - occupancyCount(nearlyFullOcc), 8)
  equal('Block 9 has nowhere to go on it', placementCount(nearlyFullOcc, block9.cells), 0)
  const impossible = solveHand(nearlyFullOcc, [block9.cells, block9.cells, block9.cells], { nodeBudget: 20000 })
  equal('three Block 9 on a board with no 3x3 hole is UNSOLVABLE', impossible.status, SOLVE_STATUS.UNSOLVABLE)
  equal('that answer did not come from a budget exhaustion', impossible.exhausted, false)
  equal('a board with no legal branch at all is a proof even with no budget',
    solveHand(nearlyFullOcc, [block9.cells], { nodeBudget: 0 }).status, SOLVE_STATUS.UNSOLVABLE)

  // Two cases the solver's ORDER search is what makes findable, both located by a
  // seeded scan rather than pinned by hand — a hand-built "nearly full" board is very
  // hard to keep clear-free, because a placement on a crowded face usually completes a
  // line through a shared edge and frees the board back up. Scanning keeps the checks
  // honest: if no such position exists, the test says so instead of silently passing.
  let impossibleCase = null
  let orderCase = null
  for (let seed = 1; seed <= 12 && (!impossibleCase || !orderCase); seed += 1) {
    if (!impossibleCase) {
      const candidate = fromBoard(playedPosition(rng(seed), 34))
      for (const names of [['Rect 6', 'Block 9'], ['Block 9', 'Square'], ['Square', 'Square'], ['L 5', 'Rect 6'], ['Block 9', 'Block 9']]) {
        const result = solveHand(candidate, names.map(cellsOf), { nodeBudget: 200000 })
        if (result.status === SOLVE_STATUS.UNSOLVABLE && result.nodes >= 2 && !result.exhausted) {
          impossibleCase = { result, candidate, names, seed }
          break
        }
      }
    }
    if (!orderCase) {
      const candidate = fromBoard(playedPosition(rng(seed), 24))
      for (const names of [['Rect 6', 'L 5'], ['S', 'Rect 6'], ['Z', 'Square'], ['L 5', 'Square'], ['Square', 'Rect 6']]) {
        const hand = names.map(cellsOf)
        const branches = enumeratePlacements(candidate, hand[0]).length
        // The first piece must HAVE moves — otherwise "it went second" proves nothing.
        if (branches === 0) continue
        const result = solveHand(candidate, hand, { nodeBudget: 60000 })
        if (result.status === SOLVE_STATUS.SOLVABLE && result.witness[0].pieceIndex === 1) {
          orderCase = { result, names, seed, branches }
          break
        }
      }
    }
  }

  // UNSOLVABLE with a search behind it: the failure has to be walked branch by branch.
  if (!impossibleCase) {
    check('a provably impossible batch with a real search behind it exists', false, 'no seed produced UNSOLVABLE with nodes >= 2')
  } else {
    check('an impossible batch is proven by walking the branches',
      impossibleCase.result.exhausted === false && impossibleCase.result.nodes >= 2,
      `${impossibleCase.names.join('+')} on seed ${impossibleCase.seed}: nodes ${impossibleCase.result.nodes}`)
    equal('the impossible batch is reported UNSOLVABLE', impossibleCase.result.status, SOLVE_STATUS.UNSOLVABLE)

    // The rule that matters most: a budget that runs out is UNKNOWN, never UNSOLVABLE.
    const starved = solveHand(impossibleCase.candidate, impossibleCase.names.map(cellsOf), { nodeBudget: 1 })
    equal('a starved search reports UNKNOWN', starved.status, SOLVE_STATUS.UNKNOWN)
    check('a starved search is never called UNSOLVABLE', starved.status !== SOLVE_STATUS.UNSOLVABLE)
    equal('a starved search reports the exhaustion', starved.exhausted, true)
    check('the starved search is starved of nodes, not of branches', starved.nodes < impossibleCase.result.nodes,
      `${starved.nodes} vs ${impossibleCase.result.nodes}`)

    const cancelled = solveHand(impossibleCase.candidate, impossibleCase.names.map(cellsOf), { nodeBudget: 200000, isCancelled: () => true })
    equal('a cancelled search reports UNKNOWN', cancelled.status, SOLVE_STATUS.UNKNOWN)
  }

  // The order of the batch is part of the search. Here the caller's FIRST piece has
  // legal moves, every one of them is dead, and the batch only completes with the
  // second piece placed first. A solver that only tried the hand in the given order
  // would call this solvable batch impossible.
  if (!orderCase) {
    check('a batch that only works in a non-obvious order exists', false, 'no seed produced a witness starting with the second piece')
  } else {
    equal('a batch whose first piece is dead is still solved', orderCase.result.status, SOLVE_STATUS.SOLVABLE)
    equal('the solver placed the second piece first', orderCase.result.witness[0].pieceIndex, 1)
    check('the dead first piece really had moves to try', orderCase.branches >= 1, `${orderCase.branches} branches`)
    check('the order search walked the dead branches before finding the path',
      orderCase.result.nodes > orderCase.branches, `nodes ${orderCase.result.nodes}, dead branches ${orderCase.branches}`)
    check('the witness still covers the whole hand', orderCase.result.witness.length === 2
      && new Set(orderCase.result.witness.map((entry) => entry.pieceIndex)).size === 2)
  }

  // Repeated shapes keep their multiplicity: two Dots are two pieces.
  const pair = solveHand(createOccupancy(), [dot.cells, dot.cells], { nodeBudget: 20000 })
  equal('two Dots on an empty cube are solvable', pair.status, SOLVE_STATUS.SOLVABLE)
  equal('the witness places both Dots', pair.witness.length, 2)
  check('the two Dots are different pieces', pair.witness[0].pieceIndex !== pair.witness[1].pieceIndex)
  const threeBlock = solveHand(createOccupancy(), [block9.cells, block9.cells, block9.cells], { nodeBudget: 20000 })
  equal('three Block 9 on an empty cube are solvable', threeBlock.status, SOLVE_STATUS.SOLVABLE)
  equal('the empty cube accepts all three Block 9', threeBlock.witness.length, 3)

  // An empty batch is trivially placeable, and says so instead of crashing.
  const emptyHand = solveHand(occ, [], { nodeBudget: 100 })
  equal('an empty batch is solvable', emptyHand.status, SOLVE_STATUS.SOLVABLE)
  equal('an empty batch has an empty witness', emptyHand.witness.length, 0)
}

// ------------------------------------------------------------------- 4. pressure
{
  const empty = createOccupancy()
  const emptyDetail = pressureDetail(empty)
  // Computed, not guessed: on an empty cube every reference shape has far more than
  // AVAILABILITY_CAP placements, so room saturates at 1 and only the (empty) occupancy
  // term is left. Measured value: room 1, occupancy 0, R 0.
  equal('room is 1 on an empty cube', emptyDetail.room, 1)
  equal('occupancy is 0 on an empty cube', emptyDetail.occupancy, 0)
  equal('R is 0 on an empty cube', pressure(empty), 0)
  check('every reference shape saturates on an empty cube', emptyDetail.shapes.every((shape) => shape.availability === 1))
  check('the reference pool carries no Block 9', !REFERENCE_SHAPES.includes('Block 9'))
  check('the reference pool carries Line 4', REFERENCE_SHAPES.includes('Line 4'))
  equal('the reference pool is the shipped pool minus Block 9', REFERENCE_SHAPES.length, SHAPES.length - 1)
  // The pool is exported as shape records too: the constructive fallback has to PLACE
  // real pieces, so it needs cells, not just names.
  check('the reference pool exposes placeable shape records', REFERENCE_POOL.length === REFERENCE_SHAPES.length
    && REFERENCE_POOL.every((entry) => Array.isArray(entry.cells) && entry.cells.length > 0 && entry.weight === SHAPE_WEIGHTS[entry.name]))
  equal('the availability cap is the spec\'s 12', AVAILABILITY_CAP, 12)
  equal('the pressure mix is the spec\'s 0.75/0.25', PRESSURE_MIX.room + PRESSURE_MIX.occupancy, 1)
  equal('the cap really caps a Dot\'s availability', availability(empty, dot.cells), 1)
  check('a Dot has more placements than the cap on an empty cube', placementCount(empty, dot.cells) > AVAILABILITY_CAP)

  // ~50% full: the reading the report quotes.
  const random = rng(2024)
  const half = fromBoard(playedPosition(random, 16))
  const halfDetail = pressureDetail(half)
  console.log(`  half-full sample: ${occupancyCount(half)}/98 cells, room ${halfDetail.room.toFixed(4)}, occupancy ${halfDetail.occupancy.toFixed(4)}, R ${halfDetail.pressure.toFixed(4)}`)
  check('the half-full sample really is about half full', halfDetail.occupancy > 0.4 && halfDetail.occupancy < 0.62, `${halfDetail.occupancy.toFixed(3)}`)
  check('R grows from the empty baseline', halfDetail.pressure > 0)
  check('a half-full board is still roomy', halfDetail.room > 0.5, `${halfDetail.room.toFixed(3)}`)

  // A packed board: the other end of the gauge, so the reading above means something.
  const packed = fromBoard(almostFullBoard([[0, 0, 4], [1, 0, 4], [0, 1, 4], [1, 1, 4]]))
  const packedDetail = pressureDetail(packed)
  console.log(`  packed sample: ${occupancyCount(packed)}/98 cells, room ${packedDetail.room.toFixed(4)}, occupancy ${packedDetail.occupancy.toFixed(4)}, R ${packedDetail.pressure.toFixed(4)}`)
  check('R on a nearly-full board is high', packedDetail.pressure > 0.6, `${packedDetail.pressure.toFixed(3)}`)
  check('R orders the samples empty < half < packed',
    pressure(empty) < halfDetail.pressure && halfDetail.pressure < packedDetail.pressure,
    `${pressure(empty)} / ${halfDetail.pressure} / ${packedDetail.pressure}`)

  // Monotonicity: filling more cells never lowers R. Holds because adding an occupied
  // cell can only remove legal placements (room falls or stays) while occupancy rises.
  // Compared with a tolerance because room() sums 1/12ths, which are not exact in
  // binary floating point — the tolerance is for the summation, not for the claim.
  const monotone = rng(777)
  let pairs = 0
  let violations = 0
  let firstViolation = ''
  for (let i = 0; i < 220; i += 1) {
    const occ = fromBoard(playedPosition(monotone, 2 + Math.floor(monotone() * 14)))
    const grown = cloneOccupancy(occ)
    let added = 0
    for (let attempt = 0; attempt < 60 && added < 1 + Math.floor(monotone() * 5); attempt += 1) {
      const index = latticeIndex(Math.floor(monotone() * SH), Math.floor(monotone() * SH), Math.floor(monotone() * SH))
      if (grown[index] !== 0) continue
      grown[index] = 1
      added += 1
    }
    if (added === 0) continue
    pairs += 1
    const before = pressure(occ)
    const after = pressure(grown)
    if (after < before - 1e-12) {
      violations += 1
      if (!firstViolation) firstViolation = `${occupancyCount(occ)} → ${occupancyCount(grown)} cells: ${before} → ${after}`
    }
  }
  check('R is monotone over a seeded sample', violations === 0, firstViolation)
  check('the monotonicity sample is non-trivial', pairs >= 150, `${pairs} pairs`)

  // The per-shape breakdown must agree with the scalar path it is meant to explain.
  check('pressureDetail agrees with room() and pressure()', Math.abs(halfDetail.room - room(half)) < 1e-12
    && Math.abs(halfDetail.pressure - pressure(half)) < 1e-12
    && Math.abs(halfDetail.occupancy - occupancyRatio(half)) < 1e-12)
  check('availability never exceeds 1', halfDetail.shapes.every((shape) => shape.availability <= 1))
  check('the breakdown covers the whole reference pool', halfDetail.shapes.length === REFERENCE_SHAPES.length)
  check('the reference pool uses the shipped base weights', halfDetail.shapes.every((shape) => shape.weight === SHAPE_WEIGHTS[shape.name]))
}

// ---------------------------------------------------------------------- 5. batch
{
  const random = rng(31337)
  const hands = [
    ['Dot', 'Dot', 'Dot'],
    ['Line 4', 'Line 4', 'Block 9'],
    ['Line 3', 'Square', 'Dot'],
    ['Block 9', 'Rect 6', 'L 5'],
    ['Corner', 'Slant 3', 'Line 2'],
  ]
  let checked = 0
  let boundsOk = true
  let accountingOk = true
  let lowBranchSeen = false
  let witnessOk = true
  let witnessChecked = 0
  let maxK = 0
  let detail = ''
  for (let i = 0; i < 40; i += 1) {
    const occ = fromBoard(playedPosition(random, 2 + (i % 16)))
    const hand = hands[i % hands.length].map(cellsOf)
    const result = analyzeBatch(occ, hand, { random: rng(1000 + i), nodeBudget: 1200 })
    checked += 1
    maxK = Math.max(maxK, result.K)
    if (!(result.aLower <= result.aUpper) || result.aLower < 0 || result.aUpper > 1) {
      boundsOk = false
      if (!detail) detail = `K ${result.K}, S ${result.S}, F ${result.F}, U ${result.U}, ${result.aLower}..${result.aUpper}`
    }
    if (result.K !== result.S + result.F + result.U || result.K > 24 || result.endings.length > 2 * result.K) accountingOk = false
    if (result.lowBranch) lowBranchSeen = true
    if (result.witness) {
      witnessChecked += 1
      const replay = boardFromOccupancy(occ)
      let ok = result.witness.length === hand.length
      for (const entry of result.witness) {
        if (!ok || !replay.canPlace(entry.face, entry.cells, entry.origin)) { ok = false; break }
        replay.place(entry.face, entry.cells, entry.origin, 0xffffff)
      }
      if (!ok) witnessOk = false
    }
    check('a bounded batch reports pressures in range', result.endingPressures.every((value) => value >= 0 && value <= 1))
  }
  check('analyzeBatch bounds stay ordered and inside [0,1]', boundsOk, detail)
  check('analyzeBatch accounts for every sample', accountingOk)
  check('analyzeBatch never samples more than 24 first moves', maxK <= 24, `max K ${maxK}`)
  check('the bounded batch sample was actually taken', maxK === 24, `max K ${maxK}`)
  check('the sampled batch set is non-trivial', checked === 40)
  check('every reported witness replays on a real Board', witnessOk, `${witnessChecked} witnesses`)
  check('witnesses were actually produced', witnessChecked >= 20, `${witnessChecked}`)
  check('the low-branch case is reachable', lowBranchSeen)
  equal('the low-branch threshold is the spec\'s 16', LOW_BRANCH_THRESHOLD, 16)
  equal('at most two endings per first move', PATHS_PER_FIRST_MOVE, 2)

  // The `samples` option is honoured.
  const board = playedPosition(rng(1234), 11)
  const occ = fromBoard(board)
  const hand = ['Line 3', 'L 5', 'Dot'].map(cellsOf)
  const few = analyzeBatch(occ, hand, { samples: 8, random: rng(42), nodeBudget: 2000 })
  check('a smaller sample request is honoured', few.K <= 8, `K ${few.K}`)
  check('a smaller sample still reports ordered bounds', few.aLower <= few.aUpper)

  // A board with fewer than 16 legal first moves: cover them all and say so.
  const pocket = almostFullBoard([[0, 0, 4], [1, 0, 4], [0, 1, 4], [1, 1, 4]])
  const lowBranch = analyzeBatch(fromBoard(pocket), [dot.cells, square.cells], { random: rng(5), nodeBudget: 4000 })
  check('a low-branch board reports itself as low-branch', lowBranch.lowBranch === true)
  equal('a low-branch board covers every first move it has', lowBranch.K, lowBranch.firstMoves)
  check('a low-branch board has fewer than 16 first moves', lowBranch.firstMoves < LOW_BRANCH_THRESHOLD, `${lowBranch.firstMoves}`)
  equal('the low-branch board has four Dot moves and one Square move', lowBranch.firstMoves, 5)
  equal('the low-branch analysis is exact (no unknowns)', lowBranch.U, 0)
  equal('every low-branch first move completes (the pocket clears its own way out)', lowBranch.S, 5)
  check('the low-branch endings name the first moves that produced them',
    lowBranch.endings.every((ending) => ending.pieceIndex >= 0 && ending.pieceIndex < 2))
  check('the low-branch analysis has an ending to measure', lowBranch.rEnd !== null)

  // Determinism: the same seeded RNG gives the same analysis.
  const first = analyzeBatch(occ, hand, { random: rng(99), nodeBudget: 2000 })
  const second = analyzeBatch(occ, hand, { random: rng(99), nodeBudget: 2000 })
  check('a seeded analyzeBatch is deterministic', first.K === second.K && first.S === second.S && first.U === second.U
    && first.rEnd === second.rEnd && JSON.stringify(first.endingPressures) === JSON.stringify(second.endingPressures))
  const viaRng = analyzeBatch(occ, hand, { rng: rng(99), nodeBudget: 2000 })
  check('the rng option is an accepted alias for random', viaRng.K === first.K && viaRng.S === first.S
    && viaRng.U === first.U && viaRng.rEnd === first.rEnd)

  // The bounds have to narrow when the search is given more room. The starved arm is
  // deliberately tight: the per-sample share is a couple of nodes, so some samples come
  // back UNKNOWN and A_upper sits above A_lower. Raising the budget resolves them and
  // the interval collapses onto the lower bound — which must not move.
  let shrink = null
  for (let seed = 1; seed <= 12 && !shrink; seed += 1) {
    const candidate = fromBoard(playedPosition(rng(seed), 18 + (seed % 20)))
    const candidateHand = [SHAPES[seed % SHAPES.length], SHAPES[(seed * 7) % SHAPES.length], SHAPES[(seed * 13) % SHAPES.length]].map((shape) => shape.cells)
    const starved = analyzeBatch(candidate, candidateHand, { random: rng(seed), nodeBudget: 120 })
    if (starved.U === 0) continue
    const rich = analyzeBatch(candidate, candidateHand, { random: rng(seed), nodeBudget: 200000 })
    if (rich.aUpper - rich.aLower < starved.aUpper - starved.aLower) shrink = { seed, starved, rich }
  }
  if (!shrink) {
    check('a hand with a non-zero unknown share exists to test the shrink', false, 'no seed produced U > 0')
  } else {
    check('raising the node budget narrows the tolerance interval',
      shrink.rich.aUpper - shrink.rich.aLower < shrink.starved.aUpper - shrink.starved.aLower,
      `seed ${shrink.seed}: ${shrink.starved.aLower.toFixed(3)}..${shrink.starved.aUpper.toFixed(3)} (U ${shrink.starved.U}) → ${shrink.rich.aLower.toFixed(3)}..${shrink.rich.aUpper.toFixed(3)} (U ${shrink.rich.U})`)
    check('the richer arm resolves unknown samples', shrink.rich.U < shrink.starved.U, `${shrink.starved.U} → ${shrink.rich.U}`)
    check('the lower bound does not move when the budget rises', shrink.rich.aLower >= shrink.starved.aLower,
      `${shrink.starved.aLower} → ${shrink.rich.aLower}`)
    check('the richer arm is exact', shrink.rich.U === 0)
  }

  // R_end is the median of the sampled ending pressures, and it is a pressure: on a
  // board that can absorb the batch it must sit near R_start.
  const start = pressure(occ)
  check('R_end is a pressure near R_start for a comfortable batch',
    first.rEnd !== null && Math.abs(first.rEnd - start) < 0.5,
    `rStart ${start.toFixed(4)}, rEnd ${first.rEnd}`)
  check('at most two endings per sampled first move are kept',
    first.endings.length <= PATHS_PER_FIRST_MOVE * first.K, `${first.endings.length} endings for K ${first.K}`)
}

// ----------------------------------------------------------------------- 6. perf
// Measured, not asserted tightly: the deal's own budget (48 analyses per candidate
// batch, ~150ms p95) is the producer's number, and this run is a tripwire for a
// regression that removes the availability cap or the flat index buffer — not a
// benchmark. The ceiling is deliberately far above the target so a slow machine cannot
// fail the suite.
{
  const random = rng(5150)
  const hands = [['Dot', 'Dot', 'Dot'], ['Line 3', 'Square', 'Dot'], ['Block 9', 'Rect 6', 'L 5'], ['Line 4', 'Corner', 'Line 2']]
  const cases = []
  for (let i = 0; i < 48; i += 1) {
    // 8..36 drops, so the sample covers the open phase AND the crowded endgame where
    // the search actually has to work. This is the steady-state cost: the placement
    // tables are already built by the groups above, and a cold first call in a browser
    // pays ~20ms once to build all fifteen of them.
    cases.push({
      occ: fromBoard(playedPosition(random, 8 + (i % 29))),
      hand: hands[i % hands.length].map(cellsOf),
    })
  }
  const timings = []
  let totalNodes = 0
  for (let i = 0; i < cases.length; i += 1) {
    const started = performance.now()
    const result = analyzeBatch(cases[i].occ, cases[i].hand, { random: rng(200 + i) })
    timings.push(performance.now() - started)
    totalNodes += result.nodes
  }
  timings.sort((a, b) => a - b)
  const p50 = timings[Math.floor(timings.length * 0.5)]
  const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))]
  const worst = timings[timings.length - 1]
  const sum = timings.reduce((a, b) => a + b, 0)
  console.log(`  analyzeBatch × 48: total ${sum.toFixed(1)}ms, p50 ${p50.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms, max ${worst.toFixed(2)}ms (${totalNodes} nodes)`)
  check('48 analyses stay inside a generous regression ceiling', sum < 1500, `${sum.toFixed(1)}ms`)
}

// ---------------------------------------------------------------------- report
const elapsed = performance.now()
console.log(`deal-core-tests: ${passed}/${passed + failures.length} checks passed`)
if (failures.length) {
  console.log('\nFAILED:')
  failures.forEach((failure) => console.log(`  - ${failure}`))
  process.exitCode = 1
} else {
  console.log('all deal-core checks passed')
}
console.log(`deal-core-tests: ${elapsed.toFixed(0)}ms`)

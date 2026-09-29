// The deal worker's contract, and the parity that makes putting a run behind it safe (v0.9.31).
//
//   node tools/deal-worker-tests.mjs
//
// Why this is a test and not a claim. v0.9.31 moved the board-aware search off the main thread:
// session.dealAsync() posts the run's state to game/dealWorker.js, and the frame the player
// released a piece on no longer pays for the search. Two things have to be true for that to be
// safe, and neither is visible in a screenshot:
//
//   1. THE WORKER DEALS EXACTLY WHAT THE SYNCHRONOUS PATH DEALS. Both run the same function
//      (dealRun.runDeal), but the state crosses a serialization boundary to get there — the board
//      as [x, y, z, color] rows, the director through serialize()/revive(), the random streams
//      through snapshot()/restore(). If any of those lost a field or reordered a draw, the worker
//      would silently deal a DIFFERENT hand than the fallback, and a run would stop being
//      replayable from its save. The loop below takes the session's state BEFORE a deal, deals it
//      the ordinary way, and checks that runDeal() given that same "before" state produces the same
//      hand, the same director, the same streams and the same search numbers.
//   2. THE MESSAGE CONTRACT HOLDS, INCLUDING ITS FAILURES. A batch that cannot be dealt is not a
//      worker failure (the caller must be able to tell "the cube is full" from "the worker
//      broke"), a refused batch must hand back the state it was given so there is nothing to
//      commit, and a malformed request must come back as an error rather than throw out of the
//      handler and leave the caller waiting for a reply that never arrives.
//
// No browser is launched: dealWorker.js imports cleanly in Node because its `self` wiring is
// guarded, so the handler can be called directly with the exact message shape Vite posts.
import { Board, SH, isShell } from '../src/game/board.js'
import { OPENING_SHAPES } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'
import { createRng, createStreams } from '../src/game/rng.js'
import { createGameSession } from '../src/game/gameSession.js'
import { runDeal } from '../src/game/dealRun.js'
import { answerDealRequest } from '../src/game/dealWorker.js'
import { createDirectorState, serialize as serializeDirector } from '../src/game/dealDirector.js'
import { enumeratePlacements, fromBoard } from '../src/game/placementModel.js'

let passed = 0
const failures = []
function check(label, ok, detail) {
  if (ok) { passed += 1; return }
  failures.push(`${label}${detail === undefined ? '' : `  ${detail}`}`)
  console.log(`FAIL ${label}${detail === undefined ? '' : `  ${detail}`}`)
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const SEEDS = [11, 4242, 31337, 90210]
const BATCHES = 60

// ---- 1. Parity: the worker's function vs the session's own deal ---------------------
// The reason is 'natural' every other batch and 'refresh' in between, because the two take
// different branches (a refresh must not advance the run or shorten Block 9's cooldown).
for (const seed of SEEDS) {
  const session = createGameSession()
  session.resetDirector(seed)
  session.board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT, createRng(seed))
  session.deal()
  const rng = createRng(seed * 31 + 7)
  let compared = 0
  let refused = 0
  let mismatches = 0
  const detail = []
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const reason = batch % 3 === 2 ? 'refresh' : 'natural'
    const before = session.snapshot()
    session.deal({ reason })
    const handNames = session.getPieces().map((piece) => piece.shape.name)
    const after = session.snapshot()
    const viaRunDeal = runDeal({ cells: before.board.cells, director: before.director, streams: before.streams, reason })
    if (viaRunDeal.ok) {
      compared += 1
      const metrics = session.getDealMetrics()
      if (!same(viaRunDeal.names, handNames)) { mismatches += 1; detail.push(`hand @${batch}`) }
      if (!same(viaRunDeal.director, after.director)) { mismatches += 1; detail.push(`director @${batch}`) }
      if (!same(viaRunDeal.streams, after.streams)) { mismatches += 1; detail.push(`streams @${batch}`) }
      if (viaRunDeal.metrics.nodes !== metrics.nodes
        || viaRunDeal.metrics.candidatesSampled !== metrics.candidatesSampled
        || viaRunDeal.metrics.candidatesRefined !== metrics.candidatesRefined
        || viaRunDeal.metrics.fallback !== metrics.fallback
        || viaRunDeal.metrics.aLower !== metrics.aLower
        || viaRunDeal.metrics.aUpper !== metrics.aUpper
        || viaRunDeal.metrics.rEnd !== metrics.rEnd
        || viaRunDeal.metrics.proofStatus !== metrics.proofStatus) { mismatches += 1; detail.push(`metrics @${batch}`) }
    } else {
      refused += 1
      // A refused batch hands the state back untouched: there is nothing to commit, and the run
      // must not have moved.
      if (!same(viaRunDeal.director, before.director) || !same(viaRunDeal.streams, before.streams)) {
        mismatches += 1
        detail.push(`refusal moved the state @${batch}`)
      }
    }
    // Play the hand out so the next batch is dealt against a board a real run could reach. The
    // placement rng is this tool's own, so both sides of the comparison see the same position.
    for (const piece of session.getPieces()) {
      const placements = enumeratePlacements(fromBoard(session.board), piece.cells)
      if (!placements.length) { piece.used = true; continue }
      const choice = placements[rng.int(placements.length)]
      session.settlePlacement(choice.face, choice.cells, choice.origin, piece.shape.color)
      session.usePiece(piece)
    }
  }
  check(`seed ${seed}: ${compared} batches (${refused} refused) dealt identically by runDeal and by the session`,
    mismatches === 0 && compared > 0, `${mismatches} mismatches: ${detail.slice(0, 4).join(', ')}`)
}

// ---- 2. The message contract --------------------------------------------------------
{
  const board = new Board()
  board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT, createRng(5150))
  const request = {
    cells: board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]),
    director: serializeDirector(createDirectorState()),
    streams: createStreams(5150).snapshot(),
    reason: 'natural',
  }
  const reply = answerDealRequest({ id: 7, request })
  check('the handler answers with the id it was given', reply.id === 7, JSON.stringify(reply).slice(0, 120))
  check('a dealable board comes back ok with three named pieces',
    reply.ok === true && reply.result.ok === true && reply.result.names.length === 3,
    JSON.stringify(reply.result?.names))
  check('the reply survives JSON (it crossed a thread boundary intact)',
    Number.isFinite(reply.result.metrics.nodes) && JSON.stringify(reply).length > 0)
  const again = answerDealRequest({ id: 8, request })
  check('the same request deals the same batch twice (deterministic across the boundary)',
    same(reply.result.names, again.result.names) && reply.result.metrics.nodes === again.result.metrics.nodes)
  check('a refresh is a different batch than a natural one on the same board',
    !same(answerDealRequest({ id: 9, request: { ...request, reason: 'refresh' } }).result.names, reply.result.names))

  // The full shell: nothing fits anywhere, so the batch is REFUSED — a fact about the position,
  // not a broken worker.
  const cells = []
  for (let x = 0; x < SH; x += 1) {
    for (let y = 0; y < SH; y += 1) {
      for (let z = 0; z < SH; z += 1) if (isShell(x, y, z)) cells.push([x, y, z, 0xffffff])
    }
  }
  const full = answerDealRequest({ id: 10, request: { ...request, cells } })
  check('a cube with no room answers ok, with result.ok false (never a worker failure)',
    full.ok === true && full.result.ok === false, JSON.stringify(full).slice(0, 160))
  check('the refused batch hands the director and the streams back unchanged',
    same(full.result.director, request.director) && same(full.result.streams, request.streams))

  const broken = answerDealRequest({ id: 11, request: null })
  check('a malformed request answers with an error instead of throwing',
    broken.id === 11 && broken.ok === false && typeof broken.error === 'string', JSON.stringify(broken).slice(0, 160))
  check('the handler never throws, whatever it is handed',
    (() => { try { answerDealRequest(undefined); answerDealRequest({}); return true } catch { return false } })())
}

console.log(`deal-worker-tests: ${passed}/${passed + failures.length} checks passed`)
if (failures.length) {
  console.log(`\n${failures.length} failed:`)
  failures.forEach((line) => console.log(`  ${line}`))
  process.exit(1)
}
console.log('all deal-worker checks passed')

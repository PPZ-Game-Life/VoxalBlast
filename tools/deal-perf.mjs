// How long does a board-aware deal actually take? (v0.9.0 P1, spec §11.2)
//
// This exists because the spec's budget — "p95 发牌准备时间不超过 150ms、常规情况下主线程无超过
// 50ms 的发牌长任务" — is explicitly a TO-BE-VERIFIED number, and because the decision it feeds
// (deal synchronously on the frame, or move the search into a Worker and give the game a
// "preparing" state) should be made on measurement rather than on the shape of the code.
//
// What is measured is the WHOLE deal: proposing up to 48 batches, proving each one, sampling 24
// first moves for the survivors, scoring them and picking one. Boards are taken at several fill
// levels, because the search gets more expensive exactly where the game gets interesting — a
// nearly-full cube has few placements but many dead branches.
//
//   node tools/deal-perf.mjs            # default: 240 deals per fill level
//   node tools/deal-perf.mjs --deals=500
import { Board } from '../src/game/board.js'
import { OPENING_SHAPES, SHAPES } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'
import { createRng } from '../src/game/rng.js'
import { createGameSession } from '../src/game/gameSession.js'
import {
  batchConstraints, beginNaturalBatch, createDirectorState, currentIntent, noteDealt, notePlacement,
} from '../src/game/dealDirector.js'
import { dealBatch } from '../src/game/dealer.js'
import { enumeratePlacements, fromBoard } from '../src/game/placementModel.js'

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [key, value] = a.replace(/^--/, '').split('=')
  return [key, value === undefined ? true : value]
}))
const DEALS = Number(args.deals || 240)

const BY_NAME = new Map(SHAPES.map((shape) => [shape.name, shape]))

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1),
  }
}

// A board at roughly `target` occupancy, built by PLAYING random legal placements — so it is a
// position the game can actually reach (no seeded lines sitting around, no off-shell cells).
function boardAt(target, seed) {
  const board = new Board()
  board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT, createRng(seed))
  const rng = createRng(seed * 7 + 1)
  const names = [...BY_NAME.keys()]
  let guard = 0
  while (board.occupied().length < target && guard < 4000) {
    guard += 1
    const shape = BY_NAME.get(names[rng.int(names.length)])
    const placements = enumeratePlacements(fromBoard(board), shape.cells)
    if (!placements.length) continue
    const choice = placements[rng.int(placements.length)]
    board.place(choice.face, choice.cells, choice.origin, shape.color)
  }
  return board
}

const LEVELS = [
  { name: 'opening (~16 cells)', target: 16 },
  { name: 'mid (~49 cells)', target: 49 },
  { name: 'busy (~70 cells)', target: 70 },
  { name: 'tight (~85 cells)', target: 85 },
]

const rows = []
for (const level of LEVELS) {
  const samples = []
  let fallbacks = 0
  let refused = 0
  let proven = 0
  let unknown = 0
  let nodes = 0
  // One director driven through a REAL run (warmup → build → challenge → relief), so the
  // targets being measured are the ones a player actually gets. Setting the batch index by
  // hand would skip the warmup branch that arms the build stretch and land every deal on a
  // challenge target instead — a harness artefact that shows up as a 100% fallback rate.
  const state = createDirectorState()
  const directorRng = createRng(31337)
  for (let i = 0; i < DEALS; i += 1) {
    const board = boardAt(level.target, 1000 + i)
    const rng = createRng(9000 + i)
    beginNaturalBatch(state, directorRng)
    const intent = currentIntent(state)
    const constraints = batchConstraints(state, { natural: true })
    const started = process.hrtime.bigint()
    const result = dealBatch({ board, director: state, intent, constraints, rng, searchRng: rng })
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    samples.push(elapsed)
    nodes += result.metrics.nodes
    if (!result.hand) refused += 1
    else if (result.metrics.fallback !== 'none') fallbacks += 1
    if (result.metrics.proofStatus === 'SOLVABLE') proven += 1
    if (result.metrics.proofStatus === 'UNKNOWN') unknown += 1
    // Play the batch out so the run advances exactly as a game does.
    for (let step = 0; step < 3; step += 1) notePlacement(state)
  }
  const row = stats(samples)
  rows.push({ level: level.name, ...row, fallbacks, refused, proven, unknown, nodesPerDeal: Math.round(nodes / DEALS) })
}

// The same measurement through the real session path (board → occupancy → deal → pieces), which
// is what the game actually calls on the frame the third piece is placed.
const sessionSamples = []
{
  const session = createGameSession()
  session.resetDirector(4242)
  session.board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT, createRng(4242))
  session.deal()
  const rng = createRng(5150)
  for (let i = 0; i < DEALS; i += 1) {
    // Play the hand out randomly so the board fills the way a game does.
    for (const piece of session.getPieces()) {
      const placements = enumeratePlacements(fromBoard(session.board), piece.cells)
      if (!placements.length) { piece.used = true; continue }
      const choice = placements[rng.int(placements.length)]
      session.settlePlacement(choice.face, choice.cells, choice.origin, piece.shape.color)
      session.usePiece(piece)
    }
    const started = process.hrtime.bigint()
    session.deal()
    sessionSamples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
}
const sessionStats = stats(sessionSamples)

console.log(`deal-perf: ${DEALS} deals per fill level, node v${process.versions.node}\n`)
console.log('level                      p50      p95      p99      max    mean   fallback  refused  SOLVABLE  UNKNOWN  nodes/deal')
for (const row of rows) {
  console.log([
    row.level.padEnd(24),
    `${row.p50.toFixed(1)}ms`.padStart(7),
    `${row.p95.toFixed(1)}ms`.padStart(8),
    `${row.p99.toFixed(1)}ms`.padStart(8),
    `${row.max.toFixed(1)}ms`.padStart(8),
    `${row.mean.toFixed(1)}ms`.padStart(7),
    `${row.fallbacks}`.padStart(9),
    `${row.refused}`.padStart(8),
    `${row.proven}`.padStart(9),
    `${row.unknown}`.padStart(8),
    `${row.nodesPerDeal}`.padStart(11),
  ].join(' '))
}
console.log('\nthrough the real session path (session.deal(), board filling as a game does):')
console.log(`  p50 ${sessionStats.p50.toFixed(1)}ms   p95 ${sessionStats.p95.toFixed(1)}ms   p99 ${sessionStats.p99.toFixed(1)}ms   max ${sessionStats.max.toFixed(1)}ms   mean ${sessionStats.mean.toFixed(1)}ms   n=${sessionStats.n}`)

const worstP95 = Math.max(...rows.map((row) => row.p95), sessionStats.p95)
console.log(`\nworst p95 across every level and the session path: ${worstP95.toFixed(1)}ms`)
console.log(`spec §11.2 budget: p95 <= 150ms, no main-thread task over 50ms`)
console.log(worstP95 <= 150 ? 'VERDICT: inside the budget on this machine.' : 'VERDICT: OVER budget — the Worker + preparing state would be needed.')

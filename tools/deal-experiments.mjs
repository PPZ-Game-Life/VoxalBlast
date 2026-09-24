// Deal experiments: does v0.9.0 P1's difficulty come from the SHAPE POOL or from the DEALER?
// (producer's 2026-09-23 dealing spec §12; v0.9.0 P1 shipped the two together, so the release
// itself cannot answer the question — only a factor-separated arm comparison can.)
//
//   node tools/deal-experiments.mjs --arms=A,B,C,D,E,F --games=100 --seeds=1,2,3 \
//        --strategies=random,clear,noise,lookahead
//
// ---------------------------------------------------------------------------
// THE SIX ARMS — the spec's §12.1 table, one to one
// ---------------------------------------------------------------------------
//   arm  shape pool (weights keyed by NAME)                        dealing
//   ---  ---------------------------------------------------------  --------------------------
//   A    FROZEN pre-v0.9.0 14 shapes: no `Line 4`, `Block 9: 1`    blind
//   B    A + `Line 4` (`Block 9: 1`)                               blind
//   C    15 shapes, `Line 4: 1`, `Block 9: 0`                      board-aware (session.deal)
//   D    15 shapes, `Line 4: 1`, `Block 9: 0.4` (= shipped table)  board-aware (session.deal)
//   E    D's exact weights (`Block 9: 0.4`, `Line 4: 1`)           blind
//   F    C's exact weights (`Block 9: 0`, `Line 4: 1`)             blind
//
// `Block 9: 0` means the shape is GENUINELY ABSENT from the draw — a zero-weight member, never
// a member that is drawn and then rejected. See `blindTable()` (it filters `weight > 0` before
// the cumulative sums are built, exactly like `weightedTable()` in src/game/dealer.js) and
// `armCForceBlock9Out()` (which makes the SHIPPED dealer build the same Block-9-free table).
//
// The weights are keyed by shape NAME, not by index, so a pool change cannot silently drift a
// weight onto a different shape, and `OPENING_SHAPES` is still the frozen opening pool: every
// arm seeds the SAME opening board for a given (seed, gameIndex), so a pool change can never be
// read as an opening-density effect.
//
// ---------------------------------------------------------------------------
// THE CONTRASTS (§12.1 pairs + §12.4.1), and the ONE factor each isolates
// ---------------------------------------------------------------------------
//   A → B   POOL only    adds Line 4, blind dealing both sides
//   C → F   DEALER only  C's pool and weights byte-identical; blind → board-aware
//                        *** THE SPEC'S HEADLINE FAIR CONTROL (§12.4.1) ***
//                        "C 组必须相比 F 组，出现更明显的阶段压力和布局失误代价。
//                         不能用 A 的不同形状池代替公平对照"
//   D → E   DEALER only  shipped weights both sides; board-aware → blind
//   C → D   WEIGHT only  Block 9 0 → 0.4, board-aware both sides
//   E → F   WEIGHT only  Block 9 0.4 → 0, blind dealing both sides
//   A → D   TWO factors  the whole v0.9.0 change in one step — NOT usable for attribution
//   B → E   TWO factors  Block 9 weight AND dealing move together — NOT usable for attribution
//
// WHAT IS DIFFERENT FROM tools/difficulty-model.mjs (the previous generation): that tool
// re-implemented the board as its own bitboard model. This one drives the REAL
// `createGameSession()` — the shipped board, the shipped director, the shipped dealer, the
// shipped solver — through a bot. That is the whole point: a number produced here is a number
// about the code that ships, not about a model of it.
//
// "Blind dealing" is implemented HERE, not in src/ (the shipped `session.deal()` is the
// board-aware dealer and must stay that way). It reproduces what the game did before v0.9.0:
// three INDEPENDENT weighted draws with no board awareness, no batch filter, no cooldown and
// no fallback — the pieces are built with `session.makePiece(shape)` and committed with
// `session.setPieces([...])`, exactly the two seams the session exposes for it.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT, stated up front because the project is strict about it
// ---------------------------------------------------------------------------
//   - these are BOTS. None of `random` / `clear` / `noise` / `lookahead` is a calibrated human
//     skill tier, and no human playtest was involved anywhere in this file;
//   - `noise` is a PROXY for "a typical player" (75% best-immediate-clear, 25% random, first
//     playable slot) inherited from difficulty-model.mjs. It is a heuristic, not a person;
//   - the step cap makes the mean a CENSORED statistic: a run that was still playable when the
//     cap was hit is not a run that lasted that long. Censoring is counted explicitly and the
//     survival curve is a Kaplan-Meier estimate with administrative censoring at the cap;
//   - Wilson intervals describe Monte Carlo uncertainty under these bots ONLY. They are not
//     model error and not real-player confidence intervals;
//   - a target that is structurally unreachable (see the reachability section) is reported as
//     such. It is never "fixed", and no claim is made that the difficulty targets were met.
//
// ---------------------------------------------------------------------------
// WHY THE RAW RECORD IS AGGREGATED PER GAME
// ---------------------------------------------------------------------------
// A per-batch record has ~35 fields and a blind arm can deal 200 batches in one game; storing
// them all made the raw file hundreds of megabytes and made `--merge` unusable. Each game
// therefore returns its own compact AGGREGATE (counters, per-(tier,phase) buckets, and the
// numeric arrays that quantiles need). Aggregation is the same code on both paths — a single
// run and a merged multi-shard run produce identical numbers from identical inputs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { OPENING_SHAPES, SHAPES, SHAPE_WEIGHTS } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'
import { createRng, hashSeed } from '../src/game/rng.js'
import { createGameSession } from '../src/game/gameSession.js'
import { Board } from '../src/game/board.js'
import { beginNaturalBatch, currentIntent, noteDealt, tierOf } from '../src/game/dealDirector.js'
import {
  LATTICE_SIZE, applyPlacement, completionInfo, countPlacements, enumeratePlacements, fromBoard,
} from '../src/game/placementModel.js'
import { solveHand } from '../src/game/handSolver.js'
import { pressure } from '../src/game/boardPressure.js'
import {
  BATCH_RULES, BUDGET, DEAL_CONFIG_VERSION, PHASES, PRESSURE_DELTA, PRESSURE_MAX_JUMP,
  RELIEF_SAFE_RANGE, TIERS,
} from '../src/game/dealConfig.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SESSION_SCHEMA = 'deal-experiments/v2'

// ---------------------------------------------------------------------------
// The arms
// ---------------------------------------------------------------------------
const SHAPE_BY_NAME = new Map(SHAPES.map((shape) => [shape.name, shape]))

// The shipped table, copied so the arms below can override single entries. The frozen export
// itself is never mutated.
const SHIPPED_WEIGHTS = Object.freeze({ ...SHAPE_WEIGHTS }) // Line 4: 1, Block 9: 0.4, total 20.4

// Arm A: the FROZEN pre-v0.9.0 table — the 14 shapes with `Block 9: 1` and no `Line 4`
// (total 20). Membership is read from `OPENING_SHAPES`, which shapes.js froze by NAME for
// exactly this reason: a future shape addition has to opt in there deliberately, so this arm
// cannot silently widen.
const PRE_LINE4_WEIGHTS = (() => {
  const table = { ...SHAPE_WEIGHTS, 'Block 9': 1 }
  delete table['Line 4']
  return Object.freeze(table)
})()

// Arm B: shipped membership with `Line 4` present but Block 9 still at its pre-v0.9.0 weight
// (total 21). This is the arm that separates "Line 4 came back" from "Block 9 went down".
const LINE4_ADDED_WEIGHTS = Object.freeze({ ...SHAPE_WEIGHTS, 'Block 9': 1 })

// Arms C and F: the 15-shape pool with `Line 4: 1` and **`Block 9: 0`** (total 20). The zero is
// a ZERO-WEIGHT MEMBER: `blindTable()` drops it before the cumulative table exists, so the draw
// can never return it — it is not "drawn and rejected".
const NO_BLOCK9_WEIGHTS = Object.freeze({ ...SHAPE_WEIGHTS, 'Block 9': 0 })

const ARMS = {
  A: {
    id: 'A',
    label: 'A 冻结原 14 类权重（无 Line 4，Block9=1，Σ20）+ 旧发牌（盲）',
    short: 'A 冻结池 + 盲发牌',
    dealer: 'blind',
    shapes: OPENING_SHAPES,
    weights: PRE_LINE4_WEIGHTS,
    block9Out: false,
  },
  B: {
    id: 'B',
    label: 'B A + Line 4（Block9=1，Σ21）+ 旧发牌（盲）',
    short: 'B +Line 4 + 盲发牌',
    dealer: 'blind',
    shapes: SHAPES,
    weights: LINE4_ADDED_WEIGHTS,
    block9Out: false,
  },
  C: {
    id: 'C',
    label: 'C 新发牌 + Line 4，Block9 权重 0（Σ20）',
    short: 'C 无 Block9 + 感知发牌',
    dealer: 'boardAware',
    shapes: SHAPES,
    weights: NO_BLOCK9_WEIGHTS,
    block9Out: true,
  },
  D: {
    id: 'D',
    label: 'D 新发牌 + Line 4，Block9 权重 0.4（Σ20.4，= 现行 SHAPE_WEIGHTS）',
    short: 'D 现行权重 + 感知发牌',
    dealer: 'boardAware',
    shapes: SHAPES,
    weights: SHIPPED_WEIGHTS,
    block9Out: false,
  },
  E: {
    id: 'E',
    label: 'E 与 D 同权重（Block9=0.4）+ 旧发牌（盲）',
    short: 'E 现行权重 + 盲发牌',
    dealer: 'blind',
    shapes: SHAPES,
    weights: SHIPPED_WEIGHTS,
    block9Out: false,
  },
  F: {
    id: 'F',
    label: 'F 与 C 同形状池和权重（Block9=0）+ 旧发牌（盲）',
    short: 'F 无 Block9 + 盲发牌',
    dealer: 'blind',
    shapes: SHAPES,
    weights: NO_BLOCK9_WEIGHTS,
    block9Out: false,
  },
}

// The pairs, and the ONE factor each isolates. `single: false` marks the pairs that move two
// factors at once — reported as the size of the whole change, NEVER as a cause.
const PAIRS = [
  { id: 'A→B', from: 'A', to: 'B', single: true, headline: false, factor: '形状池：加入 Line 4（Block 9 权重与发牌方式均不变）' },
  { id: 'C→F', from: 'C', to: 'F', single: true, headline: true, factor: '发牌方式：棋盘感知 → 盲（形状池与权重完全相同）— §12.4.1 的公平对照' },
  { id: 'D→E', from: 'D', to: 'E', single: true, headline: false, factor: '发牌方式：棋盘感知 → 盲（现行权重完全相同）' },
  { id: 'C→D', from: 'C', to: 'D', single: true, headline: false, factor: 'Block 9 权重 0 → 0.4（两侧都是棋盘感知发牌）' },
  { id: 'E→F', from: 'E', to: 'F', single: true, headline: false, factor: 'Block 9 权重 0.4 → 0（两侧都是盲发牌）' },
  { id: 'A→D', from: 'A', to: 'D', single: false, headline: false, factor: '形状池 + 发牌方式同时改变（整包参考，不可用于归因）' },
  { id: 'B→E', from: 'B', to: 'E', single: false, headline: false, factor: 'Block 9 权重 1 → 0.4 与发牌方式同时改变（不可用于归因）' },
]

// ---------------------------------------------------------------------------
// The blind dealer (implemented here on purpose — see the header)
// ---------------------------------------------------------------------------
// A cumulative weight table over the arm's own pool. Built from the arm's weight object and
// the arm's shape list, so an arm can never draw a shape its pool does not contain. A shape
// whose weight is 0 (arm C/F's `Block 9`) is filtered out BEFORE the cumulative sums are
// built: it is genuinely absent from the draw, not drawn-and-rejected.
function blindTable(arm) {
  const entries = arm.shapes
    .filter((shape) => (arm.weights[shape.name] ?? 0) > 0)
    .map((shape) => ({ name: shape.name, weight: arm.weights[shape.name] }))
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  if (!(total > 0)) throw new Error(`arm ${arm.id}: weight table is empty`)
  let running = 0
  return Object.freeze(entries.map((entry) => {
    running += entry.weight / total
    return Object.freeze({ name: entry.name, share: entry.weight / total, upTo: running })
  }))
}

function drawShape(table, rng) {
  const roll = rng()
  for (const entry of table) if (roll < entry.upTo) return SHAPE_BY_NAME.get(entry.name)
  return SHAPE_BY_NAME.get(table[table.length - 1].name)
}

// Exactly the pre-v0.9.0 deal: three independent weighted draws, no board awareness, no batch
// filter, no Block 9 cooldown, no fallback path. One random value per slot, matching
// `pickShape`'s documented call count.
function blindDeal(session, table, rng) {
  const shapes = [drawShape(table, rng), drawShape(table, rng), drawShape(table, rng)]
  const pieces = shapes.map((shape) => session.makePiece(shape))
  session.setPieces(pieces)
  return pieces
}

// ---------------------------------------------------------------------------
// Arm C's "Block 9 weight 0" through the SHIPPED dealer
// ---------------------------------------------------------------------------
// `session.deal()` builds its draw table from `SHAPE_WEIGHTS` inside src/, so a weight of 0
// cannot be injected from a tool. The one shipped lever that makes the dealer build a draw
// table with NO Block 9 entry is `constraints.allowBlock9 === false`, which `batchConstraints()`
// derives from the Block-9 cooldown (dealDirector.js: `state.naturalBatchIndex -
// state.lastBlock9NaturalBatch <= block9CooldownBatches`). Arming the cooldown before every
// natural batch therefore makes `weightedTable(new Set(['Block 9']))` — Block 9 filtered out
// BEFORE the cumulative sums are built. Same effect as weight 0, same mechanism as the shipped
// cooldown, no src/ change.
//
// This is an EXPERIMENTAL LEVER and the report says so: it is the only way to express "Block 9
// weight 0" through `session.deal()`. Its observed effect is verified rather than asserted —
// the realised Block 9 slot share for arm C is reported next to every other arm's, and the
// constructive fallback cannot smuggle one in either (REFERENCE_POOL in boardPressure.js
// excludes Block 9 by assertion).
function armCForceBlock9Out(session) {
  const director = session.getDirector()
  director.lastBlock9NaturalBatch = director.naturalBatchIndex
}

// ---------------------------------------------------------------------------
// Bot strategies
// ---------------------------------------------------------------------------
// `noise` mirrors tools/difficulty-model.mjs `chooseForSlot` + `chooseMove` in INTENT, not in
// code (that tool works on its own bitboard): take the FIRST playable slot, then with 25%
// probability a uniformly random legal placement of that shape and otherwise the placement
// that completes the most lines. The `rng()` call is unconditional, so the stream advances
// identically on both branches — the same reason the original does it that way.
const NOISE_RANDOM_CHANCE = 0.25

function legalPlacementsFor(session, occ, piece) {
  return enumeratePlacements(occ, piece.cells)
}

// Best-immediate-clear for ONE piece, deterministic: no rng call at all. This is the spec's
// "立即消除优先" strategy, and it is also the no-noise half of `noise`.
function bestClearFor(session, occ, piece) {
  const placements = legalPlacementsFor(session, occ, piece)
  if (!placements.length) return null
  let best = placements[0]
  let bestLines = completionInfo(occ, best).lines
  for (let i = 1; i < placements.length; i += 1) {
    const lines = completionInfo(occ, placements[i]).lines
    if (lines > bestLines) { best = placements[i]; bestLines = lines }
  }
  return { piece, placement: best }
}

function chooseClear(session, occ) {
  for (const piece of session.getPieces()) {
    if (piece.used) continue
    const move = bestClearFor(session, occ, piece)
    if (move) return move
  }
  return null
}

function chooseNoise(session, occ, rng) {
  for (const piece of session.getPieces()) {
    if (piece.used) continue
    const placements = legalPlacementsFor(session, occ, piece)
    if (!placements.length) continue
    if (rng() < NOISE_RANDOM_CHANCE) return { piece, placement: placements[rng.int(placements.length)] }
    let best = placements[0]
    let bestLines = completionInfo(occ, best).lines
    for (let i = 1; i < placements.length; i += 1) {
      const lines = completionInfo(occ, placements[i]).lines
      if (lines > bestLines) { best = placements[i]; bestLines = lines }
    }
    return { piece, placement: best }
  }
  return null
}

function chooseRandom(session, occ, rng) {
  const moves = []
  for (const piece of session.getPieces()) {
    if (piece.used) continue
    for (const placement of legalPlacementsFor(session, occ, piece)) moves.push({ piece, placement })
  }
  return moves.length ? moves[rng.int(moves.length)] : null
}

// The spec's fourth strategy: "考虑剩余手牌与空间的前瞻". Bounded on purpose — an unbounded
// lookahead multiplies the cost of every step of every game, and the board-aware arms already
// pay ~44ms per dealt batch.
//
//   - rank every legal move by the lines it completes immediately;
//   - keep the best LOOKAHEAD_BRANCHES;
//   - for each, settle it and ask "can the REST of this hand still be placed somewhere, and how
//     much room is left?" using `countPlacements(cap)` (which short-circuits at the cap);
//   - score = lines * 6 - blockedPieces * 4 + min(remaining room, 8).
// It is a one-ply greedy with a mobility term, NOT a solver: it never proves a continuation and
// it is not "严格五步规划" (§12.4.6). Named `lookahead` and described as such so the report
// cannot be read as claiming P2 cross-batch planning.
const LOOKAHEAD_BRANCHES = 10
const LOOKAHEAD_ROOM_CAP = 6

function chooseLookahead(session, occ) {
  const pieces = session.getPieces().filter((piece) => !piece.used)
  const moves = []
  for (const piece of pieces) {
    for (const placement of enumeratePlacements(occ, piece.cells)) {
      moves.push({ piece, placement, lines: completionInfo(occ, placement).lines })
    }
  }
  if (!moves.length) return null
  moves.sort((a, b) => b.lines - a.lines)
  const scratch = new Uint8Array(LATTICE_SIZE)
  let best = null
  for (const candidate of moves.slice(0, LOOKAHEAD_BRANCHES)) {
    const settled = applyPlacement(occ, candidate.placement, scratch)
    const next = settled.occ
    let room = 0
    let blocked = 0
    for (const piece of pieces) {
      if (piece === candidate.piece) continue
      const count = countPlacements(next, piece.cells, LOOKAHEAD_ROOM_CAP)
      room += count
      if (count === 0) blocked += 1
    }
    const score = candidate.lines * 6 - blocked * 4 + Math.min(room, 8)
    if (!best || score > best.score) best = { piece: candidate.piece, placement: candidate.placement, score }
  }
  return best ? { piece: best.piece, placement: best.placement } : null
}

const STRATEGY_ORDER = ['random', 'clear', 'noise', 'lookahead']
const STRATEGIES = {
  random: {
    id: 'random',
    label: 'random',
    description: '在全部（未用棋子 × 合法物理落点）中均匀随机。不是新手校准。',
    choose: chooseRandom,
  },
  clear: {
    id: 'clear',
    label: 'clear',
    description: '立即消除优先（确定性）：第一个可放的棋子槽位，取即时消除行数最多的落点，不消耗随机数。规格要求的"立即消除优先"。',
    choose: chooseClear,
  },
  noise: {
    id: 'noise',
    label: 'noise',
    description: '第一个可放的棋子槽位；75% 取即时消除行数最多的落点，25% 该槽位的随机合法落点。是"典型玩家"的启发式代理，不是真人。',
    choose: chooseNoise,
  },
  lookahead: {
    id: 'lookahead',
    label: 'lookahead',
    description: `前瞻（有界，单步贪心 + 机动性）：把合法落点按即时消除行数排序，只展开前 ${LOOKAHEAD_BRANCHES} 个；每个落子后统计"剩余手牌还能放多少处（每个棋子最多数到 ${LOOKAHEAD_ROOM_CAP}）"与"有几个棋子完全放不下"，取 lines*6 - 放不下的棋子数*4 + min(剩余空间, 8) 最高者。考虑剩余手牌与空间，但不是求解器，也不做跨批规划（§12.4.6）。`,
    choose: chooseLookahead,
  },
}

// ---------------------------------------------------------------------------
// Witness replay (§12.2 "witness 回放失败（必须为零）", §12.3 hard acceptance)
// ---------------------------------------------------------------------------
// Every batch the dealer marks SOLVABLE carries a witness: a 3-step path naming each piece by
// its index into the hand. The claim "the witness is replayable" is verified, not assumed —
// the path is replayed on a REAL `Board` rebuilt from the pre-deal occupancy, and every step
// must be a legal physical placement (`Board.canPlace`) before it is committed.
function replayWitness(preBoardCells, witness) {
  const board = new Board()
  board.restore({ cells: preBoardCells })
  for (const step of witness) {
    if (!board.canPlace(step.face, step.cells, step.origin)) {
      return { ok: false, at: step.pieceIndex, why: 'Board.canPlace rejected the witness step' }
    }
    board.place(step.face, step.cells, step.origin, 0xffffff)
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------
// Streams: every arm derives them from the SAME per-(seed, gameIndex) base, so the opening
// board and the bot's choice stream start from identical states in all six arms and paired
// games are comparable. The session is handed that base as its director seed, which makes its
// internal `deal`/`search`/`director` streams byte-identical to the ones built here — so the
// blind arms' director stream is the very stream the board-aware dealer would have consumed.
// The deal stream's CONSUMPTION necessarily diverges after the first batch (the board-aware
// dealer's draw count depends on the board); that divergence is the treatment, not a defect.
function baseSeedOf(seed, gameIndex) {
  return hashSeed(SESSION_SCHEMA, seed, gameIndex)
}

// `fallbackSteps` is not a pure degradation ladder: the dealer also appends these two
// INFORMATIONAL tags to every batch they describe, so counting them as fallbacks would report
// a ~96% "relaxed" rate that is really "this hand repeated one of the last four".
const INFORMATIONAL_STEPS = new Set(['same-as-previous', 'relaxed-same-shape'])

function batchKeyOf(phase, tier) {
  return `${tier}|${phase}`
}

function targetRangeOf(phase, tier) {
  if (phase === 'relief') return RELIEF_SAFE_RANGE
  const config = TIERS[Math.max(0, Math.min(TIERS.length - 1, tier | 0))]
  return phase === 'challenge' ? config.challenge : config.build
}

const TRACE_LENGTH = 5
const TRACE_SOLVE_BUDGET = BUDGET.nodesPerHand

function addCount(target, key, n = 1) {
  if (!key) return
  target[key] = (target[key] || 0) + n
}

function gameRecordBase({ arm, strategyId, seed, gameIndex }) {
  return {
    arm: arm.id,
    strategy: strategyId,
    seed,
    gameIndex,
    steps: 0,
    ended: false,
    censored: false,
    endedByRefusedDeal: false,
    maxTier: 0,
    openingCells: 0,
    phaseCounts: { warmup: 0, build: 0, challenge: 0, relief: 0 },
    b: {
      dealt: 0,
      buckets: {},
      fallbackReasons: {},
      ladderSteps: {},
      infoSteps: {},
      proofStatuses: {},
      probeStatuses: {},
      metricBatches: 0,
      fallbackBatches: 0,
      relaxedPressureOnly: 0,
      relaxedBoth: 0,
      candidatesSampled: 0,
      candidatesProven: 0,
      candidatesUnknown: 0,
      candidatesDropped: 0,
      nodesSum: 0,
      nodesMax: 0,
      constructedBatches: 0,
      rootSolvableBatches: 0,
      rootUnknownBatches: 0,
      rootUnsolvedBatches: 0,
      targetUnreachableBatches: 0,
      handNoFullContinuationBatches: 0,
      handNoFullContinuationTotal: 0,
      handNoFullContinuationAliasMismatches: 0,
      handNoFullContinuationFieldAbsent: 0,
      boardNoFullContinuation: 0,
      solvableBatches: 0,
      witnessChecked: 0,
      witnessReplayFailures: 0,
      witnessNotFull: 0,
      witnessFailureSamples: [],
      pressureJumpExceeded: 0,
      lowBranchBatches: 0,
      relaxedSameShapeBatches: 0,
      block9Batches: 0,
      block9Slots: 0,
      maxSameShapeInBatch: 0,
      maxBlock9InBatch: 0,
      cooldownWindows: 0,
      cooldownViolations: 0,
      repeatedWithPrevious: 0,
      probeChecked: 0,
      shapeSlots: {},
    },
    arrays: { latencyMs: [], nodes: [] },
    stuck: null,
  }
}

function bucketOf(record, tier, phase) {
  const key = batchKeyOf(phase, tier)
  let bucket = record.b.buckets[key]
  if (!bucket) {
    bucket = {
      tier,
      phase,
      n: 0,
      within: 0,
      intersects: 0,
      above: 0,
      below: 0,
      degenerate: 0,
      aN: 0,
      aLowerSum: 0,
      aUpperSum: 0,
      minALower: null,
      maxAUpper: null,
      withinPressure: 0,
      rBefore: [],
      jump: [],
    }
    record.b.buckets[key] = bucket
  }
  return bucket
}

function runGame({ arm, strategyId, seed, gameIndex, stepCap, table }) {
  const base = baseSeedOf(seed, gameIndex)
  const session = createGameSession()
  // The director seed is the per-game base, not the raw user seed: it keeps every stream in
  // this harness addressable from one number and keeps the board-aware arms' internal streams
  // aligned with the ones the blind arms build by hand.
  session.resetDirector(base)
  // The bot has no item policy. Without this, `stuckOutcome()` answers 'refresh' (2 charges)
  // or 'clear-path' (3 charges) instead of 'end', and a stuck run would never terminate — the
  // run would spin until the step cap and the end rate would read 0% for every arm. The
  // offline model this harness succeeds (difficulty-model.mjs) has no items at all, so zeroing
  // the charges is the same measurement convention, made explicit. §12.2's item metrics are
  // therefore NOT MEASURABLE here and are reported as "not applicable", never invented.
  for (const tool of session.ITEM_TOOLS) session.setItemCharge(tool.id, 0)

  const openingRng = createRng(hashSeed(base, 'opening'))
  session.board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT, openingRng)

  const blindRng = createRng(hashSeed(base, 'deal'))
  const phaseRng = createRng(hashSeed(base, 'director'))
  const botRng = createRng(hashSeed(base, 'bot'))
  const choose = STRATEGIES[strategyId].choose

  const record = gameRecordBase({ arm, strategyId, seed, gameIndex })
  record.openingCells = session.board.occupied().length

  let steps = 0
  let batchIndex = 0
  // The last few placements, kept so the state at a stuck hand can be reported. Only the ring
  // is kept (not the whole game): §12.2 asks for the LAST FIVE placements before a stuck state,
  // and a 600-step game would otherwise hold 600 board snapshots.
  const ring = []
  // The batch currently on the board (bucket + pre-deal R), closed when it is played out.
  let openState = null
  // Definition used for "how many steps ago the player left a completable path": the placement
  // count when the most recent batch whose hand had a FULL (3-step, SOLVABLE) witness was dealt.
  // "Full witness" is measured by the harness's own `solveHand` probe on the dealt hand, so it
  // is defined identically for blind and board-aware arms — a dealer-internal witness exists
  // only for the board-aware arms, and using that alone would make the metric incomparable
  // across the very contrast (§12.4.1) the report is about.
  let lastFullWitnessStep = null
  let previousBatchProbeSolvable = null
  let previousBatchDealerWitness = null
  let previousBlock9BatchIndex = null
  let previousBatchKey = null

  function remainingCellsOf() {
    const cells = []
    for (const piece of session.getPieces()) if (!piece.used) cells.push(piece.cells)
    return cells
  }

  function remainingNamesOf() {
    const names = []
    for (const piece of session.getPieces()) if (!piece.used) names.push(piece.shape.name)
    return names
  }

  // The stuck diagnosis: what the hand still holds, whether the previous batch had a witness,
  // how long ago the player left a completable path, and the last five placements' pressure /
  // remaining-candidate / safety trace. "Safety" is a REAL full-continuation question — the
  // remaining hand is handed to the shipped `solveHand` on the occupancy as it stood at that
  // placement — so "progressive tightening" (safety degrading step by step) can be told apart
  // from a single-step drop.
  function recordStuck(reason, outcome) {
    const trace = ring.map((entry) => {
      let continuation = 'no-pieces-left'
      let nodes = 0
      if (entry.remainingCells.length) {
        const proof = solveHand(entry.occ, entry.remainingCells, { nodeBudget: TRACE_SOLVE_BUDGET })
        continuation = proof.status
        nodes = proof.nodes
      }
      return {
        step: entry.step,
        shape: entry.shape,
        r: round(entry.r, 4),
        mobility: entry.mobility,
        remainingPieces: entry.remainingCells.length,
        remainingShapes: entry.remainingShapes,
        continuation,
        solveNodes: nodes,
      }
    })
    const progress = session.progress()
    record.stuck = {
      reason,
      stuckOutcome: outcome || null,
      atStep: steps,
      batchIndex,
      phase: progress.phase,
      tier: progress.tier,
      remainingShapes: remainingNamesOf(),
      handShapes: session.getPieces().map((piece) => piece.shape.name),
      previousBatchDealerWitness: previousBatchDealerWitness,
      previousBatchProbeSolvable: previousBatchProbeSolvable,
      lastFullWitnessStep,
      stepsSinceLastFullWitness: lastFullWitnessStep === null ? null : steps - lastFullWitnessStep,
      trace,
    }
  }

  // Open one batch and fold everything the report needs into `record`. Returns false when no
  // batch could be produced at all (only the board-aware arms can answer false: a board with no
  // legal placement for any shape makes the shipped dealer refuse and keep the previous,
  // fully-used hand).
  function openBatch() {
    const occBefore = fromBoard(session.board)
    const rBefore = pressure(occBefore)
    const preBoardCells = session.board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color])
    let hand
    let metrics = null
    let ms = null

    if (arm.dealer === 'boardAware') {
      if (arm.block9Out) armCForceBlock9Out(session)
      const started = process.hrtime.bigint()
      session.deal()
      ms = Number(process.hrtime.bigint() - started) / 1e6
      metrics = session.getDealMetrics()
      if (!metrics) return false
      hand = session.getPieces()
      if (!hand.length || hand.every((piece) => piece.used)) return false
    } else {
      // Blind: the director's phase machine is still advanced (so the reported phase mix is the
      // state a real run would be in), but NOTHING in the blind deal reads it. That is the arm.
      const director = session.getDirector()
      beginNaturalBatch(director, phaseRng)
      const intent = currentIntent(director)
      hand = blindDeal(session, table, blindRng)
      noteDealt(director, hand.map((piece) => piece.shape.name), { natural: true })
      batchIndex += 1
      finishBatch({ hand, metrics: null, ms: null, rBefore, occBefore, preBoardCells, phase: intent.phase, tier: intent.tier })
      return true
    }

    record.phaseCounts[metrics.phase] += 1
    batchIndex += 1
    finishBatch({ hand, metrics, ms, rBefore, occBefore, preBoardCells, phase: metrics.phase, tier: metrics.tier })
    return true
  }

  function finishBatch({ hand, metrics, ms, rBefore, occBefore, preBoardCells, phase, tier }) {
    const b = record.b
    const names = hand.map((piece) => piece.shape.name)
    b.dealt += 1
    const bucket = bucketOf(record, tier, phase)
    bucket.n += 1
    bucket.rBefore.push(round(rBefore, 4))

    const counts = new Map()
    for (const name of names) {
      counts.set(name, (counts.get(name) || 0) + 1)
      addCount(b.shapeSlots, name)
    }
    for (const count of counts.values()) b.maxSameShapeInBatch = Math.max(b.maxSameShapeInBatch, count)
    const block9 = counts.get('Block 9') || 0
    b.block9Slots += block9
    b.maxBlock9InBatch = Math.max(b.maxBlock9InBatch, block9)
    if (block9 > 0) b.block9Batches += 1

    // The Block-9 cooldown is measured from the REALISED hands, not from the director's
    // (arm C forces) state: a batch is "in a cooldown window" when one of the previous
    // `block9CooldownBatches` batches actually contained a Block 9. A window that opens and is
    // honoured is a hit; a window in which a Block 9 appears again is a violation.
    const inWindow = previousBlock9BatchIndex !== null && (batchIndex - previousBlock9BatchIndex) <= BATCH_RULES.block9CooldownBatches
    if (inWindow) {
      b.cooldownWindows += 1
      if (block9 > 0) b.cooldownViolations += 1
    }
    if (block9 > 0) previousBlock9BatchIndex = batchIndex

    const key = [...names].sort().join('|')
    if (key === previousBatchKey) b.repeatedWithPrevious += 1
    previousBatchKey = key

    // The harness's own hand probe: "does THIS dealt hand have a full 3-step continuation on
    // the board it was dealt onto?" — asked with the shipped solver, at the shipped per-hand
    // node budget, for EVERY arm including the blind ones that do no proof at all. This is the
    // `handNoFullContinuation` fact of §12.2, measured uniformly.
    const proof = solveHand(occBefore, hand.map((piece) => piece.cells), { nodeBudget: BUDGET.nodesPerHand })
    b.probeChecked += 1
    addCount(b.probeStatuses, proof.status)
    previousBatchProbeSolvable = proof.status === 'SOLVABLE'
    if (proof.status === 'SOLVABLE') {
      b.rootSolvableBatches += 1
      lastFullWitnessStep = steps
    } else if (proof.status === 'UNKNOWN') {
      b.rootUnknownBatches += 1
    } else {
      b.rootUnsolvedBatches += 1
    }
    // The batch's realised pressure change is only known once the batch has been PLAYED OUT, so
    // the bucket and the pre-deal R are carried until the batch closes (`closeOpenBatch`).
    openState = { bucket, rBefore, closed: false }

    if (metrics) {
      b.metricBatches += 1
      if (Number.isFinite(ms)) record.arrays.latencyMs.push(round(ms, 3))
      if (Number.isFinite(metrics.nodes)) {
        record.arrays.nodes.push(metrics.nodes)
        b.nodesSum += metrics.nodes
        b.nodesMax = Math.max(b.nodesMax, metrics.nodes)
      }
      b.candidatesSampled += metrics.candidatesSampled || 0
      b.candidatesProven += metrics.candidatesProven || 0
      b.candidatesUnknown += metrics.candidatesUnknown || 0
      b.candidatesDropped += metrics.candidatesDropped || 0
      const fallback = metrics.fallback
      if (fallback && fallback !== 'none') {
        b.fallbackBatches += 1
        addCount(b.fallbackReasons, fallback)
      }
      if (fallback === 'constructed' || (metrics.fallbackSteps || []).includes('constructed')) b.constructedBatches += 1
      for (const step of metrics.fallbackSteps || []) {
        if (INFORMATIONAL_STEPS.has(step)) addCount(b.infoSteps, step)
        else addCount(b.ladderSteps, step)
      }
      addCount(b.proofStatuses, metrics.proofStatus)
      if (fallback === 'relaxed-tolerance') {
        if (metrics.pressureKept === true) b.relaxedPressureOnly += 1
        else b.relaxedBoth += 1
      }
      if (metrics.pressureJumpExceeded === true) b.pressureJumpExceeded += 1
      if (metrics.lowBranch === true) b.lowBranchBatches += 1
      if (metrics.relaxedSameShape === true) b.relaxedSameShapeBatches += 1

      // §12.2's two DIFFERENT outcomes, recorded separately and never conflated:
      //   handNoFullContinuation  — a specific DEALT HAND has no full 3-step continuation. In
      //     src/game/dealer.js this is an alias of `candidatesDropped` (the number of sampled
      //     hands PROVEN unsolvable at the proposal step), so it is a COUNT, not a boolean. The
      //     alias is verified rather than assumed: any batch where the two disagree is counted.
      //   boardNoFullContinuation — the whole shape pool has no complete continuation on this
      //     board (the constructive walk came back short). A property of the POSITION.
      if (metrics.boardNoFullContinuation === true) b.boardNoFullContinuation += 1
      const handNoFullContinuation = metrics.handNoFullContinuation
      if (handNoFullContinuation === undefined) {
        b.handNoFullContinuationFieldAbsent += 1
      } else {
        if (handNoFullContinuation > 0) b.handNoFullContinuationBatches += 1
        b.handNoFullContinuationTotal += handNoFullContinuation
        if (handNoFullContinuation !== (metrics.candidatesDropped || 0)) b.handNoFullContinuationAliasMismatches += 1
      }

      if (metrics.aLower !== null && metrics.aLower !== undefined && metrics.aUpper !== null && metrics.aUpper !== undefined) {
        bucket.aN += 1
        bucket.aLowerSum += metrics.aLower
        bucket.aUpperSum += metrics.aUpper
        bucket.minALower = bucket.minALower === null ? metrics.aLower : Math.min(bucket.minALower, metrics.aLower)
        bucket.maxAUpper = bucket.maxAUpper === null ? metrics.aUpper : Math.max(bucket.maxAUpper, metrics.aUpper)
        if (metrics.withinSafeRange === true) bucket.within += 1
        if (metrics.intersectsSafeRange === true) bucket.intersects += 1
        const target = targetRangeOf(phase, tier)
        if (metrics.aLower > target[1]) bucket.above += 1
        else if (metrics.aUpper < target[0]) bucket.below += 1
        if (metrics.aUpper === metrics.aLower) bucket.degenerate += 1
        if (metrics.aLower > target[1] || metrics.aUpper < target[0]) b.targetUnreachableBatches += 1
      }
      if (metrics.withinPressureRange === true) bucket.withinPressure += 1

      // §12.2/§12.3: every SOLVABLE batch must carry a witness that replays. Verified here, on
      // a real Board, for every such batch — not sampled.
      const witness = metrics.witness || []
      if (metrics.proofStatus === 'SOLVABLE') {
        b.solvableBatches += 1
        if (witness.length !== 3) {
          b.witnessNotFull += 1
          b.witnessChecked += 1
          b.witnessReplayFailures += 1
          if (b.witnessFailureSamples.length < 5) b.witnessFailureSamples.push({ batchIndex, why: `SOLVABLE batch carries a ${witness.length}-step witness, not a full 3-step one` })
        } else {
          b.witnessChecked += 1
          const replay = replayWitness(preBoardCells, witness)
          if (!replay.ok) {
            b.witnessReplayFailures += 1
            if (b.witnessFailureSamples.length < 5) b.witnessFailureSamples.push({ batchIndex, at: replay.at, why: replay.why })
          }
        }
        previousBatchDealerWitness = true
      } else if (metrics.proofStatus) {
        previousBatchDealerWitness = false
      }
    } else {
      previousBatchDealerWitness = null
    }
  }

  let ended = false
  let censored = false
  let endedByRefusedDeal = false

  // The batch that is currently on the board: its bucket and its pre-deal pressure R. The
  // realised ΔR is only known when the batch has been played out, so it is recorded at close.
  function closeOpenBatch() {
    if (!openState || openState.closed) return
    openState.closed = true
    openState.bucket.jump.push(round(pressure(fromBoard(session.board)) - openState.rBefore, 4))
  }

  if (!openBatch()) {
    ended = true
    endedByRefusedDeal = true
    recordStuck('deal-refused-before-first-batch', 'refused')
  } else {
    while (true) {
      const hand = session.getPieces()
      const allUsed = hand.length === 0 || hand.every((piece) => piece.used)
      if (allUsed) {
        // The batch is spent. Stopping here is the cap; otherwise the next batch is dealt.
        closeOpenBatch()
        if (steps >= stepCap) { censored = true; break }
        if (!openBatch()) {
          ended = true
          endedByRefusedDeal = true
          recordStuck('deal-refused-after-spent-batch', 'refused')
          break
        }
        continue
      }
      const outcome = session.stuckOutcome()
      if (outcome !== 'playable') {
        ended = true
        closeOpenBatch()
        recordStuck('stuck-outcome', outcome)
        break
      }
      if (steps >= stepCap) { censored = true; closeOpenBatch(); break }
      const occ = fromBoard(session.board)
      const move = choose(session, occ, botRng)
      if (!move) {
        // Defensive: `playable` promised a move. Recorded as a stuck state rather than a silent
        // end, because "the bot was told a move existed and found none" is a finding.
        ended = true
        closeOpenBatch()
        recordStuck('no-move-despite-playable', 'playable')
        break
      }
      session.settlePlacement(move.placement.face, move.placement.cells, move.placement.origin, move.piece.shape.color)
      session.usePiece(move.piece)
      steps += 1

      // §12.2's "last five placements before a stuck state": pressure R, remaining candidates
      // (mobility of the remaining hand) and safety (a REAL full-continuation question, asked
      // later on the occupancy as it stood here). Only the ring is kept.
      const occAfter = fromBoard(session.board)
      const remainingCells = remainingCellsOf()
      let mobility = 0
      for (const cells of remainingCells) mobility += countPlacements(occAfter, cells, 12)
      ring.push({
        step: steps,
        shape: move.piece.shape.name,
        occ: Uint8Array.from(occAfter),
        remainingCells,
        remainingShapes: remainingNamesOf(),
        r: pressure(occAfter),
        mobility,
      })
      if (ring.length > TRACE_LENGTH) ring.shift()
    }
  }

  record.steps = steps
  record.ended = ended
  record.censored = censored
  record.endedByRefusedDeal = endedByRefusedDeal
  record.maxTier = tierOf(steps)
  return record
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function quantiles(values, ps = [50, 95, 99]) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  const out = { n: sorted.length }
  for (const p of ps) out[`p${p}`] = sorted.length ? round(percentile(sorted, p), 4) : null
  out.min = sorted.length ? round(sorted[0], 4) : null
  out.max = sorted.length ? round(sorted[sorted.length - 1], 4) : null
  out.mean = sorted.length ? round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, 4) : null
  return out
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// Wilson score interval, 95%. Used for rates, and only as a statement about Monte Carlo
// uncertainty under these bots.
function wilson(successes, n, z = 1.959963984540054) {
  if (!n) return [0, 0]
  const p = successes / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return [round(Math.max(0, centre - half) * 100, 1), round(Math.min(1, centre + half) * 100, 1)]
}

function tally(list) {
  const counts = new Map()
  for (const value of list) counts.set(value, (counts.get(value) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function mergeCounts(into, from) {
  for (const [key, value] of Object.entries(from || {})) into[key] = (into[key] || 0) + value
  return into
}

// Fields that must be COMBINED with max(), never summed, when games are merged.
const MAX_FIELDS = new Set(['maxSameShapeInBatch', 'maxBlock9InBatch', 'nodesMax'])

// Kaplan-Meier survival with ADMINISTRATIVE CENSORING at the step cap: a game that was still
// playable when the cap was hit contributes its at-risk time but no death. Reported as a curve
// (so "the run gets harder gradually" can be seen) AND as quantiles (with the censored ones
// labelled), because a single number hides which of the two it is.
function survivalOf(games, cap) {
  const deaths = new Map()
  const censored = new Map()
  for (const game of games) {
    const at = game.steps
    if (game.censored) censored.set(at, (censored.get(at) || 0) + 1)
    else deaths.set(at, (deaths.get(at) || 0) + 1)
  }
  let atRisk = games.length
  let survival = 1
  const points = [{ step: 0, atRisk, deaths: 0, censored: 0, survivalPct: 100 }]
  let kmMedian = null
  for (let step = 1; step <= cap && atRisk > 0; step += 1) {
    const d = deaths.get(step) || 0
    const c = censored.get(step) || 0
    if (!d && !c) continue
    if (d) {
      survival *= (atRisk - d) / atRisk
      if (kmMedian === null && survival <= 0.5) kmMedian = step
    }
    points.push({ step, atRisk, deaths: d, censored: c, survivalPct: round(survival * 100, 2) })
    atRisk -= (d + c)
  }
  const milestone = []
  for (let step = 0; step <= cap; step += 20) {
    let value = 100
    for (const point of points) {
      if (point.step > step) break
      value = point.survivalPct
    }
    milestone.push({ step, survivalPct: value })
  }
  return {
    cap,
    kmMedianSteps: kmMedian,
    events: points,
    milestones: milestone,
    censoredAtCap: censored.get(cap) || 0,
  }
}

// ---------------------------------------------------------------------------
// Aggregation (from the compact per-game records — same code for a run and for a merge)
// ---------------------------------------------------------------------------
function emptyAggregate() {
  return {
    b: {
      dealt: 0,
      metricBatches: 0,
      fallbackBatches: 0,
      relaxedPressureOnly: 0,
      relaxedBoth: 0,
      candidatesSampled: 0,
      candidatesProven: 0,
      candidatesUnknown: 0,
      candidatesDropped: 0,
      nodesSum: 0,
      nodesMax: 0,
      constructedBatches: 0,
      rootSolvableBatches: 0,
      rootUnknownBatches: 0,
      rootUnsolvedBatches: 0,
      targetUnreachableBatches: 0,
      handNoFullContinuationBatches: 0,
      handNoFullContinuationTotal: 0,
      handNoFullContinuationAliasMismatches: 0,
      handNoFullContinuationFieldAbsent: 0,
      boardNoFullContinuation: 0,
      solvableBatches: 0,
      witnessChecked: 0,
      witnessReplayFailures: 0,
      witnessNotFull: 0,
      witnessFailureSamples: [],
      pressureJumpExceeded: 0,
      lowBranchBatches: 0,
      relaxedSameShapeBatches: 0,
      block9Batches: 0,
      block9Slots: 0,
      maxSameShapeInBatch: 0,
      maxBlock9InBatch: 0,
      cooldownWindows: 0,
      cooldownViolations: 0,
      repeatedWithPrevious: 0,
      probeChecked: 0,
      fallbackReasons: {},
      ladderSteps: {},
      infoSteps: {},
      proofStatuses: {},
      probeStatuses: {},
      shapeSlots: {},
    },
    buckets: new Map(),
    arrays: { latencyMs: [], nodes: [] },
    stuckCount: 0,
    stuckReasons: {},
    stuckOutcomeKinds: {},
    stuckProbeSolvable: 0,
    stuckProbeNotSolvable: 0,
    stuckProbeUnknownState: 0,
    stepsSinceLastFullWitness: [],
    stuckRemainingShapes: {},
    traceContinuations: {},
    traceMobility: [],
    traceR: [],
    traceByOffset: {},
  }
}

function mergeGame(aggregate, game) {
  const a = aggregate
  const b = game.b
  for (const key of Object.keys(a.b)) {
    if (typeof a.b[key] !== 'number' || MAX_FIELDS.has(key)) continue
    a.b[key] += (b[key] || 0)
  }
  for (const key of MAX_FIELDS) a.b[key] = Math.max(a.b[key] || 0, b[key] || 0)
  mergeCounts(a.b.fallbackReasons, b.fallbackReasons)
  mergeCounts(a.b.ladderSteps, b.ladderSteps)
  mergeCounts(a.b.infoSteps, b.infoSteps)
  mergeCounts(a.b.proofStatuses, b.proofStatuses)
  mergeCounts(a.b.probeStatuses, b.probeStatuses)
  mergeCounts(a.b.shapeSlots, b.shapeSlots)
  for (const sample of b.witnessFailureSamples || []) {
    if (a.b.witnessFailureSamples.length < 10) a.b.witnessFailureSamples.push(sample)
  }

  for (const [key, bucket] of Object.entries(b.buckets || {})) {
    let target = a.buckets.get(key)
    if (!target) {
      target = {
        tier: bucket.tier, phase: bucket.phase, n: 0, within: 0, intersects: 0, above: 0, below: 0,
        degenerate: 0, aN: 0, aLowerSum: 0, aUpperSum: 0, minALower: null, maxAUpper: null,
        withinPressure: 0, rBefore: [], jump: [],
      }
      a.buckets.set(key, target)
    }
    for (const scalar of ['n', 'within', 'intersects', 'above', 'below', 'degenerate', 'aN', 'aLowerSum', 'aUpperSum', 'withinPressure']) {
      target[scalar] += bucket[scalar] || 0
    }
    if (Number.isFinite(bucket.minALower)) target.minALower = target.minALower === null ? bucket.minALower : Math.min(target.minALower, bucket.minALower)
    if (Number.isFinite(bucket.maxAUpper)) target.maxAUpper = target.maxAUpper === null ? bucket.maxAUpper : Math.max(target.maxAUpper, bucket.maxAUpper)
    target.rBefore.push(...(bucket.rBefore || []))
    target.jump.push(...(bucket.jump || []))
  }

  a.arrays.latencyMs.push(...(game.arrays?.latencyMs || []))
  a.arrays.nodes.push(...(game.arrays?.nodes || []))

  if (game.stuck) {
    const s = game.stuck
    a.stuckCount += 1
    addCount(a.stuckReasons, s.reason)
    if (s.previousBatchProbeSolvable === true) a.stuckProbeSolvable += 1
    else if (s.previousBatchProbeSolvable === false) a.stuckProbeNotSolvable += 1
    else a.stuckProbeUnknownState += 1
    if (Number.isFinite(s.stepsSinceLastFullWitness)) a.stepsSinceLastFullWitness.push(s.stepsSinceLastFullWitness)
    for (const name of s.remainingShapes || []) addCount(a.stuckRemainingShapes, name)
    const trace = s.trace || []
    trace.forEach((entry, index) => {
      addCount(a.traceContinuations, entry.continuation)
      a.traceMobility.push(entry.mobility)
      if (Number.isFinite(entry.r)) a.traceR.push(entry.r)
      const offset = trace.length - index // 1 = the placement right before the stuck hand
      const slot = a.traceByOffset[offset] || (a.traceByOffset[offset] = { mobility: [], r: [], solvable: 0, unsolvable: 0, unknown: 0, noPieces: 0, n: 0 })
      slot.n += 1
      slot.mobility.push(entry.mobility)
      if (Number.isFinite(entry.r)) slot.r.push(entry.r)
      if (entry.continuation === 'SOLVABLE') slot.solvable += 1
      else if (entry.continuation === 'UNSOLVABLE') slot.unsolvable += 1
      else if (entry.continuation === 'UNKNOWN') slot.unknown += 1
      else slot.noPieces += 1
    })
  }
}

function aggregateGroup(games, { arm, strategy, seed = null, stepCap }) {
  const aggregate = emptyAggregate()
  for (const game of games) mergeGame(aggregate, game)

  const n = games.length
  const ended = games.filter((game) => game.ended).length
  const censored = games.filter((game) => game.censored).length
  const allSteps = games.map((game) => game.steps)
  const endedSteps = games.filter((game) => game.ended).map((game) => game.steps)

  const phaseCounts = { warmup: 0, build: 0, challenge: 0, relief: 0 }
  for (const game of games) for (const [phase, count] of Object.entries(game.phaseCounts)) phaseCounts[phase] += count

  const tierReached = new Map()
  for (const game of games) tierReached.set(game.maxTier, (tierReached.get(game.maxTier) || 0) + 1)

  const b = aggregate.b
  const totalSlots = Object.values(b.shapeSlots).reduce((sum, value) => sum + value, 0)
  const rate = (value, total) => (total ? round((value / total) * 100, 2) : null)

  // Per (tier, phase) tolerance buckets, plus the SAME data re-folded by tier alone, because
  // §12.2 asks for the 0–29 / 30–59 / 60–89 / 90+ strata specifically. Every stratum and every
  // phase is reported, including the ones with zero batches in this sample — an omitted row
  // reads as "fine" and an explicit zero reads as "not observed here".
  const tolerance = [...aggregate.buckets.values()]
    .sort((x, y) => x.tier - y.tier || x.phase.localeCompare(y.phase))
    .map((bucket) => {
      const target = targetRangeOf(bucket.phase, bucket.tier)
      let unreachable = null
      if (bucket.aN > 0 && bucket.within === 0) {
        if (bucket.above === bucket.aN) unreachable = 'structural/above — every batch was EASIER than the target (A_lower > target upper bound in all of them)'
        else if (bucket.below === bucket.aN) unreachable = 'structural/below — every batch was HARDER than the target (A_upper < target lower bound in all of them)'
        else unreachable = 'never fully inside, although individual batches do overlap the target'
      }
      return {
        tier: bucket.tier,
        phase: bucket.phase,
        target: [...target],
        batches: bucket.n,
        aBatches: bucket.aN,
        withinCount: bucket.within,
        withinPct: rate(bucket.within, bucket.aN),
        intersectsCount: bucket.intersects,
        intersectsPct: rate(bucket.intersects, bucket.aN),
        aboveCount: bucket.above,
        abovePct: rate(bucket.above, bucket.aN),
        belowCount: bucket.below,
        belowPct: rate(bucket.below, bucket.aN),
        degenerateCount: bucket.degenerate,
        degeneratePct: rate(bucket.degenerate, bucket.aN),
        withinPressureCount: bucket.withinPressure,
        withinPressurePct: rate(bucket.withinPressure, bucket.n),
        minALower: bucket.aN ? round(bucket.minALower, 3) : null,
        maxAUpper: bucket.aN ? round(bucket.maxAUpper, 3) : null,
        meanALower: bucket.aN ? round(bucket.aLowerSum / bucket.aN, 3) : null,
        meanAUpper: bucket.aN ? round(bucket.aUpperSum / bucket.aN, 3) : null,
        meanWidth: bucket.aN ? round((bucket.aUpperSum - bucket.aLowerSum) / bucket.aN, 3) : null,
        rBefore: quantiles(bucket.rBefore, [50, 95]),
        jumpRealised: quantiles(bucket.jump, [50, 95]),
        unreachable,
      }
    })

  const strata = TIERS.map((config) => {
    const tier = config.tier
    const rows = tolerance.filter((bucket) => bucket.tier === tier)
    const batches = rows.reduce((sum, row) => sum + row.batches, 0)
    const aBatches = rows.reduce((sum, row) => sum + row.aBatches, 0)
    const within = rows.reduce((sum, row) => sum + row.withinCount, 0)
    const rValues = []
    for (const bucket of aggregate.buckets.values()) if (bucket.tier === tier) rValues.push(...bucket.rBefore)
    const jumpValues = []
    for (const bucket of aggregate.buckets.values()) if (bucket.tier === tier) jumpValues.push(...bucket.jump)
    return {
      tier,
      label: tier === TIERS.length - 1 ? `${config.minPlacements}+` : `${config.minPlacements}–${config.minPlacements + 29}`,
      placementRange: [config.minPlacements, tier === TIERS.length - 1 ? null : config.minPlacements + 29],
      tierLabel: config.label,
      buildTarget: [...config.build],
      challengeTarget: [...config.challenge],
      batches,
      aBatches,
      withinCount: within,
      targetHitPct: rate(within, aBatches),
      meanALower: rows.filter((row) => row.aBatches).length ? round(rows.reduce((sum, row) => sum + (row.meanALower || 0) * row.aBatches, 0) / aBatches, 3) : null,
      meanAUpper: rows.filter((row) => row.aBatches).length ? round(rows.reduce((sum, row) => sum + (row.meanAUpper || 0) * row.aBatches, 0) / aBatches, 3) : null,
      minALower: rows.filter((row) => row.minALower !== null).length ? Math.min(...rows.filter((row) => row.minALower !== null).map((row) => row.minALower)) : null,
      maxAUpper: rows.filter((row) => row.maxAUpper !== null).length ? Math.max(...rows.filter((row) => row.maxAUpper !== null).map((row) => row.maxAUpper)) : null,
      r: quantiles(rValues, [50, 95]),
      jumpRealised: quantiles(jumpValues, [50, 95]),
      // EVERY phase is listed, including the ones with zero batches in this sample. An omitted
      // row reads as "fine"; an explicit zero reads as "not observed here", which is the truth.
      phases: Object.fromEntries(PHASES.map((phase) => {
        const row = rows.find((bucket) => bucket.phase === phase)
        return [phase, row
          ? {
            observed: true,
            batches: row.batches,
            aBatches: row.aBatches,
            targetHitPct: row.withinPct,
            meanALower: row.meanALower,
            meanAUpper: row.meanAUpper,
            withinPressurePct: row.withinPressurePct,
            rBefore: row.rBefore,
          }
          : {
            observed: false,
            batches: 0,
            aBatches: 0,
            targetHitPct: null,
            meanALower: null,
            meanAUpper: null,
            withinPressurePct: null,
            rBefore: null,
          }]
      })),
    }
  })

  const pressureByPhase = {}
  const pooledR = []
  const pooledJump = []
  for (const bucket of aggregate.buckets.values()) {
    pooledR.push(...bucket.rBefore)
    pooledJump.push(...bucket.jump)
  }
  for (const phase of Object.keys(PRESSURE_DELTA)) {
    const jumps = []
    let batches = 0
    let within = 0
    for (const bucket of aggregate.buckets.values()) {
      if (bucket.phase !== phase) continue
      batches += bucket.n
      within += bucket.withinPressure
      jumps.push(...bucket.jump)
    }
    if (!batches) continue
    const target = PRESSURE_DELTA[phase]
    const inside = jumps.filter((value) => value >= target[0] && value <= target[1]).length
    pressureByPhase[phase] = {
      target: [...target],
      batches,
      jump: quantiles(jumps, [50, 95]),
      withinTargetCount: inside,
      withinTargetPct: rate(inside, jumps.length),
      withinPressureRangePct: rate(within, batches),
    }
  }

  const survival = survivalOf(games, stepCap)
  const stepsQuantiles = quantiles(allSteps, [50, 95, 99])

  const traceByOffset = Object.fromEntries(Object.entries(aggregate.traceByOffset).map(([offset, slot]) => [offset, {
    n: slot.n,
    mobility: quantiles(slot.mobility, [50]),
    r: quantiles(slot.r, [50]),
    solvablePct: rate(slot.solvable, slot.n),
    unsolvablePct: rate(slot.unsolvable, slot.n),
    unknownPct: rate(slot.unknown, slot.n),
    noPiecesPct: rate(slot.noPieces, slot.n),
  }]))

  return {
    arm,
    strategy,
    seed,
    games: n,
    ended,
    endedPct: rate(ended, n),
    endedCi95: wilson(ended, n),
    censored,
    censoredPct: rate(censored, n),
    refusedDealEnds: games.filter((game) => game.endedByRefusedDeal).length,
    stepsAll: stepsQuantiles,
    // The step cap makes this a CENSORED quantile whenever it lands on the cap. `stepsCensored`
    // says so instead of leaving the reader to notice.
    stepsQuantilesCensored: stepsQuantiles.p95 >= stepCap || stepsQuantiles.p99 >= stepCap,
    stepsEndedOnly: quantiles(endedSteps, [50, 95, 99]),
    meanStepsCensored: n ? round(allSteps.reduce((sum, value) => sum + value, 0) / n, 1) : null,
    meanStepsEndedOnly: endedSteps.length ? round(endedSteps.reduce((sum, value) => sum + value, 0) / endedSteps.length, 1) : null,
    survival,
    maxTierReached: [...tierReached.entries()].sort((x, y) => x[0] - y[0]).map(([tier, count]) => ({ tier, games: count })),
    batchesDealt: b.dealt,
    phaseCounts,
    tolerance,
    strata,
    pressureByPhase,
    pressure: {
      // Pooled across strata: the per-stratum R quantiles are in `strata[].r`; this is the
      // whole-arm view. R is measured on every arm (blind dealing included), so it is the one
      // pressure number the C→F fair control can compare directly.
      rBefore: quantiles(pooledR, [50, 95, 99]),
      jumpRealised: quantiles(pooledJump, [50, 95, 99]),
      jumpOverMaxCount: b.pressureJumpExceeded,
    },
    fallback: {
      applies: b.metricBatches > 0,
      metricBatches: b.metricBatches,
      fallbackBatches: b.fallbackBatches,
      fallbackPct: rate(b.fallbackBatches, b.metricBatches),
      reasons: Object.entries(b.fallbackReasons).map(([reason, count]) => ({ reason, count, pct: rate(count, b.metricBatches) })).sort((x, y) => y.count - x.count),
      ladderSteps: Object.entries(b.ladderSteps).map(([step, count]) => ({ step, count, pct: rate(count, b.metricBatches) })).sort((x, y) => y.count - x.count),
      informationalSteps: Object.entries(b.infoSteps).map(([step, count]) => ({ step, count, pct: rate(count, b.metricBatches) })).sort((x, y) => y.count - x.count),
      relaxedPressureOnly: b.relaxedPressureOnly,
      relaxedBoth: b.relaxedBoth,
      pressureJumpExceeded: b.pressureJumpExceeded,
    },
    solver: {
      batchesWithMetrics: b.metricBatches,
      probeBatches: b.probeChecked,
      rootSolvableBatches: b.rootSolvableBatches,
      rootSolvablePct: rate(b.rootSolvableBatches, b.probeChecked),
      rootUnknownBatches: b.rootUnknownBatches,
      rootUnknownPct: rate(b.rootUnknownBatches, b.probeChecked),
      rootUnsolvableBatches: b.rootUnsolvedBatches,
      rootUnsolvablePct: rate(b.rootUnsolvedBatches, b.probeChecked),
      probeStatuses: Object.entries(b.probeStatuses).map(([status, count]) => ({ status, count, pct: rate(count, b.probeChecked) })),
      candidatesSampled: b.candidatesSampled,
      candidatesProven: b.candidatesProven,
      candidatesUnknown: b.candidatesUnknown,
      candidatesDropped: b.candidatesDropped,
      candidatesDroppedPerBatch: b.metricBatches ? round(b.candidatesDropped / b.metricBatches, 3) : null,
      candidateProvenPct: rate(b.candidatesProven, b.candidatesSampled),
      candidateUnknownPct: rate(b.candidatesUnknown, b.candidatesSampled),
      candidateDroppedPct: rate(b.candidatesDropped, b.candidatesSampled),
      constructedBatches: b.constructedBatches,
      constructedPct: rate(b.constructedBatches, b.metricBatches),
      targetUnreachableBatches: b.targetUnreachableBatches,
      targetUnreachablePct: rate(b.targetUnreachableBatches, b.metricBatches),
      lowBranchBatches: b.lowBranchBatches,
      nodes: quantiles(aggregate.arrays.nodes, [50, 95, 99]),
      nodesPerBatchMean: b.metricBatches ? round(b.nodesSum / b.metricBatches, 1) : null,
      proofStatuses: Object.entries(b.proofStatuses).map(([status, count]) => ({ status, count })),
    },
    noContinuation: {
      dealerMetricsPresent: b.metricBatches > 0,
      handNoFullContinuationBatches: b.handNoFullContinuationBatches,
      handNoFullContinuationBatchesPct: rate(b.handNoFullContinuationBatches, b.metricBatches),
      handNoFullContinuationTotal: b.handNoFullContinuationTotal,
      handNoFullContinuationPerBatch: b.metricBatches ? round(b.handNoFullContinuationTotal / b.metricBatches, 3) : null,
      handNoFullContinuationAliasMismatches: b.handNoFullContinuationAliasMismatches,
      boardNoFullContinuation: b.boardNoFullContinuation,
      boardNoFullContinuationPct: rate(b.boardNoFullContinuation, b.metricBatches),
      dealerFieldAbsentBatches: b.handNoFullContinuationFieldAbsent,
      dealerFieldPresent: b.metricBatches > 0 && b.handNoFullContinuationFieldAbsent === 0,
      // The harness's own uniform measurement of the SAME fact (see `finishBatch`): every
      // dealt hand in every arm is asked "do you have a full 3-step continuation here?".
      probeHandNoFullContinuation: b.rootUnsolvedBatches,
      probeHandNoFullContinuationPct: rate(b.rootUnsolvedBatches, b.probeChecked),
      probeHandUnknown: b.rootUnknownBatches,
      probeHandUnknownPct: rate(b.rootUnknownBatches, b.probeChecked),
    },
    witness: {
      solvableBatches: b.solvableBatches,
      checked: b.witnessChecked,
      replayFailures: b.witnessReplayFailures,
      notFullWitness: b.witnessNotFull,
      samples: b.witnessFailureSamples,
    },
    dealLatencyMs: aggregate.arrays.latencyMs.length ? quantiles(aggregate.arrays.latencyMs, [50, 95, 99]) : null,
    batchFilter: {
      maxSameShapeInBatch: b.maxSameShapeInBatch,
      maxBlock9InBatch: b.maxBlock9InBatch,
      block9Batches: b.block9Batches,
      block9BatchPct: rate(b.block9Batches, b.dealt),
      block9Slots: b.block9Slots,
      block9SlotPct: rate(b.block9Slots, totalSlots),
      cooldownWindows: b.cooldownWindows,
      cooldownHits: b.cooldownWindows - b.cooldownViolations,
      cooldownHitPct: rate(b.cooldownWindows - b.cooldownViolations, b.cooldownWindows),
      cooldownViolations: b.cooldownViolations,
      repeatedBatchCount: b.repeatedWithPrevious,
      repeatedBatchPct: rate(b.repeatedWithPrevious, b.dealt),
      relaxedSameShapeBatches: b.relaxedSameShapeBatches,
    },
    shapeShares: Object.entries(b.shapeSlots)
      .map(([name, count]) => ({ name, count, sharePct: rate(count, totalSlots) }))
      .sort((x, y) => y.count - x.count),
    slotsDealt: totalSlots,
    stuck: {
      games: aggregate.stuckCount,
      gamesPct: rate(aggregate.stuckCount, n),
      reasons: Object.entries(aggregate.stuckReasons).map(([reason, count]) => ({ reason, count })),
      previousBatchHadFullWitnessPct: rate(aggregate.stuckProbeSolvable, aggregate.stuckCount),
      previousBatchHadFullWitnessCount: aggregate.stuckProbeSolvable,
      previousBatchProbeSolvable: aggregate.stuckProbeSolvable,
      previousBatchProbeNotSolvable: aggregate.stuckProbeNotSolvable,
      previousBatchProbeUnknown: aggregate.stuckProbeUnknownState,
      stepsSinceLastFullWitness: quantiles(aggregate.stepsSinceLastFullWitness, [50, 95]),
      remainingShapes: Object.entries(aggregate.stuckRemainingShapes).map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count),
      traceContinuations: Object.entries(aggregate.traceContinuations).map(([status, count]) => ({ status, count })),
      traceMobility: quantiles(aggregate.traceMobility, [50, 95]),
      traceR: quantiles(aggregate.traceR, [50, 95]),
      traceByOffset,
    },
  }
}

function baseSharesOf(arm) {
  const total = Object.values(arm.weights).reduce((sum, weight) => sum + (weight > 0 ? weight : 0), 0)
  return Object.fromEntries(
    arm.shapes
      .filter((shape) => (arm.weights[shape.name] ?? 0) > 0)
      .map((shape) => [shape.name, round(((arm.weights[shape.name] || 0) / total) * 100, 2)]),
  )
}

function designFor(armIds) {
  return {
    arms: Object.fromEntries(armIds.map((id) => {
      const arm = ARMS[id]
      const weights = Object.fromEntries(arm.shapes.map((shape) => [shape.name, arm.weights[shape.name] ?? 0]))
      const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0)
      return [id, {
        id: arm.id,
        label: arm.label,
        dealer: arm.dealer === 'boardAware' ? '棋盘感知发牌（session.deal()）' : '盲发牌（本工具实现：三次独立加权抽取）',
        block9Out: arm.block9Out === true,
        pool: arm.shapes.map((shape) => shape.name).join(', '),
        poolSize: arm.shapes.length,
        slots: blindTable(arm).length,
        weights,
        totalWeight: round(totalWeight, 3),
        baseShares: baseSharesOf(arm),
      }]
    })),
    pairs: PAIRS,
    blindDealing: '工具内实现：三次独立加权抽取，无棋盘感知、无批次过滤、无 Block 9 冷却、无回退路径；用 session.makePiece(shape) 建块、session.setPieces([...]) 提交。src/ 未改动。',
    block9WeightZero: 'C/F 的 Block 9 权重为 0 = 零权重成员：blindTable() 在累加之前就把它滤掉（与 src/game/dealer.js 的 weightedTable(exclude) 同一机制），不是"抽到再拒绝"。C 的棋盘感知一侧通过 armCForceBlock9Out() 把导演的 Block 9 冷却一直武装着，使 batchConstraints() 返回 allowBlock9=false，从而让 session.deal() 构造出同样不含 Block 9 的抽取表——这是把"权重 0"接到现行发牌器上的唯一杠杆，属实验性手段，报告同时给出 C 的实测 Block 9 出场占比供核对。',
    streams: '每局以 hashSeed(schema, seed, gameIndex) 为基，开局面与机器人选择流在六个臂中起始状态完全相同；session.resetDirector(base) 使棋盘感知臂的内部 deal/search/director 流与盲臂手工构造的流同源。发牌流的消耗在第一批之后必然分叉——那正是被测量的处理效应。',
    items: '机器人不使用道具，四种充能在开局清零（否则 stuckOutcome() 永不为 end）。',
    stepCap: null,
    censoring: '达到上限时该局仍在可放状态 → 右删失；自然结束在恰好等于上限的步数上仍计入"结束"。生存曲线用 Kaplan-Meier 做上限处的行政删失。',
    strategies: {},
    confidence: 'Wilson 95%，仅用于比率，仅表达这些机器人的抽样不确定性。',
    noiseProvenance: `镜像 tools/difficulty-model.mjs 的 chooseForSlot/chooseMove 意图（首个可放槽位；${NOISE_RANDOM_CHANCE * 100}% 随机），但在真实 session 上重写；不是逐字节历史复现。`,
    traceDefinition: `"离开可完成路径多少步" = 卡住时的步数 − 最近一批"整手有完整 3 步 witness"的批次的发牌步数。witness 由本工具自己的 solveHand 探针（nodeBudget=${BUDGET.nodesPerHand}）在每一批的到手手牌上判定，因此盲臂与棋盘感知臂口径相同。`,
    block9CooldownBatches: BATCH_RULES.block9CooldownBatches,
    maxSameShapePerBatch: BATCH_RULES.maxSameShapePerBatch,
    configVersion: DEAL_CONFIG_VERSION,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const allowed = new Set(['arms', 'games', 'seeds', 'strategies', 'step-cap', 'out', 'raw', 'merge', 'game-offset', 'note'])
  const opts = {}
  for (const arg of argv) {
    const match = /^--([^=]+)=(.+)$/.exec(arg)
    if (!match || !allowed.has(match[1])) throw new Error(`Unknown/invalid argument ${arg}; use --name=value`)
    if (opts[match[1]] !== undefined) throw new Error(`Repeated argument ${match[1]}`)
    opts[match[1]] = match[2]
  }
  const positive = (value, label) => {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
    return n
  }
  const list = (value, label) => {
    const parts = value.split(',')
    if (parts.some((part) => !part) || new Set(parts).size !== parts.length) {
      throw new Error(`${label} must contain unique non-empty values`)
    }
    return parts
  }
  const arms = list(opts.arms || 'A,B,C,D,E,F', 'arms')
  arms.forEach((id) => { if (!ARMS[id]) throw new Error(`unknown arm ${id}; use A,B,C,D,E,F`) })
  const strategies = list(opts.strategies || STRATEGY_ORDER.join(','), 'strategies')
  strategies.forEach((id) => { if (!STRATEGIES[id]) throw new Error(`unknown strategy ${id}; use ${STRATEGY_ORDER.join(',')}`) })
  const seeds = list(opts.seeds || '1,2,3', 'seeds').map((value) => {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('seeds must be uint32')
    return n
  })
  if (new Set(seeds).size !== seeds.length) throw new Error('seeds must be numerically unique')
  const gameOffset = opts['game-offset'] === undefined ? 0 : Number(opts['game-offset'])
  if (!Number.isSafeInteger(gameOffset) || gameOffset < 0) throw new Error('game-offset must be a non-negative integer')
  return {
    arms,
    strategies,
    seeds,
    games: positive(opts.games || 200, 'games'),
    gameOffset,
    stepCap: positive(opts['step-cap'] || 600, 'step-cap'),
    out: opts.out || 'tools/results/deal-experiments',
    raw: opts.raw || path.join(os.tmpdir(), `voxalblast-deal-experiments-${arms.join('')}-${strategies.join('-')}.raw.json`),
    merge: opts.merge ? opts.merge.split(',') : null,
    note: opts.note || null,
  }
}

function fingerprints() {
  const files = [
    'src/game/shapes.js', 'src/game/dealConfig.js', 'src/game/dealDirector.js', 'src/game/dealer.js',
    'src/game/handSolver.js', 'src/game/boardPressure.js', 'src/game/placementModel.js',
    'src/game/gameSession.js', 'src/game/board.js', 'src/game/rng.js',
    'src/rendering/config.js', 'tools/deal-experiments.mjs',
  ]
  return Object.fromEntries(files.map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]))
}

// ---------------------------------------------------------------------------
// Result assembly (shared by a single run and by a multi-shard merge)
// ---------------------------------------------------------------------------
function buildResult({ games, options, command, shards = null, startedAt }) {
  const design = designFor(options.arms)
  design.stepCap = options.stepCap
  design.strategies = Object.fromEntries(options.strategies.map((id) => [id, STRATEGIES[id].description]))

  const groups = []
  const pooled = []
  const byCell = new Map()
  for (const game of games) {
    const key = `${game.arm}|${game.strategy}|${game.seed}`
    if (!byCell.has(key)) byCell.set(key, [])
    byCell.get(key).push(game)
  }
  for (const armId of options.arms) {
    for (const strategyId of options.strategies) {
      for (const seed of options.seeds) {
        const cell = byCell.get(`${armId}|${strategyId}|${seed}`) || []
        if (!cell.length) continue
        groups.push(aggregateGroup(cell, { arm: armId, strategy: strategyId, seed, stepCap: options.stepCap }))
      }
    }
  }
  for (const armId of options.arms) {
    for (const strategyId of options.strategies) {
      const cellGames = []
      for (const seed of options.seeds) cellGames.push(...(byCell.get(`${armId}|${strategyId}|${seed}`) || []))
      if (!cellGames.length) continue
      const row = aggregateGroup(cellGames, { arm: armId, strategy: strategyId, stepCap: options.stepCap })
      row.bySeed = groups
        .filter((group) => group.arm === armId && group.strategy === strategyId)
        .map((group) => ({
          seed: group.seed, games: group.games, endedPct: group.endedPct, censored: group.censored,
          stepsAll: group.stepsAll, survivalKmMedian: group.survival.kmMedianSteps,
          meanStepsCensored: group.meanStepsCensored,
        }))
      pooled.push(row)
    }
  }

  // Opening-board identity check: the claim "paired games start from the same board" is
  // verifiable rather than asserted, so it is verified here.
  const openingByCellCount = new Map()
  for (const game of games) {
    const key = `${game.seed}|${game.gameIndex}`
    if (!openingByCellCount.has(key)) openingByCellCount.set(key, new Set())
    openingByCellCount.get(key).add(game.openingCells)
  }
  const mismatchedOpenings = [...openingByCellCount.values()].filter((set) => set.size > 1).length
  const openingCellHistogram = tally(games.map((game) => game.openingCells)).map(([cells, count]) => ({ cells, games: count }))

  // The reachability findings, lifted out of the per-group tables so the headline claim is a
  // first-class result rather than something a reader has to dig for.
  const reachability = []
  for (const row of pooled) {
    for (const bucket of row.tolerance) {
      if (bucket.aBatches === 0) continue
      const base = {
        arm: row.arm, strategy: row.strategy, tier: bucket.tier, phase: bucket.phase,
        target: bucket.target, batches: bucket.aBatches, withinCount: bucket.withinCount,
        withinPct: bucket.withinPct, intersectsCount: bucket.intersectsCount,
        abovePct: bucket.abovePct, belowPct: bucket.belowPct,
        degeneratePct: bucket.degeneratePct,
        minALower: bucket.minALower, maxAUpper: bucket.maxAUpper,
      }
      if (bucket.unreachable) {
        reachability.push(bucket.aBatches >= 20
          ? { ...base, kind: 'structural', detail: bucket.unreachable }
          : { ...base, kind: 'none-inside-small-sample', detail: `${bucket.unreachable} — but only ${bucket.aBatches} batches, so this is NOT called structural` })
      } else if (bucket.aBatches >= 20 && bucket.withinPct < 50) {
        reachability.push({
          ...base,
          kind: 'rarely-met',
          detail: `landed fully inside in ${bucket.withinCount}/${bucket.aBatches} batches (${bucket.withinPct}%); ${bucket.abovePct}% of batches were EASIER than the target and ${bucket.belowPct}% HARDER`,
        })
      }
    }
  }
  reachability.sort((x, y) => (x.kind === y.kind ? x.withinPct - y.withinPct : x.kind === 'structural' ? -1 : 1))

  const latencyRows = pooled.filter((row) => row.dealLatencyMs)
  const latencyVerdict = latencyRows.length ? {
    spec: 'p95 <= 150ms per dealt batch, no main-thread task over 50ms',
    worstP50: Math.max(...latencyRows.map((row) => row.dealLatencyMs.p50)),
    worstP95: Math.max(...latencyRows.map((row) => row.dealLatencyMs.p95)),
    worstP99: Math.max(...latencyRows.map((row) => row.dealLatencyMs.p99)),
    worstMax: Math.max(...latencyRows.map((row) => row.dealLatencyMs.max)),
    p95InsideBudget: Math.max(...latencyRows.map((row) => row.dealLatencyMs.p95)) <= 150,
    medianInside50ms: Math.max(...latencyRows.map((row) => row.dealLatencyMs.p50)) <= 50,
    p95Over50ms: Math.max(...latencyRows.map((row) => row.dealLatencyMs.p95)) > 50,
    measuredOn: `${latencyRows.reduce((sum, row) => sum + row.dealLatencyMs.n, 0)} real-game deals through session.deal()`,
    // The single most misleading number in this report if left unexplained: the wall-clock
    // latency was measured while many shards of this very run were competing for the same 16
    // cores. See `sample.note` and the caveat below.
    caveat: `Wall-clock, this machine, single process — NOT reproducible. ${options.note ? `RUN NOTE (read this before quoting any ms number): ${options.note} ` : ''}Two identical single-process runs of this command have differed by ~14ms at p50 because of machine load, and this measurement was taken while the run's own shards were competing for the CPU. Treat these as an order of magnitude, not a budget sign-off.`,
  } : null

  const witnessFailures = pooled.reduce((sum, row) => sum + row.witness.replayFailures, 0)
  const witnessChecked = pooled.reduce((sum, row) => sum + row.witness.checked, 0)

  const totalGames = games.length
  const cells = options.arms.length * options.strategies.length * options.seeds.length

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    command,
    options,
    shards,
    fingerprints: fingerprints(),
    design,
    sample: {
      games: totalGames,
      cells,
      gamesPerCellTarget: options.games,
      arms: options.arms,
      strategies: options.strategies,
      seeds: options.seeds,
      stepCap: options.stepCap,
      strategiesRan: options.strategies,
      strategiesSpecAsksFor: ['random', 'clear', 'noise', 'lookahead'],
      strategiesMissing: ['random', 'clear', 'noise', 'lookahead'].filter((id) => !options.strategies.includes(id)),
      // §12.1 asks for "每臂每种策略 3 个种子、每种子 200 局" = 14400 games with six arms. This run
      // reports what it ACTUALLY did, and the note below says plainly whether it is the full
      // plan or a staged subset.
      specPlan: '6 臂 × 4 策略 × 3 种子 × 200 局 = 14400 局',
      staged: true,
      stagedNote: `本次实际样本 = ${totalGames} 局（${options.arms.length} 臂 × ${options.strategies.length} 策略 × ${options.seeds.length} 种子 × ${options.games} 局）。规格 §12.1 允许分阶段跑，但要求报告说明样本量、截断与预算——这里如实说明：这是分阶段样本，不是"每种子 200 局"的完整计划，任何一格都不能当成正式结论。`,
      note: options.note || null,
      elapsedMs: Date.now() - startedAt,
    },
    openingBoardCheck: {
      pairedGamesChecked: openingByCellCount.size,
      gamesWhereArmsDisagreeOnOpeningCellCount: mismatchedOpenings,
      histogram: openingCellHistogram,
      note: '同一 (seed, gameIndex) 下所有臂的开局占用格数必须完全一致；不一致说明流没有对齐，配对比较无效。',
    },
    groups,
    pooled,
    pairs: PAIRS.map((pair) => ({
      ...pair,
      deltas: options.strategies.map((strategy) => {
        const from = pooled.find((row) => row.arm === pair.from && row.strategy === strategy)
        const to = pooled.find((row) => row.arm === pair.to && row.strategy === strategy)
        if (!from || !to) return null
        return {
          strategy,
          gamesPerSide: from.games,
          endedPctDelta: round(to.endedPct - from.endedPct, 1),
          stepsP50Delta: round(to.stepsAll.p50 - from.stepsAll.p50, 1),
          stepsP95Delta: round(to.stepsAll.p95 - from.stepsAll.p95, 1),
          kmMedianDelta: round((to.survival.kmMedianSteps ?? null) === null || (from.survival.kmMedianSteps ?? null) === null
            ? null
            : to.survival.kmMedianSteps - from.survival.kmMedianSteps, 1),
          fallbackPctDelta: to.fallback.applies && from.fallback.applies
            ? round(to.fallback.fallbackPct - from.fallback.fallbackPct, 1) : null,
          rootSolvablePctDelta: round((to.solver.rootSolvablePct ?? null) === null || (from.solver.rootSolvablePct ?? null) === null
            ? null
            : to.solver.rootSolvablePct - from.solver.rootSolvablePct, 1),
          probeHandNoFullContinuationPctDelta: round((to.noContinuation.probeHandNoFullContinuationPct ?? null) === null || (from.noContinuation.probeHandNoFullContinuationPct ?? null) === null
            ? null
            : to.noContinuation.probeHandNoFullContinuationPct - from.noContinuation.probeHandNoFullContinuationPct, 1),
          meanRDelta: round((to.strata.reduce((sum, s) => sum + (s.r.mean || 0) * s.batches, 0) / (to.batchesDealt || 1))
            - (from.strata.reduce((sum, s) => sum + (s.r.mean || 0) * s.batches, 0) / (from.batchesDealt || 1)), 4),
        }
      }),
    })),
    reachability,
    latencyVerdict,
    witnessReplay: {
      solvableBatchesReplayed: witnessChecked,
      failures: witnessFailures,
      mustBeZero: true,
      pass: witnessFailures === 0,
      note: '每一个被发牌器标为 SOLVABLE 的批次，其 witness 都在用发牌前盘面重建的真实 Board 上逐步回放（Board.canPlace 通过才提交）。失败必须为 0（§12.2、§12.3）。',
    },
    notApplicable: {
      items: {
        status: 'not applicable',
        why: '本次实验按"无道具"口径运行：每局开局把四种道具充能清零（否则 stuckOutcome() 永远返回 refresh/clear-path，局不会结束）。',
        spec12_2: '§12.2 的道具三项（使用前是否仍有可放块 / 使用后能继续多少步 / 是否有效恢复行动）在本口径下没有任何观测，因此报为"不适用"，不编造数字。',
        observedItemUses: 0,
      },
      cacheHits: {
        status: 'not applicable',
        why: '本版发牌器的 metrics 没有缓存命中计数字段；§12.2 的"缓存命中"无法从这些字段读出。最接近的是分阶段筛选（stage1Samples/refineCount），已按 candidatesSampled/Proven/Unknown/Dropped 与 nodes 报告。',
      },
      staleResults: {
        status: 'not applicable',
        why: '本工具同步调用发牌器（session.deal()），没有 Worker，也就不存在"过时结果"。§12.2 的"过时结果丢弃"是 P1 Worker 路径的指标，不在本实验的测量范围内。',
      },
      p2: {
        status: 'not applicable',
        why: 'P2（跨批预览/队列兑现/第六块可完成性）在 P1 关闭（P2_PREVIEW=false），本工具不测。',
      },
    },
    honesty: [
      'BOTS ONLY: no human playtest was involved; none of random/clear/noise/lookahead is a calibrated human skill tier.',
      '`noise` is a heuristic PROXY for a typical player, not a player. `lookahead` is a one-ply greedy with a mobility term, not a solver and not P2 cross-batch planning.',
      `The ${options.stepCap}-step cap makes meanStepsCensored and stepsAll a CENSORED statistic; the survival curve is Kaplan-Meier with administrative censoring at the cap, and censoring is counted explicitly.`,
      'Wilson intervals quantify Monte Carlo uncertainty under these bots only — not model error, not real-player confidence.',
      `Every number rests on the sample size printed next to it (${options.games} games per arm×strategy×seed). This is a STAGED sample, not the spec's full 14400-game plan; small-sample deltas are not causal claims.`,
      'Unreachable targets are reported as reachability findings and are NOT fixed or counted as met.',
      'A pair that moves two factors at once is flagged and is never used for attribution.',
      'Item metrics, cache-hit counts, stale-result counts and all P2 metrics are reported as NOT APPLICABLE under this harness, not estimated.',
    ],
    elapsedMs: Date.now() - startedAt,
  }
}

// ---------------------------------------------------------------------------
// HTML report (same visual style as tools/results/difficulty-*.html)
// ---------------------------------------------------------------------------
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const PALETTE = ['#1261a0', '#23925c', '#db8a08', '#b94574', '#7a4fd0', '#0f9ba6', '#c0561f', '#5c6f2a']
const ARM_COLOR = Object.fromEntries(Object.keys(ARMS).map((id, index) => [id, PALETTE[index % PALETTE.length]]))
const ARM_ORDER = Object.keys(ARMS)

function table(headers, rows, { className = '' } = {}) {
  return `<table${className ? ` class="${className}"` : ''}><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

// A plain inline-SVG survival chart: x = placement step, y = share of runs still alive (KM).
function survivalChart(pooled, options, strategy) {
  const width = 940
  const height = 240
  const pad = { left: 46, right: 12, top: 12, bottom: 28 }
  const cap = options.stepCap
  const x = (step) => pad.left + (step / cap) * (width - pad.left - pad.right)
  const y = (pct) => pad.top + (1 - pct / 100) * (height - pad.top - pad.bottom)
  const lines = pooled
    .filter((row) => row.strategy === strategy)
    .map((row) => {
      const points = row.survival.events.filter((_, index) => index % 1 === 0)
      const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(x(point.step), 1)},${round(y(point.survivalPct), 1)}`).join(' ')
      return `<path d="${path}" fill="none" stroke="${ARM_COLOR[row.arm]}" stroke-width="2"/>`
    }).join('')
  const grid = [0, 25, 50, 75, 100].map((pct) => `<line x1="${pad.left}" y1="${round(y(pct), 1)}" x2="${width - pad.right}" y2="${round(y(pct), 1)}" stroke="#e2e0da"/><text x="${pad.left - 6}" y="${round(y(pct) + 4, 1)}" font-size="11" text-anchor="end" fill="#667">${pct}%</text>`).join('')
  const ticks = [0, 100, 200, 300, 400, 500, 600].filter((step) => step <= cap).map((step) => `<line x1="${round(x(step), 1)}" y1="${pad.top}" x2="${round(x(step), 1)}" y2="${height - pad.bottom}" stroke="#f0eee8"/><text x="${round(x(step), 1)}" y="${height - 8}" font-size="11" text-anchor="middle" fill="#667">${step}</text>`).join('')
  const legend = pooled.filter((row) => row.strategy === strategy).map((row, index) => `<text x="${pad.left + index * 66}" y="${pad.top + 10}" font-size="12" fill="${ARM_COLOR[row.arm]}">${escape(row.arm)}</text>`).join('')
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px">${grid}${ticks}${lines}${legend}</svg>`
}

function htmlReport(result) {
  const headline = 'VoxalBlast 发牌实验：A–F 六臂（形状池 / 权重 / 发牌方式分离）'
  const pooled = result.pooled
  const byArm = (armId, strategy) => pooled.find((row) => row.arm === armId && row.strategy === strategy)

  const designRows = result.options.arms.map((id) => {
    const arm = result.design.arms[id]
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(arm.id)}</span> ${escape(arm.label)}`,
      `${arm.poolSize} 类（${escape(arm.pool)}）`,
      escape(arm.dealer),
      `${arm.slots} 槽`,
    ]
  })

  const shareRows = result.options.arms.map((id) => {
    const arm = result.design.arms[id]
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `${arm.baseShares['Line 4'] ?? 0}%`,
      `${arm.baseShares['Block 9'] ?? 0}%`,
      `${arm.totalWeight}`,
      arm.slots,
    ]
  })

  const pairRows = result.pairs.map((pair) => {
    const cells = result.options.strategies.map((strategy) => {
      const from = byArm(pair.from, strategy)
      const to = byArm(pair.to, strategy)
      if (!from || !to) return `${escape(strategy)}: —`
      const delta = pair.deltas.find((entry) => entry && entry.strategy === strategy)
      if (!delta) return `${escape(strategy)}: —`
      const sign = (value) => (value === null ? '—' : `${value > 0 ? '+' : ''}${value}`)
      return `${escape(strategy)}: 结束率 ${sign(delta.endedPctDelta)}pp，P50 步 ${sign(delta.stepsP50Delta)}，KM 中位 ${sign(delta.kmMedianDelta)}，平均 R ${sign(delta.meanRDelta)}`
    })
    return [
      `${pair.headline ? '<b>' : ''}${escape(pair.id)}${pair.headline ? '</b>' : ''}${pair.single ? '' : ' <b>（双因子）</b>'}`,
      escape(pair.factor),
      pair.single ? '单因子，可用于归因' : '<b>不是单因子，不可用于归因</b>',
      cells.join('<br>'),
    ]
  })

  const mainRows = (strategy) => result.options.arms.map((id) => {
    const row = byArm(id, strategy)
    if (!row) return []
    const seedCells = row.bySeed.map((seed) => `${seed.seed}: ${seed.endedPct}%`).join(' / ')
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `${row.games}`,
      `${row.endedPct}% [${row.endedCi95.join(', ')}]<br>各种子：${seedCells}`,
      `${row.stepsAll.p50}`,
      `${row.stepsAll.p95}${row.stepsQuantilesCensored ? ' <b>（触及上限，已删失）</b>' : ''}`,
      `${row.stepsAll.p99}`,
      `${row.survival.kmMedianSteps ?? '—'}`,
      `${row.meanStepsCensored}`,
      `${row.censored} (${row.censoredPct}%)`,
      row.maxTierReached.map((tier) => `T${tier.tier}:${tier.games}`).join(' '),
    ]
  })

  const strataRows = (strategy) => result.options.arms.flatMap((id) => {
    const row = byArm(id, strategy)
    if (!row) return []
    return row.strata.map((stratum) => [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `T${stratum.tier} ${escape(stratum.label)}`,
      `${stratum.batches}`,
      `${stratum.aBatches}`,
      stratum.aBatches
        ? `${stratum.meanALower} / ${stratum.meanAUpper}<br>观测 ${stratum.minALower}…${stratum.maxAUpper}`
        : '—（盲发牌不产生 A 区间）',
      stratum.aBatches ? `<b>${stratum.targetHitPct}%</b>` : '—',
      `${stratum.r.p50} / ${stratum.r.p95}`,
      `${stratum.jumpRealised.p50} / ${stratum.jumpRealised.p95}`,
      Object.entries(stratum.phases).map(([phase, entry]) => (entry.observed
        ? `${escape(phase)}:${entry.batches}${entry.targetHitPct === null ? '' : `（达标 ${entry.targetHitPct}%）`}`
        : `${escape(phase)}:<i>未观测</i>`)).join(' '),
    ])
  })

  const solverRows = (strategy) => result.options.arms.map((id) => {
    const row = byArm(id, strategy)
    if (!row) return []
    const s = row.solver
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `${s.probeBatches}`,
      `${s.rootSolvablePct}%`,
      `${s.rootUnknownPct}%`,
      `${s.rootUnsolvablePct}%`,
      s.batchesWithMetrics ? `${s.constructedPct}% (${s.constructedBatches})` : '—（盲发牌无搜索）',
      s.batchesWithMetrics ? `${s.targetUnreachablePct}% (${s.targetUnreachableBatches})` : '—',
      s.batchesWithMetrics ? `${s.candidateProvenPct}% / ${s.candidateUnknownPct}% / ${s.candidateDroppedPct}%` : '—',
      s.batchesWithMetrics ? `${s.candidatesDroppedPerBatch}` : '—',
    ]
  })

  const noContRows = (strategy) => result.options.arms.map((id) => {
    const row = byArm(id, strategy)
    if (!row) return []
    const c = row.noContinuation
    const dealerCell = !c.dealerMetricsPresent
      ? '<i>—（盲发牌不调用发牌器，没有这些字段）</i>'
      : !c.dealerFieldPresent
        ? `<i>发牌器无该字段（${c.dealerFieldAbsentBatches} 批缺字段）</i>`
        : `${c.handNoFullContinuationBatches} 批 (${c.handNoFullContinuationBatchesPct}%)<br>累计 ${c.handNoFullContinuationTotal} 手（每批 ${c.handNoFullContinuationPerBatch}）<br>别名与 candidatesDropped 不一致：${c.handNoFullContinuationAliasMismatches}`
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      dealerCell,
      c.dealerMetricsPresent ? `${c.boardNoFullContinuation} (${c.boardNoFullContinuationPct}%)` : '—',
      `<b>${c.probeHandNoFullContinuationPct}%</b> (${c.probeHandNoFullContinuation})`,
      `${c.probeHandUnknownPct}% (${c.probeHandUnknown})`,
    ]
  })

  const stuckRows = (strategy) => result.options.arms.map((id) => {
    const row = byArm(id, strategy)
    if (!row) return []
    const s = row.stuck
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `${s.games} (${s.gamesPct}%)`,
      `${s.previousBatchHadFullWitnessPct}% (${s.previousBatchHadFullWitnessCount}/${s.games})`,
      `${s.stepsSinceLastFullWitness.p50} / ${s.stepsSinceLastFullWitness.p95}`,
      s.remainingShapes.slice(0, 5).map((entry) => `${escape(entry.name)}:${entry.count}`).join(' ') || '—',
      s.traceContinuations.map((entry) => `${escape(entry.status)}:${entry.count}`).join(' ') || '—',
      `${s.traceMobility.p50} / ${s.traceMobility.p95}`,
      `${s.traceR.p50} / ${s.traceR.p95}`,
    ]
  })

  const traceRows = (strategy) => result.options.arms.flatMap((id) => {
    const row = byArm(id, strategy)
    if (!row) return []
    return Object.entries(row.stuck.traceByOffset)
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map(([offset, slot]) => [
        `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
        `卡住前第 ${offset} 步`,
        `${slot.n}`,
        `${slot.r.p50}`,
        `${slot.mobility.p50}`,
        `${slot.solvablePct}%`,
        `${slot.unsolvablePct}%`,
        `${slot.unknownPct}%`,
        `${slot.noPiecesPct}%`,
      ])
  })

  const shapeRows = (strategy) => result.options.arms.map((id) => {
    const row = byArm(id, strategy)
    const arm = result.design.arms[id]
    const block9 = row.shapeShares.find((share) => share.name === 'Block 9')
    const line4 = row.shapeShares.find((share) => share.name === 'Line 4')
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `${block9 ? block9.sharePct : 0}%`,
      `${arm.baseShares['Block 9'] ?? 0}%`,
      line4 ? `${line4.sharePct}%` : '—',
      `${arm.baseShares['Line 4'] ?? 0}%`,
      `${row.batchFilter.maxSameShapeInBatch}`,
      `${row.batchFilter.maxBlock9InBatch}`,
      `${row.batchFilter.cooldownWindows}`,
      row.batchFilter.cooldownWindows ? `${row.batchFilter.cooldownHitPct}% (${row.batchFilter.cooldownHits}/${row.batchFilter.cooldownWindows})` : '—',
      `${row.batchFilter.cooldownViolations}`,
      `${row.batchFilter.repeatedBatchPct}%`,
    ]
  })

  const searchRows = (strategy) => result.options.arms.map((id) => {
    const row = byArm(id, strategy)
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      row.dealLatencyMs ? `${row.dealLatencyMs.p50} / ${row.dealLatencyMs.p95} / ${row.dealLatencyMs.p99}` : '—（盲发牌无搜索）',
      row.solver.nodes.n ? `${row.solver.nodes.p50} / ${row.solver.nodes.p95} / ${row.solver.nodes.p99}` : '—',
      row.solver.nodesPerBatchMean ?? '—',
      `${row.witness.solvableBatches}`,
      `${row.witness.checked}`,
      row.witness.replayFailures === 0 ? '<b>0</b>' : `<b style="color:#b00">${row.witness.replayFailures}</b>`,
      `${row.witness.notFullWitness}`,
      `${row.batchesDealt}`,
    ]
  })

  const fallbackRows = (strategy) => result.options.arms
    .map((id) => ({ id, row: byArm(id, strategy) }))
    .filter(({ row }) => row && row.fallback.applies)
    .map(({ id, row }) => [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `${row.fallback.fallbackPct}%`,
      `${row.fallback.fallbackBatches} / ${row.fallback.metricBatches}`,
      row.fallback.reasons.map((r) => `${escape(r.reason)}: ${r.count} (${r.pct}%)`).join('<br>') || '—',
      row.fallback.ladderSteps.map((r) => `${escape(r.step)}: ${r.count}`).join('<br>') || '—',
      row.fallback.informationalSteps.map((r) => `${escape(r.step)}: ${r.count}`).join('<br>') || '—',
      `只放宽压力: ${row.fallback.relaxedPressureOnly}<br>两者都放宽: ${row.fallback.relaxedBoth}`,
    ])

  const toleranceRows = (strategy) => result.options.arms
    .map((id) => ({ id, row: byArm(id, strategy) }))
    .filter(({ row }) => row && row.tolerance.some((bucket) => bucket.aBatches > 0))
    .flatMap(({ id, row }) => row.tolerance.filter((bucket) => bucket.aBatches > 0).map((bucket) => [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `T${bucket.tier} ${escape(bucket.phase)}`,
      `[${bucket.target.join(', ')}]`,
      `${bucket.aBatches}`,
      `${bucket.meanALower} / ${bucket.meanAUpper}<br>宽 ${bucket.meanWidth}`,
      `${bucket.minALower} … ${bucket.maxAUpper}`,
      `<b>${bucket.withinPct}%</b> (${bucket.withinCount})`,
      `${bucket.intersectsPct}% (${bucket.intersectsCount})`,
      `易 ${bucket.abovePct}% / 难 ${bucket.belowPct}%`,
      `${bucket.degeneratePct}%`,
    ]))

  const pressureRows = (strategy) => result.options.arms.map((id) => {
    const row = byArm(id, strategy)
    const allR = row.strata.reduce((sum, stratum) => sum + (stratum.r.mean || 0) * stratum.batches, 0) / (row.batchesDealt || 1)
    const allJump = row.strata.reduce((sum, stratum) => sum + (stratum.jumpRealised.mean || 0) * stratum.batches, 0) / (row.batchesDealt || 1)
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `${round(allR, 4)}`,
      `${round(allJump, 4)}`,
      `${row.fallback.applies ? `${row.fallback.pressureJumpExceeded} (${round((row.fallback.pressureJumpExceeded / (row.batchesDealt || 1)) * 100, 1)}%)` : '—'}`,
      Object.entries(row.phaseCounts).map(([phase, count]) => `${escape(phase)}:${count}`).join(' '),
    ]
  })

  const phasePressureRows = (strategy) => result.options.arms.flatMap((id) => {
    const row = byArm(id, strategy)
    if (!row) return []
    return Object.entries(row.pressureByPhase).map(([phase, entry]) => [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      escape(phase),
      `[${entry.target.join(', ')}]`,
      `${entry.batches}`,
      `${entry.jump.p50} / ${entry.jump.p95}`,
      `${entry.jump.mean}`,
      `${entry.withinTargetPct}% (${entry.withinTargetCount})`,
    ])
  })

  const reachabilityBlock = (() => {
    const structural = result.reachability.filter((entry) => entry.kind === 'structural')
    const smallSample = result.reachability.filter((entry) => entry.kind === 'none-inside-small-sample')
    const rarelyMet = result.reachability.filter((entry) => entry.kind === 'rarely-met')
    return `<h3>结构性不可达（每一批都从同一侧错过目标）</h3>${
      structural.length
        ? `<ul>${structural.map((entry) => `<li><b>${escape(entry.arm)} / ${escape(entry.strategy)} / T${entry.tier} ${escape(entry.phase)}</b>：目标 [${entry.target.join(', ')}]，${entry.batches} 批全部落内 ${entry.withinCount} 次 —— ${escape(entry.detail)}。</li>`).join('')}</ul>`
        : '<p>本次样本内没有出现"每一批都从同一侧错过"的桶。这不等于目标可达：见下一节。</p>'
    }<h3>目标命中率偏低（可达但很少真正落内）</h3>${
      rarelyMet.length
        ? `<ul>${rarelyMet.map((entry) => `<li><b>${escape(entry.arm)} / ${escape(entry.strategy)} / T${entry.tier} ${escape(entry.phase)}</b>：目标 [${entry.target.join(', ')}] —— ${escape(entry.detail)}。区间退化占比 ${entry.degeneratePct}%。</li>`).join('')}</ul>`
        : '<p>没有低于 50% 命中率的桶。</p>'
    }<h3>样本太小，不作结构性断言</h3>${
      smallSample.length
        ? `<ul>${smallSample.map((entry) => `<li><b>${escape(entry.arm)} / ${escape(entry.strategy)} / T${entry.tier} ${escape(entry.phase)}</b>：目标 [${entry.target.join(', ')}] —— ${escape(entry.detail)}。</li>`).join('')}</ul>`
        : '<p>无。</p>'
    }`
  })()

  const sections = result.options.strategies.map((strategy) => `<section><h2>策略：${escape(strategy)}</h2>
<p>${escape(STRATEGIES[strategy].description)}</p>
<h3>主结果</h3>
${table(['组', '局数', '自然结束率 [模拟95% Wilson区间]', 'P50 步', 'P95 步', 'P99 步', 'KM 中位步数', '截断均值（全体）', '到上限未结束', '达到的最高 tier'], mainRows(strategy))}
<h3>生存曲线（Kaplan-Meier，上限 ${result.options.stepCap} 步处行政删失）</h3>
<p>曲线是"到第 t 步仍在进行"的比例；删失的局在上限处退出风险集，不当作死亡。</p>
${survivalChart(pooled, result.options, strategy)}
${table(['组', '步数', '生存率'], pooled.filter((row) => row.strategy === strategy).flatMap((row) => row.survival.milestones.map((point) => [`<span style="color:${ARM_COLOR[row.arm]}">${escape(row.arm)}</span>`, `${point.step}`, `${point.survivalPct}%`])))}
<h3>tier 分层（0–29 / 30–59 / 60–89 / 90+）：A 区间、R、实际达标率</h3>
<p>A 越高越<b>容易</b>。盲发牌不产生 A 区间（没有搜索），因此 A 列显示"—"，但 R 与 ΔR 对所有臂都可用。达标率 = 该分层内 A 区间<b>完全落进</b>目标区间的批次占比。</p>
${table(['组', '分层', '批数', '有 A 的批数', 'A 均值 lower/upper（观测范围）', '实际达标率', 'R_before P50/P95', '实测 ΔR P50/P95', '按阶段的批数与达标率'], strataRows(strategy))}
<h3>求解器：根节点有解率 / UNKNOWN / 构造兜底 / 目标不可达</h3>
<p>"根节点有解率" = 本工具在每一批的到手手牌上跑 solveHand（nodeBudget=${BUDGET.nodesPerHand}）判为 SOLVABLE 的批次占比；盲臂也测，所以六个臂口径一致。目标不可达率 = 该批 A 区间与目标区间<b>完全不相交</b>的批次占比。</p>
${table(['组', '探针批数', '根节点有解率', 'UNKNOWN 率', '无解率', '构造兜底率', '目标不可达率', '候选 proven/unknown/dropped', '每批被丢弃候选数'], solverRows(strategy))}
<h3>handNoFullContinuation 与 boardNoFullContinuation（两件不同的事，分开记）</h3>
<p>前者是<b>这一手牌</b>没有完整 3 步续接，后者是<b>整个形状池</b>在当前盘面上没有完整续接。第三列是本工具独立探针给出的同一事实（六个臂统一口径）。</p>
${table(['组', '发牌器 handNoFullContinuation', '发牌器 boardNoFullContinuation', '探针：整手无完整续接率', '探针 UNKNOWN 率'], noContRows(strategy))}
<h3>卡住诊断：剩余形状 / 上一批是否有 witness / 何时离开可完成路径</h3>
<p>"离开可完成路径多少步"的定义：${escape(result.design.traceDefinition)}</p>
${table(['组', '卡住局数', '上一批有完整 witness', '离开可完成路径步数 P50/P95', '卡住时剩余形状 Top5', '最近五步安全性判定', '最近五步机动性 P50/P95', '最近五步 R P50/P95'], stuckRows(strategy))}
<h3>卡住前最近五步轨迹（逐偏移）：渐进收紧还是单步骤降</h3>
<p>偏移 1 = 卡住前的最后一步。<b>偏移 1 的"不可续接"是构造性的</b>——卡住的定义就是此刻无路可走，所以它恒为 0% 可续接，不携带信息。要看的是从偏移 5 到偏移 2 的走势：若这四步的可续接率逐步下降，是<b>渐进收紧</b>；若偏移 5/4 仍高、偏移 2 骤降，是<b>单步骤降</b>。最后一列"手牌已用尽"是必要的干扰项：某一步正好是该批最后一块时，剩余手牌为空，续接问题无从谈起，此时既不是"安全"也不是"危险"。</p>
${table(['组', '偏移', '样本', 'R P50', '机动性 P50', '剩余手牌可完整续接', '不可续接', 'UNKNOWN', '手牌已用尽'], traceRows(strategy))}
<h3>形状：真实出场占比 / 同形重复 / Block 9 冷却命中</h3>
<p>冷却窗口按<b>实测手牌</b>定义：某一批之前 ${BATCH_RULES.block9CooldownBatches} 批内真的出过 Block 9 时，这一批处于窗口内；窗口内没有再出 Block 9 = 命中。C 组把冷却一直武装着，所以它按实测根本不会开出窗口（0 个窗口），这是实验性杠杆的直接结果，不是"100% 命中"。</p>
${table(['组', 'Block 9 实测占比', 'Block 9 基础占比', 'Line 4 实测占比', 'Line 4 基础占比', '单批同形最大数', '单批 Block 9 最大数', '冷却窗口数', '冷却命中率', '窗口内违规', '与上一批完全同形'], shapeRows(strategy))}
<h3>搜索：耗时 / 节点 / witness 回放失败（必须为零）</h3>
${table(['组', '发牌耗时 ms P50/P95/P99', '节点 P50/P95/P99', '每批平均节点', 'SOLVABLE 批数', '已回放', '回放失败', 'witness 不满 3 步', '总批数'], searchRows(strategy))}
<h3>回退（仅棋盘感知发牌有搜索）</h3>
<p>注意 <code>fallbackSteps</code> 是<b>混合列表</b>：<code>relaxed-pressure</code> / <code>relaxed-tolerance</code> 是真正的降级阶梯，而 <code>same-as-previous</code> 与 <code>relaxed-same-shape</code> 是每批都会追加的<b>信息标签</b>，不是回退。两者分开统计。</p>
${table(['组', '回退率', '回退批/有指标批', '终止原因 fallback', '真实降级阶梯', '信息标签（非回退）', '只放宽压力 / 两者都放宽'], fallbackRows(strategy))}
<h3>容差区间 [A_lower, A_upper]：落在目标内 vs 仅相交</h3>
${table(['组', 'tier / 阶段', '目标区间', '批数', '均值 A_lower / A_upper（宽）', '观测 min…max', '完全落在目标内', '仅相交', '偏离方向', '区间退化占比'], toleranceRows(strategy))}
<h3>压力 R（实测：发牌前 / 本批打完后）</h3>
${table(['组', '平均 R_before', '平均实测 ΔR', `ΔR > ${PRESSURE_MAX_JUMP}`, '阶段批数构成'], pressureRows(strategy))}
<h3>压力跳变按阶段对照目标（§8.2）</h3>
${table(['组', '阶段', '目标 ΔR', '批数', '实测 ΔR P50/P95', '实测 ΔR 均值', '落在目标区间内'], phasePressureRows(strategy))}
</section>`).join('')

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${headline}</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#233;background:#faf9f5;max-width:1180px;margin:32px auto;padding:0 18px}table{border-collapse:collapse;font-size:13px;width:100%}td,th{border:1px solid #ccc;padding:7px;text-align:left;vertical-align:top}section{margin-top:36px}h2{border-top:2px solid #ddd;padding-top:14px}code{overflow-wrap:anywhere}.warn{background:#fff4e5;border-left:4px solid #db8a08;padding:10px 14px}.ok{background:#eaf7ee;border-left:4px solid #23925c;padding:10px 14px}</style>
<h1>${headline}</h1>
<div class="warn">
<p><b>诚实性声明（先读这一段）：</b></p>
<ul>
<li>这里跑的是 <b>机器人</b>，不是经过真人校准的水平分层；<b>全程没有任何真人试玩</b>。</li>
<li><code>random</code> 在全部合法落点里均匀随机，<b>不是新手</b>；<code>clear</code> 是确定性的立即消除优先；<code>noise</code> 是"典型玩家"的<b>启发式代理</b>；<code>lookahead</code> 是<b>有界单步贪心</b>（前 ${LOOKAHEAD_BRANCHES} 个落点 + 机动性），<b>不是求解器，也不是 P2 的跨批规划</b>。</li>
<li>步数上限 ${result.options.stepCap}：达到上限仍在可放的局是<b>右删失</b>。生存曲线用 Kaplan-Meier 在上限处做行政删失，删失数量逐格列出；<b>全体均值是删失统计量</b>，表里同时给出只统计自然结束局的均值。</li>
<li>Wilson 区间只表达<b>这些机器人</b>下的蒙特卡洛抽样不确定性，<b>不包含</b>模型误差，也不是真人的置信区间。</li>
<li>样本量：<b>每格 ${result.options.games} 局 × ${result.options.seeds.length} 个种子</b>，共 ${result.sample.games} 局。这是<b>分阶段样本</b>，不是规格 §12.1 的"每臂每策略 3 种子 × 每种子 200 局"（14400 局）完整计划；不要用几十局去断言因果。</li>
<li>机器人<b>不使用道具</b>（开局四种充能清零）。因此 §12.2 的<b>道具三项在本口径下不适用</b>，报告里写"不适用"而不是编数字。缓存命中、过时结果丢弃、P2 指标同理。</li>
<li><b>不是单因子的配对一律标注"不可用于归因"</b>；C→F 是规格 §12.4.1 指定的公平对照，A 组的不同形状池不能代替它。</li>
</ul>
</div>
<div class="${result.witnessReplay.pass ? 'ok' : 'warn'}">
<p><b>witness 回放（§12.2/§12.3，必须为零）：</b>已回放 <b>${result.witnessReplay.solvableBatchesReplayed}</b> 个 SOLVABLE 批次的 witness，失败 <b>${result.witnessReplay.failures}</b> 次。${result.witnessReplay.pass ? '通过。' : '<b style="color:#b00">未通过——这是一个 bug，不是难度结论。</b>'}</p>
</div>
${result.sample.note ? `<div class="warn"><p><b>运行方式（影响怎么读数字）：</b>${escape(result.sample.note)}</p></div>` : ''}
<h2>臂定义（规格 §12.1 的 A–F）</h2>
${table(['臂', '形状池', '发牌方式', '可抽槽位'], designRows)}
<h3>基础抽样占比（仅权重表本身，未经任何过滤）</h3>
${table(['臂', 'Line 4', 'Block 9', '权重总和', '可抽槽位'], shareRows)}
<p>${escape(result.design.block9WeightZero)}</p>
<h2>配对：每个配对只动一个因子</h2>
${table(['配对', '隔离的因子', '是否单因子', '按策略的差值（后 − 前）'], pairRows)}
<h2>目标可达性发现</h2>
<p>目标区间是"首步容差" A：A 越高越容易。若某个 (tier, 阶段) 下<b>每一批</b>的区间都整体高于目标上界，那么该目标在该棋盘密度下<b>结构上不可达</b>——这不是可以"修"的东西，是本报告要如实指出的事实。</p>
${reachabilityBlock}
${sections}
<h2>本工具不测什么（明确列出，避免误读）</h2>
${table(['项目', '状态', '原因'], Object.entries(result.notApplicable).map(([key, entry]) => [escape(key), escape(entry.status), escape(entry.why)]))}
<h2>复现</h2><code>${escape(result.command)}</code>
${result.shards ? `<p>本次是<b>多分片并行</b>运行后合并的：${result.shards.map((shard) => `<code>${escape(shard.command)}</code>（${shard.games} 局）`).join('、')}。</p>` : ''}
<p>源码 SHA256、全部参数、逐臂逐策略逐种子统计在 <code>tools/results/deal-experiments.summary.json</code>；逐局原始记录（每局一条紧凑聚合，不是逐批明细）写到 %TEMP%，<b>不进仓库</b>。发牌参数版本 ${escape(DEAL_CONFIG_VERSION)}。</p>
</html>`
}

// ---------------------------------------------------------------------------
// Console table
// ---------------------------------------------------------------------------
function printTable(result) {
  const pooled = result.pooled
  for (const strategy of result.options.strategies) {
    console.log(`\n=== strategy: ${strategy} ===`)
    console.log('arm  games  ended%   95%CI          p50  p95  KMmed  mean*  censored  rootSolv%  probeNoCont%  B9slot%  witnessFail')
    for (const id of result.options.arms) {
      const row = pooled.find((entry) => entry.arm === id && entry.strategy === strategy)
      if (!row) continue
      const b9 = row.shapeShares.find((share) => share.name === 'Block 9')
      console.log([
        id.padEnd(4),
        String(row.games).padStart(5),
        `${row.endedPct}%`.padStart(7),
        `[${row.endedCi95.join(',')}]`.padStart(14),
        String(row.stepsAll.p50).padStart(4),
        String(row.stepsAll.p95).padStart(4),
        String(row.survival.kmMedianSteps ?? '-').padStart(5),
        String(row.meanStepsCensored).padStart(6),
        String(row.censored).padStart(9),
        `${row.solver.rootSolvablePct}`.padStart(9),
        `${row.noContinuation.probeHandNoFullContinuationPct}`.padStart(12),
        `${b9 ? b9.sharePct : 0}%`.padStart(8),
        String(row.witness.replayFailures).padStart(11),
      ].join(' '))
    }
    console.log('  mean* = censored mean over all games; censored = still playable at the cap; KMmed = Kaplan-Meier median steps')
    console.log('  tier strata (A interval / R / target-hit):')
    for (const id of result.options.arms) {
      const row = pooled.find((entry) => entry.arm === id && entry.strategy === strategy)
      if (!row) continue
      for (const stratum of row.strata) {
        if (!stratum.batches) continue
        console.log(`    ${id} T${stratum.tier} ${stratum.label.padEnd(6)} batches=${String(stratum.batches).padStart(5)} A=${stratum.aBatches ? `${stratum.meanALower}/${stratum.meanAUpper}` : 'n/a'} hit=${stratum.aBatches ? `${stratum.targetHitPct}%` : 'n/a'} R p50=${stratum.r.p50} p95=${stratum.r.p95} dR p50=${stratum.jumpRealised.p50}`)
      }
    }
  }

  console.log('\n=== required contrasts (§12.1 / §12.4.1) ===')
  for (const pair of result.pairs) {
    const flag = pair.single ? '' : '  [TWO FACTORS — NOT usable for attribution]'
    console.log(`  ${pair.id}${pair.headline ? '  (HEADLINE FAIR CONTROL)' : ''}${flag}`)
    console.log(`      factor: ${pair.factor}`)
    for (const delta of pair.deltas) {
      if (!delta) continue
      console.log(`      ${delta.strategy.padEnd(10)} ended ${delta.endedPctDelta > 0 ? '+' : ''}${delta.endedPctDelta}pp  p50 ${delta.stepsP50Delta > 0 ? '+' : ''}${delta.stepsP50Delta}  KMmed ${delta.kmMedianDelta === null ? 'n/a' : (delta.kmMedianDelta > 0 ? '+' : '') + delta.kmMedianDelta}  meanR ${delta.meanRDelta > 0 ? '+' : ''}${delta.meanRDelta}  probeNoCont ${delta.probeHandNoFullContinuationPctDelta === null ? 'n/a' : (delta.probeHandNoFullContinuationPctDelta > 0 ? '+' : '') + delta.probeHandNoFullContinuationPctDelta + 'pp'}`)
    }
  }

  console.log(`\nwitness replay: ${result.witnessReplay.solvableBatchesReplayed} SOLVABLE batches replayed, ${result.witnessReplay.failures} failures (must be 0) -> ${result.witnessReplay.pass ? 'PASS' : 'FAIL'}`)
  console.log(`sample: ${result.sample.games} games (${result.options.arms.length} arms x ${result.options.strategies.length} strategies x ${result.options.seeds.length} seeds x ${result.options.games}); spec plan would be 14400 -> this is a STAGED sample`)
  if (result.reachability.length) {
    console.log('\n=== target-reachability findings ===')
    for (const entry of result.reachability) {
      console.log(`  [${entry.kind}] ${entry.arm}/${entry.strategy} T${entry.tier} ${entry.phase} target [${entry.target.join(', ')}] — ${entry.withinCount}/${entry.batches} inside; ${entry.detail}`)
    }
  } else {
    console.log('\n=== target-reachability findings ===\n  none in this sample')
  }
  console.log(`opening-board pairing check: ${result.openingBoardCheck.gamesWhereArmsDisagreeOnOpeningCellCount} of ${result.openingBoardCheck.pairedGamesChecked} paired games disagree on opening cell count (must be 0)`)
  if (result.latencyVerdict) {
    const v = result.latencyVerdict
    console.log(`deal latency (real-game boards, session.deal()): p50 ${v.worstP50}ms p95 ${v.worstP95}ms p99 ${v.worstP99}ms max ${v.worstMax}ms`)
    console.log(`  spec §11.2: p95 <= 150ms -> ${v.p95InsideBudget ? 'PASS' : 'FAIL'}; no task over 50ms -> ${v.medianInside50ms ? 'PASS' : 'FAIL (median already above 50ms)'}`)
  }
  console.log('\nnot applicable in this harness: item metrics (§12.2, items-off convention), cache-hit counts, stale-result counts, all P2 metrics.')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function writeOutputs(result, outBase) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT, outBase)), { recursive: true })
  const summaryPath = path.resolve(ROOT, `${outBase}.summary.json`)
  const htmlPath = path.resolve(ROOT, `${outBase}.html`)
  fs.writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`)
  fs.writeFileSync(htmlPath, htmlReport(result))
  return { summaryPath, htmlPath }
}

function runShard(options, startedAt) {
  const tables = Object.fromEntries(options.arms.map((id) => [id, blindTable(ARMS[id])]))
  const games = []
  const totalGames = options.arms.length * options.strategies.length * options.seeds.length * options.games
  process.stdout.write(`deal-experiments: ${totalGames} games (${options.arms.length} arms × ${options.strategies.length} strategies × ${options.seeds.length} seeds × ${options.games}), cap ${options.stepCap}\n`)

  for (const armId of options.arms) {
    const arm = ARMS[armId]
    for (const strategyId of options.strategies) {
      const cellStarted = Date.now()
      for (const seed of options.seeds) {
        for (let i = 0; i < options.games; i += 1) {
          const gameIndex = options.gameOffset + i
          games.push(runGame({ arm, strategyId, seed, gameIndex, stepCap: options.stepCap, table: tables[armId] }))
        }
      }
      const cellGames = games.filter((game) => game.arm === armId && game.strategy === strategyId)
      const cell = aggregateGroup(cellGames, { arm: armId, strategy: strategyId, stepCap: options.stepCap })
      process.stdout.write(`  ${armId}/${strategyId}: ${cell.games} games, ended ${cell.endedPct}%, censored ${cell.censored}, p50 ${cell.stepsAll.p50}, kmMed ${cell.survival.kmMedianSteps}, ${((Date.now() - cellStarted) / 1000).toFixed(1)}s\n`)
    }
  }

  const command = `node tools/deal-experiments.mjs ${process.argv.slice(2).join(' ')}`
  const result = buildResult({ games, options, command, shards: null, startedAt })
  const rawPath = path.resolve(ROOT, options.raw)
  fs.mkdirSync(path.dirname(rawPath), { recursive: true })
  fs.writeFileSync(rawPath, `${JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), options, games }, null, 0)}\n`)
  result.rawPath = options.raw
  return { result, rawPath }
}

function mergeShards(options, startedAt) {
  const games = []
  const shards = []
  const armSet = new Set()
  const strategySet = new Set()
  const seedSet = new Set()
  // The per-cell sample size is DERIVED from the raw records rather than copied from a shard's
  // options: a cell can be split across shards (--game-offset) so that the expensive
  // board-aware cells do not serialise the whole run, and each shard then only knows its own
  // half. Deriving it keeps the reported sample size honest after a split.
  const perCell = new Map()
  let stepCap = options.stepCap
  for (const file of options.merge) {
    const summary = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'))
    const rawPath = path.resolve(ROOT, summary.rawPath || summary.options.raw)
    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'))
    games.push(...raw.games)
    for (const game of raw.games) {
      armSet.add(game.arm)
      strategySet.add(game.strategy)
      seedSet.add(game.seed)
      const key = `${game.arm}|${game.strategy}|${game.seed}`
      perCell.set(key, (perCell.get(key) || 0) + 1)
    }
    stepCap = summary.options.stepCap
    shards.push({
      command: summary.command,
      games: raw.games.length,
      arms: summary.options.arms,
      strategies: summary.options.strategies,
      seeds: summary.options.seeds,
      gamesPerCell: summary.options.games,
      gameOffset: summary.options.gameOffset || 0,
      rawPath: summary.rawPath,
    })
  }
  const gamesPerCell = Math.max(0, ...[...perCell.values()])
  const merged = {
    ...options,
    arms: ARM_ORDER.filter((id) => armSet.has(id)),
    strategies: STRATEGY_ORDER.filter((id) => strategySet.has(id)),
    seeds: [...seedSet].sort((a, b) => a - b),
    stepCap,
    games: gamesPerCell,
    gameOffset: 0,
    merge: null,
  }
  const result = buildResult({
    games,
    options: merged,
    command: `node tools/deal-experiments.mjs --merge=${options.merge.join(',')} --out=${options.out}`,
    shards,
    startedAt,
  })
  result.rawPath = shards.map((shard) => shard.rawPath).join(', ')
  return { result, rawPath: null }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()

  if (options.merge) {
    const { result } = mergeShards(options, startedAt)
    const { summaryPath, htmlPath } = writeOutputs(result, options.out.replace(/\.json$/i, ''))
    printTable(result)
    console.log(`\nmerged ${result.sample.games} games from ${result.shards.length} shards`)
    console.log(`wrote ${path.relative(ROOT, summaryPath)}, ${path.relative(ROOT, htmlPath)}`)
    console.log(`elapsed ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    return
  }

  const { result, rawPath } = runShard(options, startedAt)
  const { summaryPath, htmlPath } = writeOutputs(result, options.out.replace(/\.json$/i, ''))
  printTable(result)
  console.log(`\nwrote ${path.relative(ROOT, summaryPath)}, ${path.relative(ROOT, htmlPath)}; raw per-game JSON -> ${rawPath}`)
  console.log(`elapsed ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack); process.exitCode = 1 })
}

export {
  ARMS, PAIRS, STRATEGIES, aggregateGroup, blindTable, buildResult, htmlReport, parseArgs, runGame, survivalOf, wilson,
}

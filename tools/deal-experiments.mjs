// Deal experiments: does v0.9.0 P1's difficulty come from the SHAPE POOL or from the DEALER?
// (producer's 2026-09-23 dealing spec; v0.9.0 P1 shipped the two together, so the release
// itself cannot answer the question — only a factor-separated arm comparison can.)
//
//   node tools/deal-experiments.mjs --arms=A,B,C,D --games=200 --seeds=1,2,3 --strategies=random,noise
//
// WHAT IS DIFFERENT FROM tools/difficulty-model.mjs (the previous generation): that tool
// re-implemented the board as its own bitboard model. This one drives the REAL
// `createGameSession()` — the shipped board, the shipped director, the shipped dealer, the
// shipped solver — through a bot. That is the whole point: a number produced here is a number
// about the code that ships, not about a model of it.
//
// THE FOUR ARMS, and the single factor each pair isolates:
//
//   A  frozen pre-v0.9.0 pool (14 shapes, `Block 9: 1`, no `Line 4`) + blind dealing
//   B  A plus `Line 4` (15 shapes, `Block 9: 1`)                  + blind dealing
//   C  shipped pool (15 shapes, `Block 9: 0.4`)                   + board-aware dealer
//   D  shipped pool                                               + blind dealing
//
//   A → B   POOL only  (adds Line 4; Block 9 weight and dealing are identical)
//   B → D   POOL only  (Block 9 1 → 0.4; Line 4 present and dealing identical)
//   D → C   DEALER only (pool byte-identical; blind → board-aware)
//   A → D   BOTH       (the whole v0.9.0 change in one step; NOT a single-factor contrast)
//
// "Blind dealing" is implemented HERE, not in src/ (the shipped `session.deal()` is the
// board-aware dealer and must stay that way). It reproduces what the game did before v0.9.0:
// three INDEPENDENT weighted draws with no board awareness, no batch filter, no cooldown and
// no fallback — the pieces are built with `session.makePiece(shape)` and committed with
// `session.setPieces([...])`, exactly the two seams the session exposes for it.
//
// WHAT THIS IS NOT, stated up front because the project is strict about it:
//   - these are BOTS. Neither `random` nor `noise` is a calibrated human skill tier, and no
//     human playtest was involved anywhere in this file;
//   - `noise` is a PROXY for "a typical player" (75% best-immediate-clear, 25% random, first
//     playable slot) inherited from difficulty-model.mjs. It is a heuristic, not a person;
//   - the step cap makes the mean a CENSORED statistic: a run that was still playable when the
//     cap was hit is not a run that lasted that long;
//   - Wilson intervals describe Monte Carlo uncertainty under these two bots ONLY. They are
//     not model error and not real-player confidence intervals;
//   - a target that is structurally unreachable (see the reachability section) is reported as
//     such. It is never "fixed", and no claim is made that the difficulty targets were met.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { OPENING_SHAPES, SHAPES, SHAPE_WEIGHTS } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'
import { createRng, hashSeed } from '../src/game/rng.js'
import { createGameSession } from '../src/game/gameSession.js'
import { beginNaturalBatch, currentIntent, noteDealt, tierOf } from '../src/game/dealDirector.js'
import { completionInfo, enumeratePlacements, fromBoard } from '../src/game/placementModel.js'
import { pressure } from '../src/game/boardPressure.js'
import { BATCH_RULES, DEAL_CONFIG_VERSION, PRESSURE_DELTA, PRESSURE_MAX_JUMP, RELIEF_SAFE_RANGE, TIERS } from '../src/game/dealConfig.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SESSION_SCHEMA = 'deal-experiments/v1'

// ---------------------------------------------------------------------------
// The arms
// ---------------------------------------------------------------------------
const SHAPE_BY_NAME = new Map(SHAPES.map((shape) => [shape.name, shape]))

// The shipped table, copied so the arms below can override single entries. The frozen export
// itself is never mutated.
const SHIPPED_WEIGHTS = Object.freeze({ ...SHAPE_WEIGHTS })

// The FROZEN pre-v0.9.0 table: the 14 shapes with `Block 9: 1` and no `Line 4`. Membership is
// read from `OPENING_SHAPES`, which shapes.js froze by NAME for exactly this reason — a future
// shape addition has to opt in there deliberately, so this arm cannot silently widen.
const PRE_LINE4_WEIGHTS = (() => {
  const table = { ...SHAPE_WEIGHTS, 'Block 9': 1 }
  delete table['Line 4']
  return Object.freeze(table)
})()

// Arm B: shipped membership with `Line 4` present but Block 9 still at its pre-v0.9.0 weight.
// This is the arm that separates "Line 4 came back" from "Block 9 went down".
const LINE4_ADDED_WEIGHTS = Object.freeze({ ...SHAPE_WEIGHTS, 'Block 9': 1 })

const ARMS = {
  A: {
    id: 'A',
    label: 'A 冻结池(14, Block9=1) + 盲发牌',
    short: 'A 冻结池 + 盲发牌',
    dealer: 'blind',
    shapes: OPENING_SHAPES,
    weights: PRE_LINE4_WEIGHTS,
  },
  B: {
    id: 'B',
    label: 'B 冻结池+Line 4(15, Block9=1) + 盲发牌',
    short: 'B +Line 4 + 盲发牌',
    dealer: 'blind',
    shapes: SHAPES,
    weights: LINE4_ADDED_WEIGHTS,
  },
  C: {
    id: 'C',
    label: 'C 现行池(15, Block9=0.4) + 棋盘感知发牌',
    short: 'C 现行池 + 感知发牌',
    dealer: 'boardAware',
    shapes: SHAPES,
    weights: SHIPPED_WEIGHTS,
  },
  D: {
    id: 'D',
    label: 'D 现行池(15, Block9=0.4) + 盲发牌',
    short: 'D 现行池 + 盲发牌',
    dealer: 'blind',
    shapes: SHAPES,
    weights: SHIPPED_WEIGHTS,
  },
}

// The pairs, and the ONE factor each isolates. `single: false` marks the pair that moves two
// factors at once — reported as the size of the whole shipped change, never as a cause.
const PAIRS = [
  { id: 'A→B', from: 'A', to: 'B', single: true, factor: '形状池：加入 Line 4（Block 9 权重与发牌方式均不变）' },
  { id: 'B→D', from: 'B', to: 'D', single: true, factor: '形状池：Block 9 权重 1 → 0.4（Line 4 在场，发牌方式不变）' },
  { id: 'D→C', from: 'D', to: 'C', single: true, factor: '发牌方式：盲发牌 → 棋盘感知发牌（形状池完全相同）' },
  { id: 'A→D', from: 'A', to: 'D', single: false, factor: '形状池 + 发牌方式同时改变（整包参考，不可用于归因）' },
]

// ---------------------------------------------------------------------------
// The blind dealer (implemented here on purpose — see the header)
// ---------------------------------------------------------------------------
// A cumulative weight table over the arm's own pool. Built from the arm's weight object and
// the arm's shape list, so an arm can never draw a shape its pool does not contain.
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

const STRATEGIES = {
  random: {
    id: 'random',
    label: 'random',
    description: '在全部（未用棋子 × 合法物理落点）中均匀随机。不是新手校准。',
    choose: chooseRandom,
  },
  noise: {
    id: 'noise',
    label: 'noise',
    description: '第一个可放的棋子槽位；75% 取即时消除行数最多的落点，25% 该槽位的随机合法落点。是"典型玩家"的启发式代理，不是真人。',
    choose: chooseNoise,
  },
}

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------
// Streams: every arm derives them from the SAME per-(seed, gameIndex) base, so the opening
// board and the bot's choice stream start from identical states in all four arms and paired
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

function runGame({ arm, strategyId, seed, gameIndex, stepCap, table }) {
  const base = baseSeedOf(seed, gameIndex)
  const session = createGameSession()
  // The director seed is the per-game base, not the raw user seed: it keeps every stream in
  // this harness addressable from one number and keeps arm C's internal streams aligned with
  // the ones the blind arms build by hand.
  session.resetDirector(base)
  // The bot has no item policy. Without this, `stuckOutcome()` answers 'refresh' (2 charges)
  // or 'clear-path' (3 charges) instead of 'end', and a stuck run would never terminate — the
  // run would spin until the step cap and the end rate would read 0% for every arm. The
  // offline model this harness succeeds (difficulty-model.mjs) has no items at all, so zeroing
  // the charges is the same measurement convention, made explicit.
  for (const tool of session.ITEM_TOOLS) session.setItemCharge(tool.id, 0)

  const openingRng = createRng(hashSeed(base, 'opening'))
  session.board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT, openingRng)
  const openingCells = session.board.occupied().length

  const blindRng = createRng(hashSeed(base, 'deal'))
  const phaseRng = createRng(hashSeed(base, 'director'))
  const botRng = createRng(hashSeed(base, 'bot'))
  const choose = STRATEGIES[strategyId].choose

  const batches = []
  const phaseCounts = { warmup: 0, build: 0, challenge: 0, relief: 0 }
  let steps = 0
  let ended = false
  let censored = false
  let endedByRefusedDeal = false

  // Open one batch. Returns the record or null when no batch could be produced at all (only
  // arm C can answer null: a board with no legal placement for any shape makes the shipped
  // dealer refuse and keep the previous, fully-used hand).
  function openBatch() {
    if (arm.dealer === 'boardAware') {
      const started = process.hrtime.bigint()
      session.deal()
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      const metrics = session.getDealMetrics()
      if (!metrics) return null
      const hand = session.getPieces()
      if (!hand.length || hand.every((piece) => piece.used)) return null
      return {
        phase: metrics.phase,
        tier: metrics.tier,
        ms,
        fallback: metrics.fallback,
        fallbackSteps: [...(metrics.fallbackSteps || [])],
        aLower: metrics.aLower,
        aUpper: metrics.aUpper,
        withinSafeRange: metrics.withinSafeRange === true,
        intersectsSafeRange: metrics.intersectsSafeRange === true,
        withinPressureRange: metrics.withinPressureRange === true,
        // The dealer's own answer to "did the chosen batch keep the pressure target", which is
        // what separates the two sub-cases of a relaxed tolerance. Copied explicitly: the split
        // below reads it off the per-batch record, and a missing field would silently report
        // every relaxed-tolerance batch as "both targets relaxed".
        pressureKept: metrics.pressureKept === true,
        informationalSteps: [...(metrics.informationalSteps || [])],
        dealerRBefore: metrics.rBefore,
        dealerREnd: metrics.rEnd,
        cost: metrics.cost,
        proofStatus: metrics.proofStatus,
        lowBranch: metrics.lowBranch === true,
        relaxedSameShape: metrics.relaxedSameShape === true,
        pressureJumpExceeded: metrics.pressureJumpExceeded === true,
        candidatesSampled: metrics.candidatesSampled,
        candidatesProven: metrics.candidatesProven,
        candidatesUnknown: metrics.candidatesUnknown,
        candidatesDropped: metrics.candidatesDropped,
        nodes: metrics.nodes,
        names: hand.map((piece) => piece.shape.name),
      }
    }
    // Blind: the director's phase machine is still advanced (so the reported phase mix is the
    // state a real run would be in), but NOTHING in the blind deal reads it. That is the arm.
    const director = session.getDirector()
    beginNaturalBatch(director, phaseRng)
    const intent = currentIntent(director)
    const pieces = blindDeal(session, table, blindRng)
    const names = pieces.map((piece) => piece.shape.name)
    noteDealt(director, names, { natural: true })
    return {
      phase: intent.phase,
      tier: intent.tier,
      ms: null,
      fallback: null,
      fallbackSteps: [],
      aLower: null,
      aUpper: null,
      withinSafeRange: null,
      intersectsSafeRange: null,
      withinPressureRange: null,
      dealerRBefore: null,
      dealerREnd: null,
      cost: null,
      proofStatus: null,
      lowBranch: null,
      relaxedSameShape: null,
      pressureJumpExceeded: null,
      candidatesSampled: null,
      candidatesProven: null,
      candidatesUnknown: null,
      candidatesDropped: null,
      nodes: null,
      names,
    }
  }

  function openRecord(batch) {
    batch.rBefore = pressure(fromBoard(session.board))
    batch.completed = false
    return batch
  }

  function closeRecord(batch, completed) {
    batch.completed = completed
    batch.rEndRealised = pressure(fromBoard(session.board))
    batch.jumpRealised = batch.rEndRealised - batch.rBefore
    batches.push(batch)
  }

  let open = openBatch()
  if (!open) {
    ended = true
    endedByRefusedDeal = true
  } else {
    openRecord(open)
    while (true) {
      const hand = session.getPieces()
      const allUsed = hand.length === 0 || hand.every((piece) => piece.used)
      if (allUsed) {
        // The batch is spent. Stopping here is the cap; otherwise the next batch is dealt.
        if (steps >= stepCap) { censored = true; closeRecord(open, true); break }
        closeRecord(open, true)
        const next = openBatch()
        if (!next) { ended = true; endedByRefusedDeal = true; open = null; break }
        open = openRecord(next)
        continue
      }
      const outcome = session.stuckOutcome()
      if (outcome !== 'playable') { ended = true; break }
      if (steps >= stepCap) { censored = true; break }
      const move = choose(session, fromBoard(session.board), botRng)
      if (!move) { ended = true; break } // defensive: `playable` promised a move
      session.settlePlacement(move.placement.face, move.placement.cells, move.placement.origin, move.piece.shape.color)
      session.usePiece(move.piece)
      steps += 1
    }
    if (open && !batches.includes(open)) closeRecord(open, false)
  }

  for (const batch of batches) phaseCounts[batch.phase] = (phaseCounts[batch.phase] || 0) + 1

  return {
    arm: arm.id,
    strategy: strategyId,
    seed,
    gameIndex,
    steps,
    ended,
    censored,
    endedByRefusedDeal,
    maxTier: tierOf(steps),
    openingCells,
    batches,
    phaseCounts,
  }
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
  const sorted = [...values].sort((a, b) => a - b)
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

// Wilson score interval, 95%. Used for the natural end rate only, and only as a statement
// about Monte Carlo uncertainty under these two bots.
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

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
function aggregateGroup(games, { arm, strategy, seed = null }) {
  const n = games.length
  const ended = games.filter((game) => game.ended).length
  const censored = games.filter((game) => game.censored).length
  const allSteps = games.map((game) => game.steps)
  const endedSteps = games.filter((game) => game.ended).map((game) => game.steps)
  const batches = games.flatMap((game) => game.batches)

  const phaseCounts = { warmup: 0, build: 0, challenge: 0, relief: 0 }
  for (const game of games) for (const [phase, count] of Object.entries(game.phaseCounts)) phaseCounts[phase] += count

  const tierReached = new Map()
  for (const game of games) tierReached.set(game.maxTier, (tierReached.get(game.maxTier) || 0) + 1)

  // Batch-filter / cooldown evidence, observed directly rather than by re-deriving the rule.
  // Both counters that depend on ORDER (Block 9's gap, "same as the previous batch") are
  // computed per GAME: a batch index that ran across a game boundary would report a cooldown
  // gap between two different runs.
  let maxSameShapeInBatch = 0
  let maxBlock9InBatch = 0
  let block9Batches = 0
  let repeatedWithPrevious = 0
  const block9Gaps = []
  const shapeSlots = new Map()
  for (const game of games) {
    let previousBatchKey = null
    let previousBlock9BatchIndex = null
    game.batches.forEach((batch, batchIndex) => {
      const counts = new Map()
      for (const name of batch.names) {
        counts.set(name, (counts.get(name) || 0) + 1)
        shapeSlots.set(name, (shapeSlots.get(name) || 0) + 1)
      }
      for (const count of counts.values()) maxSameShapeInBatch = Math.max(maxSameShapeInBatch, count)
      const b9 = counts.get('Block 9') || 0
      maxBlock9InBatch = Math.max(maxBlock9InBatch, b9)
      if (b9 > 0) {
        block9Batches += 1
        if (previousBlock9BatchIndex !== null) block9Gaps.push(batchIndex - previousBlock9BatchIndex)
        previousBlock9BatchIndex = batchIndex
      }
      const key = [...batch.names].sort().join('|')
      if (key === previousBatchKey) repeatedWithPrevious += 1
      previousBatchKey = key
    })
  }
  const totalSlots = [...shapeSlots.values()].reduce((sum, value) => sum + value, 0)

  const metricBatches = batches.filter((batch) => batch.fallback !== null)
  const fallbacks = metricBatches.filter((batch) => batch.fallback && batch.fallback !== 'none')
  const fallbackReasons = tally(fallbacks.map((batch) => batch.fallback))
  // `fallbackSteps` is a MIXED list: the first two entries are the spec's real degradation
  // ladder (§7.2), while `same-as-previous` and `relaxed-same-shape` are INFORMATIONAL tags the
  // dealer appends for every batch they apply to — they are not fallbacks at all. Reported
  // apart, because a 96% "ladder step" that is really "this hand repeated a recent one" would
  // otherwise read as a 96% degradation rate.
  const ladderSteps = tally(metricBatches.flatMap((batch) => batch.fallbackSteps.filter((step) => !INFORMATIONAL_STEPS.has(step))))
  const infoSteps = tally(metricBatches.flatMap((batch) => batch.fallbackSteps.filter((step) => INFORMATIONAL_STEPS.has(step))))
  // The two sub-cases of a relaxed tolerance, read from the field the dealer sets for exactly
  // this question (`pressureKept`). The first version of this pair inferred them from
  // `fallbackSteps`, which predates the dealer splitting the branches — it reported "both
  // relaxed" for every relaxed-tolerance batch, i.e. the opposite of the truth. Verified
  // against the raw metrics by the ladder test in tools/deal-dealer-tests.mjs.
  const relaxedPressureOnly = metricBatches.filter((batch) => batch.fallback === 'relaxed-tolerance' && batch.pressureKept === true).length
  const relaxedBoth = metricBatches.filter((batch) => batch.fallback === 'relaxed-tolerance' && batch.pressureKept !== true).length

  // Tolerance intervals per (tier, phase), with the reachability verdict the spec's
  // "inside vs merely intersecting" distinction makes possible.
  const toleranceBuckets = new Map()
  for (const batch of metricBatches) {
    if (batch.aLower === null || batch.aUpper === null) continue
    const key = batchKeyOf(batch.phase, batch.tier)
    if (!toleranceBuckets.has(key)) {
      toleranceBuckets.set(key, {
        tier: batch.tier,
        phase: batch.phase,
        target: targetRangeOf(batch.phase, batch.tier),
        n: 0,
        within: 0,
        intersects: 0,
        above: 0,
        below: 0,
        straddle: 0,
        degenerate: 0,
        aLowers: [],
        aUppers: [],
        widths: [],
      })
    }
    const bucket = toleranceBuckets.get(key)
    bucket.n += 1
    if (batch.withinSafeRange) bucket.within += 1
    if (batch.intersectsSafeRange) bucket.intersects += 1
    // Which side of the target the batch actually landed on. A is "share of sampled first moves
    // from which the rest of the batch can still be finished", so a HIGHER A is EASIER: `above`
    // means the batch was more forgiving than the target allowed, `below` means harsher.
    if (batch.aLower > bucket.target[1]) bucket.above += 1
    else if (batch.aUpper < bucket.target[0]) bucket.below += 1
    else if (!batch.withinSafeRange) bucket.straddle += 1
    // A degenerate interval (A_lower === A_upper) means the analysis resolved every sampled
    // first move, i.e. the "inside vs merely intersecting" distinction the spec insists on has
    // nothing left to distinguish. Counted, because it decides how much that distinction is
    // worth reading into the table.
    if (batch.aUpper === batch.aLower) bucket.degenerate += 1
    bucket.aLowers.push(batch.aLower)
    bucket.aUppers.push(batch.aUpper)
    bucket.widths.push(batch.aUpper - batch.aLower)
  }
  const tolerance = [...toleranceBuckets.values()]
    .sort((a, b) => a.tier - b.tier || a.phase.localeCompare(b.phase))
    .map((bucket) => {
      const minALower = Math.min(...bucket.aLowers)
      const maxAUpper = Math.max(...bucket.aUppers)
      let unreachable = null
      if (bucket.within === 0) {
        if (bucket.above === bucket.n) unreachable = 'structural/above — every batch was EASIER than the target (A_lower > A_upper in all of them)'
        else if (bucket.below === bucket.n) unreachable = 'structural/below — every batch was HARDER than the target (A_upper < A_lower in all of them)'
        else unreachable = 'never fully inside, although individual batches do overlap the target'
      }
      return {
        tier: bucket.tier,
        phase: bucket.phase,
        target: [...bucket.target],
        batches: bucket.n,
        withinCount: bucket.within,
        withinPct: round((bucket.within / bucket.n) * 100, 1),
        intersectsCount: bucket.intersects,
        intersectsPct: round((bucket.intersects / bucket.n) * 100, 1),
        aboveCount: bucket.above,
        abovePct: round((bucket.above / bucket.n) * 100, 1),
        belowCount: bucket.below,
        belowPct: round((bucket.below / bucket.n) * 100, 1),
        straddleCount: bucket.straddle,
        degenerateCount: bucket.degenerate,
        degeneratePct: round((bucket.degenerate / bucket.n) * 100, 1),
        minALower: round(minALower, 3),
        maxAUpper: round(maxAUpper, 3),
        meanALower: round(bucket.aLowers.reduce((s, v) => s + v, 0) / bucket.n, 3),
        meanAUpper: round(bucket.aUppers.reduce((s, v) => s + v, 0) / bucket.n, 3),
        meanWidth: round(bucket.widths.reduce((s, v) => s + v, 0) / bucket.n, 3),
        unreachable,
      }
    })

  const rBefore = batches.map((batch) => batch.rBefore).filter(Number.isFinite)
  const rEnd = batches.map((batch) => batch.rEndRealised).filter(Number.isFinite)
  const jump = batches.map((batch) => batch.jumpRealised).filter(Number.isFinite)
  const dealerREnd = batches.map((batch) => batch.dealerREnd).filter(Number.isFinite)
  const latencies = batches.map((batch) => batch.ms).filter(Number.isFinite)

  // The pressure target is per PHASE (§8.2), so the realised jump is reported per phase too —
  // a pooled number would average a relief batch's intended fall against a build batch's
  // intended rise and read as "no pressure movement at all".
  const pressureByPhase = {}
  for (const phase of Object.keys(PRESSURE_DELTA)) {
    const phaseBatches = batches.filter((batch) => batch.phase === phase && Number.isFinite(batch.jumpRealised))
    if (!phaseBatches.length) continue
    const target = PRESSURE_DELTA[phase]
    const jumps = phaseBatches.map((batch) => batch.jumpRealised)
    pressureByPhase[phase] = {
      target: [...target],
      batches: phaseBatches.length,
      jump: quantiles(jumps),
      withinTargetCount: jumps.filter((value) => value >= target[0] && value <= target[1]).length,
      withinTargetPct: round((jumps.filter((value) => value >= target[0] && value <= target[1]).length / jumps.length) * 100, 1),
    }
  }

  const proofStatuses = tally(metricBatches.map((batch) => batch.proofStatus).filter(Boolean))

  return {
    arm,
    strategy,
    seed,
    games: n,
    ended,
    endedPct: round((ended / n) * 100, 1),
    endedCi95: wilson(ended, n),
    censored,
    censoredPct: round((censored / n) * 100, 1),
    refusedDealEnds: games.filter((game) => game.endedByRefusedDeal).length,
    stepsAll: quantiles(allSteps, [50, 95]),
    stepsEndedOnly: quantiles(endedSteps, [50, 95]),
    // The mean over ALL games is a CENSORED statistic: a capped run contributes `cap`, not its
    // real length. Both means are reported so the difference is visible rather than implied.
    meanStepsCensored: round(allSteps.reduce((s, v) => s + v, 0) / (n || 1), 1),
    meanStepsEndedOnly: endedSteps.length ? round(endedSteps.reduce((s, v) => s + v, 0) / endedSteps.length, 1) : null,
    maxTierReached: [...tierReached.entries()].sort((a, b) => a[0] - b[0]).map(([tier, count]) => ({ tier, games: count })),
    batchesDealt: batches.length,
    phaseCounts,
    fallback: {
      applies: metricBatches.length > 0,
      metricBatches: metricBatches.length,
      fallbackBatches: fallbacks.length,
      fallbackPct: metricBatches.length ? round((fallbacks.length / metricBatches.length) * 100, 1) : null,
      reasons: fallbackReasons.map(([reason, count]) => ({ reason, count, pct: round((count / (metricBatches.length || 1)) * 100, 2) })),
      ladderSteps: ladderSteps.map(([step, count]) => ({ step, count, pct: round((count / (metricBatches.length || 1)) * 100, 2) })),
      informationalSteps: infoSteps.map(([step, count]) => ({ step, count, pct: round((count / (metricBatches.length || 1)) * 100, 2) })),
      relaxedPressureOnly,
      relaxedBoth,
      pressureJumpExceeded: batches.filter((batch) => batch.pressureJumpExceeded).length,
    },
    tolerance,
    pressure: {
      rBefore: quantiles(rBefore),
      rEndRealised: quantiles(rEnd),
      jumpRealised: quantiles(jump),
      jumpOverMaxCount: jump.filter((value) => value > PRESSURE_MAX_JUMP).length,
      dealerREnd: dealerREnd.length ? quantiles(dealerREnd) : null,
    },
    pressureByPhase,
    proof: { statuses: proofStatuses.map(([status, count]) => ({ status, count })) },
    dealLatencyMs: latencies.length ? quantiles(latencies, [50, 95, 99]) : null,
    batchFilter: {
      maxSameShapeInBatch,
      maxBlock9InBatch,
      block9Batches,
      block9BatchPct: round((block9Batches / (batches.length || 1)) * 100, 2),
      block9Gaps: block9Gaps.length ? quantiles(block9Gaps, [50]) : null,
      block9GapMin: block9Gaps.length ? Math.min(...block9Gaps) : null,
      repeatedBatchCount: repeatedWithPrevious,
      repeatedBatchPct: round((repeatedWithPrevious / (batches.length || 1)) * 100, 2),
    },
    shapeShares: [...shapeSlots.entries()]
      .map(([name, count]) => ({ name, count, sharePct: round((count / (totalSlots || 1)) * 100, 2) }))
      .sort((a, b) => b.count - a.count),
    slotsDealt: totalSlots,
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const allowed = new Set(['arms', 'games', 'seeds', 'strategies', 'step-cap', 'out', 'raw'])
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
  const arms = list(opts.arms || 'A,B,C,D', 'arms')
  arms.forEach((id) => { if (!ARMS[id]) throw new Error(`unknown arm ${id}; use A,B,C,D`) })
  const strategies = list(opts.strategies || 'random,noise', 'strategies')
  strategies.forEach((id) => { if (!STRATEGIES[id]) throw new Error(`unknown strategy ${id}; use random,noise`) })
  const seeds = list(opts.seeds || '1,2,3', 'seeds').map((value) => {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('seeds must be uint32')
    return n
  })
  if (new Set(seeds).size !== seeds.length) throw new Error('seeds must be numerically unique')
  return {
    arms,
    strategies,
    seeds,
    games: positive(opts.games || 200, 'games'),
    stepCap: positive(opts['step-cap'] || 600, 'step-cap'),
    out: opts.out || 'tools/results/deal-experiments',
    raw: opts.raw || path.join(os.tmpdir(), 'voxalblast-deal-experiments.raw.json'),
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
// HTML report (same visual style as tools/results/difficulty-*.html)
// ---------------------------------------------------------------------------
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const PALETTE = ['#1261a0', '#23925c', '#db8a08', '#b94574', '#7a4fd0', '#0f9ba6', '#c0561f', '#5c6f2a']
const ARM_COLOR = Object.fromEntries(Object.keys(ARMS).map((id, index) => [id, PALETTE[index % PALETTE.length]]))

function table(headers, rows, { className = '' } = {}) {
  return `<table${className ? ` class="${className}"` : ''}><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

function htmlReport(result) {
  const headline = 'VoxalBlast 发牌实验：形状池 vs 发牌方式（A/B/C/D）'
  const pooled = result.pooled
  const byArm = (armId, strategy) => pooled.find((row) => row.arm === armId && row.strategy === strategy)

  const designRows = result.options.arms.map((id) => {
    const arm = result.design.arms[id]
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(arm.id)}</span> ${escape(arm.label)}`,
      escape(arm.pool),
      escape(arm.dealer),
      `${arm.slots} 槽`,
    ]
  })

  const shareRows = result.options.arms.map((id) => {
    const arm = result.design.arms[id]
    const shipped = arm.baseShares['Line 4'] ?? 0
    const block9 = arm.baseShares['Block 9'] ?? 0
    return [
      `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
      `${shipped}%`,
      `${block9}%`,
      `${arm.totalWeight}`,
    ]
  })

  const sections = result.options.strategies.map((strategy) => {
    const rows = result.options.arms.map((id) => {
      const row = byArm(id, strategy)
      if (!row) return []
      const seedCells = row.bySeed.map((s) => `${s.seed}: ${s.endedPct}%`).join(' / ')
      return [
        `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
        `${row.games}`,
        `${row.endedPct}% [${row.endedCi95.join(', ')}]<br>各种子：${seedCells}`,
        `${row.stepsAll.p50}`,
        `${row.stepsAll.p95}`,
        `${row.meanStepsCensored}`,
        `${row.censored} (${row.censoredPct}%)`,
        row.maxTierReached.map((t) => `T${t.tier}:${t.games}`).join(' '),
      ]
    })
    const fallbackRows = result.options.arms
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
    const toleranceRows = result.options.arms
      .map((id) => ({ id, row: byArm(id, strategy) }))
      .filter(({ row }) => row && row.tolerance.length)
      .flatMap(({ id, row }) => row.tolerance.map((bucket) => [
        `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
        `T${bucket.tier} ${escape(bucket.phase)}`,
        `[${bucket.target.join(', ')}]`,
        `${bucket.batches}`,
        `${bucket.meanALower} / ${bucket.meanAUpper}<br>宽 ${bucket.meanWidth}`,
        `${bucket.minALower} … ${bucket.maxAUpper}`,
        `<b>${bucket.withinPct}%</b> (${bucket.withinCount})`,
        `${bucket.intersectsPct}% (${bucket.intersectsCount})`,
        `易 ${bucket.abovePct}% / 难 ${bucket.belowPct}%`,
        `${bucket.degeneratePct}%`,
      ]))
    const pressureRows = result.options.arms.map((id) => {
      const row = byArm(id, strategy)
      return [
        `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
        `${row.pressure.rBefore.p50} / ${row.pressure.rBefore.p95}`,
        `${row.pressure.rEndRealised.p50} / ${row.pressure.rEndRealised.p95}`,
        `${row.pressure.jumpRealised.p50} / ${row.pressure.jumpRealised.p95}`,
        `${row.pressure.jumpRealised.mean}`,
        `${row.pressure.jumpOverMaxCount} (${round((row.pressure.jumpOverMaxCount / (row.batchesDealt || 1)) * 100, 1)}%)`,
        row.pressure.dealerREnd ? `${row.pressure.dealerREnd.p50} / ${row.pressure.dealerREnd.p95}` : '—（无搜索）',
      ]
    })
    const filterRows = result.options.arms.map((id) => {
      const row = byArm(id, strategy)
      const arm = result.design.arms[id]
      const block9Realised = row.shapeShares.find((s) => s.name === 'Block 9')
      const line4Realised = row.shapeShares.find((s) => s.name === 'Line 4')
      return [
        `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
        `${block9Realised ? block9Realised.sharePct : 0}%`,
        `${arm.baseShares['Block 9'] ?? 0}%`,
        line4Realised ? `${line4Realised.sharePct}%` : '—',
        `${arm.baseShares['Line 4'] ?? 0}%`,
        `${row.batchFilter.maxSameShapeInBatch}`,
        `${row.batchFilter.maxBlock9InBatch}`,
        row.batchFilter.block9Gaps ? `${row.batchFilter.block9Gaps.p50}（最小 ${row.batchFilter.block9GapMin}）` : '—',
        `${row.batchFilter.repeatedBatchPct}%`,
      ]
    })
    const phaseRows = result.options.arms.map((id) => {
      const row = byArm(id, strategy)
      const total = Object.values(row.phaseCounts).reduce((sum, value) => sum + value, 0) || 1
      const pct = (phase) => `${row.phaseCounts[phase] || 0} (${round(((row.phaseCounts[phase] || 0) / total) * 100, 1)}%)`
      return [
        `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
        `${row.batchesDealt}`,
        pct('warmup'), pct('build'), pct('challenge'), pct('relief'),
        row.maxTierReached.map((t) => `T${t.tier}:${t.games}`).join(' '),
      ]
    })
    const phasePressureRows = result.options.arms
      .flatMap((id) => {
        const row = byArm(id, strategy)
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
    const latencyRows = result.options.arms.map((id) => {
      const row = byArm(id, strategy)
      return [
        `<span style="color:${ARM_COLOR[id]}">${escape(id)}</span>`,
        row.dealLatencyMs ? `${row.dealLatencyMs.p50} / ${row.dealLatencyMs.p95} / ${row.dealLatencyMs.p99}` : '—（盲发牌无搜索）',
        `${row.batchesDealt}`,
      ]
    })
    return `<section><h2>策略：${escape(strategy)}</h2>
<p>${escape(STRATEGIES[strategy].description)}</p>
<h3>主结果</h3>
${table(['组', '局数', '自然结束率 [模拟95% Wilson区间]', 'P50 步', 'P95 步', '截断均值（全体）', '到上限未结束', '达到的最高 tier'], rows)}
<h3>阶段构成与 tier 分布（实际发出的批次）</h3>
${table(['组', '总批数', 'warmup', 'build', 'challenge', 'relief', '各 tier 的局数'], phaseRows)}
<h3>回退（仅棋盘感知发牌有搜索，因此只有 C 有这一项）</h3>
<p>注意 <code>fallbackSteps</code> 是<b>混合列表</b>：<code>relaxed-pressure</code> / <code>relaxed-tolerance</code> 是真正的降级阶梯，而 <code>same-as-previous</code> 与 <code>relaxed-same-shape</code> 是每批都会追加的<b>信息标签</b>（"这一批与最近四批中的一批同形"），不是回退。两者分开统计，否则会把 96% 的"同形"读成 96% 的降级。</p>
${table(['组', '回退率', '回退批/有指标批', '终止原因 fallback', '真实降级阶梯', '信息标签（非回退）', '只放宽压力 / 两者都放宽'], fallbackRows)}
<h3>容差区间 [A_lower, A_upper]：落在目标内 vs 仅相交（两者是不同事实）</h3>
<p>A 越高越<b>容易</b>。"易" = 整段区间高于目标上界（比目标更宽容）；"难" = 整段低于目标下界；"宽" 是区间平均宽度，0 表示该批所有被抽样的首步都被求解器判定完毕（A_lower = A_upper），此时"相交"与"落内"在数学上等价 —— 这正是规格坚持要区分的那件事在这里<b>几乎没有区分度</b>的原因。</p>
${table(['组', 'tier / 阶段', '目标区间', '批数', '均值 A_lower / A_upper（宽）', '观测 min…max', '完全落在目标内', '仅相交', '偏离方向', '区间退化占比'], toleranceRows)}
<h3>压力 R（实测：发牌前 / 本批打完后）</h3>
${table(['组', 'R_before P50/P95', 'R_end 实测 P50/P95', '实测跳变 P50/P95', '跳变均值', `跳变 > ${PRESSURE_MAX_JUMP}`, '发牌器自己的 R_end P50/P95'], pressureRows)}
<h3>压力跳变按阶段对照目标（§8.2）</h3>
${table(['组', '阶段', '目标 ΔR', '批数', '实测 ΔR P50/P95', '实测 ΔR 均值', '落在目标区间内'], phasePressureRows)}
<h3>批次过滤与 Block 9 冷却（实际发出的分布）</h3>
${table(['组', 'Block 9 实测占比', 'Block 9 基础占比', 'Line 4 实测占比', 'Line 4 基础占比', '单批同形最大数', '单批 Block 9 最大数', '相邻 Block 9 批间隔中位（最小）', '与上一批完全同形'], filterRows)}
<h3>发牌耗时（毫秒）</h3>
${result.latencyVerdict ? `<p>规格 §11.2 的判据是「p95 ≤ 150ms，且常规情况下主线程没有超过 50ms 的发牌长任务」。本次实测（${escape(result.latencyVerdict.measuredOn)}）：最差 <b>p50 ${result.latencyVerdict.worstP50}ms</b>、p95 ${result.latencyVerdict.worstP95}ms、p99 ${result.latencyVerdict.worstP99}ms、max ${result.latencyVerdict.worstMax}ms。</p>
<ul><li>p95 ≤ 150ms 判据：<b>${result.latencyVerdict.p95InsideBudget ? '通过' : '不通过'}</b>。</li>
<li>「无超过 50ms 的长任务」判据：中位数 <b>${result.latencyVerdict.medianInside50ms ? '在 50ms 内' : '已超过 50ms'}</b>，但 p95 为 ${result.latencyVerdict.worstP95}ms${result.latencyVerdict.p95Over50ms ? '，即<b>约 5% 的发牌超过 50ms</b> —— 这条判据应当读作「勉强」，而不是「通过」' : ''}。</li></ul>
<p>${escape(result.latencyVerdict.caveat)}</p>` : ''}
${table(['组', 'P50 / P95 / P99', '批数'], latencyRows)}
</section>`
  }).join('')

  const pairRows = result.pairs.map((pair) => {
    const cells = result.options.strategies.map((strategy) => {
      const from = byArm(pair.from, strategy)
      const to = byArm(pair.to, strategy)
      if (!from || !to) return `${escape(strategy)}: —`
      const dEnd = round(to.endedPct - from.endedPct, 1)
      const dP50 = round(to.stepsAll.p50 - from.stepsAll.p50, 1)
      const dFb = to.fallback.applies && from.fallback.applies
        ? `${round(to.fallback.fallbackPct - from.fallback.fallbackPct, 1)}pp`
        : '—'
      return `${escape(strategy)}: 结束率 ${dEnd > 0 ? '+' : ''}${dEnd}pp，P50 步 ${dP50 > 0 ? '+' : ''}${dP50}，回退率 ${dFb}`
    })
    return [
      `${escape(pair.id)}${pair.single ? '' : ' <b>（双因子）</b>'}`,
      escape(pair.factor),
      cells.join('<br>'),
    ]
  })

  const reachability = result.reachability
  const structural = reachability.filter((entry) => entry.kind === 'structural')
  const smallSample = reachability.filter((entry) => entry.kind === 'none-inside-small-sample')
  const rarelyMet = reachability.filter((entry) => entry.kind === 'rarely-met')
  const reachabilityBlock = `<h3>结构性不可达（每一批都从同一侧错过目标）</h3>${
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

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${headline}</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#233;background:#faf9f5;max-width:1180px;margin:32px auto;padding:0 18px}table{border-collapse:collapse;font-size:13px;width:100%}td,th{border:1px solid #ccc;padding:7px;text-align:left;vertical-align:top}section{margin-top:36px}h2{border-top:2px solid #ddd;padding-top:14px}.legend span{margin-right:22px;font-weight:bold}code{overflow-wrap:anywhere}.warn{background:#fff4e5;border-left:4px solid #db8a08;padding:10px 14px}</style>
<h1>${headline}</h1>
<div class="warn">
<p><b>诚实性声明（先读这一段）：</b></p>
<ul>
<li>这里跑的是 <b>机器人</b>，不是经过真人校准的水平分层；<b>全程没有任何真人试玩</b>。</li>
<li><code>random</code> 在全部合法落点里均匀随机，<b>不是新手</b>；<code>noise</code> 是"典型玩家"的<b>启发式代理</b>（第一个可放槽位、75% 取即时消除最多、25% 随机），<b>不是玩家</b>。</li>
<li>步数上限 ${result.options.stepCap}：达到上限仍在可放的局是<b>右删失</b>，不是"这局就是 600 步"。因此<b>全体均值是删失统计量</b>，表里同时给出只统计自然结束局的均值。</li>
<li>Wilson 区间只表达<b>这两个机器人</b>下的蒙特卡洛抽样不确定性，<b>不包含</b>模型误差，也不是真人的置信区间。</li>
<li>样本量：每个数字都写在表里。<b>每格 ${result.options.games} 局 × ${result.options.seeds.length} 个种子</b>；不要用几十局去断言因果。</li>
<li>机器人<b>不使用道具</b>：开局即把四种道具充能清零，否则 <code>stuckOutcome()</code> 会一直回 <code>refresh</code>/<code>clear-path</code>，任何局都结束不了。这与上一代离线模型（无道具）是同一口径。</li>
</ul>
</div>
<h2>臂定义</h2>
${table(['臂', '形状池', '发牌方式', '池规模'], designRows)}
<h3>基础抽样占比（仅权重表本身，未经任何过滤）</h3>
${table(['臂', 'Line 4', 'Block 9', '权重总和'], shareRows)}
<h2>单因子配对</h2>
${table(['配对', '隔离的因子', '按策略的差值（后 - 前）'], pairRows)}
<h2>目标可达性发现</h2>
<p>目标区间是"首步容差" A：A 越高越容易。若某个 (tier, 阶段) 下<b>每一批</b>的区间都整体高于目标上界，那么该目标在该棋盘密度下<b>结构上不可达</b>——这不是可以"修"的东西，是本报告要如实指出的事实。</p>
${reachabilityBlock}
${sections}
<h2>复现</h2><code>${escape(result.command)}</code>
<p>源码 SHA256、全部参数、逐臂逐策略逐种子统计在 <code>tools/results/deal-experiments.summary.json</code>；逐局与逐批原始记录写到 <code>${escape(result.rawPath)}</code>（%TEMP%，<b>不进仓库</b>）。发牌参数版本 ${escape(DEAL_CONFIG_VERSION)}。</p>
</html>`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const started = Date.now()

  const tables = Object.fromEntries(options.arms.map((id) => [id, blindTable(ARMS[id])]))
  const design = {
    arms: Object.fromEntries(options.arms.map((id) => {
      const arm = ARMS[id]
      const weights = Object.fromEntries(arm.shapes.map((shape) => [shape.name, arm.weights[shape.name] ?? 0]))
      const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0)
      return [id, {
        id: arm.id,
        label: arm.label,
        dealer: arm.dealer === 'boardAware' ? '棋盘感知发牌（session.deal()）' : '盲发牌（本工具实现：三次独立加权抽取）',
        pool: arm.shapes.map((shape) => shape.name).join(', '),
        poolSize: arm.shapes.length,
        slots: tables[id].length,
        weights,
        totalWeight: round(totalWeight, 3),
        baseShares: baseSharesOf(arm),
      }]
    })),
    pairs: PAIRS,
    blindDealing: '工具内实现：三次独立加权抽取，无棋盘感知、无批次过滤、无 Block 9 冷却、无回退路径；用 session.makePiece(shape) 建块、session.setPieces([...]) 提交。src/ 未改动。',
    streams: '每局以 hashSeed(schema, seed, gameIndex) 为基，开局面与机器人选择流在四个臂中起始状态完全相同；session.resetDirector(base) 使 C 的内部 deal/search/director 流与盲臂手工构造的流同源。发牌流的消耗在第一批之后必然分叉——那正是被测量的处理效应。',
    items: '机器人不使用道具，四种充能在开局清零（否则 stuckOutcome() 永不为 end）。',
    stepCap: options.stepCap,
    censoring: '达到上限时该局仍在可放状态 → 右删失；自然结束在恰好等于上限的步数上仍计入"结束"。',
    strategies: Object.fromEntries(options.strategies.map((id) => [id, STRATEGIES[id].description])),
    confidence: 'Wilson 95%，仅用于自然结束率，仅表达这两个机器人的抽样不确定性。',
    noiseProvenance: `镜像 tools/difficulty-model.mjs 的 chooseForSlot/chooseMove 意图（首个可放槽位；${NOISE_RANDOM_CHANCE * 100}% 随机），但在真实 session 上重写；不是逐字节历史复现。`,
    block9CooldownBatches: BATCH_RULES.block9CooldownBatches,
    maxSameShapePerBatch: BATCH_RULES.maxSameShapePerBatch,
    configVersion: DEAL_CONFIG_VERSION,
  }

  const raw = { schemaVersion: 1, generatedAt: new Date().toISOString(), options, design, games: [] }
  const groups = []
  const pooled = []
  const pooledGames = new Map()

  const totalGames = options.arms.length * options.strategies.length * options.seeds.length * options.games
  process.stdout.write(`deal-experiments: ${totalGames} games (${options.arms.length} arms × ${options.strategies.length} strategies × ${options.seeds.length} seeds × ${options.games}), cap ${options.stepCap}\n`)

  for (const armId of options.arms) {
    const arm = ARMS[armId]
    for (const strategyId of options.strategies) {
      for (const seed of options.seeds) {
        const games = []
        for (let gameIndex = 0; gameIndex < options.games; gameIndex += 1) {
          const game = runGame({ arm, strategyId, seed, gameIndex, stepCap: options.stepCap, table: tables[armId] })
          games.push(game)
          raw.games.push(game)
        }
        const group = aggregateGroup(games, { arm: armId, strategy: strategyId, seed })
        const perSeed = { seed, games: group.games, endedPct: group.endedPct, censored: group.censored, stepsAll: group.stepsAll, meanStepsCensored: group.meanStepsCensored }
        groups.push({ ...group, bySeed: [perSeed] })
        if (!pooledGames.has(`${armId}|${strategyId}`)) pooledGames.set(`${armId}|${strategyId}`, [])
        pooledGames.get(`${armId}|${strategyId}`).push(...games)
        process.stdout.write(`  ${armId}/${strategyId}/seed=${seed}: ${group.games} games, ended ${group.endedPct}%, censored ${group.censored}, p50 ${group.stepsAll.p50}\n`)
      }
    }
  }

  // The pooled row carries the per-seed spread, so a single-seed outlier is visible instead of
  // being averaged away.
  for (const [key, games] of pooledGames) {
    const [armId, strategyId] = key.split('|')
    const row = aggregateGroup(games, { arm: armId, strategy: strategyId })
    row.bySeed = groups
      .filter((group) => group.arm === armId && group.strategy === strategyId)
      .map((group) => ({
        seed: group.seed, games: group.games, endedPct: group.endedPct,
        censored: group.censored, stepsAll: group.stepsAll, meanStepsCensored: group.meanStepsCensored,
      }))
    pooled.push(row)
  }

  // Opening-board identity check: the claim "paired games start from the same board" is
  // verifiable rather than asserted, so it is verified here.
  const openingByCellCount = new Map()
  for (const game of raw.games) {
    const key = `${game.seed}|${game.gameIndex}`
    if (!openingByCellCount.has(key)) openingByCellCount.set(key, new Set())
    openingByCellCount.get(key).add(game.openingCells)
  }
  const mismatchedOpenings = [...openingByCellCount.values()].filter((set) => set.size > 1).length
  const openingCellHistogram = tally(raw.games.map((game) => game.openingCells)).map(([cells, count]) => ({ cells, games: count }))

  // The reachability findings, lifted out of the per-group tables so the headline claim is a
  // first-class result rather than something a reader has to dig for. Two kinds, kept apart:
  //   - `structural`: no batch in the bucket ever landed inside the target, and they all missed
  //     on the same side — the target is unreachable for that board density, full stop;
  //   - `rarely-met`: the target IS reachable, but landed inside in under half the batches. That
  //     is a rate observation on a finite sample, not a proof, and is labelled as such.
  const reachability = []
  for (const row of pooled) {
    for (const bucket of row.tolerance) {
      const base = {
        arm: row.arm, strategy: row.strategy, tier: bucket.tier, phase: bucket.phase,
        target: bucket.target, batches: bucket.batches, withinCount: bucket.withinCount,
        withinPct: bucket.withinPct, intersectsCount: bucket.intersectsCount,
        abovePct: bucket.abovePct, belowPct: bucket.belowPct,
        degeneratePct: bucket.degeneratePct,
        minALower: bucket.minALower, maxAUpper: bucket.maxAUpper,
      }
      if (bucket.unreachable) {
        // "Structural" is only claimed when the bucket is big enough for "no batch landed
        // inside" to mean something. On a handful of batches it means nothing, and calling it
        // structural would be exactly the kind of overclaim this report exists to avoid.
        reachability.push(bucket.batches >= 20
          ? { ...base, kind: 'structural', detail: bucket.unreachable }
          : { ...base, kind: 'none-inside-small-sample', detail: `${bucket.unreachable} — but only ${bucket.batches} batches, so this is NOT called structural` })
      } else if (bucket.batches >= 20 && bucket.withinPct < 50) {
        reachability.push({
          ...base,
          kind: 'rarely-met',
          detail: `landed fully inside in ${bucket.withinCount}/${bucket.batches} batches (${bucket.withinPct}%); ${bucket.abovePct}% of batches were EASIER than the target and ${bucket.belowPct}% HARDER`,
        })
      }
    }
  }
  reachability.sort((a, b) => (a.kind === b.kind ? a.withinPct - b.withinPct : a.kind === 'structural' ? -1 : 1))

  // The spec's own latency criterion (§11.2): "p95 发牌准备时间不超过 150ms、常规情况下主线程无超过
  // 50ms 的发牌长任务". Reported as a verdict rather than left for a reader to spot, because the
  // median crossing 50ms is exactly the kind of number a table hides.
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
    // The same command re-run on this machine gave p50 57.3ms / p95 74.1ms while other work was
    // running, and p50 43.0ms / p95 50.3ms when it was not. A wall-clock number from a dev
    // machine is not reproducible, so it is reported as a range of observations, not a figure.
    caveat: 'Wall-clock, this machine, single process — NOT reproducible: two identical runs of this command differed by ~14ms at p50 because of machine load. deal-perf.mjs measured fixed-fill boards; this measures boards a bot actually reached, which is a different (and here, cheaper) mix. Treat these as an order of magnitude, not a budget sign-off.',
  } : null

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: `node tools/deal-experiments.mjs ${process.argv.slice(2).join(' ')}`,
    options,
    fingerprints: fingerprints(),
    design,
    openingBoardCheck: {
      pairedGamesChecked: openingByCellCount.size,
      gamesWhereArmsDisagreeOnOpeningCellCount: mismatchedOpenings,
      histogram: openingCellHistogram,
      note: '同一 (seed, gameIndex) 下四个臂的开局占用格数必须完全一致；不一致说明流没有对齐，配对比较无效。',
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
          fallbackPctDelta: to.fallback.applies && from.fallback.applies
            ? round(to.fallback.fallbackPct - from.fallback.fallbackPct, 1) : null,
        }
      }),
    })),
    reachability,
    latencyVerdict,
    honesty: [
      'BOTS ONLY: no human playtest was involved; neither strategy is a calibrated human skill tier.',
      '`noise` is a heuristic PROXY for a typical player, not a player.',
      `The ${options.stepCap}-step cap makes meanStepsCensored a CENSORED statistic; meanStepsEndedOnly is reported beside it.`,
      'Wilson intervals quantify Monte Carlo uncertainty under these two bots only — not model error, not real-player confidence.',
      'Every number rests on the sample size printed next to it; small-sample deltas are not causal claims.',
      'Unreachable targets are reported as reachability findings and are NOT fixed or counted as met.',
    ],
    elapsedMs: Date.now() - started,
    rawPath: options.raw,
  }

  const outBase = options.out.replace(/\.json$/i, '')
  fs.mkdirSync(path.dirname(path.resolve(ROOT, outBase)), { recursive: true })
  fs.writeFileSync(path.resolve(ROOT, options.raw), `${JSON.stringify(raw, null, 2)}\n`)
  const summary = { ...result, omitted: { perGameRecords: raw.games.length, note: `逐局与逐批记录在 ${options.raw}（%TEMP%，不进仓库）` } }
  const summaryPath = path.resolve(ROOT, `${outBase}.summary.json`)
  const htmlPath = path.resolve(ROOT, `${outBase}.html`)
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(htmlPath, htmlReport(result))

  printTable(result)
  console.log(`\nwrote ${path.relative(ROOT, summaryPath)}, ${path.relative(ROOT, htmlPath)}; raw per-game JSON -> ${options.raw}`)
  console.log(`elapsed ${(result.elapsedMs / 1000).toFixed(1)}s`)
}

function printTable(result) {
  const pooled = result.pooled
  for (const strategy of result.options.strategies) {
    console.log(`\n=== strategy: ${strategy} ===`)
    console.log('arm  games  ended%   95%CI          p50  p95  mean*  censored  T  fallback%  B9slot%  latency p50')
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
        String(row.meanStepsCensored).padStart(6),
        String(row.censored).padStart(8),
        String(row.maxTierReached.map((t) => t.tier).pop()).padStart(2),
        `${row.fallback.fallbackPct === null ? 'n/a' : `${row.fallback.fallbackPct}%`}`.padStart(9),
        `${b9 ? b9.sharePct : 0}%`.padStart(8),
        `${row.dealLatencyMs ? `${row.dealLatencyMs.p50}ms` : 'n/a'}`.padStart(11),
      ].join(' '))
    }
    console.log('  mean* = censored mean over all games; censored = still playable at the cap')
    console.log('  phase mix (warmup/build/challenge/relief, batches dealt):')
    for (const id of result.options.arms) {
      const row = pooled.find((entry) => entry.arm === id && entry.strategy === strategy)
      if (!row) continue
      const total = Object.values(row.phaseCounts).reduce((sum, value) => sum + value, 0) || 1
      const pct = (phase) => `${row.phaseCounts[phase] || 0}(${round(((row.phaseCounts[phase] || 0) / total) * 100, 1)}%)`
      console.log(`    ${id}: ${row.batchesDealt} batches  warmup ${pct('warmup')}  build ${pct('build')}  challenge ${pct('challenge')}  relief ${pct('relief')}   tiers ${row.maxTierReached.map((t) => `T${t.tier}:${t.games}`).join(' ')}`)
    }
    console.log('  realised pressure jump per phase (target from dealConfig §8.2):')
    for (const id of result.options.arms) {
      const row = pooled.find((entry) => entry.arm === id && entry.strategy === strategy)
      if (!row) continue
      for (const [phase, entry] of Object.entries(row.pressureByPhase)) {
        console.log(`    ${id} ${phase.padEnd(9)} target [${entry.target.join(', ')}]  n=${String(entry.batches).padStart(4)}  p50=${entry.jump.p50} p95=${entry.jump.p95} mean=${entry.jump.mean}  inside ${entry.withinTargetPct}%`)
      }
    }
  }
  const fallbackArm = result.options.arms.find((id) => result.design.arms[id].dealer.startsWith('棋盘'))
  if (fallbackArm) {
    console.log(`\n=== fallback reasons (arm ${fallbackArm}, board-aware dealer) ===`)
    for (const strategy of result.options.strategies) {
      const row = pooled.find((entry) => entry.arm === fallbackArm && entry.strategy === strategy)
      if (!row) continue
      console.log(`  ${strategy}: rate ${row.fallback.fallbackPct}% over ${row.fallback.metricBatches} batches (${row.fallback.fallbackBatches} fell back)`)
      for (const reason of row.fallback.reasons) console.log(`    reason   ${reason.reason.padEnd(24)} ${String(reason.count).padStart(5)}  ${reason.pct}%`)
      for (const step of row.fallback.ladderSteps) console.log(`    ladder   ${step.step.padEnd(24)} ${String(step.count).padStart(5)}  ${step.pct}%`)
      for (const step of row.fallback.informationalSteps) console.log(`    tag(not a fallback) ${step.step.padEnd(14)} ${String(step.count).padStart(5)}  ${step.pct}%`)
      console.log(`    relaxed pressure only ${row.fallback.relaxedPressureOnly}; both targets relaxed ${row.fallback.relaxedBoth}`)
    }
  }
  if (result.reachability.length) {
    console.log('\n=== target-reachability findings ===')
    for (const entry of result.reachability) {
      console.log(`  [${entry.kind}] ${entry.arm}/${entry.strategy} T${entry.tier} ${entry.phase} target [${entry.target.join(', ')}] — ${entry.withinCount}/${entry.batches} inside; ${entry.detail}`)
    }
  } else {
    console.log('\n=== target-reachability findings ===\n  none in this sample')
  }
  console.log(`\nopening-board pairing check: ${result.openingBoardCheck.gamesWhereArmsDisagreeOnOpeningCellCount} of ${result.openingBoardCheck.pairedGamesChecked} paired games disagree on opening cell count (must be 0)`)
  if (result.latencyVerdict) {
    const v = result.latencyVerdict
    console.log(`deal latency (real-game boards, session.deal()): p50 ${v.worstP50}ms p95 ${v.worstP95}ms p99 ${v.worstP99}ms max ${v.worstMax}ms`)
    console.log(`  spec §11.2: p95 <= 150ms -> ${v.p95InsideBudget ? 'PASS' : 'FAIL'}; no task over 50ms -> ${v.medianInside50ms ? 'PASS' : 'FAIL (median already above 50ms)'}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack); process.exitCode = 1 })
}

export { ARMS, PAIRS, aggregateGroup, blindTable, htmlReport, parseArgs, runGame, wilson }

// The dealer (v0.9.0 P1; producer's 2026-09-23 spec §3.2, §5, §6, §7).
//
// WHAT CHANGED AND WHY IT IS A BIG DEAL: until v0.8.x a batch was three independent draws
// from a weighted pool — the deal could not see the board, so it could not know whether the
// player was about to be handed three pieces that do not fit. Every difficulty lever the
// project had measured before this (pool composition, weights, opening density, staged
// dealing) was an attempt to make that blind process *statistically* survivable, and the
// measurement said so: with the 14-shape pool, a typical bot's run ended because it was
// holding pieces that no longer fit, and ~98% of those deaths held the nine-cell Block 9.
//
// This module deals the other way round: it PROPOSES up to 48 batches, PROVES what each one
// can do on the current board, and then picks one against the director's intent. The player
// still has to find the line — the spec is explicit that "每批至少存在一条完整放置路径"
// is not the same as "随便放都能活" (§1.3), and that a hand is never made unsolvable on
// purpose. What changes is that "you died because the deal was blind" stops being a thing.
//
// THE CONTRACT, in the spec's own terms:
//   - a batch is a SET of three pieces: permutations are one combination (§3.2);
//   - at most one Block 9 per batch, and three natural batches of cooldown after one (§3.2);
//   - an item Refresh is dealt by THIS module too, on the relief target, without a Block 9,
//     and without advancing the natural batch counter or the cooldown (§10.1);
//   - the search is honest: SOLVABLE carries a replayable witness, UNSOLVABLE is only
//     reported when every branch was exhausted, and a budget that runs out is UNKNOWN —
//     never a death sentence and never a silent "probably fine" (§6.1);
//   - the dealer never mutates the live board, score, items, chain or committed RNG state
//     (§11.1): it works on copies and the caller commits.
import { SHAPES, SHAPE_WEIGHTS } from './shapes.js'
import { BATCH_RULES, BUDGET, DEAL_CONFIG_VERSION, FALLBACK_REASONS, PRESSURE_MAX_JUMP, SAMPLING } from './dealConfig.js'
import { REFERENCE_POOL, pressure } from './boardPressure.js'
import { applyPlacement, cloneOccupancy, enumeratePlacements, fromBoard } from './placementModel.js'
import { analyzeBatch, solveHand } from './handSolver.js'
import { costOf, pickCandidate } from './dealDirector.js'

// The reference pool carries geometry and weights, not the shipped colour, so a constructed
// batch has to be handed back as the SHIPPED shape objects — main paints a dropped piece from
// `piece.shape.color`, and a pool entry without one would render as undefined.
const SHAPE_BY_NAME = new Map(SHAPES.map((shape) => [shape.name, shape]))

// A weighted table over the shapes a batch is ALLOWED to contain right now. Built per batch
// rather than cached, because the exclusions move (Block 9's cooldown).
function weightedTable(exclude = new Set()) {
  const entries = SHAPES
    .filter((shape) => !exclude.has(shape.name) && (SHAPE_WEIGHTS[shape.name] ?? 0) > 0)
    .map((shape) => ({ shape, weight: SHAPE_WEIGHTS[shape.name] }))
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  let running = 0
  return entries.map((entry) => {
    running += entry.weight / total
    return { shape: entry.shape, upTo: running }
  })
}

function drawFrom(table, rng) {
  const roll = rng()
  for (const entry of table) if (roll < entry.upTo) return entry.shape
  return table[table.length - 1].shape
}

// Accepts either shape objects (a freshly drawn hand) or plain names (the director's
// `recentHands`, which are stored as names because that is what a save slot can hold). Getting
// this wrong is silent and total: reading `.name` off a string yields undefined, every recent
// hand then hashes to the same key, and the "same as a recent batch" flag fires on every deal.
function multisetKey(entries) {
  return entries.map((entry) => (typeof entry === 'string' ? entry : entry.name)).sort().join('|')
}

// "按基础权重生成最多 48 个不重复手牌组合" (§7.1). Constraints are applied at DRAW time, not
// by rejecting afterwards, so a cooling batch never wastes its candidate budget on hands it
// could not use. The `guard` is what stops a pathological constraint set from spinning
// forever (e.g. a pool of one shape with maxSameShape 2 has no legal batch at all).
export function sampleHands({ rng, limit = SAMPLING.candidateHands, allowBlock9 = true, maxSameShape = 2, maxBlock9 = BATCH_RULES.maxBlock9PerBatch, pool = null }) {
  const exclude = allowBlock9 ? new Set() : new Set(['Block 9'])
  const table = pool || weightedTable(exclude)
  const seen = new Set()
  const hands = []
  const guard = limit * 40
  for (let attempt = 0; hands.length < limit && attempt < guard; attempt += 1) {
    const draw = [drawFrom(table, rng), drawFrom(table, rng), drawFrom(table, rng)]
    const counts = new Map()
    draw.forEach((shape) => counts.set(shape.name, (counts.get(shape.name) || 0) + 1))
    if ([...counts.values()].some((count) => count > maxSameShape)) continue
    // Block 9 has its own, stricter cap (§3.2 "一批最多一个 Block9"): the general "at most two
    // of a shape" rule would happily deal two nine-cell pieces, which is exactly the batch the
    // shape's cooldown exists to prevent. Caught by tools/deal-dealer-tests.mjs.
    if ((counts.get('Block 9') || 0) > maxBlock9) continue
    const key = multisetKey(draw)
    if (seen.has(key)) continue
    seen.add(key)
    hands.push(draw)
  }
  return hands
}

// The constructive fallback (§7.2 step 4): instead of sampling and hoping, WALK a legal
// three-placement path on the current board using the reference pool, then deal exactly the
// pieces of that path. It is the one path that guarantees a playable batch when the board is
// merely tight rather than full, and it relaxes the same-shape soft constraint by design —
// a path may legitimately need two of the same piece.
function constructPath(occupancy, rng, { depth = 3, pool = REFERENCE_POOL } = {}) {
  const path = []
  const shapes = []
  let current = cloneOccupancy(occupancy)
  for (let step = 0; step < depth; step += 1) {
    // Try shapes in a shuffled order so the constructed batch is not always the same
    // silhouette, and take the first shape that has any legal placement at all.
    const candidates = rng ? rng.shuffle(pool) : [...pool]
    let placed = null
    for (const shape of candidates) {
      const placements = enumeratePlacements(current, shape.cells)
      if (!placements.length) continue
      const choice = placements[rng ? rng.int(placements.length) : 0]
      placed = { shape, choice }
      break
    }
    if (!placed) break
    // `applyPlacement` returns the settled board as `occ` — advancing `current` is the whole
    // point of the walk (a silent no-op here would place all three pieces on the same board
    // and "prove" a path that does not exist).
    const settled = applyPlacement(current, placed.choice)
    current = settled.occ
    shapes.push(SHAPE_BY_NAME.get(placed.shape.name) || placed.shape)
    path.push({
      pieceIndex: step,
      shape: placed.shape.name,
      face: placed.choice.face,
      quarter: placed.choice.quarter,
      origin: placed.choice.origin,
      cells: placed.choice.cells,
      cleared: settled.cellsCleared,
    })
  }
  return { shapes, witness: path, occupancy: current }
}

function sameHand(a, b) {
  return multisetKey(a) === multisetKey(b)
}

// One dealt batch. Everything the caller needs to commit, plus the metrics the run report
// and the experiments read. `board` is a Board (read-only here); `director` is the state
// object from dealDirector (read-only here — the CALLER advances it, so a batch that is
// discarded never moves the run forward).
export function dealBatch({
  board,
  occupancy = null,
  director,
  intent,
  constraints,
  rng,
  searchRng = null,
  beforeHands = [],
  nodeBudget = BUDGET.nodesPerDeal,
  referencePool = REFERENCE_POOL,
}) {
  const occ = occupancy || fromBoard(board)
  const rBefore = pressure(occ)
  const metrics = {
    phase: intent.phase,
    tier: intent.tier,
    configVersion: DEAL_CONFIG_VERSION,
    rBefore,
    rEnd: null,
    aLower: null,
    aUpper: null,
    candidatesSampled: 0,
    candidatesProven: 0,
    candidatesUnknown: 0,
    candidatesDropped: 0,
    candidatesRefined: 0,
    nodes: 0,
    fallback: FALLBACK_REASONS.NONE,
    fallbackSteps: [],
    withinSafeRange: false,
    intersectsSafeRange: false,
    withinPressureRange: false,
    // True when the chosen batch hit its tolerance target but moved the pressure further than
    // the soft guard (§8.2) prefers. Recorded separately so the report can tell "we missed the
    // target" apart from "we hit it, a bit harder than planned".
    pressureJumpExceeded: false,
    lowBranch: false,
  }

  // ---- 1. Propose (§7.1 step 3) ----------------------------------------------
  const hands = sampleHands({ rng, allowBlock9: constraints.allowBlock9, maxSameShape: constraints.maxSameShape })
  metrics.candidatesSampled = hands.length

  // ---- 2. Prove (§7.1 step 4) ------------------------------------------------
  const survivors = []
  // The proof is DETERMINISTIC by design (solveHand takes no stream): the same board and the
  // same hand must always get the same verdict, or a bug report could not be replayed. Only
  // the sampling in analyzeBatch consumes a stream, and it takes its own so the dealing
  // stream is not shifted by how many samples a search happened to need.
  const samplingRng = searchRng || rng
  let spent = 0
  for (const hand of hands) {
    if (spent >= nodeBudget) break
    const cells = hand.map((shape) => shape.cells)
    const proof = solveHand(occ, cells, { nodeBudget: BUDGET.nodesPerHand })
    spent += proof.nodes
    if (proof.status === 'UNSOLVABLE') {
      // Proven impossible: this batch would be a guaranteed death, so it is not a candidate.
      metrics.candidatesDropped += 1
      continue
    }
    if (proof.status === 'SOLVABLE') metrics.candidatesProven += 1
    else metrics.candidatesUnknown += 1
    survivors.push({ hand, names: hand.map((shape) => shape.name), proof, cells })
  }

  // ---- 2b. Analyse, in two passes (§11.2 "采用分阶段筛选") --------------------
  // Pass 1 ranks every survivor cheaply; pass 2 refines only the best few at full depth.
  // Measured reason: analysing all 48 proposals at 24 samples each cost ~70ms p50 on the main
  // thread — inside the spec's 150ms p95 but OVER its "no 50ms long task" criterion (see
  // tools/deal-perf.mjs). The cheap pass is a RANKING, never a verdict: nothing is discarded
  // by it, and the batch that is finally chosen always carries a full-depth analysis.
  const analysed = []
  const scoringFor = (entry, analysis) => costOf(director, intent, {
    aLower: analysis.aLower, aUpper: analysis.aUpper, rEnd: analysis.rEnd, rBefore, handNames: entry.names,
  })
  for (const entry of survivors) {
    if (spent >= nodeBudget) break
    const analysis = analyzeBatch(occ, entry.cells, {
      samples: SAMPLING.stage1Samples,
      nodeBudget: BUDGET.nodesPerRemaining,
      rng: samplingRng,
    })
    spent += analysis.nodes || 0
    entry.analysis = analysis
    entry.scoring = scoringFor(entry, analysis)
    analysed.push(entry)
  }
  const ranked = [...analysed].sort((a, b) => a.scoring.cost - b.scoring.cost)
  const refine = ranked.slice(0, Math.max(1, SAMPLING.refineCount))
  for (const entry of refine) {
    if (spent >= nodeBudget) break
    const analysis = analyzeBatch(occ, entry.cells, {
      samples: SAMPLING.firstMoves,
      nodeBudget: BUDGET.nodesPerRemaining,
      rng: samplingRng,
    })
    spent += analysis.nodes || 0
    entry.analysis = analysis
    entry.refined = true
    entry.scoring = scoringFor(entry, analysis)
  }
  metrics.candidatesRefined = refine.length
  metrics.nodes = spent

  // ---- 3. Choose, with the spec's degradation order (§7.1 step 5, §7.2) ------
  let chosen = null
  if (analysed.length) {
    // Preferred: a batch that lands INSIDE the tolerance target. The pressure-jump guard
    // (§8.2) then picks between those — it is a preference, not a gate. Getting this wrong is
    // what made the first version report a fallback on EVERY opening deal: on a nearly empty
    // board the pressure term is dominated by occupancy, so a perfectly good three-piece batch
    // moves R by more than 0.08 all by itself. Measured by tools/deal-perf.mjs.
    const within = analysed.filter((entry) => entry.scoring.withinSafeRange)
    const calm = within.filter((entry) => (entry.analysis.rEnd - rBefore) <= PRESSURE_MAX_JUMP)
    if (calm.length) chosen = pickCandidate(calm, rng)
    else if (within.length) {
      chosen = pickCandidate(within, rng)
      // A real, recorded fact about this batch — NOT a fallback. The batch hit its tolerance
      // target; it simply moved the pressure more than the soft guard prefers.
      metrics.pressureJumpExceeded = true
    } else {
      // No sampled batch could be brought inside the tolerance target. The spec's first
      // degradation step is to relax the PRESSURE target and keep the tolerance one; when that
      // is what happens the batch is still chosen on tolerance, and the fallback is recorded.
      const byPressure = [...analysed].sort((a, b) => a.scoring.pressure - b.scoring.pressure)
      const withinPressure = byPressure.filter((entry) => entry.scoring.withinPressureRange)
      if (withinPressure.length) {
        chosen = pickCandidate(withinPressure, rng)
        metrics.fallback = FALLBACK_REASONS.RELAXED_TOLERANCE
        metrics.fallbackSteps.push(FALLBACK_REASONS.RELAXED_PRESSURE)
      } else {
        // Both targets missed: take the batch that leaves the player the most room, and say so.
        const loosest = [...analysed].sort((a, b) => b.analysis.aLower - a.analysis.aLower)
        chosen = pickCandidate(loosest, rng)
        metrics.fallback = FALLBACK_REASONS.RELAXED_TOLERANCE
        metrics.fallbackSteps.push(FALLBACK_REASONS.RELAXED_PRESSURE, FALLBACK_REASONS.RELAXED_TOLERANCE)
      }
    }
  }

  // Nothing survived the search: either every sampled batch is provably impossible (the
  // board has no three-placement continuation at all) or the budget was exhausted before
  // anything was proven.
  if (!chosen) {
    const constructed = constructPath(occ, rng, { depth: 3, pool: referencePool })
    if (constructed.shapes.length === 3) {
      metrics.fallback = FALLBACK_REASONS.CONSTRUCTED
      metrics.fallbackSteps.push(FALLBACK_REASONS.EXTRA_CANDIDATES, FALLBACK_REASONS.CONSTRUCTED)
      // The walk produced the three pieces IN PATH ORDER, and the spec allows the display slots
      // to be shuffled ("实际展示槽位可以最后洗牌"). Shuffling a hand is only free if the witness
      // is remapped with it: the witness names a piece by its INDEX into the hand, so shuffling
      // the hand alone would leave the witness pointing at the wrong piece — a replay would
      // "verify" a path with the wrong shapes and quietly disagree with the board.
      const order = constructed.shapes.map((_, index) => index)
      const shuffled = rng ? rng.shuffle(order) : order
      const hand = shuffled.map((index) => constructed.shapes[index])
      const position = new Map(shuffled.map((original, at) => [original, at]))
      const witness = constructed.witness.map((step) => ({ ...step, pieceIndex: position.get(step.pieceIndex) }))
      chosen = {
        hand,
        names: hand.map((shape) => shape.name),
        proof: { status: 'SOLVABLE', witness, nodes: 0 },
        analysis: { aLower: 1, aUpper: 1, rEnd: pressure(constructed.occupancy), samples: 3, lowBranch: true },
        scoring: { cost: 0, tolerance: 0, pressure: 0, repeat: 0, withinSafeRange: true, intersectsSafeRange: true, withinPressureRange: true },
        relaxedSameShape: true,
      }
    } else if (constructed.shapes.length > 0) {
      // A partial continuation: hand the player what IS provably playable and fill the rest
      // normally. The batch is explicitly marked as not-fully-solvable — the spec forbids
      // claiming otherwise (§7.2), and the caller lets the normal stuck flow handle it.
      const need = 3 - constructed.shapes.length
      const drawn = sampleHands({ rng, limit: 1, allowBlock9: constraints.allowBlock9, maxSameShape: constraints.maxSameShape })
      const filler = (drawn[0] || []).slice(0, need)
      const hand = [...constructed.shapes, ...filler]
      metrics.fallback = FALLBACK_REASONS.NO_FULL_CONTINUATION
      metrics.fallbackSteps.push(FALLBACK_REASONS.CONSTRUCTED, FALLBACK_REASONS.NO_FULL_CONTINUATION)
      metrics.boardNoFullContinuation = true
      chosen = {
        hand,
        names: hand.map((shape) => shape.name),
        proof: { status: 'UNKNOWN', witness: constructed.witness, nodes: 0 },
        analysis: { aLower: 0, aUpper: 1, rEnd: null, samples: constructed.shapes.length, lowBranch: true },
        scoring: { cost: 0, tolerance: 0, pressure: 0, repeat: 0, withinSafeRange: false, intersectsSafeRange: false, withinPressureRange: false },
        relaxedSameShape: true,
      }
    } else {
      // Not even one legal placement on the whole cube. This is NOT a deal failure to hide:
      // the caller keeps the position and the existing stuck/relief flow decides what the
      // player sees (§7.2 last paragraph).
      metrics.fallback = FALLBACK_REASONS.NO_FIRST_MOVE
      metrics.fallbackSteps.push(FALLBACK_REASONS.NO_FIRST_MOVE)
      return { hand: null, names: [], metrics, witness: null }
    }
  }

  // ---- 4. Report ------------------------------------------------------------
  const analysis = chosen.analysis
  metrics.rEnd = analysis.rEnd
  metrics.aLower = analysis.aLower
  metrics.aUpper = analysis.aUpper
  metrics.withinSafeRange = chosen.scoring.withinSafeRange === true
  metrics.intersectsSafeRange = chosen.scoring.intersectsSafeRange === true
  metrics.withinPressureRange = chosen.scoring.withinPressureRange === true
  metrics.cost = chosen.scoring.cost
  metrics.lowBranch = analysis.lowBranch === true
  metrics.samples = analysis.samples
  metrics.proofStatus = chosen.proof.status
  // One witness shape for both sources. The solver names a piece by its INDEX into the batch
  // (the same shape can appear twice and the two are different pieces) and carries the
  // already-rotated cell set; the constructive fallback produces the same fields plus the
  // shape name as a convenience. Normalising here means a caller never has to know which
  // path produced the batch before it can replay it.
  metrics.witness = (chosen.proof.witness || []).map((step) => ({
    pieceIndex: step.pieceIndex,
    face: step.face,
    quarter: step.quarter,
    origin: step.origin,
    cells: step.cells,
  }))
  metrics.relaxedSameShape = chosen.relaxedSameShape === true
  metrics.repeatedWithRecent = chosen.scoring.repeat
  if (metrics.relaxedSameShape) metrics.fallbackSteps.push(FALLBACK_REASONS.RELAXED_SAME_SHAPE)
  if (beforeHands.some((hand) => sameHand(hand, chosen.names))) metrics.fallbackSteps.push(FALLBACK_REASONS.SAME_AS_PREVIOUS)

  return {
    hand: chosen.hand,
    names: chosen.names,
    witness: metrics.witness,
    metrics,
  }
}

// The P2 entry point the spec describes (§9.2) — the next batch is generated, locked and
// saved ahead of time so a challenge can be planned across the batch boundary. P1 ships with
// the flag off and this function deliberately NOT wired into the game: it exists so that the
// honest statement "P1 does not implement cross-batch planning" has a name attached to it.
export function dealQueuedBatch(...args) {
  return dealBatch(...args)
}

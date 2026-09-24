// Batch solvability and tolerance analysis for the dealing director
// (§6.2/§6.3 of the producer's 2026-09-23 dealing spec, v0.9.0 P2).
//
// The question the director actually asks is not "is this board tight" but "if I hand
// the player THESE three pieces, how many ways out do they still have". That question
// has three possible answers, and keeping them apart is the whole point of this file:
//
//   SOLVABLE    — a full, replayable path was found: an ordered list of moves that
//                 places every piece of the batch on the real board.
//   UNSOLVABLE  — every legal branch was exhausted and none of them completes.
//   UNKNOWN     — the search stopped early (node budget, or the caller cancelled)
//                 before all branches were covered.
//
// UNKNOWN must never be reported as UNSOLVABLE. A batch that was only *not proven*
// solvable is exactly the case the director is asked to judge, and calling it
// impossible would reject playable deals and, worse, would look like a difficulty
// finding. So the search carries an `exhausted` flag: UNSOLVABLE is returned only when
// the traversal finished on its own.
//
// Depth is the batch size (three pieces, §6.2), and the ORDER of the pieces is part of
// the search — the player may place the third piece first, and a batch that only works
// in one order is still solvable. Repeated shapes keep their multiplicity: two Dots in
// one batch are two pieces, and the second Dot is a real placement the first one did not
// make. (Only the *ordering* of two identical pieces is collapsed — see `duplicate`
// below — because swapping two identical pieces reaches the same boards.)
import { normalizeCells } from './shapes.js'
import { applyPlacement, completionInfo, cloneOccupancy, enumeratePlacements } from './placementModel.js'
import { pressure, room } from './boardPressure.js'

export const SOLVE_STATUS = Object.freeze({
  SOLVABLE: 'SOLVABLE',
  UNSOLVABLE: 'UNSOLVABLE',
  UNKNOWN: 'UNKNOWN',
})

// Per-call search budget, in expanded placements. A three-piece batch over an open
// board has hundreds of legal moves per piece, so a full exhaustion is far out of
// reach (and would be pointless: an open board is solvable, and the first witness
// found is the answer). The budget exists for the two cases where the answer is
// expensive: a genuinely stuck board (where the branch factor collapses and the proof
// completes well inside the budget) and a nearly-stuck one (where the honest answer is
// UNKNOWN).
export const DEFAULT_NODE_BUDGET = 20000

// The whole analyzeBatch call shares one budget — 24 samples cannot each have the full
// one, or a single call would be 24× the work. Default sized so that 48 candidate
// batches stay inside the deal's latency target; see the perf section of
// tools/deal-core-tests.mjs for the measured p95.
export const DEFAULT_BATCH_NODE_BUDGET = 4000

export const DEFAULT_SAMPLES = 24

// §6.3: below 16 legal first moves there is no sampling left to do — cover them all
// and say so, because A_lower/A_upper then describe the whole first-move space rather
// than a sample of it, and a caller that knows that can trust the bounds more.
export const LOW_BRANCH_THRESHOLD = 16

// At most two endings per sampled first move: one branch of one first move must not
// decide the median, and a batch that only works down one narrow line should not read
// as comfortable. One full witness is always kept.
export const PATHS_PER_FIRST_MOVE = 2

// How many candidates the "keep the room" ranking is allowed to settle and measure.
// room() is 14 shape counts, so measuring all ~300 first moves would cost more than the
// search itself; the ranking is a diversity heuristic (it decides WHICH first moves get
// sampled), not an argmax, so a deterministic spread over the candidate list is enough.
const ROOM_RANK_LIMIT = 64

// Move ordering scores a move by the lines it completes, which costs one small scan per
// candidate. On a very long move list that scan is more expensive than the branching it
// saves, so it is skipped there.
const ORDER_SCAN_LIMIT = 512

function normalizeBudget(value, fallback) {
  if (value === Infinity) return Infinity
  const budget = Number(value)
  if (!Number.isFinite(budget)) return fallback
  return Math.max(0, Math.floor(budget))
}

function pieceKeyOf(cells) {
  return cells.map(([u, v]) => `${u},${v}`).sort().join('|')
}

// Normalize a piece, but keep the caller's array when it is already normalized. That is
// not a micro-optimization for its own sake: placementModel caches each shape's physical
// placement list by array IDENTITY, and the dealer hands the same three piece arrays to
// analyzeBatch 48 times in a row. Re-normalizing would allocate a fresh array every call
// and rebuild the canonical key for it, on the hottest path in the deal.
function asNormalized(cells) {
  if (!Array.isArray(cells) || cells.length === 0) return []
  let minU = Infinity
  let minV = Infinity
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i][0] < minU) minU = cells[i][0]
    if (cells[i][1] < minV) minV = cells[i][1]
  }
  return minU === 0 && minV === 0 ? cells : normalizeCells(cells)
}

// A witness entry. `pieceIndex` names the slot in the hand the caller passed in, and
// face/quarter/origin/cells are exactly what `Board.place(face, cells, origin, color)`
// takes — so the caller can replay the path on the real board and land on the state the
// solver promised. `indices` is there for callers that work on occupancy buffers.
function entryOf(pieceIndex, placement) {
  return {
    pieceIndex,
    face: placement.face,
    quarter: placement.quarter,
    origin: { u: placement.origin.u, v: placement.origin.v },
    cells: placement.cells.map((cell) => cell.slice()),
    indices: placement.indices.slice(),
  }
}

function orderedMoves(occ, cells, rank) {
  const legal = enumeratePlacements(occ, cells)
  if (!rank || legal.length < 2 || legal.length > ORDER_SCAN_LIMIT) return legal
  const scored = legal.map((placement, order) => ({ placement, lines: completionInfo(occ, placement).lines, order }))
  scored.sort((a, b) => b.lines - a.lines || a.order - b.order)
  return scored.map((entry) => entry.placement)
}

function search(occ, pieces, remaining, path, ctx) {
  if (remaining.length === 0) {
    ctx.paths.push(path.slice())
    ctx.states.push(cloneOccupancy(occ))
    return ctx.paths.length >= ctx.maxPaths
  }
  for (let i = 0; i < remaining.length; i += 1) {
    const pieceIndex = remaining[i]
    // Two identical pieces are two pieces (the multiplicity is real), but the order
    // between them is not a different plan: Dot A then Dot B reaches exactly the boards
    // Dot B then Dot A reaches. Exploring both would double the search for every
    // repeated shape and burn the node budget on duplicate branches.
    let duplicate = false
    for (let j = 0; j < i; j += 1) {
      if (ctx.pieceKeys[remaining[j]] === ctx.pieceKeys[pieceIndex]) { duplicate = true; break }
    }
    if (duplicate) continue

    const legal = orderedMoves(occ, pieces[pieceIndex], remaining.length > 1)
    const next = remaining.slice(0, i).concat(remaining.slice(i + 1))
    for (let m = 0; m < legal.length; m += 1) {
      if (ctx.nodes >= ctx.budget) {
        ctx.exhausted = true
        return true
      }
      if (ctx.isCancelled && (ctx.nodes & 0x3f) === 0 && ctx.isCancelled()) {
        ctx.exhausted = true
        ctx.cancelled = true
        return true
      }
      ctx.nodes += 1
      const settled = applyPlacement(occ, legal[m])
      path.push(entryOf(pieceIndex, legal[m]))
      const stop = search(settled.occ, pieces, next, path, ctx)
      path.pop()
      if (stop) return true
    }
  }
  return false
}

// Is the whole batch placeable, and if so in which order?
//
//   solveHand(occ, handCells, { nodeBudget }) ->
//     { status, witness, paths, states, nodes, exhausted, cancelled }
//
// `witness` is the first replayable path (null unless SOLVABLE) and `paths`/`states`
// carry up to `maxPaths` of them, so analyzeBatch can measure more than one ending of
// the same first move without a second search. `nodes` is the number of expanded
// placements, which is what the caller's shared budget is charged.
export function solveHand(occ, handCells, options = {}) {
  const pieces = (handCells ?? []).map(asNormalized)
  const ctx = {
    nodes: 0,
    budget: normalizeBudget(options.nodeBudget, DEFAULT_NODE_BUDGET),
    maxPaths: Math.max(1, Math.trunc(Number(options.maxPaths) || 1)),
    isCancelled: typeof options.isCancelled === 'function' ? options.isCancelled : null,
    pieceKeys: pieces.map(pieceKeyOf),
    paths: [],
    states: [],
    exhausted: false,
    cancelled: false,
  }

  // An empty batch is trivially placeable. Saying so keeps the caller from having to
  // special-case it, and keeps the "SOLVABLE means a witness exists" contract (the
  // witness is the empty path).
  if (pieces.length === 0) {
    const state = cloneOccupancy(occ)
    return {
      status: SOLVE_STATUS.SOLVABLE,
      witness: [],
      paths: [[]],
      states: [state],
      nodes: 0,
      exhausted: false,
      cancelled: false,
    }
  }

  search(occ, pieces, pieces.map((_, index) => index), [], ctx)
  const status = ctx.paths.length > 0
    ? SOLVE_STATUS.SOLVABLE
    : ctx.exhausted ? SOLVE_STATUS.UNKNOWN : SOLVE_STATUS.UNSOLVABLE
  return {
    status,
    witness: ctx.paths[0] ?? null,
    paths: ctx.paths,
    states: ctx.states,
    nodes: ctx.nodes,
    exhausted: ctx.exhausted,
    cancelled: ctx.cancelled,
  }
}

function median(values) {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// A deterministic shuffle: the injected RNG is the ONLY source of randomness in this
// module, so a test can pin the whole analysis by passing a seeded stream.
function shuffled(list, random) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const roll = Math.floor(random() * (i + 1))
    const j = roll < 0 ? 0 : roll > i ? i : roll
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

// Rank by "which first move leaves the most room". Measured with the real room() on the
// settled board, over a bounded deterministic spread of the candidates (ROOM_RANK_LIMIT).
function rankedByRoom(occ, candidates) {
  const step = Math.max(1, Math.ceil(candidates.length / ROOM_RANK_LIMIT))
  const scored = []
  for (let i = 0; i < candidates.length; i += step) {
    const candidate = candidates[i]
    const settled = applyPlacement(occ, candidate.placement)
    scored.push({ candidate, room: room(settled.occ) })
  }
  scored.sort((a, b) => b.room - a.room || a.candidate.id - b.candidate.id)
  return scored.map((entry) => entry.candidate)
}

// One candidate per (piece, face) pair first, then the rest: the third quarter of the
// sample exists to make sure the analysis is not all one piece on one face.
function coverageOrder(candidates) {
  const seen = new Set()
  const first = []
  const rest = []
  for (const candidate of candidates) {
    const key = `${candidate.pieceIndex}|${candidate.placement.face}`
    if (seen.has(key)) {
      rest.push(candidate)
      continue
    }
    seen.add(key)
    first.push(candidate)
  }
  return first.concat(rest)
}

// §6.2/§6.3: sample the first moves, then ask of each one whether the REST of the batch
// still fits. Returns the tolerance interval, the ending pressures and a witness.
//
//   analyzeBatch(occ, handCells, { samples, nodeBudget, random, isCancelled }) ->
//     { K, S, F, U, aLower, aUpper, rEnd, endingPressures, endings, witness, witnesses,
//       lowBranch, firstMoves, nodes, budgetLeft, rStart }
//
// A_lower = S/K is the proven-completable share; A_upper = (S+U)/K assumes every
// unresolved first move is in fact completable, which is the only honest way to read an
// UNKNOWN. When U = 0 the two coincide and the answer is exact. The interval is the
// point: a wide one means "this batch was not analysed enough to judge", not "this batch
// is bad" — raising the node budget narrows it, and tools/deal-core-tests.mjs pins that.
export function analyzeBatch(occ, handCells, options = {}) {
  const pieces = (handCells ?? []).map(asNormalized)
  const requested = Number.isFinite(Number(options.samples)) ? Math.max(0, Math.trunc(Number(options.samples))) : DEFAULT_SAMPLES
  // The spec names the injected RNG but not the option key; `rng` is accepted as an
  // alias because the dealing code (dealer.js) passes its seeded search stream that way.
  // A stream from rng.js IS a function (with extra methods), so both names work.
  const injected = typeof options.rng === 'function' ? options.rng : options.random
  const random = typeof injected === 'function' ? injected : Math.random
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null
  let budgetLeft = normalizeBudget(options.nodeBudget, DEFAULT_BATCH_NODE_BUDGET)

  // Every distinct physical first move. Two identical pieces at the same spot are the
  // same move (the remaining hand differs only in which copy is left), so the dedup key
  // is shape + cells rather than piece slot.
  const candidates = []
  const seenMoves = new Set()
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
    const key = pieceKeyOf(pieces[pieceIndex])
    for (const placement of enumeratePlacements(occ, pieces[pieceIndex])) {
      const moveKey = `${key}#${placement.key}`
      if (seenMoves.has(moveKey)) continue
      seenMoves.add(moveKey)
      const completion = completionInfo(occ, placement)
      candidates.push({
        id: candidates.length,
        pieceIndex,
        placement,
        clears: completion.cellsCleared,
        lines: completion.lines,
      })
    }
  }

  const firstMoves = candidates.length
  const target = Math.min(requested, firstMoves)
  const lowBranch = firstMoves < LOW_BRANCH_THRESHOLD

  // Four quarters, then de-duplicated and topped up to `target`: a quarter that
  // prioritises clears, a quarter that prioritises room, a quarter that spreads over
  // pieces and faces, a quarter of random exploration. The quarters overlap by design
  // (the best-clearing move is often also the room-keeper), which is why the top-up
  // pass exists — without it a "24 sample" analysis would quietly run on 11 moves.
  const quarter = Math.ceil(target / 4)
  const byClears = candidates.slice().sort((a, b) => b.clears - a.clears || b.lines - a.lines || a.id - b.id)
  const categories = [byClears, rankedByRoom(occ, candidates), coverageOrder(candidates), shuffled(candidates, random)]

  const picked = []
  const pickedIds = new Set()
  for (const list of categories) {
    let taken = 0
    for (const candidate of list) {
      if (taken >= quarter || picked.length >= target) break
      if (pickedIds.has(candidate.id)) continue
      pickedIds.add(candidate.id)
      picked.push(candidate)
      taken += 1
    }
  }
  for (const candidate of byClears) {
    if (picked.length >= target) break
    if (pickedIds.has(candidate.id)) continue
    pickedIds.add(candidate.id)
    picked.push(candidate)
  }

  const K = picked.length
  let S = 0
  let F = 0
  let U = 0
  let nodes = 0
  const endings = []
  const witnesses = []

  for (let index = 0; index < K; index += 1) {
    const candidate = picked[index]
    const settled = applyPlacement(occ, candidate.placement)
    const rest = []
    for (let slot = 0; slot < pieces.length; slot += 1) {
      if (slot !== candidate.pieceIndex) rest.push(pieces[slot])
    }
    // Fair share of what is left, so the first sample cannot starve the last one.
    const share = Math.max(0, Math.floor(budgetLeft / (K - index)))
    const result = solveHand(settled.occ, rest, {
      nodeBudget: share,
      maxPaths: PATHS_PER_FIRST_MOVE,
      isCancelled,
    })
    budgetLeft = Math.max(0, budgetLeft - result.nodes)
    nodes += result.nodes
    if (result.status === SOLVE_STATUS.SOLVABLE) S += 1
    else if (result.status === SOLVE_STATUS.UNSOLVABLE) F += 1
    else U += 1

    if (result.status !== SOLVE_STATUS.SOLVABLE) continue
    const head = entryOf(candidate.pieceIndex, candidate.placement)
    const kept = Math.min(result.paths.length, PATHS_PER_FIRST_MOVE)
    for (let i = 0; i < kept; i += 1) {
      const state = result.states[i]
      endings.push({
        pieceIndex: candidate.pieceIndex,
        face: candidate.placement.face,
        quarter: candidate.placement.quarter,
        origin: { u: candidate.placement.origin.u, v: candidate.placement.origin.v },
        pressure: pressure(state),
        occ: state,
      })
      witnesses.push([head, ...result.paths[i]])
    }
  }

  const endingPressures = endings.map((ending) => ending.pressure)
  return {
    K,
    S,
    F,
    U,
    aLower: K > 0 ? S / K : 0,
    aUpper: K > 0 ? (S + U) / K : 0,
    // The median of the ENDING pressures — the cube after the batch has actually been
    // played out, not after the first move. A first move that is provably completable
    // contributes at most two endings, so one lucky line cannot drag the median down.
    // null when no sampled first move could be completed at all.
    rEnd: median(endingPressures),
    endingPressures,
    endings,
    witness: witnesses[0] ?? null,
    witnesses,
    lowBranch,
    firstMoves,
    nodes,
    budgetLeft,
    // Pressure before the batch, so the caller can read the analysis as a delta
    // (R_end − R_start) without a second measurement of the same board.
    rStart: pressure(occ),
  }
}

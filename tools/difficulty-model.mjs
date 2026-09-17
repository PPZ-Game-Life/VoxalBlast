// Measurement-only difficulty model for the A/B/C/D opening and deal experiment.
//
// This module deliberately imports the shipped board/shape definitions rather than
// maintaining a second cube geometry. Runtime moves use four uint32 words for the
// 98 shell cells; Board is used only to reproduce the real opening seeder and at
// conversion boundaries.
import { Board, FACES, SH, faceLattice } from '../src/game/board.js'
import { SHAPES, rotateCells } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'

const WORDS = 4
const EMPTY_STATE = Object.freeze([0, 0, 0, 0])
const SHAPE_BY_NAME = new Map(SHAPES.map((shape) => [shape.name, shape]))
const SMALL = Object.freeze(['Dot', 'Line 2'])
const THREE = Object.freeze(['Line 3', 'Corner'])
const FOUR = Object.freeze(['Square', 'L', 'J', 'T', 'S', 'Z'])
const GROUPS = Object.freeze([SMALL, THREE, FOUR])
const CHALLENGE_WEIGHTS = Object.freeze([0, 0.1, 0.9])
const RELIEF_WEIGHTS = Object.freeze([0.1, 0.2, 0.7])

export const SHAPE_NAMES = Object.freeze(SHAPES.map((shape) => shape.name))

// Named measurement pools. `current` reproduces the shipped ten-shape equal pools
// exactly; the rest are the documented compression candidates. Weights are
// relative, so a pool can favour a subset without removing it. Pool ids are part of
// the published CLI surface, so an unknown id throws instead of silently dealing
// the shipped pool.
const POOL_SPECS = Object.freeze({
  current: { label: '现行十种等权重', weights: Object.fromEntries(SHAPE_NAMES.map((name) => [name, 1])) },
  c: { label: '去单格与直线2（8种）', weights: Object.fromEntries(SHAPE_NAMES.filter((name) => !SMALL.includes(name)).map((name) => [name, 1])) },
  d: { label: '去单格、直线2、三格转角（7种）', weights: Object.fromEntries(SHAPE_NAMES.filter((name) => !SMALL.includes(name) && name !== 'Corner').map((name) => [name, 1])) },
  w90: { label: '四格件×3＋直线3×2（加权）', weights: Object.fromEntries([...FOUR.map((name) => [name, 3]), ['Line 3', 2]]) },
  e: { label: '只留六种四格件', weights: Object.fromEntries(FOUR.map((name) => [name, 1])) },
  e5: { label: '只留L/J/T/S/Z（去Square）', weights: Object.fromEntries(FOUR.filter((name) => name !== 'Square').map((name) => [name, 1])) },
})

export const POOL_IDS = Object.freeze(Object.keys(POOL_SPECS))

function buildPool(id) {
  const spec = POOL_SPECS[id]
  const entries = Object.entries(spec.weights).filter(([, weight]) => weight > 0).map(([name, weight]) => ({ name, weight }))
  if (!entries.length) throw new Error(`pool ${id} is empty`)
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  const cumulative = []
  let running = 0
  for (const entry of entries) {
    running += entry.weight / total
    cumulative.push({ ...entry, upTo: running })
  }
  return Object.freeze({
    id,
    label: spec.label,
    entries: Object.freeze(entries),
    cumulative: Object.freeze(cumulative),
    members: new Set(entries.map((entry) => entry.name)),
  })
}

export const POOLS = Object.freeze(Object.fromEntries(POOL_IDS.map((id) => [id, buildPool(id)])))

export function poolById(id = 'current') {
  const pool = POOLS[id]
  if (!pool) throw new Error(`unknown pool "${id}"; known pools: ${POOL_IDS.join(', ')}`)
  return pool
}

// Relative weights are consumed through an explicit cumulative table so an
// unweighted pool stays byte-identical to the old uniform index arithmetic.
function pickWeighted(pool, r) {
  for (const entry of pool.cumulative) if (r < entry.upTo) return entry.name
  return pool.cumulative[pool.cumulative.length - 1].name
}

// Stage weights are renormalized over the groups the pool still covers. A pool with
// no small pieces therefore never keeps a silent 20% share reserved for an emptied
// group; the challenge/relief split survives proportionally.
function activeStageGroups(pool, weights) {
  const active = GROUPS
    .map((members, index) => ({ members: members.filter((name) => pool.members.has(name)), weight: weights[index] }))
    .filter((group) => group.members.length > 0 && group.weight > 0)
  if (!active.length) throw new Error(`pool ${pool.id} has no shape in any staged group`)
  const total = active.reduce((sum, group) => sum + group.weight, 0)
  const cumulative = []
  let running = 0
  for (const group of active) {
    running += group.weight / total
    cumulative.push({ ...group, upTo: running })
  }
  return cumulative
}

// Stable shell index: x, then y, then z, matching the old reachability model.
export const CELLS = []
const INDEX_BY_COORD = new Map()
for (let x = 0; x < SH; x += 1) {
  for (let y = 0; y < SH; y += 1) {
    for (let z = 0; z < SH; z += 1) {
      if (x !== 0 && x !== SH - 1 && y !== 0 && y !== SH - 1 && z !== 0 && z !== SH - 1) continue
      const index = CELLS.length
      const coordinate = Object.freeze([x, y, z])
      CELLS.push(coordinate)
      INDEX_BY_COORD.set(`${x},${y},${z}`, index)
    }
  }
}
Object.freeze(CELLS)
if (CELLS.length !== 98) throw new Error(`difficulty model expected 98 shell cells, found ${CELLS.length}`)

// Orthogonal shell neighbours support the optional `space` actor's compactness
// heuristic. This is deliberately geometric rather than face-based: a shared edge
// cell is still one physical cube and should not gain duplicate neighbours.
const NEIGHBORS = CELLS.map(([x, y, z]) => {
  const out = []
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const index = INDEX_BY_COORD.get(`${x + dx},${y + dy},${z + dz}`)
    if (index !== undefined) out.push(index)
  }
  return Object.freeze(out)
})
Object.freeze(NEIGHBORS)

function bitFor(index) {
  return (1 << (index & 31)) >>> 0
}

function maskFromIndices(indices) {
  const words = new Uint32Array(WORDS)
  for (const index of indices) words[index >>> 5] |= bitFor(index)
  return words
}

function wordsKey(words) {
  return `${words[0].toString(16).padStart(8, '0')}:${words[1].toString(16).padStart(8, '0')}:${words[2].toString(16).padStart(8, '0')}:${words[3].toString(16).padStart(8, '0')}`
}

function normalizedCellKey(cells) {
  return cells.map(([u, v]) => `${u},${v}`).sort().join('|')
}

// Sixty shipped face lines. Shared edge/corner cells intentionally occur in the
// masks of more than one face line, exactly as Board.findAllFullLines() treats them.
export const LINES = []
for (const face of FACES) {
  for (let v = 0; v < SH; v += 1) {
    const indices = []
    for (let u = 0; u < SH; u += 1) indices.push(INDEX_BY_COORD.get(faceLattice(face, u, v).join(',')))
    const mask = maskFromIndices(indices)
    LINES.push(Object.freeze({ id: LINES.length, face, axis: 'row', n: v, indices: Object.freeze(indices), mask }))
  }
  for (let u = 0; u < SH; u += 1) {
    const indices = []
    for (let v = 0; v < SH; v += 1) indices.push(INDEX_BY_COORD.get(faceLattice(face, u, v).join(',')))
    const mask = maskFromIndices(indices)
    LINES.push(Object.freeze({ id: LINES.length, face, axis: 'col', n: u, indices: Object.freeze(indices), mask }))
  }
}
Object.freeze(LINES)
const LINES_BY_INDEX = Array.from({ length: CELLS.length }, () => [])
for (const line of LINES) for (const index of line.indices) LINES_BY_INDEX[index].push(line.id)

export const PLACEMENTS = []
export const BY_SHAPE = new Map(SHAPE_NAMES.map((name) => [name, []]))
// Stable order here is shape -> rotation -> face -> origin. The older
// reachability.mjs builds face -> rotation -> origin instead, so deterministic
// ties are reproducible inside this experiment but trajectories are NOT expected
// to be byte-identical to that older simulator.
for (const shape of SHAPES) {
  const orientations = new Set()
  for (let quarter = 0; quarter < 4; quarter += 1) {
    const cells = rotateCells(shape.cells, quarter)
    const orientationKey = normalizedCellKey(cells)
    if (orientations.has(orientationKey)) continue
    orientations.add(orientationKey)
    const maxU = Math.max(...cells.map(([u]) => u))
    const maxV = Math.max(...cells.map(([, v]) => v))
    for (const face of FACES) {
      for (let u = 0; u < SH - maxU; u += 1) {
        for (let v = 0; v < SH - maxV; v += 1) {
          const indices = cells.map(([du, dv]) => INDEX_BY_COORD.get(faceLattice(face, u + du, v + dv).join(',')))
          const mask = maskFromIndices(indices)
          const lineIds = [...new Set(indices.flatMap((index) => LINES_BY_INDEX[index]))]
          const placement = Object.freeze({
            id: `${shape.name}|${face}|q${quarter}|${u},${v}`,
            shape: shape.name,
            face,
            cells: Object.freeze(cells.map((cell) => Object.freeze(cell.slice()))),
            origin: Object.freeze({ u, v }),
            indices: Object.freeze(indices.slice()),
            mask,
            maskKey: wordsKey(mask),
            lineIds: Object.freeze(lineIds),
          })
          PLACEMENTS.push(placement)
          BY_SHAPE.get(shape.name).push(placement)
        }
      }
    }
  }
}
Object.freeze(PLACEMENTS)
for (const [name, placements] of BY_SHAPE) BY_SHAPE.set(name, Object.freeze(placements))

function validState(state) {
  return state != null && state.length >= WORDS
}

export function stateFromBoard(board) {
  const state = new Uint32Array(WORDS)
  for (const cell of board.occupied()) {
    const index = INDEX_BY_COORD.get(`${cell.x},${cell.y},${cell.z}`)
    if (index === undefined) throw new Error(`board contains a non-shell cell: ${cell.x},${cell.y},${cell.z}`)
    state[index >>> 5] |= bitFor(index)
  }
  return state
}

export function boardFromState(state) {
  if (!validState(state)) throw new TypeError('state must contain four uint32 words')
  const board = new Board()
  for (let index = 0; index < CELLS.length; index += 1) {
    if ((state[index >>> 5] & bitFor(index)) === 0) continue
    const [x, y, z] = CELLS[index]
    board.cells.set(board.key(x, y, z), { x, y, z, color: 0xffffff })
  }
  return board
}

export function stateKey(state) {
  if (!validState(state)) throw new TypeError('state must contain four uint32 words')
  return wordsKey(state)
}

function popcount32(value) {
  value >>>= 0
  value -= (value >>> 1) & 0x55555555
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333)
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

export function occupiedCount(state) {
  if (!validState(state)) throw new TypeError('state must contain four uint32 words')
  return popcount32(state[0]) + popcount32(state[1]) + popcount32(state[2]) + popcount32(state[3])
}

export function canPlace(state, placement) {
  const mask = placement.mask
  return (((state[0] & mask[0]) | (state[1] & mask[1]) | (state[2] & mask[2]) | (state[3] & mask[3])) >>> 0) === 0
}

function lineIsFull(state, line) {
  const mask = line.mask
  // Bitwise operators return signed int32 values; normalize before comparing with
  // Uint32Array words so masks containing bit 31 are not mistaken for incomplete.
  return ((state[0] & mask[0]) >>> 0) === mask[0]
    && ((state[1] & mask[1]) >>> 0) === mask[1]
    && ((state[2] & mask[2]) >>> 0) === mask[2]
    && ((state[3] & mask[3]) >>> 0) === mask[3]
}

export function fullLineCount(state) {
  let count = 0
  for (const line of LINES) if (lineIsFull(state, line)) count += 1
  return count
}

export function settle(state, placement) {
  const placed = new Uint32Array(WORDS)
  placed[0] = (state[0] | placement.mask[0]) >>> 0
  placed[1] = (state[1] | placement.mask[1]) >>> 0
  placed[2] = (state[2] | placement.mask[2]) >>> 0
  placed[3] = (state[3] | placement.mask[3]) >>> 0

  const clear = new Uint32Array(WORDS)
  let lines = 0
  let faceBits = 0
  for (let i = 0; i < LINES.length; i += 1) {
    const line = LINES[i]
    if (!lineIsFull(placed, line)) continue
    lines += 1
    faceBits |= 1 << FACES.indexOf(line.face)
    clear[0] |= line.mask[0]
    clear[1] |= line.mask[1]
    clear[2] |= line.mask[2]
    clear[3] |= line.mask[3]
  }

  const next = new Uint32Array(WORDS)
  next[0] = (placed[0] & ~clear[0]) >>> 0
  next[1] = (placed[1] & ~clear[1]) >>> 0
  next[2] = (placed[2] & ~clear[2]) >>> 0
  next[3] = (placed[3] & ~clear[3]) >>> 0
  return {
    state: next,
    lines,
    cellsCleared: popcount32(clear[0]) + popcount32(clear[1]) + popcount32(clear[2]) + popcount32(clear[3]),
    facesHit: popcount32(faceBits),
    // Bit i corresponds to FACES[i]. Exposed for opening-quality proof: placing
    // on +z is insufficient unless one of the lines actually cleared is on +z.
    faceMask: faceBits,
  }
}

// FNV-1a hashes the complete stream identity, then mulberry32 supplies the values.
// Opening/deal/policy/structure therefore do not perturb each other when one model
// consumes extra random numbers.
function streamSeed(seed, gameIndex, streamName) {
  const text = `${String(seed)}\u0000${String(gameIndex)}\u0000${String(streamName)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function rngFor(seed, gameIndex, streamName) {
  let value = streamSeed(seed, gameIndex, streamName)
  return function mulberry32() {
    value = (value + 0x6d2b79f5) >>> 0
    let mixed = value
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function stageAt(completedSteps) {
  const steps = Math.max(0, Math.trunc(Number(completedSteps) || 0))
  if (steps <= 11) return { name: 'opening', weights: [0.2, 0.3, 0.5] }
  if (steps <= 29) return { name: 'pressure', weights: [0.1, 0.2, 0.7] }
  if (steps <= 47) return { name: 'challenge', weights: [...CHALLENGE_WEIGHTS] }
  if (steps <= 53) return { name: 'relief', weights: [...RELIEF_WEIGHTS] }
  const cycle = (steps - 54) % 24
  return cycle < 18
    ? { name: 'challenge-cycle', weights: [...CHALLENGE_WEIGHTS] }
    : { name: 'relief-cycle', weights: [...RELIEF_WEIGHTS] }
}

export function drawHand(rng, completedSteps = 0, staged = false, poolId = 'current') {
  const pool = poolById(poolId)
  const hand = []
  const groups = staged ? activeStageGroups(pool, stageAt(completedSteps).weights) : null
  for (let slot = 0; slot < 3; slot += 1) {
    const first = rng()
    const second = rng() // Always consumed, including uniform deals, for paired streams.
    if (!staged) {
      hand.push(pickWeighted(pool, first))
      continue
    }
    let chosen = groups[groups.length - 1]
    for (const group of groups) {
      if (first < group.upTo) { chosen = group; break }
    }
    hand.push(chosen.members[Math.min(chosen.members.length - 1, Math.floor(second * chosen.members.length))])
  }
  return hand
}

function uniqueLegalPlacements(state, shape, face = null) {
  const placements = BY_SHAPE.get(shape)
  if (!placements) return []
  const seen = new Set()
  const legal = []
  for (const placement of placements) {
    if (face && placement.face !== face) continue
    if (!canPlace(state, placement) || seen.has(placement.maskKey)) continue
    seen.add(placement.maskKey)
    legal.push(placement)
  }
  return legal
}

export function legalCount(state, shape) {
  return uniqueLegalPlacements(state, shape).length
}

export function legalMoves(state, hand) {
  const moves = []
  for (let slot = 0; slot < hand.length; slot += 1) {
    const shape = hand[slot]
    if (!SHAPE_BY_NAME.has(shape)) continue
    for (const placement of uniqueLegalPlacements(state, shape)) moves.push({ slot, pl: placement })
  }
  return moves
}

function compactness(state) {
  let pairs = 0
  for (let index = 0; index < CELLS.length; index += 1) {
    if ((state[index >>> 5] & bitFor(index)) === 0) continue
    for (const neighbor of NEIGHBORS[index]) {
      // Count each occupied orthogonal pair once.
      if (neighbor > index && (state[neighbor >>> 5] & bitFor(neighbor)) !== 0) pairs += 1
    }
  }
  return pairs
}

function immediateLineCount(state, placement) {
  const p0 = (state[0] | placement.mask[0]) >>> 0
  const p1 = (state[1] | placement.mask[1]) >>> 0
  const p2 = (state[2] | placement.mask[2]) >>> 0
  const p3 = (state[3] | placement.mask[3]) >>> 0
  let count = 0
  // Valid model states never retain a full line after settle(), so every newly
  // completed line intersects the placed cells. This is the old simulator's
  // quickLineCount optimization, avoiding 60-line scans for every candidate.
  for (const lineId of placement.lineIds) {
    const mask = LINES[lineId].mask
    if (((p0 & mask[0]) >>> 0) === mask[0]
      && ((p1 & mask[1]) >>> 0) === mask[1]
      && ((p2 & mask[2]) >>> 0) === mask[2]
      && ((p3 & mask[3]) >>> 0) === mask[3]) count += 1
  }
  return count
}

function chooseForSlot(state, shape, rng, strategy) {
  const legal = uniqueLegalPlacements(state, shape)
  if (legal.length === 0) return null
  if (strategy === 'noise' && rng() < 0.25) return legal[Math.floor(rng() * legal.length)]
  let best = legal[0]
  let bestLines = immediateLineCount(state, best)
  for (let i = 1; i < legal.length; i += 1) {
    const lines = immediateLineCount(state, legal[i])
    if (lines > bestLines) {
      best = legal[i]
      bestLines = lines
    }
  }
  return best
}

function settleAffectedLines(state, placement) {
  const placed = new Uint32Array(WORDS)
  placed[0] = (state[0] | placement.mask[0]) >>> 0
  placed[1] = (state[1] | placement.mask[1]) >>> 0
  placed[2] = (state[2] | placement.mask[2]) >>> 0
  placed[3] = (state[3] | placement.mask[3]) >>> 0
  const clear = new Uint32Array(WORDS)
  for (const lineId of placement.lineIds) {
    const line = LINES[lineId]
    if (!lineIsFull(placed, line)) continue
    clear[0] |= line.mask[0]
    clear[1] |= line.mask[1]
    clear[2] |= line.mask[2]
    clear[3] |= line.mask[3]
  }
  placed[0] = (placed[0] & ~clear[0]) >>> 0
  placed[1] = (placed[1] & ~clear[1]) >>> 0
  placed[2] = (placed[2] & ~clear[2]) >>> 0
  placed[3] = (placed[3] & ~clear[3]) >>> 0
  return {
    state: placed,
    clear,
    cellsCleared: popcount32(clear[0]) + popcount32(clear[1]) + popcount32(clear[2]) + popcount32(clear[3]),
  }
}

function compactnessAfter(state, placement, clear, baseCompactness) {
  let addedPairs = 0
  for (const index of placement.indices) {
    for (const neighbor of NEIGHBORS[index]) {
      const neighborIsNew = placement.indices.includes(neighbor)
      const occupiedAfterPlacement = neighborIsNew || (state[neighbor >>> 5] & bitFor(neighbor)) !== 0
      if (!occupiedAfterPlacement) continue
      // New-to-old is seen once from the new cell. New-to-new is seen from both.
      if (!neighborIsNew || neighbor > index) addedPairs += 1
    }
  }
  if (clear[0] === 0 && clear[1] === 0 && clear[2] === 0 && clear[3] === 0) return baseCompactness + addedPairs

  let removedPairs = 0
  for (let index = 0; index < CELLS.length; index += 1) {
    if ((clear[index >>> 5] & bitFor(index)) === 0) continue
    for (const neighbor of NEIGHBORS[index]) {
      const occupiedBeforeClear = placement.indices.includes(neighbor)
        || (state[neighbor >>> 5] & bitFor(neighbor)) !== 0
      if (!occupiedBeforeClear) continue
      const neighborCleared = (clear[neighbor >>> 5] & bitFor(neighbor)) !== 0
      if (!neighborCleared || neighbor > index) removedPairs += 1
    }
  }
  return baseCompactness + addedPairs - removedPairs
}

// Shallow all-hand beam actor for sensitivity checks, NOT an optimal player.
// It considers every currently legal slot/mask and ranks the width-6 beam by:
//   cleared unique cells * 100000 + empty shell cells * 100 + occupied adjacency.
// Those constants make the criteria lexicographic at this board size: immediate
// release first, empty-space preservation second, compactness third. Inside that
// already-pruned beam it chooses the result with the largest summed unique legal
// mask count for the remaining hand, then the preliminary score. This creates an
// explicit beam-order bias: a move pruned from the immediate top six can never win,
// even if deeper search would favor it. Ties retain stable placement order. The
// actor looks only one move ahead, never sees a future deal, and consumes no RNG.
function chooseSpaceMove(state, hand) {
  const moves = legalMoves(state, hand)
  if (moves.length === 0) return null
  const beam = []
  const seenCandidates = new Set()
  const baseCompactness = compactness(state)
  for (const move of moves) {
    const remaining = hand.filter((_, slot) => slot !== move.slot)
    const signature = `${move.pl.maskKey}|${remaining.slice().sort().join(',')}`
    if (seenCandidates.has(signature)) continue
    seenCandidates.add(signature)
    const outcome = settleAffectedLines(state, move.pl)
    const nextCompactness = compactnessAfter(state, move.pl, outcome.clear, baseCompactness)
    const emptyCells = CELLS.length - occupiedCount(outcome.state)
    const preliminary = outcome.cellsCleared * 100000 + emptyCells * 100 + nextCompactness
    const candidate = { ...move, remaining, nextState: outcome.state, preliminary, mobility: 0 }
    let at = beam.findIndex((entry) => preliminary > entry.preliminary)
    if (at < 0) at = beam.length
    beam.splice(at, 0, candidate)
    if (beam.length > 6) beam.pop()
  }
  let best = null
  for (const candidate of beam) {
    candidate.mobility = candidate.remaining.reduce((sum, shape) => sum + legalCount(candidate.nextState, shape), 0)
    if (!best
      || candidate.mobility > best.mobility
      || (candidate.mobility === best.mobility && candidate.preliminary > best.preliminary)) best = candidate
  }
  return { slot: best.slot, pl: best.pl }
}

export function chooseMove(state, hand, rng, strategy = 'noise') {
  if (strategy === 'random') {
    const moves = legalMoves(state, hand)
    return moves.length ? moves[Math.floor(rng() * moves.length)] : null
  }
  if (strategy === 'space') return chooseSpaceMove(state, hand)
  if (strategy !== 'noise' && strategy !== 'greedy') throw new Error(`unknown strategy: ${strategy}`)
  // Preserve the old simulator's slot priority: only the first playable slot is
  // considered. Greedy/noise then choose a placement for that shape.
  for (let slot = 0; slot < hand.length; slot += 1) {
    if (!SHAPE_BY_NAME.has(hand[slot])) continue
    const placement = chooseForSlot(state, hand[slot], rng, strategy)
    if (placement) return { slot, pl: placement }
  }
  return null
}

function seededBoard(rng) {
  const board = new Board()
  board.seedOpening(SHAPES, OPENING_LAYOUT, rng)
  if (board.hasFullLineOnAnyFace()) throw new Error('Board.seedOpening produced a full line')
  return board
}

function openingWitness(state, hand, nodeBudget) {
  const playableTypes = new Set(hand.filter((shape) => legalCount(state, shape) >= 2))
  if (playableTypes.size < 2) return { status: 'unsolvable', nodes: 0, witness: null, reason: 'fewer-than-two-playable-types' }

  let nodes = 0
  let budgetExhausted = false
  const dfs = (current, remainingSlots, path) => {
    if (remainingSlots.length === 0) return path
    for (const slot of remainingSlots) {
      const moves = uniqueLegalPlacements(current, hand[slot])
      for (const placement of moves) {
        if (nodes >= nodeBudget) {
          budgetExhausted = true
          return null
        }
        nodes += 1
        const result = settle(current, placement)
        const nextSlots = remainingSlots.filter((candidate) => candidate !== slot)
        const found = dfs(result.state, nextSlots, [...path, { slot, shape: hand[slot], placementId: placement.id }])
        if (found || budgetExhausted) return found
      }
    }
    return null
  }

  // The first move must be physically represented on +z AND clear an actual +z
  // row/column; clearing only a neighboring face through a shared edge is not a
  // front-face opportunity. Subsequent moves may use any face. Masks are
  // deduplicated on +z so symmetric orientations consume the budget only once.
  const frontFaceBit = 1 << FACES.indexOf('+z')
  for (let slot = 0; slot < hand.length; slot += 1) {
    for (const placement of uniqueLegalPlacements(state, hand[slot], '+z')) {
      if (nodes >= nodeBudget) return { status: 'budget-exhausted', nodes, witness: null, reason: 'node-budget-exhausted' }
      nodes += 1
      const result = settle(state, placement)
      if ((result.faceMask & frontFaceBit) === 0) continue
      const remaining = hand.map((_, index) => index).filter((index) => index !== slot)
      const first = [{ slot, shape: hand[slot], placementId: placement.id }]
      const witness = dfs(result.state, remaining, first)
      if (witness) return { status: 'accepted', nodes, witness, reason: 'quality-validated' }
      if (budgetExhausted) return { status: 'budget-exhausted', nodes, witness: null, reason: 'node-budget-exhausted' }
    }
  }
  return { status: 'unsolvable', nodes, witness: null, reason: 'no-plus-z-line-clear-three-piece-continuation' }
}

export function makeOpening({
  seed,
  gameIndex,
  structured = false,
  staged = false,
  poolId = 'current',
  maxAttempts = 128,
  nodeBudget = 12000,
} = {}) {
  const openingRng = rngFor(seed, gameIndex, 'opening')
  const dealRng = rngFor(seed, gameIndex, 'deal')
  const baselineBoard = seededBoard(openingRng)
  const baselineState = stateFromBoard(baselineBoard)
  const baselineCount = occupiedCount(baselineState)
  const hand = drawHand(dealRng, 0, staged, poolId)

  if (!structured) {
    return {
      state: baselineState,
      hand,
      meta: {
        structured: false,
        baselineCount,
        actualCount: baselineCount,
        attempts: 1,
        nodes: 0,
        searchBudgetExhaustions: 0,
        searchUnsolvable: 0,
        countRejected: 0,
        accepted: null,
        fallback: false,
        reason: 'not-requested',
        witness: null,
      },
    }
  }

  const attemptsLimit = Math.max(1, Math.trunc(Number(maxAttempts) || 1))
  const budget = Math.max(1, Math.trunc(Number(nodeBudget) || 1))
  let attempts = 1
  let nodes = 0
  let searchBudgetExhaustions = 0
  let searchUnsolvable = 0
  let countRejected = 0

  // The quality contract requires at least two DISTINCT first-hand shape types.
  // No opening resample can change this independently drawn hand, so repeated
  // seeding would be guaranteed wasted work (not a search failure or budget exhaustion).
  if (new Set(hand).size < 2) {
    return {
      state: baselineState,
      hand,
      meta: {
        structured: true,
        baselineCount,
        actualCount: baselineCount,
        attempts,
        nodes,
        searchBudgetExhaustions,
        searchUnsolvable,
        countRejected,
        accepted: false,
        fallback: true,
        reason: 'structured-impossible-first-hand-fewer-than-two-distinct-types; returned-unstructured-baseline',
        witness: null,
      },
    }
  }

  // Paired comparison first: accept the exact current opening when it already has
  // the requested quality, without consuming the structure stream.
  let check = openingWitness(baselineState, hand, budget)
  nodes += check.nodes
  if (check.status === 'accepted') {
    return {
      state: baselineState,
      hand,
      meta: {
        structured: true,
        baselineCount,
        actualCount: baselineCount,
        attempts,
        nodes,
        searchBudgetExhaustions,
        searchUnsolvable,
        countRejected,
        accepted: true,
        fallback: false,
        reason: 'baseline-quality-validated',
        witness: check.witness,
      },
    }
  }
  if (check.status === 'budget-exhausted') searchBudgetExhaustions += 1
  else searchUnsolvable += 1

  const structureRng = rngFor(seed, gameIndex, 'structure')
  while (attempts < attemptsLimit && nodes < budget) {
    attempts += 1
    const candidateBoard = seededBoard(structureRng)
    const candidateState = stateFromBoard(candidateBoard)
    const actualCount = occupiedCount(candidateState)
    if (actualCount !== baselineCount) {
      countRejected += 1
      continue
    }
    check = openingWitness(candidateState, hand, budget - nodes)
    nodes += check.nodes
    if (check.status === 'accepted') {
      return {
        state: candidateState,
        hand,
        meta: {
          structured: true,
          baselineCount,
          actualCount,
          attempts,
          nodes,
          searchBudgetExhaustions,
          searchUnsolvable,
          countRejected,
          accepted: true,
          fallback: false,
          reason: 'rejection-sampled-quality-validated',
          witness: check.witness,
        },
      }
    }
    if (check.status === 'budget-exhausted') searchBudgetExhaustions += 1
    else searchUnsolvable += 1
  }

  // Never label an unvalidated board structured. Returning the paired baseline is
  // explicit and lets the report disclose how often B/D fell back to A/C.
  return {
    state: baselineState,
    hand,
    meta: {
      structured: true,
      baselineCount,
      actualCount: baselineCount,
      attempts,
      nodes,
      searchBudgetExhaustions,
      searchUnsolvable,
      countRejected,
      accepted: false,
      fallback: true,
      reason: nodes >= budget
        ? 'structured-node-budget-exhausted; returned-unstructured-baseline'
        : 'structured-attempts-exhausted; returned-unstructured-baseline',
      witness: null,
    },
  }
}

export { EMPTY_STATE }

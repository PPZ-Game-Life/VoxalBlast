// Space-pressure metrics for the dealing director (§6.1 of the producer's
// 2026-09-23 dealing spec, v0.9.0 P2).
//
// The director needs one number that says "how tight is this cube right now",
// comparable across phases, hands and cooldowns. Two obvious candidates are both
// wrong on their own:
//   - "free cells / 98" ignores SHAPE: a board with 30 scattered free cells and no
//     3×3 hole is far tighter than a board with 30 free cells in one block, and the
//     hand the player is holding cannot tell the difference either;
//   - "how many placements does the CURRENT hand have" moves with the deal, so it
//     cannot be used to compare two candidate batches — the metric would be part of
//     what it measures.
//
// So R(B) is measured against a FIXED REFERENCE POOL: every shape the game can deal
// except `Block 9`, weighted with the shipped SHAPE_WEIGHTS. It is a measuring stick,
// not a dealing pool: it never varies with phase, cooldown or the current hand, and
// nothing here may be fed back into the deal. `Block 9` is out for the same reason it
// is interesting — it needs a 3×3 gap, so it saturates to "stuck" long before the
// rest of the pool does, and it would turn the metric into a mostly-binary reading of
// one shape (it also carries a 0.4 weight in the deal, which is not a base weight).
// `Line 4` is IN: it ships in the pool since v0.9.0 P1 and it is the one shape that
// commits 80% of a face row, so a pressure metric that cannot see it would miss the
// most common way a face goes from "busy" to "one row from clearing".
//
// The pool is resolved once, at module load, into frozen entries — the shipped table
// is already frozen, but a measuring stick that could be re-pointed at runtime is a
// metric that can silently change meaning between two measurements in the same report.
import { SHAPES, SHAPE_WEIGHTS } from './shapes.js'
import { CELL_COUNT, countPlacements, occupancyCount } from './placementModel.js'

// min(N, 12)/12. The cap is what keeps a Dot — 98 legal placements on an empty cube,
// and still dozens on a crowded one — from drowning out the shapes that are actually
// stuck: without it, availability would be dominated by the smallest pieces and room()
// would stay near 1.0 on boards where Line 4, L 5 and Rect 6 have nowhere to go.
// The cost of the cap is that it saturates: a board where EVERY reference shape has 12
// or more placements reads availability 1.0 for all of them and R can no longer tell
// such a board from a completely empty one. R is therefore a lower-resolution gauge in
// the open phase and a sharp one under pressure, which is where the director uses it.
export const AVAILABILITY_CAP = 12

export const PRESSURE_MIX = Object.freeze({ room: 0.75, occupancy: 0.25 })

const POOL_ENTRIES = (() => {
  const entries = SHAPES
    .filter((shape) => shape.name !== 'Block 9')
    .map((shape) => {
      const weight = SHAPE_WEIGHTS[shape.name] ?? 0
      if (!(weight > 0)) throw new Error(`boardPressure: reference shape ${shape.name} has no base weight`)
      return Object.freeze({ name: shape.name, cells: shape.cells, weight })
    })
  const names = entries.map((entry) => entry.name)
  // Both halves of the choice above, asserted rather than assumed: a future edit that
  // drops Line 4 from SHAPES or renames it would silently change every R ever
  // reported, and the failure would look like a difficulty shift instead of a typo.
  if (!names.includes('Line 4')) throw new Error('boardPressure: the reference pool must contain Line 4')
  if (names.includes('Block 9')) throw new Error('boardPressure: the reference pool must not contain Block 9')
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0)
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry, share: entry.weight / totalWeight })))
})()

// The pool itself, as shape records with their base weights — the form the constructive
// fallback (dealer.js) needs, since it has to place real pieces, not just count them.
export const REFERENCE_POOL = POOL_ENTRIES
// The same pool by name, for callers that only report or filter.
export const REFERENCE_SHAPES = Object.freeze(POOL_ENTRIES.map((entry) => entry.name))
export const REFERENCE_WEIGHT = POOL_ENTRIES.reduce((sum, entry) => sum + entry.weight, 0)

// N(s, B): deduplicated legal physical placements of `s` on `B` (see placementModel —
// a Dot on a shared edge is one placement, not one per face that can see it).
export function placementCount(occ, cells) {
  return countPlacements(occ, cells)
}

export function availability(occ, cells) {
  return Math.min(countPlacements(occ, cells, AVAILABILITY_CAP), AVAILABILITY_CAP) / AVAILABILITY_CAP
}

// The spec's occupancy(B): occupied unique lattice cells over the 98 shell cells.
// Named `occupancyRatio` because `occupancy` in this codebase is the buffer itself.
export function occupancyRatio(occ) {
  return occupancyCount(occ) / CELL_COUNT
}

// Per-shape breakdown, so a report can say WHICH shape is stuck instead of only that
// the board is tight. `room` and `pressure` here are the same numbers the scalar
// helpers return; this is the expensive entry point (it counts every shape) and the
// reason the scalar room() below is built on the same single pass.
export function pressureDetail(occ) {
  let weighted = 0
  const shapes = REFERENCE_POOL.map((entry) => {
    // Uncapped here on purpose: this is the reporting path, and "Dot has 12
    // placements" would be a lie when it really has 61. The scalar room() below is
    // the hot path and does stop counting at the cap.
    const n = countPlacements(occ, entry.cells)
    const value = Math.min(n, AVAILABILITY_CAP) / AVAILABILITY_CAP
    weighted += entry.weight * value
    return Object.freeze({ name: entry.name, n, availability: value, weight: entry.weight })
  })
  const roomValue = weighted / REFERENCE_WEIGHT
  const occupancyValue = occupancyRatio(occ)
  return Object.freeze({
    room: roomValue,
    occupancy: occupancyValue,
    pressure: PRESSURE_MIX.room * (1 - roomValue) + PRESSURE_MIX.occupancy * occupancyValue,
    shapes: Object.freeze(shapes),
  })
}

// room(B) = Σ weight(s)·availability(s,B) / Σ weight(s)
export function room(occ) {
  let weighted = 0
  for (let i = 0; i < REFERENCE_POOL.length; i += 1) {
    const entry = REFERENCE_POOL[i]
    const n = countPlacements(occ, entry.cells, AVAILABILITY_CAP)
    weighted += entry.weight * (Math.min(n, AVAILABILITY_CAP) / AVAILABILITY_CAP)
  }
  return weighted / REFERENCE_WEIGHT
}

// R(B) = 0.75·(1 − room(B)) + 0.25·occupancy(B). Larger R = tighter.
//
// The 3:1 split is the producer's call (§6.1) and it is the right way round: room is
// the part that decides whether the next piece fits at all, occupancy is the tiebreak
// that separates two boards with equally many placements (a fuller cube has less slack
// left to absorb a bad deal). Because availability is monotone non-increasing in the
// occupied set and occupancy is monotone non-decreasing, R never falls when cells are
// added — tools/deal-core-tests.mjs pins that, and it is what lets the director compare
// "before" and "after" a placement without a second measurement.
export function pressure(occ) {
  return PRESSURE_MIX.room * (1 - room(occ)) + PRESSURE_MIX.occupancy * occupancyRatio(occ)
}

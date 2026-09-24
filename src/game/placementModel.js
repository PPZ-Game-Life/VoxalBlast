// Fast, allocation-light occupancy model for the dealer's batch search.
//
// v0.9.0 P2 (the producer's 2026-09-23 dealing spec, §5): the dealer has to answer
// "can these three pieces ALL be placed?" thousands of times per candidate batch, on
// a hot path (48 candidate batches × up to 24 sampled first moves each). `Board`
// cannot serve that path: every cell lookup builds a `${x},${y},${z}` string and
// every state is a `Map`, so a search node costs more in allocation than in thinking.
//
// So this module is a second *representation*, never a second rule book. The rule
// stays in board.js, and everything here is checked against Board cell-for-cell by
// tools/deal-core-tests.mjs (the differential gate the spec asks for). The settle
// below reproduces Board.place's semantics exactly, and each of those choices has a
// failure mode attached to it:
//   - legality = every cell in bounds and free, i.e. Board.canPlace with the same
//     origin range (0 .. SH-1-maxU), so a piece that only fits sideways is not
//     silently "no spot" (v0.2.26);
//   - clearing = every full line on ALL SIX faces in one batch (v0.3), because a
//     drop on +z can complete a row on -y through a shared edge cell;
//   - a shared edge/corner cell is ONE lattice cell. It is cleared once however many
//     lines cross it, and it is reachable from every face that can see it — which is
//     why the placement list below is deduplicated by cell set: a Dot on an edge is
//     one physical placement, not two, and counting it twice would inflate every
//     `N(s,B)` in boardPressure.js and the availability of the small pieces with it.
//
// Occupancy is a `Uint8Array(125)` indexed by the raw lattice coordinate (0 = free,
// 1 = occupied) rather than a 98-slot shell table: the index is one multiply per
// cell, the buffer is small enough to clone per search node, and a non-shell cell is
// impossible to reach through faceLattice() anyway (every face plane is on the
// shell). `occupancyCount` still counts only the 98 shell cells, so a stray core cell
// — which could never be placed or cleared — can never move a metric.
//
// Every inner loop here reads a FLAT Int32Array, never an array of frozen arrays.
// That is not style: measured on this machine, testing one 384-placement shape
// against a board costs ~7.1µs through `placement.indices[i]` and ~1.0µs through a
// flat `Int32Array` of the same numbers, and the dealer's analysis touches that loop
// thousands of times per batch. The frozen `indices`/`cells` arrays stay on the
// placement objects because they are the public, readable form (and the replay form).
import { SH, FACES, faceLattice, isShell } from './board.js'
import { normalizeCells, maxOrigin, rotateCells } from './shapes.js'

export const LATTICE_SIZE = SH * SH * SH

// Stable lattice index: x, then y, then z — the same order tools/difficulty-model.mjs
// uses for its bitboard, so a debugging session can compare the two by eye.
export function latticeIndex(x, y, z) {
  return (x * SH + y) * SH + z
}

// The 98 shell cells, in that same index order.
export const SHELL_CELLS = (() => {
  const cells = []
  for (let x = 0; x < SH; x += 1) {
    for (let y = 0; y < SH; y += 1) {
      for (let z = 0; z < SH; z += 1) {
        if (isShell(x, y, z)) cells.push(Object.freeze([x, y, z]))
      }
    }
  }
  return Object.freeze(cells)
})()

export const CELL_COUNT = SHELL_CELLS.length // 98
export const SHELL_INDICES = Object.freeze(SHELL_CELLS.map(([x, y, z]) => latticeIndex(x, y, z)))

// The 60 face lines, in Board.findAllFullLines() order (FACES order, rows before
// columns on each face). `indices` are lattice indices, `coords` the coordinates, so
// a differential failure prints the same cells on both sides of the comparison.
export const LINES = (() => {
  const lines = []
  for (const face of FACES) {
    for (let v = 0; v < SH; v += 1) {
      const coords = []
      for (let u = 0; u < SH; u += 1) coords.push(faceLattice(face, u, v))
      lines.push(makeLine(face, 'row', v, coords))
    }
    for (let u = 0; u < SH; u += 1) {
      const coords = []
      for (let v = 0; v < SH; v += 1) coords.push(faceLattice(face, u, v))
      lines.push(makeLine(face, 'col', u, coords))
    }
  }
  return Object.freeze(lines)
})()

function makeLine(face, axis, n, coords) {
  const frozen = coords.map(([x, y, z]) => Object.freeze([x, y, z]))
  return Object.freeze({
    face,
    axis,
    n, // v for a row, u for a column — the field names Board.findFullLines() uses
    coords: Object.freeze(frozen),
    indices: Object.freeze(frozen.map(([x, y, z]) => latticeIndex(x, y, z))),
  })
}

export const LINE_COUNT = LINES.length // 60

// The same 60 lines as one flat buffer, line `li` living at [li*SH, li*SH+SH), plus
// its face bit. The settle scan and the completion scan both walk this.
const LINE_FLAT = (() => {
  const flat = new Int32Array(LINE_COUNT * SH)
  LINES.forEach((line, li) => line.indices.forEach((index, k) => { flat[li * SH + k] = index }))
  return flat
})()
const LINE_FACE_BIT = (() => {
  const bits = new Int32Array(LINE_COUNT)
  LINES.forEach((line, li) => { bits[li] = 1 << FACES.indexOf(line.face) })
  return bits
})()

// Which lines pass through a given lattice cell. A corner cell is on 3 faces and
// therefore in 6 lines; this is the cheap half of the settle, used to count what a
// move *can* complete without scanning all 60 lines.
const LINES_BY_INDEX = (() => {
  const table = Array.from({ length: LATTICE_SIZE }, () => [])
  LINES.forEach((line, lineId) => {
    for (const index of line.indices) table[index].push(lineId)
  })
  return table
})()

const NO_LINES = Object.freeze([])

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

export function createOccupancy() {
  return new Uint8Array(LATTICE_SIZE)
}

export function cloneOccupancy(occ) {
  return occ.slice(0, LATTICE_SIZE)
}

// Convert a Board (or anything with the same `occupied()` shape) into an occupancy.
// A cell that is not on the shell cannot come from a legal placement, cannot be
// cleared by any line, and would therefore sit in the search as permanent debris —
// so it throws instead of being quietly dropped (same call as difficulty-model.mjs).
export function fromBoard(board) {
  const occ = createOccupancy()
  for (const cell of board.occupied()) {
    const { x, y, z } = cell
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !isShell(x, y, z)) {
      throw new Error(`placementModel: board holds a non-shell cell ${x},${y},${z}`)
    }
    occ[latticeIndex(x, y, z)] = 1
  }
  return occ
}

export function occupancyCount(occ) {
  let count = 0
  for (let i = 0; i < SHELL_INDICES.length; i += 1) {
    if (occ[SHELL_INDICES[i]] !== 0) count += 1
  }
  return count
}

export function occupiedCoords(occ) {
  const out = []
  for (let i = 0; i < SHELL_INDICES.length; i += 1) {
    if (occ[SHELL_INDICES[i]] !== 0) out.push(SHELL_CELLS[i].slice())
  }
  return out
}

// ---------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------

// Canonical key of a cell set, independent of order and of the input's origin.
export function shapeKey(cells) {
  return normalizeCells(cells).map(([u, v]) => `${u},${v}`).sort().join('|')
}

const tableCache = new Map()
// placement -> its table, so canPlace() is O(1) without putting a back-reference on
// the placement objects themselves (see buildTable).
const placementTable = new WeakMap()
// Identity cache in front of the key cache. The hot callers (boardPressure's reference
// pool, the solver's hand pieces) pass the SAME cell array over and over — 14 shapes ×
// 48 analyses, or 3 pieces × 24 samples — and rebuilding a canonical key for it means
// normalizing, sorting and joining a string on every lookup. Keying on the array object
// first turns that into a WeakMap hit.
const tableIdentity = new WeakMap()
const EMPTY_TABLE = Object.freeze({ placements: Object.freeze([]), flat: new Int32Array(0), offsets: new Int32Array(1) })

// Every distinct physical placement of a shape, in shape → rotation → face → origin
// order, plus the flat index buffer the fast paths use. Built once per shape and
// frozen: the cell set a (face, quarter, origin) triple covers does not depend on the
// board, so the "a Dot on an edge is ONE placement" deduplication is a property of the
// geometry and can be done here rather than on every search node. Two entries with the
// same cell set are always legal or illegal together, so filtering this list by the
// board is exactly the runtime deduplication the spec asks for — just paid once
// instead of per node.
export function shapeTable(cells) {
  if (!Array.isArray(cells) || cells.length === 0) return EMPTY_TABLE
  const byIdentity = tableIdentity.get(cells)
  if (byIdentity) return byIdentity
  const key = shapeKey(cells)
  let table = tableCache.get(key)
  if (!table) {
    table = buildTable(normalizeCells(cells))
    tableCache.set(key, table)
  }
  tableIdentity.set(cells, table)
  return table
}

// The public form: the placement objects themselves.
export function placementsFor(cells) {
  return shapeTable(cells).placements
}

function buildTable(base) {
  const seenOrientation = new Set()
  const seenCells = new Set()
  const placements = []
  for (let quarter = 0; quarter < 4; quarter += 1) {
    const shape = rotateCells(base, quarter)
    // A Dot (and Line 2/Line 4/Rect 6) has fewer than four distinct orientations;
    // skipping the repeats keeps the candidate list — and every count derived from
    // it — free of phantom placements that differ only by a label.
    const orientationKey = shape.map(([u, v]) => `${u},${v}`).join('|')
    if (seenOrientation.has(orientationKey)) continue
    seenOrientation.add(orientationKey)
    const { u: uMax, v: vMax } = maxOrigin(shape, SH)
    for (const face of FACES) {
      for (let u = 0; u < uMax; u += 1) {
        for (let v = 0; v < vMax; v += 1) {
          const indices = []
          const coords = []
          for (const [du, dv] of shape) {
            const [x, y, z] = faceLattice(face, u + du, v + dv)
            indices.push(latticeIndex(x, y, z))
            coords.push(Object.freeze([x, y, z]))
          }
          const cellKey = indices.slice().sort((a, b) => a - b).join(',')
          if (seenCells.has(cellKey)) continue
          seenCells.add(cellKey)
          const lineIds = []
          for (const index of indices) {
            for (const lineId of LINES_BY_INDEX[index]) {
              if (!lineIds.includes(lineId)) lineIds.push(lineId)
            }
          }
          lineIds.sort((a, b) => a - b)
          // How many of this placement's cells sit in each of those lines. Precomputed
          // so completionInfo() can decide "is this line full once I place?" with one
          // 5-cell scan per line instead of a nested membership test.
          const lineFill = new Int32Array(lineIds.length)
          lineIds.forEach((lineId, i) => {
            let count = 0
            for (const index of indices) {
              const line = LINES[lineId].indices
              for (let k = 0; k < line.length; k += 1) if (line[k] === index) { count += 1; break }
            }
            lineFill[i] = count
          })
          placements.push(Object.freeze({
            key: cellKey,
            index: placements.length, // its slot in the flat buffer below
            face,
            quarter,
            origin: Object.freeze({ u, v }),
            // The rotated, normalized cell list: `Board.place(face, cells, origin)`
            // accepts exactly this triple, which is what makes a witness replayable.
            cells: Object.freeze(shape.map((cell) => Object.freeze(cell.slice()))),
            indices: Object.freeze(indices),
            coords: Object.freeze(coords),
            lineIds: Object.freeze(lineIds),
            lineFill,
          }))
        }
      }
    }
  }
  const total = placements.reduce((sum, placement) => sum + placement.indices.length, 0)
  const flat = new Int32Array(total)
  const offsets = new Int32Array(placements.length + 1)
  let at = 0
  placements.forEach((placement, i) => {
    offsets[i] = at
    for (const index of placement.indices) flat[at++] = index
  })
  offsets[placements.length] = at
  const table = Object.freeze({ placements: Object.freeze(placements), flat, offsets })
  // Each placement remembers the table it belongs to, so `canPlace(occ, placement)`
  // can jump straight to its own flat span. A WeakMap rather than a field on the
  // placement: the placement objects are handed to callers (and to tests) and a
  // placement → table → placements cycle would break JSON.stringify of a witness.
  for (const placement of placements) placementTable.set(placement, table)
  return table
}

// Is placement #p of `table` free on this occupancy? One tight loop over the flat
// buffer — this is the single hottest line of the dealer's analysis.
function fitsAt(occ, table, p) {
  const flat = table.flat
  const from = table.offsets[p]
  const to = table.offsets[p + 1]
  for (let i = from; i < to; i += 1) {
    if (occ[flat[i]] !== 0) return false
  }
  return true
}

export function canPlace(occ, placement) {
  const table = placementTable.get(placement)
  return table ? fitsAt(occ, table, placement.index) : false
}

// Every legal physical placement of `cells` on this occupancy, in stable order.
export function enumeratePlacements(occ, cells) {
  const table = shapeTable(cells)
  const legal = []
  for (let p = 0; p < table.placements.length; p += 1) {
    if (fitsAt(occ, table, p)) legal.push(table.placements[p])
  }
  return legal
}

// N(s,B) of boardPressure.js. `cap` short-circuits the scan once the count can no
// longer matter (availability saturates at 12, so room() never needs the 13th) —
// the returned value is exact only when cap is Infinity or N ≤ cap, and both
// callers only ever read min(N, cap).
export function countPlacements(occ, cells, cap = Infinity) {
  const table = shapeTable(cells)
  let count = 0
  for (let p = 0; p < table.placements.length; p += 1) {
    if (!fitsAt(occ, table, p)) continue
    count += 1
    if (count >= cap) return count
  }
  return count
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

// Apply a placement and settle every full line on the cube, byte-identical to
// Board.place: set the cells, find every full line on all six faces, delete the
// UNION of their cells (so a shared cell crossed by several lines is deleted once).
//
// `out` is the destination buffer. Passing one lets a search reuse a scratch
// occupancy; passing the input occupancy itself is legal and settles in place. The
// detail returned is what the caller needs to score or to rank a move: `lines`
// (every full line, in the 60-line order), `facesHit`, `faceMask` (bit i = FACES[i]),
// `cellsCleared` and `clearedIndices` (the deduplicated union).
export function applyPlacement(occ, placement, out = new Uint8Array(LATTICE_SIZE)) {
  if (out !== occ) out.set(occ.subarray(0, LATTICE_SIZE))
  const indices = placement.indices
  for (let i = 0; i < indices.length; i += 1) out[indices[i]] = 1

  // Allocated only when something actually clears: most nodes of a search settle onto
  // a board with no full line, and an empty array per node is pure GC pressure.
  let lines = null
  let cleared = null
  let faceMask = 0
  let facesHit = 0
  for (let li = 0; li < LINE_COUNT; li += 1) {
    const base = li * SH
    let full = true
    for (let k = 0; k < SH; k += 1) {
      if (out[LINE_FLAT[base + k]] === 0) { full = false; break }
    }
    if (!full) continue
    if (lines === null) lines = []
    lines.push(LINES[li])
    const bit = LINE_FACE_BIT[li]
    if ((faceMask & bit) === 0) { faceMask |= bit; facesHit += 1 }
    if (cleared === null) cleared = new Set()
    for (let k = 0; k < SH; k += 1) cleared.add(LINE_FLAT[base + k])
  }

  let clearedIndices = NO_LINES
  if (cleared !== null) {
    clearedIndices = lines.length === 1 ? lines[0].indices : Array.from(cleared)
    for (let i = 0; i < clearedIndices.length; i += 1) out[clearedIndices[i]] = 0
  }
  return {
    occ: out,
    lines: lines ?? NO_LINES,
    facesHit,
    faceMask,
    cellsCleared: clearedIndices.length,
    clearedIndices,
  }
}

// What a move WOULD clear, counted only on the lines that pass through the placed
// cells. That shortcut is exact whenever the incoming state has no already-full line
// — true of every state applyPlacement produced, and of every state fromBoard() can
// read off a real board, because a board is only ever handed on after a settle. It
// exists for move ORDERING inside the solver (and for ranking the "clears first"
// sample in handSolver.analyzeBatch); it must never be used to clear anything, where
// the full 60-line scan above is the rule.
export function completionInfo(occ, placement) {
  const lineIds = placement.lineIds
  const lineFill = placement.lineFill
  let lines = 0
  let cleared = null
  for (let i = 0; i < lineIds.length; i += 1) {
    const base = lineIds[i] * SH
    // The placement's own cells are not in `occ` yet — that is the whole point of the
    // move — so the line is full afterwards exactly when the number of empty cells it
    // still shows equals the number of cells this placement fills in it.
    const need = lineFill[i]
    let missing = 0
    for (let k = 0; k < SH; k += 1) {
      if (occ[LINE_FLAT[base + k]] === 0) {
        missing += 1
        if (missing > need) break
      }
    }
    if (missing !== need) continue
    lines += 1
    if (cleared === null) cleared = new Set()
    for (let k = 0; k < SH; k += 1) cleared.add(LINE_FLAT[base + k])
  }
  return { lines, cellsCleared: cleared === null ? 0 : cleared.size }
}

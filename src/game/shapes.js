// Flat 2D polyomino pool for the cube-face placement model.
// Placements snap onto one of the six faces of the cube; each face is a flat
// grid, so shapes are two-dimensional (u, v) only. Pieces keep a fixed
// orientation (no player rotation) — see docs/Planning/02 & 03.
//
// v0.2.24: the face shrank to 5×5, so the 5-long line was dropped from the pool
// — on a 5-wide face it could only ever be placed on a completely empty row and
// would instantly clear that line, handing out free points and rescuing almost
// every "no legal placement" game over. 4 is therefore the longest line.
//
// Each cell is [u, v] relative to the shape's top-left origin at (0,0).
export const SHAPES = [
  { name: 'Dot',    color: 0xff6d5c, cells: [[0, 0]] },
  { name: 'Line 2', color: 0x35c3ff, cells: [[0, 0], [1, 0]] },
  { name: 'Line 3', color: 0xffcb1f, cells: [[0, 0], [1, 0], [2, 0]] },
  { name: 'Line 4', color: 0x2fd89b, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { name: 'Square', color: 0xa349ff, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { name: 'L',      color: 0xff8a2a, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  { name: 'J',      color: 0x4a6cff, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  { name: 'T',      color: 0xff5d6f, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  { name: 'S',      color: 0x00c2a0, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  { name: 'Z',      color: 0xc24bff, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  { name: 'Corner', color: 0x45d8f1, cells: [[0, 0], [1, 0], [0, 1]] },
]

// Normalize a set of 2D cells so the minimum u/v is 0 (top-left origin).
export function normalizeCells(cells) {
  const min = [0, 1].map((axisIndex) => Math.min(...cells.map((cell) => cell[axisIndex])))
  return cells.map((cell) => cell.map((value, index) => value - min[index]))
}

// Largest origin offset for a set of cells within a face of `faceSize`.
export function maxOrigin(cells, faceSize) {
  const maxU = Math.max(...cells.map(([u]) => u))
  const maxV = Math.max(...cells.map(([, v]) => v))
  return { u: faceSize - maxU, v: faceSize - maxV }
}

// Rotate a normalized cell set by `quarter` × 90° steps in the (u,v) plane and
// re-normalize it to a top-left origin. Used to reason about every in-plane
// orientation a piece can reach once the cube is turned.
export function rotateCells(cells, quarter = 1) {
  let out = cells.map(([u, v]) => [u, v])
  const turns = ((quarter % 4) + 4) % 4
  for (let i = 0; i < turns; i += 1) out = normalizeCells(out.map(([u, v]) => [-v, u]))
  return out
}

export function cellExtent(cells) {
  const maxU = Math.max(...cells.map(([u]) => u))
  const maxV = Math.max(...cells.map(([, v]) => v))
  return { u: maxU + 1, v: maxV + 1 }
}

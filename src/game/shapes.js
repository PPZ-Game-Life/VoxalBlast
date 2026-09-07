export const SHAPES = [
  { name: 'Line 3', color: 0xf04452, cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
  { name: 'Big L', color: 0x354bff, cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [3, 1, 0]] },
  { name: 'L', color: 0x20de35, cells: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [2, 1, 0]] },
  { name: 'Square', color: 0xd13dda, cells: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]] },
  { name: 'Corner', color: 0xff920d, cells: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] },
  { name: 'Tri-cube', color: 0x45d8f1, cells: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
  { name: 'Block', color: 0xe9eeff, cells: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] },
]

export function rotateCells(cells, axis) {
  const rotated = cells.map(([x, y, z]) => {
    if (axis === 'x') return [x, -z, y]
    if (axis === 'y') return [z, y, -x]
    return [-y, x, z]
  })
  const min = [0, 1, 2].map((axisIndex) => Math.min(...rotated.map((cell) => cell[axisIndex])))
  return rotated.map((cell) => cell.map((value, index) => value - min[index]))
}

export function keyOf(x, y, z) {
  return `${x},${y},${z}`
}

export function normalizeCells(cells) {
  const min = [0, 1, 2].map((axisIndex) => Math.min(...cells.map((cell) => cell[axisIndex])))
  return cells.map((cell) => cell.map((value, index) => value - min[index]))
}

import { keyOf } from './shapes.js'

export const SIZE = 5

export class Board {
  constructor() {
    this.cells = new Map()
    this.score = 0
    this.totalLines = 0
  }

  clear() {
    this.cells.clear()
    this.score = 0
    this.totalLines = 0
  }

  canPlace(cells, origin) {
    return cells.every(([x, y, z]) => {
      const px = x + origin.x
      const py = y + origin.y
      const pz = z + origin.z
      return px >= 0 && px < SIZE && py >= 0 && py < SIZE && pz >= 0 && pz < SIZE && !this.cells.has(keyOf(px, py, pz))
    })
  }

  place(cells, origin, color) {
    cells.forEach(([x, y, z]) => {
      const px = x + origin.x
      const py = y + origin.y
      const pz = z + origin.z
      this.cells.set(keyOf(px, py, pz), { x: px, y: py, z: pz, color })
    })
    const lines = this.findFullLines()
    const cleared = new Set(lines.flatMap((line) => line.cells.map(([x, y, z]) => keyOf(x, y, z))))
    cleared.forEach((key) => this.cells.delete(key))
    const multiplier = lines.length === 1 ? 1 : lines.length === 2 ? 3 : lines.length === 3 ? 6 : 10
    const points = lines.length ? 100 * lines.length * multiplier : 0
    this.score += points
    this.totalLines += lines.length
    return { lines, cleared, points }
  }

  findFullLines() {
    const lines = []
    for (let y = 0; y < SIZE; y += 1) for (let z = 0; z < SIZE; z += 1) {
      const cells = Array.from({ length: SIZE }, (_, x) => [x, y, z])
      if (cells.every(([x, yy, zz]) => this.cells.has(keyOf(x, yy, zz)))) lines.push({ axis: 'x', cells })
    }
    for (let x = 0; x < SIZE; x += 1) for (let z = 0; z < SIZE; z += 1) {
      const cells = Array.from({ length: SIZE }, (_, y) => [x, y, z])
      if (cells.every(([xx, y, zz]) => this.cells.has(keyOf(xx, y, zz)))) lines.push({ axis: 'y', cells })
    }
    for (let x = 0; x < SIZE; x += 1) for (let y = 0; y < SIZE; y += 1) {
      const cells = Array.from({ length: SIZE }, (_, z) => [x, y, z])
      if (cells.every(([xx, yy, z]) => this.cells.has(keyOf(xx, yy, z)))) lines.push({ axis: 'z', cells })
    }
    return lines
  }

  candidateCells() {
    const candidates = new Set()
    for (let y = 0; y < SIZE; y += 1) for (let z = 0; z < SIZE; z += 1) {
      const row = Array.from({ length: SIZE }, (_, x) => [x, y, z])
      const missing = row.filter(([x, yy, zz]) => !this.cells.has(keyOf(x, yy, zz)))
      if (missing.length > 0 && missing.length <= 2) missing.forEach((cell) => candidates.add(keyOf(...cell)))
    }
    for (let x = 0; x < SIZE; x += 1) for (let z = 0; z < SIZE; z += 1) {
      const row = Array.from({ length: SIZE }, (_, y) => [x, y, z])
      const missing = row.filter(([xx, y, zz]) => !this.cells.has(keyOf(xx, y, zz)))
      if (missing.length > 0 && missing.length <= 2) missing.forEach((cell) => candidates.add(keyOf(...cell)))
    }
    for (let x = 0; x < SIZE; x += 1) for (let y = 0; y < SIZE; y += 1) {
      const row = Array.from({ length: SIZE }, (_, z) => [x, y, z])
      const missing = row.filter(([xx, yy, z]) => !this.cells.has(keyOf(xx, yy, z)))
      if (missing.length > 0 && missing.length <= 2) missing.forEach((cell) => candidates.add(keyOf(...cell)))
    }
    return candidates
  }
}

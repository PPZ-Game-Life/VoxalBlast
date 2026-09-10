// Cube-face placement on the OUTER SHELL of a 5×5×5 lattice.
// The cube is a 5×5×5 grid of unit cells (one 5×5 grid per face); placement is
// allowed only on the exposed shell (x/y/z at 0 or CUBE-1). Cells are keyed by
// their lattice coordinate (x,y,z), so blocks on an edge or corner are shared by
// the adjacent faces — exactly one cube there, not one per face.
import { maxOrigin } from './shapes.js'

export const SH = 5 // shell lattice size per axis (v0.2.24: 6 → 5)
export const FACES = ['+x', '-x', '+y', '-y', '+z', '-z']

// Map a face's local grid (u in the first in-plane axis, v in the second) to a
// lattice cell (x,y,z). The plane axis is pinned to the shell layer.
const FACE_LATTICE = {
  '+z': (u, v) => [u, v, SH - 1],
  '-z': (u, v) => [u, v, 0],
  '+x': (u, v) => [SH - 1, u, v],
  '-x': (u, v) => [0, u, v],
  '+y': (u, v) => [u, SH - 1, v],
  '-y': (u, v) => [u, 0, v],
}

export function faceLattice(face, u, v) {
  return FACE_LATTICE[face](u, v)
}

export function isShell(x, y, z) {
  return x === 0 || x === SH - 1 || y === 0 || y === SH - 1 || z === 0 || z === SH - 1
}

export class Board {
  constructor() {
    this.cells = new Map() // key `${x},${y},${z}` -> { x, y, z, color }
    this.score = 0
    this.totalLines = 0
  }

  clear() {
    this.cells.clear()
    this.score = 0
    this.totalLines = 0
  }

  key(x, y, z) {
    return `${x},${y},${z}`
  }

  inBounds(x, y, z) {
    return x >= 0 && x < SH && y >= 0 && y < SH && z >= 0 && z < SH
  }

  has(x, y, z) {
    return this.cells.has(this.key(x, y, z))
  }

  canPlace(face, cells, origin) {
    return cells.every(([u, v]) => {
      const [x, y, z] = faceLattice(face, u + origin.u, v + origin.v)
      return this.inBounds(x, y, z) && !this.cells.has(this.key(x, y, z))
    })
  }

  place(face, cells, origin, color) {
    cells.forEach(([u, v]) => {
      const [x, y, z] = faceLattice(face, u + origin.u, v + origin.v)
      this.cells.set(this.key(x, y, z), { x, y, z, color })
    })
    const lines = this.findFullLines(face)
    const cleared = new Set()
    lines.forEach((line) => line.cells.forEach(([x, y, z]) => cleared.add(this.key(x, y, z))))
    cleared.forEach((key) => this.cells.delete(key))
    const multiplier = lines.length === 1 ? 1 : lines.length === 2 ? 3 : lines.length === 3 ? 6 : 10
    const points = lines.length ? 100 * lines.length * multiplier : 0
    this.score += points
    this.totalLines += lines.length
    return { lines, cleared, points }
  }

  // Item tools remove cubes without scoring, clearing lines or advancing turns.
  removeAt(x, y, z) {
    return this.cells.delete(this.key(x, y, z))
  }

  removeCells(list) {
    // list entries are lattice cells [x,y,z]
    const removed = []
    list.forEach(([x, y, z]) => {
      if (this.cells.delete(this.key(x, y, z))) removed.push([x, y, z])
    })
    return removed
  }

  findFullLines(face) {
    const lines = []
    for (let v = 0; v < SH; v += 1) {
      const cells = []
      for (let u = 0; u < SH; u += 1) cells.push(faceLattice(face, u, v))
      if (cells.every(([x, y, z]) => this.cells.has(this.key(x, y, z)))) lines.push({ axis: 'row', v, face, cells })
    }
    for (let u = 0; u < SH; u += 1) {
      const cells = []
      for (let v = 0; v < SH; v += 1) cells.push(faceLattice(face, u, v))
      if (cells.every(([x, y, z]) => this.cells.has(this.key(x, y, z)))) lines.push({ axis: 'col', u, face, cells })
    }
    return lines
  }

  // True if the piece fits somewhere on ANY face (the cube can be rotated freely).
  anyPlacement(cells) {
    if (cells.length === 0) return false
    for (const face of FACES) {
      const { u: uMax, v: vMax } = maxOrigin(cells, SH)
      for (let u = 0; u < uMax; u += 1) for (let v = 0; v < vMax; v += 1) {
        if (this.canPlace(face, cells, { u, v })) return true
      }
    }
    return false
  }

  // All occupied shell cells (lattice coordinates), for rendering.
  occupied() {
    return Array.from(this.cells.values())
  }
}

// Cube-face placement on the OUTER SHELL of a 5×5×5 lattice.
// The cube is a 5×5×5 grid of unit cells (one 5×5 grid per face); placement is
// allowed only on the exposed shell (x/y/z at 0 or CUBE-1). Cells are keyed by
// their lattice coordinate (x,y,z), so blocks on an edge or corner are shared by
// the adjacent faces — exactly one cube there, not one per face.
//
// v0.3 — clearing settles ALL SIX faces (docs/Planning/08 §1/§3, 02 §2). Because
// of that sharing, a drop on +z can complete a row on -y; settling only the face
// played left such a line sitting there full, and the player had to drop a second
// piece to make it go away. This module owns the rule only — the score lives in
// scoring.js, the honors in honors.js. `place()` reports what happened and
// nothing else.
import { normalizeCells, maxOrigin, rotateCells } from './shapes.js'

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

  // Drop a piece on `face` and settle every full line on the cube in the same
  // batch. Returns the resolution only (no score): `linesByFace` groups the
  // settled lines by the face they live on, `facesHit` is how many distinct faces
  // took part, `cellsCleared` counts the SHELL CELLS actually deleted (a shared
  // edge/corner cell crossed by several lines is still one cube) while `lines`
  // counts every line — the same cell can be in two rows and a column at once.
  place(face, cells, origin, color) {
    const occupancyBefore = {}
    FACES.forEach((faceKey) => { occupancyBefore[faceKey] = this.faceOccupancy(faceKey) })
    cells.forEach(([u, v]) => {
      const [x, y, z] = faceLattice(face, u + origin.u, v + origin.v)
      this.cells.set(this.key(x, y, z), { x, y, z, color })
    })
    const lines = this.findAllFullLines()
    const linesByFace = {}
    lines.forEach((line) => {
      if (!linesByFace[line.face]) linesByFace[line.face] = []
      linesByFace[line.face].push(line)
    })
    const cleared = new Set()
    lines.forEach((line) => line.cells.forEach(([x, y, z]) => cleared.add(this.key(x, y, z))))
    cleared.forEach((key) => this.cells.delete(key))
    const occupancy = {}
    FACES.forEach((faceKey) => { occupancy[faceKey] = this.faceOccupancy(faceKey) })
    return {
      face,
      lines,
      linesByFace,
      facesHit: Object.keys(linesByFace).length,
      cellsCleared: cleared.size,
      // Faces left with nothing on them after the settle. A face can be empty from
      // the opening layout too, so `faceWiped` is the one to read for "this move
      // emptied a face": it only counts faces that had cells before the drop. A
      // shared edge cell can empty a face that never had a line of its own.
      faceEmpty: FACES.filter((faceKey) => occupancy[faceKey] === 0),
      faceWiped: FACES.filter((faceKey) => occupancyBefore[faceKey] > 0 && occupancy[faceKey] === 0),
    }
  }

  // Running totals (the HUD reads them). Scoring itself lives in scoring.js; the
  // board only accumulates what it is handed so the two stay independent.
  addScore(points, linesCleared = 0) {
    this.score += points
    this.totalLines += linesCleared
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

  // Every full row/column on this one face.
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

  // Every full line on all six faces, in FACES order and rows before columns on
  // each face. v0.3: this is what place() settles — see the file header.
  findAllFullLines() {
    return FACES.flatMap((face) => this.findFullLines(face))
  }

  // Occupied cells as seen from one face (its 25 lattice cells; edge and corner
  // cells are counted by each face that can see them).
  faceOccupancy(face) {
    let occupied = 0
    for (let u = 0; u < SH; u += 1) {
      for (let v = 0; v < SH; v += 1) {
        const [x, y, z] = faceLattice(face, u, v)
        if (this.cells.has(this.key(x, y, z))) occupied += 1
      }
    }
    return occupied
  }

  // Is a row or column on this face already full? Cheap enough to use as a guard
  // (findFullLines() builds every line it finds, which the opening seeder would
  // only throw away).
  hasFullLine(face) {
    for (let v = 0; v < SH; v += 1) {
      if (Array.from({ length: SH }, (_, u) => faceLattice(face, u, v)).every(([x, y, z]) => this.cells.has(this.key(x, y, z)))) return true
    }
    for (let u = 0; u < SH; u += 1) {
      if (Array.from({ length: SH }, (_, v) => faceLattice(face, u, v)).every(([x, y, z]) => this.cells.has(this.key(x, y, z)))) return true
    }
    return false
  }

  hasFullLineOnAnyFace() {
    return FACES.some((face) => this.hasFullLine(face))
  }

  // ---- Opening layout (v0.2.31) ---------------------------------------------
  // Seed a starting position instead of an empty shell. `plan` maps a face to how
  // many CELLS to fill on it (a target, not a shape count: shapes run from 1 to 4
  // cells, so seeding "2 shapes" could put two single blocks on the play surface
  // or eight, and the opening would swing between bare and crowded from one game
  // to the next). `shapePool` is the same pool the candidate slots draw from, so
  // the colors on the cube are exactly the candidate colors. Two rules make a
  // seeded board indistinguishable from a played one:
  //   - no overlap (canPlace, which also keeps every cell on the shell), and
  //   - no completed line on ANY face. A seeded line would be a free clear for the
  //     first placement to touch it, and the opening layout is decoration: it may
  //     never hand out a line the player did not build.
  // Returns the seeds it managed to place. A face may end up under its target if
  // the random attempts keep colliding — an opening layout is decoration, never a
  // source of stuck states, so it may never score or clear.
  seedOpening(shapePool, plan, random = Math.random) {
    const seeded = []
    Object.entries(plan).forEach(([face, targetCells]) => {
      let filled = 0
      // The guard caps the number of shapes per face (a target of 7 cells cannot
      // legitimately need more than 7 attempts, and every retry is a fresh shape).
      for (let guard = 0; filled < targetCells && guard < 8; guard += 1) {
        const seed = this.seedOne(face, shapePool, random)
        if (!seed) continue
        seeded.push(seed)
        filled += seed.cells.length
      }
    })
    return seeded
  }

  seedOne(face, shapePool, random, attempts = 40) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const shape = shapePool[Math.floor(random() * shapePool.length)]
      const cells = normalizeCells(shape.cells)
      const { u: uMax, v: vMax } = maxOrigin(cells, SH)
      const origin = { u: Math.floor(random() * uMax), v: Math.floor(random() * vMax) }
      if (!this.canPlace(face, cells, origin)) continue
      const added = cells.map(([u, v]) => faceLattice(face, u + origin.u, v + origin.v))
      added.forEach(([x, y, z]) => this.cells.set(this.key(x, y, z), { x, y, z, color: shape.color }))
      if (this.hasFullLineOnAnyFace()) {
        added.forEach(([x, y, z]) => this.cells.delete(this.key(x, y, z)))
        continue
      }
      return { face, name: shape.name, cells: added }
    }
    return null
  }

  // True if the piece fits somewhere on ANY face (the cube can be rotated
  // freely). v0.2.26: a placement keeps the candidate's screen-facing
  // orientation, so the four in-plane rotations are exactly what the player can
  // reach by rolling/yawing the cube before dropping the piece. Checking only
  // the raw orientation would call a sideways-only fit "no spot" and end the
  // game one turn early.
  anyPlacement(cells) {
    if (cells.length === 0) return false
    for (const face of FACES) {
      for (let quarter = 0; quarter < 4; quarter += 1) {
        const shape = rotateCells(cells, quarter)
        const { u: uMax, v: vMax } = maxOrigin(shape, SH)
        for (let u = 0; u < uMax; u += 1) for (let v = 0; v < vMax; v += 1) {
          if (this.canPlace(face, shape, { u, v })) return true
        }
      }
    }
    return false
  }

  // All occupied shell cells (lattice coordinates), for rendering.
  occupied() {
    return Array.from(this.cells.values())
  }
}

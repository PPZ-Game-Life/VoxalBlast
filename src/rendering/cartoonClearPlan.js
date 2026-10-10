// Cartoon clear planner — the pure half of CARTOON_CLEAR_VFX_HANDOFF §4.
//
// This module decides WHAT a normal clear looks like and never touches a pixel: which face lines
// are really the same physical line, how many distinct cells were cleared, where the emitters go,
// which faces have to show an outline, and what the event's budget is. `rendering/effects.js`
// consumes the plan; nothing here imports THREE, the board, the scene or the clock, so the §9.1
// table can be asserted in a plain `node` process (tools/cartoon-clear-plan-tests.mjs).
//
// The one thing this file exists to fix: `Board.place()` reports lines PER FACE, so a shared edge
// or a shared corner reaches the presentation layer twice. Measured on HEAD bf03464f, a plain
// two-line crossing arrived as three raw lines and a five-line crossing as seven, and the old
// budget was chosen from that inflated count. §4.1 splits the two ideas apart:
//
//   physicalLines   — the same space segment, reported once. THIS is the budget input.
//   faceFootprints  — every face that really reported a line. These draw the outlines, so
//                     de-duplicating the budget can never hide a visible surface's confirmation.

/** Stable face order for tie-breaks: never let enumeration order pick an emission direction. */
export const FACE_ORDER = Object.freeze(['+z', '+x', '-x', '+y', '-y', '-z'])

const FACE_RANK = Object.freeze({ '+z': 0, '+x': 1, '-x': 2, '+y': 3, '-y': 4, '-z': 5 })

const key3 = (cell) => `${cell[0]},${cell[1]},${cell[2]}`

/** The physical identity of a face line: its cell set, order-independent. */
export function physicalKey(line) {
  return line.cells.map(key3).sort().join('|')
}

function indexOfLine(line) {
  return line.axis === 'row' ? line.v : line.u
}

/**
 * §4.1/§4.2. `lines` are board.js's raw face lines (each with `face`, `axis`, `v`/`u`, `cells`).
 * `frontFace` is the face the player is looking at (boardView's `findFrontFace()`), used to pick
 * which of several faces sharing one segment owns the emission direction; `visibleFaces` is the
 * ordered preference list of faces the camera can actually see.
 */
export function planClear(lines, { frontFace = null, visibleFaces = [], maxOutlineCells = 150 } = {}) {
  const physical = new Map()
  const footprints = []
  const seenFaceLine = new Set()

  for (const line of lines || []) {
    if (!line || !Array.isArray(line.cells) || !line.cells.length) continue
    const footprintKey = `${line.face}|${line.axis}|${indexOfLine(line)}`
    // A weapon-of-last-resort guard, not the de-duplication itself: board.js does not repeat a
    // (face, axis, index) triple today, and if it ever did the outline would be drawn twice.
    if (seenFaceLine.has(footprintKey)) continue
    seenFaceLine.add(footprintKey)
    footprints.push({
      face: line.face,
      axis: line.axis,
      index: indexOfLine(line),
      cells: line.cells.map((cell) => [cell[0], cell[1], cell[2]]),
    })
    const identity = physicalKey(line)
    let entry = physical.get(identity)
    if (!entry) {
      entry = { key: identity, cells: line.cells.map((cell) => [cell[0], cell[1], cell[2]]), reports: [] }
      physical.set(identity, entry)
    }
    entry.reports.push({ face: line.face, axis: line.axis, index: indexOfLine(line) })
  }

  const physicalLines = [...physical.values()].map((entry) => {
    // Ends along the line's own axis. Sorting the tuple is enough for all six faces: a face line
    // varies on exactly two coordinates and is constant on the third, so the lexicographic first
    // and last cells ARE its two ends.
    const sorted = [...entry.cells].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const axis = [0, 1, 2].find((i) => last[i] !== first[i]) ?? 0
    const outward = [0, 0, 0]
    outward[axis] = 1
    return {
      key: entry.key,
      cells: sorted,
      reports: entry.reports,
      // The face that owns this segment's emission direction. A face the camera can see wins;
      // `frontFace` wins outright; otherwise a stable face rank breaks the tie so the choice
      // never depends on the order board.js happened to enumerate its faces in.
      face: pickFace(entry.reports, { frontFace, visibleFaces }),
      axis,
      first,
      last,
      outward,
    }
  })

  const union = new Map()
  for (const line of physicalLines) for (const cell of line.cells) union.set(key3(cell), cell)
  const uniqueCells = [...union.values()]

  // A cell on two or more physical lines is an intersection: §4.2 allows it exactly ONE mark.
  const hits = new Map()
  for (const line of physicalLines) for (const cell of line.cells) {
    const key = key3(cell)
    hits.set(key, (hits.get(key) || 0) + 1)
  }
  const intersections = [...hits.entries()].filter(([, count]) => count > 1).map(([key]) => union.get(key))

  // §4.3 「每事件最多150个去重表面格」 — the outline may never be dropped for decoration, so it is
  // capped here, deterministically, rather than by whatever order the meshes were built in.
  const outlineCells = []
  const outlineSeen = new Set()
  for (const footprint of footprints) {
    for (const cell of footprint.cells) {
      const key = key3(cell)
      if (outlineSeen.has(key)) continue
      outlineSeen.add(key)
      outlineCells.push(cell)
    }
  }

  return {
    physicalLines,
    physicalLineCount: physicalLines.length,
    faceFootprints: footprints,
    uniqueCells,
    uniqueCellCount: uniqueCells.length,
    intersections,
    outlineCells: outlineCells.slice(0, maxOutlineCells),
    outlineCellCount: Math.min(outlineCells.length, maxOutlineCells),
    outlineTruncated: outlineCells.length > maxOutlineCells,
    // `rawLineCount` is kept only so a report can say how much duplication there was; it is
    // deliberately not what any budget is chosen from.
    rawLineCount: footprints.length,
    duplicatedReports: footprints.length - physicalLines.length,
  }
}

function pickFace(reports, { frontFace, visibleFaces }) {
  const faces = reports.map((report) => report.face)
  if (frontFace && faces.includes(frontFace)) return frontFace
  const visible = visibleFaces.filter((face) => faces.includes(face))
  const candidates = visible.length ? visible : faces
  return [...new Set(candidates)].sort((a, b) => (FACE_RANK[a] ?? 9) - (FACE_RANK[b] ?? 9))[0]
}

/**
 * §4.3's table, in the unit the handoff states it: the WHOLE event's new sprite decorations.
 * `reducedMotion` is a separate axis with its own row; `cramped` halves whatever row applies
 * (§4.3 「手机横屏/安全边距不足：装饰预算减半」) and never shrinks the board.
 */
export function clearBudget(physicalLineCount, { lowPower = false, reducedMotion = false, cramped = false } = {}) {
  if (reducedMotion) return 0
  const count = Math.max(0, Math.trunc(physicalLineCount) || 0)
  if (count <= 0) return 0
  const table = lowPower ? CARTOON_BUDGETS.lowPower : CARTOON_BUDGETS.standard
  const base = table[Math.min(count, 3)]
  return cramped ? Math.round(base * 0.5) : base
}

/** §4.3's table, kept here so config.js and the tests read the same numbers. */
export const CARTOON_BUDGETS = Object.freeze({
  standard: Object.freeze({ 1: 14, 2: 22, 3: 32 }),
  lowPower: Object.freeze({ 1: 7, 2: 11, 3: 16 }),
})

/**
 * §4.3's caps per event, in physical lines. `marks` counts stars/sparkles together (the doc
 * states them as one budget), `arcs` the swoosh/dash pair.
 */
export function clearCaps(physicalLineCount) {
  const count = Math.max(1, Math.trunc(physicalLineCount) || 1)
  if (count === 1) return { marks: 2, arcs: 2 }
  if (count === 2) return { marks: 4, arcs: 2 }
  return { marks: 4, arcs: 4 }
}

/** §5's wall-clock tail for this event. NOT multiplied by any slow-motion factor. */
export function clearTailSeconds(physicalLineCount) {
  const count = Math.max(0, Math.trunc(physicalLineCount) || 0)
  if (count <= 0) return 0
  return count === 1 ? 0.36 : 0.42
}

/**
 * §4.2's emitter list: the two ends of each physical line, rotated so the event's total is spread
 * across the lines rather than spent on the first one, capped at 8 positions and sampled stably
 * when there are more. The line outlines are NOT affected by this cap.
 */
export function emitterPositions(plan, { max = 8 } = {}) {
  const ends = []
  for (const line of plan.physicalLines) {
    ends.push({ cell: line.first, face: line.face, outward: line.outward.map((v) => -v), line: line.key })
    ends.push({ cell: line.last, face: line.face, outward: line.outward.map((v) => v), line: line.key })
  }
  // Merge ends that sit on the SAME cell (e.g. a two-line corner): one anchor, not two.
  const merged = new Map()
  for (const end of ends) {
    const key = key3(end.cell)
    if (!merged.has(key)) merged.set(key, end)
  }
  const unique = [...merged.values()]
  if (unique.length <= max) return unique
  // Stable sampling: evenly spaced over the list, never random, so the same board always picks
  // the same endpoints.
  const stride = unique.length / max
  return Array.from({ length: max }, (_, i) => unique[Math.floor(i * stride)])
}

/** Cells that should carry the small star flash: the intersections first, then the line ends. */
export function markPositions(plan, cap) {
  const marks = []
  const used = new Set()
  const push = (cell, face) => {
    if (marks.length >= cap) return
    const key = key3(cell)
    if (used.has(key)) return
    used.add(key)
    marks.push({ cell, face })
  }
  for (const cell of plan.intersections) push(cell, plan.physicalLines[0]?.face ?? null)
  for (const end of emitterPositions(plan, { max: 8 })) push(end.cell, end.face)
  return marks
}

/**
 * §4.2 「伪随机只影响方片角度/速度，使用独立VFX种子（event key + physical signature），不消耗
 * 发牌/棋盘随机源」. A 32-bit FNV-1a over the event's own identity: the same clear always throws
 * the same confetti, and the game's dealing RNG is never touched.
 */
export function vfxSeed(eventKey, plan) {
  const material = `${eventKey}|${plan.physicalLines.map((line) => line.key).join(';')}`
  let hash = 0x811c9dc5
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** mulberry32 over the VFX seed: stable, allocation-free, and never the game's stream. */
export function vfxRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

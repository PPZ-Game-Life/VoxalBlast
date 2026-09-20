// Shape geometry for the two games' boards: our 5x5 cube face (and the six-face cube)
// versus Block Blast's single 8x8 plane.
//
//   node tools/shape-geometry.mjs [gridSize ...]     # default: 5 8
//
// Why: docs/Technical/SHAPE_POOL_VS_BLOCKBLAST.md compares the two candidate pools. A
// shape's difficulty is not its cell count — it is how many windows it needs relative
// to the board it lands on. This prints that side by side, per family, for both boards.
//
// WHAT THIS IS: exact combinatorics on an empty board (a w×h piece, kept in its own
// orientation, has (N-w+1)×(N-h+1) origins) plus the one structural flag that matters
// most — whether a piece can ever clear a line BY ITSELF (only a solid 1×N / N×1 line
// can). It is NOT a simulation and says nothing about a crowded board; that is what
// tools/difficulty-abcd.mjs and tools/face-fragility.mjs measure.
//
// WHAT IS NOT VERIFIED: Block Blast's exact piece list. The inventory below is the
// canonical set reported by public gameplay material (official docs do not exist and
// the wiki could not be fetched), so every row carries a confidence mark. Treat the
// geometry as exact and the membership as provisional.
import { SHAPES } from '../src/game/shapes.js'

// Confidence: 'high' = unambiguous in public material, 'mid' = present in most
// summaries, 'low' = believed present but not confirmed.
const BLOCK_BLAST_FAMILIES = [
  { name: '1×1', cells: 1, w: 1, h: 1, orientations: 1, confidence: 'high' },
  { name: 'Line 2', cells: 2, w: 2, h: 1, orientations: 2, confidence: 'high' },
  { name: 'Line 3', cells: 3, w: 3, h: 1, orientations: 2, confidence: 'high' },
  { name: 'Line 4', cells: 4, w: 4, h: 1, orientations: 2, confidence: 'mid' },
  { name: 'Line 5', cells: 5, w: 5, h: 1, orientations: 2, confidence: 'mid' },
  { name: 'Square 2×2', cells: 4, w: 2, h: 2, orientations: 1, confidence: 'high' },
  { name: 'Rect 2×3', cells: 6, w: 3, h: 2, orientations: 2, confidence: 'high' },
  { name: 'Square 3×3', cells: 9, w: 3, h: 3, orientations: 1, confidence: 'high' },
  { name: 'Corner (3)', cells: 3, w: 2, h: 2, orientations: 4, confidence: 'high' },
  { name: 'L (4)', cells: 4, w: 3, h: 2, orientations: 4, confidence: 'high' },
  { name: 'J (4)', cells: 4, w: 3, h: 2, orientations: 4, confidence: 'high' },
  { name: 'T (4)', cells: 4, w: 3, h: 2, orientations: 4, confidence: 'high' },
  { name: 'S (4)', cells: 4, w: 3, h: 2, orientations: 2, confidence: 'high' },
  { name: 'Z (4)', cells: 4, w: 3, h: 2, orientations: 2, confidence: 'high' },
  { name: 'L (5, 3+3)', cells: 5, w: 3, h: 3, orientations: 4, confidence: 'mid' },
  { name: 'Slant / staircase (3)', cells: 3, w: 3, h: 3, orientations: 4, confidence: 'low' },
]

const sizes = (process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number))
const GRIDS = sizes.length ? sizes : [5, 8]

function bbox(cells) {
  let w = 0
  let h = 0
  for (const [u, v] of cells) { w = Math.max(w, u + 1); h = Math.max(h, v + 1) }
  return { w, h }
}

function geometry(w, h, size) {
  const origins = Math.max(0, size - w + 1) * Math.max(0, size - h + 1)
  return {
    origins,
    // A single piece clears a line by itself only when it IS a full line of the board.
    selfClears: (w === size && h === 1) || (h === size && w === 1),
    boardPct: Math.round((100 * w * h) / (size * size) * 10) / 10,
    linePct: Math.round((100 * Math.max(w, h)) / size * 10) / 10,
  }
}

console.log('=== 本作现行池（14 类，放置自动取平面内四朝向）')
console.log('shape       cells  bbox   orientations  ' + GRIDS.map((n) => `origins@${n}  selfClear@${n}  board%@${n}  line%@${n}`).join('  '))
for (const shape of SHAPES) {
  const { w, h } = bbox(shape.cells)
  const cols = GRIDS.map((n) => {
    const g = geometry(w, h, n)
    return `${String(g.origins).padStart(9)}  ${String(g.selfClears).padStart(12)}  ${String(g.boardPct).padStart(8)}  ${String(g.linePct).padStart(7)}`
  })
  console.log(`${shape.name.padEnd(11)} ${String(shape.cells.length).padStart(5)}  ${`${w}x${h}`.padStart(5)}  ${String(4).padStart(12)}  ${cols.join('  ')}`)
}
console.log('  （四格件与 Dot/Square/Block 9 的实际不同朝向数少于 4，见工具注释；此处一律按 4 朝向枚举上界）')

console.log('\n=== Block Blast 侧（8×8 单平面；清单来自公开资料，未获官方确认）')
console.log('family                  cells  bbox   orient  conf   origins@8  selfClear@8  board%@8  line%@8')
for (const piece of BLOCK_BLAST_FAMILIES) {
  const g = geometry(piece.w, piece.h, 8)
  console.log([
    piece.name.padEnd(23), String(piece.cells).padStart(5), `${piece.w}x${piece.h}`.padStart(5),
    String(piece.orientations).padStart(6), piece.confidence.padStart(6),
    String(g.origins).padStart(10), String(g.selfClears).padStart(12),
    String(g.boardPct).padStart(9), String(g.linePct).padStart(8),
  ].join('  '))
}

const variantTotal = BLOCK_BLAST_FAMILIES.reduce((sum, p) => sum + p.orientations, 0)
console.log(`\n固定朝向件合计（按上表朝向数展开）：${variantTotal} 件`)
const ourVariants = SHAPES.reduce((sum, s) => {
  const { w, h } = bbox(s.cells)
  const distinct = new Set()
  for (let q = 0; q < 4; q += 1) {
    const rot = s.cells.map(([u, v]) => q === 0 ? [u, v] : q === 1 ? [v, -u] : q === 2 ? [-u, -v] : [-v, u])
    const minU = Math.min(...rot.map(([u]) => u))
    const minV = Math.min(...rot.map(([, v]) => v))
    distinct.add(rot.map(([u, v]) => [u - minU, v - minV]).sort().map((p) => p.join(',')).join('|'))
  }
  void w; void h
  return sum + distinct.size
}, 0)
console.log(`本作 14 类展开后（同一形状的重复朝向合并）：${ourVariants} 件`)

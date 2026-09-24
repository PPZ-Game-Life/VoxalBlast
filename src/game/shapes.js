// Flat 2D polyomino pool for the cube-face placement model.
// Placements snap onto one of the six faces of the cube; each face is a flat
// grid, so shapes are two-dimensional (u, v) only. Pieces keep a fixed
// orientation (no player rotation) — see docs/Planning/02 & 03.
//
// v0.2.24 dropped the 5-long line: on a 5-wide face it could only ever land on a
// completely empty row, and it would instantly clear that row — free points, and
// a rescue from almost every "no legal placement" game over. v0.2.31 dropped the
// 4-long line as well, by the producer's call: it was the only piece that ate 80%
// of a face row, so whenever it fit it read as a free line instead of a choice.
//
// v0.9.0 (P1 of the producer's 2026-09-23 dealing spec, §3.1) puts **Line 4 BACK**,
// on the producer's explicit call, at an explicit weight of 1. Two corrections come
// with it, both of which the older notes above got wrong and neither of which is a
// reason to re-drop it:
//   - a 4-long line does NOT clear a line whenever it fits. On a 5-wide face it needs
//     a completely empty row (or column) to self-clear; on a half-full face it is an
//     80%-of-a-row commitment, which is pressure, not a free point. The old "放下必
//     清线" wording was inaccurate — see docs/Planning/02 §3.
//   - `Line 4` carries weight 1 **explicitly**, so it is the one exception to the
//     "a shape weighs 2 only if it is a four-cell piece" rule. Don't "fix" it to 2.
// `Line 5` stays out: on a 5-wide face it can only ever land on a completely empty
// row and clears it instantly, and P1 does not add it.
//
// Each cell is [u, v] relative to the shape's top-left origin at (0,0).
//
// v0.7 「田园木作」recoloured the pool to CRAYON PAINT: colours a wooden toy would
// actually be painted, rather than the fluorescent v0.5 set. Chroma comes down a
// step and the hues spread out, so the pieces stay distinguishable against a warm
// timber board AND against a green meadow. Keep them in the paint family — a neon
// colour here is what makes the whole scene read as "3D render" instead of "toy".
//
// v0.8.17 — the WOOD-FREE HUE BAND. The producer reported that a few candidates
// "和空置时候的木色方块太接近了，看不清". Measured in Lab against the three tones the
// board's timber actually renders as (front `#D3A36F`, base `#E4A16D`, top `#E3C7AC`),
// exactly four paints sat inside the wood's own warm band (hue ≤ 80°):
//
//   L      #EF9127 h32°  ΔE 30.5   ← the worst offender: an orange block ON an orange board
//   Line 3 #F2B52B h42°  ΔE 36.8   ← amber vs lit timber is ΔE 39 with the same luminance
//   Dot    #E8543F h 7°  ΔE 40.6
//   L 5    #93B23C h76°  ΔE 44.2
//
// A placed block and an empty one are the SAME cube in a different material (see
// BOARD_STYLE), so "is this cell filled?" is carried by colour and nothing else — a
// paint that lives in the timber's band answers that question wrongly. The rule now:
// **no paint may sit in the wood band.** Every colour must clear the wood either by
// HUE (≥ 35° away from the timber's ~27°) or by LIGHTNESS (|ΔL*| ≥ 22), which is what
// the four replacements do — the band 0–95° is now empty of paint:
//
//   Dot    #E8543F → #C22B58  raspberry       ΔE 40.6 → 56.0
//   Line 3 #F2B52B → #293894  deep navy       ΔE 36.8 → 90.5
//   L      #EF9127 → #217D6E  deep teal       ΔE 30.5 → 52.7
//   L 5    #93B23C → #90C22D  lime            ΔE 44.2 → 57.4
//
// Why these four and not "just darken the orange": the pool is 14 shapes and the
// wheel outside the band (95°–350°) already carries 10 of them, so the freed slots go
// to the families with room — a lime at h80 (the one remaining yellowish note, now
// 51° off the timber), a teal at h170, a navy at h232 and a raspberry at h342.
// Assignments respect the shape pairs: `L`/`J` are mirror images and must not both be
// blue, so navy went to `Line 3`, not to `L`.
//
// Two things this also fixes, both checked before shipping:
//   - `Dot` WAS bit-identical to `palette.invalid` (`#E8543F`), so dragging a Dot onto
//     an illegal cell painted the invalid ghost in the piece's own colour — the one
//     case where "no room here" was invisible. The raspberry is ΔE 33.6 off terracotta.
//   - The tightest NEW pair is `Line 3`/`J` at ΔE 16.8, no worse than the pairs the
//     pool already ships with (`J`/`Slant 3` 16.5, `Square`/`Block 9` 12.2).
// Full 14-colour table: docs/Planning/05 §3. Keep new colours inside the crayon family
// (S ≈ 0.55–0.85, V ≈ 0.45–0.90) — that, not the hue, is what still reads as "toy".
export const SHAPES = [
  { name: 'Dot',    color: 0xc22b58, cells: [[0, 0]] },
  { name: 'Line 2', color: 0x3f8fe0, cells: [[0, 0], [1, 0]] },
  { name: 'Line 3', color: 0x293894, cells: [[0, 0], [1, 0], [2, 0]] },
  // v0.9.0 P1: back in the shipped pool by the producer's call (2026-09-23 spec §3.1),
  // explicit weight 1, geometry [[0,0],[1,0],[2,0],[3,0]] — the definition the spec
  // names, and the same one the BB-alignment measurement arm has been using.
  //
  // Colour `#2121d9`: picked by the pool's own rule (v0.8.17 wood-free hue band), not
  // by eye — of every crayon-family colour (S 0.55–0.85, V 0.45–0.90) that clears the
  // timber, this one maximises the distance to the nearest shipped paint: ΔE 45.1 to
  // `Square`, 48.3 to `Block 9`, 51.1 to `Line 3`, and ≥130 to all three timber tones.
  // It keeps the "line family is blue" reading (`Line 2` sky, `Line 3` navy, `Line 4`
  // royal) while staying far outside every existing pair — the pool's own tightest
  // shipped pair is `J`/`Slant 3` at ΔE 16.5. Scan: tools/.tmp-line4-color.mjs.
  { name: 'Line 4', color: 0x2121d9, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { name: 'Square', color: 0x8b57c9, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { name: 'L',      color: 0x217d6e, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  { name: 'J',      color: 0x2f5fc4, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  { name: 'T',      color: 0xe0658f, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  { name: 'S',      color: 0x4faa4a, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  { name: 'Z',      color: 0xc03fa0, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  { name: 'Corner', color: 0x35b6c9, cells: [[0, 0], [1, 0], [0, 1]] },
  // v0.8.12, by the producer's ask: the two larger pieces. Both are the natural
  // one-step-up of something already in the pool rather than new silhouettes —
  // `Rect 6` is Square widened to 3×2, `L 5` is `L` with its arm and foot each
  // extended by a cell (3-tall arm, 3-wide foot, still a 3×3 bounding box).
  //
  // ⚠️ `L 5` deliberately stops at a 3-long line. The 4-long and 5-long LINES were
  // both removed on purpose (see the v0.2.24 / v0.2.31 notes above): on a 5-wide face
  // they land on an empty row, clear it instantly and read as a free point rather
  // than a choice. A 5-cell L drawn the other way (`[[0,0],[0,1],[0,2],[0,3],[1,3]]`,
  // the textbook L-pentomino) carries a 4-long arm and would put that problem back —
  // if the producer wants THAT silhouette, the line-length rule has to be revisited
  // in the same breath.
  { name: 'Rect 6', color: 0x3fa87a, cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]] },
  { name: 'L 5',    color: 0x90c22d, cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]] },
  // The staircase triomino — the third shape the producer asked for ("斜着的三个小块连着").
  // It is the second free triomino; `Corner` is the other one.
  //
  // Worth knowing before anyone "fixes" it: no two of its cells share a row or a
  // column, so this piece can never complete a line by itself, in any placement. It
  // is a pure filler — the rescue-hatch role a Dot or Line 2 plays, and the opposite
  // end of the pool from Rect 6 / Block 9. That is also why its weight stays 1.
  { name: 'Slant 3', color: 0x6a5fb0, cells: [[0, 0], [1, 1], [2, 2]] },
  // 3×3, the producer's "九个小块的 3✖️3". The biggest piece in the pool by a wide
  // margin: it covers 9 of a face's 25 cells (36%) and needs a 3×3 free region, of
  // which a 5-wide face has only 9 positions. Two things follow, and both are why it
  // is worth measuring rather than assuming:
  //   - it can never complete a line by itself (a face line is 5 cells and this is
  //     3 wide), so it never self-clears — it is pure board pressure;
  //   - a hand holding it is effectively a two-piece hand whenever the current face
  //     has no 3×3 hole, which is most of the time on a busy board. `board.anyPlacement`
  //     still scans all six faces, so it is a "rotate to find room" piece, not a dead
  //     card — but see docs/Technical/DIFFICULTY_TENSION.md for what it does to the
  //     ending rate before deciding to keep it at weight 1.
  { name: 'Block 9', color: 0xa94fc4, cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] },
]
// Candidate weights (v0.8.4; the pool grew in v0.8.12/13/14, the RULE did not). The six
// four-cell shapes carry weight 2 and every other shape carries 1. With the shipping
// 14-shape pool that is 20 weight units: 12/20 = 60% of dealt slots are four-cell
// pieces, and 15/20 = 75% are four cells or larger (the 77.8% quoted here before
// v0.8.14 was the twelve-shape pool). Nothing leaves the pool.
//
// Why: measurement found the equal-weight pool leaves a competent player 80+ legal
// placements on 81% of steps, with a tightest moment of 19 placements in a whole
// game (docs/Technical/DIFFICULTY_TENSION.md). Re-weighting is the mildest lever
// that lowers that slack without deleting a shape — a typical actor's tightest
// moment moves from 9 to 6 placements and natural endings rise from 1.0% to 4.2%.
// Deleting the small pieces is stronger (d/w90 reach 16-21%) but removes the
// rescue hatch a Dot or Line 2 provides on a crowded board. Weights are relative;
// only their ratios matter. Keep every shape above zero unless the producer
// explicitly asks for a smaller pool — and board.seedOpening keeps drawing
// uniformly from SHAPES, so the opening decoration follows the pool's membership.
//
// v0.8.12 measured the two new shapes at weight 1 as well as weight 2, because they
// are the largest pieces in the pool and "bigger pieces are more common" made
// weight 2 the obvious first guess. 1800 games per arm, seed 1/2/3, casual (random)
// actor, 600-step cap:
//
//                    ended    p50 steps   p90 steps   tight-move
//   ten-shape equal   99.3%      94          242        15.7%
//   old soft82       100.0%      83          185        19.6%
//   weight 1 (SHIP)  100.0%      50          113        17.7%
//   weight 2         100.0%      41           89        17.8%
//
// So either weight finally makes the casual game END (the long-standing goal was a
// 60–120-step median, and the pre-v0.8.12 pool sat above 600 for anything but random
// play). Weight 1 lands nearest that band, so it ships; weight 2 is the stronger
// dial if the producer wants more pressure, and it is a one-line change.
// v0.8.13 added `Slant 3` and v0.8.14 `Block 9` at weight 1 for the same reason: the
// rule is "a shape is weighted 2 only if it is a four-cell piece". The pool is now 14
// shapes and the shares are 12/20 four-cell, 15/20 for four cells or larger. The
// measurement quoted below was taken at v0.8.12 (twelve shapes); see
// DIFFICULTY_TENSION.md for the later re-runs, which is where Block 9's effect lands.
// v0.9.0 P1 breaks the rule in exactly one place (Line 4 = 1) and turns Block 9 down to
// 0.4 — read the two entries in the table below before touching either number.
export const SHAPE_WEIGHTS = Object.freeze({
  Dot: 1,
  'Line 2': 1,
  'Line 3': 1,
  Corner: 1,
  'Slant 3': 1,
  Square: 2,
  L: 2,
  J: 2,
  T: 2,
  S: 2,
  Z: 2,
  'Rect 6': 1,
  'L 5': 1,
  // v0.9.0 P1 (2026-09-23 spec §3.1): the two numbers this release is about.
  //   Line 4  — 1, explicit: the one exception to the four-cell rule (see its entry above).
  //   Block 9 — 0.4, down from 1. The spec's target is "keep the nine-cell block's
  //             strategic value, stop it monopolising the stuck states"; 0.4 is the
  //             arm `tools/difficulty-model.mjs` already measured (greedy ending rate
  //             92.5% → 69.5%), so the first experiment starts from a known point.
  // Total is 20.4 (was 20): Block 9's single-slot share drops 5.00% → 1.96%, Line 4
  // enters at 4.90%, four-cell pieces go 60.0% → 58.8%, four-cells-or-larger 75.0% →
  // 75.5%. These are BASE SAMPLING shares, not what the player finally sees: the batch
  // filter (≤1 Block 9, Block 9 cooldown, ≤2 of a shape per batch) and the difficulty
  // director both move the realised distribution — see docs/Planning/02 §3.
  'Line 4': 1,
  'Block 9': 0.4,
})

// The opening preset (Board.seedOpening) draws UNIFORMLY from this list, and P1 freezes
// its membership to the pre-Line-4 pool on purpose: the spec (§3.3) asks the new shape to
// move the CANDIDATE distribution only, so a change in opening density can never be read
// as part of the Line 4 effect in the A/B/C experiments. Frozen by name, not by slicing
// SHAPES, so a future shape addition has to opt in here deliberately.
export const OPENING_SHAPES = Object.freeze(SHAPES.filter((shape) => shape.name !== 'Line 4'))

const WEIGHTED_POOL = (() => {
  const entries = SHAPES.map((shape) => ({ shape, weight: SHAPE_WEIGHTS[shape.name] ?? 0 }))
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  if (!total) throw new Error('shape weights are all zero')
  let running = 0
  return entries
    .filter((entry) => entry.weight > 0)
    .map((entry) => {
      running += entry.weight / total
      return { shape: entry.shape, upTo: running }
    })
})()

// Deal one candidate. Consumes exactly one random value, so the three dealing
// sites keep their previous Math.random() call count.
export function pickShape(random = Math.random) {
  const r = random()
  for (const entry of WEIGHTED_POOL) if (r < entry.upTo) return entry.shape
  return WEIGHTED_POOL[WEIGHTED_POOL.length - 1].shape
}

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

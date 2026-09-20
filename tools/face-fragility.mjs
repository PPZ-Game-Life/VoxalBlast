// How fragile is an NxN face to a 3x3 piece? (v0.8.15, measurement-only.)
//
//   node tools/face-fragility.mjs [trials]
//
// Why this exists: the 14-shape pool's difficulty jump is attributed to `Block 9`
// (3x3) in docs/Technical/DIFFICULTY_CURVE_POOL14.md, but the same shape is benign in
// Block Blast — an 8x8 single plane. This probe answers the geometric half of that
// question: at EQUAL occupancy, how much more often does a 5x5 face have no empty 3x3
// window than an 8x8 board? It counts "no empty 3x3 window", i.e. the face can no
// longer accept the piece at all.
//
// What it is NOT: a simulation of VoxalBlast, Block Blast, or any board game. It is a
// uniform-random occupancy model, used as a first-order geometry proxy. Real boards
// are clustered by line clearing (greedy keeps ~25 of 98 cells occupied but in bands
// that block several windows at once), so the real fragility of a 5x5 face is worse
// than the numbers below, not better. No gameplay file is imported or modified.

const TRIALS = Number(process.argv[2] || 20000)

// mulberry32, seeded per (size, occupancy) so the table is reproducible.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function blockedPct(size, occupiedCells, trials = TRIALS) {
  const random = rng(20260920 + size * 131 + occupiedCells)
  const total = size * size
  const index = Array.from({ length: total }, (_, i) => i)
  const grid = new Uint8Array(total)
  let blocked = 0
  for (let trial = 0; trial < trials; trial += 1) {
    grid.fill(0)
    for (let i = 0; i < occupiedCells; i += 1) {
      const j = i + Math.floor(random() * (total - i))
      const swap = index[i]; index[i] = index[j]; index[j] = swap
      grid[index[i]] = 1
    }
    let anyFreeWindow = false
    for (let r = 0; r < size - 2 && !anyFreeWindow; r += 1) {
      for (let c = 0; c < size - 2 && !anyFreeWindow; c += 1) {
        let free = true
        for (let dr = 0; dr < 3 && free; dr += 1) {
          for (let dc = 0; dc < 3; dc += 1) if (grid[(r + dr) * size + c + dc]) { free = false; break }
        }
        if (free) anyFreeWindow = true
      }
    }
    if (!anyFreeWindow) blocked += 1
  }
  return { trials, windows: (size - 2) * (size - 2), pct: (100 * blocked) / trials }
}

if (process.argv[1] && process.argv[1].endsWith('face-fragility.mjs')) {
  console.log(`trials per cell: ${TRIALS}\n`)
  console.log('face   occupied  occupancy%  empty-3x3 windows  P(no 3x3 fits)')
  const plan = new Map([
    [5, [0, 2, 4, 6, 8, 10, 12, 14, 16, 20]],
    [8, [0, 5, 10, 15, 20, 25, 30, 40, 50]],
  ])
  for (const [size, targets] of plan) {
    for (const cells of targets) {
      const { windows, pct } = blockedPct(size, cells)
      console.log(`${size}x${size}  ${String(cells).padStart(8)}  ${String(Math.round((100 * cells) / (size * size))).padStart(9)}%  ${String(windows).padStart(17)}  ${pct.toFixed(1).padStart(12)}%`)
    }
  }
}

// Fixed-pose session fixtures for BLOCK_REFERENCE_REWORK_HANDOFF §9 R0.
//
// Why this exists: the handoff's central complaint is that the material argument has
// been made against an EMPTY board (v0.9.32 screenshot A) while the reference image is
// a board full of coloured blocks. §0 item 5 forbids "pre-loading coloured blocks into
// the real new-game start" to fake that comparison, so the coloured board has to arrive
// as a SESSION FIXTURE that `tools/screenshot.mjs` injects into a throwaway browser
// profile (SHOT_SESSION=<file>) — the real new-game path stays untouched.
//
// R0 also demands candidate coverage for Dot / Line 4 / L / J / S / Z / Rect 6 / Block 9.
// The game only ever deals three candidates at a time, so coverage is split across three
// batches that share ONE board: same board, three different hands. Batches are fixed, not
// random, so a before/after pair always compares the same shapes.
//
//   node tools/visual-fixtures.mjs
//
// Writes tools/fixtures/visual-color-board-{a,b,c}.json. Deterministic: no Math.random.
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIDE = 5 // src/game/board.js SH

// src/game/board.js isShell: the 3x3x3 core can never be reached by a line, so it is
// never the shell. Kept as a copy rather than an import because this script must stay
// runnable without booting the game's module graph.
const isShell = (x, y, z) => !(x >= 1 && x <= 3 && y >= 1 && y <= 3 && z >= 1 && z <= 3)

// CURRENT logic colours from src/game/shapes.js — NOT render colours. referencePalette.js
// maps these to the lacquer toy palette at render time, so a fixture that stored render
// RGB would bypass the very mapping the review is about.
const RED = 0xc22b58 // Dot    -> #ff1644
const BLUE = 0x2f5fc4 // J      -> #0085ff
const GREEN = 0x4faa4a // S      -> #00ce80
const YELLOW = 0x293894 // Line 3 -> #ffc400
const PURPLE = 0xc03fa0 // Z      -> #c300f0
const PALETTE = [RED, BLUE, GREEN, YELLOW, PURPLE]

// 2x2x2-ish same-colour clusters, the way the reference stacks blocks, instead of
// per-cell noise that would hide seams behind a speckled face. The modulus is the palette
// length, so the original five-colour call reproduces the committed fixtures byte for byte.
function paint(x, y, z, length = PALETTE.length) {
  const cluster = Math.floor(x / 2) + Math.floor(y / 2) * 2 + Math.floor(z / 2) * 3
  return cluster % length
}

// A mostly-filled shell with the front wall complete. The front wall is the whole point:
// it is the surface the default stop pose shows, and the surface the reference shows as
// solid saturated toy colour. Gaps are deliberate so bare cream timber stays visible on
// the bottom band and inside the right face — a fully coloured cube would make seam
// colour impossible to grade against the wood.
const GAPS = new Set(['3,4,3', '2,4,2', '1,4,1', '4,0,2', '4,1,1', '0,4,3', '0,0,4', '4,4,4'])

function boardCells(palette = PALETTE) {
  const cells = []
  for (let x = 0; x < SIDE; x += 1) {
    for (let y = 0; y < SIDE; y += 1) {
      for (let z = 0; z < SIDE; z += 1) {
        if (!isShell(x, y, z)) continue
        // Front wall (z=max), top face (y=max), right face (x=max), and a partial back
        // face. Bottom face and the left face stay bare so the palette has a rest.
        const filled = z === SIDE - 1
          || (y === SIDE - 1 && z >= 0)
          || (x === SIDE - 1 && z >= 0)
          || (z === 0 && y <= 2)
        if (!filled) continue
        if (GAPS.has(`${x},${y},${z}`)) continue
        cells.push([x, y, z, palette[paint(x, y, z, palette.length)]])
      }
    }
  }
  return cells
}

// Batch hands. Index 0 is the widest piece in its batch on purpose: §5.2 says a 4-cell
// line is the shape most at risk of being fitted smaller than its neighbours, so it must
// never be the one batch that a reviewer skips.
//
// v0.10.0 adds batch `d`, the three pentominoes. Their colours have to be graded against
// the timber here rather than in the numeric scan alone (the v0.8.17 rule's whole point),
// and the three have to be tellable apart from the four-cell `T` at a glance — so this
// batch is the one whose BOARD paints with the new colours too, giving the review a real
// render of each new paint next to bare wood and next to the old palette.
const PENTOMINO_PALETTE = [0xc22b58, 0x2f5fc4, 0x4faa4a, 0x293894, 0xd62fd6, 0x2fd64b, 0xd13c2e, 0x8b57c9]
const BATCHES = {
  a: ['Dot', 'Line 4', 'L'],
  b: ['J', 'S', 'Z'],
  c: ['Rect 6', 'Block 9', 'T'],
  d: ['Cross 5', 'U 5', 'T 5'],
}

const BOARD = boardCells()
const PENTOMINO_BOARD = boardCells(PENTOMINO_PALETTE)

for (const [key, pieces] of Object.entries(BATCHES)) {
  const cells = (key === 'd' ? PENTOMINO_BOARD : BOARD).map((cell) => cell.slice())
  const fixture = {
    snapshot: {
      board: { cells, score: 4180, totalLines: 21 },
      pieces: pieces.map((name) => ({ name, used: false })),
      items: { refresh: 2, hammer: 1, rocket: 1, bomb: 1 },
      run: { chain: 0, bestChain: 5, facesLit: ['+z'], honors: [] },
      pose: {},
    },
    // board() reports the same order it was handed, so expectedBoard is the identity
    // of the snapshot cells (all colours here are already current, so migrate()'s
    // legacy remap is a no-op — that path is covered by legacy-palette-session.json).
    expectedBoard: { cells: cells.map((cell) => cell.slice()), score: 4180, totalLines: 21 },
  }
  const out = join(ROOT, 'tools', 'fixtures', `visual-color-board-${key}.json`)
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`OK   ${out}  cells=${cells.length}  pieces=${pieces.join(' / ')}`)
}

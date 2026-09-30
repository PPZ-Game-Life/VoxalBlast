// G0 frozen session fixtures for MATERIAL_GROUNDING_REWORK_HANDOFF §4.
//
// Why fixtures at all: §4.1 asks for an empty board AND "the same coloured save" frozen with
// hashes, and §4.6 asks for one observation swatch carrying bare timber next to a red, a blue
// and a green block. The game deals its own hand, so the only honest way to put exactly
// Dot (red) / J (blue) / S (green) in the tray is a SESSION FIXTURE — `tools/screenshot.mjs`
// and `tools/material-grounding-probe.mjs` inject it through `SHOT_SESSION=` / `--fixture`
// into a throwaway browser profile. The real new-game path is never touched, and nothing is
// added to the player's save.
//
//   node tools/material-grounding-fixtures.mjs
//
// Writes tools/fixtures/material-grounding-{empty,rgb}.json. Deterministic: no Math.random.
//
// The coloured board is the SAME layout the R-series reviews used (BLOCK_REFERENCE_REWORK_*):
// front wall, top face, right face and a partial back face filled, bottom and left faces left
// bare. Reusing it is deliberate — the material rounds are compared against those frames, and
// a new layout would make every earlier screenshot incomparable. Colours are the LOGIC colours
// (src/game/shapes.js), not render RGB: referencePalette.js maps them at render time, and a
// fixture that stored render RGB would bypass the very mapping a review is grading.
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIDE = 5 // src/game/board.js SH

// src/game/board.js isShell: the 3x3x3 core is never the shell lattice of a face line.
const isShell = (x, y, z) => !(x >= 1 && x <= 3 && y >= 1 && y <= 3 && z >= 1 && z <= 3)

const RED = 0xc22b58 // Dot
const BLUE = 0x2f5fc4 // J
const GREEN = 0x4faa4a // S
const PALETTE = [RED, BLUE, GREEN, 0x293894, 0xc03fa0]

// Same colour clustering and same gap set as tools/visual-fixtures.mjs, so the R-series
// frames and the G-series frames show the same board.
function paint(x, y, z, length = PALETTE.length) {
  const cluster = Math.floor(x / 2) + Math.floor(y / 2) * 2 + Math.floor(z / 2) * 3
  return cluster % length
}
const GAPS = new Set(['3,4,3', '2,4,2', '1,4,1', '4,0,2', '4,1,1', '0,4,3', '0,0,4', '4,4,4'])

function boardCells() {
  const cells = []
  for (let x = 0; x < SIDE; x += 1) {
    for (let y = 0; y < SIDE; y += 1) {
      for (let z = 0; z < SIDE; z += 1) {
        if (!isShell(x, y, z)) continue
        const filled = z === SIDE - 1
          || (y === SIDE - 1 && z >= 0)
          || (x === SIDE - 1 && z >= 0)
          || (z === 0 && y <= 2)
        if (!filled) continue
        if (GAPS.has(`${x},${y},${z}`)) continue
        cells.push([x, y, z, PALETTE[paint(x, y, z)]])
      }
    }
  }
  return cells
}

// The three observation paints, in the order §4.6 names them.
const PIECES = ['Dot', 'J', 'S']

function fixture(cells) {
  return {
    snapshot: {
      board: { cells: cells.map((cell) => cell.slice()), score: 4180, totalLines: 21 },
      pieces: PIECES.map((name) => ({ name, used: false })),
      items: { refresh: 2, hammer: 1, rocket: 1, bomb: 1 },
      run: { chain: 0, bestChain: 5, facesLit: ['+z'], honors: [] },
      pose: {},
    },
    // board() reports the same order it was handed, so expectedBoard is the identity of the
    // snapshot cells (every colour here is already current, so migrate()'s legacy remap is a
    // no-op). The score and the line count are the ones the fixture claims, so a resume that
    // silently re-scored would fail rather than pass.
    expectedBoard: { cells: cells.map((cell) => cell.slice()), score: 4180, totalLines: 21 },
  }
}

const COLOURED = boardCells()

for (const [key, cells] of [['empty', []], ['rgb', COLOURED]]) {
  const out = join(ROOT, 'tools', 'fixtures', `material-grounding-${key}.json`)
  writeFileSync(out, `${JSON.stringify(fixture(cells), null, 2)}\n`)
  console.log(`OK   ${out}  cells=${cells.length}  pieces=${PIECES.join(' / ')}`)
}

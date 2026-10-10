// Rule-case fixtures for the cartoon clear VFX round (CARTOON_CLEAR_VFX_HANDOFF §9.1).
//
//   node tools/cartoon-clear-fixtures.mjs
//
// The handoff's test table cannot be exercised by `demoClear()`: that entry builds line
// descriptors without a Board, so it can prove a budget but never "raw 2 / physical 1 / 5 unique
// cells". Each fixture below is a REAL session snapshot — the same shape `tools/screenshot.mjs`
// injects through SHOT_SESSION — with a board pattern that is exactly one legal drop away from
// the case it is named after. The probe then performs that drop through the game's own
// `onDrop()` and reads the lines the rules layer really produced.
//
// The fixtures live in a throwaway browser profile and never write a save: the real new-game
// path is untouched (the same rule `tools/visual-fixtures.mjs` states).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SH = 5
const FACES = ['+x', '-x', '+y', '-y', '+z', '-z']
const LATTICE = {
  '+z': (u, v) => [u, v, SH - 1],
  '-z': (u, v) => [u, v, 0],
  '+x': (u, v) => [SH - 1, u, v],
  '-x': (u, v) => [0, u, v],
  '+y': (u, v) => [u, SH - 1, v],
  '-y': (u, v) => [u, 0, v],
}
const isShell = (x, y, z) => x === 0 || x === SH - 1 || y === 0 || y === SH - 1 || z === 0 || z === SH - 1

// The logic colours are src/game/shapes.js's own, not render RGB: referencePalette.js maps them
// at render time, and a fixture carrying render colour would bypass that mapping.
const PAINT = [0xc22b58, 0x2f5fc4, 0x4faa4a, 0x293894, 0xc03fa0, 0x35b6c9]

const row = (face, index, from, to) => Array.from({ length: to - from + 1 }, (_, i) => LATTICE[face](from + i, index))
const col = (face, index, from, to) => Array.from({ length: to - from + 1 }, (_, i) => LATTICE[face](index, from + i))

// Deterministic paint, clustered like a real board rather than per-cell noise.
function painted(cells) {
  return cells.map((cell, index) => [cell[0], cell[1], cell[2], PAINT[(cell[0] + cell[1] * 2 + cell[2] * 3 + index) % PAINT.length]])
}

// A few cells on the far side of the cube so the captures show a played board rather than a bare
// shell. They sit on '-z'/'-x', away from every case's drop cell.
const DECOR = [
  ...row('-z', 0, 0, 2), ...row('-z', 3, 1, 3),
  ...col('-x', 1, 0, 2), ...row('-x', 2, 2, 4),
]

const CASES = {
  // 单线: one row is one cell short; a Dot completes it.
  single: {
    expect: { physical: 1, uniqueCells: 5 },
    drop: { face: '+z', piece: 'Dot', origin: { u: 4, v: 2 } },
    prefill: [...row('+z', 2, 0, 3), ...row('+z', 0, 0, 2), ...col('+z', 1, 3, 4)],
  },
  // 平行双线: two adjacent rows each three cells short; Rect 6 (3 wide x 2 tall) completes both.
  parallel: {
    expect: { physical: 2, uniqueCells: 10 },
    drop: { face: '+z', piece: 'Rect 6', origin: { u: 2, v: 1 } },
    prefill: [...row('+z', 1, 0, 1), ...row('+z', 2, 0, 1), ...row('+z', 4, 0, 1)],
  },
  // 交叉双线: a row and a column that meet at ONE missing cell; a Dot settles both.
  cross: {
    expect: { physical: 2, uniqueCells: 9 },
    drop: { face: '+z', piece: 'Dot', origin: { u: 4, v: 2 } },
    prefill: [...row('+z', 2, 0, 3), ...col('+z', 4, 0, 1), ...col('+z', 4, 3, 4)],
  },
  // 同一共享满棱两面报告: row v=4 on '+z' and row v=4 on '+y' are the SAME five lattice cells.
  'shared-edge': {
    expect: { physical: 1, uniqueCells: 5 },
    drop: { face: '+z', piece: 'Dot', origin: { u: 4, v: 4 } },
    prefill: [...row('+z', 4, 0, 3)],
  },
  // 前面一行 + 相邻面同高一行: row v=2 on '+z' and column u=2 on '+x' share exactly the corner
  // cell (4,2,4). y=2 is an interior layer, so no third face mirrors either line.
  'face-pair': {
    expect: { physical: 2, uniqueCells: 9 },
    drop: { face: '+z', piece: 'Dot', origin: { u: 4, v: 2 } },
    prefill: [...row('+z', 2, 0, 3), ...col('+x', 2, 0, 3)],
  },
  // 同面三行: Block 9 (3x3) fills the last three cells of three rows.
  three: {
    expect: { physical: 3, uniqueCells: 15 },
    drop: { face: '+z', piece: 'Block 9', origin: { u: 2, v: 0 } },
    prefill: [...row('+z', 0, 0, 1), ...row('+z', 1, 0, 1), ...row('+z', 2, 0, 1)],
  },
  // 四线交汇: a 2x2 Square closes two rows AND two columns at once -- 4 lines over 16 cells.
  four: {
    expect: { physical: 4, uniqueCells: 16 },
    drop: { face: '+z', piece: 'Square', origin: { u: 3, v: 0 } },
    prefill: [
      ...row('+z', 0, 0, 2), ...row('+z', 1, 0, 2),
      ...col('+z', 3, 2, 4), ...col('+z', 4, 2, 4),
    ],
  },
  // 五线交汇: the same intersection one column wider -- two rows + three columns = 5 lines.
  five: {
    expect: { physical: 5, uniqueCells: 19 },
    drop: { face: '+z', piece: 'Rect 6', origin: { u: 2, v: 0 } },
    prefill: [
      ...row('+z', 0, 0, 1), ...row('+z', 1, 0, 1),
      ...col('+z', 2, 2, 4), ...col('+z', 3, 2, 4), ...col('+z', 4, 2, 4),
    ],
  },
}

mkdirSync(join(ROOT, 'tools', 'fixtures'), { recursive: true })

let failures = 0
const table = {}

for (const [name, spec] of Object.entries(CASES)) {
  const seen = new Map()
  const add = (cell) => seen.set(cell.join(','), cell)
  for (const cell of [...painted(spec.prefill), ...painted(DECOR)]) {
    if (!isShell(cell[0], cell[1], cell[2])) throw new Error(`${name}: ${cell} is not on the shell`)
    add(cell)
  }
  // Hard precondition: the fixture itself must not already hold a full line. `Board.place()`
  // settles every full line on the cube, so a seeded line would be a free clear and the case
  // would measure the fixture instead of the drop.
  for (const face of FACES) {
    for (let index = 0; index < SH; index += 1) {
      for (const line of [row(face, index, 0, SH - 1), col(face, index, 0, SH - 1)]) {
        if (line.length === SH && line.every((cell) => seen.has(cell.join(',')))) {
          throw new Error(`${name}: fixture already holds a full line on ${face} at ${index}`)
        }
      }
    }
  }
  const cells = [...seen.values()]
  const snapshot = {
    v: 2,
    board: { cells, score: 0, totalLines: 0 },
    pieces: [spec.drop.piece, 'Line 3', 'Dot'].map((piece) => ({ name: piece, used: false })),
    items: { refresh: 2, hammer: 1, rocket: 1, bomb: 1 },
    run: { chain: 0, bestChain: 0, maxLinesOneMove: 0, maxFacesOneMove: 0, facesLit: [], faceWipes: 0, honors: [], honorCounts: {} },
    pose: {},
  }
  const fixture = { name, drop: spec.drop, expect: spec.expect, occupied: cells.length, snapshot }
  writeFileSync(join(ROOT, 'tools', 'fixtures', `cartoon-clear-${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`)
  table[name] = { drop: spec.drop, expect: spec.expect, occupied: cells.length }
  console.log(`OK   cartoon-clear-${name}.json  occupied=${cells.length}  drop=${spec.drop.piece}@${spec.drop.face}(${spec.drop.origin.u},${spec.drop.origin.v})  expect=${JSON.stringify(spec.expect)}`)
}

// The v1 save the handoff asks about: the same single-line board, but a legacy rules version, so
// `rewardEvent` may be null while the local event key still has to be unique.
{
  const base = JSON.parse(readFileSync(join(ROOT, 'tools', 'fixtures', 'cartoon-clear-single.json'), 'utf8'))
  const expect = { physical: 1, uniqueCells: 5, legacy: true }
  writeFileSync(join(ROOT, 'tools', 'fixtures', 'cartoon-clear-legacy-single.json'), `${JSON.stringify({
    name: 'legacy-single',
    drop: base.drop,
    expect,
    occupied: base.occupied,
    snapshot: { ...base.snapshot, run: { ...base.snapshot.run, scoreRulesVersion: 1 } },
  }, null, 2)}\n`)
  table['legacy-single'] = { drop: base.drop, expect, occupied: base.occupied }
  console.log(`OK   cartoon-clear-legacy-single.json  scoreRulesVersion=1  expect=${JSON.stringify(expect)}`)
}

writeFileSync(join(ROOT, 'tools', 'fixtures', 'cartoon-clear-cases.json'), `${JSON.stringify(table, null, 2)}\n`)
console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${Object.keys(table).length + 1} fixtures written`)
process.exit(failures ? 1 : 0)

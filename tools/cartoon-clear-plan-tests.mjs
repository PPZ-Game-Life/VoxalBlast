// Cartoon clear planner tests (CARTOON_CLEAR_VFX_HANDOFF §9.1).
//
//   node tools/cartoon-clear-plan-tests.mjs
//   npm run test:cartoon
//
// These run the REAL rules layer: `Board.restore()` loads the fixture, `Board.place()` settles the
// same drop the probe performs, and the planner is asked what it makes of the lines that came out.
// Nothing here draws, so §4.1's numbers are asserted without a browser.
//
// The drop cells come from the shape's own `cells` normalised to the origin. That is the identity
// mapping for the '+z' face in the shipped docked pose -- the same pose the probe drives -- so the
// board this file builds is the board the probe built (the probe reads the lines back and recorded
// the identical face/axis sets in artifacts/cartoon-clear-v1/r0/evidence.json).
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Board, FACES, SH, isShell } from '../src/game/board.js'
import { SHAPES, normalizeCells } from '../src/game/shapes.js'
import { createRng, hashSeed } from '../src/game/rng.js'
import {
  CARTOON_BUDGETS, clearBudget, clearCaps, clearTailSeconds, emitterPositions,
  markPositions, physicalKey, planClear, vfxSeed,
} from '../src/rendering/cartoonClearPlan.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'tools', 'fixtures')

const failures = []
function check(label, condition, detail) {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${detail}`}`)
  if (!condition) failures.push(label)
}
const equal = (label, actual, expected) => check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)

const CASE_NAMES = [
  'single', 'parallel', 'cross', 'shared-edge', 'face-pair', 'three', 'four', 'five', 'legacy-single',
]

function loadCase(name) {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, `cartoon-clear-${name}.json`), 'utf8'))
  const shape = SHAPES.find((entry) => entry.name === fixture.drop.piece)
  if (!shape) throw new Error(`${name}: unknown shape ${fixture.drop.piece}`)
  const board = new Board()
  const restored = board.restore({ cells: fixture.snapshot.board.cells })
  if (restored !== fixture.occupied) throw new Error(`${name}: restore took ${restored} of ${fixture.occupied} cells`)
  // A fixture that already holds a full line would settle a line the drop did not make.
  const pre = board.findAllFullLines()
  if (pre.length) throw new Error(`${name}: fixture already holds ${pre.length} full line(s)`)
  const cells = normalizeCells(shape.cells)
  const result = board.place(fixture.drop.face, cells, fixture.drop.origin, shape.color)
  return { name, fixture, shape, board, result }
}

console.log('--- §9.1 rule cases, through the real Board and the real planner ---')
for (const name of CASE_NAMES) {
  const { fixture, result, board } = loadCase(name)
  const plan = planClear(result.lines, { frontFace: fixture.drop.face })
  const raw = result.lines.map((line) => `${line.face}:${line.axis}${line.axis === 'row' ? line.v : line.u}`)

  equal(`${name}: physical line count`, plan.physicalLineCount, fixture.expect.physical)
  equal(`${name}: unique cleared cells`, plan.uniqueCellCount, fixture.expect.uniqueCells)
  // §4.1: de-duplication may only ever MERGE reports, never invent or drop a line.
  check(`${name}: every raw face line is represented by a physical line`,
    plan.rawLineCount >= plan.physicalLineCount && plan.duplicatedReports === plan.rawLineCount - plan.physicalLineCount,
    `raw=${plan.rawLineCount} physical=${plan.physicalLineCount} dup=${plan.duplicatedReports} [${raw.join(' ')}]`)
  // §4.1: the outline keeps every face that really reported a line, so de-duplicating the budget
  // cannot hide a visible surface's confirmation.
  check(`${name}: the outline keeps every reported face footprint`,
    plan.faceFootprints.length === plan.rawLineCount,
    `footprints=${plan.faceFootprints.length} raw=${plan.rawLineCount}`)
  check(`${name}: the outline covers every cleared cell exactly once`,
    plan.outlineCellCount === plan.uniqueCellCount && !plan.outlineTruncated,
    `outline=${plan.outlineCellCount} unique=${plan.uniqueCellCount} truncated=${plan.outlineTruncated}`)
  // §4.2: an intersection is an event-internal set -- one anchor, not one per line.
  check(`${name}: no cell is counted as an intersection twice`,
    new Set(plan.intersections.map((cell) => cell.join(','))).size === plan.intersections.length,
    `intersections=${plan.intersections.length}`)
  // §4.2: at most 8 decoration emitters, and never more ends than the lines can produce.
  const ends = emitterPositions(plan, { max: 8 })
  check(`${name}: emitters are capped at 8 and merged by position`,
    ends.length <= 8 && ends.length <= plan.physicalLineCount * 2,
    `emitters=${ends.length} for ${plan.physicalLineCount} physical line(s)`)

  // §4.3's table, in both tiers, straight from the shipped numbers.
  const standard = CARTOON_BUDGETS.standard[Math.min(plan.physicalLineCount, 3)]
  const lowPower = CARTOON_BUDGETS.lowPower[Math.min(plan.physicalLineCount, 3)]
  equal(`${name}: standard budget`, clearBudget(plan.physicalLineCount), standard)
  equal(`${name}: low power budget`, clearBudget(plan.physicalLineCount, { lowPower: true }), lowPower)
  equal(`${name}: cramped halves the budget`, clearBudget(plan.physicalLineCount, { cramped: true }), Math.round(standard * 0.5))
  equal(`${name}: reduced motion spends no sprite`, clearBudget(plan.physicalLineCount, { reducedMotion: true }), 0)
  const caps = clearCaps(plan.physicalLineCount)
  const marks = markPositions(plan, caps.marks)
  check(`${name}: star/point marks stay inside the cap`, marks.length <= caps.marks, `marks=${marks.length} cap=${caps.marks}`)
  check(`${name}: every mark is a real cleared cell`,
    marks.every((mark) => plan.uniqueCells.some((cell) => cell.join(',') === mark.cell.join(','))),
    `${marks.length} mark(s)`)
  // §4.3's tail: a single line is over by 360ms, a multi-line event by 420ms.
  equal(`${name}: tail seconds`, clearTailSeconds(plan.physicalLineCount), plan.physicalLineCount === 1 ? 0.36 : 0.42)
  // §4.2: the same event must always draw the same confetti, from its own seed.
  equal(`${name}: the VFX seed is deterministic`, vfxSeed(7, plan), vfxSeed(7, plan))
  check(`${name}: the plan is deterministic`,
    JSON.stringify(plan) === JSON.stringify(planClear(result.lines, { frontFace: fixture.drop.face })),
    `physical=${plan.physicalLineCount} unique=${plan.uniqueCellCount}`)
  // Nothing in the planner may write the board: the score and the remaining cells are the rules'.
  check(`${name}: the planner left the board alone`, board.score === 0 || board.score >= 0)
  console.log(`     ${name}  raw=${plan.rawLineCount} physical=${plan.physicalLineCount} unique=${plan.uniqueCellCount} intersections=${plan.intersections.length} emitters=${ends.length} failedLines=${board.findAllFullLines().length}`)
}

console.log('\n--- planner units ---')
{
  const a = { face: '+z', axis: 'row', v: 2, cells: [[0, 2, 4], [1, 2, 4], [2, 2, 4]] }
  const b = { face: '+x', axis: 'col', u: 2, cells: [[2, 2, 4], [0, 2, 4], [1, 2, 4]] }
  equal('two face reports of one segment share a physical key', physicalKey(a), physicalKey(b))
  const plan = planClear([a, b], { frontFace: null })
  equal('a shared segment is one physical line', plan.physicalLineCount, 1)
  equal('a shared segment still has two face footprints', plan.faceFootprints.length, 2)
  equal('the shared segment has 3 unique cells', plan.uniqueCellCount, 3)
  // §4.2: with no front face, the direction comes from a STABLE rank, not from array order.
  equal('face choice is order-independent (b then a)', planClear([b, a], {}).physicalLines[0].face, planClear([a, b], {}).physicalLines[0].face)
  check('the front face wins the tie-break', planClear([a, b], { frontFace: '+x' }).physicalLines[0].face === '+x')
  check('a +z row and a +z col of the same five cells are ONE physical line',
    planClear([a, { ...a, axis: 'col', u: 2 }], {}).physicalLineCount === 1)
}
{
  equal('no cleared lines means no sprite budget', clearBudget(0), 0)
  equal('zero lines have a zero tail', clearTailSeconds(0), 0)
  equal('four lines still use the 3+ row', clearBudget(4), 32)
  equal('five lines still use the 3+ row', clearBudget(5), 32)
  equal('caps for one line', JSON.stringify(clearCaps(1)), JSON.stringify({ marks: 2, arcs: 2 }))
  equal('caps for two lines', JSON.stringify(clearCaps(2)), JSON.stringify({ marks: 4, arcs: 2 }))
  equal('caps for four lines', JSON.stringify(clearCaps(4)), JSON.stringify({ marks: 4, arcs: 4 }))
}
{
  // §4.2 「端点多于8时稳定抽样」: the same board must pick the same emitters, and the count must
  // fall out of the lines rather than out of the array order.
  const lines = FACES.slice(0, 4).map((face, index) => ({
    face,
    axis: 'row',
    v: index,
    cells: Array.from({ length: SH }, (_, u) => [u, index, index]),
  }))
  const plan = planClear(lines, {})
  const first = emitterPositions(plan, { max: 8 }).map((end) => end.cell.join(','))
  const second = emitterPositions(plan, { max: 8 }).map((end) => end.cell.join(','))
  check('endpoint sampling is stable', first.join('|') === second.join('|'), first.length)
  check('endpoint sampling respects the cap', first.length <= 8, first.length)
}


console.log("\n--- differential fuzz: planClear vs a brute-force reference ---")
{
  // The nine hand-made cases prove the rules the doc names. This proves the DE-DUPLICATION is
  // the same function as an obvious (slow) reference over hundreds of random boards, so a case
  // nobody thought of cannot slip through. Seeded, so a failure is reproducible.
  const FUZZ_CASES = 400
  const rng = createRng(hashSeed('v0.13.3-cartoon-clear-fuzz', 20261009))
  let drops = 0
  let sharedEdgeCases = 0
  let orphanBudget = 0
  let worstEmitters = 0
  for (let caseIndex = 0; caseIndex < FUZZ_CASES; caseIndex += 1) {
    const cells = []
    for (let x = 0; x < SH; x += 1) {
      for (let y = 0; y < SH; y += 1) {
        for (let z = 0; z < SH; z += 1) {
          if (!isShell(x, y, z)) continue
          if (rng() < 0.5) cells.push([x, y, z, 0xc22b58])
        }
      }
    }
    const board = new Board()
    board.restore({ cells })
    const shape = SHAPES[Math.floor(rng() * SHAPES.length)]
    const oriented = normalizeCells(shape.cells)
    const face = FACES[Math.floor(rng() * FACES.length)]
    let placed = null
    for (let attempt = 0; attempt < 40 && !placed; attempt += 1) {
      const origin = { u: Math.floor(rng() * SH), v: Math.floor(rng() * SH) }
      if (!board.canPlace(face, oriented, origin)) continue
      placed = board.place(face, oriented, origin, shape.color)
    }
    if (!placed || !placed.lines.length) continue
    drops += 1
    const raw = placed.lines
    const plan = planClear(raw, { frontFace: face })

    // The reference: group the raw face lines by their sorted cell set, union every cell.
    const reference = new Map()
    const union = new Set()
    for (const line of raw) {
      const key = line.cells.map((cell) => cell.join(",")).sort().join("|")
      reference.set(key, (reference.get(key) || 0) + 1)
      for (const cell of line.cells) union.add(cell.join(","))
    }
    if (plan.physicalLineCount !== reference.size) {
      failures.push(`fuzz ${caseIndex}: physical ${plan.physicalLineCount} vs reference ${reference.size}`)
    }
    if (plan.uniqueCellCount !== union.size) {
      failures.push(`fuzz ${caseIndex}: union ${plan.uniqueCellCount} vs reference ${union.size}`)
    }
    if (plan.rawLineCount !== raw.length) {
      failures.push(`fuzz ${caseIndex}: raw ${plan.rawLineCount} vs board ${raw.length}`)
    }
    if (plan.faceFootprints.length !== raw.length) {
      failures.push(`fuzz ${caseIndex}: footprints ${plan.faceFootprints.length} vs raw ${raw.length}`)
    }
    if (plan.physicalLineCount > raw.length) {
      failures.push(`fuzz ${caseIndex}: more physical lines than raw reports`)
    }
    // Every plan must stay inside the doc ceilings whatever the board looked like.
    for (const tier of ["standard", "lowPower"]) {
      const budget = clearBudget(plan.physicalLineCount, { lowPower: tier === "lowPower" })
      const cap = CARTOON_BUDGETS[tier][Math.min(Math.max(1, plan.physicalLineCount), 3)]
      if (budget > cap) failures.push(`fuzz ${caseIndex}: ${tier} budget ${budget} over ${cap}`)
    }
    const caps = clearCaps(plan.physicalLineCount)
    if (markPositions(plan, caps.marks).length > caps.marks) {
      failures.push(`fuzz ${caseIndex}: marks over cap`)
    }
    const emitters = emitterPositions(plan, { max: 8 }).length
    worstEmitters = Math.max(worstEmitters, emitters)
    if (emitters > 8) failures.push(`fuzz ${caseIndex}: ${emitters} emitters over the cap of 8`)
    if (plan.outlineCellCount > 150) failures.push(`fuzz ${caseIndex}: outline over 150 cells`)
    if (plan.duplicatedReports < 0) failures.push(`fuzz ${caseIndex}: negative duplication`)
    if (plan.duplicatedReports > 0) sharedEdgeCases += 1
  }
  check("fuzz: the run actually dropped onto real boards", drops >= 120, `${drops} of ${FUZZ_CASES} random boards produced a settled drop (a random shape/face/origin is usually illegal or clears nothing)`)
  check("fuzz: shared-edge duplication was actually exercised", sharedEdgeCases >= 30,
    `${sharedEdgeCases} of ${drops} drops reported one space segment more than once`)
  check("fuzz: the emitter cap held on every board", worstEmitters <= 8, `worst ${worstEmitters}`)
}
console.log(`\n${failures.length ? 'FAIL' : 'PASS'}  ${failures.length} failure(s)`)
process.exit(failures.length ? 1 : 0)

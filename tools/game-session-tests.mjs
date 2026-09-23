// Game session tests (plan section 6 P6: "新增测试 tools/game-session-tests.mjs（无新依赖）").
//
// They run in plain Node -- no DOM, no WebGL, no browser -- because game/gameSession.js has no
// UI, no Three.js and no platform dependency. That importability IS the P6a claim; everything
// below is asserted against the real Board and the real scoring rules, never a mock of them.
//
// Coverage in P6a (data + pure actions): dealing, the run token, placement, clearing, scoring,
// the chain, the face ledger and the exact shape settlePlacement returns.
// Still to come with P6b (items, undo, rescue, end-of-run, the snapshot data):
//   - 三槽用完换批, 道具不计分, 撤销还色还次数, 三类救场, 局终幂等, 结束后不生成可保存局.
import { createGameSession } from '../src/game/gameSession.js'
import { SH, FACES, faceLattice } from '../src/game/board.js'
import { SHAPES, normalizeCells } from '../src/game/shapes.js'

let total = 0
let passed = 0
const failures = []
function check(label, condition, detail = '') {
  total += 1
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `  (${detail})` : ''}`)
}

const fresh = () => createGameSession()

// ---- 1. a fresh session starts empty -------------------------------------------
{
  const s = fresh()
  check('a fresh session holds no pieces', s.getPieces().length === 0)
  check('a fresh session starts on run token 0', s.getRunId() === 0)
  check('a fresh run record is zeroed', s.run.chain === 0 && s.run.bestChain === 0 && s.run.faceWipes === 0
    && s.run.maxLinesOneMove === 0 && s.run.maxFacesOneMove === 0 && s.run.facesLit.size === 0
    && s.run.honors.length === 0 && Object.keys(s.run.honorCounts).length === 0)
  check('a fresh board is empty', s.board.occupied().length === 0 && s.board.score === 0 && s.board.totalLines === 0)
}

// ---- 2. dealing -----------------------------------------------------------------
{
  const s = fresh()
  const hand = s.deal()
  check('deal returns three pieces', hand.length === 3 && s.getPieces() === hand)
  check('every dealt piece is unused', hand.every((piece) => piece.used === false))
  check('every dealt piece has cells', hand.every((piece) => Array.isArray(piece.cells) && piece.cells.length > 0))
  check('a dealt piece comes from the shape pool', hand.every((piece) => SHAPES.includes(piece.shape)))

  const shape = SHAPES.find((candidate) => candidate.cells.length > 1) || SHAPES[0]
  const piece = s.makePiece(shape)
  check('makePiece normalizes the shape cells', JSON.stringify(piece.cells) === JSON.stringify(normalizeCells(shape.cells)))
  check('makePiece keeps the shape object itself', piece.shape === shape)
  check('makePiece starts unused', piece.used === false)
  check('currentCells is the piece\'s own cell list', s.currentCells(piece) === piece.cells)

  const replacement = [s.makePiece(SHAPES[0])]
  s.setPieces(replacement)
  check('setPieces replaces the hand', s.getPieces() === replacement)
}

// ---- 3. the run token -----------------------------------------------------------
{
  const s = fresh()
  s.run.chain = 4
  s.run.bestChain = 7
  s.run.faceWipes = 2
  s.run.facesLit.add('+z')
  s.run.honors.push('h')
  s.run.honorCounts.h = 1
  s.resetRun()
  check('resetRun zeroes the record', s.run.chain === 0 && s.run.bestChain === 0 && s.run.faceWipes === 0
    && s.run.facesLit.size === 0 && s.run.honors.length === 0 && Object.keys(s.run.honorCounts).length === 0)
  check('resetRun advances the run token', s.getRunId() === 1)
  s.resetRun()
  check('the run token advances again', s.getRunId() === 2)
  check('resetRun leaves the board alone', s.board.occupied().length === 0)
}

// A face row with four of its five cells filled, so one placement completes it.
function fillRowExceptOne(s, face, v, exceptU) {
  const records = []
  for (let u = 0; u < SH; u += 1) {
    if (u === exceptU) continue
    const [x, y, z] = faceLattice(face, u, v)
    records.push({ x, y, z, color: 0 })
  }
  s.board.addCells(records)
  return records.length
}

// ---- 4. placement, clearing and the return shape --------------------------------
// An INTERIOR row (v = 2): its cells are not shared with a neighbouring face, so exactly one line
// is completed. The edge rows are covered separately in test 5 - they really do clear two faces.
{
  const s = fresh()
  const face = '+z'
  const filled = fillRowExceptOne(s, face, 2, 4)
  check('the filler row is four cells', filled === 4, `filled=${filled}`)

  const before = s.board.score
  const settled = s.settlePlacement(face, [[0, 0]], { u: 4, v: 2 }, 3)
  const keys = Object.keys(settled).sort().join(',')
  check('settlePlacement returns the documented shape',
    keys === 'honors,level,lineCount,lines,previousChain,result,score', keys)
  check('the completed line was found', settled.lineCount === 1 && settled.lines.length === 1, `lineCount=${settled.lineCount}`)
  check('the line is reported on the face it was dropped on', settled.lines[0].face === face, settled.lines[0]?.face)
  check('the line held five cells', settled.lines[0].cells.length === SH, `${settled.lines[0].cells.length}`)
  check('result carries the raw board answer', settled.result.face === face && settled.result.facesHit === 1)
  check('the clear paid', settled.score.total > 0, `total=${settled.score.total}`)
  check('the board score moved by exactly the move score', s.board.score === before + settled.score.total,
    `${before} + ${settled.score.total} = ${s.board.score}`)
  check('the board counted the line', s.board.totalLines === 1, `totalLines=${s.board.totalLines}`)
  check('the clear raised the chain', settled.previousChain === 0 && s.run.chain > 0, `chain=${s.run.chain}`)
  check('the best chain follows', s.run.bestChain === s.run.chain, `best=${s.run.bestChain}`)
  check('the face is recorded as lit', s.run.facesLit.has(face) && s.run.facesLit.size === 1)
  check('the per-move maxima follow', s.run.maxLinesOneMove === 1 && s.run.maxFacesOneMove === 1)
  check('a cleared board is empty again', s.board.occupied().length === 0, `${s.board.occupied().length}`)
}

// ---- 5. an edge row clears two faces at once (the cross-face rule) --------------
{
  const s = fresh()
  fillRowExceptOne(s, '+z', 0, 4)
  const settled = s.settlePlacement('+z', [[0, 0]], { u: 4, v: 0 }, 3)
  check('an edge row completes a line on the neighbour too', settled.lineCount === 2, `lineCount=${settled.lineCount}`)
  check('and the board reports two faces hit', settled.result.facesHit === 2, `facesHit=${settled.result.facesHit}`)
  const lit = [...s.run.facesLit].sort().join(',')
  check('both faces are lit', s.run.facesLit.size === 2, lit)
  check('the face ledger names the two real faces', s.run.facesLit.has('+z') && !s.run.facesLit.has('+y'), lit)
  check('the per-move face maximum saw both', s.run.maxFacesOneMove === 2, `max=${s.run.maxFacesOneMove}`)
}

// ---- 6. a second consecutive clear, then a dead turn ----------------------------
{
  const s = fresh()
  fillRowExceptOne(s, '+z', 2, 4)
  s.settlePlacement('+z', [[0, 0]], { u: 4, v: 2 }, 3)
  const firstChain = s.run.chain
  fillRowExceptOne(s, '+x', 2, 4)
  const second = s.settlePlacement('+x', [[0, 0]], { u: 4, v: 2 }, 3)
  check('the second clear continued the chain', s.run.chain > firstChain, `${firstChain} -> ${s.run.chain}`)
  check('previousChain reports the chain before the move', second.previousChain === firstChain, `${second.previousChain}`)
  check('two faces are lit now', s.run.facesLit.size === 2, `${[...s.run.facesLit].join(',')}`)
  check('the best chain kept up', s.run.bestChain === s.run.chain, `best=${s.run.bestChain}`)

  const chainBefore = s.run.chain
  const dead = s.settlePlacement('+z', [[0, 0]], { u: 0, v: 0 }, 3)
  check('a turn that clears nothing zeroes the chain', dead.lineCount === 0 && s.run.chain === 0, `chain=${s.run.chain}`)
  check('the dead turn still reports the chain it broke', dead.previousChain === chainBefore,
    `previousChain=${dead.previousChain}, was ${chainBefore}`)
  check('the dead turn still scored', dead.score.total > 0 && s.board.score > 0)
  check('the dead turn put its cell on the board', s.board.occupied().length === 1, `${s.board.occupied().length}`)
  check('the dead turn earned no honor', dead.honors.ids.length === 0 && s.run.honors.length === 0)
}

// ---- 7. a placement is refused where the board says no --------------------------
{
  const s = fresh()
  fillRowExceptOne(s, '+z', 2, 4)
  const filled = s.board.occupied()
  const target = filled[0]
  check('canPlace refuses an occupied cell', s.board.canPlace('+z', [[0, 0]], { u: 0, v: 2 }) === false)
  check('canPlace accepts the free one', s.board.canPlace('+z', [[0, 0]], { u: 4, v: 2 }) === true)
  check('the board really has that cell', s.board.has(target.x, target.y, target.z) === true)
  check('and not the free one', s.board.has(...faceLattice('+z', 4, 2)) === false)
}

// ---- 8. the session is a self-contained model -----------------------------------
{
  const a = fresh()
  const b = fresh()
  a.board.addCells([{ x: 0, y: 0, z: 0, color: 1 }])
  a.run.chain = 3
  check('two sessions do not share a board', b.board.occupied().length === 0 && b.board.score === 0)
  check('two sessions do not share a run record', b.run.chain === 0 && b.run.facesLit.size === 0)
  check('two sessions do not share a token', b.getRunId() === 0 && a.getRunId() === 0)
  check('the lattice constants are the board\'s', SH === 5 && FACES.length === 6)
}

// ---- 9. what each tool reaches (P6b-1) ------------------------------------------
{
  const s = fresh()
  const hammer = s.toolScopeCells('hammer', '+z', 2, 2, 'row')
  check('the hammer reaches exactly one cell', hammer.length === 1
    && hammer[0].join(',') === faceLattice('+z', 2, 2).join(','), JSON.stringify(hammer))
  const row = s.toolScopeCells('rocket', '+z', 2, 2, 'row')
  const col = s.toolScopeCells('rocket', '+z', 2, 2, 'col')
  check('the rocket clears a whole row', row.length === SH, `${row.length}`)
  check('the rocket clears a whole column', col.length === SH, `${col.length}`)
  check('the row and the column are different cells',
    row.map((c) => c.join(',')).join('|') !== col.map((c) => c.join(',')).join('|'))
  check('the row follows v, the column follows u',
    row.every((c, i) => c.join(',') === faceLattice('+z', i, 2).join(','))
    && col.every((c, i) => c.join(',') === faceLattice('+z', 2, i).join(',')))
  check('the bomb covers 2x2', s.toolScopeCells('bomb', '+z', 2, 2, '2x2').length === 4)
  check('the bomb is trimmed at the face edge', s.toolScopeCells('bomb', '+z', 4, 4, '2x2').length === 1)
}

// ---- 10. a tool clears without scoring (P6b-1) ----------------------------------
{
  const s = fresh()
  fillRowExceptOne(s, '+z', 2, 4)
  const before = { score: s.board.score, lines: s.board.totalLines, chain: s.run.chain, hammer: s.getItemCounts().hammer }
  const applied = s.applyItem('hammer', '+z', 0, 2, 'row')
  check('the hammer found the cell it was aimed at', applied.scope.length === 1 && applied.removed.length === 1)
  check('the record keeps the colour the cell had', applied.records[0]?.color === 0, JSON.stringify(applied.records[0]))
  check('a tool does not score', s.board.score === before.score && s.board.totalLines === before.lines,
    `${s.board.score}/${s.board.totalLines}`)
  check('a tool does not move the chain', s.run.chain === before.chain)
  check('a tool does not touch the charges by itself', s.getItemCounts().hammer === before.hammer)
  check('the cell is really gone', s.board.occupied().length === 3, `${s.board.occupied().length}`)
  const miss = s.applyItem('hammer', '+z', 4, 2, 'row')
  check('a tool aimed at nothing removes nothing', miss.removed.length === 0 && miss.records.length === 0)
  const rocket = s.applyItem('rocket', '+z', 2, 2, 'row')
  // Four cells were filled, the hammer took one, so three are left on that row.
  check('the rocket removes the occupied cells of its line', rocket.removed.length === 3, `${rocket.removed.length}`)
  check('the rocket reports the whole line it covered', rocket.scope.length === SH)
}

// ---- 11. undo restores colours and the charge (P6b-1) ---------------------------
{
  const s = fresh()
  fillRowExceptOne(s, '+z', 2, 4)
  const coloursBefore = s.board.occupied().map((cell) => `${cell.x},${cell.y},${cell.z}:${cell.color}`).sort().join('|')
  const applied = s.applyItem('hammer', '+z', 0, 2, 'row')
  s.spendItem('hammer')
  check('the charge was spent', s.getItemCounts().hammer === 0, `${s.getItemCounts().hammer}`)
  s.openUndo({ id: 'hammer', records: applied.records }, 5000)
  check('the window is open', s.hasUndo() === true && s.getUndo().records === applied.records)
  const undone = s.undoLast()
  check('undo reports how much came back', undone.restored === applied.removed.length, `${undone.restored}`)
  check('undo refunded the charge', s.getItemCounts().hammer === 1, `${s.getItemCounts().hammer}`)
  check('undo closed the window', s.hasUndo() === false)
  const coloursAfter = s.board.occupied().map((cell) => `${cell.x},${cell.y},${cell.z}:${cell.color}`).sort().join('|')
  check('undo restored every cell with its own colour', coloursAfter === coloursBefore, coloursAfter)
  check('undo with nothing to undo is a no-op', s.undoLast() === null)
}

// ---- 12. charges: floors, caps and reset (P6b-1) --------------------------------
{
  const s = fresh()
  const start = s.getItemCounts()
  check('a fresh session has the starting charges',
    start.refresh === 2 && start.hammer === 1 && start.rocket === 1 && start.bomb === 1, JSON.stringify(start))
  s.spendItem('hammer')
  s.spendItem('hammer')
  check('a charge never goes below zero', s.getItemCounts().hammer === 0)
  s.refundItem('hammer')
  s.refundItem('hammer')
  s.refundItem('hammer')
  check('a refund stops at the tool cap', s.getItemCounts().hammer === s.itemTool('hammer').cap, `${s.getItemCounts().hammer}`)
  s.setItemCharge('bomb', -5)
  check('setItemCharge floors at zero', s.getItemCounts().bomb === 0)
  s.setItemCharge('bomb', 99)
  check('setItemCharge does not clamp to the cap (the save path is what clamps)', s.getItemCounts().bomb === 99)
  s.setItemCharge('nope', 3)
  check('setItemCharge ignores unknown tools', s.getItemCounts().nope === undefined)
  s.setItemCounts({ refresh: 0, hammer: 0, rocket: 0, bomb: 0 })
  check('setItemCounts replaces the whole table', s.getItemCounts().refresh === 0 && s.getItemCounts().bomb === 0)
  s.resetItemCounts()
  check('resetItemCounts restores the starting charges',
    s.getItemCounts().rocket === 1 && s.getItemCounts().bomb === 1 && s.getItemCounts().refresh === 2)
  check('the tool table is frozen', Object.isFrozen(s.ITEM_TOOLS) === true)
  check('the tool table is the four real tools', s.ITEM_TOOLS.map((tool) => tool.id).join(',') === 'refresh,hammer,rocket,bomb')
}

// ---- 13. the undo window expires on its own (P6b-1) -----------------------------
{
  const s = fresh()
  let expired = 0
  s.openUndo({ id: 'bomb', records: [] }, 30, () => { expired += 1 })
  check('a fresh window is open', s.hasUndo() === true)
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('the window expired on its own and told main', s.hasUndo() === false && expired === 1, `expired=${expired}`)
  s.openUndo({ id: 'bomb', records: [] }, 5000, () => { expired += 1 })
  s.clearUndo()
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('clearing kills the timer too', expired === 1 && s.hasUndo() === false, `expired=${expired}`)
  s.openUndo({ id: 'bomb', records: [] }, 5000, () => { expired += 1 })
  s.openUndo({ id: 'hammer', records: [] }, 5000, () => { expired += 1 })
  check('opening again replaces the entry, not the timer', s.getUndo().id === 'hammer')
  s.clearUndo()
}

// ---- 14. a spent hand is replaced by a fresh one (P6a) --------------------------
{
  const s = fresh()
  s.deal()
  s.getPieces().forEach((piece) => { piece.used = true })
  check('every piece can be marked used', s.getPieces().every((piece) => piece.used))
  const next = s.deal()
  check('a new deal is a full, unused hand', next.length === 3 && next.every((piece) => !piece.used))
  check('and it replaced the old one', s.getPieces() === next)
}

console.log(`game-session-tests: ${passed}/${total} checks passed`)
if (failures.length) {
  console.log('failures:')
  failures.forEach((failure) => console.log(`  - ${failure}`))
  process.exitCode = 1
}

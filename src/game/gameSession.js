// Game session -- the game's own data model and its pure actions (refactor P6a).
//
// Plan section 2 `game/gameSession.js`: it owns the board, the hand of pieces, the run counters,
// the run token and the two actions that change them without touching anything outside: dealing a
// new hand and settling a placement. It has NO DOM, NO Three.js, NO platform SDK and no UI state,
// so it imports and runs in plain Node -- that is what makes tools/game-session-tests.mjs possible
// (plan section 6 P6: "gameSession 可在 Node 无 DOM/WebGL 环境 import 与测试").
//
// What deliberately stays in main, and why (plan section 6 P6a):
//   - the selection (`selectedPiece`), the drag record and every listener: input, P7;
//   - everything the player sees or hears afterwards (renderBoard, the HUD, the effects, the
//     platform calls): this module RETURNS what happened and main decides how to show it;
//   - `clearItemUndo()`: the undo window belongs to the item flow (P6b), and main still calls it
//     immediately before settlePlacement(), in the order it always ran;
//   - the resume snapshot format (P6b) and the record store (main's endGame()).
import { Board, SH, faceLattice } from './board.js'
import { pickShape, normalizeCells } from './shapes.js'
import { moveScore, nextChain } from './scoring.js'
import { resolveHonors, feedbackLevel } from './honors.js'

export function createGameSession() {
  const board = new Board()

  // Everything the chain indicator, the Game Over panel and the record wall need to
  // know about the run in progress. Nothing here is persisted as-is: endGame() hands
  // it to recordStore, which owns the snapshot format and its migration.
  const run = {
    chain: 0, // consecutive clearing placements; a dead turn zeroes it (08 §4.4)
    bestChain: 0,
    maxLinesOneMove: 0,
    maxFacesOneMove: 0,
    facesLit: new Set(), // faces cleared at least once this run (六面制霸 progress)
    faceWipes: 0,
    honors: [], // ids in the order they were earned
    honorCounts: {},
  }

  // The hand is REPLACED by every deal and by a resumed session, so it is handed out through
  // getPieces()/setPieces() rather than bound to a name that would go stale (the same rule
  // boardView's bearing and pieceView's selection follow).
  let pieces = []
  let runId = 0 // one token per game, so a score is never submitted twice

  function getPieces() {
    return pieces
  }

  function setPieces(next) {
    pieces = next
    return pieces
  }

  function getRunId() {
    return runId
  }

  function resetRun() {
    run.chain = 0
    run.bestChain = 0
    run.maxLinesOneMove = 0
    run.maxFacesOneMove = 0
    run.facesLit.clear()
    run.faceWipes = 0
    run.honors = []
    run.honorCounts = {}
    runId += 1
  }

  function makePiece(shape) {
    return { shape, cells: normalizeCells(shape.cells), used: false }
  }

  function currentCells(piece) {
    return piece.cells
  }

  // A new hand. The caller clears the selection and repaints the slots: that is UI, and it is
  // main's (main.nextPieces() is the wrapper every existing call site still calls).
  function deal() {
    pieces = Array.from({ length: 3 }, () => makePiece(pickShape()))
    return pieces
  }

  // Place a piece and settle everything that follows from it. The return shape is exactly the one
  // main has always destructured: { result, lines, lineCount, honors, level, score, previousChain }.
  // Showing any of it -- sounds, particles, the HUD, the score pop, the slow-motion dip -- is the
  // caller's business.
  function settlePlacement(face, cells, origin, color) {
    const result = board.place(face, cells, origin, color)
    const lines = result.lines
    const lineCount = lines.length
    const previousChain = run.chain
    run.chain = nextChain(previousChain, lineCount)
    if (lineCount > 0) {
      run.bestChain = Math.max(run.bestChain, run.chain)
      lines.forEach((line) => run.facesLit.add(line.face))
    }
    const honors = resolveHonors({ lines: lineCount, faces: result.facesHit })
    const level = feedbackLevel({ lines: lineCount, faces: result.facesHit })
    const score = moveScore({
      cellCount: cells.length,
      lines: lineCount,
      faces: result.facesHit,
      chain: run.chain,
      honorBonus: honors.bonus,
    })
    board.addScore(score.total, lineCount)
    run.maxLinesOneMove = Math.max(run.maxLinesOneMove, lineCount)
    run.maxFacesOneMove = Math.max(run.maxFacesOneMove, result.facesHit)
    run.faceWipes += result.faceWiped.length
    honors.ids.forEach((id) => {
      run.honors.push(id)
      run.honorCounts[id] = (run.honorCounts[id] || 0) + 1
    })
    return { result, lines, lineCount, honors, level, score, previousChain }
  }

  // ---- Items (refactor P6b-1) --------------------------------------------------
  // Plan §2 state table: the charges and the undo RECORD are game data, so they live here; the
  // targeting mode (itemActive/itemTap/itemBusyUntil) and everything the player sees are main's.
  const ITEM_TOOLS = Object.freeze([
    { id: 'refresh', name: 'Refresh', icon: '↻', start: 2, cap: 3 },
    { id: 'hammer', name: 'Hammer', icon: '🔨', start: 1, cap: 2 },
    { id: 'rocket', name: 'Rocket', icon: '🚀', start: 1, cap: 2 },
    { id: 'bomb', name: 'Bomb', icon: '💣', start: 1, cap: 2 },
  ])
  // Replaced wholesale by a reset or a resumed session, so it is read through getItemCounts().
  let itemCounts = Object.fromEntries(ITEM_TOOLS.map((tool) => [tool.id, tool.start]))
  // { id, records } while the undo window is open. `records` carry the COLOURS the removed cells
  // had, which is what makes the undo exact rather than cosmetic (07 §3.1 A9).
  let itemUndo = null
  let itemUndoTimer = 0

  function getItemCounts() {
    return itemCounts
  }

  function setItemCounts(next) {
    itemCounts = next
    return itemCounts
  }

  function setItemCharge(id, count) {
    if (id in itemCounts) itemCounts[id] = Math.max(0, Math.trunc(Number(count) || 0))
    return { ...itemCounts }
  }

  function itemTool(id) {
    return ITEM_TOOLS.find((tool) => tool.id === id)
  }

  function resetItemCounts() {
    itemCounts = Object.fromEntries(ITEM_TOOLS.map((tool) => [tool.id, tool.start]))
    return itemCounts
  }

  function spendItem(id) {
    itemCounts[id] = Math.max(0, itemCounts[id] - 1)
  }

  function refundItem(id) {
    const tool = itemTool(id)
    itemCounts[id] = Math.min(tool ? tool.cap : itemCounts[id] + 1, itemCounts[id] + 1)
  }

  // Which lattice cells a tool covers from a face cell (07 §3.1 A5). The rocket's row/column is
  // the one thing the player can still change while aiming, so it arrives as a parameter: the
  // aiming state is main's (P7), the shape of the tool's reach is the rule and lives here.
  function toolScopeCells(id, face, u, v, orientation) {
    if (id === 'hammer') return [faceLattice(face, u, v)]
    if (id === 'rocket') {
      const cells = []
      if (orientation === 'col') for (let i = 0; i < SH; i += 1) cells.push(faceLattice(face, u, i))
      else for (let i = 0; i < SH; i += 1) cells.push(faceLattice(face, i, v))
      return cells
    }
    // bomb: 2×2 square on the face, growing toward +u/+v, trimmed to bounds
    const cells = []
    for (let du = 0; du <= 1; du += 1) for (let dv = 0; dv <= 1; dv += 1) {
      const cu = u + du
      const cv = v + dv
      if (cu < SH && cv < SH) cells.push(faceLattice(face, cu, cv))
    }
    return cells
  }

  // A tool's whole effect on the board, in the order it has always run: read the records BEFORE
  // the removal (undo needs the colours; removeCells only hands back coordinates), then remove.
  // Nothing is scored and no chain moves - a tool is not a placement (07 §1.2).
  function applyItem(id, face, u, v, orientation) {
    const scope = toolScopeCells(id, face, u, v, orientation)
    const records = board.peekCells(scope)
    const removed = board.removeCells(scope)
    return { scope, records, removed }
  }

  // ---- The undo window (refactor P6b-1) ----------------------------------------
  // Plan §2: `itemUndoTimer` belongs to the session's undo window, and expiry/clear must not touch
  // the DOM - main is told instead. One business path only: clearing the window here and showing it
  // in main happen together, so the UI can never look undoable while the session cannot undo.
  function openUndo(entry, ms, onExpire) {
    clearUndo()
    itemUndo = entry
    itemUndoTimer = setTimeout(() => {
      clearUndo()
      if (onExpire) onExpire()
    }, ms)
  }

  function clearUndo() {
    itemUndo = null
    if (itemUndoTimer) clearTimeout(itemUndoTimer)
    itemUndoTimer = 0
  }

  function hasUndo() {
    return itemUndo !== null
  }

  function getUndo() {
    return itemUndo
  }

  // Undo: the window closes first, then the cells come back with their own colours and the charge
  // is refunded. main shows the result (toast/haptics/board repaint) and runs the stuck check.
  function undoLast() {
    if (!itemUndo) return null
    const { id, records } = itemUndo
    clearUndo()
    const restored = board.addCells(records)
    refundItem(id)
    return { id, records, restored }
  }

  return {
    // The two const records, mutated in place: main binds them straight back to `board` and `run`.
    board,
    run,
    // The two that are reassigned go through accessors.
    getPieces,
    setPieces,
    getRunId,
    // Actions.
    resetRun,
    deal,
    makePiece,
    currentCells,
    settlePlacement,
    // Items (P6b-1): the charges, the tool's reach, its effect on the board and the undo window.
    ITEM_TOOLS,
    getItemCounts,
    setItemCounts,
    setItemCharge,
    itemTool,
    resetItemCounts,
    spendItem,
    refundItem,
    toolScopeCells,
    applyItem,
    openUndo,
    clearUndo,
    hasUndo,
    getUndo,
    undoLast,
  }
}

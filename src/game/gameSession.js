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
import { Board } from './board.js'
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
  }
}

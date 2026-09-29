// Game session -- the game's own data model and its pure actions (refactor P6a).
//
// Plan section 2 `game/gameSession.js`: it owns the board, the hand of pieces, the run counters,
// the run token, the item charges and the undo window, the rescue judgement, the end-of-run flags
// and the resume snapshot's game data, plus the actions that change them without touching anything
// outside: dealing a new hand, settling a placement, applying a tool and restoring a save. It has
// NO DOM, NO Three.js, NO platform SDK and no UI state, so it imports and runs in plain Node --
// that is what makes tools/game-session-tests.mjs possible (plan section 6 P6: "gameSession 可在
// Node 无 DOM/WebGL 环境 import 与测试").
//
// What deliberately stays in main, and why (plan section 6 P6a):
//   - the selection (`selectedPiece`), the drag record and every listener: input, P7;
//   - everything the player sees or hears afterwards (renderBoard, the HUD, the effects, the
//     platform calls): this module RETURNS what happened and main decides how to show it;
//   - `clearItemUndo()`: the undo window belongs to the item flow (P6b), and main still calls it
//     immediately before settlePlacement(), in the order it always ran;
//   - the STORE and the pose: the snapshot's game data is here (P6b-2) and main merges the pose
//     in, because the store is platform-facing and the pose is boardView's;
//   - the order that ends a run (local record, slot, platform): main's endGame().
import { Board, SH, faceLattice } from './board.js'
import { SHAPES, normalizeCells } from './shapes.js'
import { moveScore, nextChain } from './scoring.js'
import { resolveHonors, feedbackLevel } from './honors.js'
import { createStreams } from './rng.js'
import { runDeal } from './dealRun.js'
import {
  createDirectorState, notePlacement, revive as reviveDirector, serialize as serializeDirector,
  tierOf,
} from './dealDirector.js'
import { FALLBACK_REASONS } from './dealConfig.js'

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

  // v0.9.0 P1: the difficulty director and the separated random streams. Both are part of the
  // RUN, not of the module, so they are replaced wholesale by a reset or a resume — the same
  // rule the hand and the item counts already follow.
  let director = createDirectorState()
  let streams = createStreams(Math.floor(Math.random() * 0xffffffff))
  // The last batch's search report (tolerance interval, pressure change, fallback, witness).
  // Kept for the run report and the probes; nothing in the game loop branches on it.
  let lastDealMetrics = null

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
    // A new run is a new difficulty run: back to step 0, warmup, a fresh seed. Without this a
    // restart would inherit the previous run's tier and hand the player a level-3 deal on an
    // empty board (and the same random stream, which would deal the same opening hands).
    dealEpoch += 1 // a batch in flight belongs to the run that has just been thrown away
    resetDirector()
  }

  function makePiece(shape) {
    return { shape, cells: normalizeCells(shape.cells), used: false }
  }

  function currentCells(piece) {
    return piece.cells
  }

  // One piece per turn: a settled placement spends the candidate it was dropped from. The hand is
  // the session's, so the flag is set through here rather than by whoever happens to hold the
  // piece (plan §6 P6a: 现存 currentDrag.piece.used = true 改由明确 session 动作执行，时机保持 —
  // main still calls it at the same point of the drop it always did).
  function usePiece(piece) {
    piece.used = true
    return piece
  }

  // ---- The deal (v0.9.0 P1; the search left this thread in v0.9.31) ------------
  // The hand is no longer three blind draws: the dealer proposes up to 36 batches, proves what
  // each can do on THIS board and picks one against the director's intent — see dealer.js for why.
  // Since v0.9.31 that transaction also runs in a worker (dealRun.js): it used to run inside the
  // frame the player released a piece on, at 40ms+ on a desktop and several times that on a phone,
  // which the producer reported as 「放置上去会卡顿一下」. What is left here is WHEN a returned
  // batch becomes the hand — and the one rule that keeps the game honest is unchanged: a batch that
  // cannot be dealt at all (the cube has no legal placement for any shape) leaves the PREVIOUS hand
  // in place rather than emptying it. An empty hand would read as `idle` in stuckOutcome() and
  // silently skip the stuck flow; a fully-used hand is exactly the state the flow exists for.
  let dealEpoch = 0 // bumped by anything that replaces the run's state under an in-flight deal
  let inFlight = null // { id, resolve } while the worker is answering
  let worker = null
  let workerUnavailable = false
  let dealRequestId = 0

  // Everything the deal needs, as data the worker can be handed: the board's occupancy in the same
  // [x, y, z, color] rows the resume slot stores, the director's save state, the random streams'
  // save state and the reason. The worker therefore never has to know what a Board is.
  function dealInput(reason) {
    return {
      cells: board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]),
      director: serializeDirector(director),
      streams: streams.snapshot(),
      reason: reason === 'refresh' ? 'refresh' : 'natural',
    }
  }

  // A returned batch becomes the hand HERE and nowhere else, and it takes the director and the
  // random streams with it: the worker ran on copies, so committing means adopting that copy's next
  // state. It is the same state the synchronous path reaches, because it is the same function that
  // produced it (dealRun.runDeal) — that is what makes the worker safe to put a run behind.
  function commitDeal(result) {
    lastDealMetrics = result.metrics
    if (!result.ok) {
      // Nothing is committed and nothing is spent: the caller keeps the hand it had, and main shows
      // the player what the stuck flow already says (§7.2).
      return { ok: false, pieces: null, metrics: result.metrics, reason: result.reason ?? result.metrics?.fallback }
    }
    director = reviveDirector(result.director)
    streams.restore(result.streams)
    pieces = result.names.map((name) => shapeByName.get(name)).filter(Boolean).map(makePiece)
    return { ok: true, pieces, metrics: result.metrics, names: result.names, witness: result.witness }
  }

  // A new hand. The caller clears the selection and repaints the slots: that is UI, and it is
  // main's (main.nextPieces() is the wrapper every existing call site still calls).
  //
  // The historical contract is "deal() hands back the hand", and every existing call site and test
  // relies on it. It is now also the FALLBACK: a resumed run completing a short hand, and any
  // environment without a worker, come through here rather than through the async path.
  function deal(options = {}) {
    const result = dealFor(options.reason === 'refresh' ? 'refresh' : 'natural')
    // A refused deal hands back the batch that is already on the board — used up, which is the
    // state the stuck flow reads — and the reason is available through getDealMetrics().
    return result.ok ? result.pieces : pieces
  }

  function dealFor(reason) {
    return commitDeal(runDeal(dealInput(reason)))
  }

  // The item Refresh (07 §2.1) goes through the same service, on the relief target and with
  // Block 9 excluded. It reports success so the caller can refuse to spend the charge: the spec's
  // rule is that the inventory moves only after a new batch exists (§10.1).
  function refreshDeal() {
    return dealFor('refresh')
  }

  function ensureWorker() {
    if (worker || workerUnavailable) return worker
    if (typeof Worker === 'undefined') {
      // No worker to be had: the synchronous path is the whole deal, exactly as it was before
      // v0.9.31. Slower on the drop frame, identical in what it deals.
      workerUnavailable = true
      return null
    }
    try {
      worker = new Worker(new URL('./dealWorker.js', import.meta.url), { type: 'module' })
      worker.onmessage = (event) => {
        const waiter = inFlight
        inFlight = null
        if (waiter && waiter.id === event.data?.id) waiter.resolve(event.data)
      }
      // A worker that failed to load, or that threw outside the request handler, can answer
      // nothing: mark it broken and resolve the pending request as a FAILURE so the caller falls
      // back, rather than leaving the player's turn waiting on a message that will never come.
      worker.onerror = () => {
        workerUnavailable = true
        worker = null
        const waiter = inFlight
        inFlight = null
        if (waiter) waiter.resolve({ id: waiter.id, ok: false, error: 'worker-error' })
      }
    } catch {
      workerUnavailable = true
      worker = null
    }
    return worker
  }

  // The same deal, off this thread. It resolves with exactly what dealFor() returns, so a caller
  // never has to branch on which one it got — and a worker that cannot answer degrades to the
  // synchronous path instead of failing the player's turn.
  function dealAsync(reason = 'natural') {
    const wanted = reason === 'refresh' ? 'refresh' : 'natural'
    const active = ensureWorker()
    if (!active) return Promise.resolve(dealFor(wanted))
    const epoch = dealEpoch
    const id = (dealRequestId += 1)
    const request = dealInput(wanted)
    return new Promise((resolve) => {
      inFlight = { id, resolve }
      try {
        active.postMessage({ id, request })
      } catch {
        workerUnavailable = true
        worker = null
        inFlight = null
        resolve({ id, ok: false, error: 'postMessage-failed' })
      }
    }).then((reply) => {
      if (!reply || !reply.ok) return dealFor(wanted)
      // The run was replaced while the worker was thinking (a new game, a resume, a reset): the
      // batch answers a board that no longer exists, so it is dropped rather than committed.
      if (epoch !== dealEpoch) return { ok: false, stale: true, pieces, metrics: lastDealMetrics }
      return commitDeal(reply.result)
    })
  }

  // "A hand is on its way." The input layer closes the tray's and the item strip's gates on this,
  // so a second deal cannot be asked for while the first is still being computed, and the used-up
  // hand on screen cannot be dragged while its replacement is in flight.
  function isDealing() {
    return inFlight !== null
  }

  function resetDirector(seed = null) {
    dealEpoch += 1
    director = createDirectorState()
    streams = createStreams(seed === null ? Math.floor(Math.random() * 0xffffffff) : seed)
    lastDealMetrics = null
    return director
  }

  function getDirector() {
    return director
  }

  // Read-only view for the HUD, the run report and the probes. Nothing in the game branches
  // on the tier yet — P1 changes the deal, not the interface.
  function progress() {
    return {
      placementCount: director.placementCount,
      tier: tierOf(director.placementCount),
      phase: director.phase,
      challengePlacementsLeft: director.challengePlacementsLeft,
      reliefPending: director.reliefPending,
      naturalBatchIndex: director.naturalBatchIndex,
    }
  }

  function getDealMetrics() {
    return lastDealMetrics
  }

  // Place a piece and settle everything that follows from it. The return shape is exactly the one
  // main has always destructured: { result, lines, lineCount, honors, level, score, previousChain }.
  // Showing any of it -- sounds, particles, the HUD, the score pop, the slow-motion dip -- is the
  // caller's business.
  function settlePlacement(face, cells, origin, color) {
    const result = board.place(face, cells, origin, color)
    // One step = one settled placement (§4.1). A drag, an illegal drop, a cube turn, a pause, a
    // load, an item use and its undo, and a refresh all deliberately do NOT come through here.
    // The tier is derived from this counter, so the challenge stretch and the milestone
    // crossing are read off the same number the player's progress is.
    const step = notePlacement(director)
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
    return { result, lines, lineCount, honors, level, score, previousChain, step }
  }

  // ---- Items (refactor P6b-1) --------------------------------------------------
  // Plan §2 state table: the charges and the undo RECORD are game data, so they live here; the
  // targeting mode (itemActive/itemTap/itemBusyUntil) and everything the player sees are main's.
  // NO DISPLAY NAME HERE (docs/Technical/LOCALIZATION.md): the strip's caption and the status
  // bar's title come from the i18n catalogue by id (`item.name.hammer`). A `name` field here
  // was a second copy that the language switch could never reach — it was never read, so it is
  // gone rather than translated.
  const ITEM_TOOLS = Object.freeze([
    { id: 'refresh', icon: '↻', start: 2, cap: 3 },
    { id: 'hammer', icon: '🔨', start: 1, cap: 2 },
    { id: 'rocket', icon: '🚀', start: 1, cap: 2 },
    { id: 'bomb', icon: '💣', start: 1, cap: 2 },
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

  // Which FACE cells a tool covers from an anchor (07 §8.5.4). This is the tool's reach in the
  // coordinates the preview draws in — the frame, the internal ruling and the per-cell empty/
  // occupied split are all per face cell — while `toolScopeCells()` below is the same list
  // resolved to lattice coordinates, which is what removal and the undo record need. One
  // definition, two projections: if the frame and the clear could disagree about where a bomb
  // reaches, §8.5.7's 「所见即所得」 would be unenforceable.
  //
  // The rocket's row/column is the one thing the player can still change while aiming, so the
  // orientation arrives as a parameter: the aiming state is the input layer's (P7), the SHAPE of
  // the reach is a rule and lives here. §8.6's clipping is kept exactly as shipped — the bomb
  // grows toward +u/+v and is cut by the face edge rather than slid inwards to fit.
  function toolScopeFaceCells(id, face, u, v, orientation) {
    if (id === 'hammer') return [{ u, v }]
    if (id === 'rocket') {
      const cells = []
      if (orientation === 'col') for (let i = 0; i < SH; i += 1) cells.push({ u, v: i })
      else for (let i = 0; i < SH; i += 1) cells.push({ u: i, v })
      return cells
    }
    const cells = []
    for (let du = 0; du <= 1; du += 1) for (let dv = 0; dv <= 1; dv += 1) {
      const cu = u + du
      const cv = v + dv
      if (cu < SH && cv < SH) cells.push({ u: cu, v: cv })
    }
    return cells
  }

  function toolScopeCells(id, face, u, v, orientation) {
    return toolScopeFaceCells(id, face, u, v, orientation).map((cell) => faceLattice(face, cell.u, cell.v))
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

  // ---- End of run and the resume slot (refactor P6b-2) -------------------------
  // Plan §3: `gameEnded` and `runLive` are the session's state. The ORDER that ends a run -- local
  // record, HUD, slot cleared, score handed to the platform -- stays in main's endGame(); what
  // lives here is the two flags that make it idempotent and the one question that reads both.
  let gameEnded = false
  // "The player is in a run that has not finished." Kept separate from `pieces.length` on purpose:
  // the game boots with no run open, and writing a slot there would offer 继续游戏 on a board
  // nobody has touched.
  let runLive = false

  function isEnded() {
    return gameEnded
  }

  function setEnded(flag) {
    gameEnded = flag === true
    return gameEnded
  }

  function setRunLive(flag) {
    runLive = flag === true
    return runLive
  }

  // The resume slot is only worth writing for a run the player is in and has not finished
  // (plan §6 P6: 结束后不生成可保存局). main's saveSession() asks this before touching the store.
  function isSaveable() {
    return runLive && !gameEnded
  }

  // ---- The rescue judgement (refactor P6b-2) -----------------------------------
  function hasPlaceablePiece() {
    return pieces.some((piece) => !piece.used && board.anyPlacement(piece.cells))
  }

  // 07 §3.1 B1 (v0.8.16): a jam no longer ends the run while a blocking-clear tool is
  // still charged — the item that can open a hole has to be allowed to be used, or three
  // of the four tools are decorative exactly when they matter. This is deliberately NOT a
  // solvability check: whether hammer / rocket / bomb can actually open a legal spot is
  // the player's judgement, and the exhaustive search (6 faces × 25 targets × 3 tools × 3
  // candidate cells × their orientations) costs far more than it is worth. The charges
  // are what keep this from looping: every prompt names a tool the player can spend, and
  // the run ends when the last one is gone.
  function hasBlockingClearTool() {
    return itemCounts.hammer > 0 || itemCounts.rocket > 0 || itemCounts.bomb > 0
  }

  // The judgement only: no DOM, no status text, no ending. What the player reads and whether the
  // run is over are main's (plan §6 P6b asks for named outcomes, not a string event list), so
  // these four answers are the whole contract. `idle` is the two cases the old guard swallowed —
  // the run is already over, or there is no hand to judge.
  function stuckOutcome() {
    if (gameEnded || !pieces.length) return 'idle'
    if (hasPlaceablePiece()) return 'playable'
    if (itemCounts.refresh > 0) return 'refresh'
    if (hasBlockingClearTool()) return 'clear-path'
    return 'end'
  }

  // ---- The resume snapshot's game data (refactor P6b-2) ------------------------
  // Plan §4: the DATA half is the session's, the store and the presentation stay in main, and the
  // pose is boardView's — main merges that one key in. Nothing here reads or writes storage.
  function snapshot() {
    return {
      board: {
        cells: board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]),
        score: board.score,
        totalLines: board.totalLines,
      },
      // Names, not shape objects: the pool is the single source of truth for a
      // candidate's colour and cells, so a snapshot can never resurrect a shape that
      // was retired from the pool (v0.2.24 的 5 长线、v0.2.31 的 4 长线).
      pieces: pieces.map((piece) => ({ name: piece.shape.name, used: piece.used })),
      items: { ...itemCounts },
      // v0.9.0 P1 (§4.3): from this version a save carries the run's PROGRESS, not just its
      // board — the step count, the phase machine's counters, Block 9's cooldown, the recent
      // hands and the exact state of every random stream. That is what makes a resumed run
      // continue the same difficulty instead of restarting it, and what makes "the same save
      // replayed twice deals the same hands" true.
      director: serializeDirector(director),
      streams: streams.snapshot(),
      run: {
        chain: run.chain,
        bestChain: run.bestChain,
        maxLinesOneMove: run.maxLinesOneMove,
        maxFacesOneMove: run.maxFacesOneMove,
        facesLit: [...run.facesLit],
        faceWipes: run.faceWipes,
        honors: [...run.honors],
        honorCounts: { ...run.honorCounts },
      },
    }
  }

  // Name -> shape, derived from the pool, which stays the single source of truth: a save only ever
  // names a shape, so a retired one simply fails to resolve and its slot is dealt again.
  const shapeByName = new Map(SHAPES.map((shape) => [shape.name, shape]))

  // THREE.MathUtils.clamp, in plain code: this module has no Three.js (plan §2 boundary). Same
  // arithmetic, so a hand-edited or stale save clamps to exactly the band it always did.
  function clampCharge(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  // The data half of a resume. Everything the player sees afterwards — repaint, HUD, chain strip,
  // item bar, pause — is main's applySession(), which calls this in the middle of its own order.
  function applySnapshot(saved) {
    board.restore(saved.board)
    run.chain = saved.run.chain
    run.bestChain = saved.run.bestChain
    run.maxLinesOneMove = saved.run.maxLinesOneMove
    run.maxFacesOneMove = saved.run.maxFacesOneMove
    run.facesLit = new Set(saved.run.facesLit)
    run.faceWipes = saved.run.faceWipes
    run.honors = [...saved.run.honors]
    run.honorCounts = { ...saved.run.honorCounts }
    const restoredPieces = saved.pieces
      .map((entry) => {
        const shape = shapeByName.get(entry.name)
        if (!shape) return null
        const piece = makePiece(shape)
        piece.used = entry.used
        return piece
      })
      .filter(Boolean)
    // The run's PROGRESS comes back before the hand is completed: the director decides what
    // the fill batch is aimed at (relief) and the stream state decides what it draws, so
    // restoring them afterwards would deal the fill from the wrong run's state.
    director = reviveDirector(saved.director)
    if (saved.streams) streams.restore(saved.streams)
    lastDealMetrics = null
    // A batch dealt for the run that was on screen a moment ago answers the wrong board: the
    // in-flight request is invalidated here, and its reply is dropped when it arrives.
    dealEpoch += 1
    // A retired shape can leave fewer than three candidates; deal the missing slots
    // instead of resuming with a short strip (the layout is a fixed row of three).
    // v0.9.0 P1: those slots come from the same dealer, on the relief target, because a
    // resumed run must never be handed a hand it cannot finish. A resumed hand that IS
    // complete is left exactly as it was (the spec forbids re-dealing a displayed hand).
    while (restoredPieces.length < 3) {
      const fill = dealFor('refresh')
      if (!fill.ok) break
      restoredPieces.push(...fill.pieces.slice(0, 3 - restoredPieces.length))
    }
    setPieces(restoredPieces)
    itemCounts = Object.fromEntries(ITEM_TOOLS.map((tool) => [
      tool.id,
      clampCharge(Number.isFinite(saved.items[tool.id]) ? saved.items[tool.id] : tool.start, 0, tool.cap),
    ]))
    return restoredPieces
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
    refreshDeal,
    // v0.9.31: the same deal, off the main thread, plus the "one is on its way" state the input
    // gates read. `deal()` stays for the resume fill, the tools and the worker-less fallback.
    dealAsync,
    isDealing,
    resetDirector,
    getDirector,
    progress,
    getDealMetrics,
    makePiece,
    currentCells,
    usePiece,
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
    toolScopeFaceCells,
    applyItem,
    openUndo,
    clearUndo,
    hasUndo,
    getUndo,
    undoLast,
    // End of run, the resume slot and the rescue judgement (P6b-2): the flags and the answer,
    // never the flow that shows them.
    isEnded,
    setEnded,
    setRunLive,
    isSaveable,
    stuckOutcome,
    // The snapshot's game data: main merges the pose in and owns the store.
    snapshot,
    applySnapshot,
  }
}

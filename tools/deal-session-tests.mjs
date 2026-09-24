// Deal integration at the SESSION level (v0.9.0 P1). Run: node tools/deal-session-tests.mjs
//
// The two suites next door prove the dealer and the director. This one proves the seam that
// would be easiest to get wrong and hardest to notice: what a SAVE carries, what an OLD save
// becomes, and that resuming a run does not silently reset (or re-grant) its difficulty.
//
// The spec's §4.3 rules being pinned here:
//   - an old save keeps its board, hand, score, items and honors;
//   - the step count is NOT reconstructed from the score — a migrated run starts at 0 and says
//     so through a `migration` flag;
//   - the first deal after a migration gets ONE buffer batch, and that buffer is not granted
//     again on the next load (it is persisted as consumed);
//   - a resumed run continues the same random stream, so the same save replayed twice deals
//     the same hands;
//   - a hand that is already on screen is never re-dealt by a load.
import { Board } from '../src/game/board.js'
import { OPENING_SHAPES } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'
import { createGameSession } from '../src/game/gameSession.js'
import { createRng } from '../src/game/rng.js'
import { migrate, SESSION_VERSION } from '../src/game/session.js'
import { WARMUP_BATCHES } from '../src/game/dealConfig.js'

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) passed += 1
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function equal(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// A session with a deterministic seed and an opening board.
function freshSession(seed = 1) {
  const session = createGameSession()
  session.board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT, createRng(seed))
  session.resetDirector(seed)
  return session
}

// Fill the whole shell: no shape has any legal placement anywhere.
function fillCube(board) {
  for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) for (let z = 0; z < 5; z += 1) {
    if (x === 0 || y === 0 || z === 0 || x === 4 || y === 4 || z === 4) {
      board.cells.set(board.key(x, y, z), { x, y, z, color: 1 })
    }
  }
}

// ---- A new run starts at step 0 in warmup -----------------------------------
{
  const session = freshSession(11)
  equal('a fresh run is at step 0', session.progress().placementCount, 0)
  equal('a fresh run is in warmup', session.progress().phase, 'warmup')
  equal('a fresh run is tier 0', session.progress().tier, 0)
  const hand = session.deal()
  equal('a natural deal hands out three pieces', hand.length, 3)
  equal('the first natural batch is a warmup batch', session.getDealMetrics().phase, 'warmup')
  check('the batch was proven on the real board', session.getDealMetrics().proofStatus !== 'UNSOLVABLE',
    session.getDealMetrics().proofStatus)
}

// ---- The step counter is advanced by exactly one action --------------------
{
  const session = freshSession(12)
  session.deal()
  equal('dealing does not advance the step counter', session.progress().placementCount, 0)
  session.settlePlacement('+z', [[0, 0]], { u: 4, v: 4 }, 0xffffff)
  equal('one settled placement is one step', session.progress().placementCount, 1)
  // An item does not come through settlePlacement, so it cannot advance the counter.
  session.applyItem('hammer', '+z', 4, 4, 'row')
  equal('using an item is not a step', session.progress().placementCount, 1)
  session.undoLast()
  equal('undoing an item is not a step', session.progress().placementCount, 1)
  session.refreshDeal()
  equal('a refresh is not a step', session.progress().placementCount, 1)
}

// ---- A reset really resets the difficulty ---------------------------------
{
  const session = freshSession(13)
  for (let i = 0; i < 40; i += 1) session.settlePlacement('+z', [[0, 0]], { u: i % 5, v: 4 - (i % 3) }, 1)
  check('the run climbed past tier 0', session.progress().tier >= 1, `${session.progress().tier}`)
  session.resetRun()
  equal('a new run goes back to step 0', session.progress().placementCount, 0)
  equal('a new run goes back to tier 0', session.progress().tier, 0)
  equal('a new run goes back to warmup', session.progress().phase, 'warmup')
}

// ---- A v2 save round-trips the progress ------------------------------------
{
  const session = freshSession(14)
  session.deal()
  for (let i = 0; i < 5; i += 1) session.settlePlacement('+z', [[0, 0]], { u: i, v: 4 }, 1)
  const snap = session.snapshot()
  const round = migrate(JSON.parse(JSON.stringify({ ...snap, at: Date.now() })))
  equal('the migrated snapshot is at the current version', round.v, SESSION_VERSION)
  equal('the step count survives a save', round.director.placementCount, snap.director.placementCount)
  equal('the phase survives a save', round.director.phase, snap.director.phase)
  equal('the natural batch index survives a save', round.director.naturalBatchIndex, snap.director.naturalBatchIndex)
  equal('the stream states survive a save', JSON.stringify(round.streams), JSON.stringify(snap.streams))
  check('a v2 save is not marked as a migration', round.director.migration !== true)

  const resumed = createGameSession()
  resumed.applySnapshot(round)
  equal('the resumed run is on the same step', resumed.progress().placementCount, session.progress().placementCount)
  equal('the resumed run is in the same phase', resumed.progress().phase, session.progress().phase)
  // The same save replayed twice must deal the same hands — that is the whole point of saving
  // the stream state rather than only a seed.
  const a = createGameSession(); a.applySnapshot(JSON.parse(JSON.stringify(round)))
  const b = createGameSession(); b.applySnapshot(JSON.parse(JSON.stringify(round)))
  equal('two replays of one save deal the same hand', a.deal().map((p) => p.shape.name).join(','), b.deal().map((p) => p.shape.name).join(','))
}

// ---- A pre-v0.9.0 save: no director, one buffer batch, no repeat buffer -----
{
  const session = freshSession(15)
  session.deal()
  for (let i = 0; i < 12; i += 1) session.settlePlacement('+z', [[0, 0]], { u: i % 5, v: 4 - Math.floor(i / 5) }, 1)
  const modern = session.snapshot()
  // Strip the v0.9.0 fields to make it look like a v1 slot.
  const legacy = { board: modern.board, pieces: modern.pieces, items: modern.items, run: modern.run, v: 1, at: Date.now() }

  const migrated = migrate(JSON.parse(JSON.stringify(legacy)))
  check('an old save is still resumable', migrated !== null)
  equal('an old save keeps its board', migrated.board.cells.length, modern.board.cells.length)
  equal('an old save keeps its score', migrated.board.score, modern.board.score)
  equal('an old save keeps its hand', migrated.pieces.length, 3)
  equal('the step count is NOT reconstructed from anything', migrated.director.placementCount, 0)
  equal('a migrated run is flagged as one', migrated.director.migration, true)
  check('a migrated run is past warmup so its buffer batch is a relief batch',
    migrated.director.naturalBatchIndex === WARMUP_BATCHES, `${migrated.director.naturalBatchIndex}`)
  equal('a migrated run is owed one buffer batch', migrated.director.reliefPending, true)

  const resumed = createGameSession()
  resumed.applySnapshot(migrated)
  resumed.setRunLive(true)
  // Play the hand out and deal the next batch: it must be the relief batch.
  resumed.getPieces().forEach((piece) => { piece.used = true })
  resumed.deal()
  equal('the first batch after a migration is the buffer batch', resumed.getDealMetrics().phase, 'relief')

  // The buffer is consumed once: the state that gets saved no longer owes it.
  const saved = migrate(JSON.parse(JSON.stringify({ ...resumed.snapshot(), at: Date.now() })))
  equal('the buffer is not owed again after being dealt', saved.director.reliefPending, false)
  const secondLoad = createGameSession()
  secondLoad.applySnapshot(saved)
  secondLoad.getPieces().forEach((piece) => { piece.used = true })
  secondLoad.deal()
  check('the second load does not get another buffer batch', secondLoad.getDealMetrics().phase !== 'relief',
    secondLoad.getDealMetrics().phase)
}

// ---- A load never re-deals the hand that is on screen ---------------------
{
  const session = freshSession(16)
  session.deal()
  session.getPieces()[0].used = true
  const before = session.getPieces().map((piece) => `${piece.shape.name}:${piece.used}`).join(',')
  const snap = migrate(JSON.parse(JSON.stringify({ ...session.snapshot(), at: Date.now() })))
  const resumed = createGameSession()
  resumed.applySnapshot(snap)
  equal('a resumed hand is exactly the hand that was saved',
    resumed.getPieces().map((piece) => `${piece.shape.name}:${piece.used}`).join(','), before)
}

// ---- A refresh reports failure instead of spending ------------------------
{
  const session = freshSession(17)
  session.deal()
  const before = session.getPieces().map((piece) => piece.shape.name).join(',')
  fillCube(session.board)
  const result = session.refreshDeal()
  equal('a refresh on a full cube reports failure', result.ok, false)
  equal('and says why', result.reason, 'board-no-first-move')
  equal('and leaves the hand alone', session.getPieces().map((piece) => piece.shape.name).join(','), before)
  equal('and does not advance the natural batch counter', session.progress().naturalBatchIndex, 1)
}

// ---- A refused natural deal leaves a used hand for the stuck flow ----------
{
  const session = freshSession(18)
  session.deal()
  session.getPieces().forEach((piece) => { piece.used = true })
  fillCube(session.board)
  session.deal()
  check('the hand is still the used one, so the stuck flow can see it', session.getPieces().every((piece) => piece.used))
  check('the stuck judgement is not idle', session.stuckOutcome() !== 'idle', session.stuckOutcome())
  check('the stuck judgement asks for a rescue, not silence',
    ['refresh', 'clear-path', 'end'].includes(session.stuckOutcome()), session.stuckOutcome())
}

// ---- A short hand (retired shape) is topped up from the dealer -------------
{
  const session = freshSession(19)
  const snap = {
    v: 1,
    at: Date.now(),
    board: { cells: [[0, 0, 4, 0xc22b58]], score: 0, totalLines: 0 },
    // 'Line 5' is not in the shipped pool, so this slot cannot be restored.
    pieces: [{ name: 'Line 5', used: false }, { name: 'Dot', used: false }],
    items: { refresh: 2, hammer: 1, rocket: 1, bomb: 1 },
    run: { chain: 0, bestChain: 0, maxLinesOneMove: 0, maxFacesOneMove: 0, facesLit: [], faceWipes: 0, honors: [], honorCounts: {} },
  }
  const migrated = migrate(snap)
  const resumed = createGameSession()
  resumed.applySnapshot(migrated)
  equal('a short hand is topped back up to three slots', resumed.getPieces().length, 3)
  check('the topped-up slots are unused', resumed.getPieces().slice(1).every((piece) => piece.used === false))
}

// ---- Spec §12.3: a milestone never rewrites the hand on screen --------------
// "29→30、59→60、89→90 的等级边界正确，旧手牌不变" — the tier changes the NEXT batch, never the
// one the player is looking at. This is the difference between "the game got harder" and "the
// game took my pieces away".
{
  for (const boundary of [30, 60, 90]) {
    const session = freshSession(20 + boundary)
    session.getDirector().placementCount = boundary - 1
    session.deal()
    const before = session.getPieces().map((piece) => `${piece.shape.name}:${piece.used}`).join(',')
    const tierBefore = session.progress().tier
    session.settlePlacement('+z', [[0, 0]], { u: 0, v: 4 }, 1)
    equal(`step ${boundary} crosses the tier boundary`, session.progress().tier, tierBefore + 1)
    equal(`step ${boundary}: the hand on screen is untouched`, session.getPieces().map((piece) => `${piece.shape.name}:${piece.used}`).join(','), before)
  }
}

// ---- Spec §12.3: an item's undo cannot be used as a free re-deal -------------
// "清理道具撤销能恢复相关导演状态；无免费重抽漏洞." A clear tool changes the BOARD, and the
// board is what the next deal is computed from — so "use it, look at what the dealer would have
// given you, then undo" would be a free reroll if the undo left anything behind. The undo
// restores the cells and the charge; the check here is that the hand and the director are
// bit-identical across the pair, so there is nothing to peek at.
{
  const session = freshSession(23)
  session.deal()
  session.board.addCells([{ x: 4, y: 0, z: 0, color: 1 }, { x: 4, y: 1, z: 0, color: 1 }])
  const handBefore = session.getPieces().map((piece) => `${piece.shape.name}:${piece.used}`).join(',')
  const progressBefore = JSON.stringify(session.progress())
  const cellsBefore = session.board.occupied().length
  const chargesBefore = session.getItemCounts().hammer

  const applied = session.applyItem('hammer', '+x', 0, 0, 'row')
  // The charge is spent by the caller (main spends it when the tool is committed); `applyItem`
  // is only the board effect. Mirroring that order is what makes the refund meaningful.
  session.spendItem('hammer')
  session.openUndo({ id: 'hammer', records: applied.records }, 3000, null)
  session.undoLast()

  equal('the cells are back', session.board.occupied().length, cellsBefore)
  equal('the charge is back', session.getItemCounts().hammer, chargesBefore)
  equal('the hand is untouched by the item and its undo', session.getPieces().map((piece) => `${piece.shape.name}:${piece.used}`).join(','), handBefore)
  equal('the director state is untouched too', JSON.stringify(session.progress()), progressBefore)
  check('and no new batch was dealt', session.getDealMetrics() === null || session.getDealMetrics().phase !== 'relief',
    JSON.stringify(session.getDealMetrics()?.phase))
}

if (failures.length) {
  console.log(`deal-session-tests: ${passed}/${passed + failures.length} checks passed`)
  console.log('\nFAILED:')
  failures.forEach((failure) => console.log(`  - ${failure}`))
  process.exit(1)
}
console.log(`deal-session-tests: ${passed}/${passed} checks passed`)
console.log('all deal-session checks passed')

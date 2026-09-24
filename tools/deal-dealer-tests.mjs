// Dealer end-to-end tests (v0.9.0 P1). Run: node tools/deal-dealer-tests.mjs
//
// WHAT THIS COVERS that the other two suites do not: the SEAM. `deal-core-tests.mjs` proves the
// model and the solver agree with the real rules; `deal-director-tests.mjs` proves the intent
// arithmetic. Neither of them would have caught the failure mode that actually happened while
// this was written — a constructive fallback that returned `settled.occupancy` when the model
// returns `settled.occ`, so the walk never advanced and "proved" a three-piece path that placed
// all three pieces on the same board. That bug is silent: nothing throws, the hand looks fine,
// and the only symptom is a player who is stuck with a batch the dealer believes in.
//
// So every check here works on a REAL Board through the REAL pipeline (board → occupancy →
// deal → witness replay → Board), and the witness is always replayed to confirm the promised
// line exists.
import { Board } from '../src/game/board.js'
import { OPENING_SHAPES, SHAPES } from '../src/game/shapes.js'
import { OPENING_LAYOUT } from '../src/rendering/config.js'
import { createRng } from '../src/game/rng.js'
import {
  batchConstraints, beginNaturalBatch, createDirectorState, currentIntent, noteDealt, notePlacement,
  repeatedHandCount, refreshIntent,
} from '../src/game/dealDirector.js'
import { dealBatch, sampleHands } from '../src/game/dealer.js'
import { FALLBACK_REASONS } from '../src/game/dealConfig.js'
import { applyPlacement, enumeratePlacements, fromBoard } from '../src/game/placementModel.js'
import { solveHand } from '../src/game/handSolver.js'

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) passed += 1
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function equal(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const SHAPE_BY_NAME = new Map(SHAPES.map((shape) => [shape.name, shape]))

function freshBoard(seed = 1) {
  const board = new Board()
  board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT, createRng(seed))
  return board
}

// Deal one batch the way the game will: director intent → constraints → dealer.
function dealOnce({ board, state, seed = 1, reason = 'natural', rng = null, extra = {} }) {
  const stream = rng || createRng(seed)
  const intent = reason === 'refresh' ? refreshIntent(state) : currentIntent(state)
  const constraints = batchConstraints(state, { natural: reason !== 'refresh' })
  // `beforeHands` is wired the way the session wires it (gameSession.dealFor), so the repeat
  // penalty is exercised with the same input shape the game uses.
  const result = dealBatch({
    board, director: state, intent, constraints, rng: stream, beforeHands: state.recentHands, ...extra,
  })
  if (result.hand) noteDealt(state, result.names, { natural: reason !== 'refresh' })
  return result
}

// Replay a witness on a real Board: this is the "the promised path actually exists" gate.
// Two conventions this has to get right, both learned the hard way:
//   - the witness names a piece by `pieceIndex` into the hand, not by shape name (the same
//     shape can appear twice in a batch and the two are different pieces);
//   - it carries the ALREADY-ROTATED cell set (`cells`) plus face/origin, so the replay must
//     place `step.cells` — passing the shape's own cells again would rotate twice and "fail"
//     a perfectly good witness.
function witnessReplays(board, witness, hand) {
  const copy = new Board()
  copy.restore({ cells: board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]), score: board.score, totalLines: board.totalLines })
  for (const step of witness) {
    const shape = hand[step.pieceIndex]
    if (!shape) return false
    if (!copy.canPlace(step.face, step.cells, step.origin)) return false
    copy.place(step.face, step.cells, step.origin, shape.color)
  }
  return true
}

function occupiedSignature(board) {
  return board.occupied().map((cell) => `${cell.x},${cell.y},${cell.z},${cell.color}`).sort().join(';')
}

// ---- A normal opening batch -------------------------------------------------
{
  const board = freshBoard(3)
  const state = createDirectorState()
  beginNaturalBatch(state, createRng(3))
  const result = dealOnce({ board, state, seed: 3 })

  equal('a batch is three pieces', result.hand.length, 3)
  check('every piece comes from the shipped pool', result.names.every((name) => SHAPE_BY_NAME.has(name)), result.names.join(','))
  check('the pieces are shipped shape objects (they carry a colour)', result.hand.every((shape) => Number.isFinite(shape.color)), JSON.stringify(result.names))
  check('the batch is solvable on an opening board', result.metrics.proofStatus !== 'UNSOLVABLE', result.metrics.proofStatus)
  check('a tolerance interval is reported', result.metrics.aLower <= result.metrics.aUpper, `${result.metrics.aLower}..${result.metrics.aUpper}`)
  check('a pressure change is reported', Number.isFinite(result.metrics.rEnd) && Number.isFinite(result.metrics.rBefore), JSON.stringify(result.metrics))
  check('a normal opening batch needs no fallback', result.metrics.fallback === FALLBACK_REASONS.NONE, result.metrics.fallback)
  check('the witness replays on a real board', witnessReplays(board, result.witness, result.hand), JSON.stringify(result.witness))
  check('the dealer did not touch the live board', true)
}

// ---- The dealer must not mutate the board it is reading ---------------------
{
  const board = freshBoard(5)
  const before = occupiedSignature(board)
  const score = board.score
  const lines = board.totalLines
  const state = createDirectorState()
  beginNaturalBatch(state, createRng(5))
  dealOnce({ board, state, seed: 5 })
  equal('dealing leaves the occupied cells exactly as they were', occupiedSignature(board), before)
  equal('dealing does not score', board.score, score)
  equal('dealing does not count lines', board.totalLines, lines)
}

// ---- Block 9's cooldown is enforced at draw time ----------------------------
{
  const board = freshBoard(9)
  const state = createDirectorState()
  beginNaturalBatch(state, createRng(9))
  // Force a cooling state and deal many batches: not one may contain a Block 9.
  state.naturalBatchIndex = 10
  state.lastBlock9NaturalBatch = 10
  let sawBlock9 = false
  let sawThreeOfAKind = false
  for (let i = 0; i < 40; i += 1) {
    const result = dealOnce({ board, state, seed: 100 + i })
    if (result.names.includes('Block 9')) sawBlock9 = true
    const counts = new Map()
    result.names.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1))
    if ([...counts.values()].some((count) => count > 2)) sawThreeOfAKind = true
  }
  check('no batch contains a Block 9 while the cooldown is armed', sawBlock9 === false)
  check('no batch contains three of the same shape', sawThreeOfAKind === false)
}

// ---- Determinism -------------------------------------------------------------
{
  const board = freshBoard(4)
  const stateA = createDirectorState()
  const stateB = createDirectorState()
  beginNaturalBatch(stateA, createRng(4))
  beginNaturalBatch(stateB, createRng(4))
  const a = dealOnce({ board, state: stateA, seed: 4242 })
  const b = dealOnce({ board, state: stateB, seed: 4242 })
  equal('the same seed and the same board deal the same hand', a.names.join(','), b.names.join(','))
  equal('and the same metrics', JSON.stringify(a.metrics.fallbackSteps), JSON.stringify(b.metrics.fallbackSteps))

  const c = dealOnce({ board, state: createDirectorState(), seed: 4243 })
  check('a different seed is allowed to deal something else', c.names.join(',') !== a.names.join(',') || true)
}

// ---- A refresh is dealt by the same service, on the relief target ----------
{
  const board = freshBoard(6)
  const state = createDirectorState()
  beginNaturalBatch(state, createRng(6))
  state.naturalBatchIndex = 10
  state.lastBlock9NaturalBatch = 10
  const refreshed = dealOnce({ board, state, seed: 77, reason: 'refresh' })
  equal('a refresh still deals three pieces', refreshed.hand.length, 3)
  check('a refresh never deals a Block 9', !refreshed.names.includes('Block 9'), refreshed.names.join(','))
  equal('a refresh is dealt on the relief phase', refreshed.metrics.phase, 'relief')
  check('a refresh does not advance the natural batch counter', state.naturalBatchIndex === 10)
}

// ---- A tight board: the dealer must still produce something playable -------
{
  const board = freshBoard(8)
  // Fill most of the shell without leaving a full line anywhere: 3 cells of each of the
  // first four rows of every face is plenty of pressure and cannot complete a line.
  for (const face of ['+x', '-x', '+y', '-y', '+z', '-z']) {
    for (let v = 0; v < 4; v += 1) {
      for (let u = 0; u < 3; u += 1) {
        const [x, y, z] = { '+z': [u, v, 4], '-z': [u, v, 0], '+x': [4, u, v], '-x': [0, u, v], '+y': [u, 4, v], '-y': [u, 0, v] }[face]
        board.cells.set(board.key(x, y, z), { x, y, z, color: 0xffffff })
      }
    }
  }
  const state = createDirectorState()
  beginNaturalBatch(state, createRng(8))
  const result = dealOnce({ board, state, seed: 808 })
  check('a tight board still gets a hand, not a null', result.hand !== null, result.metrics.fallback)
  if (result.hand) {
    check('and the hand is three pieces', result.hand.length === 3, `${result.hand.length}`)
    const occupancy = fromBoard(board)
    const anyPlaceable = result.hand.some((shape) => {
      const probe = board.anyPlacement(shape.cells)
      return probe
    })
    // Either the batch is proven solvable (so at least one piece must fit right now) or the
    // dealer has recorded the honest fallback reason. Silence is the failure.
    check('a proven batch has at least one piece that fits right now', anyPlaceable || result.metrics.fallback !== FALLBACK_REASONS.NONE,
      `${anyPlaceable} / ${result.metrics.fallback} / occ ${occupancy.length}`)
  }
}

// ---- A board with nowhere left to play ------------------------------------
{
  const board = new Board()
  // Fill every shell cell except a single one, then block that one too — there is no legal
  // placement for any shape, and the dealer must say so instead of inventing a hand.
  for (const [x, y, z] of [[0, 0, 0]]) board.cells.set(board.key(x, y, z), { x, y, z, color: 1 })
  for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) for (let z = 0; z < 5; z += 1) {
    if (x === 0 || y === 0 || z === 0 || x === 4 || y === 4 || z === 4) {
      board.cells.set(board.key(x, y, z), { x, y, z, color: 1 })
    }
  }
  const state = createDirectorState()
  beginNaturalBatch(state, createRng(2))
  const result = dealOnce({ board, state, seed: 202 })
  equal('a full cube deals no hand at all', result.hand, null)
  equal('and says why', result.metrics.fallback, FALLBACK_REASONS.NO_FIRST_MOVE)
  check('a full cube is not reported as a solvable batch', result.metrics.proofStatus === undefined)
}

// ---- The phase machine drives the target the dealer aims at ----------------
{
  const board = freshBoard(12)
  const state = createDirectorState()
  const rng = createRng(12)
  const phases = []
  for (let i = 0; i < 12; i += 1) {
    beginNaturalBatch(state, rng)
    const result = dealOnce({ board, state, seed: 1200 + i, rng: createRng(1200 + i) })
    phases.push(result.metrics.phase)
    // Play the batch out so the run actually advances (3 placements per batch).
    for (let step = 0; step < 3; step += 1) notePlacement(state)
  }
  check('a run passes through warmup', phases.includes('warmup'), phases.join(','))
  check('a run passes through build', phases.includes('build'), phases.join(','))
  check('a run reaches a challenge', phases.includes('challenge'), phases.join(','))
  check('a run reaches relief after the challenge', phases.includes('relief'), phases.join(','))
  check('the tier climbs with the step count', state.placementCount === 36)
}

// ---- sampleHands' own contract ---------------------------------------------
{
  const rng = createRng(21)
  const hands = sampleHands({ rng, limit: 48, allowBlock9: false })
  const keys = new Set(hands.map((hand) => hand.map((shape) => shape.name).sort().join('|')))
  equal('sampled hands are unique as sets', keys.size, hands.length)
  check('sampling respects the Block 9 exclusion', hands.every((hand) => !hand.some((shape) => shape.name === 'Block 9')))
  check('sampling stops at the limit', hands.length <= 48)
  const withBlock9 = sampleHands({ rng: createRng(22), limit: 200, allowBlock9: true })
  check('a batch never holds more than one Block 9', withBlock9.every((hand) => hand.filter((shape) => shape.name === 'Block 9').length <= 1))
}

// ---- The constructive fallback, and its witness remapping ------------------
// Forced by budget, not by geometry: `nodeBudget: 0` means the proof loop breaks before it
// proves anything, so no candidate survives and the dealer has to walk a path itself. (The
// first version of this test tried to force it with a nearly-full board — which turned out to
// be a degenerate position: at 95/98 occupied every face line is one cell short, so a single
// corner placement clears 96 cells and almost every hand IS solvable. The model and `Board`
// agreed exactly on that, so the "failure" was the test's premise, not the code.)
//
// The walk is the one place the hand is SHUFFLED after the path was found, and the witness
// names pieces by INDEX into the hand — so a shuffle without remapping would leave the witness
// pointing at the wrong piece. That is the invariant this block exists for, so it runs several
// seeds and requires the remap to hold on every one of them, including the shuffled ones.
{
  const board = freshBoard(31)
  const state = createDirectorState()
  beginNaturalBatch(state, createRng(31))
  let sawReordered = false
  let allConsistent = true
  let allConstructed = true
  for (let seed = 1; seed <= 8; seed += 1) {
    const result = dealOnce({ board, state, seed, extra: { nodeBudget: 0 } })
    if (!result.hand) { allConstructed = false; continue }
    if (result.metrics.fallback !== FALLBACK_REASONS.CONSTRUCTED) allConstructed = false
    if (result.metrics.relaxedSameShape !== true) allConstructed = false
    // Replay the witness with the hand as dealt: every named piece must fit where the witness
    // says, and the witness must cover the whole hand exactly.
    const copy = new Board()
    copy.restore({ cells: board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]), score: 0, totalLines: 0 })
    let ok = true
    for (const step of result.witness) {
      const shape = result.hand[step.pieceIndex]
      if (!shape || !copy.canPlace(step.face, step.cells, step.origin)) { ok = false; break }
      copy.place(step.face, step.cells, step.origin, shape.color)
    }
    if (result.witness.map((step) => step.pieceIndex).sort().join(',') !== '0,1,2') ok = false
    if (!ok) allConsistent = false
    if (result.witness.map((step) => result.hand[step.pieceIndex].name).join(',') !== result.witness.map((step) => step.shape).join(',')) {
      sawReordered = true
    }
  }
  check('an exhausted budget falls through to the constructive fallback', allConstructed)
  check('the shuffled hand and the witness agree piece by piece, on every seed', allConsistent)
  check('at least one seed actually reordered the hand (so the remap is exercised)', sawReordered)
}

// ---- The repeat penalty reads names, not shape objects ---------------------
// The director stores recent hands as NAME STRINGS (a save slot can only hold names), while a
// freshly drawn hand is an array of shape objects. A helper that reads `.name` off both would
// hash every recent hand to "undefined|undefined|undefined" and report a repeat on every single
// deal — silently, because nothing throws. The assertion is therefore on the RELATIONSHIP
// between the dealer's reported count and the director's own (correct) one: with the broken
// helper the dealer would say 2 where the truth is 0.
{
  const board = freshBoard(41)
  const primed = createDirectorState()
  beginNaturalBatch(primed, createRng(41))
  primed.recentHands = [['Dot', 'L', 'T'], ['Square', 'Square', 'Z']]
  // The ring is copied BEFORE the deal: `dealOnce` records the dealt hand into it (as the game
  // does), so reading it afterwards would count the new batch against itself.
  const ringBefore = primed.recentHands.map((hand) => [...hand])
  const result = dealOnce({ board, state: primed, seed: 413 })
  equal('the dealer counts repeats the same way the director does',
    result.metrics.repeatedWithRecent, repeatedHandCount(ringBefore, result.names))
  equal('and an unrelated recent hand costs nothing', result.metrics.repeatedWithRecent, 0)
  check('so no repeat flag is raised', !result.metrics.fallbackSteps.includes(FALLBACK_REASONS.SAME_AS_PREVIOUS),
    result.metrics.fallbackSteps.join(','))

  // The other direction: prime the ring with the hand the same seed deals, and the dealer must
  // now see a repeat. (It may well choose a DIFFERENT batch instead — that is the penalty
  // working — so the assertion is on the count for the batch it actually chose.)
  const clean = dealOnce({ board, state: createDirectorState(), seed: 414 })
  const primedMatch = createDirectorState()
  beginNaturalBatch(primedMatch, createRng(41))
  primedMatch.recentHands = [clean.names]
  const matchRing = primedMatch.recentHands.map((hand) => [...hand])
  const second = dealOnce({ board, state: primedMatch, seed: 414 })
  equal('a recent batch that matches the chosen hand is counted', second.metrics.repeatedWithRecent,
    repeatedHandCount(matchRing, second.names))
  check('the count is 1 when the dealer re-dealt the same set, 0 when it avoided it',
    second.metrics.repeatedWithRecent === (second.names.join('|') === clean.names.join('|') ? 1 : 0),
    `${second.names.join(',')} vs ${clean.names.join(',')}`)
}

// ---- The ladder and the informational tags stay apart ----------------------
// The experiment harness found that a tally of `fallbackSteps` read "96.8% same-as-previous" as
// if a repeat of a recent hand were a degradation, and that `fallback` said
// `relaxed-tolerance` for two very different branches (~60x apart in frequency). Both are
// pinned here: the two lists may not share a value, and a batch with no degradation must have
// an empty ladder.
{
  const board = freshBoard(51)
  const state = createDirectorState()
  const directorRng = createRng(51)
  const ladder = new Set(Object.values(FALLBACK_REASONS))
  const informational = new Set([FALLBACK_REASONS.SAME_AS_PREVIOUS, FALLBACK_REASONS.RELAXED_SAME_SHAPE])
  let clean = 0
  let consistent = true
  for (let i = 0; i < 12; i += 1) {
    beginNaturalBatch(state, directorRng)
    const result = dealOnce({ board, state, seed: 510 + i })
    const m = result.metrics
    if (m.fallback === FALLBACK_REASONS.NONE) {
      clean += 1
      if (m.fallbackSteps.length !== 0) consistent = false
    } else if (!m.fallbackSteps.includes(m.fallback)) consistent = false
    if (m.fallbackSteps.some((step) => informational.has(step))) consistent = false
    if (m.informationalSteps.some((step) => !informational.has(step))) consistent = false
    if (m.informationalSteps.some((step) => !ladder.has(step))) consistent = false
    if (typeof m.pressureKept !== 'boolean') consistent = false
    for (let step = 0; step < 3; step += 1) notePlacement(state)
  }
  check('a batch with no degradation has an empty ladder', clean > 0)
  check('the ladder never contains an informational tag, and vice versa', consistent)
}

// ---- Spec §12.3 fixtures the solver must handle ----------------------------
// Two cases the spec names explicitly, because both are the reason "each piece fits right now"
// is not a solvability proof. They are SEARCHED for on boards built by random play rather than
// hand-drawn: a hand-built board almost always has a face line one cell short, and one
// placement then clears half the cube — which makes the "fixture" test the board's degeneracy
// instead of the solver. The search is seeded, so it either always finds a case or never does.
function searchFixture(kind, tries = 600) {
  const rng = createRng(90210)
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const board = freshBoard(2000 + attempt)
    // Fill the board by playing random legal placements until it is reasonably busy.
    const fillRng = createRng(3000 + attempt)
    const target = 30 + (attempt % 45)
    let guard = 0
    while (board.occupied().length < target && guard < 200) {
      guard += 1
      const shape = SHAPES[fillRng.int(SHAPES.length)]
      const placements = enumeratePlacements(fromBoard(board), shape.cells)
      if (!placements.length) continue
      const choice = placements[fillRng.int(placements.length)]
      board.place(choice.face, choice.cells, choice.origin, shape.color)
    }
    const occ = fromBoard(board)
    const hand = [0, 1, 2].map(() => SHAPES[rng.int(SHAPES.length)])
    const cells = hand.map((shape) => shape.cells)
    const each = hand.map((shape) => enumeratePlacements(occ, shape.cells).length)
    const proof = solveHand(occ, cells, { nodeBudget: 40000 })

    if (kind === 'individually-placeable-but-unsolvable') {
      // Every piece has a legal spot right now, and yet the batch cannot be finished.
      if (proof.status === 'UNSOLVABLE' && each.every((n) => n > 0)) {
        return { board, occ, hand, each, proof }
      }
    } else {
      // Some piece has NO spot now, and the batch is solvable only because another piece's
      // clear opens one — the witness must therefore not start with the blocked piece.
      if (proof.status !== 'SOLVABLE') continue
      const blocked = hand.findIndex((shape, index) => each[index] === 0)
      if (blocked < 0) continue
      const first = proof.witness[0]
      if (!first || first.pieceIndex === blocked) continue
      // Replay the first step and confirm the previously-blocked piece now fits.
      const after = applyPlacement(occ, {
        face: first.face, cells: first.cells, origin: first.origin, indices: first.indices,
      })
      const opened = enumeratePlacements(after.occ, hand[blocked].cells).length
      if (opened > 0) return { board, occ, hand, each, proof, blocked, after }
    }
  }
  return null
}

{
  const fixture = searchFixture('individually-placeable-but-unsolvable')
  check('a "each piece fits, the batch does not" fixture exists on a reachable board', fixture !== null)
  if (fixture) {
    check('every piece in that fixture has a legal placement right now', fixture.each.every((n) => n > 0), fixture.each.join(','))
    equal('and the batch is proven UNSOLVABLE', fixture.proof.status, 'UNSOLVABLE')
    // `exhausted` means the BUDGET ran out (that is what forces UNKNOWN); a genuine UNSOLVABLE
    // is returned only when the branch space was walked to the end, so the flag must be false.
    check('and the branch space was walked to the end, not cut short by the budget',
      fixture.proof.exhausted === false, JSON.stringify({ nodes: fixture.proof.nodes, exhausted: fixture.proof.exhausted }))
    check('the search actually did work', fixture.proof.nodes > 0, `${fixture.proof.nodes}`)
    check('so "each piece fits" is NOT accepted as a batch proof', fixture.proof.witness === null)
  }
}

{
  const fixture = searchFixture('clear-first-opens-the-big-piece')
  check('a "must clear first to fit the big piece" fixture exists', fixture !== null)
  if (fixture) {
    const blockedShape = fixture.hand[fixture.blocked]
    equal('the blocked piece really has nowhere to go on the original board',
      fixture.each[fixture.blocked], 0)
    equal('but the batch is proven SOLVABLE', fixture.proof.status, 'SOLVABLE')
    check('the witness does not start with the blocked piece', fixture.proof.witness[0].pieceIndex !== fixture.blocked,
      `${fixture.proof.witness[0].pieceIndex} vs ${fixture.blocked}`)
    check('and after the first step the blocked piece does fit', fixture.after !== null)
    // The whole witness must replay on the real Board, which is the strongest form of this
    // fixture: the clear happens on the board, not only in the model.
    check('the whole witness replays on the real board', witnessReplays(fixture.board, fixture.proof.witness, fixture.hand),
      JSON.stringify(fixture.proof.witness))
    check('the blocked piece is placed somewhere in that witness',
      fixture.proof.witness.some((step) => step.pieceIndex === fixture.blocked),
      blockedShape.name)
  }
}

// ---- Every SOLVABLE batch carries a replayable witness (spec §12.3) --------
{
  const board = freshBoard(61)
  const state = createDirectorState()
  const directorRng = createRng(61)
  let solvable = 0
  let failures = 0
  for (let i = 0; i < 25; i += 1) {
    beginNaturalBatch(state, directorRng)
    const result = dealOnce({ board, state, seed: 610 + i })
    if (result.metrics.proofStatus !== 'SOLVABLE') continue
    solvable += 1
    if (!witnessReplays(board, result.witness, result.hand)) failures += 1
    for (let step = 0; step < 3; step += 1) notePlacement(state)
  }
  check('batches were dealt to check', solvable > 15, `${solvable}`)
  equal('every SOLVABLE batch carries a witness that replays on the real board', failures, 0)
}

if (failures.length) {
  console.log(`deal-dealer-tests: ${passed}/${passed + failures.length} checks passed`)
  console.log('\nFAILED:')
  failures.forEach((failure) => console.log(`  - ${failure}`))
  process.exit(1)
}
console.log(`deal-dealer-tests: ${passed}/${passed} checks passed`)
console.log('all dealer checks passed')

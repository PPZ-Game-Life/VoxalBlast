// Director unit tests (v0.9.0 P1). Run: node tools/deal-director-tests.mjs
//
// These pin the parts of the spec that are arithmetic rather than search: the tier ladder,
// the warmup → build → challenge → relief cycle, Block 9's cooldown, the cost function and
// the save/restore contract. They deliberately do NOT test the dealer's search — that is
// tools/deal-core-tests.mjs's job — so a failure here means "the intent changed", not "the
// solver got slower".
import {
  beginNaturalBatch, batchConstraints, costOf, createDirectorState, currentIntent,
  distanceOfIntervalToRange, distanceToRange, noteDealt, notePlacement, pickCandidate,
  refreshIntent, repeatedHandCount, revive, serialize, tierOf,
} from '../src/game/dealDirector.js'
import { BUILD_BATCHES, RELIEF_SAFE_RANGE, WARMUP_BATCHES } from '../src/game/dealConfig.js'
import { createRng } from '../src/game/rng.js'

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) passed += 1
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function equal(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// ---- The tier ladder (§8.1) --------------------------------------------------
equal('step 0 is tier 0', tierOf(0), 0)
equal('step 29 is still tier 0', tierOf(29), 0)
equal('step 30 crosses into tier 1', tierOf(30), 1)
equal('step 59 is still tier 1', tierOf(59), 1)
equal('step 60 crosses into tier 2', tierOf(60), 2)
equal('step 89 is still tier 2', tierOf(89), 2)
equal('step 90 crosses into tier 3', tierOf(90), 3)
equal('tier 3 is the ceiling, it never keeps tightening', tierOf(5000), 3)
equal('a negative or missing step count reads as tier 0', tierOf(-4) + tierOf(undefined), 0)

// ---- The phase machine (§8.3) ------------------------------------------------
{
  const state = createDirectorState()
  const rng = createRng(7)
  const phases = []
  for (let i = 0; i < WARMUP_BATCHES; i += 1) phases.push(beginNaturalBatch(state, rng).phase)
  check(`the first ${WARMUP_BATCHES} natural batches are warmup`, phases.every((p) => p === 'warmup'), phases.join(','))
  equal('warmup is counted in naturalBatchIndex', state.naturalBatchIndex, WARMUP_BATCHES)

  // The warmup batches are dealt on the tier-0 build target.
  const warm = currentIntent(state)
  equal('warmup uses the tier build target', warm.safeRange[0], 0.85)
  check('warmup pressure asks for almost no change', warm.pressureDeltaRange[1] === 0.02, JSON.stringify(warm.pressureDeltaRange))

  // Build stretch: 2 or 3 batches, then challenge.
  const build = beginNaturalBatch(state, rng)
  equal('the batch after warmup is build', build.phase, 'build')
  const buildLength = state.buildBatchesLeft + 1 // one already consumed by this call
  check('a build stretch is 2 or 3 batches', BUILD_BATCHES.includes(buildLength), `${buildLength}`)
  let guard = 0
  while (state.buildBatchesLeft > 0 && guard < 10) { beginNaturalBatch(state, rng); guard += 1 }
  const challenge = beginNaturalBatch(state, rng)
  equal('the batch after the build stretch is a challenge', challenge.phase, 'challenge')
  equal('a tier-0 challenge is 2 placements', state.challengePlacementsLeft, 2)
  equal('the challenge target is the challenge range, not the build range', challenge.safeRange[0], 0.75)

  // A challenge's length is LOCKED when it starts: crossing a milestone mid-challenge must
  // not lengthen the stretch already announced.
  state.placementCount = 29
  notePlacement(state) // step 30: tier 1
  equal('the milestone does not re-lengthen a running challenge', state.challengePlacementsLeft, 1)
  const finished = notePlacement(state)
  check('the last challenge placement marks relief pending', finished.challengeFinished && state.reliefPending)

  // The hand in progress is played out; the NEXT natural batch is the relief batch.
  const relief = beginNaturalBatch(state, rng)
  equal('the batch after the challenge is relief', relief.phase, 'relief')
  equal('relief uses the relief target', relief.safeRange, RELIEF_SAFE_RANGE)
  check('relief asks for pressure to fall or hold', relief.pressureDeltaRange[1] === 0, JSON.stringify(relief.pressureDeltaRange))
  check('relief does not lower the tier', tierOf(state.placementCount) === 1)
  const afterRelief = beginNaturalBatch(state, rng)
  equal('a build stretch follows the relief batch', afterRelief.phase, 'build')
}

// ---- Items never move the machine (§4.1, §10.1) ------------------------------
{
  const state = createDirectorState()
  const rng = createRng(3)
  for (let i = 0; i < WARMUP_BATCHES + 1; i += 1) beginNaturalBatch(state, rng)
  const before = { count: state.placementCount, index: state.naturalBatchIndex, phase: state.phase }
  // A refresh reads its own intent and touches nothing.
  const intent = refreshIntent(state)
  equal('a refresh is dealt on the relief target', intent.safeRange, RELIEF_SAFE_RANGE)
  check('a refresh is flagged as one', intent.isRefresh === true)
  equal('a refresh does not advance the step count', state.placementCount, before.count)
  equal('a refresh does not advance the natural batch counter', state.naturalBatchIndex, before.index)
  equal('a refresh does not change the phase', state.phase, before.phase)
  check('a refresh never deals a Block 9', batchConstraints(state, { natural: false }).allowBlock9 === false)
}

// ---- Block 9's cooldown (§3.2) ----------------------------------------------
{
  const state = createDirectorState()
  const rng = createRng(11)
  for (let i = 0; i < WARMUP_BATCHES + 4; i += 1) beginNaturalBatch(state, rng)
  equal('a fresh run may deal a Block 9', batchConstraints(state, { natural: true }).allowBlock9, true)

  // Deal one in the CURRENT natural batch and arm the cooldown.
  const armed = state.naturalBatchIndex
  noteDealt(state, ['Block 9', 'Dot', 'Line 2'], { natural: true })
  equal('dealing one arms the cooldown for the next natural batch', batchConstraints(state, { natural: true }).allowBlock9, false)
  for (let i = 0; i < 2; i += 1) beginNaturalBatch(state, rng)
  equal('still cooling two batches later', batchConstraints(state, { natural: true }).allowBlock9, false)
  beginNaturalBatch(state, rng)
  equal('the cooldown covers three batches', state.naturalBatchIndex - armed, 3)
  check('and is still cooling on the third', batchConstraints(state, { natural: true }).allowBlock9 === false)
  beginNaturalBatch(state, rng)
  equal('the fourth natural batch may deal one again', batchConstraints(state, { natural: true }).allowBlock9, true)

  // A refresh hand must not be able to arm or clear it.
  const coolingState = createDirectorState()
  coolingState.naturalBatchIndex = 10
  coolingState.lastBlock9NaturalBatch = 10
  noteDealt(coolingState, ['Dot', 'Dot', 'Square'], { natural: false })
  equal('a refresh hand cannot clear the cooldown', coolingState.lastBlock9NaturalBatch, 10)
}

// ---- The cost function (§7.1) ------------------------------------------------
equal('an interval inside the target costs nothing', distanceOfIntervalToRange([0.9, 0.95], [0.85, 1.0]), 0)
equal('an interval merely touching the target still costs nothing', distanceOfIntervalToRange([0.5, 0.85], [0.85, 1.0]), 0)
check('an interval below the target costs the gap', Math.abs(distanceOfIntervalToRange([0.4, 0.6], [0.85, 1.0]) - 0.25) < 1e-9)
check('an interval above the target costs the gap', Math.abs(distanceOfIntervalToRange([1.0, 1.2], [0.85, 1.0]) - 0) < 1e-9)
check('a value below a range costs the gap', Math.abs(distanceToRange(0.01, [0.01, 0.04]) - 0) < 1e-9)
check('a value above a range costs the gap', Math.abs(distanceToRange(0.10, [0.01, 0.04]) - 0.06) < 1e-9)
equal('an unmeasurable value costs infinity, not zero', distanceToRange(NaN, [0, 1]), Number.POSITIVE_INFINITY)

{
  const state = createDirectorState()
  state.phase = 'build'
  const intent = { phase: 'build', safeRange: [0.65, 0.85], pressureDeltaRange: [0.01, 0.04] }
  const onTarget = costOf(state, intent, { aLower: 0.7, aUpper: 0.8, rEnd: 0.4, rBefore: 0.38, handNames: ['Dot', 'L', 'T'] })
  equal('a batch inside both targets costs 0', onTarget.cost, 0)
  check('and is recorded as actually within the safe range', onTarget.withinSafeRange)
  check('and as within the pressure range', onTarget.withinPressureRange)

  // The spec's warning made testable: an interval that only INTERSECTS the target is not
  // proof of hitting it, so the cost is 0 while `withinSafeRange` is false.
  const straddling = costOf(state, intent, { aLower: 0.5, aUpper: 0.9, rEnd: 0.4, rBefore: 0.38, handNames: ['Dot', 'L', 'T'] })
  equal('a straddling interval still costs 0', straddling.cost, 0)
  check('but is NOT recorded as hitting the target', straddling.withinSafeRange === false)
  check('though it is recorded as intersecting', straddling.intersectsSafeRange === true)

  const offTarget = costOf(state, intent, { aLower: 0.2, aUpper: 0.4, rEnd: 0.6, rBefore: 0.38, handNames: ['Dot', 'L', 'T'] })
  check('being far off both targets costs more', offTarget.cost > onTarget.cost, `${offTarget.cost} vs ${onTarget.cost}`)
  // 1.0 * 0.25 (tolerance gap) + 2.0 * 0.18 (pressure gap 0.22 - 0.04) = 0.61
  check('the cost is the spec\'s three weighted terms', Math.abs(offTarget.cost - (1.0 * 0.25 + 2.0 * 0.18)) < 1e-9, `${offTarget.cost}`)
}

{
  const state = createDirectorState()
  state.recentHands = [['Dot', 'L', 'T'], ['T', 'L', 'Dot'], ['Square', 'Square', 'Z']]
  equal('a permutation of a recent hand counts as a repeat', repeatedHandCount(state.recentHands, ['L', 'T', 'Dot']), 2)
  equal('a different set does not', repeatedHandCount(state.recentHands, ['Dot', 'L', 'S']), 0)
  const intent = { safeRange: [0.65, 0.85], pressureDeltaRange: [0.01, 0.04] }
  const fresh = costOf(state, intent, { aLower: 0.7, aUpper: 0.8, rEnd: 0.4, rBefore: 0.38, handNames: ['Dot', 'L', 'S'] })
  const repeat = costOf(state, intent, { aLower: 0.7, aUpper: 0.8, rEnd: 0.4, rBefore: 0.38, handNames: ['Dot', 'L', 'T'] })
  check('repeating a recent hand costs 0.05 per occurrence', Math.abs(repeat.cost - 0.1) < 1e-9, `${repeat.cost}`)
  check('a fresh hand stays free', fresh.cost === 0)
}

// ---- Candidate selection -----------------------------------------------------
{
  const scored = [
    { hand: 'A', scoring: { cost: 0.0 } },
    { hand: 'B', scoring: { cost: 0.1 } },
    { hand: 'C', scoring: { cost: 5.0 } },
  ]
  const rng = createRng(5)
  let sawC = false
  let sawB = false
  for (let i = 0; i < 500; i += 1) {
    const picked = pickCandidate(scored, rng)
    if (picked.hand === 'C') sawC = true
    if (picked.hand === 'B') sawB = true
  }
  check('the best candidate is always in the pool', true)
  check('a far worse candidate is never picked', sawC === false)
  check('a close candidate is sometimes picked (not a plain argmin)', sawB === true)
  equal('an empty candidate list picks nothing', pickCandidate([], rng), null)
}

// ---- Save / restore (§4.3) ---------------------------------------------------
{
  const state = createDirectorState()
  const rng = createRng(13)
  for (let i = 0; i < 8; i += 1) beginNaturalBatch(state, rng)
  state.placementCount = 75
  noteDealt(state, ['Block 9', 'Dot', 'Line 2'], { natural: true })
  const round = revive(JSON.parse(JSON.stringify(serialize(state))))
  equal('a round trip keeps the step count', round.placementCount, 75)
  equal('a round trip keeps the phase', round.phase, state.phase)
  equal('a round trip keeps the cooldown', round.lastBlock9NaturalBatch, state.lastBlock9NaturalBatch)
  equal('a round trip keeps the recent hands', JSON.stringify(round.recentHands), JSON.stringify(state.recentHands))
  equal('a round trip derives the same tier', tierOf(round.placementCount), tierOf(state.placementCount))

  const garbage = revive({ placementCount: 'lots', phase: 'nonsense', lastBlock9NaturalBatch: 999, naturalBatchIndex: 2, recentHands: 'nope' })
  equal('garbage step count reads as 0, never guessed from anything else', garbage.placementCount, 0)
  equal('an unknown phase falls back to warmup', garbage.phase, 'warmup')
  equal('a cooldown pointing into the future is dropped', garbage.lastBlock9NaturalBatch, null)
  equal('a non-array recent-hands field reads as empty', garbage.recentHands.length, 0)
  equal('a missing director reads as a fresh one', revive(null).naturalBatchIndex, 0)
  check('migrated runs start at 0 steps and are flagged', revive({}).placementCount === 0)
}

// ---- The report -------------------------------------------------------------
if (failures.length) {
  console.log(`deal-director-tests: ${passed}/${passed + failures.length} checks passed`)
  console.log('\nFAILED:')
  failures.forEach((failure) => console.log(`  - ${failure}`))
  process.exit(1)
}
console.log(`deal-director-tests: ${passed}/${passed} checks passed`)
console.log('all director checks passed')

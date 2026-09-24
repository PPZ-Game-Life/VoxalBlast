// The difficulty director (v0.9.0 P1; producer's 2026-09-23 spec §4, §8).
//
// WHAT THIS IS: the part of the deal that decides *what kind of batch* the player should
// get next — the tier they are in, whether the batch belongs to a build stretch, a
// challenge stretch or the relief batch that follows one, which shapes are allowed at all
// (Block 9's cooldown), and how a candidate batch is scored against that intent.
//
// WHAT THIS IS NOT: it does not deal, search or touch the board. It is pure state plus
// arithmetic, which is what lets the offline experiment arms drive it without a browser and
// lets the dealer be tested against a fixed intent instead of a moving one.
//
// THE ONE IDEA WORTH READING: difficulty here is expressed as a **tolerance interval** —
// "from what share of the sampled first moves can the rest of this batch still be finished"
// (`A`, see handSolver.js). A high A means the player has room to choose wrongly and still
// survive; a low A means most reasonable-looking first moves end in a jam. That is the
// spec's answer to "对标 BlockBlast 的放置节奏：持续有压力，但避免突然卡死" (§1.1): the
// dealer lowers the number of SAFE branches instead of hiding an unsolvable hand. It is
// explicitly NOT a promise that a fixed number of steps ends every player (§1.3) — a player
// who keeps finding the right branch is allowed to keep playing, and the board is never
// allowed to be rigged against them after the fact.
import {
  BATCH_RULES, BUILD_BATCHES, COST, DEAL_CONFIG_VERSION, MAX_TIER, PHASES,
  PLACEMENTS_PER_TIER, PRESSURE_DELTA, RELIEF_SAFE_RANGE, TIERS, WARMUP_BATCHES,
} from './dealConfig.js'

// The step counter's only job is to be monotone: one increment per SETTLED placement
// (§4.1 — not a drag, not an illegal drop, not a cube turn, not a pause, not a load, not an
// item use or its undo, not a refresh). Everything else is derived from it, so a save slot
// can never hold a step count and a tier that disagree.
export function tierOf(placementCount) {
  const steps = Number.isFinite(placementCount) && placementCount > 0 ? Math.floor(placementCount) : 0
  return Math.min(MAX_TIER, Math.floor(steps / PLACEMENTS_PER_TIER))
}

export function tierConfig(tier) {
  return TIERS[Math.max(0, Math.min(MAX_TIER, tier | 0))]
}

// A fresh run: warmup, nothing dealt yet, no cooldown armed.
export function createDirectorState() {
  return {
    version: 1,
    configVersion: DEAL_CONFIG_VERSION,
    placementCount: 0,
    naturalBatchIndex: 0,          // how many NATURAL batches have been dealt this run
    phase: 'warmup',
    buildBatchesLeft: 0,
    challengePlacementsLeft: 0,
    reliefPending: false,          // the challenge just finished; the NEXT batch is relief
    lastBlock9NaturalBatch: null,  // null = never dealt one this run
    recentHands: [],               // shape-name multisets, newest last, capped by config
    // P1 has no next-batch preview, so this stays 'rollingPressure' for the whole release
    // and the report can say so honestly (§9.1 vs §9.2).
    challengeMode: 'rollingPressure',
    migration: false,              // true when the run was migrated from a pre-v0.9.0 save
  }
}

// ---- The phase machine (§8.3) -----------------------------------------------
// Called exactly once per NATURAL batch, at generation time, and it both advances the
// counters and answers "what kind of batch is this". An item Refresh does NOT come through
// here (see refreshIntent): it must not advance the natural batch counter, must not shorten
// the Block 9 cooldown, and is always dealt on the relief target.
//
// The shape of a run: 3 warmup batches → [2–3 build batches → 1 challenge → 1 relief] → ...
// A challenge's length is in PLACEMENTS and is LOCKED when the challenge starts, so crossing
// the 30/60/90 milestone mid-challenge does not lengthen the stretch already announced.
export function beginNaturalBatch(state, rng) {
  state.naturalBatchIndex += 1
  const tier = tierOf(state.placementCount)

  if (state.naturalBatchIndex <= WARMUP_BATCHES) {
    state.phase = 'warmup'
    // The build stretch that follows warmup is decided on the LAST warmup batch, so the very
    // next natural batch is already a build batch rather than falling straight through to a
    // challenge. (Caught by tools/deal-director-tests.mjs: without this the first challenge
    // arrived at batch 4 and the run never had a build stretch at all.)
    if (state.naturalBatchIndex === WARMUP_BATCHES) {
      state.buildBatchesLeft = rng ? BUILD_BATCHES[rng.int(BUILD_BATCHES.length)] : BUILD_BATCHES[0]
    }
    return intentFor(state, tier)
  }
  if (state.reliefPending) {
    // The challenge ended during the previous hand; that hand was played out in full and
    // this is the recovery batch (§8.3).
    state.reliefPending = false
    state.phase = 'relief'
    // A new build stretch starts after this relief batch; its length is decided now so the
    // rhythm does not depend on how many hands the relief batch happens to take.
    state.buildBatchesLeft = rng ? BUILD_BATCHES[rng.int(BUILD_BATCHES.length)] : BUILD_BATCHES[0]
    return intentFor(state, tier)
  }
  if (state.challengePlacementsLeft > 0) {
    // A challenge that ran past the end of the previous batch: the remaining steps apply to
    // the first placements of this one, and the batch is generated on the challenge target
    // (§8.3 "剩余挑战步数对应下一批前若干次放置").
    state.phase = 'challenge'
    return intentFor(state, tier)
  }
  if (state.buildBatchesLeft > 0) {
    state.buildBatchesLeft -= 1
    state.phase = 'build'
    return intentFor(state, tier)
  }
  state.phase = 'challenge'
  state.challengePlacementsLeft = tierConfig(tier).challengeSteps
  return intentFor(state, tier)
}

// One settled placement (§4.1). Returns what changed so main can act on the milestone
// without re-deriving it — and so the run report can count real challenge steps rather than
// a countdown field.
export function notePlacement(state) {
  state.placementCount += 1
  const tier = tierOf(state.placementCount)
  const enteredTier = tier !== tierOf(state.placementCount - 1)
  let challengeFinished = false
  if (state.challengePlacementsLeft > 0) {
    state.challengePlacementsLeft -= 1
    if (state.challengePlacementsLeft === 0) {
      state.reliefPending = true
      challengeFinished = true
    }
  }
  return { placementCount: state.placementCount, tier, enteredTier, challengeFinished }
}

// Record a dealt hand. `natural` batches move the run forward (and are the only ones that can
// arm the Block 9 cooldown); a refresh hand is remembered for the repeat penalty but changes
// nothing else.
export function noteDealt(state, handNames, { natural = true } = {}) {
  const names = [...handNames]
  state.recentHands.push(names)
  while (state.recentHands.length > BATCH_RULES.recentHandsKept) state.recentHands.shift()
  if (natural && names.includes('Block 9')) state.lastBlock9NaturalBatch = state.naturalBatchIndex
  return names
}

// ---- The intent a batch is generated against --------------------------------
function intentFor(state, tier) {
  const config = tierConfig(tier)
  if (state.phase === 'relief') {
    return {
      phase: 'relief',
      tier,
      safeRange: RELIEF_SAFE_RANGE,
      pressureDeltaRange: PRESSURE_DELTA.relief,
      challengePlacementsLeft: 0,
      // A relief batch still has to be finishable; "easier" is the whole point of it.
      label: '恢复：几乎总能找到出路',
    }
  }
  if (state.phase === 'challenge') {
    return {
      phase: 'challenge',
      tier,
      safeRange: config.challenge,
      pressureDeltaRange: PRESSURE_DELTA.challenge,
      challengePlacementsLeft: state.challengePlacementsLeft,
      label: config.label,
    }
  }
  if (state.phase === 'warmup') {
    return {
      phase: 'warmup',
      tier,
      safeRange: config.build,
      pressureDeltaRange: PRESSURE_DELTA.warmup,
      challengePlacementsLeft: 0,
      label: '开局：观察与基础放置',
    }
  }
  return {
    phase: 'build',
    tier,
    safeRange: config.build,
    pressureDeltaRange: PRESSURE_DELTA.build,
    challengePlacementsLeft: 0,
    label: config.label,
  }
}

export function currentIntent(state) {
  return intentFor(state, tierOf(state.placementCount))
}

// The intent an item Refresh is dealt against (§10.1): relief targets, read at the CURRENT
// tier, and never a Block 9. It deliberately does not consult or move the phase machine.
export function refreshIntent(state) {
  const tier = tierOf(state.placementCount)
  return {
    phase: 'relief',
    tier,
    safeRange: RELIEF_SAFE_RANGE,
    pressureDeltaRange: PRESSURE_DELTA.relief,
    challengePlacementsLeft: state.challengePlacementsLeft,
    label: '换批：救场目标（排除 Block 9）',
    isRefresh: true,
  }
}

// Which shapes a batch generated right now may contain (§3.2). The Block 9 cooldown is
// counted in NATURAL batches: a refresh never arms it and never clears it.
export function batchConstraints(state, { natural = true, allowBlock9Override = null } = {}) {
  const cooling = state.lastBlock9NaturalBatch !== null
    && state.naturalBatchIndex - state.lastBlock9NaturalBatch <= BATCH_RULES.block9CooldownBatches
  const allowBlock9 = allowBlock9Override !== null
    ? allowBlock9Override === true
    : (natural ? !cooling : BATCH_RULES.refreshAllowsBlock9)
  return {
    allowBlock9,
    maxSameShape: BATCH_RULES.maxSameShapePerBatch,
    // Why Block 9 is out, for the batch's own record: "cooldown" and "this is a refresh" are
    // different facts and the report should not conflate them.
    block9Reason: allowBlock9 ? 'allowed' : (natural ? 'cooldown' : 'refresh'),
  }
}

// ---- Scoring a candidate batch (§7.1) ---------------------------------------
// 0 when the interval/value is inside the range, otherwise the gap. The spec is explicit
// that an interval which merely INTERSECTS the target is not proof of hitting it — so the
// caller keeps `withinRange` separately and the report counts how often the target was
// actually met, instead of the cost being read as "close enough".
export function distanceToRange(value, range) {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY
  if (value < range[0]) return range[0] - value
  if (value > range[1]) return value - range[1]
  return 0
}

export function distanceOfIntervalToRange(interval, range) {
  const [lo, hi] = interval
  if (hi < range[0]) return range[0] - hi
  if (lo > range[1]) return lo - range[1]
  return 0
}

// How many of the recent hands are the same SET of shapes as this one. Order does not
// matter: "相同三块的不同排列视为同一个待评估组合" (§3.2).
export function repeatedHandCount(recentHands, handNames) {
  const key = multisetKey(handNames)
  return recentHands.reduce((count, hand) => count + (multisetKey(hand) === key ? 1 : 0), 0)
}

function multisetKey(names) {
  return [...names].sort().join('|')
}

// The whole cost of one candidate batch against the intent. `metrics` comes from the solver
// analysis: { aLower, aUpper, rEnd }.
export function costOf(state, intent, metrics) {
  const tolerance = distanceOfIntervalToRange([metrics.aLower, metrics.aUpper], intent.safeRange)
  const pressure = distanceToRange(metrics.rEnd - metrics.rBefore, intent.pressureDeltaRange)
  const repeat = repeatedHandCount(state.recentHands, metrics.handNames)
  return {
    cost: COST.tolerance * tolerance + COST.pressure * pressure + COST.repeat * repeat,
    tolerance,
    pressure,
    repeat,
    // The two honest "did it actually land" flags, kept apart from the cost.
    withinSafeRange: metrics.aLower >= intent.safeRange[0] && metrics.aUpper <= intent.safeRange[1],
    intersectsSafeRange: metrics.aUpper >= intent.safeRange[0] && metrics.aLower <= intent.safeRange[1],
    withinPressureRange: pressure === 0,
  }
}

// Weighted pick among the best few candidates (§7.1): exp(-(cost - minCost) / temperature).
// Deterministic given the RNG, and never a plain argmin — a dealer that always returns the
// single hardest hand makes a repeated position feel scripted.
export function pickCandidate(scored, rng) {
  if (!scored.length) return null
  const ranked = [...scored].sort((a, b) => a.scoring.cost - b.scoring.cost)
  const pool = ranked.slice(0, Math.max(1, Math.min(COST.pickFromBest, ranked.length)))
  if (pool.length === 1) return pool[0]
  const minCost = pool[0].scoring.cost
  const weights = pool.map((entry) => Math.exp(-(entry.scoring.cost - minCost) / COST.temperature))
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (!(total > 0) || !rng) return pool[0]
  let roll = rng() * total
  for (let i = 0; i < pool.length; i += 1) {
    roll -= weights[i]
    if (roll <= 0) return pool[i]
  }
  return pool[pool.length - 1]
}

// ---- Save / restore (§4.3) --------------------------------------------------
export function serialize(state) {
  return {
    version: state.version,
    configVersion: state.configVersion,
    placementCount: state.placementCount,
    naturalBatchIndex: state.naturalBatchIndex,
    phase: state.phase,
    buildBatchesLeft: state.buildBatchesLeft,
    challengePlacementsLeft: state.challengePlacementsLeft,
    reliefPending: state.reliefPending,
    lastBlock9NaturalBatch: state.lastBlock9NaturalBatch,
    recentHands: state.recentHands.map((hand) => [...hand]),
    challengeMode: state.challengeMode,
    migration: state.migration,
  }
}

// A saved director that cannot be trusted reads as a FRESH one with the step count kept —
// never as a throw. The step count is the one field worth salvaging (it is the player's
// progress), and §4.3 forbids reconstructing it from the score: a migrated run starts at 0
// rather than guessing, and says so through `migration`.
export function revive(saved) {
  const fresh = createDirectorState()
  if (!saved || typeof saved !== 'object') return fresh
  const count = Number.isFinite(saved.placementCount) && saved.placementCount > 0
    ? Math.floor(saved.placementCount)
    : 0
  const restored = {
    ...fresh,
    placementCount: count,
    naturalBatchIndex: Number.isFinite(saved.naturalBatchIndex) && saved.naturalBatchIndex >= 0
      ? Math.floor(saved.naturalBatchIndex)
      : 0,
    phase: PHASES.includes(saved.phase) ? saved.phase : 'warmup',
    buildBatchesLeft: clampInt(saved.buildBatchesLeft, 0, Math.max(...BUILD_BATCHES)),
    challengePlacementsLeft: clampInt(saved.challengePlacementsLeft, 0, tierConfig(MAX_TIER).challengeSteps),
    reliefPending: saved.reliefPending === true,
    lastBlock9NaturalBatch: Number.isFinite(saved.lastBlock9NaturalBatch) ? Math.floor(saved.lastBlock9NaturalBatch) : null,
    recentHands: Array.isArray(saved.recentHands)
      ? saved.recentHands.filter(Array.isArray).map((hand) => hand.filter((name) => typeof name === 'string')).slice(-BATCH_RULES.recentHandsKept)
      : [],
    challengeMode: saved.challengeMode === 'previewPuzzle' ? 'previewPuzzle' : 'rollingPressure',
    migration: saved.migration === true,
    configVersion: typeof saved.configVersion === 'string' ? saved.configVersion : DEAL_CONFIG_VERSION,
  }
  // A cooldown that points at a batch that has not happened yet (or at a batch from a
  // different config) is meaningless — drop it rather than block Block 9 forever.
  if (restored.lastBlock9NaturalBatch !== null && restored.lastBlock9NaturalBatch > restored.naturalBatchIndex) {
    restored.lastBlock9NaturalBatch = null
  }
  return restored
}

function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

// Dealing + progressive-difficulty parameters (v0.9.0 P1; producer's 2026-09-23 spec).
//
// Every number the new dealer obeys lives here, for one reason: the spec is explicit that
// **none of these are verified balance conclusions** — they are the first trial
// configuration ("所有新权重、阈值、搜索预算与难度区间均为首轮试验配置"). A single
// parameter file is what makes "which numbers did we actually ship" answerable without
// reading the search, and it is the value that `configVersion` below pins into every save
// slot and every experiment row. When a number here changes, the version string changes
// with it, so a result measured under the old table can never be mistaken for a result
// under the new one.
//
// Read the spec's sections next to these tables:
//   §8.1 tier targets, §8.2 pressure deltas, §8.3 the phase machine,
//   §3.2 batch constraints, §6.1–6.3 search and sampling, §7.1 the cost function,
//   §11.2 the search budget.
//
// What is NOT here, on purpose:
//   - the shape weights (they are game rules and live in src/game/shapes.js);
//   - the reference pool used for the pressure metric (boardPressure.js owns it);
//   - anything about the next-batch preview (P2) — `P2_PREVIEW` is false and the whole
//     feature is a separate, later decision (§9.2). P1 must never claim it.

// Bumped whenever any value in this file changes in a way that can move a hand. It is
// written into the save slot and into the experiment output, so a number is always
// attributable to the table that produced it.
export const DEAL_CONFIG_VERSION = 'v0.9.0-p1.0'

// ---- Tiers (§8.1) ------------------------------------------------------------
// `tier = min(3, floor(placementCount / 30))` — the tier is DERIVED, never stored, so the
// step count and the tier can never disagree in a save slot.
//
// `safeRange` is the tolerated first-move completion interval `[A_lower, A_upper]` the
// dealer aims at: `A` is "share of sampled first moves from which the rest of the batch can
// still be finished", i.e. how much room a player has to choose wrongly and survive. A
// HIGHER value is EASIER. challenge ranges sit below build ranges at every tier, and both
// narrow downwards as the run goes on — that is the whole progressive-difficulty idea.
//
// `challengeSteps` is how many placements a challenge段 lasts (§8.3): 2 / 3 / 4 / 5, the
// spec's "30 / 60 / 90 节点" made visible as 连续压力. It is a length in PLACEMENTS, not
// batches, so a challenge can span a batch boundary — turning the cube, using an item or
// refreshing does NOT count as a placement and does not advance it.
export const TIERS = Object.freeze([
  { tier: 0, minPlacements: 0, build: [0.85, 1.00], challenge: [0.75, 0.95], challengeSteps: 2, label: '观察与基础放置' },
  { tier: 1, minPlacements: 30, build: [0.70, 0.90], challenge: [0.55, 0.80], challengeSteps: 3, label: '先后顺序与留空间' },
  { tier: 2, minPlacements: 60, build: [0.65, 0.85], challenge: [0.45, 0.70], challengeSteps: 4, label: '整批规划、连续决策' },
  { tier: 3, minPlacements: 90, build: [0.60, 0.80], challenge: [0.40, 0.65], challengeSteps: 5, label: '连续压力（P2 起可跨批规划）' },
])
export const MAX_TIER = TIERS.length - 1
export const PLACEMENTS_PER_TIER = 30

// Relief always aims at "there is nearly always a way through" (§8.1). It is a RECOVERY
// target, not a difficulty reset: it does not clear the board, lower the tier or refund
// items (§8.3).
export const RELIEF_SAFE_RANGE = Object.freeze([0.85, 1.00])

// ---- Pressure change per phase (§8.2) ---------------------------------------
// `R_end − R_before` is how much tighter the sampled batch leaves the board. It is a SOFT
// hand-selection target: the dealer never adds or removes blocks to hit it.
export const PRESSURE_DELTA = Object.freeze({
  warmup: [-0.08, 0.02],
  build: [0.01, 0.04],
  challenge: [0.00, 0.04],
  relief: [-0.12, 0.00],
})
// "同时优先避免采样整批压力一次增加超过 0.08" (§8.2). A soft guard, applied when choosing
// between otherwise comparable candidates — not a rule that can fail a batch. It is
// deliberately NOT folded into the cost formula below, so the shipped cost stays exactly
// the three terms the spec prints.
export const PRESSURE_MAX_JUMP = 0.08

// ---- Batch composition rules (§3.2) -----------------------------------------
export const BATCH_RULES = Object.freeze({
  maxBlock9PerBatch: 1,
  // After a natural batch deals a Block 9, the next three natural batches may not contain
  // one. This is the shape-level version of "stop one piece monopolising the stuck states"
  // (§1.1) and it is why Block 9's realised rate is below its 1.96% base share.
  block9CooldownBatches: 3,
  // Soft constraint: at most two of the same shape per batch. The constructive fallback is
  // allowed to relax it, and MUST record that it did (see FALLBACK_REASONS).
  maxSameShapePerBatch: 2,
  // Item Refresh: never deals a Block 9 in P1, and never advances the natural batch counter
  // or shortens the cooldown (§3.2, §10.1).
  refreshAllowsBlock9: false,
  // How many recent natural hands the repeat penalty looks back over (§7.1).
  recentHandsKept: 4,
})

// ---- Sampling and search budget (§6.2, §11.2) -------------------------------
export const SAMPLING = Object.freeze({
  // "按基础权重生成最多 48 个不重复手牌组合" (§7.1). A cap, not a quota — and P1 ships 36.
  // Measured with tools/deal-perf.mjs: at 48 proposals a deal cost ~51ms p50 on the main
  // thread, i.e. it sat exactly on the spec's "no 50ms long task" criterion; at 36 it is
  // comfortably inside both criteria on the development machine. The proposal step draws
  // without replacement by SET, so a smaller cap narrows the search a little rather than
  // biasing it — and the fallback path still covers the case where nothing sampled fits.
  candidateHands: 36,
  // "最多取 24 个互不重复的合法首步" (§6.2); below `minFirstMoves` the analysis covers every
  // legal first move instead and reports the low-branch case.
  firstMoves: 24,
  minFirstMoves: 16,
  // "每个首步最多保留同等数量（初始 2 条）" of successful paths, for R_end (§6.3).
  pathsPerFirstMove: 2,
  // Staged filtering (§11.2 "采用分阶段筛选与缓存"). Analysing all 48 proposals at the full
  // 24 samples is what made a deal cost ~70ms on the main thread — over the spec's own
  // "no 50ms long task" criterion even though the p95 was inside budget. So every proven
  // candidate is first analysed cheaply, and only the best few are refined at full depth.
  // The cheap pass is a RANKING, not a verdict: nothing is dropped by it, and the chosen
  // candidate always carries a full-depth analysis.
  stage1Samples: 8,
  refineCount: 6,
})

// Node budgets are the reproducible unit of cost (§11.2): a run is described by
// (configVersion, seed, budget), not by a wall-clock number that changes with the machine.
// These are first-cut values — the acceptance target is p95 ≤ 150ms per dealt batch with no
// main-thread task over 50ms, and that is a TO-BE-VERIFIED budget, not a known performance.
export const BUDGET = Object.freeze({
  nodesPerHand: 6000,        // one full-batch SOLVABLE/UNSOLVABLE proof attempt
  nodesPerRemaining: 1200,   // the per-first-move "can the rest still be placed" question
  nodesPerDeal: 400000,      // the ceiling for ONE dealt batch, across all candidates
})

// ---- Candidate selection (§7.1) ---------------------------------------------
// cost = 1.0 * distanceOfIntervalToRange(A_interval, safeRange)
//      + 2.0 * distanceToRange(R_end - R_before, pressureDeltaRange)
//      + 0.05 * repeatedHandCountInRecent4Batches
// An interval that merely INTERSECTS the target is not proof of hitting it — the cost only
// knows "how far away", and the dealer records whether the chosen hand actually landed
// inside, so a run that never reaches its target is visible instead of silently "close".
export const COST = Object.freeze({
  tolerance: 1.0,
  pressure: 2.0,
  repeat: 0.05,
  // Weighted pick among the best few: exp(-(cost - minCost) / temperature). Without this the
  // dealer would pick the same hardest hand every time a position repeats, which reads as a
  // rigged game even when the search is honest.
  temperature: 0.08,
  pickFromBest: 5,
})

// ---- Phase machine (§8.3) ---------------------------------------------------
export const PHASES = Object.freeze(['warmup', 'build', 'challenge', 'relief'])
export const WARMUP_BATCHES = 3      // "新局前三次自然发牌为 warmup（第一批记入其中）"
export const BUILD_BATCHES = Object.freeze([2, 3]) // "随机选择 2 或 3 批 build"
export const RELIEF_BATCHES = 1      // "→ 1 批 relief → 下一轮 build"

// ---- P2 (§9.2) --------------------------------------------------------------
// The next-batch preview is a SEPARATE feature with its own switch, default OFF, and it is
// not part of P1. Its existence here is the honest version of "P1 不能宣称已经实现 P2":
// the flag is false, the queued hand is never generated, and the director reports
// `challengeMode: 'rollingPressure'`.
export const P2_PREVIEW = false

// Why a batch is not what the search wanted. Every fallback is recorded on the batch so the
// telemetry can report a fallback RATE instead of pretending every hand hit its target.
export const FALLBACK_REASONS = Object.freeze({
  NONE: 'none',
  RELAXED_PRESSURE: 'relaxed-pressure',
  RELAXED_TOLERANCE: 'relaxed-tolerance',
  EXTRA_CANDIDATES: 'extra-candidates',
  CONSTRUCTED: 'constructed',
  RELAXED_SAME_SHAPE: 'relaxed-same-shape',
  NO_FULL_CONTINUATION: 'board-no-full-continuation',
  NO_FIRST_MOVE: 'board-no-first-move',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  // Not a fallback: the chosen batch is the same SET of three pieces as one of the last four
  // batches. It is recorded because a player notices repetition long before a metric does.
  SAME_AS_PREVIOUS: 'same-as-previous',
})

// The order the dealer degrades in (§7.2). Kept as data so the report can say WHICH step was
// needed rather than "a fallback happened".
export const FALLBACK_ORDER = Object.freeze([
  FALLBACK_REASONS.RELAXED_PRESSURE,
  FALLBACK_REASONS.RELAXED_TOLERANCE,
  FALLBACK_REASONS.EXTRA_CANDIDATES,
  FALLBACK_REASONS.CONSTRUCTED,
])

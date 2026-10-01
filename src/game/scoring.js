// VoxalBlast score model — TWO rule sets, one file.
//
// v0.10.3 (docs/Technical/SCORE_REWARD_SIMPLIFICATION_HANDOFF.md): the game ships a second
// scoring rule set. Both live here, because "every coefficient of the score lives HERE and
// nowhere else" is the property that makes the balance auditable, and splitting them across
// two modules would make "which formula did this run use" a question about file layout.
//
//   * SCORE_RULES_V1 / SCORING / moveScore()      — the shipped 08 §4 rules.
//     LEGACY ONLY. A run that was already in progress on a version-1 save finishes on these
//     rules (§5.2: 不中途改价), and tools/reachability.mjs + the old-formula regression in
//     tools/rule-tests.mjs still drive them. No new run reaches them.
//   * SCORE_RULES_VERSION / SCORING_V2 / settleScore() — this round's simplification:
//     基础放置分 + 基础消线分 + 三类额外奖励（一次多消 / 连续消除 / 清除整面）, and nothing
//     else. No cross-face bonus, no chain milestone, no honour bonus, no multiplier stacking.
//
// Both are pure functions so tools/rule-tests.mjs can drive them directly, and both stay
// reproducible by design (08 §5.4): no random crit, no item multiplier, no probabilistic
// trigger. A score that cannot be replayed cannot back a leaderboard.
export const SCORE_RULES_V1 = 1
export const SCORE_RULES_VERSION = 2

export const SCORING = Object.freeze({
  // §4.1 placement score — paid for every cell that lands, cleared or not, so a
  // turn spent building still reads as progress instead of a waste.
  placePerCell: 10,

  // §4.2 line score = lineBase × 总消除线数 × multiplier(总消除线数), where the
  // index is the number of lines settled by ONE placement (0 = no clear).
  // The curve is convex on purpose: taking a third line must beat three separate
  // single lines, or nobody builds for it (09 §4.2, 实测 1 线 63.5% / 2 线 32.9%
  // / 3 线 3.10% / 4 线 0.43%). 7..12 are the 理论区 — never observed in 2000
  // games × 600 steps — but the table has to reach the proven per-move ceiling of
  // 12 lines (tools/reachability.mjs) or "破顶" stops meaning anything.
  lineBase: 100,
  lineMultipliers: Object.freeze([0, 1, 2.5, 5, 10, 18, 30, 45, 65, 90, 120, 155, 195]),

  // §4.3 cross-face reward is ADDITION, not multiplication. A 2-face clear is
  // 31.6% of all clears (09 §2.1) — basic play, so it must not multiply the most
  // common event into the biggest reward; that would flatten the contrast the
  // rare events need. 3 is the proven ceiling: a 4-cell piece can touch at most
  // one corner, and a corner belongs to 3 faces, so there is no 4+ branch.
  faceBonus: Object.freeze({ 2: 200, 3: 600 }),

  // §4.4 the streak. `perLink` is paid on every clearing turn against the chain
  // AFTER this move's increment; a turn that clears nothing drops the chain to 0,
  // and chainMilestones pay once, on the exact link that reaches them.
  chainPerLink: 25,
  chainMilestones: Object.freeze([
    Object.freeze({ at: 5, bonus: 200 }),
    Object.freeze({ at: 10, bonus: 500 }),
    Object.freeze({ at: 15, bonus: 1000 }),
    Object.freeze({ at: 20, bonus: 2000 }),
  ]),
})

// ---- v2: the simplified table (handoff §2.1, 首轮推荐值) ------------------------
//
// Five numbers, plus the two caps the doc states as caps. Everything else the old rules
// paid for is gone: the凸 multiplier curve, the cross-face bonus, the chain milestone and
// the six honour bonuses are all absent rather than set to zero, so a future reader cannot
// mistake a disabled branch for a live one.
//
// The multi-clear bonus is deliberately LINEAR (`100 × (L-1)`): the doc accepts that this
// weakens the old ultra-rare 5+ line payout, because 玩家能算清楚自己的分数 outranks it
// (handoff §7 「这是简化的代价」). Do not put the honour bonus back to compensate.
export const SCORING_V2 = Object.freeze({
  placePerCell: 10,
  lineBase: 100,
  multiStep: 100, // 每多一条线 +100, from the 2nd line on
  streakStep: 50, // 连续消除第 2 次起，每级 +50 ...
  streakCap: 4, // ... 最高 4 级（第 5 次起封顶 +200，次数仍显示真实值）
  faceClear: 300, // 每个净面 +300
})

// The three reward categories, fixed ids (§4.1). `REWARD_ORDER` is the order they are
// built and listed in (the doc's own §2.1 order); `REWARD_PRIORITY` is the MAIN-TITLE
// order of §3.3 — 清除整面 > 一次多消 > 连续消除. They are two different questions
// ("which do we list" vs "which do we headline") and are kept apart on purpose.
export const REWARD_TYPES = Object.freeze({
  MULTI_CLEAR: 'MULTI_CLEAR',
  CLEAR_STREAK: 'CLEAR_STREAK',
  FACE_CLEAR: 'FACE_CLEAR',
})
export const REWARD_ORDER = Object.freeze([
  REWARD_TYPES.MULTI_CLEAR, REWARD_TYPES.CLEAR_STREAK, REWARD_TYPES.FACE_CLEAR,
])
export const REWARD_PRIORITY = Object.freeze([
  REWARD_TYPES.FACE_CLEAR, REWARD_TYPES.MULTI_CLEAR, REWARD_TYPES.CLEAR_STREAK,
])

// Proven per-move ceiling (08 §2.2 / 09 §1.1). A count above it can only come from
// a rule change, so it clamps rather than inventing a multiplier.
export const MAX_LINES_PER_MOVE = SCORING.lineMultipliers.length - 1

const count = (value) => Math.max(0, Math.trunc(value) || 0)

// ----------------------------------------------------------------------------
// v1 — legacy formula. Kept byte-for-byte identical to what shipped, because a
// version-1 run in flight is still scored by it and the frozen measurements in
// docs/Technical/DIFFICULTY_*.md were taken against these exact numbers.
// ----------------------------------------------------------------------------

export function lineMultiplier(lineCount) {
  return SCORING.lineMultipliers[Math.min(MAX_LINES_PER_MOVE, count(lineCount))]
}

export function lineScore(lineCount) {
  const lines = count(lineCount)
  return SCORING.lineBase * lines * lineMultiplier(lines)
}

export function faceBonus(facesHit) {
  return SCORING.faceBonus[count(facesHit)] || 0
}

export function placementScore(cellCount) {
  return SCORING.placePerCell * count(cellCount)
}

export function chainBonus(chain) {
  return count(chain) > 0 ? SCORING.chainPerLink * count(chain) : 0
}

export function chainMilestoneBonus(chain) {
  const hit = SCORING.chainMilestones.find((milestone) => milestone.at === count(chain))
  return hit ? hit.bonus : 0
}

// The streak rule itself (§4.4): a placement that cleared something extends the
// chain, one that cleared nothing drops it to zero. Tiny and pure on purpose — it is
// the one line the balance of the whole streak layer hangs on, so it is stated once.
// v2 keeps this rule unchanged (§2.3: 同一口径，只是第二次才开始给奖).
export function nextChain(chain, lines) {
  return count(lines) > 0 ? count(chain) + 1 : 0
}

// ---- what counts as ONE line for scoring (制作人口径，2026-10-01) ------------------
//
// 「棱上的消除会被计算多次」. A row along a cube edge is ONE physical row of five blocks, but it
// lies on two faces, so `Board.place()` reports it twice — once per face. That is CORRECT for
// clearing (v0.3 settles all six faces so nothing is ever left standing full) and correct for the
// face ledger (`facesHit`, `faceWiped`, `facesLit` are facts about the cube), and it is WRONG for
// scoring: the player cleared five blocks, exactly as they would have in the middle of a face, and
// was told 「一次消除 2 线」, paid 2 × 100 line points AND the multi-clear bonus on top — 310 for a
// move that pays 110 anywhere else on the board.
//
// So the score counts DISTINCT SEGMENTS: a line's identity is the SET OF CELLS it occupies, never
// the face it was noticed on. Interior rows are unaffected (one face, one segment), two genuinely
// different rows stay two, and a shared edge collapses to the one row the player actually made.
//
// This is the same identity rendering/effects.js uses (`segmentKey`) to draw one band per segment
// instead of one per face — the board had one answer for the picture and another for the money.
export function segmentKey(line) {
  if (!line || !Array.isArray(line.cells)) return ''
  return line.cells.map((cell) => cell.join(',')).sort().join('|')
}

export function uniqueLines(lines) {
  const seen = new Set()
  const out = []
  for (const line of lines || []) {
    const key = segmentKey(line)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

/** The line count the score, the streak and the run's own totals are stated in. */
export function countScoringLines(lines) {
  return uniqueLines(lines).length
}

// One place that turns a settled move into points, LEGACY rules (§4.5):
//   放置分 + 线分 + 跨面奖励 + 链加成(含里程碑) + Σ 荣誉加分
//
// `chain` is the chain length AFTER this move — a clearing move increments first,
// so a 5th consecutive clear pays 25×5 and the 5-link milestone on the same turn.
// The chain terms are gated on a clear having happened at all, so a caller that
// forgets to zero the chain on a dead turn cannot quietly bank streak points.
export function moveScore({ cellCount = 0, lines = 0, faces = 0, chain = 0, honorBonus = 0 } = {}) {
  const cleared = count(lines) > 0
  const placement = placementScore(cellCount)
  const line = lineScore(lines)
  const face = faceBonus(faces)
  const chainLinks = cleared ? chainBonus(chain) : 0
  const milestone = cleared ? chainMilestoneBonus(chain) : 0
  const honor = count(honorBonus)
  return {
    placement,
    line,
    face,
    chain: chainLinks + milestone,
    chainMilestone: milestone,
    honor,
    total: placement + line + face + chainLinks + milestone + honor,
  }
}

// ----------------------------------------------------------------------------
// v2 — the simplified formula (handoff §2)
// ----------------------------------------------------------------------------

// `wipedFaces` arrives as Board.place()'s `faceWiped` — a list of face IDS, not a count,
// because the presentation layer needs to know WHICH faces to outline (§4.1). Anything
// else (a number, a stale save field, undefined) normalizes to an id-free count so a
// caller can never be paid twice for the same face.
//   - `undefined`/absent → 0 faces (看得见的“没传”比猜一个数安全)
//   - a number           → that many anonymous faces
//   - an array           → its DISTINCT entries
export function normalizeWipedFaces(wipedFaces) {
  if (Array.isArray(wipedFaces)) return [...new Set(wipedFaces)].length
  return count(wipedFaces)
}

// §2.1 一次多消: 同手 L 条线，L>=2 起 +100×(L-1)。一次多消 only looks at THIS hand.
export function multiClearBonus(lines) {
  const lineCount = count(lines)
  return lineCount >= 2 ? SCORING_V2.multiStep * (lineCount - 1) : 0
}

// §2.3 连续消除: 第二次连续消除起给奖，C-1 级、封顶 4 级（C>=5 都是 +200）。
// The CHAIN still counts真实次数 (显示「连续消除 12 次」), only the money caps.
export function streakBonus(lines, chain) {
  if (count(lines) <= 0) return 0
  const step = Math.min(Math.max(count(chain) - 1, 0), SCORING_V2.streakCap)
  return SCORING_V2.streakStep * step
}

// §2.4 清除整面: 落子前非空 → 正常结算后为空。
//
// **制作人口径（2026-10-01）**：只算**方块放置的那一面**，侧面不算。`Board.place()` 的
// `faceWiped` 会列出所有「落子前非空、结算后为空」的面 —— 共享棱/角上的格子被邻面的线带走时，
// 一个邻面也会跟着空掉 —— 但那不是玩家这一手的目标面，不发奖。所以进价前必须用
// `wipedFacesFor()` 收窄，直接把 `faceWiped` 丢进来是错的（v0.11.0 首版就是这么做的，
// 一次沿棱的消除能同时点亮 3 个面并付 900 分）。
//
// 由此 `W ∈ {0, 1}`：一手最多清空一个面（落子面），「2 面 +600、依此类推」在当前规则下不可达。
export function faceClearBonus(lines, wipedFaces) {
  if (count(lines) <= 0) return 0
  return SCORING_V2.faceClear * normalizeWipedFaces(wipedFaces)
}

// 净面判定的收窄：从 `faceWiped` 里只留下落子面。返回的是**面 ID 列表**（不是个数），
// 因为表现层要用它点亮那一面。落子面必须真的出现在 `faceWiped` 里才算 —— 也就是它必须
// 「落子前非空、结算后为空」；一个本来就空的面不会被奖励。
export function wipedFacesFor(placedFace, faceWiped, lines) {
  if (count(lines) <= 0) return []
  if (!placedFace || !Array.isArray(faceWiped)) return []
  return faceWiped.includes(placedFace) ? [placedFace] : []
}

// The three bonuses, each settled ONCE, as the reward list §4.1 asks for: zero-bonus
// categories produce NO entry (so the presentation layer can never print "+0").
//
// `primaryType` is the §3.3 headline: 清除整面 > 一次多消 > 连续消除. It is a statement
// about reading order, not a claim about rarity.
export function resolveRewards({ lines = 0, chain = 0, wipedFaces = 0 } = {}) {
  const bonusOf = {
    [REWARD_TYPES.MULTI_CLEAR]: multiClearBonus(lines),
    [REWARD_TYPES.CLEAR_STREAK]: streakBonus(lines, chain),
    [REWARD_TYPES.FACE_CLEAR]: faceClearBonus(lines, wipedFaces),
  }
  const counts = {
    [REWARD_TYPES.MULTI_CLEAR]: count(lines),
    [REWARD_TYPES.CLEAR_STREAK]: count(chain),
    [REWARD_TYPES.FACE_CLEAR]: normalizeWipedFaces(wipedFaces),
  }
  const rewards = REWARD_ORDER
    .filter((type) => bonusOf[type] > 0)
    .map((type) => ({ type, count: counts[type], bonus: bonusOf[type] }))
  const primaryType = REWARD_PRIORITY.find((type) => bonusOf[type] > 0) || null
  return {
    rewards,
    primaryType,
    multiBonus: bonusOf[REWARD_TYPES.MULTI_CLEAR],
    streakBonus: bonusOf[REWARD_TYPES.CLEAR_STREAK],
    faceClearBonus: bonusOf[REWARD_TYPES.FACE_CLEAR],
  }
}

// ONE settled move → the whole score, in the shape §4.1 fixes:
//   { placement, linePoints, multiBonus, streakBonus, faceClearBonus, total, rewards, primaryType }
//
// `total` is ALWAYS the sum of the five named parts (the assertion in §6.1), and there is
// no path through here that adds a sixth term — no honour bonus, no cross-face bonus, no
// milestone, no multiplier. The old `faces` (facesHit) argument is deliberately NOT
// accepted: a shared edge counts a line on two faces, so paying for facesHit would pay
// the same clear twice (handoff §2.4 「后者绝不能直接拿来发整面奖」).
export function settleScore({ cellCount = 0, lines = 0, chain = 0, wipedFaces = 0 } = {}) {
  const lineCount = count(lines)
  const placement = SCORING_V2.placePerCell * count(cellCount)
  const linePoints = SCORING_V2.lineBase * lineCount
  const reward = resolveRewards({ lines: lineCount, chain, wipedFaces })
  return {
    placement,
    linePoints,
    multiBonus: reward.multiBonus,
    streakBonus: reward.streakBonus,
    faceClearBonus: reward.faceClearBonus,
    rewards: reward.rewards,
    primaryType: reward.primaryType,
    total: placement + linePoints + reward.multiBonus + reward.streakBonus + reward.faceClearBonus,
  }
}

// Presentation intensity of a settled v2 move — the SAME L0–L5 ladder the celebration
// budget, the clear cue and the L5 dip are indexed by, derived from the reward result
// instead of re-reading lines and facesHit (handoff §3.4: 新奖励展示必须直接消费本次统一
// 奖励事件，不能按 facesHit 自行升级).
//
// This is a RULE-side number (honors.js kept the v1 one); the seconds, the paper counts
// and the shake it maps to are presentation numbers and live in rendering/config.js.
export function rewardLevel({ lines = 0, rewards = [] } = {}) {
  const lineCount = count(lines)
  let level = lineCount >= 5 ? 5 : lineCount >= 1 ? lineCount : 0
  const bump = (value) => { level = Math.max(level, value) }
  for (const reward of rewards || []) {
    if (reward.type === REWARD_TYPES.MULTI_CLEAR) bump(reward.count >= 5 ? 5 : reward.count >= 4 ? 4 : reward.count >= 3 ? 3 : 2)
    else if (reward.type === REWARD_TYPES.CLEAR_STREAK) bump(reward.count >= 5 ? 4 : reward.count >= 3 ? 3 : 2)
    // 清除整面 counts 0 or 1 by rule (只算落子面): one emptied face is an L3 moment, and there is
    // no second tier to climb to.
    else if (reward.type === REWARD_TYPES.FACE_CLEAR) bump(3)
  }
  return level
}

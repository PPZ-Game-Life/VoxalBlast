// VoxalBlast score model (v0.3) — docs/Planning/08-荣誉与排行榜系统.md §4.
//
// Every coefficient of the score lives HERE and nowhere else. Retuning the
// balance must be an edit to SCORING, never a hunt through main.js; the four
// layers are pure functions so tools/rule-tests.mjs can drive them directly.
//
// Main score stays reproducible by design (08 §5.4): no random crit, no item
// multiplier, no probabilistic trigger. A score that cannot be replayed cannot
// back a leaderboard.
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

// Proven per-move ceiling (08 §2.2 / 09 §1.1). A count above it can only come
// from a rule change, so it clamps rather than inventing a multiplier.
export const MAX_LINES_PER_MOVE = SCORING.lineMultipliers.length - 1

const count = (value) => Math.max(0, Math.trunc(value) || 0)

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
export function nextChain(chain, lines) {
  return count(lines) > 0 ? count(chain) + 1 : 0
}

// One place that turns a settled move into points (§4.5):
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

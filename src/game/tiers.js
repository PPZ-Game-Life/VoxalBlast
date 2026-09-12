// 阶位 / Tier — docs/Planning/08-荣誉与排行榜系统.md §4.6.
//
// The cut scores are deliberately EMPTY. Measured median score is 212,300 while
// 99.3% of games hit the 600-step cap without ever ending (09 §3), so a run has no
// natural length and any absolute threshold would be calibrated against a game
// that never stops. The doc's method is to take the quantile cuts of a REAL
// distribution once the difficulty question is settled (08 §11.1 / §12).
//
// So this module ships the mechanism and leaves the numbers null. Until a
// calibration is pasted in, `tierForScore()` returns null and the UI says
// "阶位待校准" instead of showing a badge nobody can earn.
// tools/tier-calibration.mjs turns a sample of real scores into the object below.
export const TIERS = Object.freeze([
  Object.freeze({ tier: 1, name: '新刻面', title: 'NOVICE' }),
  Object.freeze({ tier: 2, name: '塑形者', title: 'SHAPER' }),
  Object.freeze({ tier: 3, name: '面匠', title: 'FACER' }),
  Object.freeze({ tier: 4, name: '六面手', title: 'CUBER' }),
  Object.freeze({ tier: 5, name: '立方师', title: 'MASTER' }),
  Object.freeze({ tier: 6, name: '满贯者', title: 'LEGEND' }),
])

// Quantile cuts of the reference distribution, in score. `null` = uncalibrated.
// Fill via tools/tier-calibration.mjs, which also records where the sample came
// from — a tier table without a provenance line is the thing §4.6 warns about.
export const TIER_CUTS = Object.freeze({
  p25: null, // tier 1 → 2
  p50: null, // tier 2 → 3
  p75: null, // tier 3 → 4
  p90: null, // tier 4 → 5
  p99: null, // tier 5 → 6
})

export const TIER_CALIBRATION = null // e.g. { source: 'noise×2000', at: '2026-09-12', games: 2000 }

const CUT_KEYS = ['p25', 'p50', 'p75', 'p90', 'p99']

export function tiersReady(cuts = TIER_CUTS) {
  let previous = -Infinity
  return CUT_KEYS.every((key) => {
    const value = cuts?.[key]
    if (!Number.isFinite(value) || value <= previous) return false
    previous = value
    return true
  })
}

// Tier of a score against a set of cuts, or null when they are not calibrated.
export function tierForScore(score, cuts = TIER_CUTS) {
  if (!tiersReady(cuts)) return null
  const value = Number.isFinite(score) ? score : 0
  const rank = CUT_KEYS.filter((key) => value >= cuts[key]).length
  return TIERS[Math.min(TIERS.length - 1, rank)]
}

// Which tier a cut set would hand out, for the calibration report.
export function tierSummary(cuts = TIER_CUTS) {
  if (!tiersReady(cuts)) return null
  return TIERS.map((tier, index) => ({
    ...tier,
    from: index === 0 ? 0 : cuts[CUT_KEYS[index - 1]],
    to: index === TIERS.length - 1 ? Infinity : cuts[CUT_KEYS[index]],
  }))
}

#!/usr/bin/env node
// Tier calibration — turns a sample of finished scores into the cut scores that
// src/game/tiers.js deliberately leaves empty (docs/Planning/08 §4.6).
//
//   node tools/tier-calibration.mjs my-scores.json
//   node tools/tier-calibration.mjs tools/reachability-v0.3.json   # model sample, see warning
//
// Input shapes it accepts:
//   - [12000, 15300, ...]                     a bare array of scores
//   - { "scores": [...] }                     a named array
//   - { "phase2": { "scorePercentiles": {} } } a reachability run (MODEL, not players)
//
// ⚠️ The design asks for REAL player quantiles (08 §4.6): the model's own percentiles
// are squeezed together because 100% of modelled games hit the step cap, so they
// describe "who survives 600 steps", not who is good. The tool prints the provenance
// it found so the number in the config can always be traced back.
import fs from 'node:fs'
import { tierSummary } from '../src/game/tiers.js'

const path = process.argv[2]
if (!path) {
  console.error('usage: node tools/tier-calibration.mjs <scores.json>')
  process.exit(2)
}

const raw = JSON.parse(fs.readFileSync(path, 'utf8'))
let scores = []
let source = path
let caveat = ''

if (Array.isArray(raw)) {
  scores = raw.filter((value) => Number.isFinite(value))
} else if (Array.isArray(raw.scores)) {
  scores = raw.scores.filter((value) => Number.isFinite(value))
  source = raw.source || path
} else if (raw.phase2?.scorePercentiles) {
  // Already-reduced model output: we can only re-emit its quantiles.
  const { p25, p50, p75, p90, p99 } = raw.phase2.scorePercentiles
  caveat = 'MODEL distribution (reachability run), NOT real players — see the warning in the header'
  print({ p25, p50, p75, p90, p99 }, {
    source: `${path} phase2.scorePercentiles`,
    games: raw.phase2.games ?? 0,
    at: new Date().toISOString().slice(0, 10),
  }, caveat)
  process.exit(0)
} else {
  console.error('unrecognised input: expected an array of scores, {scores:[...]} or a reachability JSON')
  process.exit(2)
}

if (scores.length < 30) {
  console.error(`only ${scores.length} scores — a quantile table needs a few hundred to mean anything`)
  process.exit(2)
}

scores.sort((a, b) => a - b)
const pick = (p) => {
  const index = (scores.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return scores[low]
  return Math.round(scores[low] + (scores[high] - scores[low]) * (index - low))
}

print(
  { p25: pick(0.25), p50: pick(0.5), p75: pick(0.75), p90: pick(0.9), p99: pick(0.99) },
  { source, games: scores.length, at: new Date().toISOString().slice(0, 10) },
  caveat,
)

function print(cuts, provenance, warning) {
  if (warning) console.warn(`⚠️  ${warning}\n`)
  console.log(`${scores.length || provenance.games} scores from ${provenance.source}\n`)
  console.log('Paste into src/game/tiers.js:\n')
  console.log(`export const TIER_CUTS = Object.freeze({
  p25: ${cuts.p25}, // tier 1 → 2
  p50: ${cuts.p50}, // tier 2 → 3
  p75: ${cuts.p75}, // tier 3 → 4
  p90: ${cuts.p90}, // tier 4 → 5
  p99: ${cuts.p99}, // tier 5 → 6
})`)
  console.log(`\nexport const TIER_CALIBRATION = Object.freeze({ source: '${provenance.source}', at: '${provenance.at}', games: ${provenance.games} })\n`)
  console.log('Tier bands this would produce:')
  for (const band of tierSummary(cuts) || []) {
    const to = Number.isFinite(band.to) ? band.to : '∞'
    console.log(`  T${band.tier} ${band.name.padEnd(4, '　')} ${String(band.from).padStart(7)} ~ ${to}`)
  }
}

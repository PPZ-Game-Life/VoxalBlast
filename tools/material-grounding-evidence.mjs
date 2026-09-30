// Curate the G0/G1 evidence: turn `artifacts/material-grounding/report-all.json` into the small,
// reviewable record that goes into the version库, and copy the selected frames with it.
//
//   node tools/material-grounding-evidence.mjs [report.json] [outDir]
//   defaults: artifacts/material-grounding/report-all.json → docs/Technical/assets/material-grounding-review
//
// Why a separate step rather than "commit the report": the probe's report carries every read-out of
// every condition (3.4 MB for six sessions) because that is what a re-analysis needs, while the
// repository should carry the numbers a reviewer has to be able to check by hand — the fixture
// hashes, the frame timings, the region diffs, the interpenetration table — plus the frames those
// numbers are about. Everything else stays in `artifacts/` (gitignored, regenerable).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = resolve(ROOT, process.argv[2] || 'artifacts/material-grounding/report-all.json')
const outDir = resolve(ROOT, process.argv[3] || 'docs/Technical/assets/material-grounding-review')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))

// The selected frames. Mobile is the primary acceptance viewport (§9.2: 390x844), so the full
// frames are the phone's; the desktop contributions are 1:1 crops, which is also what the earlier
// block-reference review kept (its directory is ~4.9 MB for the same reason).
// [view, tier, condition id, label, crop key]. A crop is not its own condition: the probe records
// it under `crops` on the condition it was cut from.
const FRAMES = [
  ['mobile', 'high', 'g0-empty-dock', 'G0 空盘 · 默认停靠'],
  ['mobile', 'high', 'g0-rgb-dock', 'G0 彩色存档 · 默认停靠（木 + 红/蓝/绿）'],
  ['mobile', 'high', 'g1a-A-all', 'G1a-A 全部开启'],
  ['mobile', 'high', 'g1a-C-no-contact', 'G1a-C 仅关接触贴片'],
  ['mobile', 'high', 'g1a-D-no-projected', 'G1a-D 仅关实时投影接收面'],
  ['mobile', 'high', 'g1b-art-ssao-off', 'G1b 二维底座（无 SSAO）'],
  ['mobile', 'high', 'g1b-platform-plain', 'G1b 三维样板（无 SSAO/无贴片/无接收面）'],
  ['mobile', 'high', 'g1b-platform-decal', 'G1b 三维样板 + 接触贴片'],
  ['mobile', 'high', 'g1b-platform-ssao', 'G1b 三维样板 + SSAO'],
  ['mobile', 'high', 'g1b-platform-flip-pitch-mid', 'G1b 三维样板 · pitch 45° 中间帧'],
  ['mobile', 'high', 'g1b-platform-intro-mid', 'G1b 三维样板 · 开场波次中间帧'],
  ['desktop', 'high', 'g0-rgb-dock', 'G0 1:1 正面裁切（彩漆）', 'face'],
  ['desktop', 'high', 'g0-rgb-dock', 'G0 1:1 底排裁切（裸木 + 彩漆同框）', 'wood'],
  ['desktop', 'high', 'g1b-art-flip-pitch-mid', 'G1b 二维底座 · pitch 45° 底边 1:1', 'base'],
  ['desktop', 'high', 'g1b-platform-flip-pitch-mid', 'G1b 三维样板 · pitch 45° 底边 1:1', 'base'],
  ['desktop', 'high', 'g1b-art-flip-roll-mid', 'G1b 二维底座 · roll 45° 底边 1:1', 'base'],
  ['desktop', 'high', 'g1b-platform-flip-roll-mid', 'G1b 三维样板 · roll 45° 底边 1:1', 'base'],
]

const condition = (view, tier, id) => report.conditions.find((entry) => entry.view === view && entry.tier === tier && entry.id === id)
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

mkdirSync(outDir, { recursive: true })
const frames = []
for (const [view, tier, id, label, cropKey] of FRAMES) {
  const entry = condition(view, tier, id)
  if (!entry) {
    console.warn(`WARN no such condition: ${view}/${tier}/${id}`)
    continue
  }
  const file = cropKey ? entry.crops?.[cropKey] : entry.file
  if (!file) {
    console.warn(`WARN no '${cropKey}' crop on: ${view}/${tier}/${id}`)
    continue
  }
  const source = resolve(ROOT, file)
  const name = cropKey ? `${id}-crop-${cropKey}.png` : `${id}.png`
  const target = join(outDir, name)
  copyFileSync(source, target)
  frames.push({
    id, label, view, tier, crop: cropKey || null,
    file: relative(ROOT, target).replace(/\\/g, '/'),
    bytes: statSync(target).size,
    sha256: sha256(target),
    state: entry.state,
    note: entry.note,
  })
}

// The numbers a reviewer checks by hand, per session.
const sessions = []
for (const entry of report.conditions) {
  const key = `${entry.view}|${entry.tier}`
  if (sessions.some((session) => session.key === key)) continue
  const grounding = entry.readouts.rendering.grounding
  sessions.push({
    key, view: entry.view, tier: entry.tier, viewport: entry.viewport,
    tierReported: grounding.tier,
    ssaoEnabledAtBoot: grounding.ssaoEnabled,
    ssaoOfferedByTier: grounding.ssaoOfferedByTier,
    occlusionIntensity: grounding.occlusionIntensity,
    rendererInfo: entry.readouts.rendering.rendererInfo,
    programs: entry.readouts.rendering.programs,
    ssaoInputs: entry.readouts.rendering.contactShadows.ssaoInputs,
    cubeBottomY: grounding.cubeBottomY,
    supportTopY: grounding.supportTopY,
    pedestalArt: grounding.pedestalArt,
  })
}

const timings = report.conditions
  .filter((entry) => entry.frameTiming)
  .map((entry) => ({
    id: entry.id, view: entry.view, tier: entry.tier,
    ...entry.frameTiming.static ? { static: entry.frameTiming.static } : {},
    ...entry.frameTiming.turning ? { turning: entry.frameTiming.turning } : {},
  }))

const evidence = {
  run: report.run,
  note: 'G0 + G1 evidence (docs/Technical/MATERIAL_GROUNDING_REWORK_HANDOFF.md §4/§5). Frame times come from headless software rendering on this machine and are a RELATIVE same-machine baseline, not a device measurement.',
  fixtures: report.fixtures,
  sessions,
  frames,
  frameTiming: timings,
  diffs: report.diffs,
  interpenetration: report.interpenetration,
  introWave: report.introWave,
  pageErrors: report.pageErrors,
  fullReport: relative(ROOT, reportPath).replace(/\\/g, '/'),
  regenerate: 'npm run fixtures:grounding && npm run probe:grounding -- --views=desktop,mobile,desktop720 --tiers=high,low',
}

const out = join(outDir, 'g0-g1-evidence.json')
writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`OK   ${relative(ROOT, out).replace(/\\/g, '/')}  frames=${frames.length}  diffs=${report.diffs.length}  interpenetration=${report.interpenetration.length}`)

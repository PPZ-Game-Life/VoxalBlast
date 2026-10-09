// 「浮空积木世界」美术包的接入前哨检查（v0.13.0）。
//
// Why this exists: the skin's assets arrive as a delivered pack with its own manifest, and the
// two ways a pack goes wrong at integration time are both invisible in a screenshot —
//   * a reference points at a file that is not there (a 404 that renders as "the old skin is
//     still on screen", which reads exactly like a cache problem and is not one), and
//   * the first screen quietly pulls more than the budget the handoff set (§10: 首屏新增美术
//     网络目标 ≤400 KiB), because every individual file looks small.
//
// So this checks the PACK against its own manifest, and then checks what the SOURCE actually
// references against the pack. It is deliberately read-only and dependency-free: no browser, no
// build, so it can run before the frame is finished — which is precisely when a wrong path is
// cheapest to catch.
//
//   node tools/floating-world-assets.mjs
//
// Scope it does NOT cover: whether the art looks right, whether a referenced SVG decodes, or
// whether the browser actually requests what the CSS names (that is what `npm run shot`'s
// network/error gate is for). This is the offline half.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHAPES } from '../src/game/shapes.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACK_DIR = join(ROOT, 'public', 'art', 'floating-world-v1')
const MANIFEST = join(PACK_DIR, 'manifest.json')
const RECIPE = join(PACK_DIR, 'scene.recipe.json')
const RUNTIME_PREFIX = '/art/floating-world-v1/'
const FIRST_SCREEN_BUDGET = 400 * 1024
// The pack's own exchange backups. §2.5: the GLBs are geometry sources for the art team, and
// the shipped background instantiates the recipe's `cells` instead — so they are NOT first-screen
// payload, and counting them would fail the budget for a file the game never asks for.
const EXCHANGE_ONLY = /\.glb$/i

const failures = []
const warnings = []

function fail(message) { failures.push(message) }
function warn(message) { warnings.push(message) }
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`
const manifestBytes = (file) => {
  const bytes = readFileSync(file)
  // Git may check text assets out as CRLF on Windows. Manifest sizes are canonical LF bytes so the
  // same pack validates on every OS; binary payloads always use their exact on-disk byte length.
  return /\.(?:json|svg)$/i.test(file)
    ? Buffer.byteLength(bytes.toString('utf8').replace(/\r\n/g, '\n'))
    : bytes.length
}

if (!existsSync(MANIFEST)) {
  console.error(`floating-world-assets: no manifest at ${relative(ROOT, MANIFEST)}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const recipe = JSON.parse(readFileSync(RECIPE, 'utf8'))
if (manifest.runtimeBase !== RUNTIME_PREFIX) {
  warn(`manifest.runtimeBase is ${JSON.stringify(manifest.runtimeBase)}, the source uses ${RUNTIME_PREFIX}`)
}

// ---- 1. the pack matches its own manifest --------------------------------------
let packedBytes = 0
const byRole = new Map()
for (const entry of manifest.files) {
  const file = join(PACK_DIR, entry.path)
  if (!existsSync(file)) { fail(`manifest lists ${entry.path} but the file is missing`); continue }
  const actual = manifestBytes(file)
  if (actual !== entry.bytes) fail(`${entry.path}: manifest says ${entry.bytes} canonical bytes, file is ${actual}`)
  if (actual === 0) fail(`${entry.path}: zero bytes`)
  packedBytes += actual
  byRole.set(entry.role, (byRole.get(entry.role) ?? 0) + 1)
}
if (manifest.totals) {
  if (manifest.totals.files !== manifest.files.length) fail(`manifest.totals.files is ${manifest.totals.files}, the list holds ${manifest.files.length}`)
  if (manifest.totals.bytes !== packedBytes) fail(`manifest.totals.bytes is ${manifest.totals.bytes}, the files total ${packedBytes}`)
}
// A file on disk that the manifest does not list is how a pack grows a second, unversioned copy
// of something the art team thought they had replaced.
const known = new Set(manifest.files.map((entry) => entry.path))
const walk = (dir, prefix = '') => {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) walk(join(dir, item.name), rel)
    else if (item.name !== 'manifest.json' && !known.has(rel)) warn(`${rel} is in the pack but not in the manifest`)
  }
}
walk(PACK_DIR)

// ---- 2. every legal stored colour has an authored display colour ----------------
// Derive the set from SHAPES so a future pool expansion fails here until the recipe follows it;
// never pin the gate to "18 forever". Decimal and 0x-prefixed JSON keys are both accepted by
// Number(), matching the runtime reader in rendering/floatingWorld.js.
const legalColours = [...new Set(SHAPES.map((shape) => shape.color))]
const paintMap = new Map(Object.entries(recipe.paintMapping ?? {}).map(([stored, shown]) => [Number(stored), String(shown).toUpperCase()]))
const missingPaint = legalColours.filter((color) => !paintMap.has(color))
if (missingPaint.length) {
  fail(`paintMapping misses ${missingPaint.length}/${legalColours.length} legal colour(s): ${missingPaint.map((color) => `0x${color.toString(16).padStart(6, '0')}`).join(', ')}`)
}
const requiredPolish = new Map([
  [0x2121d9, '#2F70E8'], [0xd62fd6, '#AF68D4'], [0x2fd64b, '#56B879'], [0xd13c2e, '#E66B63'],
])
for (const [stored, shown] of requiredPolish) {
  if (paintMap.get(stored) !== shown) fail(`paintMapping 0x${stored.toString(16)} is ${paintMap.get(stored) ?? 'missing'}, expected ${shown}`)
}

// ---- 3. what the source references, and whether it is there ---------------------
// Every `/art/floating-world-v1/...` string in index.html and src/**. A reference that does not
// resolve is the failure mode this tool was written for.
const SOURCE_EXTENSIONS = /\.(html|css|js)$/
const references = new Map()
function scan(file) {
  const text = readFileSync(file, 'utf8')
  // TWO forms, because the pack is reached two ways: the runtime URL (`/art/floating-world-v1/…`)
  // that CSS and `<img>` use, and the relative module path (`…/public/art/floating-world-v1/…`)
  // that the recipe import uses. Counting only the first would have reported a first screen of
  // zero bytes while the recipe — the largest thing the source actually pulls — went uncounted.
  for (const match of text.matchAll(/['"(]([^'"()\s]*(?:\/art\/floating-world-v1\/)[^'"()\s]+)['")]/g)) {
    const raw = match[1].split('?')[0]
    const url = raw.includes(RUNTIME_PREFIX)
      ? RUNTIME_PREFIX + raw.slice(raw.indexOf(RUNTIME_PREFIX) + RUNTIME_PREFIX.length)
      : RUNTIME_PREFIX + raw.slice(raw.indexOf('public/art/floating-world-v1/') + 'public/art/floating-world-v1/'.length)
    if (!references.has(url)) references.set(url, [])
    references.get(url).push(relative(ROOT, file).split(sep).join('/'))
  }
}
function scanTree(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === 'dist' || item.name.startsWith('.')) continue
    const full = join(dir, item.name)
    if (item.isDirectory()) scanTree(full)
    else if (SOURCE_EXTENSIONS.test(item.name)) scan(full)
  }
}
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.html')) scan(join(ROOT, entry.name))
}
scanTree(join(ROOT, 'src'))

let referencedBytes = 0
let referencedClouds = 0
let counted = 0
let referencedLogo = null
// A `<picture>` NAMES both members of its pair but the browser FETCHES one. Counting both would
// report a first screen the game never has — and, worse, would make the right implementation
// look like the wrong one. So the logo pair is counted as its LARGER member: still the worst
// case for the budget, without double-charging a fallback that is only fetched when WebP is
// unsupported.
const logoCandidates = []
for (const [url, from] of references) {
  const file = join(ROOT, 'public', url.replace(RUNTIME_PREFIX, `${join('art', 'floating-world-v1')}/`))
  if (!existsSync(file)) { fail(`${url} is referenced by ${from.join(', ')} but does not exist`); continue }
  if (EXCHANGE_ONLY.test(url)) continue
  const bytes = statSync(file).size
  if (/\/brand\/logo-/.test(url)) { logoCandidates.push({ url, bytes }); referencedLogo = url; continue }
  referencedBytes += bytes
  counted += 1
  if (/\/clouds\/cloud-[abc]\.png$/.test(url)) referencedClouds += 1
}
if (logoCandidates.length) {
  const largest = logoCandidates.reduce((a, b) => (b.bytes > a.bytes ? b : a))
  referencedBytes += largest.bytes
  counted += 1
  if (logoCandidates.length > 1) {
    console.log(`logo        ${logoCandidates.length} file(s) named (${logoCandidates.map((c) => c.url.split('/').pop()).join(', ')}); counting ${largest.url.split('/').pop()} as the fetched one`)
  }
}

// ---- 3. the first-screen budget (§10) ------------------------------------------
// Counted as "the references the source actually names": one logo, the UI the frame needs, the
// three cloud PNGs, the recipe. A skin that names all three logo files at once (instead of the
// `<picture>` the handoff asks for) shows up here as an over-budget first screen.
if (referencedBytes > FIRST_SCREEN_BUDGET) {
  fail(`referenced art is ${kib(referencedBytes)}, over the ${kib(FIRST_SCREEN_BUDGET)} first-screen budget`)
}
if (referencedClouds > 3) fail(`${referencedClouds} cloud PNGs are referenced; the pack ships three`)
if (referencedLogo && /logo-1024\.png$/.test(referencedLogo) && references.has(`${RUNTIME_PREFIX}brand/logo-1024.webp`)) {
  warn('both the WebP and the PNG logo are referenced — use <picture> so only one is fetched')
}

console.log(`paint map   ${legalColours.length - missingPaint.length}/${legalColours.length} legal stored colours mapped`)
console.log(`pack        ${manifest.files.length} files, ${kib(packedBytes)} (manifest totals agree with disk)`)
console.log(`roles       ${[...byRole].map(([role, n]) => `${role}:${n}`).join('  ')}`)
console.log(`references  ${counted} file(s) named by index.html/src, ${kib(referencedBytes)} counted for the first screen`)
console.log(`budget      ${kib(referencedBytes)} / ${kib(FIRST_SCREEN_BUDGET)} (GLB exchange backups excluded)`)
for (const message of warnings) console.warn(`WARN ${message}`)
if (failures.length) {
  for (const message of failures) console.error(`FAIL ${message}`)
  console.error(`\nfloating-world-assets: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('floating-world-assets: pack, references and first-screen budget all hold')

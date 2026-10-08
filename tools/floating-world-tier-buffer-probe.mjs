// VoxalBlast "floating block world" R7 buffer/tier evidence (art handoff section 7.3).
//
// Section 7.3 asks for "graphics contexts, draw calls, the ACTUAL BUFFER SIZE and physical-phone
// frame time", and the correction handoff repeats the same numbers: "high 3/3/6, medium 2/2/4,
// low 1/1/3, DPR caps 1.75 / 1.5 / 1". "Actual buffer size" is the one of those that is a pure
// measurement, and it is also the one that can be wrong silently: a cap that is only REPORTED
// (in `rendering().world.tierSpec.dprCap`) while `renderer.setPixelRatio` follows some other
// number is a handle that does nothing, and no screenshot can show it because the screenshot
// driver runs at devicePixelRatio 1 where every cap is a no-op.
//
// So this probe drives the REAL device pixel ratio: it emulates dsf 1 / 2 / 3 on each of the six
// viewports the handoff names, reloads (the tier is resolved once per load), and compares
// `canvas.width / canvas.clientWidth` - the ratio the drawing buffer ACTUALLY has - against
// `min(devicePixelRatio, tierSpec.dprCap)`.
//
//   node tools/floating-world-tier-buffer-probe.mjs [url] [--quick]
//
// `--quick` keeps one retina ratio (3) plus the dsf-1 control on every viewport; the full matrix
// adds dsf 2. Exit code 1 if any assertion fails. No threshold here is tuned to a run.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => p && existsSync(p))
if (!EDGE) throw new Error('no Edge/Chrome found')

// Flags are skipped when picking the URL: `npm run probe:buffer -- --quick` puts `--quick` in
// argv[2], and treating it as the target produced "Cannot navigate to invalid URL --quick/".
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const url = (positional[0] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const quick = process.argv.includes('--quick')
const outDir = resolve(ROOT, 'artifacts/visual-tier')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The six viewports of art handoff section 13.1 / correction section 9.2, in the same order.
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'desktop720', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small-mobile', width: 320, height: 740 },
  { name: 'landscape', width: 844, height: 390 },
  { name: 'widescreen', width: 2048, height: 900 },
]
const RATIOS = quick ? [1, 3] : [1, 2, 3]

let nextId = 100
function send(ws, method, params = {}) {
  const id = nextId++
  return new Promise((res, rej) => {
    const onMessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', onMessage)
      m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function connect(endpoint) {
  const ws = new WebSocket(endpoint)
  await new Promise((ok, no) => {
    ws.addEventListener('open', () => ok(), { once: true })
    ws.addEventListener('error', no, { once: true })
  })
  return ws
}
async function evaluate(ws, expression, awaitPromise = false) {
  const r = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  return r.result.value
}

// What the page says about itself, plus the DOM's own view of the drawing buffer. The ratio is
// computed from `canvas.width / canvas.clientWidth` rather than from `renderer.getPixelRatio()`
// on purpose: the buffer is what costs memory and fill rate, and it is also what a wrong style
// rule (a canvas scaled by CSS on top of the device ratio) would break while the renderer's own
// number stayed correct.
const READ = `(() => {
  const report = globalThis.__voxalblast.rendering()
  const canvas = document.getElementById('world-canvas')
  const all = [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height, hidden: c.offsetParent === null && c.getBoundingClientRect().width === 0 }))
  return JSON.stringify({
    dpr: window.devicePixelRatio,
    // The two inputs the tier selector actually reads (config.js getRenderQuality): the width
    // media query and the core count. Recording them is what makes the tier map explainable
    // instead of a table of magic results - a landscape phone is high only because its width
    // is over 700 AND its cores are over 4.
    narrowViewport: window.matchMedia('(max-width: 700px)').matches,
    cores: navigator.hardwareConcurrency ?? null,
    tier: report.world.tier,
    dprCap: report.world.tierSpec.dprCap,
    tierSpec: report.world.tierSpec,
    lowPower: report.lowPower,
    canvas: canvas ? { bufferW: canvas.width, bufferH: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight } : null,
    canvases: all.length,
    renderer: report.rendererInfo,
    programs: report.programs,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    projection: report.projection,
  })
})()`

const failures = []
const check = (ok, label, detail) => {
  if (!ok) failures.push(`${label}${detail ? ` - ${detail}` : ''}`)
  return ok
}

mkdirSync(outDir, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'voxalblast-tier-'))
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--run-all-compositor-stages-before-draw', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=900,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let port = null
for (let i = 0; i < 80 && !port; i += 1) {
  try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch { await sleep(250) }
}
const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const browserSocket = await connect(info.webSocketDebuggerUrl)
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = await connect(target.webSocketDebuggerUrl)
await send(ws, 'Page.enable')
await send(ws, 'Runtime.enable')

const rows = []
for (const viewport of VIEWPORTS) {
  for (const dsf of RATIOS) {
    await send(ws, 'Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height,
      screenWidth: viewport.width, screenHeight: viewport.height,
      deviceScaleFactor: dsf, mobile: viewport.width < 600,
    })
    // The tier is resolved once per load, so every combination needs its own navigation - a
    // resize would only re-size the buffer and keep the previous tier's cap.
    await send(ws, 'Page.navigate', { url: `${url}?buffer-probe=${viewport.name}x${dsf}` })
    await sleep(4600)
    const read = JSON.parse(await evaluate(ws, READ))
    const expectedRatio = Math.min(read.dpr, read.dprCap)
    const actualRatio = read.canvas.cssW > 0 ? read.canvas.bufferW / read.canvas.cssW : null
    const row = {
      viewport: viewport.name,
      css: `${viewport.width}x${viewport.height}`,
      dsfRequested: dsf,
      dpr: read.dpr,
      tier: read.tier,
      lowPower: read.lowPower,
      narrowViewport: read.narrowViewport,
      cores: read.cores,
      dprCap: read.dprCap,
      clusters: read.tierSpec.clusters,
      looseBlocks: read.tierSpec.looseBlocks,
      clouds: read.tierSpec.clouds,
      ssao: read.tierSpec.ssao,
      expectedRatio,
      actualRatio,
      capBites: read.dpr > read.dprCap,
      buffer: read.canvas ? [read.canvas.bufferW, read.canvas.bufferH] : null,
      css_: read.canvas ? [read.canvas.cssW, read.canvas.cssH] : null,
      canvases: read.canvases,
      calls: read.renderer.calls,
      triangles: read.renderer.triangles,
      textures: read.renderer.textures,
      programs: read.programs,
      projectionErrorPx: read.projection ? read.projection.worstPx : null,
    }
    const tag = `${viewport.name}@${dsf}x`
    // E1: the cap the report NAMES is the cap the buffer HAS. This is the assertion that fails if
    // `dprCap` ever goes back to being decoration.
    check(actualRatio !== null && Math.abs(actualRatio - expectedRatio) < 1e-6,
      `E1 ${tag} buffer ratio ${actualRatio} != min(dpr ${read.dpr}, cap ${read.dprCap}) = ${expectedRatio}`)
    // E2: the buffer is the CSS size times the ratio - no double scaling from a style rule.
    // `Math.floor`, not `Math.round`: three's `WebGLRenderer.setSize` floors the backing store, and
    // at ratio 1.75 that is visible (390px * 1.75 = 682.5 -> 682, measured on landscape@3x).
    check(read.canvas && read.canvas.bufferW === Math.floor(read.canvas.cssW * expectedRatio) && read.canvas.bufferH === Math.floor(read.canvas.cssH * expectedRatio),
      `E2 ${tag} buffer ${row.buffer} is not css ${row.css_} x ${expectedRatio} (floored)`)
    // E3: at dsf 2/3 the emulated device ratio really is above the cap, so E1 is not vacuous.
    check(dsf === 1 ? read.dpr === 1 : read.dpr > read.dprCap,
      `E3 ${tag} devicePixelRatio ${read.dpr} does not exceed the cap ${read.dprCap} (the case is vacuous)`)
    // E4: exactly four WebGL canvases - the board, the three candidates and the world. A ninth
    // context would hit the browser's per-page limit and silently kill the oldest context.
    check(read.canvases === 4, `E4 ${tag} expected 4 canvases, found ${read.canvases}`)
    check(read.projection && read.projection.worstPx < 1, `E5 ${tag} projection error ${read.projection?.worstPx}px`, ) 
    rows.push(row)
    console.log(`  ${tag.padEnd(18)} dpr=${String(read.dpr).padEnd(4)} cap=${String(read.dprCap).padEnd(5)} ratio=${String(actualRatio).padEnd(5)} tier=${String(read.tier).padEnd(5)} buffer=${row.buffer?.join('x')}  calls=${row.calls} tris=${row.triangles} tex=${row.textures} prog=${row.programs}`)
  }
}

// E6: the tier is a property of the VIEWPORT, not of the device pixel ratio. If a retina phone
// picked a different tier than a plain one, the decoration budget and the cap would disagree
// between two devices of the same class.
for (const viewport of VIEWPORTS) {
  const tiers = new Set(rows.filter((r) => r.viewport === viewport.name).map((r) => r.tier))
  const caps = new Set(rows.filter((r) => r.viewport === viewport.name).map((r) => r.dprCap))
  check(tiers.size === 1 && caps.size === 1, `E6 ${viewport.name} tier/cap depend on the device pixel ratio`, `tiers=${[...tiers]} caps=${[...caps]}`)
}

const report = {
  version, url, quick,
  // Which scene the counters were read on. The boot state is the HOME COVER: the world renders
  // behind it and the board is hidden, so these draw-call/triangle totals are NOT the in-game
  // totals recorded in FLOATING_WORLD_R7_PERF.md - the buffer sizes and ratios are what this
  // probe owns, and those are state independent.
  state: 'home-cover (boot)',
  viewports: VIEWPORTS, ratios: RATIOS,
  // Section 7.3's tier table, as MEASURED: which viewport landed on which tier and what the
  // budget for that tier is. The deviation (every phone is `low`, because the project's tier
  // selector is width-based) is a producer decision recorded in KNOWN_GAPS section 1; this probe
  // reports what happens rather than judging it.
  rows,
  failures,
}
const jsonPath = join(outDir, `tier-buffer-${version}.json`)
writeFileSync(jsonPath, JSON.stringify(report, null, 1))
console.log(`floating-world tier/buffer probe  v${version}  ${quick ? 'quick' : 'full'}  ${rows.length} combinations`)
const perViewport = VIEWPORTS.map((v) => {
  const r = rows.find((x) => x.viewport === v.name)
  return `${v.name}=${r.tier}(cap ${r.dprCap}, ${r.clusters}/${r.looseBlocks}/${r.clouds}, ssao ${r.ssao ? 'on' : 'off'})`
})
console.log(`tiers  ${perViewport.join('  ')}`)
console.log(`caps bite at dsf>cap: ${rows.filter((r) => r.capBites).length} of ${rows.length} combinations`)
console.log(`json   ${jsonPath}`)
console.log(failures.length ? `FAIL ${failures.length}:\n  - ${failures.join('\n  - ')}` : 'all tier/buffer assertions passed')

await send(browserSocket, 'Browser.close').catch(() => {})
await sleep(1000)
try { rmSync(profile, { recursive: true, force: true, maxRetries: 8 }) } catch {}
process.exit(failures.length ? 1 : 0)

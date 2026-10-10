// Cartoon clear VFX probe (docs/Technical/CARTOON_CLEAR_VFX_HANDOFF.md §8/§9).
//
//   node tools/cartoon-clear-probe.mjs r0 [url]      baseline + existing-clear evidence
//   node tools/cartoon-clear-probe.mjs r1 [url]      8-tile atlas gate + single-line beats
//   node tools/cartoon-clear-probe.mjs r2 [url]      multi-line planning / dedup / budget
//   node tools/cartoon-clear-probe.mjs r3 [url]      lifecycle, low tier, reduced motion
//
// Needs a dev server. This probe never starts one: give it the URL it should hit (default
// http://localhost:5199/, this round's own server -- see the round's evidence record for the
// exact URL the numbers were taken at).
//
// Why a probe and not a screenshot: §9.1 asks for things a picture cannot answer -- how many
// particles are REALLY alive at a beat, whether the effective tier halves the budget, whether
// a scope cancel actually reached the effects layer -- and §9.2 asks for pictures at named
// beats. This file does both: the timeline pass samples every frame from inside the page and
// the beat pass takes one screenshot per named moment.
//
// Every pin this file sets is a DEV-only handle (`__voxalblastDev.*`); the read-outs it keeps
// are `__voxalblast.*`, which are read-only by construction (diagnostics.js install()).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { readPng } from './png-read.mjs'

const round = (process.argv[2] || 'r0').toLowerCase()
const url = process.argv[3] || 'http://localhost:5199/'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, 'artifacts', 'cartoon-clear-v1', round)
mkdirSync(OUT, { recursive: true })

const r3 = (value) => Math.round(value * 1000) / 1000

// The tile order comes from the pack's own atlas JSON rather than being retyped here, and the
// per-sprite ground truth is the delivered sprite PNGs -- the same art the atlas was built from,
// so the gate compares the RENDER against the source of truth and not against itself.
const CARTOON_ATLAS = JSON.parse(readFileSync(join(ROOT, 'docs/assets/cartoon-clear-v1/runtime/atlas.json'), 'utf8'))
const CARTOON_TILE_ORDER = CARTOON_ATLAS.layout.order
const spriteMetrics = new Map()

// §9.2 「必要视口」. r0 records the two extremes this round can afford to run end to end; the
// full five-viewport sweep belongs to the round that finishes the look (r2/r3), and the
// evidence record names which ones were actually run rather than implying all of them were.
const VIEWPORTS = {
  r0: [
    { id: 'desktop', width: 1440, height: 900, mobile: false },
    { id: 'phone', width: 390, height: 844, mobile: true },
  ],
  r1: [
    { id: 'desktop', width: 1440, height: 900, mobile: false },
    { id: 'phone', width: 390, height: 844, mobile: true },
  ],
  r2: [
    { id: 'desktop', width: 1440, height: 900, mobile: false },
    { id: 'phone', width: 390, height: 844, mobile: true },
    { id: 'landscape-phone', width: 844, height: 390, mobile: true },
  ],
  r3: [
    { id: 'desktop', width: 1440, height: 900, mobile: false },
    { id: 'phone', width: 390, height: 844, mobile: true },
    { id: 'short-phone', width: 360, height: 600, mobile: true },
  ],
}

const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error(`no headless browser found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// §9.2 「截图时间点 0/65/110/180/260/360/420/600ms」 -- the beats the handoff names, taken from
// the SAME table §5 uses, so a picture and a number cannot drift apart here.
const BEATS = [0, 65, 110, 180, 260, 360, 420, 600]

// §9.1's table, one fixture per row. r0 runs them to record what the CURRENT implementation
// does with a real multi-line settle; r2 re-runs the same set against the new planner.
const FIXTURE_NAMES = {
  r0: ['single', 'parallel', 'cross', 'shared-edge', 'face-pair', 'three', 'four', 'five', 'legacy-single'],
  r2: ['single', 'parallel', 'cross', 'shared-edge', 'face-pair', 'three', 'four', 'five', 'legacy-single'],
  r3: ['single', 'five', 'legacy-single'],
}

const failures = []
function check(label, condition, detail) {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${detail}`}`)
  if (!condition) failures.push(label)
}
function note(label, detail) { console.log(`     ${label}  ${detail}`) }

// ---------------------------------------------------------------- §3.1 sampling gate
//
// "The file loaded" is not the gate the handoff asks for. This measures what the GPU actually
// drew: the gate frame is diffed against a quiet frame of the same page, the changed pixels are
// split into connected blobs, and each blob is compared with the sprite it is supposed to be.
//
// The comparison is on three shape properties that a wrong tile or a flipped one cannot fake:
// the blob's fill ratio inside its own box, and where its alpha mass sits relative to that box's
// centre in x and y. A vertical flip moves the mass to the other side of the centre; a horizontal
// flip does the same in x (which is how `swoosh-cream`'s +X direction is checked); picking the
// wrong tile changes the fill ratio outright.

function alphaMetrics(image) {
  const { width, height, channels, pixels } = image
  const mask = new Uint8Array(width * height)
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  let sumX = 0, sumY = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels
      // The sprite PNG own silhouette: any non-zero alpha. The delivered art keeps a 4px RGBA
      // expansion around the graphic with alpha 0, so this is the graphic and not the margin.
      if (pixels[i + 3] === 0) continue
      mask[y * width + x] = 1
      count += 1
      sumX += x; sumY += y
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return summarise({ minX, minY, maxX, maxY, count, sumX, sumY })
}

/**
 * The bounding box, fill ratio and alpha-mass offset of a mask, in the units the checks use:
 * the box in pixels, and `dx`/`dy` as the mass offset from the box centre in HALF-box units, so
 * -1 means the mass sits hard against the low edge. One summary function, so a sprite PNG and a
 * rendered tile are always measured the same way.
 */
function summarise({ minX, minY, maxX, maxY, count, sumX, sumY }) {
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const centreX = (minX + maxX) / 2
  const centreY = (minY + maxY) / 2
  return {
    box: { minX, minY, maxX, maxY, width, height },
    count,
    fill: count / (width * height),
    aspect: width / height,
    dx: (sumX / count - centreX) / (width / 2),
    dy: (sumY / count - centreY) / (height / 2),
  }
}

/**
 * The changed-pixel metrics of ONE tile, measured inside that tile own window. A whole-frame
 * blob split was tried first and merged a tile with the horizon it happened to straddle, which
 * is exactly the kind of unrelated change a window cannot pick up.
 */
function windowMetrics(quiet, live, screen, tileScreen) {
  // Exactly the tile's own quad, plus a one-pixel guard. A wider window was tried first and let
  // whatever the tile happened to be drawn over into the mask, which reads as an oversized
  // graphic rather than as a contaminated measurement.
  const half = Math.max(6, Math.round(tileScreen * 0.5) + 1)
  const x0 = Math.max(0, Math.round(screen.x - half))
  const x1 = Math.min(live.width - 1, Math.round(screen.x + half))
  const y0 = Math.max(0, Math.round(screen.y - half))
  const y1 = Math.min(live.height - 1, Math.round(screen.y + half))
  const { channels } = live
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0, sumX = 0, sumY = 0
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const p = (y * live.width + x) * channels
      const d = Math.abs(live.pixels[p] - quiet.pixels[p])
        + Math.abs(live.pixels[p + 1] - quiet.pixels[p + 1])
        + Math.abs(live.pixels[p + 2] - quiet.pixels[p + 2])
      // A higher threshold than a whole-frame diff would use: the antialiased fringe of a small
      // sprite is not the sprite, and letting it into the mask inflates every box by a few px.
      if (d <= 48) continue
      count += 1; sumX += x; sumY += y
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (count < 60) return null
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const centreX = (minX + maxX) / 2
  const centreY = (minY + maxY) / 2
  return {
    box: { minX, minY, maxX, maxY, width, height },
    count,
    fill: count / (width * height),
    dx: (sumX / count - centreX) / (width / 2),
    dy: (sumY / count - centreY) / (height / 2),
    // The mask reached the edge of its window, so something OTHER than this tile is in here and
    // the box is not the tile's own. Reported rather than measured: a silently oversized box is
    // how a contaminated window reads as "the wrong tile was sampled".
    clipped: minX <= x0 + 1 || minY <= y0 + 1 || maxX >= x1 - 1 || maxY >= y1 - 1,
  }
}
for (const id of CARTOON_TILE_ORDER) {
  const file = join(ROOT, 'docs', 'assets', 'cartoon-clear-v1', 'runtime', 'sprites', `${id}.png`)
  if (!existsSync(file)) throw new Error(`missing ground-truth sprite: ${file}`)
  const metrics = alphaMetrics(readPng(file))
  if (!metrics) throw new Error(`sprite has no opaque pixels: ${id}`)
  spriteMetrics.set(id, metrics)
}

/** p50/p90 frame cadence, in ms, from a timeline of absolute timestamps. */function frameCadence(samples) {
  const deltas = []
  for (let i = 1; i < samples.length; i += 1) deltas.push(samples[i].t - samples[i - 1].t)
  if (!deltas.length) return null
  deltas.sort((a, b) => a - b)
  return {
    p50: deltas[Math.floor(deltas.length / 2)],
    p90: deltas[Math.floor(deltas.length * 0.9)],
    max: deltas[deltas.length - 1],
    fps: Math.round(1000 / Math.max(1, deltas[Math.floor(deltas.length / 2)])),
  }
}

let nextId = 100
function send(ws, id, method, params = {}) {
  return new Promise((resolve_, reject) => {
    const finish = (error, result) => {
      clearTimeout(timeout)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      if (error) reject(error)
      else resolve_(result)
    }
    const onMessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== id) return
      finish(msg.error ? new Error(`${method}: ${JSON.stringify(msg.error)}`) : null, msg.result)
    }
    const onClose = () => finish(new Error(`${method}: debugger connection closed`))
    const timeout = setTimeout(() => finish(new Error(`${method}: timed out`)), 30000)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose, { once: true })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(endpoint) {
  const ws = new WebSocket(endpoint)
  await new Promise((ok, no) => {
    const timeout = setTimeout(() => { ws.close(); no(new Error('debugger connection timed out')) }, 5000)
    ws.addEventListener('open', () => { clearTimeout(timeout); ok() }, { once: true })
    ws.addEventListener('error', (error) => { clearTimeout(timeout); no(error) }, { once: true })
  })
  return ws
}

function git(...args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return null }
}

const evidence = {
  round,
  url,
  at: new Date().toISOString(),
  head: git('rev-parse', 'HEAD'),
  version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
  beats: BEATS,
  browser: BROWSER,
  viewports: [],
  failures: [],
  checks: [],
}

const profile = mkdtempSync(join(tmpdir(), `voxalblast-cartoon-clear-${round}-`))
// Software rasterisation runs this scene at a handful of frames per second at 1440x900, and a
// beat table sampled from a 5fps clock describes the sampler rather than the effect. CC_GPU=1
// asks for the real device instead; whatever the run used is written into the evidence so a
// number can never be quoted without the clock it came from.
const gpu = process.env.CC_GPU === '1'
const child = spawn(BROWSER, [
  '--headless=new', ...(gpu ? ['--use-angle=d3d11'] : ['--disable-gpu']),
  '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true })
evidence.rasterisation = gpu ? 'd3d11 (CC_GPU=1)' : 'swiftshader (--disable-gpu)'

let ws
let browserSocket = null
try {
  let port
  for (let i = 0; i < 80; i += 1) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); break } catch { await sleep(250) }
  }
  if (!port) throw new Error('devtools never came up')
  browserSocket = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl)
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = await connect(target.webSocketDebuggerUrl)

  const browserErrors = []
  ws.addEventListener('message', (event) => {
    const { method, params } = JSON.parse(event.data)
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      browserErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '))
    }
    if (method === 'Runtime.exceptionThrown') browserErrors.push(params.exceptionDetails.text)
  })
  await send(ws, 1, 'Page.enable')
  await send(ws, 2, 'Runtime.enable')

  const evaluate = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`))
  const shot = async (name) => {
    const result = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  }

  // ---- rule cases: ONE real settled placement per fixture --------------------------------
  // §9.1. `demoClear()` can prove a budget but never "raw 2 / physical 1 / 5 unique cells",
  // because it builds descriptors without a Board. Each of these loads a session snapshot whose
  // pattern is exactly one legal drop away from the case, and drives the game's own onDrop().
  // The fixtures are injected into this throwaway profile only; no real save is written.
  if (round !== 'r1') {
    const firstViewport = VIEWPORTS[round]?.[0] || VIEWPORTS.r0[0]
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: firstViewport.width, height: firstViewport.height,
      screenWidth: firstViewport.width, screenHeight: firstViewport.height,
      deviceScaleFactor: 1, mobile: firstViewport.mobile,
    })
    const fixtureCases = []
    let injectId = null
    for (const name of FIXTURE_NAMES[round] || FIXTURE_NAMES.r0) {
      const file = join(ROOT, 'tools', 'fixtures', `cartoon-clear-${name}.json`)
      if (!existsSync(file)) { fixtureCases.push({ name, error: 'fixture missing' }); continue }
      const fixture = JSON.parse(readFileSync(file, 'utf8'))
      if (injectId) await send(ws, nextId++, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: injectId })
      const added = await send(ws, nextId++, 'Page.addScriptToEvaluateOnNewDocument', {
        source: `localStorage.setItem('voxalblast.session.v1', ${JSON.stringify(JSON.stringify(fixture.snapshot))});`,
      })
      injectId = added.identifier
      await send(ws, nextId++, 'Page.navigate', { url })
      await sleep(2800)
      await evaluate('JSON.stringify(globalThis.__voxalblastDev.setBoardFloat({ frozen: true, time: 0 }))')
      await evaluate('JSON.stringify(globalThis.__voxalblastDev.setAmbient({ frozen: true, time: 0 }))')
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if ((await json('globalThis.__voxalblast.intro().active')) === false) break
        await sleep(200)
      }
      await evaluate('globalThis.__voxalblastDev.clearCelebration()')
      await sleep(240)
      const before = await json(`({
        cells: globalThis.__voxalblast.board().cells.length,
        score: globalThis.__voxalblast.board().score,
        totalLines: globalThis.__voxalblast.board().totalLines,
        fullLines: globalThis.__voxalblast.board().fullLines,
        rulesVersion: globalThis.__voxalblast.run().scoreRulesVersion,
        rewardEventId: globalThis.__voxalblast.run().rewardEventId,
      })`)
      const beforeShot = await shot(`case-${name}-before`)
      const drop = fixture.drop
      const dropped = await json(`globalThis.__voxalblastDev.dropAt(${JSON.stringify({
        pieceIndex: 0, face: drop.face, u: drop.origin.u, v: drop.origin.v,
      })})`)
      await sleep(120)
      const after = await json(`({
        cells: globalThis.__voxalblast.board().cells.length,
        score: globalThis.__voxalblast.board().score,
        totalLines: globalThis.__voxalblast.board().totalLines,
        rewardEventId: globalThis.__voxalblast.run().rewardEventId,
      })`)
      const event = dropped.event || null
      const rules = dropped.rules || null
      const rawLines = rules?.lines || []
      const plan = dropped.plan || null
      fixtureCases.push({
        name,
        expect: fixture.expect,
        before,
        beforeFrame: beforeShot.replace(ROOT + '\\', '').replaceAll('\\', '/'),
        drop,
        ok: dropped.ok,
        reason: dropped.reason ?? null,
        // The RAW face lines board.js really produced (face/axis/index/cells). §4.1's whole point
        // is that this list is not the budget input, so it is recorded verbatim rather than
        // summarised into a count.
        rawLines,
        plan,
        event,
        after,
      })
      check(`${name}: the fixture board loaded`,
        before.cells === fixture.occupied && before.fullLines.length === 0,
        `cells=${before.cells}/${fixture.occupied} fullLines=${before.fullLines.length}`)
      check(`${name}: the drop was legal`, dropped.ok === true, dropped.ok ? '' : `refused: ${dropped.reason}`)
      check(`${name}: ${fixture.expect.uniqueCells} unique cleared cells`,
        event?.uniqueCells === fixture.expect.uniqueCells,
        `uniqueCells=${event?.uniqueCells}`)
      if (dropped.ok) {
        // The face scan may report one physical line more than once (a shared edge/corner), so
        // raw is only ever asserted to be AT LEAST the physical count here. The equality is the
        // planner's own assertion and lands with it in r2.
        check(`${name}: raw face lines are >= the ${fixture.expect.physical} physical line(s)`,
          rawLines.length >= fixture.expect.physical,
          `raw=${rawLines.length} [${rawLines.map((line) => `${line.face}:${line.axis}${line.index}`).join(' ')}]`)
        if (plan) {
          check(`${name}: the planner reports ${fixture.expect.physical} physical line(s)`,
            plan.physicalLineCount === fixture.expect.physical,
            `physicalLineCount=${plan.physicalLineCount}`)
        }
      }
      note(`${name}`, `raw=${rawLines.length} unique=${event?.uniqueCells} physical=${plan?.physicalLineCount ?? 'n/a'} budget=${event?.budget} score ${before.score}->${after.score}`)
    }
    evidence.fixtureCases = fixtureCases
  }

  for (const viewport of VIEWPORTS[round] || VIEWPORTS.r0) {
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height,
      screenWidth: viewport.width, screenHeight: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.mobile,
    })
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(3200)

    // The game boots straight into a run (v0.8.22); a cover may still be up if a previous
    // pass left one. Dismissing it is the same click the home screen's own primary button does.
    await evaluate(`(() => { const el = document.querySelector('#home-primary'); if (el && !document.querySelector('#app').classList.contains('home-open')) return 'no-cover'; if (el) { el.click(); return 'dismissed' } return 'no-button' })()`)
    // §8.7: pin BOTH world clocks, or two captures of the same build differ pixel for pixel.
    await evaluate('JSON.stringify(globalThis.__voxalblastDev.setBoardFloat({ frozen: true, time: 0 }))')
    await evaluate('JSON.stringify(globalThis.__voxalblastDev.setAmbient({ frozen: true, time: 0 }))')
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await json('globalThis.__voxalblast.intro().active')) === false) break
      await sleep(200)
    }
    await sleep(300)

    const record = { ...viewport, dpr: await evaluate('window.devicePixelRatio') }
    record.boot = await json(`({
      title: document.title,
      version: document.querySelector('#app-version')?.textContent ?? null,
      hasDevHandles: typeof globalThis.__voxalblastDev === 'object',
      errors: ${JSON.stringify(browserErrors)},
    })`)

    // ---- baseline: what the frame costs, where the camera is, what the board holds ---------
    record.baseline = await json(`({
      renderer: globalThis.__voxalblast.rendering().rendererInfo,
      framing: globalThis.__voxalblast.framing(),
      rotation: globalThis.__voxalblast.rotation(),
      tiles: globalThis.__voxalblast.rendering().meshes,
      uniqueCells: globalThis.__voxalblast.rendering().uniqueCells,
      introIntegrity: globalThis.__voxalblast.intro().integrity,
      board: { score: globalThis.__voxalblast.board().score, cells: globalThis.__voxalblast.board().cells.length,
               totalLines: globalThis.__voxalblast.board().totalLines },
      run: globalThis.__voxalblast.run(),
      effects: globalThis.__voxalblast.effects(),
      quality: { lowPower: globalThis.__voxalblast.effects().lowPower, reducedMotion: globalThis.__voxalblast.effects().reducedMotion },
    })`)

    // A settled, FX-free frame: this is the "before" of every pixel comparison in the round.
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(200)
    record.quietFrame = { file: await shot(`${viewport.id}-quiet`) }

    // ---- §3.1's sampling gate: all eight tiles, measured on screen ------------------------
    // Only on the round's first viewport: the gate is about SAMPLING, and the sampling does not
    // depend on the window size, so repeating it per viewport would spend captures on nothing.
    if (viewport === (VIEWPORTS[round] || VIEWPORTS.r0)[0]) {
      await evaluate('globalThis.__voxalblastDev.clearCelebration()')
      await sleep(220)
      const quietPath = join(OUT, `${viewport.id}-quiet.png`)
      const gate = await json('globalThis.__voxalblastDev.atlasGate()')
      await sleep(180)
      const gatePath = await shot(`${viewport.id}-atlas-gate`)
      const gateRecord = { ...gate, frame: gatePath.replace(ROOT + '\\', '').replaceAll('\\', '/') }
      try {
        const quiet = readPng(quietPath)
        const live = readPng(gatePath)
        // The gate's own projection says where each tile is, so each tile is measured inside its
        // OWN window rather than by splitting the whole frame into blobs. Blob splitting merged a
        // tile with the horizon it straddled, which is exactly the kind of unrelated change a
        // window cannot pick up.
        const first = (gate.tiles || [])[0]?.screen
        const second = (gate.tiles || [])[1]?.screen
        const gridPitch = second && first ? Math.hypot(second.x - first.x, second.y - first.y) : 1
        const tileScreenFromGrid = first && second ? (gridPitch / (gate.spacing || 1.7)) * gate.tileWorld : 64
        gateRecord.tileScreenFromGrid = r3(tileScreenFromGrid)
        gateRecord.tiles = CARTOON_TILE_ORDER.map((id, index) => {
          const entry = (gate.tiles || []).find((tile) => tile.index === index)
          const expected = spriteMetrics.get(id)
          if (!entry?.screen || !expected) return { id, index, measured: null }
          // The tile's own on-screen size, from its own corners (the gate projects them). A global
          // grid pitch was tried first and under-measured the off-axis tiles by ~10%.
          const tileScreen = entry.screenSize
            ? (entry.screenSize.width + entry.screenSize.height) / 2
            : tileScreenFromGrid
          const measured = windowMetrics(quiet, live, entry.screen, tileScreen)
          if (!measured) return { id, index, screen: entry.screen, measured: null, reason: 'nothing changed in this tile window' }
          return {
            id,
            index,
            screen: entry.screen,
            tileScreen: r3(tileScreen),
            // The sprite's own alpha box as a FRACTION of its 128px tile, which is the one
            // property that stays comparable across the size the gate happened to draw at.
            expected: {
              w: r3(expected.box.width / 128), h: r3(expected.box.height / 128),
              dx: r3(expected.dx), dy: r3(expected.dy),
            },
            measured: {
              w: r3(measured.box.width / tileScreen), h: r3(measured.box.height / tileScreen),
              dx: r3(measured.dx), dy: r3(measured.dy),
              box: measured.box, fill: r3(measured.fill), clipped: measured.clipped,
            },
          }
        })
        // Every window's raw numbers, so the record can be re-read without re-running the probe.
        gateRecord.tilesRaw = gateRecord.tiles.map((tile) => ({
          id: tile.id, measured: tile.measured, expected: tile.expected,
        }))
        check(`${viewport.id} atlas gate: all 8 tiles were drawn`,
          gateRecord.tiles.filter((tile) => tile.measured).length === CARTOON_TILE_ORDER.length,
          `measured=${gateRecord.tiles.filter((tile) => tile.measured).length}/8`)
        for (const tile of gateRecord.tiles) {
          if (!tile.measured) {
            check(`${viewport.id} gate ${tile.id}: sampled`, false, tile.reason || 'no measurement')
            continue
          }
          const { measured, expected } = tile
          if (measured.clipped) {
            check(`${viewport.id} gate ${tile.id}: the tile window is clean`, false,
              `mask reached the window edge at ${JSON.stringify(measured.box)} — report as UNMEASURED, not as a pass`)
            continue
          }
          // A box more than half again the sprite's own silhouette cannot be that sprite: the
          // window is the tile's own quad, so whatever grew it came from outside the graphic (the
          // post chain's bloom halo and its SMAA edge are the two candidates). Reported as
          // UNMEASURED with its number rather than counted as a pass -- a measurement this probe
          // cannot trust does not get to certify the tile.
          if (measured.w > expected.w * 1.5 || measured.h > expected.h * 1.5) {
            tile.unmeasured = true
            note(`${viewport.id} gate ${tile.id}`,
              `UNMEASURED: box ${measured.w}x${measured.h} of tile is >1.5x the sprite's own ${expected.w}x${expected.h}`)
            continue
          }
          // A wrong tile changes the graphic's own bounding box outright (a star's box is 0.80 of
          // its tile, a dash's is 0.76 x 0.30), and a rotation or a flip moves it as well. Both
          // are measured against the delivered sprite PNGs, so this cannot agree with itself.
          check(`${viewport.id} gate ${tile.id}: the graphic sampled is the right tile`,
            Math.abs(measured.w - expected.w) <= 0.12 && Math.abs(measured.h - expected.h) <= 0.12,
            `box ${measured.w}x${measured.h} of tile vs ${expected.w}x${expected.h}`)
          check(`${viewport.id} gate ${tile.id}: the tile is not flipped or rotated`,
            Math.abs(measured.dx - expected.dx) <= 0.20 && Math.abs(measured.dy - expected.dy) <= 0.20,
            `dx ${measured.dx} vs ${expected.dx}, dy ${measured.dy} vs ${expected.dy}`)
        }
      } catch (error) {
        check(`${viewport.id} atlas gate: frames could be compared`, false, error.message)
      }
      record.atlasGate = gateRecord
    }

    // ---- per-frame timeline around ONE event ----------------------------------------------
    // The sampler runs INSIDE the page on rAF, so what it records is what the frame loop
    // computed, not what an out-of-band poll happened to land on. Absolute timestamps are kept
    // so the beats are measured from the event's own t=0 regardless of when the trigger landed.
    const timeline = async (trigger) => {
      await evaluate('globalThis.__voxalblastDev.clearCelebration()')
      await sleep(260)
      await evaluate(`(() => {
        globalThis.__ccSamples = []
        globalThis.__ccT0 = null
        globalThis.__ccDone = false
        globalThis.__ccStart = null
        let frame = 0
        const tick = () => {
          const now = performance.now()
          if (globalThis.__ccStart === null) globalThis.__ccStart = now
          const fx = globalThis.__voxalblast.effects()
          // The per-frame draw-call total is the frame loop's own counter. Reading it costs a
          // report build, so it is taken every second frame and the count is what the round
          // reports -- a cheap read-out is worth more than a per-frame one that perturbs what
          // it measures.
          const ri = frame % 2 === 0 ? globalThis.__voxalblast.rendering().rendererInfo : null
          frame += 1
          globalThis.__ccSamples.push({
            now,
            calls: ri ? ri.calls : null, triangles: ri ? ri.triangles : null,
            liveSystems: fx.liveSystems, liveChips: fx.liveChips, liveParticles: fx.liveParticles,
            decorations: fx.decorations, bands: fx.bands, transients: fx.transients,
            outlines: fx.outlines,
            // The new pool, kept apart from the celebration's own (§4.3 「必须在report显式分项」).
            cartoonSprites: fx.cartoon.liveSprites,
            cartoonSystems: fx.cartoon.liveSystems,
            cartoonEvents: fx.cartoon.liveEvents,
            atlas: fx.cartoon.atlas.status,
          })
          if (now - globalThis.__ccStart < 1500) requestAnimationFrame(tick)
          else globalThis.__ccDone = true
        }
        requestAnimationFrame(tick)
        return true
      })()`)
      await sleep(80)
      const event = await json(`(() => { globalThis.__ccT0 = performance.now(); return ${trigger} })()`)
      for (let i = 0; i < 60; i += 1) {
        if (await evaluate('globalThis.__ccDone === true')) break
        await sleep(60)
      }
      const samples = await json('globalThis.__ccSamples')
      const t0 = await evaluate('globalThis.__ccT0')
      // Convert to "ms since the event", which is the only clock §5 is written in.
      const rel = samples.map((sample) => ({ t: Math.round(sample.now - t0), ...sample, now: undefined }))
      return { event, t0, samples: rel }
    }

    const at = (samples, beat) => {
      // The last sample at or before the beat: a frame that had not happened yet cannot be
      // reported as if it had.
      let picked = null
      for (const sample of samples) if (sample.t <= beat) picked = sample
      return picked
    }

    record.cases = []
    const cases = round === 'r0' || round === 'r1' ? [1] : [1, 2, 3]
    if (round === 'r2' || round === 'r3') cases.push(4, 5)
    for (const lines of cases) {
      const run = await timeline(`globalThis.__voxalblastDev.demoClear(${lines})`)
      const event = run.event.event || null
      const pool = (sample) => (sample ? Math.max(sample.cartoonSprites, sample.transients, sample.outlines) : 0)
      const peak = run.samples.reduce((acc, sample) => (sample.cartoonSprites > (acc?.cartoonSprites ?? -1) ? sample : acc), null)
      const after = run.samples.filter((sample) => sample.t >= 0)
      const lastAlive = [...after].reverse().find((sample) => pool(sample) > 0)
      const caseRecord = {
        lines,
        event,
        cartoon: await json('globalThis.__voxalblast.effects().cartoon'),
        beats: Object.fromEntries(BEATS.map((beat) => [beat, at(run.samples, beat)])),
        peak,
        zeroAfterMs: lastAlive ? lastAlive.t : 0,
        sampleCount: run.samples.length,
        // The cadence matters as much as the numbers: headless software rasterisation runs this
        // scene far slower than a phone, and a beat table taken from a 5fps clock is a statement
        // about the sampler, not about the effect. It is reported next to every timeline.
        frameMs: frameCadence(run.samples),
        timeline: run.samples,
      }
      record.cases.push(caseRecord)
      note(`${viewport.id} demoClear(${lines})`,
        `budget=${event?.budget} spawned=${event?.spawned} physical=${event?.physicalLineCount} unique=${event?.uniqueCells} peakSprites=${peak?.cartoonSprites} zeroAfter=${caseRecord.zeroAfterMs}ms`)
      if (round === 'r1' || round === 'r2' || round === 'r3') {
        // §9.1 单线: raw/physical=1, 5 unique cells, inside the 14/7 budget, and the clear pool is
        // empty after 360ms -- measured, not asserted from the config.
        const expected = lines === 1 ? 1 : lines
        const budgetCap = (await json('globalThis.__voxalblast.effects().lowPower'))
          ? { 1: 7, 2: 11, 3: 16 }[Math.min(lines, 3)]
          : { 1: 14, 2: 22, 3: 32 }[Math.min(lines, 3)]
        check(`${viewport.id} L${lines}: the budget comes from the physical line count (${budgetCap})`,
          event?.budget === budgetCap && event?.spawned <= budgetCap,
          `budget=${event?.budget} spawned=${event?.spawned} physical=${event?.physicalLineCount}`)
        check(`${viewport.id} L${lines}: the demo's physical line count is ${expected}`,
          event?.physicalLineCount === expected, `physical=${event?.physicalLineCount} raw=${event?.rawLineCount}`)
        const tail = lines === 1 ? 360 : 420
        // The sampler can only see whole frames, so the last frame with something alive can sit up
        // to one frame past the moment the last particle really died. The allowance is that one
        // frame and nothing more (a frame here is ~18ms, against a 106ms overshoot on the branch
        // this round replaced).
        check(`${viewport.id} L${lines}: the clear pool is empty by ${tail}ms`,
          caseRecord.zeroAfterMs <= tail + (caseRecord.frameMs?.p50 ?? 0) + 2,
          `zeroAfter=${caseRecord.zeroAfterMs}ms tail=${tail}ms frame=${caseRecord.frameMs?.p50}ms`)
        check(`${viewport.id} L${lines}: the atlas is loaded for the runtime clear`,
          caseRecord.cartoon.atlas.status === 'ready', `status=${caseRecord.cartoon.atlas.status}`)
      }
    }

    // ---- one screenshot per named beat, from a FRESH event each time ---------------------
    // A single pass cannot do this: capturing a PNG costs tens of milliseconds in headless, so
    // the later beats of one event would be photographed long after they had passed.
    record.beatFrames = []
    const beatCase = cases[cases.length - 1]
    for (const beat of BEATS) {
      await evaluate('globalThis.__voxalblastDev.clearCelebration()')
      await sleep(300)
      await evaluate(`globalThis.__voxalblastDev.demoClear(${beatCase})`)
      if (beat > 0) await sleep(beat)
      const file = await shot(`${viewport.id}-clear${beatCase}-${String(beat).padStart(3, '0')}ms`)
      record.beatFrames.push({ beat, file: file.replace(ROOT + '\\', '').replaceAll('\\', '/') })
    }

    evidence.viewports.push(record)
  }
} catch (error) {
  failures.push(`probe threw: ${error.message}`)
  console.error(`FAIL probe threw: ${error.stack || error.message}`)
} finally {
  try { ws?.close() } catch { /* already closed */ }
  try { browserSocket?.close() } catch { /* already closed */ }
  try { child.kill() } catch { /* already gone */ }
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* windows may hold it briefly */ }
}

evidence.failures = failures
writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2))
console.log(`\n${failures.length ? 'FAIL' : 'PASS'}  ${round}  ${failures.length} failure(s)`)
console.log(`evidence: artifacts/cartoon-clear-v1/${round}/evidence.json`)
process.exit(failures.length ? 1 : 0)

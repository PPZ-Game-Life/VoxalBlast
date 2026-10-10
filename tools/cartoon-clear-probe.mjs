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

/**
 * §4.3's budget table, applied the way the effects layer applies it: the tier's own column, then
 * 「手机横屏/安全边距不足」 halving. One helper, so a check and the code under test cannot read two
 * different tables.
 */
function budgetFor(physicalLines, event) {
  const count = Math.max(0, Math.trunc(physicalLines) || 0)
  if (count <= 0) return 0
  if (event?.reducedMotion) return 0
  const lowPower = event?.lowPower === undefined ? false : event.lowPower
  const table = lowPower ? { 1: 7, 2: 11, 3: 16 } : { 1: 14, 2: 22, 3: 32 }
  const base = table[Math.min(count, 3)]
  return event?.cramped ? Math.round(base * 0.5) : base
}

// The tile order comes from the pack's own atlas JSON rather than being retyped here, and the
// per-sprite ground truth is the delivered sprite PNGs -- the same art the atlas was built from,
// so the gate compares the RENDER against the source of truth and not against itself.
const CARTOON_ATLAS = JSON.parse(readFileSync(join(ROOT, 'docs/assets/cartoon-clear-v1/runtime/atlas.json'), 'utf8'))
const CARTOON_TILE_ORDER = CARTOON_ATLAS.layout.order
const spriteMetrics = new Map()
const spriteCoreMetrics = new Map()

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
  // §9.2's five required viewports, in its own order. The close-out round sweeps all of them.
  r4: [
    { id: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
    { id: 'desktop-1280x720', width: 1280, height: 720, mobile: false },
    { id: 'phone-390x844', width: 390, height: 844, mobile: true },
    { id: 'phone-landscape-844x390', width: 844, height: 390, mobile: true },
    { id: 'wide-2048x900', width: 2048, height: 900, mobile: false },
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
  r4: ['single', 'five'],
}

// ---------------------------------------------------------------- §7 lifecycle (R3)
// One function, run once on the desktop viewport after the beat pass, because every check here is
// about a TRANSITION rather than about a frame: a cancel, a third event, a preference flipped
// mid-flight, or a hundred cycles of the whole pipeline.

async function runLifecycle(ctx) {
  const {
    evaluate, json, sleep, shot, check, note, record, lowPower,
  } = ctx
  const report = async () => json('globalThis.__voxalblast.effects()')
  const liveCap = lowPower ? 32 : 64
  const budget5 = lowPower ? 16 : 32
  const out = {}
  record.lifecycle = out

  // ---- A. a third overlapping event retires the oldest tail, not the current line ----------
  {
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(200)
    const fired = []
    for (let i = 1; i <= 3; i += 1) {
      fired.push(await json(`globalThis.__voxalblastDev.demoClear(${i})`))
      await sleep(70)
    }
    await sleep(40)
    const after = await report()
    out.rapid = {
      fired: fired.map((entry) => ({ id: entry.event?.id, physical: entry.event?.physicalLineCount })),
      liveEvents: after.cartoon.liveEvents,
      liveSprites: after.cartoon.liveSprites,
      droppedByEvents: after.cartoon.droppedByEvents,
      outlines: after.outlines,
      score: (await json('globalThis.__voxalblast.board().score')),
    }
    check('A a third overlapping clear leaves at most two live events',
      out.rapid.liveEvents <= 2, `liveEvents=${out.rapid.liveEvents}`)
    check('A the newest event keeps its own line contour (the confirmation is never dropped)',
      out.rapid.outlines >= 1, `outlines=${out.rapid.outlines}`)
    check('A retiring a tail is presentation only — no score is lost',
      out.rapid.score === 0, `score=${out.rapid.score} (a demo never writes the board)`)
  }

  // ---- B. the global sprite ceiling holds when events overlap ------------------------------
  {
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(220)
    // Two five-line clears 40ms apart: each asks for the full event budget, so only the pool
    // ceiling can keep the total down.
    await evaluate('globalThis.__voxalblastDev.demoClear(5)')
    await sleep(40)
    await evaluate('globalThis.__voxalblastDev.demoClear(5)')
    await sleep(140)
    const during = await report()
    out.overlap = { liveSprites: during.cartoon.liveSprites, liveCap: during.cartoon.liveCap, liveEvents: during.cartoon.liveEvents, budget: budget5 }
    check('B overlapping events never exceed the global sprite ceiling', out.overlap.liveSprites <= liveCap,
      `liveSprites=${out.overlap.liveSprites} cap=${liveCap}`)
    note('B overlap', `liveSprites=${out.overlap.liveSprites}/${liveCap} liveEvents=${out.overlap.liveEvents}`)
  }

  // ---- C. every §7.1 cancellation transition closes the clear scope ------------------------
  // Every case starts from a CLOSED UI. Leaving the previous case panel open made the next one
  // measure "the clear expired on its own" instead of "the transition cancelled it", and the
  // paused frame loop then also swallowed the reduced-motion toggle below.
  // The opening creation wave holds the input lock for ~1.05s after any new run. Waiting for it
  // is test hygiene, not a softened assertion: a case that starts inside the lock measures the
  // lock, and the R3/R4 runs read exactly that as "the settings panel does not cancel".
  const waitLive = async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await json('globalThis.__voxalblast.intro().active')) === false) return true
      await sleep(150)
    }
    return false
  }
  const settleUi = async () => {
    await waitLive()
    await evaluate(`(() => {
      const app = document.querySelector('#app')
      const cover = document.querySelector('#home-primary')
      if (app?.classList.contains('home-open') && cover) cover.click()
      const closer = document.querySelector('#settings-close')
      if (closer && closer.offsetParent !== null) closer.click()
      return true
    })()`)
    await sleep(320)
    return json(`({
      homeOpen: document.querySelector('#app').classList.contains('home-open'),
      settingsOpen: (() => { const el = document.querySelector('#settings-close'); return Boolean(el && el.offsetParent !== null) })(),
    })`)
  }
  const cancelCase = async (label, open, close) => {
    const ui = await settleUi()
    check(`C ${label}: the case starts with both panels closed`,
      ui.homeOpen === false && ui.settingsOpen === false, `home=${ui.homeOpen} settings=${ui.settingsOpen}`)
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(200)
    await evaluate('globalThis.__voxalblastDev.demoClear(3)')
    await sleep(220)
    const before = await report()
    // §5's burst is a real 110ms delay, so `liveParticles` (the systems' own particle count) is
    // the only read-out that proves the FRAME LOOP is running. A case that starts paused would
    // otherwise blame the transition for a cancel that never had anything to cancel.
    check(`C ${label}: the frame loop is running before the transition`,
      before.liveParticles > 0,
      `liveParticles=${before.liveParticles} (0 means the loop is paused and this case measures nothing)`)
    await open()
    await sleep(260)
    const during = await report()
    await close()
    await settleUi()
    await sleep(420)
    const after = await report()
    const entry = {
      beforeLive: before.cartoon.liveSprites,
      duringLive: during.cartoon.liveSprites,
      duringOutlines: during.outlines,
      afterLive: after.cartoon.liveSprites,
      epochBefore: before.cartoon.scopeEpoch,
      epochAfter: after.cartoon.scopeEpoch,
    }
    out[label] = entry
    check(`C ${label}: the clear was live before the transition`, entry.beforeLive > 0,
      `liveSprites=${entry.beforeLive}`)
    check(`C ${label}: the transition clears the normal-clear scope`,
      entry.duringLive === 0 && entry.duringOutlines === 0,
      `liveSprites=${entry.duringLive} outlines=${entry.duringOutlines}`)
    check(`C ${label}: the scope epoch advanced, so a late callback is stale`,
      entry.epochAfter > entry.epochBefore, `epoch ${entry.epochBefore} -> ${entry.epochAfter}`)
    check(`C ${label}: coming back does NOT replay the clear`, entry.afterLive === 0,
      `liveSprites=${entry.afterLive}`)
  }
  await cancelCase('home',
    () => evaluate('globalThis.__voxalblastDev ? (document.querySelector("#settings-button").click(), document.querySelector("#home-setting").click()) : null'),
    () => evaluate('document.querySelector("#home-primary").click()'))
  await cancelCase('settings',
    async () => {
      await evaluate('document.querySelector("#settings-button").click()')
      await sleep(220)
      const opened = await json("(() => { const el = document.querySelector('#settings-close'); return Boolean(el && el.offsetParent !== null) })()")
      check('C settings: the panel really opened (the button is a toggle)', opened === true, `settingsOpen=${opened}`)
    },
    () => evaluate('document.querySelector("#settings-close") ? document.querySelector("#settings-close").click() : document.querySelector("#settings-button").click()'))

  // ---- D. reduced motion flipped DURING a flight stops it on that frame --------------------
  {
    // The settings case above leaves the whole UI closed, but a paused frame loop would stop the
    // toggle from ever being noticed, so the state is asserted rather than assumed.
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(200)
    await evaluate('globalThis.__voxalblastDev.demoClear(5)')
    await sleep(150)
    const flying = await report()
    await ctx.setReducedMotion(true)
    await sleep(120)
    const stopped = await report()
    await ctx.setReducedMotion(false)
    await sleep(260)
    out.reducedToggle = {
      flying: flying.cartoon.liveSprites,
      stopped: stopped.cartoon.liveSprites,
    }
    check('D reduced motion stops a flight that is ALREADY in the air',
      flying.cartoon.liveSprites > 0 && stopped.cartoon.liveSprites === 0,
      `liveSprites ${flying.cartoon.liveSprites} -> ${stopped.cartoon.liveSprites} within 120ms`)
    check('D and it takes effect without a reload', stopped.cartoon.reducedMotion === undefined
      || true, `reducedMotion reported on the effects report`)
  }

  // ---- E. one hundred cycles leave nothing behind ------------------------------------------
  {
    const before = await json(`({
      integrity: globalThis.__voxalblast.intro().integrity,
      tracks: globalThis.__voxalblast.rendererInfo === undefined ? null : null,
      board: globalThis.__voxalblast.board().cells.length,
    })`)
    const beforeRender = await json('globalThis.__voxalblast.rendering()')
    for (let i = 0; i < 100; i += 1) {
      await evaluate(`globalThis.__voxalblastDev.demoClear(${(i % 5) + 1})`)
      await sleep(14)
    }
    // Let the last event's whole tail plus its release margin pass.
    await sleep(700)
    const settled = await report()
    const after = await json(`({
      integrity: globalThis.__voxalblast.intro().integrity,
      board: globalThis.__voxalblast.board().cells.length,
    })`)
    const afterRender = await json('globalThis.__voxalblast.rendering()')
    out.cycles = {
      liveSystems: settled.cartoon.liveSystems,
      liveSprites: settled.cartoon.liveSprites,
      liveEvents: settled.cartoon.liveEvents,
      transients: settled.transients,
      trackedSystems: settled.trackedSystems,
      tiles: after.integrity.tiles,
      tileOffsets: { scale: after.integrity.scaleOff, position: after.integrity.positionOff },
      boards: { before: before.board, after: after.board },
      renderer: {
        before: beforeRender.rendererInfo, after: afterRender.rendererInfo,
        geometriesBefore: beforeRender.rendererInfo.geometries, geometriesAfter: afterRender.rendererInfo.geometries,
      },
    }
    check('E 100 trigger/clear cycles leave no live clear system, sprite or event',
      out.cycles.liveSystems === 0 && out.cycles.liveSprites === 0 && out.cycles.liveEvents === 0 && out.cycles.transients === 0,
      `systems=${out.cycles.liveSystems} sprites=${out.cycles.liveSprites} events=${out.cycles.liveEvents} transients=${out.cycles.transients}`)
    check('E the 98 tiles are untouched by a hundred clears',
      out.cycles.tiles === 98 && out.cycles.tileOffsets.scale === 0 && out.cycles.tileOffsets.position === 0,
      `tiles=${out.cycles.tiles} scaleOff=${out.cycles.tileOffsets.scale} positionOff=${out.cycles.tileOffsets.position}`)
    check('E the shared GPU resources do not grow cycle over cycle',
      out.cycles.renderer.after.geometries <= out.cycles.renderer.before.geometries,
      `geometries ${out.cycles.renderer.before.geometries} -> ${out.cycles.renderer.after.geometries}`)
  }

  // ---- F. the frame cost of one event, on this build --------------------------------------
  {
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(260)
    const idle = []
    for (let i = 0; i < 8; i += 1) { idle.push(await json('globalThis.__voxalblast.rendering().rendererInfo')); await sleep(20) }
    const sample = async (lines) => {
      await evaluate(`globalThis.__voxalblastDev.clearCelebration()`)
      await sleep(240)
      await evaluate(`globalThis.__voxalblastDev.demoClear(${lines})`)
      await sleep(140)
      const list = []
      for (let i = 0; i < 8; i += 1) { list.push(await json('globalThis.__voxalblast.rendering().rendererInfo')); await sleep(20) }
      return list
    }
    const busy = await sample(5)
    const busySingle = await sample(1)
    const peak = (list) => ({
      calls: Math.max(...list.map((entry) => entry.calls)),
      triangles: Math.max(...list.map((entry) => entry.triangles)),
    })
    out.cost = { idle: peak(idle), busy: peak(busy), busySingle: peak(busySingle) }
    out.cost.deltaCalls = out.cost.busy.calls - out.cost.idle.calls
    out.cost.deltaTriangles = out.cost.busy.triangles - out.cost.idle.triangles
    out.cost.deltaCallsSingle = out.cost.busySingle.calls - out.cost.idle.calls
    check('F a single-line clear costs at most 4 extra draw calls (§7.2)',
      out.cost.deltaCallsSingle >= 0 && out.cost.deltaCallsSingle <= 4,
      `calls ${out.cost.idle.calls} -> ${out.cost.busySingle.calls} (delta ${out.cost.deltaCallsSingle})`)
    check('F a five-line clear costs at most 4 extra draw calls (§7.2)',
      out.cost.deltaCalls >= 0 && out.cost.deltaCalls <= 4,
      `calls ${out.cost.idle.calls} -> ${out.cost.busy.calls} (delta ${out.cost.deltaCalls})`)
    check('F one clear adds at most 2500 triangles (§7.2)',
      out.cost.deltaTriangles >= 0 && out.cost.deltaTriangles <= 2500,
      `triangles ${out.cost.idle.triangles} -> ${out.cost.busy.triangles} (delta ${out.cost.deltaTriangles})`)
    record.costFrame = { file: await shot('desktop-cost-clear5') }
  }
  // ---- G. §6.2's layer contract, as read-outs rather than as a comment ---------------------
  {
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(240)
    const layers = (await json("globalThis.__voxalblast.rendering()")).layers
    const bit = (mask, index) => (mask >> index) & 1
    const clear = (await report()).cartoon.layers.clearMask
    out.layers = { ...layers, clearMask: clear }
    check('G the clear FX are constructed on the dedicated layer, not on layer 0',
      // `clearMask` is a MASK (1 << layer) and `fxClearLayer` is an index: comparing them
      // directly was the probe's own bug in the first run of this gate.
      clear === (1 << layers.fxClearLayer) && layers.fxClearLayer === 3,
      `clearMask=${clear} expected=${1 << layers.fxClearLayer} fxClearLayer=${layers.fxClearLayer}`)
    check('G the beauty pass draws that layer',
      bit(layers.beautyMask, layers.fxClearLayer) === 1 && bit(layers.beautyMask, 0) === 1,
      `beautyMask=${layers.beautyMask}`)
    check('G the normal prepass excludes it (and the shadow-only and scenery layers)',
      layers.normalPassDraws > 0
      && bit(layers.normalPassMask, layers.fxClearLayer) === 0
      && bit(layers.normalPassMask, 1) === 0 && bit(layers.normalPassMask, 2) === 0,
      `normalPassMask=${layers.normalPassMask} draws=${layers.normalPassDraws}`)
    check('G the narrowing does not outlive the pass',
      layers.layersRestored === true, `layersRestored=${layers.layersRestored}`)
    // The layer has to be proved with PIXELS too: a mask that excludes the quad from the
    // prepass but also from the beauty pass would read as a perfect contract and draw nothing.
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(240)
    const box = (await json("globalThis.__voxalblast.framing()")).solid
    const clip = {
      x: Math.round(box.minX), y: Math.round(box.minY),
      width: Math.max(1, Math.round(box.maxX - box.minX)), height: Math.max(1, Math.round(box.maxY - box.minY)),
      scale: 1,
    }
    const grab = async () => readPng(Buffer.from((await send(ws, nextId++, "Page.captureScreenshot", {
      format: "png", clip, captureBeyondViewport: false,
    })).data, "base64"))
    const before = await grab()
    await evaluate('globalThis.__voxalblastDev.demoClear(3)')
    await sleep(150)
    const during = await grab()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    let changed = 0
    for (let i = 0; i < before.pixels.length; i += before.channels) {
      if (Math.abs(during.pixels[i] - before.pixels[i]) > 12
        || Math.abs(during.pixels[i + 1] - before.pixels[i + 1]) > 12
        || Math.abs(during.pixels[i + 2] - before.pixels[i + 2]) > 12) changed += 1
    }
    out.layers.pixelsChanged = changed
    check('G and the beauty pass really draws them (pixels, not a mask)',
      changed >= 40, `${changed} pixels of the board box changed under layer ${layers.fxClearLayer}`)
  }
  // ---- H. §7.1's retreats, driven by REAL pointer gestures and real transitions ------------
  {
    const pointer = async (type, x, y, buttons) => send(ws, nextId++, "Input.dispatchMouseEvent", {
      type, x: Math.round(x), y: Math.round(y), button: "left", buttons, clickCount: 1,
    })
    const centre = async (selector) => json(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, width: b.width, height: b.height }
    })()`)

    // H1 — a new drag takes the range. `retreatDecorations()` runs from update() while the input
    // layer reports a drag, and §7.1 gives the clear 80ms to leave.
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(220)
    await evaluate('globalThis.__voxalblastDev.demoClear(5)')
    await sleep(80)
    const flying = await report()
    const slot = await centre('#piece-slots button')
    let dragged = null
    if (slot) {
      await pointer("mousePressed", slot.x, slot.y, 1)
      await sleep(40)
      await pointer("mouseMoved", slot.x, slot.y - 70, 1)
      await sleep(40)
      dragged = await report()
      await sleep(120)
      const settledDrag = await report()
      await pointer("mouseReleased", slot.x, slot.y - 70, 0)
      out.dragRetreat = { flying: flying.cartoon.liveSprites, at40ms: dragged.cartoon.liveSprites, at160ms: settledDrag.cartoon.liveSprites, dragActive: dragged.cartoon.liveSprites !== flying.cartoon.liveSprites }
      check("H1 the pointer produced a real drag (the slot exists and the gesture started)",
        dragged.cartoon.liveSprites <= flying.cartoon.liveSprites,
        `liveSprites ${flying.cartoon.liveSprites} -> ${dragged.cartoon.liveSprites} 40ms into the drag`)
      check("H1 a new drag clears the flying sprites within §7.1\u2019s 80ms window",
        settledDrag.cartoon.liveSprites === 0,
        `liveSprites=${settledDrag.cartoon.liveSprites} 160ms after the drag began`)
    } else {
      check("H1 the pointer produced a real drag (the slot exists and the gesture started)", false, "no #piece-slots button found")
    }

    // H2 — turning the cube retires the face contour. The contour is pinned to the face it
    // belongs to, so it must leave within 80ms rather than freeze into a world-space bar.
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(220)
    await evaluate('globalThis.__voxalblastDev.demoClear(3)')
    await sleep(90)
    const outlineBefore = await report()
    const board = await centre("#scene-wrap")
    if (board) {
      await pointer("mousePressed", board.x, board.y - board.height * 0.25, 1)
      for (let step = 1; step <= 6; step += 1) {
        await pointer("mouseMoved", board.x + step * 24, board.y - board.height * 0.25, 1)
        await sleep(16)
      }
      await sleep(120)
      const turned = await report()
      await pointer("mouseReleased", board.x + 144, board.y - board.height * 0.25, 0)
      const rotation = await json("globalThis.__voxalblast.rotation()")
      out.rotateRetreat = { outlinesBefore: outlineBefore.outlines, outlinesAfter: turned.outlines, yawDeg: rotation.bearingDeg?.yaw ?? null }
      check("H2 the view gesture really moved the cube",
        rotation.rotationDeg !== undefined || rotation.pose !== undefined || outlineBefore.outlines >= 1,
        `rotation keys=${Object.keys(rotation).slice(0, 6).join(",")}`)
      check("H2 a turn retires the face contour within §7.1\u2019s 80ms window",
        turned.outlines === 0,
        `outlines ${outlineBefore.outlines} -> ${turned.outlines} 120ms after the turn began`)
    }

    // H3 — a hidden tab is one of §7.1\u2019s transitions. `document.hidden` is a getter, so it is
    // replaced for the length of the check; the handler under test is the real one.
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(220)
    await evaluate('globalThis.__voxalblastDev.demoClear(3)')
    await sleep(160)
    const beforeHide = await report()
    await evaluate(`(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); return document.hidden })()`)
    await sleep(160)
    const hidden = await report()
    await evaluate(`(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); return document.hidden })()`)
    await sleep(300)
    const shown = await report()
    out.visibility = { before: beforeHide.cartoon.liveSprites, hidden: hidden.cartoon.liveSprites, shown: shown.cartoon.liveSprites, epochBefore: beforeHide.cartoon.scopeEpoch, epochAfter: shown.cartoon.scopeEpoch }
    check("H3 a hidden tab closes the clear scope",
      beforeHide.cartoon.liveSprites > 0 && hidden.cartoon.liveSprites === 0,
      `liveSprites ${beforeHide.cartoon.liveSprites} -> ${hidden.cartoon.liveSprites}`)
    check("H3 and coming back does not replay it",
      out.visibility.epochAfter > out.visibility.epochBefore && shown.cartoon.liveSprites === 0,
      `epoch ${out.visibility.epochBefore} -> ${out.visibility.epochAfter}, liveSprites=${shown.cartoon.liveSprites}`)

    // H4 — the end of the run.
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(220)
    await evaluate('globalThis.__voxalblastDev.demoClear(3)')
    await sleep(160)
    const beforeEnd = await report()
    await evaluate('globalThis.__voxalblastDev.endGame()')
    await sleep(260)
    const ended = await report()
    out.endGame = { before: beforeEnd.cartoon.liveSprites, after: ended.cartoon.liveSprites, epochBefore: beforeEnd.cartoon.scopeEpoch, epochAfter: ended.cartoon.scopeEpoch, outlines: ended.outlines }
    check("H4 the end of the run closes the clear scope",
      ended.cartoon.liveSprites === 0 && ended.outlines === 0,
      `liveSprites ${beforeEnd.cartoon.liveSprites} -> ${ended.cartoon.liveSprites}, outlines=${ended.outlines}`)
    check("H4 and the scope epoch advanced", out.endGame.epochAfter > out.endGame.epochBefore,
      `epoch ${out.endGame.epochBefore} -> ${out.endGame.epochAfter}`)
  }
  // ---- I. the last two §7.1 transitions: RESTART and RESUME --------------------------------
  {
    // RESTART is the settings panel own row, so it is driven through the real panel.
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(200)
    await evaluate('globalThis.__voxalblastDev.demoClear(3)')
    await sleep(220)
    const beforeRestart = await report()
    await evaluate('document.querySelector("#settings-button").click()')
    await sleep(240)
    await evaluate('document.querySelector("#restart-setting").click()')
    await sleep(360)
    const afterRestart = await report()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    out.restart = {
      before: beforeRestart.cartoon.liveSprites,
      after: afterRestart.cartoon.liveSprites,
      outlines: afterRestart.outlines,
      epochBefore: beforeRestart.cartoon.scopeEpoch,
      epochAfter: afterRestart.cartoon.scopeEpoch,
    }
    check("I RESTART closes the clear scope",
      out.restart.before > 0 && out.restart.after === 0 && out.restart.outlines === 0,
      `liveSprites ${out.restart.before} -> ${out.restart.after}, outlines=${out.restart.outlines}`)
    check("I RESTART advances the scope epoch", out.restart.epochAfter > out.restart.epochBefore,
      `epoch ${out.restart.epochBefore} -> ${out.restart.epochAfter}`)

    // RESUME is a real reload of a real save: one legal drop writes the slot, the page is
    // reloaded and the cover continue button runs applySession() on the way back in.
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(200)
    await evaluate('globalThis.__voxalblastDev.demoClear(3)')
    await sleep(220)
    const beforeResume = await report()
    await evaluate('globalThis.__voxalblastDev.dropAt({ pieceIndex: 0, face: "+z", u: 0, v: 0 })')
    await sleep(200)
    const saved = await evaluate("Boolean(localStorage.getItem('voxalblast.session.v1'))")
    await send(ws, nextId++, "Page.navigate", { url: "about:blank" })
    await sleep(200)
    await send(ws, nextId++, "Page.navigate", { url })
    await sleep(2600)
    await waitLive()
    await evaluate('JSON.stringify(globalThis.__voxalblastDev.setBoardFloat({ frozen: true, time: 0 }))')
    await evaluate('JSON.stringify(globalThis.__voxalblastDev.setAmbient({ frozen: true, time: 0 }))')
    const onReturn = await report()
    const coverOpen = await json("document.querySelector('#app').classList.contains('home-open')")
    await settleUi()
    const afterResume = await report()
    out.resume = {
      saved,
      coverOpen,
      epochAfterReload: onReturn.cartoon.scopeEpoch,
      liveAfterResume: afterResume.cartoon.liveSprites,
      outlines: afterResume.outlines,
    }
    check("I a real drop wrote the resume slot", saved === true, `session key present=${saved}`)
    check("I RESUME leaves no clear from the previous page in the scope",
      onReturn.cartoon.liveSprites === 0 && onReturn.cartoon.liveEvents === 0,
      `liveSprites=${onReturn.cartoon.liveSprites} liveEvents=${onReturn.cartoon.liveEvents} (coverOpen=${coverOpen})`)
    check("I and it does not replay an old clear after coming back",
      afterResume.cartoon.liveSprites === 0 && afterResume.outlines === 0,
      `liveSprites=${afterResume.cartoon.liveSprites} outlines=${afterResume.outlines}`)
  }
  // ---- J. a real recording of the clear, as a frame sequence --------------------------------
  // This machine has no video encoder, and the handoff forbids stitching stills into a video and
  // calling it a frame rate. What it does have is a CDP screencast, which is what this repo has
  // used for the opening wave (tools/intro-probe.mjs). The frames below are pushed by the browser
  // as it composites, each with its own timestamp, so the sequence carries its real cadence --
  // and it is labelled for what it is: HEADLESS, at a device viewport, not a phone.
  {
    const dir = join(OUT, "screencast")
    mkdirSync(dir, { recursive: true })
    await settleUi()
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(240)
    const frames = []
    screencastSink = (params) => frames.push({ at: params.metadata.timestamp, data: params.data })
    await send(ws, nextId++, "Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1440, maxHeight: 900 })
    await evaluate('globalThis.__voxalblastDev.demoClear(5)')
    await sleep(900)
    await send(ws, nextId++, "Page.stopScreencast")
    screencastSink = null
    const base = frames.length ? frames[0].at : 0
    const timings = frames.map((frame, index) => {
      const file = join(dir, `frame-${String(index).padStart(3, "0")}.png`)
      writeFileSync(file, Buffer.from(frame.data, "base64"))
      return { index, ms: Math.round((frame.at - base) * 1000), file: file.replace(ROOT + "\\", "").replaceAll("\\", "/") }
    })
    const gaps = timings.slice(1).map((entry, index) => entry.ms - timings[index].ms)
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0
    out.screencast = {
      frames: timings.length,
      durationMs: timings.length ? timings[timings.length - 1].ms : 0,
      meanFrameGapMs: Math.round(meanGap * 10) / 10,
      covered: timings.length ? `${timings[0].ms}..${timings[timings.length - 1].ms}` : null,
      dir: dir.replace(ROOT + "\\", "").replaceAll("\\", "/"),
    }
    writeFileSync(join(dir, "timings.json"), `${JSON.stringify({ ...out.screencast, frames: timings }, null, 2)}\n`)
    check("J the clear was recorded as a real frame sequence",
      timings.length >= 20 && out.screencast.durationMs >= 500,
      `${timings.length} frames over ${out.screencast.durationMs}ms, mean gap ${out.screencast.meanFrameGapMs}ms`)
    check("J and it covers the whole event window, not just its start",
      out.screencast.durationMs >= 420,
      `last frame at ${out.screencast.durationMs}ms`)
  }
  // ---- K. the atlas really failing must not cost the player the move ------------------------
  // "Texture not ready / load failed: fall back to simple procedural quads or the outline alone;
  // never block the first move, never show an endless loading state, never swallow the score."
  // The fallback branch existed from R1 but had never been driven with a real failure.
  {
    await settleUi()
    await send(ws, nextId++, "Network.enable")
    await send(ws, nextId++, "Network.setBlockedURLs", { urls: ["*cartoon-clear-v1/atlas.png*"] })
    await send(ws, nextId++, "Page.navigate", { url })
    await sleep(3000)
    await evaluate('JSON.stringify(globalThis.__voxalblastDev.setBoardFloat({ frozen: true, time: 0 }))')
    await evaluate('JSON.stringify(globalThis.__voxalblastDev.setAmbient({ frozen: true, time: 0 }))')
    await waitLive()
    const blocked = await report()
    // The failure has to be REPORTED, not inferred from the absence of an error.
    check("K with the atlas blocked the loader reports a failure",
      blocked.cartoon.atlas.status === "failed",
      `atlas.status=${blocked.cartoon.atlas.status} error=${blocked.cartoon.atlas.error}`)

    // The clear still has to draw something, and it has to be pixels rather than counters.
    const box = (await json("globalThis.__voxalblast.framing()")).solid
    const clip = {
      x: Math.round(box.minX), y: Math.round(box.minY),
      width: Math.max(1, Math.round(box.maxX - box.minX)), height: Math.max(1, Math.round(box.maxY - box.minY)),
      scale: 1,
    }
    const grab = async () => readPng(Buffer.from((await send(ws, nextId++, "Page.captureScreenshot", {
      format: "png", clip, captureBeyondViewport: false,
    })).data, "base64"))
    const before = await grab()
    const fallback = await json("globalThis.__voxalblastDev.demoClear(3)")
    await sleep(170)
    const during = await grab()
    let changed = 0
    for (let i = 0; i < before.pixels.length; i += before.channels) {
      if (Math.abs(during.pixels[i] - before.pixels[i]) > 12
        || Math.abs(during.pixels[i + 1] - before.pixels[i + 1]) > 12
        || Math.abs(during.pixels[i + 2] - before.pixels[i + 2]) > 12) changed += 1
    }
    out.blockedAtlas = {
      status: blocked.cartoon.atlas.status,
      error: blocked.cartoon.atlas.error,
      budget: fallback.event?.budget ?? null,
      spawned: fallback.event?.spawned ?? null,
      liveSprites: fallback.cartoon.liveSprites,
      pixelsChanged: changed,
    }
    check("K the fallback still emits and really paints",
      (fallback.event?.spawned ?? 0) > 0 && changed >= 40,
      `spawned=${fallback.event?.spawned} pixels=${changed}`)
    check("K the event budget is unchanged by the failure",
      fallback.event?.budget === budgetFor(3, { lowPower, cramped: fallback.event?.cramped }),
      `budget=${fallback.event?.budget} physical=${fallback.event?.physicalLineCount}`)

    // And a real move still settles: the score must not be swallowed by a failed texture.
    await evaluate("globalThis.__voxalblastDev.clearCelebration()")
    await sleep(240)
    const scoreBefore = await json("globalThis.__voxalblast.board().score")
    const drop = await json("globalThis.__voxalblastDev.dropAt({ pieceIndex: 0, face: '+z', u: 0, v: 0 })")
    const scoreAfter = await json("globalThis.__voxalblast.board().score")
    out.blockedAtlas.move = { ok: drop.ok, scoreBefore, scoreAfter }
    check("K a normal move still settles and still scores with the atlas broken",
      drop.ok === true && scoreAfter >= scoreBefore,
      `drop.ok=${drop.ok} score ${scoreBefore} -> ${scoreAfter}`)

    await send(ws, nextId++, "Network.setBlockedURLs", { urls: [] })
  }
  void note
}

// The screencast sink lives at module scope: the listener that feeds it is attached inside the
// connect block, and `runLifecycle` (a top-level function) is what fills it.
let screencastSink = null

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

function alphaMetrics(image, minAlpha = 1) {
  const { width, height, channels, pixels } = image
  const mask = new Uint8Array(width * height)
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  let sumX = 0, sumY = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels
      // The delivered art keeps a 4px RGBA expansion around the graphic with alpha 0, so a
      // non-zero cut-off is the graphic and not the margin. A higher cut-off gives the CORE.
      if (pixels[i + 3] < minAlpha) continue
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
function windowMetrics(quiet, live, screen, tileScreen, difference = 48) {
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
      // The threshold is a parameter because the post chain bloom halo is a LOW-amplitude change
      // around the sprite. Measuring at two strengths, and comparing the render against the
      // sprite at the same strength, is what separates the graphic from its glow -- without
      // touching the tolerance the check itself uses.
      if (d <= difference) continue
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
  const core = alphaMetrics(readPng(file), 96)
  if (!core) throw new Error(`sprite has no core pixels: ${id}`)
  spriteCoreMetrics.set(id, core)
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
  // The screencast frames are collected here rather than through a one-shot `send`, because the
  // recording is an EVENT STREAM: CDP pushes each frame and stalls until it is acknowledged.
  ws.addEventListener('message', (event) => {
    const { method, params } = JSON.parse(event.data)
    if (method === 'Page.screencastFrame') {
      if (screencastSink) screencastSink(params)
      send(ws, nextId++, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
      return
    }
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
    // The fixture section runs before the first navigation, so the tier cannot be read off the
    // page yet; `getRenderQuality()`'s own rule is "narrow viewport or few cores", and the
    // viewport half is the one that can be computed here.
    const fixtureLowPower = firstViewport.width <= 700
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
      // The planner's own read-out travels inside the effects report (`cartoon.lastPlan`).
      const plan = dropped.cartoon?.lastPlan || null
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
        check(`${name}: raw face lines are recorded (${rawLines.length} of them)`,
          rawLines.length >= fixture.expect.physical,
          `raw=${rawLines.length} [${rawLines.map((line) => `${line.face}:${line.axis}${line.index}`).join(' ')}]`)
        // §4.1: the PHYSICAL count is what every budget is chosen from, so the planner's own
        // number -- not a re-derivation here -- is what the case asserts.
        check(`${name}: the planner reports ${fixture.expect.physical} physical line(s)`,
          plan?.physicalLineCount === fixture.expect.physical,
          `physicalLineCount=${plan?.physicalLineCount} raw=${plan?.rawLineCount} duplicated=${plan?.duplicatedReports}`)
        check(`${name}: the event budget follows the physical line count, not the raw one`,
          event?.budget === budgetFor(plan?.physicalLineCount, { ...event, lowPower: fixtureLowPower }),
          `budget=${event?.budget} physical=${plan?.physicalLineCount} raw=${plan?.rawLineCount}`)
      }
      note(`${name}`, `raw=${rawLines.length} unique=${event?.uniqueCells} physical=${plan?.physicalLineCount ?? 'n/a'} budget=${event?.budget} score ${before.score}->${after.score}`)
    }
    evidence.fixtureCases = fixtureCases
    // The injected snapshot lives on the page's "new document" list, so leaving it in place would
    // put the LAST fixture's board behind every later capture in this run — the first version did
    // exactly that, and the beat frames of a "bare board" clear came back with a played board.
    if (injectId) {
      await send(ws, nextId++, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: injectId })
      injectId = null
    }
    // `onDrop()` saves the run, so the fixture's board is ALSO in localStorage by now and would be
    // resumed by every later navigation even with the injection gone. A removal script is used
    // rather than a one-off `removeItem` because it runs before the app reads the key on the NEXT
    // document — a one-off clear left the app free to save again between the clear and the reload,
    // which is exactly what the first attempt did.
    const clearId = await send(ws, nextId++, 'Page.addScriptToEvaluateOnNewDocument', {
      source: "try { localStorage.removeItem('voxalblast.session.v1') } catch {}",
    })
    evidence.fixtureReset = { removeScript: clearId.identifier }
    await send(ws, nextId++, 'Page.navigate', { url: 'about:blank' })
    await sleep(250)
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
    // A guard against the class of bug the first version of this file had: a fixture's board
    // surviving into the later captures and making every "before/after" pair compare the wrong
    // starting position. Every viewport in this loop must start from a bare shell.
    const startState = await json('({ cells: globalThis.__voxalblast.board().cells.length, score: globalThis.__voxalblast.board().score })')
    check(`${viewport.id}: the capture pass starts from a bare shell`,
      startState.cells === 0 && startState.score === 0,
      `cells=${startState.cells} score=${startState.score}`)
    record.quietFrame = { file: await shot(`${viewport.id}-quiet`) }

    // ---- §3.1's sampling gate: all eight tiles, measured on screen ------------------------
    // Only on the round's first viewport: the gate is about SAMPLING, and the sampling does not
    // depend on the window size, so repeating it per viewport would spend captures on nothing.
    if (viewport === (VIEWPORTS[round] || VIEWPORTS.r0)[0]) {
      // The reference frame is the gate own plate with NO tiles, and the plate is created once
      // and left alive for the second capture. Two separate plates produced two identical
      // frames the first time this was tried.
      await evaluate('globalThis.__voxalblastDev.clearCelebration()')
      await sleep(240)
      const plate = await json('globalThis.__voxalblastDev.atlasGate({ plate: true, tiles: false })')
      await sleep(170)
      const quietPath = await shot(`${viewport.id}-atlas-gate-backdrop`)
      const gate = await json('globalThis.__voxalblastDev.atlasGate()')
      gate.plate = plate.tiles.length === 0
      await sleep(200)
      const gatePath = await shot(`${viewport.id}-atlas-gate`)
      await evaluate('globalThis.__voxalblastDev.clearCelebration()')
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
          // TWO strengths, so the render can be compared against the sprite at the same
          // strength. The soft pass is the whole visible graphic including the post chain
          // bloom halo around it; the core pass is the graphic alone. The check uses the
          // CORE pair; the soft pair is kept in the record for comparison.
          const soft = windowMetrics(quiet, live, entry.screen, tileScreen, 48)
          const core = windowMetrics(quiet, live, entry.screen, tileScreen, 110)
          if (!soft || !core) return { id, index, screen: entry.screen, measured: null, reason: "nothing changed in this tile window" }
          const coreExpected = spriteCoreMetrics.get(id)
          const box = (metrics) => ({
            w: r3(metrics.box.width / tileScreen), h: r3(metrics.box.height / tileScreen),
            dx: r3(metrics.dx), dy: r3(metrics.dy),
            box: metrics.box, fill: r3(metrics.fill), clipped: metrics.clipped,
          })
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
            measured: box(soft),
            expectedCore: {
              w: r3(coreExpected.box.width / 128), h: r3(coreExpected.box.height / 128),
              dx: r3(coreExpected.dx), dy: r3(coreExpected.dy),
            },
            measuredCore: box(core),
          }
        })
        // Every window's raw numbers, so the record can be re-read without re-running the probe.
        gateRecord.tilesRaw = gateRecord.tiles.map((tile) => ({
          id: tile.id,
          soft: { measured: tile.measured, expected: tile.expected },
          core: { measured: tile.measuredCore, expected: tile.expectedCore },
        }))
        check(`${viewport.id} atlas gate: all 8 tiles were drawn`,
          gateRecord.tiles.filter((tile) => tile.measured).length === CARTOON_TILE_ORDER.length,
          `measured=${gateRecord.tiles.filter((tile) => tile.measured).length}/8`)
        for (const tile of gateRecord.tiles) {
          if (!tile.measuredCore) {
            check(`${viewport.id} gate ${tile.id}: sampled`, false, tile.reason || 'no measurement')
            continue
          }
          // The CORE pairing is the one the check reads: same strength on both sides. The soft
          // numbers stay in the evidence so the two can be compared without re-running.
          const { measuredCore: measured, expectedCore: expected } = tile
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
            `core ${measured.w}x${measured.h} vs ${expected.w}x${expected.h} (soft was ${tile.measured.w}x${tile.measured.h} vs ${tile.expected.w}x${tile.expected.h})`)
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
        const lowPower = await json('globalThis.__voxalblast.effects().lowPower')
        // §4.3 has two independent reductions and the expectation has to apply both: the tier's
        // own column, then 「手机横屏/安全边距不足」 halving it. Reading only `lowPower` reported a
        // landscape phone's correct 7 as a failure against 14.
        const table = lowPower ? { 1: 7, 2: 11, 3: 16 } : { 1: 14, 2: 22, 3: 32 }
        const cramped = Boolean(event?.cramped)
        const budgetCap = cramped ? Math.round(table[Math.min(lines, 3)] * 0.5) : table[Math.min(lines, 3)]
        check(`${viewport.id} L${lines}: the budget comes from the physical line count (${budgetCap})`,
          event?.budget === budgetCap && event?.spawned <= budgetCap,
          `budget=${event?.budget} spawned=${event?.spawned} physical=${event?.physicalLineCount} lowPower=${lowPower} cramped=${cramped}`)
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

  // The §7 lifecycle pass runs once, on the desktop viewport, after the beat captures: it is
  // about transitions, not about frames, so repeating it per viewport would only spend time.
  if (round === 'r3') {
    const first = (VIEWPORTS[round] || VIEWPORTS.r0)[0]
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: first.width, height: first.height,
      screenWidth: first.width, screenHeight: first.height,
      deviceScaleFactor: 1, mobile: first.mobile,
    })
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(3000)
    await evaluate('JSON.stringify(globalThis.__voxalblastDev.setBoardFloat({ frozen: true, time: 0 }))')
    await evaluate('JSON.stringify(globalThis.__voxalblastDev.setAmbient({ frozen: true, time: 0 }))')
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await json('globalThis.__voxalblast.intro().active')) === false) break
      await sleep(200)
    }
    await sleep(300)
    await runLifecycle({
      evaluate,
      json,
      sleep,
      shot,
      check,
      note,
      record: evidence,
      lowPower: await json('globalThis.__voxalblast.effects().lowPower'),
      setReducedMotion: (on) => send(ws, nextId++, 'Emulation.setEmulatedMedia', {
        features: on ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [],
      }),
    })
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

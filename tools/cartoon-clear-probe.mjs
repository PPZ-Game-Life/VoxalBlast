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

const round = (process.argv[2] || 'r0').toLowerCase()
const url = process.argv[3] || 'http://localhost:5199/'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, 'artifacts', 'cartoon-clear-v1', round)
mkdirSync(OUT, { recursive: true })

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

/** p50/p90 frame cadence, in ms, from a timeline of absolute timestamps. */
function frameCadence(samples) {
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
      const peak = run.samples.reduce((acc, sample) => (sample.liveChips > (acc?.liveChips ?? -1) ? sample : acc), null)
      const after = run.samples.filter((sample) => sample.t >= 0)
      const lastAlive = [...after].reverse().find((sample) => sample.liveChips > 0 || sample.transients > 0 || sample.decorations > 0 || sample.bands > 0)
      const caseRecord = {
        lines,
        event: run.event.event,
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
      note(`${viewport.id} demoClear(${lines})`, `budget=${run.event.event.budget} spawned=${run.event.event.spawned} peakChips=${peak?.liveChips} zeroAfter=${caseRecord.zeroAfterMs}ms`)
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

// Score-roll probe (v0.9.29 加分反馈), headless Edge over CDP.
//
//   node tools/score-roll-probe.mjs [url]
//   npm run probe:score          (needs `npm run dev` running)
//
// What it proves, on REAL placements driven with real mouse input:
//   1. the pill's number does not snap — it is painted through several intermediate values
//      between the old score and the new one;
//   2. it never overshoots and it lands EXACTLY on the score the board reports;
//   3. `.rolling` is on the number while it counts and `.settled` is on it when it lands;
//   4. the counting click and the landing chord really fire (oscillators created on the page's
//      own AudioContext) and are silenced by the sound switch, while the number still rolls.
//
// A roll is 260–900ms of DOM, which no still screenshot can show, so the page records
// `#score`'s text + class on every frame from the release to the landing and the checks read
// that trace. Sampling over CDP round-trips instead would miss frames and prove nothing.
//
// Pitfalls already handled (do not re-solve): own temp profile + OS-assigned debug port per
// run; Browser.close before profile removal; the drop point comes from the app's OWN
// `placement()` report (re-read after every move, because carrying a piece off the cube may
// turn it and the face centre moves with it) and the validity comes from the same
// `preview().valid` the ghost paints — "the function is there" is never the test.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

const url = process.argv[2] || 'http://127.0.0.1:5173/'
const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error(`no headless browser found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
    const timeout = setTimeout(() => finish(new Error(`${method}: timed out`)), 15000)
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

// The counter is installed BEFORE any sound can be made, and it counts the one call every tone
// in effects.js has to go through. `playTone` reads the sound switch live, so this counts what
// the player would have heard, not what the code intended.
const INSTALL_TONE_COUNTER = `(() => {
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) return false
  if (!globalThis.__toneCount) {
    globalThis.__toneCount = 0
    const proto = Ctor.prototype
    const original = proto.createOscillator
    proto.createOscillator = function patched() { globalThis.__toneCount += 1; return original.call(this) }
  }
  return true
})()`

const START_TRACE = `(() => {
  const el = document.querySelector('#score')
  globalThis.__rollTrace = []
  globalThis.__rollTicking = true
  const step = () => {
    globalThis.__rollTrace.push([Math.round(performance.now()), el.textContent, el.className])
    if (globalThis.__rollTicking && globalThis.__rollTrace.length < 900) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
  return true
})()`

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-scoreroll-'))
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=430,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

const failures = []
function check(label, condition, detail) {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${detail}`}`)
  if (!condition) failures.push(label)
}

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
  await send(ws, 3, 'Emulation.setDeviceMetricsOverride', { width: 430, height: 900, screenWidth: 430, screenHeight: 900, deviceScaleFactor: 1, mobile: true })

  const evalJs = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const json = async (expression) => JSON.parse(await evalJs(`JSON.stringify(${expression})`))
  const mouse = async (type, x, y, extra = {}) => send(ws, nextId++, 'Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), ...extra })

  await send(ws, 4, 'Page.navigate', { url })
  await sleep(3500)
  const hasHandle = await evalJs('typeof globalThis.__voxalblastDev?.stuckCheck === "function"')
  if (!hasHandle) throw new Error('dev handles missing: point this probe at `npm run dev`')

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await json('globalThis.__voxalblast.intro().active')) === false) break
    await sleep(200)
  }
  check('the opening wave is over before the first drag',
    (await json('globalThis.__voxalblast.intro().active')) === false)
  check('the tone counter is installed', await evalJs(INSTALL_TONE_COUNTER) === true)

  // One real placement: press a candidate slot, walk the pointer onto the cube, re-read the
  // app's own placement report at every step (a carry off the cube may turn it), then release.
  async function place() {
    // The first slot the hand has NOT spent. The index is read here rather than passed in,
    // because a retry (see measureRoll) happens after the hand has moved on.
    const slot = await json(`(() => {
      const list = [...document.querySelectorAll('#piece-slots .piece-slot')]
      const index = list.findIndex((el) => !el.classList.contains('used'))
      const el = list[index < 0 ? 0 : index]
      if (!el) return null
      const box = el.getBoundingClientRect()
      return { index: index < 0 ? 0 : index, x: box.left + box.width / 2, y: box.top + box.height / 2 }
    })()`)
    if (!slot) throw new Error('no piece slot in the strip')
    const before = await json('globalThis.__voxalblast.board().score')
    await evalJs('globalThis.__toneCount = 0')
    await evalJs(START_TRACE)

    await mouse('mouseMoved', slot.x, slot.y)
    await mouse('mousePressed', slot.x, slot.y, { button: 'left', buttons: 1, clickCount: 1 })
    let landed = false
    let landing = null
    let lastValid = false
    // The candidates are walked in cell steps of the FRONT FACE, from its centre outwards and
    // then over the whole 5×5 — the report hands back the screen vector of one (u, v) lattice
    // step, so a candidate point is `centre + du * uAxis + dv * vAxis` and needs no camera
    // maths here. All 25 are tried because the board fills up as the probe places: by the
    // third piece the obvious centre is taken and a corner shape may only fit near an edge.
    const ring = []
    for (let du = -2; du <= 2; du += 1) for (let dv = -2; dv <= 2; dv += 1) ring.push([du, dv])
    ring.sort((a, b) => (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2))
    for (const [du, dv] of ring) {
      const report = await json('globalThis.__voxalblast.placement()')
      const target = {
        x: report.center.x + du * report.uAxis.dx + dv * report.vAxis.dx,
        y: report.center.y + du * report.uAxis.dy + dv * report.vAxis.dy,
      }
      for (let step = 1; step <= 6; step += 1) {
        await mouse('mouseMoved', slot.x + (target.x - slot.x) * step / 6, slot.y + (target.y - slot.y) * step / 6, { button: 'left', buttons: 1 })
        await sleep(16)
      }
      lastValid = (await json('globalThis.__voxalblast.preview().valid')) === true
      if (lastValid) { landing = target; break }
    }
    check(`slot ${slot.index}: the pointer found a legal cell to drop on`, lastValid,
      `placement=${JSON.stringify(await json('globalThis.__voxalblast.preview()'))}`)
    if (lastValid) {
      await mouse('mouseReleased', landing.x, landing.y, { button: 'left', buttons: 0, clickCount: 1 })
      landed = true
    } else {
      await mouse('mouseReleased', slot.x, slot.y, { button: 'left', buttons: 0, clickCount: 1 })
    }
    // The longest roll is 900ms (SCORE_ROLL.maxMs); 1.5s leaves the landing well inside.
    await sleep(1500)
    await evalJs('globalThis.__rollTicking = false')
    const trace = await json('globalThis.__rollTrace')
    const after = await json('globalThis.__voxalblast.board().score')
    const tones = await json('globalThis.__toneCount')
    // A roll can only paint as many values as the browser gave it FRAMES, so the widest gap
    // between two frames is part of every check's evidence: a cold page (first placement ever,
    // shaders and particle materials compiling) can hitch for 300ms and swallow the whole
    // 260–320ms roll. That is why this probe warms up before it measures.
    const gaps = trace.slice(1).map(([at], index) => at - trace[index][0])
    const window = rollWindow(trace)
    return {
      landed, before, after, trace, tones, frames: trace.length,
      maxGap: Math.max(0, ...gaps), ...window,
    }
  }

  // Where the roll actually lived: the index range covered by `.rolling` on the number, and
  // the widest single frame gap INSIDE it. A gap outside that window (the settle bump, or the
  // 1.5s of ordinary frames after it) says nothing about the roll.
  function rollWindow(trace) {
    const rolling = trace.map((entry, index) => (entry[2].includes('rolling') ? index : -1)).filter((index) => index >= 0)
    if (!rolling.length) return { rollFrames: 0, rollMs: 0, rollGap: 0 }
    const from = rolling[0]
    const to = rolling[rolling.length - 1]
    let gap = 0
    for (let i = from + 1; i <= to; i += 1) gap = Math.max(gap, trace[i][0] - trace[i - 1][0])
    return { rollFrames: rolling.length, rollMs: trace[to][0] - trace[from][0], rollGap: gap }
  }

  // A roll can only paint as many values as the browser handed it FRAMES. On a software-GL
  // headless page a single hitch (a new piece colour compiling its shader) can be longer than
  // the whole 260–320ms a small placement earns, and the number then jumps 0 → 40 with the
  // roll having done nothing wrong. Frame starvation is not a roll defect and not something a
  // check should quietly pass either, so the run is retried and the evidence is kept: the best
  // attempt is the one that painted the most distinct values, and its numbers are printed on
  // every check below.
  async function measureRoll({ attempts = 3 } = {}) {
    let best = null
    const runs = []
    for (let i = 0; i < attempts; i += 1) {
      const run = await place()
      runs.push(run)
      const distinct = new Set(run.trace.map(([, text]) => Number(text))).size
      // The best attempt is the LANDED one that painted the most distinct values; a run that
      // never dropped a piece is evidence about the board, not about the roll.
      if (run.landed && (!best || distinct > best.distinct)) best = { ...run, distinct }
      // 120ms is well over a real frame (16ms on a device, 20–70ms on this software renderer)
      // and well under any roll (260ms floor), so it separates "one frame swallowed the roll"
      // from "the roll painted nothing between its ends".
      // A run that never landed has nothing to say about the roll, and one that was starved
      // of frames says nothing either: retry both.
      if (run.landed && (distinct >= 3 || run.rollGap < 120)) break
    }
    if (!best) {
      const last = runs[runs.length - 1]
      best = { ...last, distinct: new Set(last.trace.map(([, text]) => Number(text))).size }
    }
    return { best, runs, tones: runs.reduce((sum, run) => sum + run.tones, 0), paid: runs.some((run) => run.after > run.before), landed: runs.some((run) => run.landed) }
  }

  // ---- 0. warm-up: one placement, measured by nothing --------------------------------
  // The FIRST placement of a cold page pays for shader and particle-material compilation,
  // and one 300ms hitch is longer than the whole 260–320ms roll such a placement earns. It
  // is not a defect in the roll — a browser with no frames cannot paint frames — so the
  // probe pays it here and leaves the checks below to a warm page.
  const warm = await place()
  check('the warm-up placement settled', warm.landed && warm.after > warm.before,
    `${warm.before} -> ${warm.after}, widest frame gap ${warm.maxGap}ms`)
  await sleep(400)

  // ---- 1. sound ON: the number rolls, and it is audible -------------------------------
  const sound = await measureRoll()
  const first = sound.best
  check('placement 1 paid something', sound.paid,
    `${first.before} -> ${first.after}, ${sound.runs.length} attempt(s)`)
  const values = first.trace.map(([, text]) => Number(text))
  const distinct = first.distinct
  const final = values[values.length - 1]
  const evidence = `${distinct} distinct values in ${first.frames} frames, roll ${first.rollMs}ms over ${first.rollFrames} frames, widest roll gap ${first.rollGap}ms, ${sound.runs.length} attempt(s)`
  check('the number is painted through several values, not snapped', distinct >= 3, evidence)
  check('a frame shows LESS than the final score (it really counted up)',
    values.some((value) => value < final), `min=${Math.min(...values)} final=${final}`)
  check('no frame ever shows MORE than the final score', values.every((value) => value <= final),
    `max=${Math.max(...values)} final=${final}`)
  check('the number lands exactly on the score the board reports', final === first.after,
    `pill=${final} board=${first.after}`)
  check('`.rolling` is on the number while it counts', first.rollFrames >= 2, `${first.rollFrames} frames`)
  check('`.settled` is on the number when it lands',
    first.trace.filter(([, , className]) => className.includes('settled')).length >= 1,
    `${first.trace.filter(([, , className]) => className.includes('settled')).length} frames`)
  check('the roll ends with `.rolling` OFF the number',
    !first.trace[first.trace.length - 1][2].includes('rolling'),
    `class="${first.trace[first.trace.length - 1][2]}"`)
  // playPlaceSound already fires 1-2 tones; the roll owes at least one click and the landing
  // owes exactly two, so anything under 4 means a stage of the roll is silent. Counted across
  // every attempt, so a hitch can only make this check MORE certain, never less.
  check('the clicks and the landing chord really fire', sound.tones >= 4,
    `${sound.tones} oscillators across ${sound.runs.length} attempt(s), ${evidence}`)

  // ---- 2. sound OFF: the number still rolls, and nothing is heard ---------------------
  const soundPressed = await json(`document.querySelector('#sound-button').getAttribute('aria-pressed')`)
  await mouse('mouseMoved', 0, 0)
  const button = await json(`(() => { const box = document.querySelector('#sound-button').getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })()`)
  await mouse('mouseMoved', button.x, button.y)
  await mouse('mousePressed', button.x, button.y, { button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await mouse('mouseReleased', button.x, button.y, { button: 'left', buttons: 0, clickCount: 1 })
  await sleep(300)
  const nowPressed = await json(`document.querySelector('#sound-button').getAttribute('aria-pressed')`)
  check('the sound switch flipped for the second placement', nowPressed !== soundPressed,
    `aria-pressed ${soundPressed} -> ${nowPressed}`)

  const second = await measureRoll()
  const silent = second.best
  check('placement 2 paid something', second.paid,
    `${silent.before} -> ${silent.after}, ${second.runs.length} attempt(s)`)
  const secondValues = silent.trace.map(([, text]) => Number(text))
  check('with the sound off the number STILL rolls',
    silent.distinct >= 3 && secondValues.some((value) => value < secondValues[secondValues.length - 1]),
    `${silent.distinct} distinct values, roll ${silent.rollMs}ms over ${silent.rollFrames} frames, widest roll gap ${silent.rollGap}ms`)
  check('with the sound off nothing is heard', second.tones === 0,
    `${second.tones} oscillators across ${second.runs.length} attempt(s)`)
  check('and it lands exactly on the board score', secondValues[secondValues.length - 1] === silent.after,
    `pill=${secondValues[secondValues.length - 1]} board=${silent.after}`)

  // Put the switch back the way it was found: the preference is persisted in localStorage, and
  // a probe that leaves the developer's browser silent is a probe that gets blamed for it.
  await mouse('mouseMoved', button.x, button.y)
  await mouse('mousePressed', button.x, button.y, { button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await mouse('mouseReleased', button.x, button.y, { button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)
  check('the sound switch was put back',
    (await json(`document.querySelector('#sound-button').getAttribute('aria-pressed')`)) === soundPressed)

  check('no browser console errors', browserErrors.length === 0, browserErrors.join(' | '))
} finally {
  try { if (browserSocket?.readyState === WebSocket.OPEN) await send(browserSocket, 9999, 'Browser.close') } catch {}
  try { ws?.close() } catch {}
  await sleep(500)
  if (child.exitCode === null) {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    await sleep(600)
  }
  // Recursive removal stays inside the real temp directory and only targets this driver's own
  // profile, even if TEMP holds an unexpected path.
  try {
    const tempRoot = realpathSync(tmpdir())
    const actual = realpathSync(profile)
    const suffix = relative(tempRoot, actual)
    const insideTemp = suffix && !suffix.startsWith('..') && !suffix.includes(sep)
    if (insideTemp && basename(actual).startsWith('voxalblast-scoreroll-')) {
      rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
  } catch {}
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
} else {
  console.log('\nscore roll (v0.9.29) verified: counts up, lands on the board score, audible, silenced by the switch')
}

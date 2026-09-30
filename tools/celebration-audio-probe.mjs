// Clear-celebration × audio-lifecycle probe (v0.10.1), headless Edge over CDP.
//
//   node tools/celebration-audio-probe.mjs [url]
//   npm run probe:celebration      (needs `npm run dev` running)
//
// docs/Technical/CLEAR_CELEBRATION_AUDIO_HANDOFF.md §3/§4/§6/§8 ask for things a screenshot
// cannot show and a DOM read cannot prove:
//   * the paper budget is allocated per EVENT — L1..L5 spend the doc's own numbers, the shared
//     cell of two intersecting lines is counted ONCE, and the numbers on screen equal the ones
//     config.js ships (they are imported here rather than retyped);
//   * reduced motion is its own axis: it zeroes the FLYING decoration while the event itself
//     still happens and still says so — and it does not touch sound;
//   * ONE main cue per settled placement, and the chain milestone rides inside it instead of
//     opening a second melody;
//   * the scenes: the settings panel drops in-run cues while still allowing the explicit test
//     tone, and the finished run is exactly the state that still owes a record sound;
//   * the mute really silences the master (measured AFTER the master gain, not at the call site).
//
// The triggers come from `__voxalblastDev.demoClear()`, which builds REAL line descriptors off
// the front face's lattice and calls the very same spawnClearEffects()/playClear() the gameplay
// path calls — a mock of the pipeline would prove nothing about the pipeline.
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { CELEBRATION, AUDIO_STYLE } from '../src/rendering/config.js'

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

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-celebration-'))
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
  const click = async (selector) => {
    const box = await json(`(() => { const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
    if (!box) throw new Error(`no element for ${selector}`)
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(box.x), y: Math.round(box.y), button: 'left', buttons: 1, clickCount: 1 })
    await sleep(40)
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(box.x), y: Math.round(box.y), button: 'left', buttons: 0, clickCount: 1 })
    await sleep(120)
  }

  await send(ws, 4, 'Page.navigate', { url })
  await sleep(3500)
  const hasDemo = await evalJs('typeof globalThis.__voxalblastDev?.demoClear === "function"')
  if (!hasDemo) {
    const diag = await evalJs(`JSON.stringify({
      dev: typeof globalThis.__voxalblastDev,
      devKeys: globalThis.__voxalblastDev ? Object.keys(globalThis.__voxalblastDev) : null,
      readOnly: typeof globalThis.__voxalblast,
      readOnlyKeys: globalThis.__voxalblast ? Object.keys(globalThis.__voxalblast) : null,
      title: document.title, ready: document.readyState,
    })`)
    throw new Error(`dev handles missing: ${diag} (browser said: ${browserErrors.join(' | ') || 'nothing'})`)
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await json('globalThis.__voxalblast.intro().active')) === false) break
    await sleep(200)
  }

  const clearBus = () => evalJs('globalThis.__voxalblastDev.clearCelebration()')
  const demo = async (lines, faces = 1, milestone = 0) => {
    await clearBus()
    await evalJs('globalThis.__voxalblastDev.audioReset()')
    return json(`globalThis.__voxalblastDev.demoClear(${lines}, ${faces}, ${milestone})`)
  }
  const bus = () => json('globalThis.__voxalblast.audio()')

  // ---- 0. the check that no counter can replace -------------------------------------------
  // The first version of this file reported `liveChips=64, liveParticles=64` while the screen
  // showed NOTHING: a `RotationOverLife` behavior made every instance matrix NaN, the batch drew
  // zero pictures, and every read-out in the game was still perfectly correct. Only pixels can
  // tell "the budget was spent" from "the paper is on screen", so the board area is sampled
  // every frame from inside the page and compared against the frame BEFORE the event.
  const watchBoard = (cx, cy) => `(() => {
    const canvas = document.querySelector('canvas')
    const box = canvas.getBoundingClientRect()
    const probe = document.createElement('canvas')
    probe.width = 32; probe.height = 32
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    const sx = (${cx} - box.left) * (canvas.width / box.width) - 64
    const sy = (${cy} - box.top) * (canvas.height / box.height) - 64
    globalThis.__boardWatch = []
    const start = performance.now()
    let first = null
    const tick = () => {
      const at = Math.round(performance.now() - start)
      try {
        ctx.drawImage(canvas, sx, sy, 128, 128, 0, 0, 32, 32)
        const data = ctx.getImageData(0, 0, 32, 32).data
        if (!first) first = Array.from(data)
        let changed = 0
        for (let i = 0; i < data.length; i += 4) {
          if (Math.abs(data[i] - first[i]) > 12 || Math.abs(data[i + 1] - first[i + 1]) > 12) changed += 1
        }
        globalThis.__boardWatch.push([at, changed])
      } catch (error) { globalThis.__boardWatch.push([-1, String(error.message)]) }
      if (performance.now() - start < 1200) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
  })()`

  // ---- 1. the per-event budget, straight out of the shipped config ---------------------
  const lowPower = (await json('globalThis.__voxalblast.effects()')).lowPower
  const table = lowPower ? CELEBRATION.budgets.lowPower : CELEBRATION.budgets.standard
  const decorationCap = lowPower ? CELEBRATION.decorationCap.lowPower : CELEBRATION.decorationCap.standard
  for (const lines of [1, 2, 3, 4, 5]) {
    const report = await demo(lines)
    check(`L${lines}: the event budget is the shipped one (${table[lines]})`,
      report.event.budget === table[lines] && report.event.spawned <= table[lines],
      `budget=${report.event.budget} spawned=${report.event.spawned}`)
    check(`L${lines}: nothing on screen exceeds the budget or the decoration cap`,
      report.liveChips <= table[lines] && report.decorations <= decorationCap,
      `liveChips=${report.liveChips} decorations=${report.decorations} cap=${decorationCap}`)
    // §8: the band is the RESULT being shown and the decoration cooldown must never withhold
    // it — one band per distinct cleared segment, and never more than there were lines.
    check(`L${lines}: every line keeps its band`, report.bands === Math.min(lines, 5),
      `bands=${report.bands} lines=${lines}`)
    // The tail is a wall-clock promise (§7.3): nothing may still be flying after it.
    await sleep(CELEBRATION.tailSeconds[lines] * 1000 + 400)
    const settled = await json('globalThis.__voxalblast.effects()')
    check(`L${lines}: the tail is over inside its own wall-clock budget`,
      settled.liveChips === 0 && settled.decorations === 0,
      `after ${CELEBRATION.tailSeconds[lines]}s: liveChips=${settled.liveChips} decorations=${settled.decorations}`)
  }
  check('the whole ladder stays under the on-screen flying ceiling',
    (await json('globalThis.__voxalblast.effects()')).liveChips <= CELEBRATION.flyingCap[lowPower ? 'lowPower' : 'standard'])

  // ---- 2. an intersecting pair is ONE cell, not two ------------------------------------
  const shared = await demo(2)
  check('two intersecting lines share a cell and it is counted once',
    shared.event.uniqueCells === 9,
    `uniqueCells=${shared.event.uniqueCells} (two 5-cell lines sharing one corner)`)

  // ---- 2b. the paper is really ON SCREEN -------------------------------------------------
  {
    const centre = await json('globalThis.__voxalblast.placement().center')
    await clearBus()
    await sleep(400)
    await evalJs(watchBoard(centre.x, centre.y))
    await evalJs('globalThis.__voxalblastDev.demoClear(5, 1, 0)')
    await sleep(1500)
    const watch = await json('globalThis.__boardWatch')
    const peak = watch.reduce((best, entry) => (entry[1] > best[1] ? entry : best), [-1, -1])
    const tail = watch[watch.length - 1] || [-1, -1]
    check('the celebration actually paints pixels over the board', peak[1] >= 20,
      `peak ${peak[1]}/1024 sampled cells changed at ${peak[0]}ms (a NaN instance matrix changes 0)`)
    check('and the board is back to itself when the tail is over', tail[1] <= 4,
      `${tail[1]} cells still changed at ${tail[0]}ms`)
  }

  // ---- 2c. 手机没安全留白: less decoration, never a smaller board ------------------------
  {
    // A landscape phone is the case the design names. The viewport is emulated rather than
    // guessed at from the CSS, because the rule is stated in viewport terms.
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: 844, height: 390, screenWidth: 844, screenHeight: 390, deviceScaleFactor: 1, mobile: true,
    })
    await sleep(400)
    const cramped = await demo(5)
    check('a landscape phone gets LESS paper, not a smaller board',
      cramped.event.cramped === true && cramped.event.spawned <= Math.ceil(table[5] * 0.5)
      && cramped.liveChips <= Math.ceil(table[5] * 0.5),
      `cramped=${cramped.event.cramped} spawned=${cramped.event.spawned} liveChips=${cramped.liveChips} of budget ${table[5]}`)
    check('and it keeps every band and the decoration it is allowed',
      cramped.bands === 5 && cramped.event.decorations >= 1,
      `bands=${cramped.bands} decorations=${cramped.event.decorations}`)
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: 430, height: 900, screenWidth: 430, screenHeight: 900, deviceScaleFactor: 1, mobile: true,
    })
    await sleep(400)
    const roomy = await demo(5)
    check('and a portrait phone is back to the full budget',
      roomy.event.cramped === false && roomy.event.spawned === table[5],
      `cramped=${roomy.event.cramped} spawned=${roomy.event.spawned}`)
  }

  // ---- 3. one main cue per event, and the milestone rides inside it ---------------------
  const plain = await demo(3)
  const busAfterPlain = await bus()
  check('L3 plays ONE main cue and no stack', busAfterPlain.lastCue === 'clear-l3' && busAfterPlain.voices <= 1,
    `lastCue=${busAfterPlain.lastCue} voices=${busAfterPlain.voices}`)
  const withMilestone = await demo(3, 1, 10)
  const busAfterMilestone = await bus()
  check('the chain milestone is added INSIDE the main cue, not as a second event',
    busAfterMilestone.lastCue === 'chain-milestone' && busAfterMilestone.voices <= 2,
    `lastCue=${busAfterMilestone.lastCue} voices=${busAfterMilestone.voices}`)
  check('the milestone does not change the visual budget',
    withMilestone.event.budget === plain.event.budget,
    `${plain.event.budget} -> ${withMilestone.event.budget}`)

  // ---- 4. reduced motion closes MOTION, not the event, and not the sound ----------------
  await send(ws, nextId++, 'Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  const reduced = await demo(5)
  const reducedBus = await bus()
  check('reduced motion is read from the media query', reduced.reducedMotion === true)
  check('reduced motion flies no paper at all', reduced.liveChips === 0, `liveChips=${reduced.liveChips}`)
  check('reduced motion keeps ONE static mark (the result is still announced)',
    reduced.decorations >= 1 && reduced.decorations <= decorationCap, `decorations=${reduced.decorations}`)
  check('reduced motion does not silence the event', reducedBus.lastCue === 'clear-l5' && reducedBus.muted === false,
    `lastCue=${reducedBus.lastCue} muted=${reducedBus.muted}`)
  await send(ws, nextId++, 'Emulation.setEmulatedMedia', { features: [] })
  await sleep(150)
  const restored = await demo(5)
  check('and turning the preference back off flies paper again', restored.liveChips > 0,
    `liveChips=${restored.liveChips}`)

  // ---- 5. the mute stops the MASTER, and it is measured there ---------------------------
  // An A/B of the SAME event: measured once with the sound on — the positive control, which is
  // the case that fails if the bus never reaches the output at all — and once with it off, the
  // negative case the old oscillator count could not make. Each measurement starts from its own
  // reset, taken well after the ≤20ms mute ramp, so neither is contaminated by the other.
  await evalJs('globalThis.__voxalblastDev.audioReset()')
  await demo(2)
  const loudBus = await bus()
  check('with the sound ON the same event does reach the output', loudBus.outputPeak > 0.0005,
    `outputPeak=${loudBus.outputPeak}`)

  const soundPressed = await json(`document.querySelector('#sound-button').getAttribute('aria-pressed')`)
  await click('#sound-button')
  await sleep(400)
  const beforeMuted = await bus()
  await evalJs('globalThis.__voxalblastDev.audioReset()')
  await demo(2)
  const mutedBus = await bus()
  check('with the sound off no cue reaches the bus',
    mutedBus.cuesPlayed === beforeMuted.cuesPlayed,
    `${beforeMuted.cuesPlayed} -> ${mutedBus.cuesPlayed}, drop=${mutedBus.lastDropReason}`)
  check('with the sound off the master output is silent', mutedBus.outputPeak === 0,
    `outputPeak=${mutedBus.outputPeak} muted=${mutedBus.muted} voices=${mutedBus.voices}`)
  check('and the visual event still happened with the sound off',
    (await json('globalThis.__voxalblast.effects()')).event?.budget === table[2],
    `budget=${(await json('globalThis.__voxalblast.effects()')).event?.budget}`)
  await click('#sound-button')
  await sleep(200)
  check('the sound switch was put back',
    (await json(`document.querySelector('#sound-button').getAttribute('aria-pressed')`)) === soundPressed)

  // ---- 6. the scenes: settings drops in-run cues but allows the test tone ---------------
  await click('#settings-button')
  await sleep(200)
  const settingsScene = (await bus()).scene
  check('opening the settings panel moves the audio scene', settingsScene === 'settings', `scene=${settingsScene}`)
  const beforeSettings = await bus()
  await evalJs('globalThis.__voxalblastDev.audioReset()')
  const inSettings = await demo(2)
  const afterSettings = await bus()
  check('a placement inside the settings panel is VISUAL but silent',
    afterSettings.cuesPlayed === beforeSettings.cuesPlayed && inSettings.event.budget === table[2],
    `cues ${beforeSettings.cuesPlayed} -> ${afterSettings.cuesPlayed}, budget=${inSettings.event.budget}`)
  check('the dropped cue says why it was dropped',
    String(afterSettings.lastDropReason).endsWith(':scene:settings'), `lastDropReason=${afterSettings.lastDropReason}`)
  // OFF then ON, via the panel's own sound ROW: only the ON tap owes a test tone (§6.3 显式试音),
  // and it is allowed here. The row is used rather than the topbar button because the panel is
  // covering the topbar — a click through a modal would be testing the modal.
  await click('#sound-setting')
  await sleep(150)
  await evalJs('globalThis.__voxalblastDev.audioReset()')
  await click('#sound-setting')
  await sleep(300)
  const tested = await bus()
  check('the settings panel ALLOWS an explicit test tone',
    tested.cuesPlayed > afterSettings.cuesPlayed && tested.outputPeak > 0,
    `cues ${afterSettings.cuesPlayed} -> ${tested.cuesPlayed}, peak=${tested.outputPeak}`)
  await click('#settings-close')
  await sleep(250)
  check('closing the panel returns the bus to gameplay', (await bus()).scene === 'gameplay',
    `scene=${(await bus()).scene}`)

  // ---- 7. the result scene: exactly one ending cue, and never twice ---------------------
  await evalJs('globalThis.__voxalblastDev.audioReset()')
  const beforeEnd = await bus()
  await evalJs('globalThis.__voxalblastDev.endGame()')
  await sleep(400)
  const ended = await bus()
  check('a finished run moves the bus to the result scene', ended.scene === 'result', `scene=${ended.scene}`)
  check('the ending plays exactly one cue',
    ended.cuesPlayed - beforeEnd.cuesPlayed === 1,
    `${beforeEnd.cuesPlayed} -> ${ended.cuesPlayed}, lastCue=${ended.lastCue}`)
  check('and it is a result cue',
    ended.lastCue === 'new-best' || ended.lastCue === 'game-over', `lastCue=${ended.lastCue}`)
  const stamped = await json(`({ stamped: document.querySelectorAll('.game-over-best.stamped').length,
    paper: document.querySelectorAll('.record-paper').length })`)
  check('the record card is stamped exactly when the record cue played',
    ended.lastCue === 'new-best' ? (stamped.stamped === 1 && stamped.paper === 1) : (stamped.stamped === 0 && stamped.paper === 0),
    `lastCue=${ended.lastCue} stamped=${stamped.stamped} paper=${stamped.paper}`)
  // A language switch re-renders the card from the same summary: §4.4 forbids a second show.
  // The row lives in the settings panel, so the panel is opened for it — the card stays mounted
  // underneath, which is exactly the case that has to be proved.
  await click('#settings-button')
  await sleep(250)
  const beforeLocale = await bus()
  await click('#language-setting')
  await sleep(400)
  const afterLocale = await bus()
  const paperAfterLocale = await json(`document.querySelectorAll('.record-paper').length`)
  check('a language switch does not re-trigger the record moment',
    afterLocale.cuesPlayed === beforeLocale.cuesPlayed && paperAfterLocale <= 1,
    `cues ${beforeLocale.cuesPlayed} -> ${afterLocale.cuesPlayed}, paper=${paperAfterLocale}`)
  await click('#settings-close')
  await sleep(200)
  check('and the record cue is not repeated by a second endGame',
    await evalJs('globalThis.__voxalblastDev.endGame()') === undefined
      && (await bus()).cuesPlayed === afterLocale.cuesPlayed,
    `cues=${(await bus()).cuesPlayed}`)

  check('the bus never ran past its own voice limit',
    (await bus()).voices <= AUDIO_STYLE.voiceLimit, `voices=${(await bus()).voices}`)
  check('no browser console errors', browserErrors.length === 0, browserErrors.join(' | '))
} finally {
  try { if (browserSocket?.readyState === WebSocket.OPEN) await send(browserSocket, 9999, 'Browser.close') } catch {}
  try { ws?.close() } catch {}
  await sleep(500)
  if (child.exitCode === null) {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    await sleep(600)
  }
  try {
    const tempRoot = realpathSync(tmpdir())
    const actual = realpathSync(profile)
    const suffix = relative(tempRoot, actual)
    const insideTemp = suffix && !suffix.startsWith('..') && !suffix.includes(sep)
    if (insideTemp && basename(actual).startsWith('voxalblast-celebration-')) {
      rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
  } catch {}
}

if (failures.length) {

  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
} else {
  console.log('\ncelebration + audio lifecycle (v0.10.1) verified: per-event budgets, shared cells counted once, one main cue, reduced motion, scenes and mute')
}

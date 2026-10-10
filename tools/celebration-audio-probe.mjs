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
import { CARTOON_CLEAR, AUDIO_STYLE } from '../src/rendering/config.js'
// v0.13.3: the NORMAL clear's authority is the planner, not CELEBRATION
// (CARTOON_CLEAR_VFX_HANDOFF §9.2). CELEBRATION still owns the item bursts and the record card.
import { CARTOON_BUDGETS, clearTailSeconds } from '../src/rendering/cartoonClearPlan.js'
import { readPng } from './png-read.mjs'

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
  const demo = async (lines) => {
    await clearBus()
    await evalJs('globalThis.__voxalblastDev.audioReset()')
    return json(`globalThis.__voxalblastDev.demoClear(${lines})`)
  }
  // v0.10.3 (SCORE_REWARD_SIMPLIFICATION_HANDOFF §3): the three reward signatures. `demoReward`
  // runs the REAL rule (scoring.js settleScore) through the REAL presentation — the merged note,
  // the main cue chosen by the headline category, the reward shake — so what this probe hears is
  // what a settled placement hears.
  const demoReward = async (lines, chain = 0, wipedFaces = 0) => {
    await clearBus()
    await evalJs('globalThis.__voxalblastDev.audioReset()')
    return json(`globalThis.__voxalblastDev.demoReward(${lines}, ${chain}, ${wipedFaces})`)
  }
  const bus = () => json('globalThis.__voxalblast.audio()')

  // ---- 0. the check that no counter can replace -------------------------------------------


  // ---- 1. the per-event budget, straight out of the shipped config ---------------------
  // v0.13.3: the NORMAL clear's authority moved to `cartoonClearPlan.js`. §9.2 of
  // CARTOON_CLEAR_VFX_HANDOFF asks for exactly this: the budget/duration assertions are
  // re-pointed at the new table while the NEGATIVE assertions below (reduced motion, the mute,
  // one main cue per placement) stay exactly as they were.
  const lowPower = (await json('globalThis.__voxalblast.effects()')).lowPower
  const tier = lowPower ? 'lowPower' : 'standard'
  const table = CARTOON_BUDGETS[tier]
  const liveCap = CARTOON_CLEAR.live[tier]
  const spritePool = (report) => report.cartoon.liveSprites
  const budgetFor = (lines, cramped = false) => {
    const base = table[Math.min(lines, 3)]
    return cramped ? Math.round(base * 0.5) : base
  }
  for (const lines of [1, 2, 3, 4, 5]) {
    const report = await demo(lines)
    const expected = budgetFor(lines)
    check(`L${lines}: the event budget is the shipped one (${expected})`,
      report.event.budget === expected && report.event.spawned <= expected,
      `budget=${report.event.budget} spawned=${report.event.spawned}`)
    check(`L${lines}: nothing on screen exceeds the budget or the live ceiling`,
      spritePool(report) <= expected && spritePool(report) <= liveCap,
      `liveSprites=${spritePool(report)} liveCap=${liveCap}`)
    // §4.1: the budget is chosen from the PHYSICAL line count, so a demo of N alternating
    // row/columns must report N of them however many raw face lines the scan produced.
    check(`L${lines}: the budget follows the physical line count, not the raw face lines`,
      report.cartoon.lastPlan.physicalLineCount === lines,
      `physical=${report.cartoon.lastPlan.physicalLineCount} raw=${report.cartoon.lastPlan.rawLineCount}`)
    // The line contour is the RESULT being shown and no sprite budget may ever take it away.
    check(`L${lines}: the cleared line keeps its own contour`, report.outlines === 1,
      `outlines=${report.outlines}`)
    // The tail is a wall-clock promise (§7.3): nothing may still be flying after it.
    const tail = clearTailSeconds(lines)
    await sleep(tail * 1000 + 400)
    const settled = await json('globalThis.__voxalblast.effects()')
    check(`L${lines}: the tail is over inside its own wall-clock budget`,
      settled.cartoon.liveSprites === 0 && settled.outlines === 0,
      `after ${tail}s: liveSprites=${settled.cartoon.liveSprites} outlines=${settled.outlines}`)
  }

  // ---- 2. an intersecting pair is ONE cell, not two ------------------------------------
  const shared = await demo(2)
  check('two intersecting lines share a cell and it is counted once',
    shared.event.uniqueCells === 9,
    `uniqueCells=${shared.event.uniqueCells} (two 5-cell lines sharing one corner)`)

  // ---- 2b. the paper is really ON SCREEN -------------------------------------------------
  {
    // v0.13.3: the pixel watch only means something while the board is actually DRAWN — the home
    // cover calls `effects.setVisible(false)` and hides the FX group without stopping a single
    // counter, so an open cover would make this check report "nothing on screen" about an effect
    // that was never allowed to draw. Same dismissal `tools/cartoon-clear-probe.mjs` performs.
    await evalJs(`(() => { const el = document.querySelector('#home-primary')
      if (el && document.querySelector('#app').classList.contains('home-open')) el.click()
      return document.querySelector('#app').classList.contains('home-open') })()`)
    await sleep(500)
    const solid = (await json('globalThis.__voxalblast.framing()')).solid
    await clearBus()
    await sleep(400)
    // The pixels are read from a COMPOSITED screenshot, not from the WebGL canvas. `drawImage()`
    // on a canvas whose context was created without `preserveDrawingBuffer` is not guaranteed to
    // see anything, and the in-page watch this replaces reported "0 of 1024 cells changed" for an
    // effect the R2 captures show plainly on screen. A screenshot cannot have that failure mode.
    const boardBox = {
      x: Math.round(solid.minX), y: Math.round(solid.minY),
      width: Math.max(1, Math.round(solid.maxX - solid.minX)),
      height: Math.max(1, Math.round(solid.maxY - solid.minY)),
      scale: 1,
    }
    const grab = async () => {
      const result = await send(ws, nextId++, 'Page.captureScreenshot', {
        format: 'png', clip: { ...boardBox, scale: 1 }, captureBeyondViewport: false,
      })
      return readPng(Buffer.from(result.data, 'base64'))
    }
    const quiet = await grab()
    await evalJs('globalThis.__voxalblastDev.demoClear(5)')
    await sleep(140)
    const loud = await grab()
    await evalJs('globalThis.__voxalblastDev.clearCelebration()')
    let changed = 0
    for (let i = 0; i < quiet.pixels.length; i += quiet.channels) {
      if (Math.abs(loud.pixels[i] - quiet.pixels[i]) > 12
        || Math.abs(loud.pixels[i + 1] - quiet.pixels[i + 1]) > 12
        || Math.abs(loud.pixels[i + 2] - quiet.pixels[i + 2]) > 12) changed += 1
    }
    const total = quiet.width * quiet.height
    check('the celebration actually paints pixels over the board', changed >= Math.max(20, total * 0.0005),
      `${changed}/${total} pixels of the board box changed 140ms into a 5-line clear`)
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
    const crampedBudget = budgetFor(5, true)
    check('a landscape phone gets LESS paper, not a smaller board',
      cramped.event.cramped === true && cramped.event.spawned <= crampedBudget
      && spritePool(cramped) <= crampedBudget,
      `cramped=${cramped.event.cramped} spawned=${cramped.event.spawned} liveSprites=${spritePool(cramped)} of budget ${crampedBudget}`)
    check('and it keeps the cleared line outline',
      cramped.outlines === 1, `outlines=${cramped.outlines}`)
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: 430, height: 900, screenWidth: 430, screenHeight: 900, deviceScaleFactor: 1, mobile: true,
    })
    await sleep(400)
    const roomy = await demo(5)
    check('and a portrait phone is back to the full budget',
      roomy.event.cramped === false && roomy.event.spawned === table[Math.min(5, 3)],
      `cramped=${roomy.event.cramped} spawned=${roomy.event.spawned} of ${table[Math.min(5, 3)]}`)
  }

  // ---- 3. one main cue per event, chosen by the reward headline -------------------------
  // v0.10.3: the old assertion here was "the chain milestone rides inside the main cue", and the
  // chain milestone no longer exists. What replaced it is stronger and is what §3.2 asks for:
  // each of the three categories gets its OWN identifiable cue, a secondary streak is added as
  // one trimmed tail inside the main one, and the whole thing is still one event.
  const plain = await demo(3)
  const busAfterPlain = await bus()
  check('L3 plays ONE main cue and no stack', busAfterPlain.lastCue === 'clear-l3' && busAfterPlain.voices <= 1,
    `lastCue=${busAfterPlain.lastCue} voices=${busAfterPlain.voices}`)

  // 一次多消: the ascending clear-lN the ladder already owns — and the shake the doc states for
  // it (3 线约 2px/100ms), measured in the unit it was asked for.
  const multi = await demoReward(3)
  const busAfterMulti = await bus()
  check('a multi-clear plays the ascending clear cue', busAfterMulti.lastCue === 'clear-l3',
    `lastCue=${busAfterMulti.lastCue}`)
  check('the multi-clear shakes 2px for 100ms', multi.rewardShake?.px === 2 && multi.rewardShake?.ms === 100,
    JSON.stringify(multi.rewardShake))
  check('and its headline is reported on the event', multi.event.primaryType === 'MULTI_CLEAR',
    `${multi.event.primaryType}`)

  // 连续消除: its own two-knock cue, NOT the ascending run — that is the whole point of §3.2.
  const streak = await demoReward(1, 2)
  const busAfterStreak = await bus()
  check('a streak plays its own cue, not the ascending run', busAfterStreak.lastCue === 'streak-2',
    `lastCue=${busAfterStreak.lastCue}`)
  check('a long streak caps the cue instead of climbing', (await demoReward(1, 9)).event.primaryType === 'CLEAR_STREAK'
    && (await bus()).lastCue === 'streak-hi', `lastCue=${(await bus()).lastCue}`)
  check('the streak shake is the doc’s 1px/60ms', streak.rewardShake?.px === 1 && streak.rewardShake?.ms === 60,
    JSON.stringify(streak.rewardShake))

  // 清除整面: a paper sweep under a bright chord, deliberately NOT an ascending melody.
  const face = await demoReward(1, 1, 1)
  const busAfterFace = await bus()
  check('a face clear plays the face cue', busAfterFace.lastCue === 'face-clear', `lastCue=${busAfterFace.lastCue}`)
  check('the face clear lights the face it emptied', face.event.wipedFaces.length === 1 && face.event.primaryType === 'FACE_CLEAR',
    `wiped=${face.event.wipedFaces.join(',')} primary=${face.event.primaryType}`)
  check('the face shake is the doc’s 2px/100ms', face.rewardShake?.px === 2 && face.rewardShake?.ms === 100,
    JSON.stringify(face.rewardShake))
  // 制作人口径（2026-10-01）：净面只算落子面，一手最多一个面。所以「2+ 面 3px/140ms」那一档
  // 是不可达的，demo 入口也**造不出来** —— 它必须收窄成 1 面，而不是演示一个规则不允许的状态。
  const overFace = await demoReward(1, 1, 3)
  check('a demo cannot fabricate a two-face hand', overFace.event.wipedFaces.length === 1
    && overFace.rewardShake?.px === 2,
    `wiped=${overFace.event.wipedFaces.length} shake=${JSON.stringify(overFace.rewardShake)}`)

  // 同手多类: ONE main cue, at most ONE extra tail, and the shake is the MAXIMUM (never a sum).
  const stacked = await demoReward(3, 4, 1)
  const busAfterStacked = await bus()
  check('a three-category hand is still one event with one headline', stacked.event.primaryType === 'FACE_CLEAR',
    `${stacked.event.primaryType}`)
  check('the headline cue plays, with one streak tail inside it',
    busAfterStacked.voices === 2 && busAfterStacked.lastCue === 'streak-tail',
    `lastCue=${busAfterStacked.lastCue} voices=${busAfterStacked.voices}`)
  // 3 lines (2px) + streak (1px) + one face (2px): the answer is the MAXIMUM, so 2px — never the
  // 5px a sum would give.
  check('the stacked shake is the maximum of the three, not their sum',
    stacked.rewardShake?.px === 2 && stacked.rewardShake?.px < 2 + 1 + 2, JSON.stringify(stacked.rewardShake))
  check('and it matches the largest single category in the hand',
    stacked.rewardShake?.px === Math.max(multi.rewardShake.px, streak.rewardShake.px, face.rewardShake.px),
    `${stacked.rewardShake?.px}`)
  check('the reward never changes the visual budget',
    stacked.event.budget === table[stacked.event.level],
    `${table[stacked.event.level]} -> ${stacked.event.budget}`)
  check('and a plain clear still has no reward signature at all',
    plain.event.primaryType === null && plain.rewardShake === null,
    `primary=${plain.event.primaryType} shake=${JSON.stringify(plain.rewardShake)}`)

  // ---- 4. reduced motion closes MOTION, not the event, and not the sound ----------------
  await send(ws, nextId++, 'Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  const reduced = await demo(5)
  const reducedBus = await bus()
  check('reduced motion is read from the media query', reduced.reducedMotion === true)
  check('reduced motion flies no paper at all', spritePool(reduced) <= 1, `liveSprites=${spritePool(reduced)}`)
  check('reduced motion keeps ONE static mark (the result is still announced)',
    reduced.event.spawned >= 1 && reduced.event.spawned <= 1, `spawned=${reduced.event.spawned}`)
  check('reduced motion does not silence the event', reducedBus.lastCue === 'clear-l5' && reducedBus.muted === false,
    `lastCue=${reducedBus.lastCue} muted=${reducedBus.muted}`)
  await send(ws, nextId++, 'Emulation.setEmulatedMedia', { features: [] })
  await sleep(150)
  // v0.13.3: the burst is a REAL 110ms delay now (§5 「所有发射在140ms前完成」), so the read has to
  // come after it — the report the trigger returns only ever holds the paused systems.
  await demo(5)
  await sleep(180)
  const restored = await json('globalThis.__voxalblast.effects()')
  check('and turning the preference back off flies paper again', spritePool(restored) > 1,
    `liveSprites=${spritePool(restored)} read 180ms after the trigger`)

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

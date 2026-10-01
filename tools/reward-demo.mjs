// Reward-signature demo captures + legacy-save compatibility read-out (v0.10.3).
//
//   node tools/reward-demo.mjs [url]
//   npm run demo:rewards            (needs `npm run dev` on 127.0.0.1:5173)
//
// docs/Technical/SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §6.4 asks for five short demos —
// 一次多消 / 连续消除 / 清除整面 / 三类同手 / 静音+reduced-motion — plus a legacy-save
// compatibility result. This tool produces both halves:
//
//   * the STILLS, taken inside the page at the timestamp the design names (§3.4: the merged
//     reward note is on screen from 100–240ms), driven through `__voxalblastDev.demoReward()`,
//     which runs the real rule (scoring.js settleScore) and the real presentation;
//   * the NUMBERS, read from the same DOM the player reads (the note's own title/detail), the
//     effects report (the shake) and the audio report (which cue played), so "it looked right"
//     is never the only evidence.
//
// The compatibility half loads a REAL version-1 snapshot into localStorage and reloads: the run
// must come back on version 1, keep its board and chain, get the one-off notice, and be ranked
// against the legacy pool — never the version-2 one.
//
// Output: artifacts/visual/reward-<case>-<viewport>.png
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { t } from '../src/i18n/index.js'

const url = process.argv[2] || 'http://127.0.0.1:5173/'
// `all` (default) runs both halves; `demos` / `legacy` run one, which is what iterating on a
// single failing half needs — the full run boots the game four times.
const MODE = process.argv[3] || 'all'
// §3.4: 100–240ms is the window the note is meant to be up in. 180ms sits inside it.
const CAPTURE_MS = 180
const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900, mobile: false },
  { id: 'mobile', width: 390, height: 844, mobile: true },
]
// (lines, chain, wipedFaces) — the three counts a reward is made of, and nothing else.
const CASES = [
  { id: 'multi', label: '一次多消 3 线', lines: 3, chain: 1, faces: 0, expect: 'MULTI_CLEAR' },
  { id: 'streak', label: '连续消除 4 次', lines: 1, chain: 4, faces: 0, expect: 'CLEAR_STREAK' },
  { id: 'face', label: '清空 1 面', lines: 1, chain: 1, faces: 1, expect: 'FACE_CLEAR' },
  { id: 'stacked', label: '三类同手', lines: 3, chain: 4, faces: 1, expect: 'FACE_CLEAR' },
]

const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error('no headless browser found')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let nextId = 100
let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`OK   ${label}${detail ? `  ${detail}` : ''}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail ? `  ${detail}` : ''}`)
}

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
    const timeout = setTimeout(() => finish(new Error(`${method}: timed out`)), 20000)
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

// A version-1 save: every field the CURRENT migration whitelists, and deliberately NO
// `scoreRulesVersion` — §5.1 fixes that case as 「缺档视为版本 1」, which is exactly what has to be
// proved here rather than assumed.
function legacySnapshot() {
  return {
    v: 2,
    at: Date.now(),
    board: {
      cells: [[2, 2, 4, 0xc22b58], [2, 1, 4, 0x3f8fe0], [0, 2, 4, 0x217d6e]],
      score: 1234,
      totalLines: 7,
    },
    pieces: [
      { name: 'Dot', used: false },
      { name: 'Line 3', used: false },
      { name: 'Square', used: false },
    ],
    items: { refresh: 1, hammer: 1, rocket: 0, bomb: 1 },
    run: {
      chain: 3,
      bestChain: 4,
      maxLinesOneMove: 2,
      maxFacesOneMove: 2,
      facesLit: ['+z'],
      faceWipes: 1,
      honors: ['TRIPLE'],
      honorCounts: { TRIPLE: 1 },
    },
    pose: {},
  }
}

const outDir = join(process.cwd(), 'artifacts', 'visual')
mkdirSync(outDir, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'voxalblast-reward-'))
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  // The audio bus is unlocked by a gesture and a headless page has none. Without this the cues
  // are dropped as `locked` and "which cue played" could never be answered — the same flag
  // tools/celebration-audio-probe.mjs uses for the same reason.
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${VIEWPORTS[0].width},${VIEWPORTS[0].height}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let ws
let browserSocket = null
const written = []
try {
  let port
  for (let i = 0; i < 80; i += 1) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); break } catch { await sleep(250) }
  }
  if (!port) throw new Error('devtools never came up')
  browserSocket = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl)
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = await connect(target.webSocketDebuggerUrl)
  await send(ws, 1, 'Page.enable')
  await send(ws, 2, 'Runtime.enable')
  await send(ws, 3, 'Network.enable')

  const evalJs = async (expression) => {
    // `awaitPromise`: the audio unlock is a promise, and a page that never unlocked has an empty
    // bus — which would make "a cue played" untestable rather than false.
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const json = async (expression) => JSON.parse(await evalJs(`JSON.stringify(${expression})`))
  const shoot = async (name) => {
    const shot = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png' })
    const path = join(outDir, `${name}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    written.push(path)
  }
  const setViewport = async (viewport) => {
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height,
      screenWidth: viewport.width, screenHeight: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.mobile,
    })
  }
  const load = async (locale = 'en') => {
    await send(ws, nextId++, 'Page.navigate', { url: `${url}${url.includes('?') ? '&' : '?'}lang=${locale}` })
    await sleep(3200)
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await json('globalThis.__voxalblast.intro().active')) === false) break
      await sleep(200)
    }
    // The bus is unlocked by a gesture, and a headless page has none: without this the cues are
    // dropped as `locked` and "which cue played" could never be answered.
    await evalJs('globalThis.__voxalblastDev?.audioUnlock()')
    await sleep(120)
  }
  const hasDemo = await evalJs('typeof globalThis.__voxalblastDev?.demoReward === "function"')
  if (!hasDemo) {
    await load()
    if (!(await evalJs('typeof globalThis.__voxalblastDev?.demoReward === "function"'))) {
      throw new Error('dev handles missing: point this tool at `npm run dev` (127.0.0.1:5173)')
    }
  }

  // ---- 1. the five demos, one still each, desktop and portrait --------------------
  for (const viewport of (MODE === 'legacy' ? [] : VIEWPORTS)) {
    await setViewport(viewport)
    await load()
    for (const testCase of CASES) {
      await evalJs('globalThis.__voxalblastDev.clearCelebration()')
      await sleep(260)
      // The event is armed and the still is taken INSIDE the page's own clock: a screenshot over
      // CDP costs several hundred ms in software GL and would otherwise photograph the tail
      // rather than the moment §3.4 names.
      const report = await json(`(() => {
        const started = performance.now()
        const report = globalThis.__voxalblastDev.demoReward(${testCase.lines}, ${testCase.chain}, ${testCase.faces})
        return { report, at: performance.now() - started }
      })()`)
      await sleep(Math.max(0, CAPTURE_MS - report.at))
      await shoot(`reward-${testCase.id}-${viewport.id}`)
      const note = await json(`(() => {
        const notes = [...document.querySelectorAll('#honor-layer .reward-note')]
        const last = notes[notes.length - 1]
        return {
          count: notes.length,
          title: last?.querySelector('strong')?.textContent ?? null,
          detail: last?.querySelector('small')?.textContent ?? null,
          eventId: last?.dataset.eventId ?? null,
          className: last?.className ?? null,
        }
      })()`)
      const bus = await json('globalThis.__voxalblast.audio()')
      check(`${viewport.id} ${testCase.id}: one note, and it is the one the doc names`,
        note.count === 1 && note.title === t(`reward.${testCase.expect}.title`, { n: testCase.expect === 'MULTI_CLEAR' ? testCase.lines : testCase.expect === 'CLEAR_STREAK' ? testCase.chain : testCase.faces }),
        `count=${note.count} title="${note.title}"`)
      check(`${viewport.id} ${testCase.id}: the headline category is the doc's priority`,
        report.report.event.primaryType === testCase.expect, `${report.report.event.primaryType}`)
      check(`${viewport.id} ${testCase.id}: the detail lists every category that paid`,
        testCase.id === 'stacked' ? (note.detail || '').split(' · ').length === 3 : (note.detail || '').includes('+'),
        `detail="${note.detail}"`)
      check(`${viewport.id} ${testCase.id}: a main cue played`,
        typeof bus.lastCue === 'string' && bus.lastCue.length > 0, `cue=${bus.lastCue}`)
      check(`${viewport.id} ${testCase.id}: the reward shake is the doc's maximum`,
        report.report.rewardShake?.px > 0 && report.report.rewardShake?.px <= 3,
        JSON.stringify(report.report.rewardShake))
      await sleep(1200)
    }

    // ---- 2. the quiet case: sound off + reduced motion (§6.3's third axis) --------
    await send(ws, nextId++, 'Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    const soundPressed = await json('document.querySelector("#sound-button").getAttribute("aria-pressed")')
    if (soundPressed === 'true') {
      const box = await json(`(() => { const b = document.querySelector('#sound-button').getBoundingClientRect()
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
      await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(box.x), y: Math.round(box.y), button: 'left', buttons: 1, clickCount: 1 })
      await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(box.x), y: Math.round(box.y), button: 'left', buttons: 0, clickCount: 1 })
      await sleep(300)
    }
    await evalJs('globalThis.__voxalblastDev.clearCelebration()')
    const quietCues = (await json('globalThis.__voxalblast.audio()')).cuesPlayed
    const quiet = await json('globalThis.__voxalblastDev.demoReward(3, 4, 1)')
    await shoot(`reward-quiet-${viewport.id}`)
    const quietNote = await json(`(() => {
      const last = [...document.querySelectorAll('#honor-layer .reward-note')].pop()
      return { count: document.querySelectorAll('#honor-layer .reward-note').length, title: last?.querySelector('strong')?.textContent ?? null }
    })()`)
    const quietBus = await json('globalThis.__voxalblast.audio()')
    check(`${viewport.id} quiet: the note is still painted with the sound off and reduced motion`,
      quietNote.count === 1 && quietNote.title === t('reward.FACE_CLEAR.title', { n: 1 }),
      `count=${quietNote.count} title="${quietNote.title}"`)
    check(`${viewport.id} quiet: no cue reached the bus`,
      quietBus.cuesPlayed === quietCues, `${quietCues} -> ${quietBus.cuesPlayed} (${quietBus.lastDropReason})`)
    check(`${viewport.id} quiet: the shake is closed under reduced motion`,
      quiet.rewardShake === null && quiet.reducedMotion === true,
      `shake=${JSON.stringify(quiet.rewardShake)} reduced=${quiet.reducedMotion}`)
    await send(ws, nextId++, 'Emulation.setEmulatedMedia', { features: [] })
    if (soundPressed === 'true') {
      const box = await json(`(() => { const b = document.querySelector('#sound-button').getBoundingClientRect()
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
      await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(box.x), y: Math.round(box.y), button: 'left', buttons: 1, clickCount: 1 })
      await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(box.x), y: Math.round(box.y), button: 'left', buttons: 0, clickCount: 1 })
      await sleep(200)
    }
    await evalJs('globalThis.__voxalblastDev.clearCelebration()')
  }

  // ---- 3. the legacy save: it resumes on version 1, and nothing re-prices it -------
  if (MODE === 'demos') {
    console.log(`\nreward demos written: ${written.length} stills in artifacts/visual`)
    console.log(`checks: ${checks - failures} ok, ${failures} failed`)
    if (failures) process.exitCode = 1
    throw new Error('__stop__')
  }
  await setViewport(VIEWPORTS[0])
  await load()
  // The snapshot has to be written while the page is still here (localStorage belongs to the
  // origin) — but leaving that page makes the game save its own LIVE run over the injection
  // (main.js's visibilitychange/beforeunload handler), so the reload would read a fresh run and
  // the "legacy save" would be testing nothing. `endGame()` is the honest way to stop that: it
  // ends the run (clearing its slot and making it unsaveable) exactly as the player's own ending
  // does, after which the write below is the only thing in the slot.
  await evalJs('globalThis.__voxalblastDev.endGame()')
  await sleep(600)
  const seed = [
    ['voxalblast.session.v1', JSON.stringify(legacySnapshot())],
    ['voxalblast.records.v1', JSON.stringify({
      v: 1,
      best: { score: 250000, at: Date.now() },
      weekly: { key: null, score: 0 },
      records: { gamesPlayed: 3 },
      honors: { TRIPLE: 2 },
      recent: [{ score: 250000, lines: 40, chain: 6, facesLit: 6, honors: ['TRIPLE'], at: Date.now() }],
    })],
  ]
  for (const [key, value] of seed) await evalJs(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
  const seeded = await json(`(() => ({ session: localStorage.getItem('voxalblast.session.v1')?.length ?? null, records: localStorage.getItem('voxalblast.records.v1')?.length ?? null }))()`)
  check('legacy: the snapshot is in this origin’s storage before the reload',
    seeded.session > 100 && seeded.records > 100, JSON.stringify(seeded))
  await send(ws, nextId++, 'Page.navigate', { url: `${url}${url.includes('?') ? '&' : '?'}lang=en` })
  await sleep(3600)
  const afterReload = await json(`(() => {
    const raw = localStorage.getItem('voxalblast.session.v1')
    let stored = null
    try { stored = JSON.parse(raw) } catch { stored = null }
    return {
      session: raw?.length ?? null,
      records: localStorage.getItem('voxalblast.records.v1')?.length ?? null,
      storedChain: stored?.run?.chain ?? null,
      storedScore: stored?.board?.score ?? null,
      storedRules: stored?.run?.scoreRulesVersion ?? null,
      liveChain: globalThis.__voxalblast.run().chain,
      liveScore: globalThis.__voxalblast.board().score,
    }
  })()`)
  check('legacy: the injected snapshot is still the one on disk after the reload',
    afterReload.storedChain === 3 && afterReload.storedScore === 1234,
    JSON.stringify(afterReload))
  check('legacy: the boot resumed it instead of starting a fresh run',
    afterReload.liveChain === 3 && afterReload.liveScore === 1234, JSON.stringify(afterReload))
  const home = await json('globalThis.__voxalblast.home()')
  check('legacy: the boot resumes straight into the run, without the cover',
    home.open === false, `open=${home.open} label="${home.label}"`)
  const bestPill = await json('document.querySelector("#best").textContent')
  check('legacy: the BEST pill shows the legacy pool, not the empty version-2 one',
    bestPill === '250,000' || bestPill === '250000', `pill="${bestPill}"`)
  await shoot('reward-legacy-resumed-desktop')

  const run = await json('globalThis.__voxalblast.run()')
  const board = await json('globalThis.__voxalblast.board()')
  const toast = await json('document.querySelector("#toast").textContent')
  check('legacy: the resumed run plays the OLD rules', run.scoreRulesVersion === 1, `v${run.scoreRulesVersion}`)
  check('legacy: the chain and the score came back', run.chain === 3 && board.score === 1234,
    `chain=${run.chain} score=${board.score}`)
  check('legacy: the board came back with its cells', board.cells.length === 3, `${board.cells.length}`)
  check('legacy: the old honours are still on the run', run.honorCounts.TRIPLE === 1, JSON.stringify(run.honorCounts))
  check('legacy: the one-off notice was shown', toast === t('toast.legacyRules'), `toast="${toast}"`)
  check('legacy: no version-2 reward tally was invented', Object.values(run.rewardCounts).every((value) => value === 0),
    JSON.stringify(run.rewardCounts))
  await shoot('reward-legacy-resumed-desktop')

  // The leaderboard must rank the legacy run inside the legacy pool and say so.
  await evalJs('globalThis.__voxalblastDev.openLeaderboard()')
  await sleep(400)
  const panel = await json('document.querySelector("#leaderboard-body").textContent')
  check('legacy: the panel labels the legacy pool as the old rules',
    panel.includes(t('leaderboard.bestLegacy')) || panel.includes('old rules'), panel.slice(0, 120))
  await shoot('reward-legacy-leaderboard-desktop')

  console.log(`\nreward demos written: ${written.length} stills in artifacts/visual`)
  console.log(`checks: ${checks - failures} ok, ${failures} failed`)
  if (failures) process.exitCode = 1
} catch (error) {
  if (error.message !== '__stop__') throw error
} finally {
  try { ws?.close() } catch { /* already closed */ }
  try { browserSocket?.close() } catch { /* already closed */ }
  try { child.kill() } catch { /* already gone */ }
  try {
    const actual = realpathSync(profile)
    if (basename(actual).startsWith('voxalblast-reward-') && relative(tmpdir(), actual) && !relative(tmpdir(), actual).startsWith(`..${sep}`)) {
      rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
  } catch { /* a locked profile is not worth failing the run over */ }
}

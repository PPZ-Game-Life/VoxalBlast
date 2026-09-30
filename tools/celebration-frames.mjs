// Clear-celebration frame captures (v0.10.1), headless Edge over CDP.
//
//   node tools/celebration-frames.mjs [url]
//   npm run shot:celebration      (needs `npm run dev` running)
//
// docs/Technical/CLEAR_CELEBRATION_AUDIO_HANDOFF.md §10 R4 asks for 「对关键效果采
// 0/80/160/320/700/1400ms 帧」and says in the same breath that a single still cannot prove
// rhythm or audio-visual sync. This tool is the first half of that sentence: it drives ONE
// L5 event through the very same `__voxalblastDev.demoClear()` the gameplay path uses and
// captures the six frames, so the composition, the paper budget and the tail length can be
// LOOKED AT at the timestamps the design names. It does not claim to prove timing, and it is
// not a substitute for the on-device recording R4 still owes.
//
// Output: artifacts/visual/celebration-<level>ms-<viewport>.png
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

const url = process.argv[2] || 'http://127.0.0.1:5173/'
const FRAMES = [0, 80, 160, 320, 700, 1400]
const LEVELS = (process.argv[3] || '5').split(',').map(Number)
const VIEWPORT = process.env.VB_VIEWPORT === 'mobile'
  ? { width: 390, height: 844, mobile: true }
  : { width: 1440, height: 900, mobile: false }

const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error('no headless browser found')

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

const outDir = join(process.cwd(), 'artifacts', 'visual')
mkdirSync(outDir, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'voxalblast-frames-'))
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
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
  await send(ws, 3, 'Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height,
    screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height,
    deviceScaleFactor: 1, mobile: VIEWPORT.mobile,
  })
  const evalJs = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.text}`)
    return result.result?.value
  }
  const shoot = async (name) => {
    const shot = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png' })
    const path = join(outDir, `${name}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    written.push(path)
  }

  // The frames are taken INSIDE the page, not over CDP. `Page.captureScreenshot` costs several
  // hundred ms per call in headless software GL — longer than the whole 420ms tail of an L1
  // event — so the first version of this tool asked for "0/80/160ms" and silently returned the
  // same frozen PNG for every one of them. Reading the canvas from a rAF callback that runs
  // after the game's own gives the frame at the timestamp it claims, and because the event is
  // armed in the SAME task, t=0 is the design's t=0 (the moment the rules settled).
  const captureFrames = (level, times) => `(() => {
    const canvas = document.querySelector('canvas')
    const times = ${JSON.stringify(times)}
    globalThis.__shots = []
    const start = performance.now()
    globalThis.__voxalblastDev.demoClear(${level}, 1, 0)
    let index = 0
    const tick = () => {
      const now = performance.now() - start
      while (index < times.length && now >= times[index]) {
        // The read-out is sampled in the SAME callback as the pixels: a report read later over
        // CDP describes a different moment and would happily say "0 particles" about a frame
        // that is full of them.
        let data = ''
        try { data = canvas.toDataURL('image/png') } catch (error) { data = 'ERR:' + error.message }
        globalThis.__shots.push([times[index], data, globalThis.__voxalblast.effects()])
        index += 1
      }
      if (index < times.length) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
  })()`

  await send(ws, 4, 'Page.navigate', { url })
  await sleep(3500)
  if (!(await evalJs('typeof globalThis.__voxalblastDev?.demoClear === "function"'))) {
    throw new Error('dev handles missing: point this tool at `npm run dev`')
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!(await evalJs('globalThis.__voxalblast.intro().active'))) break
    await sleep(200)
  }
  const suffix = VIEWPORT.mobile ? 'mobile' : 'desktop'
  await shoot(`celebration-${suffix}-before`)

  for (const level of LEVELS) {
    await evalJs('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(300)
    await evalJs(captureFrames(level, FRAMES))
    await sleep(FRAMES[FRAMES.length - 1] + 600)
    const parsed = JSON.parse(await evalJs('JSON.stringify(globalThis.__shots)'))
    const event = JSON.parse(await evalJs('JSON.stringify(globalThis.__voxalblast.effects().event)'))
    for (const [at, dataUrl, report] of parsed) {
      if (String(dataUrl).startsWith('ERR:')) {
        console.log(`  L${level} @${at}ms  capture failed: ${dataUrl}`)
        continue
      }
      const path = join(outDir, `celebration-L${level}-${String(at).padStart(4, '0')}ms-${suffix}.png`)
      writeFileSync(path, Buffer.from(String(dataUrl).split(',')[1], 'base64'))
      written.push(path)
      console.log(`  L${level} @${at}ms  liveChips=${report.liveChips} liveParticles=${report.liveParticles} decorations=${report.decorations} bands=${report.bands}`)
    }
    console.log(`L${level}: budget=${event.budget} spawned=${event.spawned} decorations=${event.decorations}`)
  }
  console.log(`\n${written.length} frame(s) written to ${outDir}`)
  console.log('A still cannot prove rhythm or audio-visual sync (handoff §10 R4) — the on-device\nrecording with system sound is still owed for that.')
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
    if (suffix && !suffix.startsWith('..') && !suffix.includes(sep) && basename(actual).startsWith('voxalblast-frames-')) {
      rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
  } catch {}
}

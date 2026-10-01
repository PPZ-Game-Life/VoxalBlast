// Boot-frame capture (v0.11.2) — what the player actually sees between the first paint and the
// first playable frame, headless Edge over CDP.
//
//   node tools/boot-frames.mjs [url] [prefix]
//   npm run probe:boot        (needs `npm run dev` on 127.0.0.1:5173)
//
// Why it exists: 「重新打开游戏会卡在一个奇怪的页面」 is a claim about a SEQUENCE of frames, and a
// screenshot of the finished game cannot see it.
//
// How it measures: one NAVIGATION PER TIMESTAMP. A CDP screenshot costs several hundred ms in
// headless software GL — longer than the whole boot — so asking for "0/300/900ms" from one
// session returns the same late frame several times (the trap tools/celebration-frames.mjs
// documents). Each sample below is therefore a fresh load, and the timestamp it is labelled with
// is the delay it was actually waited. Reading the WebGL canvas from inside the page is NOT a
// substitute: with `preserveDrawingBuffer:false` that read comes back black even on a frame the
// screen is showing, which is why this tool photographs instead of sampling.
//
// Alongside each still it records which layer the DOM was showing (boot overlay / home cover /
// game) and whether the intro wave was running, so "the seam was visible" is a fact and not a
// judgement about a picture.
//
// Output: artifacts/visual/<prefix>-<ms>ms-<viewport>.png
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

const url = process.argv[2] || 'http://127.0.0.1:5173/'
const prefix = process.argv[3] || 'boot'
const TIMES = (process.env.VB_BOOT_TIMES || '0,400,900,1600,2600,4000').split(',').map(Number)
const VIEWPORT = process.env.VB_VIEWPORT === 'mobile'
  ? { id: 'mobile', width: 390, height: 844, mobile: true }
  : { id: 'desktop', width: 1440, height: 900, mobile: false }

const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error('no headless browser found')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let nextId = 100
let checks = 0
let failures = 0

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

const outDir = join(process.cwd(), 'artifacts', 'visual')
mkdirSync(outDir, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'voxalblast-boot-'))
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
  const consoleErrors = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description || 'exception')
    }
  })
  await send(ws, 1, 'Page.enable')
  await send(ws, 2, 'Runtime.enable')
  await send(ws, 3, 'Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height,
    screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height,
    deviceScaleFactor: 1, mobile: VIEWPORT.mobile,
  })
  const evalJs = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const json = async (expression) => JSON.parse(await evalJs(`JSON.stringify(${expression})`))

  const LAYERS = `(() => {
    const boot = document.getElementById('boot-screen')
    const home = document.getElementById('home')
    const app = document.getElementById('app')
    const style = boot ? getComputedStyle(boot) : null
    return {
      boot: boot ? (boot.classList.contains('done') ? 'done' : 'showing') : 'absent',
      bootState: (globalThis.__voxalblast && globalThis.__voxalblast.boot) ? globalThis.__voxalblast.boot() : null,
      bootOpacity: style ? Number(style.opacity) : null,
      home: home ? (home.classList.contains('hidden') ? 'hidden' : 'visible') : 'absent',
      homeOpen: app ? app.classList.contains('home-open') : null,
      canvas: (() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : null })(),
      intro: (globalThis.__voxalblast && globalThis.__voxalblast.intro) ? globalThis.__voxalblast.intro().active : null,
      slots: document.querySelectorAll('#piece-slots .piece-slot').length,
      paintedPx: (() => {
        // How much of the VIEWPORT is covered by the canvas the player can see. 0 means the stage
        // is not on screen at all; the boot overlay is measured separately, by bootOpacity.
        const c = document.querySelector('canvas')
        if (!c) return 0
        const box = c.getBoundingClientRect()
        return Math.round(box.width * box.height)
      })(),
    }
  })()`

  console.log(`boot timeline (${VIEWPORT.id}) — one navigation per row`)
  console.log('   ms   curtain    home     intro  slots  canvas')
  const rows = []
  for (const at of TIMES) {
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(at)
    const layers = await json(LAYERS)
    const shot = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png' })
    const path = join(outDir, `${prefix}-${String(at).padStart(4, '0')}ms-${VIEWPORT.id}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    written.push(path)
    rows.push({ at, ...layers })
    console.log(`${String(at).padStart(5)}   ${String(layers.boot).padEnd(10)} ${String(layers.home).padEnd(8)} ${String(layers.intro).padEnd(6)} ${String(layers.slots).padEnd(6)} ${layers.canvas}`)
    // A navigation replaces the page; the previous one is gone, so nothing has to be reset.
    await sleep(250)
  }

  // ---- the contract this tool exists to hold ---------------------------------------------
  // 1. From the FIRST paint until the scene is complete, the curtain is up. `absent` means the
  //    element was already removed (i.e. the curtain lifted) — the same thing as `done`.
  const covered = rows.filter((row) => row.at <= 900)
  check('every early frame is behind the curtain',
    covered.every((row) => row.boot === 'showing'),
    covered.map((row) => `${row.at}ms:${row.boot}`).join(' '))
  // 2. Nothing incomplete is ever on screen: for every sample, either the curtain is up or the
  //    tray is full. This is the property the producer's 「奇怪的页面」 was a violation of.
  const seams = rows.filter((row) => row.boot !== 'showing' && row.slots < 3)
  check('no frame shows an empty tray outside the curtain', seams.length === 0,
    seams.map((row) => `${row.at}ms:slots=${row.slots}`).join(' '))
  // 3. The page-load path settles the opening wave instead of playing it (v0.11.2).
  const afterBoot = rows.filter((row) => row.at >= 2600)
  check('the page-load path never plays the opening wave',
    afterBoot.every((row) => row.intro === false),
    afterBoot.map((row) => `${row.at}ms:intro=${row.intro}`).join(' '))
  // 4. It really lifts, and on its own.
  const last = rows[rows.length - 1]
  check('the curtain lifts by the end of the run', last.boot === 'done' || last.boot === 'absent',
    `${last.at}ms:${last.boot}`)
  check('and it lifts because the scene was READY, not because the timeout saved it',
    last.bootState?.reason === 'ready',
    `reason=${last.bootState?.reason} elapsed=${last.bootState?.elapsed}ms`)
  // 5. …and it does not make the player wait. The curtain is a curtain, not a progress bar: the
  //    whole page-load path has to be done inside this budget on the reference desktop.
  check('the curtain is up for less than 2s', last.bootState?.elapsed < 2000,
    `elapsed=${last.bootState?.elapsed}ms`)
  if (consoleErrors.length) console.log(`console errors: ${consoleErrors.join(' | ')}`)
  else console.log('console errors: none')
  console.log(`stills: ${written.length} in artifacts/visual`)
  console.log(`checks: ${checks - failures} ok, ${failures} failed`)
  if (failures) process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* already closed */ }
  try { browserSocket?.close() } catch { /* already closed */ }
  try { child.kill() } catch { /* already gone */ }
  try {
    const actual = realpathSync(profile)
    if (basename(actual).startsWith('voxalblast-boot-') && !relative(tmpdir(), actual).startsWith(`..${sep}`)) {
      rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
  } catch { /* a locked profile is not worth failing the run over */ }
}

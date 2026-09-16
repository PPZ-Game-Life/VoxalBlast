// Desktop + mobile screenshot driver for VoxalBlast (headless Edge over CDP).
//
// Why this exists instead of `msedge --screenshot=...`: `--screenshot` can only
// capture the FIRST frame, and VoxalBlast opens on the home cover, so the raw flag
// gives you the home screen and nothing else — the board is never in the picture.
// This driver clicks through `#home-primary` first, and it also collects
// window.onerror / unhandledrejection, which is how a rename slip that blanked the
// whole board was caught in one run instead of by eye.
//
// No puppeteer: Node 18+ has a global WebSocket, and CDP is JSON over it. The repo
// deliberately has no browser-automation dependency.
//
//   node tools/screenshot.mjs [url] [outDir]
//   npm run shot
//
// Defaults: url http://127.0.0.1:5173/, outDir artifacts/visual (gitignored).
// Writes <outDir>/v<package.version>-desktop-home.png, -desktop-board.png and
// -mobile-board.png and -widescreen-board.png, then prints a DOM/error probe.
//
// Pitfalls this driver already handles, do not re-solve them:
//   - Device emulation, not --window-size, establishes the actual mobile viewport.
//     The probe asserts both CSS layout and PNG dimensions so cropping cannot pass.
//   - Every capture uses a fresh temp profile and an OS-assigned debugging port.
//   - Browser.close lets Edge stop its process tree before the validated temp
//     profile is removed; an owned-process fallback handles failed browser startup.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const url = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const outDir = resolve(ROOT, process.argv[3] || 'artifacts/visual')

const SHOTS = [
  { name: 'desktop-home', width: 1440, height: 900, mode: 'home' },
  { name: 'desktop-board', width: 1440, height: 900, mode: 'board' },
  { name: 'mobile-board', width: 390, height: 844, mode: 'board' },
  { name: 'widescreen-board', width: 2048, height: 900, mode: 'board' },
]

// Only the screenshot page receives this seed; gameplay remains genuinely random.
const CAPTURE_SEED = 20260916

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findBrowser() {
  for (const path of EDGE_CANDIDATES) if (path && existsSync(path)) return path
  throw new Error(`no headless browser found; tried:\n  ${EDGE_CANDIDATES.join('\n  ')}`)
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

async function waitForExit(child, timeoutMs = 5000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((ok) => {
    const done = () => { clearTimeout(timeout); ok(true) }
    const timeout = setTimeout(() => { child.removeListener('exit', done); ok(false) }, timeoutMs)
    child.once('exit', done)
  })
}

async function closeBrowser(child, browserSocket, pageSocket, profile) {
  if (browserSocket?.readyState === WebSocket.OPEN) {
    // Edge may close the socket before replying; process exit is the confirmation.
    await send(browserSocket, 1000, 'Browser.close').catch(() => {})
  }
  if (pageSocket?.readyState === WebSocket.OPEN) pageSocket.close()
  if (browserSocket?.readyState === WebSocket.OPEN) browserSocket.close()
  let exited = await waitForExit(child)
  if (!exited && child.pid) {
    if (process.platform === 'win32') {
      const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      cleanup.on('error', () => {})
      await waitForExit(cleanup)
    } else child.kill('SIGTERM')
    exited = await waitForExit(child)
  }
  if (!exited) throw new Error(`capture browser did not exit; retained profile ${profile}`)

  // Recursive removal must remain inside the real temp directory and target only
  // this driver's newly created profile, even if TEMP contains an unexpected path.
  const tempRoot = realpathSync(tmpdir())
  const actualProfile = realpathSync(profile)
  const suffix = relative(tempRoot, actualProfile)
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)
    || !basename(actualProfile).startsWith('voxalblast-shot-')) {
    throw new Error(`refusing to remove profile outside capture temp directory: ${actualProfile}`)
  }
  try {
    rmSync(actualProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch (error) {
    // Edge/Windows may hold cache files briefly after Browser.close succeeds.
    // A retained temp profile is a cleanup warning, not a rendering-test failure.
    if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
    console.warn(`WARN cleanup: retained locked temp profile ${actualProfile} (${error.code})`)
  }
}

async function capture(browser, shot) {
  const { width, height, mode } = shot
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const profile = mkdtempSync(join(tmpdir(), 'voxalblast-shot-'))
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
      '--run-all-compositor-stages-before-draw',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let startupError = null
    child.on('error', (error) => { startupError = error })
    let ws = null
    let browserSocket = null
    let captureError = null

    try {
      let browserInfo = null
      let port
      for (let i = 0; i < 80; i += 1) {
        if (startupError) throw startupError
        try {
          port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
          browserInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
          break
        } catch { await sleep(250) }
      }
      if (!browserInfo) continue
      browserSocket = await connect(browserInfo.webSocketDebuggerUrl)

      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
      ws = await connect(target.webSocketDebuggerUrl)
      const browserErrors = []
      const graphicsFailure = /shader|gl_invalid|invalid_operation|invalid_enum|invalid_value|context lost/i
      ws.addEventListener('message', (event) => {
        const { method, params } = JSON.parse(event.data)
        if (method === 'Runtime.consoleAPICalled') {
          const message = params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
          if (params.type === 'error' || (params.type === 'warning' && graphicsFailure.test(message))) {
            browserErrors.push(`console.${params.type}: ${message}`)
          }
        } else if (method === 'Log.entryAdded') {
          const { level, text, source, url: sourceUrl } = params.entry
          if (level === 'error' || (level === 'warning' && graphicsFailure.test(text))) {
            browserErrors.push(`${source}.${level}: ${text}${sourceUrl ? ` @ ${sourceUrl}` : ''}`)
          }
        }
      })

      await send(ws, 1, 'Page.enable')
      await send(ws, 2, 'Runtime.enable')
      await send(ws, 20, 'Log.enable')
      await send(ws, 3, 'Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => { let seed = ${CAPTURE_SEED}; Math.random = () => {
          seed = (seed + 0x6d2b79f5) >>> 0;
          let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
          value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
          return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        }; })(); globalThis.__errs = [];`
          + 'addEventListener("error", (e) => globalThis.__errs.push(String(e.message) + " @ " + String(e.filename) + ":" + String(e.lineno)));'
          + 'addEventListener("unhandledrejection", (e) => globalThis.__errs.push("rejection: " + String((e.reason && e.reason.stack) || e.reason)));',
      })
      await send(ws, 4, 'Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: width < 600 })
      await send(ws, 5, 'Page.navigate', { url })
      await sleep(3200)

      if (mode === 'board') {
        const click = await send(ws, 6, 'Runtime.evaluate', {
          expression: '(() => { const b = document.querySelector("#home-primary"); if (!b) return "no-button"; b.click(); return "clicked"; })()',
          returnByValue: true,
        })
        if (click.result?.value !== 'clicked') throw new Error(`home cover not dismissed: ${click.result?.value}`)
        await sleep(2600)
      }

      // Two rAFs and a short pause: the last state has to reach the compositor,
      // otherwise the capture can lag the very thing under test by a frame.
      await send(ws, 7, 'Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true })
      await send(ws, 21, 'Runtime.evaluate', {
        expression: 'Promise.all([...document.querySelectorAll(".pastoral-backdrop img")].map(image => image.decode().catch(() => {})))',
        awaitPromise: true,
      })
      await sleep(400)

      const probe = await send(ws, 8, 'Runtime.evaluate', {
        expression: `(() => {
          const layer = document.querySelector('.pastoral-backdrop')
          const svg = layer && layer.querySelector('svg')
          const image = layer && layer.querySelector('img')
          const r = layer && layer.getBoundingClientRect()
          return JSON.stringify({
            backdrop: !!layer && !!svg && Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight,
            backdropImage: image ? { loaded: image.complete && image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight } : null,
            viewport: { width: innerWidth, height: innerHeight },
            rendering: globalThis.__voxalblast?.rendering?.() ?? null,
            backdropZ: layer ? getComputedStyle(layer).zIndex : null,
            woodGrain: getComputedStyle(document.documentElement).getPropertyValue('--wood-grain').slice(0, 26),
            version: ${JSON.stringify(version)},
            home: document.querySelector('#home').className,
            canvases: document.querySelectorAll('canvas').length,
            errors: globalThis.__errs || [],
          })
        })()`,
        returnByValue: true,
      })
      if (probe.exceptionDetails) throw new Error(`${shot.name}: probe threw — ${probe.exceptionDetails.exception?.description || probe.exceptionDetails.text}`)

      const shot_ = await send(ws, 9, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const out = join(outDir, `v${version}-${shot.name}.png`)
      mkdirSync(outDir, { recursive: true })
      const png = Buffer.from(shot_.data, 'base64')
      writeFileSync(out, png)
      const parsed = JSON.parse(probe.result.value)
      parsed.errors = [...new Set([...parsed.errors, ...browserErrors])]
      parsed.screenshot = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      const failures = []
      if (parsed.errors.length) failures.push('browser/runtime errors')
      if (!parsed.backdrop) failures.push('backdrop SVG fallback or viewport coverage missing')
      if (!parsed.backdropImage?.loaded) failures.push('background image missing or not loaded')
      if (parsed.viewport.width !== width || parsed.viewport.height !== height) failures.push('incorrect CSS viewport')
      if (parsed.screenshot.width !== width || parsed.screenshot.height !== height) failures.push('incorrect PNG dimensions')
      if (parsed.rendering?.meshes !== 98 || parsed.rendering?.uniqueCells !== 98) failures.push('board must contain exactly 98 unique meshes')
      const clean = failures.length === 0
      console.log(`${clean ? 'OK  ' : 'FAIL'} ${shot.name.padEnd(13)} ${width}x${height}  ${out}`)
      console.log(`     ${JSON.stringify(parsed)}`)
      if (!clean) throw new Error(`${shot.name}: ${failures.join('; ')}`)
      return
    } catch (error) {
      captureError = error
      throw error
    } finally {
      try {
        await closeBrowser(child, browserSocket, ws, profile)
      } catch (error) {
        // Preserve the original test failure and its stack even if browser cleanup
        // independently fails; report the cleanup issue alongside it.
        if (!captureError) throw error
        console.warn(`WARN cleanup after ${shot.name} failure: ${error.message}`)
      }
    }
  }
  throw new Error(`${shot.name}: devtools never came up after 3 attempts`)
}

const browser = findBrowser()
console.log(`browser ${browser}\ntarget  ${url}\nversion v${version}\n`)
for (const shot of SHOTS) await capture(browser, shot)

// Desktop + mobile screenshot driver for VoxalBlast (headless Edge over CDP).
//
// Why this exists instead of `msedge --screenshot=...`: `--screenshot` can only
// capture the FIRST frame, and VoxalBlast opens on the home cover, so the raw flag
// gives you the home screen and nothing else — the board is never in the picture.
// This driver navigates and waits for the opening creation wave to settle — the game
// boots straight into a run (v0.8.22), so the home shots are taken by going through
// settings → 回到主页, the way a player gets there. It also collects
// window.onerror / unhandledrejection, which is how a rename slip that blanked the
// whole board was caught in one run instead of by eye.
//
// No puppeteer: Node 18+ has a global WebSocket, and CDP is JSON over it. The repo
// deliberately has no browser-automation dependency.
//
//   node tools/screenshot.mjs [url] [outDir]
//   npm run shot
//   SHOT_REFLECTION_SWEEP=1 adds held-drag angle captures + pose JSON for board shots.
//   SHOT_GEM_COMPARE=1 also captures the same pose with volume response disabled.
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
  { name: 'mobile-home', width: 390, height: 844, mode: 'home' },
  { name: 'desktop-home-return', width: 1440, height: 900, mode: 'home-return' },
  { name: 'desktop-board', width: 1440, height: 900, mode: 'board' },
  // v0.13.0 R7: the handoff §13.1's viewport list is 1440×900 / 1280×720 / 390×844 / 320×740 /
  // 844×390 / 2048×900. Five of the six were already here; 1280×720 was the one being graded by
  // nothing, and it is the laptop size where the HUD's clamp(`--plaque-width`, 220–350px) and the
  // 16:9 canvas both change shape.
  { name: 'desktop720-board', width: 1280, height: 720, mode: 'board' },
  { name: 'mobile-board', width: 390, height: 844, mode: 'board' },
  { name: 'small-mobile-board', width: 320, height: 740, mode: 'board' },
  { name: 'landscape-board', width: 844, height: 390, mode: 'board' },
  { name: 'widescreen-board', width: 2048, height: 900, mode: 'board' },
  // v0.8.15: the Game Over card is now a first-class capture. It was reachable only
  // on a shell jam (rare before the pool expansion), which is exactly why a CSS rule
  // that hid its PLAY AGAIN button on every viewport ≤900px survived from 2026-09-07
  // to here: no mobile run ever ended. These two shots are the hard gate — mobile
  // first, because that is the width where the button used to disappear.
  { name: 'mobile-gameover', width: 390, height: 844, mode: 'gameover' },
  { name: 'desktop-gameover', width: 1440, height: 900, mode: 'gameover' },
  // v0.9.18: the two panels that carry the most COPY, and therefore the two surfaces a
  // language can break. Every string in them is now looked up from src/i18n/locales/*, and
  // copy has no fixed width: English reads longer than Chinese in the record list, Chinese
  // reads longer in a two-word button. Screenshot both languages with
  // `node tools/screenshot.mjs "http://127.0.0.1:5173/?lang=zh-Hans" artifacts/visual-zh`.
  { name: 'desktop-settings', width: 1440, height: 900, mode: 'settings' },
  { name: 'mobile-settings', width: 390, height: 844, mode: 'settings' },
  { name: 'desktop-leaderboard', width: 1440, height: 900, mode: 'leaderboard' },
  { name: 'mobile-leaderboard', width: 390, height: 844, mode: 'leaderboard' },
  // v0.12.0: the panel's other view — MY RECORDS, the local record wall. The two shots above open
  // on the tab the panel really starts on (GLOBAL, the seasonal board), so the pair covers the
  // whole surface; a tab that only renders when it is clicked would be invisible to the other.
  { name: 'desktop-leaderboard-local', width: 1440, height: 900, mode: 'leaderboard-local' },
  { name: 'mobile-leaderboard-local', width: 390, height: 844, mode: 'leaderboard-local' },
]

// Only the screenshot page receives this seed; gameplay remains genuinely random.
//
// v0.8.17: `SHOT_SEED=<n> npm run shot` re-rolls the draw. The fixed seed is what
// makes a run reproducible, but it also freezes WHICH candidate colours are on
// screen — and a fixed seed that never deals, say, `L 5` cannot show whether a new
// paint reads against the timber, which is exactly what a colour change has to prove.
// Three or four seeds cover the 14-shape pool; each run is still fully deterministic.
const CAPTURE_SEED = Number(process.env.SHOT_SEED || 20260916)
const SURFACE_FALLBACK = process.env.SHOT_SURFACE === 'fallback'
// Inject only into this driver's disposable browser profile, never the player's
// browser. Used to verify a continued game, not just a freshly dealt palette.
const sessionFixture = process.env.SHOT_SESSION
  ? JSON.parse(readFileSync(resolve(ROOT, process.env.SHOT_SESSION), 'utf8')) : null

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
          if (SURFACE_FALLBACK && source === 'network' && sourceUrl?.endsWith('/art/block-pigment.webp')) return
          if (level === 'error' || (level === 'warning' && graphicsFailure.test(text))) {
            browserErrors.push(`${source}.${level}: ${text}${sourceUrl ? ` @ ${sourceUrl}` : ''}`)
          }
        }
      })

      await send(ws, 1, 'Page.enable')
      await send(ws, 2, 'Runtime.enable')
      await send(ws, 20, 'Log.enable')
      if (SURFACE_FALLBACK) {
        await send(ws, 23, 'Network.enable')
        await send(ws, 24, 'Network.setBlockedURLs', { urls: ['*/art/block-pigment.webp'] })
      }
      await send(ws, 3, 'Page.addScriptToEvaluateOnNewDocument', {
        source: (sessionFixture ? `localStorage.setItem('voxalblast.session.v1', ${JSON.stringify(JSON.stringify(sessionFixture.snapshot))});` : '')
          + (sessionFixture?.records ? `localStorage.setItem('voxalblast.records.v1', ${JSON.stringify(JSON.stringify(sessionFixture.records))});` : '')
          + `(() => { let seed = ${CAPTURE_SEED}; Math.random = () => {
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
      await sleep(3600)

      // v0.8.22 (03 §1): the game now OPENS inside a run, so there is no home cover to
      // dismiss and no click needed for the board shots. 主页 is reached the way a player
      // reaches it — settings → 回到主页 — which is also what the two home shots grade.
      // Every mode waits for the opening creation wave to finish first: it holds the input
      // lock, so a shot (or a dev-handle click) taken mid-wave would grade a half-built
      // cube and a locked board.
      let nextId = 200
      let wave = null
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const read = await send(ws, nextId++, 'Runtime.evaluate', {
          expression: 'JSON.stringify((() => { const i = globalThis.__voxalblast?.intro?.(); return i ? { active: i.active, plays: i.plays, total: i.total } : null })())',
          returnByValue: true,
        })
        const raw = read.result?.value
        wave = raw && raw !== 'null' ? JSON.parse(raw) : null
        if (wave && !wave.active) break
        await sleep(150)
      }
      // v0.13.0 R5 (handoff §8.7): pin the board's idle float at zero before anything is graded.
      // The float is a live animation now, so without this the same build photographs at a
      // different board height every run and the framing band/ratio read-outs stop being
      // comparable between runs — which is the whole point of a fixed capture seed.
      //
      // v0.13.0 R4 (KNOWN_GAPS §3 / §C0.4): and the SCENERY's ambient clock, which is a second,
      // independent one. Pinning only the board left the clouds and the buildings running, so
      // two captures of the same build still differed pixel for pixel. Both pins now go through
      // the same call shape, and the gate below reads them back rather than trusting them.
      await send(ws, nextId++, 'Runtime.evaluate', {
        expression: '(() => { const d = globalThis.__voxalblastDev; if (!d) return "no-dev-handle";'
          + ' return { board: d.setBoardFloat?.({ frozen: true, time: 0 }) ?? null,'
          + ' ambient: d.setAmbient?.({ frozen: true, time: 0 }) ?? null }; })()',
        returnByValue: true,
      })
      if (mode === 'home' || mode === 'home-return') {
        await send(ws, nextId++, 'Runtime.evaluate', {
          expression: '(() => { document.querySelector("#settings-button").click(); document.querySelector("#home-setting").click(); return "home"; })()',
          returnByValue: true,
        })
        await sleep(700)
      }

      // The Game Over card cannot be reached by playing (endGame() fires only on a
      // shell jam), so the shot goes through the dev-only handle. It exists only on
      // the dev server: a production build deliberately ships no such hook, and a
      // capture that silently fell back to the home screen would be a false pass.
      if (mode === 'gameover') {
        const ended = await send(ws, 22, 'Runtime.evaluate', {
          expression: '(() => { const dev = globalThis.__voxalblastDev; if (typeof dev?.endGame !== "function") return "no-dev-handle"; dev.endGame(); return "ended"; })()',
          returnByValue: true,
        })
        if (ended.result?.value !== 'ended') throw new Error(`game over shot needs the dev server (${ended.result?.value}); point npm run shot at npm run dev`)
        await sleep(900)
      }

      // v0.9.18 (docs/Technical/LOCALIZATION.md): the settings panel is the densest text
      // surface in the game — eight rows, each a title over a subtitle — and it is where the
      // language row lives. Opened through the real gear, so the shot is of the shipped path.
      if (mode === 'settings') {
        await send(ws, nextId++, 'Runtime.evaluate', {
          expression: '(() => { document.querySelector("#settings-button").click(); return "settings"; })()',
          returnByValue: true,
        })
        await sleep(600)
      }

      // The leaderboard is captured from a FINISHED run (the Game Over card's own entry), not
      // from the home cover: the cover would hide the live board behind the panel and every
      // board gate below would be graded on a covered scene.
      if (mode === 'leaderboard' || mode === 'leaderboard-local') {
        const ended = await send(ws, 23, 'Runtime.evaluate', {
          expression: '(() => { const dev = globalThis.__voxalblastDev; if (typeof dev?.endGame !== "function") return "no-dev-handle"; dev.endGame(); return "ended"; })()',
          returnByValue: true,
        })
        if (ended.result?.value !== 'ended') throw new Error(`leaderboard shot needs the dev server (${ended.result?.value}); point npm run shot at npm run dev`)
        await sleep(600)
        await send(ws, nextId++, 'Runtime.evaluate', {
          expression: '(() => { document.querySelector("#leaderboard-button").click(); return "open"; })()',
          returnByValue: true,
        })
        await sleep(600)
        // The panel opens on GLOBAL; the local wall is the second tab, switched the way a player
        // switches it (a real click on the tab, not a second render path).
        if (mode === 'leaderboard-local') {
          await send(ws, nextId++, 'Runtime.evaluate', {
            expression: '(() => { document.querySelector("#lb-tab-local").click(); return "tab"; })()',
            returnByValue: true,
          })
          await sleep(500)
        }
      }

      // Two rAFs and a short pause: the last state has to reach the compositor,
      // otherwise the capture can lag the very thing under test by a frame.
      await send(ws, 7, 'Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true })
      await send(ws, 21, 'Runtime.evaluate', {
        expression: 'Promise.all([...document.querySelectorAll(".pastoral-backdrop img")].map(image => image.decode().catch(() => {})))',
        awaitPromise: true,
      })
      // v0.9.16: derive the score plaque's BOARD-edge ratio from the art, on every run. The
      // plaque does not begin with the board — its leaf decoration runs along the top edge — so
      // the row that matters is the first whose longest opaque run spans half the slice. Done in
      // the page (same origin, so getImageData is allowed) so the probe needs no PNG decoder of
      // its own and cannot drift from what the browser actually paints. Separate evaluate call
      // because the main probe below is a synchronous IIFE.
      await send(ws, 22, 'Runtime.evaluate', {
        expression: `(async () => {
          try {
            const img = new Image()
            // v0.13.0 R6: the plaque asset is the floating-world SVG now. The measurement is
            // asset-agnostic on purpose — it rasterises whatever the skin actually paints and
            // finds the first row that is mostly solid — so it follows the art instead of being
            // re-typed beside it. (An SVG with an intrinsic size rasterises exactly like a PNG.)
            img.src = './art/floating-world-v1/ui/score-panel.svg'
            await img.decode()
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            ctx.drawImage(img, 0, 0)
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
            for (let y = 0; y < canvas.height; y += 1) {
              let best = 0, run = 0
              for (let x = 0; x < canvas.width; x += 1) {
                if (data[(y * canvas.width + x) * 4 + 3] > 8) { run += 1; if (run > best) best = run }
                else run = 0
              }
              if (best >= canvas.width * 0.5) { globalThis.__artBoardTopRatio = y / canvas.height; return true }
            }
            globalThis.__artBoardTopRatio = null
            return false
          } catch { globalThis.__artBoardTopRatio = null; return false }
        })()`,
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
            framing: globalThis.__voxalblast?.framing?.() ?? null,
            playLayout: (() => {
              const cube = globalThis.__voxalblast?.framing?.()?.solid
              if (!cube) return null
              const tray = document.querySelector('.bottom-panel').getBoundingClientRect()
              const tools = document.querySelector('#item-bar').getBoundingClientRect()
              // v0.9.14: the room the bottom turn dwell actually has — from the cube's bottom
              // edge down to the tray, minus the lift a TOUCH carry adds to the measured centre
              // (12px + half the piece's own height). A 3-row piece is the widest the pool has,
              // so that is the case the layout has to leave room for. A mouse carry only lifts
              // the centre 10px, so desktop is graded on that instead — the lift is clamped to
              // the room above the cube, and on a desktop the cube is already saturated.
              const cellPx = Math.hypot(...['dx', 'dy'].map((k) => globalThis.__voxalblast.placement().uAxis[k]))
              const touchLift3 = 12 + Math.min(3 * cellPx * 0.5, 120)
              const mouseLift = 10
              const band = tray.top - cube.maxY
              const hud = document.querySelector('.score-plaque').getBoundingClientRect()
              const gear = document.querySelector('#settings-button').getBoundingClientRect()
              // v0.9.16: the ratio the layout used, read from the stylesheet — the HUD is graded
              // against the BOARD's top edge, not the plaque element's (the leaf decoration
              // sticks out above the board, which is what made the device screenshot look wrong).
              const boardTop = Number(getComputedStyle(document.documentElement).getPropertyValue('--plaque-board-top'))
              return {
                widthShare: (cube.maxX - cube.minX) / innerWidth,
                heightShare: (cube.maxY - cube.minY) / innerHeight,
                clearOfTools: cube.minY >= tools.bottom,
                clearOfTray: cube.maxY <= tray.top,
                turnBandPx: band,
                turnBandFor3Row: band - touchLift3,
                turnBandForMouse: band - mouseLift,
                // The button's top against the BOARD's top edge (plaque top + its board offset).
                boardTopRatio: boardTop,
                hudTopDelta: gear.top - (hud.top + hud.height * boardTop),
              }
            })(),
            artBoardTopRatio: globalThis.__artBoardTopRatio ?? null,
            resumedBoard: ${Boolean(sessionFixture)} ? globalThis.__voxalblast?.board?.() : null,
            gameLayers: [...document.querySelectorAll('.topbar, .game-layout')].map(el => ({ visibility: getComputedStyle(el).visibility, inert: el.inert, width: el.clientWidth, height: el.clientHeight })),
            candidateFrames: globalThis.__voxalblast?.candidateFrames?.() ?? [],
            // v0.9.32 R0 (BLOCK_REFERENCE_REWORK_HANDOFF §5.3): the candidate tray's real
            // CSS pixels. This block reads LAYOUT BOXES only -- it deliberately does not
            // re-derive the preview camera's ortho fit, because diagnostics must not copy a
            // projection algorithm (plan §2.1). Per-cell pitch is paired offline: the
            // projected NDC box from candidateFrames above times the canvas CSS width, over
            // the shape's own cell span, which the analysis side knows from shapes.js.
            pieceMetrics: [...document.querySelectorAll('.piece-slot')].map((slot, index) => {
              const rect = (el) => {
                if (!el) return null
                const r = el.getBoundingClientRect()
                return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }
              }
              return {
                index,
                className: slot.className,
                slot: rect(slot),
                canvas: rect(slot.querySelector('canvas')),
                thumb: rect(slot.querySelector('.piece-thumb')),
              }
            }),
            trayMetrics: (() => {
              const el = document.querySelector('.bottom-panel')
              if (!el) return null
              const r = el.getBoundingClientRect()
              return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }
            })(),
            // The board's own lattice pitch on screen, from the same axis the placement probe
            // already publishes -- one world cell in CSS px, no second implementation.
            boardCellPx: (() => {
              const u = globalThis.__voxalblast?.placement?.()?.uAxis
              return u ? +Math.hypot(u.dx, u.dy).toFixed(2) : null
            })(),
            devicePixelRatio: devicePixelRatio,
            canvasPx: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height })),
            scoreTextContained: [...document.querySelectorAll('#score, #best, .score-chip-label, .best-chip-label')].every(el => {
              const range = document.createRange()
              range.selectNodeContents(el)
              const text = range.getBoundingClientRect(), box = el.getBoundingClientRect()
              return text.left >= box.left - 1 && text.right <= box.right + 1 && text.top >= box.top - 1 && text.bottom <= box.bottom + 1
            }),
            candidateCanvasesContained: [...document.querySelectorAll('.piece-preview-canvas')].every(canvas => {
              const c = canvas.getBoundingClientRect(), s = canvas.closest('.piece-slot').getBoundingClientRect()
              return c.left >= s.left && c.right <= s.right && c.top >= s.top && c.bottom <= s.bottom
            }),
            // v0.9.21: the old skin's drawings must not survive underneath the reference skin's PNG
            // art. Checking visibility on the svg itself is NOT enough -- visibility inherits, so a
            // carving nested inside a host the skin turned back to visible ('.item-icon' on the item
            // strip) paints again, and the real phone showed two icons at once. A legacy drawing that
            // still paints inside a host carrying reference art is a failure, whatever hides it.
            // (No backticks in this block: it is one big template literal.)
            legacyArtHidden: [...document.querySelectorAll('svg.toy-icon')].every(svg => {
              const host = svg.parentElement
              const cs = getComputedStyle(svg)
              const box = svg.getBoundingClientRect()
              const hostHasArt = getComputedStyle(host).backgroundImage !== 'none'
              const paints = cs.visibility !== 'hidden' && cs.display !== 'none' && box.width > 0 && box.height > 0
              return !(hostHasArt && paints)
            }),
            backdropZ: layer ? getComputedStyle(layer).zIndex : null,
            woodGrain: getComputedStyle(document.documentElement).getPropertyValue('--wood-grain').slice(0, 26),
            version: ${JSON.stringify(version)},
            // v0.8.21: the version tag ships in the release build and must be READABLE
            // on every viewport, including 320px. It is the only way to tell which
            // build a phone is running, and it was silently dev-only before.
            versionBadge: (() => {
              const el = document.querySelector('#app-version')
              if (!el) return null
              const cs = getComputedStyle(el)
              const box = el.getBoundingClientRect()
              return {
                text: el.textContent,
                hidden: el.hidden,
                display: cs.display,
                visibility: cs.visibility,
                width: Math.round(box.width),
                height: Math.round(box.height),
              }
            })(),
            // v0.8.21 opening wave: by the time any shot is taken it must be over, and
            // every block must be back on its authored transform wearing the shared
            // material — a wave that left a block scaled or dimmed is a regression the
            // eye would only catch on the frame it happened.
            introWave: (() => {
              const i = globalThis.__voxalblast?.intro?.()
              return i ? { active: i.active, plays: i.plays, total: i.total, integrity: i.integrity } : null
            })(),
            // v0.8.22: the game must boot INSIDE a run — a refresh that lands on the home
            // cover was the producer's first v0.8.22 report.
            // v0.8.22: the item strip's disabled state is derived from isPaused, so any
            // transient pause (the opening wave, the settings panel) that forgets to
            // restore it leaves four usable tools looking dead. Graded on every board shot.
            items: [...document.querySelectorAll('.item-button')].map((el) => ({
              id: el.dataset.item,
              disabled: el.classList.contains('disabled'),
              count: Number(el.querySelector('.item-count')?.textContent ?? '0'),
              opacity: getComputedStyle(el).opacity,
            })),
            boot: {
              homeOpen: globalThis.__voxalblast?.home?.().open ?? null,
              homeVisible: (() => { const el = document.querySelector('#home'); return !el || getComputedStyle(el).display !== 'none' })(),
              appHomeOpen: document.querySelector('#app').classList.contains('home-open'),
              status: document.querySelector('#status').textContent,
            },
            home: document.querySelector('#home').className,
            canvases: document.querySelectorAll('canvas').length,
            gameOver: (() => {
              const measure = (sel) => {
                const el = document.querySelector(sel)
                if (!el) return null
                const box = el.getBoundingClientRect()
                const x = Math.round(box.left + box.width / 2)
                const y = Math.round(box.top + box.height / 2)
                const top = document.elementFromPoint(x, y)
                return {
                  display: getComputedStyle(el).display,
                  width: Math.round(box.width),
                  height: Math.round(box.height),
                  at: [x, y],
                  // A control painted off-screen or covered by another layer is as
                  // unreachable as one that was never rendered.
                  onTop: !!top && (top === el || el.contains(top)),
                }
              }
              const card = document.querySelector('#game-over')
              return {
                cardShown: !!card && getComputedStyle(card).display !== 'none',
                playAgain: measure('#reset-modal'),
                leaderboardEntry: measure('#leaderboard-button'),
              }
            })(),
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
      // v0.13.0 (correction handoff §13.2「更新而不是删除旧断言」): the two assertions that used
      // to stand here — "a `.pastoral-backdrop` layer covers the viewport" and "its valley webp
      // loaded" — described the PAINTED background the floating world retires. They are
      // replaced, not deleted, by what the frame has to prove now: a real lit scene graph is up,
      // it lives on the scenery layer ALONE (which is what keeps it out of the normal/depth
      // prepass and out of picking), its sky is ready, its floor is below the board's worst
      // pose, and it built the cloud count its quality tier asked for. Each of these is a fact a
      // screenshot cannot show — a missing cloud layer and a cloud layer drawn behind an opaque
      // sky are the same picture.
      const world = parsed.rendering?.world
      if (!world) failures.push('the floating world did not report (scenery). is it mounted?')
      else {
        if (!world.enabled) failures.push('the floating world is disabled')
        if (world.layer !== 2 || world.layerMask !== 4) failures.push(`scenery must live on layer 2 alone (layer ${world.layer}, mask ${world.layerMask})`)
        if (!world.sky?.ready) failures.push('the sky material/texture is not ready')
        if (!(world.plaza?.floorY <= -4.5)) failures.push(`the plaza floor (${world.plaza?.floorY}) is above the board's worst pose — the board would cut through it`)
        if (!(world.cells > 0)) failures.push('the floating blocks have no cells')
        if (!(world.clouds > 0) || world.cloudTextures !== 3) failures.push(`clouds: ${world.clouds} sprites over ${world.cloudTextures} textures (the pack ships three)`)
        // The scenery's composition is ART-FIXED at 3 groups / 3 loose blocks / 6 clouds on
        // every tier, and that is a DELIBERATE deviation from §7.3's per-tier counts — the R4
        // side's own receipt §4.2 records the reason: the project's `lowPower` selector is
        // width-based, EVERY phone width lands in `low`, and applying the recipe's low tier
        // (1/1/3) would strip the very viewport C1 is graded at. Downgrades still act on DPR,
        // shadows and SSAO.
        //
        // So the exact numbers are asserted here rather than the tier comparison they replaced:
        // this gate now pins the composition the module PROMISES. If the tiers are ever wired
        // up, this line has to change with them — which is the point. The deviation itself is
        // recorded as an OPEN PRODUCER DECISION in docs/Technical/KNOWN_GAPS.md, not resolved.
        if (world.clusters !== 3 || world.looseBlocks !== 3 || world.clouds !== 6) {
          failures.push(`scenery composition is ${world.clusters}/${world.looseBlocks}/${world.clouds}, the art-fixed contract is 3/3/6 (see KNOWN_GAPS: the §7.3 tier deviation is an open decision)`)
        }
        // v0.13.0 R4 (KNOWN_GAPS §3 / handoff §C0.4): the world has to BE still for the picture to
        // be comparable. This is read back from the module rather than trusted from the pin call
        // above — a pin that silently stopped working would otherwise be invisible until someone
        // diffed two captures by hand, which is exactly how it went unnoticed the first time.
        if (!world.ambient?.pinned) {
          failures.push('the scenery ambient clock was not pinned — two captures of this build are not pixel-comparable (§C0.4)')
        }
      }
      if (parsed.viewport.width !== width || parsed.viewport.height !== height) failures.push('incorrect CSS viewport')
      if (parsed.screenshot.width !== width || parsed.screenshot.height !== height) failures.push('incorrect PNG dimensions')
      if (parsed.rendering?.meshes !== 98 || parsed.rendering?.uniqueCells !== 98) failures.push('board must contain exactly 98 unique meshes')
      if (parsed.rendering?.surfaceArt !== (SURFACE_FALLBACK ? 'fallback' : 'ready')) failures.push('block surface asset / fallback not ready')
      const materials = parsed.rendering?.materials
      if (!(materials?.wood.roughness > materials?.paint.roughness)) failures.push('bare wood must stay rougher than toy plastic')
      if (!materials?.environmentBound) failures.push('per-material reflection tuning is bypassed by scene environment')
      if (!(parsed.rendering?.trianglesPerBlock <= 1000)) failures.push('shared block exceeds H5 geometry budget')
      // v0.13.0 (handoff §5.2/§13.2): the board FLOATS. The old gate here asserted a painted
      // pedestal's contact decal had opacity > 0, which is exactly the thing this direction
      // deletes — so it is replaced, not deleted, by the facts that make a support-free board
      // readable. "Stronger" is the point: the old one only proved a quad was drawn.
      const ground = parsed.rendering?.grounding?.ground
      const grounding = parsed.rendering?.grounding
      // v0.13.0 R3 (handoff §9.3). The main canvas became the WHOLE viewport and the board is
      // put back into the play area by the render camera's embedded projection. Four things
      // make that real, and none of them is visible in the picture: the canvas really is the
      // viewport, the gameplay rect is a strict sub-rect of it (so the embed is exercised at
      // all), the two projections agree to within a CSS pixel, and no fifth WebGL context
      // appeared — the stage's whole justification is that scenery gets drawn by THIS renderer.
      const projection = parsed.rendering?.projection
      if (!projection) failures.push('the render-camera embedding was not reported')
      else {
        if (Math.round(projection.canvas.width) !== width || Math.round(projection.canvas.height) !== height) {
          failures.push(`the main canvas is ${projection.canvas.width}x${projection.canvas.height}, not the ${width}x${height} viewport`)
        }
        if (!(projection.gameplayRect.width > 0 && projection.gameplayRect.height > 0)) failures.push('the gameplay rect has no area')
        if (projection.gameplayRect.width >= projection.canvas.width || projection.gameplayRect.height >= projection.canvas.height) {
          failures.push('the gameplay rect fills the canvas — the embedded projection was never exercised')
        }
        if (!(projection.worstPx <= 1)) failures.push(`render-camera embedding is ${projection.worstPx}px off the gameplay projection (budget 1 CSS px)`)
      }
      if (parsed.canvases !== 4) failures.push(`expected 4 WebGL canvases (main + three candidate slots), found ${parsed.canvases}`)
      if (grounding?.route !== 'none') failures.push(`the floating-world skin must ship without a pedestal or platform (route: ${grounding?.route})`)
      if (grounding?.pedestalArt && !grounding.pedestalArt.hidden) failures.push('the painted pedestal is still visible behind the board')
      if (grounding?.platform?.visible) failures.push('the G1 platform prototype is visible in the shipped route')
      if (!(grounding?.groundClearance > 0)) failures.push(`the ground plane is not below every pose of the board (clearance ${grounding?.groundClearance})`)
      // v0.13.1: ownership is explicit now. The layer-2 art ellipse is the only shipped shadow;
      // the two legacy layer-1 quads remain diagnostic routes and must BOTH be off in production.
      // This is stricter than the old "exactly one legacy quad" check: it proves the approved
      // mechanism exists, is mapped and has area, while also preventing either double-shadow path.
      const artShadow = world?.boardShadow
      if (grounding?.shadowMechanism !== 'art-ellipse') failures.push(`unexpected shipped shadow owner: ${grounding?.shadowMechanism}`)
      if (ground?.blobVisible || ground?.projectedVisible) failures.push('a legacy ground-shadow quad is still drawn under the art ellipse')
      if (!artShadow?.visible || !artShadow?.mapReady || !artShadow?.parented) failures.push('the floating-world art shadow is not fully mounted and visible')
      if (!(artShadow?.opacity > 0 && artShadow?.width > 0 && artShadow?.height > 0)) failures.push('the floating-world art shadow has no visible area')
      if (parsed.rendering?.lowPower && parsed.rendering?.contactShadows?.ssaoEnabled) failures.push('low-power path must use surface AO instead of full scene SSAO')
      const onHome = mode === 'home' || mode === 'home-return'
      // The badge is inside the hidden topbar while the home cover is up, so on those
      // two shots only its box and text are graded.
      if (!parsed.versionBadge || parsed.versionBadge.text !== `v${version}`) failures.push('version badge missing or does not match package.json')
      else if (parsed.versionBadge.display === 'none' || !parsed.versionBadge.width || !parsed.versionBadge.height) failures.push('version badge has no visible box')
      else if (!onHome && (parsed.versionBadge.hidden || parsed.versionBadge.visibility !== 'visible')) failures.push('version badge is hidden in a live run')
      if (parsed.introWave) {
        if (parsed.introWave.active) failures.push('opening wave still running when the shot was taken')
        if (!(parsed.introWave.plays >= 1)) failures.push('no opening wave was armed on this load')
        const integrity = parsed.introWave.integrity
        if (integrity && Object.entries(integrity).some(([key, value]) => key.endsWith('Off') && value > 0)) {
          failures.push(`opening wave left blocks off their authored state (${JSON.stringify(integrity)})`)
        }
      }
      // v0.8.22: a run must be on screen at boot. The two home shots get there through
      // settings → 回到主页, so only the board/gameover modes are graded on it.
      if (!onHome) {
        if (parsed.framing?.clipped) failures.push('play cube clipped by canvas')
        if (parsed.playLayout && (!parsed.playLayout.clearOfTools || !parsed.playLayout.clearOfTray)) failures.push('play cube overlaps tools or tray')
        // v0.9.14: the bottom turn dwell (03 §3.1) needs the piece's CENTRE to leave the cube's
        // silhouette, and the tray sits directly under it. A TOUCH carry is graded on the widest
        // piece in the pool (3 rows, 12px + half its height); a MOUSE carry only lifts 10px. The
        // two are graded separately because the lift is clamped to the room above the cube, and a
        // desktop cube is already vertically saturated — buying phone headroom there would mean
        // shrinking the cube, which is not a trade this game makes.
        const touchViewport = parsed.playLayout && parsed.playLayout.turnBandFor3Row >= 0
        const mouseViewport = parsed.playLayout && parsed.playLayout.turnBandForMouse >= 0
        if (parsed.playLayout && !touchViewport && !mouseViewport) {
          failures.push(`bottom turn band too small (${parsed.playLayout.turnBandPx.toFixed(0)}px band, ${parsed.playLayout.turnBandFor3Row.toFixed(0)}px left for a 3-row touch carry, ${parsed.playLayout.turnBandForMouse.toFixed(0)}px for a mouse carry)`)
        }
        // v0.9.16: the gear and the score BOARD are two corner elements sharing a top edge.
        // Graded against the board's own edge inside the art (the ratio gate right below).
        if (parsed.playLayout && Math.abs(parsed.playLayout.hudTopDelta) > 2) {
          failures.push(`settings button's top edge is ${parsed.playLayout.hudTopDelta.toFixed(1)}px off the score BOARD's top edge`)
        }
        // …and the ratio itself has to still match the ART, derived at run time rather than
        // remembered: the page rasterises the skin's plaque asset into a canvas and finds the
        // first row whose longest opaque run spans half the slice — the BOARD's top edge (the
        // old slice's leaf decoration never formed a run that wide, and the new one has no
        // decoration at all, so its outer stroke's top row is the answer).
        //
        // v0.13.0 R6: a null measurement is now a FAILURE rather than a skip. The old form
        // silently graded nothing whenever the rasterisation failed, which was survivable while
        // the asset was a PNG the browser could always decode; it is not survivable now that the
        // asset is an SVG, where a decode miss would turn the one gate that ties
        // `--plaque-board-top` to the art into a gate that always passes.
        if (parsed.playLayout && parsed.artBoardTopRatio === null) {
          failures.push('the plaque asset could not be measured, so the --plaque-board-top/art agreement is ungraded')
        } else if (parsed.playLayout
          && Math.abs(parsed.playLayout.boardTopRatio - parsed.artBoardTopRatio) > 0.005) {
          failures.push(`--plaque-board-top is ${parsed.playLayout.boardTopRatio} but score-panel.svg says ${parsed.artBoardTopRatio} — re-measure with node tools/art-alpha-box.mjs, or fix the skin stylesheet`)
        }
        if (parsed.boot.homeOpen !== false || parsed.boot.homeVisible || parsed.boot.appHomeOpen) {
          failures.push(`the game did not open inside a run (${JSON.stringify(parsed.boot)})`)
        }
        // Game Over greys the strip on purpose (the run is over), and so does the settings
        // panel (the board is paused behind it), so the gate is about the states a player is
        // meant to be able to play from. The leaderboard shot is taken after a finished run
        // for the first of those reasons.
        const stuckItems = mode === 'gameover' || mode === 'leaderboard' || mode === 'leaderboard-local' || mode === 'settings'
          ? []
          : (parsed.items || []).filter((item) => item.count > 0 && item.disabled)
        if (stuckItems.length) failures.push(`item buttons are left disabled although they have charges (${JSON.stringify(stuckItems)})`)
      }
      if (parsed.gameLayers.some(layer => layer.visibility !== (onHome ? 'hidden' : 'visible') || layer.inert !== onHome || !layer.width || !layer.height)) failures.push('game layer visibility, input isolation or preserved layout incorrect')
      // Page-level invariant, so it runs for the cover shots too (a hidden host paints nothing).
      if (!parsed.legacyArtHidden) failures.push('a legacy toy-icon still paints under the reference art')
      if (!onHome) {
        if (parsed.candidateFrames.length !== 3 || parsed.candidateFrames.some(frame => ![frame.minX, frame.maxX, frame.minY, frame.maxY].every(Number.isFinite) || frame.minX < -0.99 || frame.maxX > 0.99 || frame.minY < -0.99 || frame.maxY > 0.99)) failures.push('candidate volume clipped by camera')
        if (!parsed.candidateCanvasesContained) failures.push('candidate canvas clipped by slot')
        if (!parsed.scoreTextContained) failures.push('score or label text overflows its cell')
        if (sessionFixture && mode === 'board' && JSON.stringify(parsed.candidateFrames.map(frame => frame.name)) !== JSON.stringify(sessionFixture.snapshot.pieces.map(piece => piece.name))) failures.push('candidate fixture not restored')
      }
      if (sessionFixture && mode === 'board') {
        const actual = parsed.resumedBoard
        const expected = sessionFixture.expectedBoard
        if (JSON.stringify(actual?.cells) !== JSON.stringify(expected.cells)) failures.push('resumed board colours or coordinates differ')
        if (actual?.score !== expected.score || actual?.totalLines !== expected.totalLines) failures.push('resume changed score or line count')
      }
      if (mode === 'gameover') {
        // v0.8.15 gate: the panel's only restart affordance must be rendered, sized and
        // hittable at EVERY width. A `display: none` from a media query is invisible to
        // a desktop-only check, so this shot exists at 390px and 1440px.
        const { cardShown, playAgain, leaderboardEntry } = parsed.gameOver
        if (!cardShown) failures.push('game over card is not shown')
        if (playAgain?.display === 'none') failures.push('PLAY AGAIN is hidden by CSS at this width')
        if (!playAgain?.width || !playAgain?.height) failures.push('PLAY AGAIN has no layout box')
        if (playAgain && !playAgain.onTop) failures.push(`PLAY AGAIN is covered at its own centre (${playAgain.at})`)
        if (leaderboardEntry && !leaderboardEntry.onTop) failures.push('排行榜 entry is covered at its own centre')
      }
      const clean = failures.length === 0
      console.log(`${clean ? 'OK  ' : 'FAIL'} ${shot.name.padEnd(13)} ${width}x${height}  ${out}`)
      console.log(`     ${JSON.stringify(parsed)}`)
      if (!clean) throw new Error(`${shot.name}: ${failures.join('; ')}`)
      if (process.env.SHOT_GEM_COMPARE === '1' && mode === 'board') {
        const settings = parsed.rendering.materials.gem.settings
        const tuned = await send(ws, nextId++, 'Runtime.evaluate', {
          expression: `__voxalblastDev.tuneGem({scatter:0,coreAbsorption:0,internalReflection:0,environmentTransmission:0})`, returnByValue: true,
        })
        if (tuned.exceptionDetails) throw new Error('gem comparison needs the dev tuning hook')
        try {
          await send(ws, nextId++, 'Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true })
          const surfaceOnly = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
          writeFileSync(out.replace(/\.png$/, '-surface-only.png'), Buffer.from(surfaceOnly.data, 'base64'))
        } finally {
          await send(ws, nextId++, 'Runtime.evaluate', { expression: `__voxalblastDev.tuneGem(${JSON.stringify(settings)})`, returnByValue: true })
        }
        console.log(`OK   ${shot.name}: surface-only comparison captured; volume settings restored`)
      }
      // Optional visual evidence for specular response: one real, held yaw drag
      // visits five angles, then returns to the original pose before release.
      // No gameplay write hook or camera/material change is used for these shots.
      if (process.env.SHOT_REFLECTION_SWEEP === '1' && mode === 'board') {
        const boundsRead = await send(ws, nextId++, 'Runtime.evaluate', {
          expression: 'JSON.stringify({ bounds: __voxalblast.bounds(), board: __voxalblast.board() })', returnByValue: true,
        })
        const before = JSON.parse(boundsRead.result.value)
        const bounds = before.bounds
        const x = (bounds.minX + bounds.maxX) / 2, y = bounds.minY * 0.3 + bounds.maxY * 0.7
        const span = bounds.maxX - bounds.minX
        await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
        const poses = []
        let previous = 0
        for (const offset of [-0.22, -0.1, 0, 0.1, 0.22, 0]) {
          for (let step = 1; step <= 8; step += 1) {
            await send(ws, nextId++, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved', x: x + (previous + (offset - previous) * step / 8) * span, y, button: 'left', buttons: 1,
            })
          }
          await send(ws, nextId++, 'Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true })
          const pose = await send(ws, nextId++, 'Runtime.evaluate', { expression: 'JSON.stringify(__voxalblast.rotation())', returnByValue: true })
          const capture = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
          const path = out.replace(/\.png$/, `-reflection-${poses.length}.png`)
          writeFileSync(path, Buffer.from(capture.data, 'base64'))
          poses.push({ offset, path, rotation: JSON.parse(pose.result.value) })
          previous = offset
        }
        await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
        const after = await send(ws, nextId++, 'Runtime.evaluate', { expression: 'JSON.stringify(__voxalblast.board())', returnByValue: true })
        if (JSON.stringify(before.board) !== after.result.value) throw new Error('reflection sweep mutated board state')
        if (new Set(poses.map(pose => JSON.stringify(pose.rotation.pose))).size < 3) throw new Error('reflection sweep did not rotate the cube')
        if (browserErrors.length) throw new Error(`reflection sweep: ${browserErrors.join('; ')}`)
        writeFileSync(out.replace(/\.png$/, '-reflection.json'), JSON.stringify(poses, null, 2))
        console.log(`OK   ${shot.name}: reflection sweep captured ${poses.length} poses; board unchanged`)
      }
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
const requestedShots = process.env.SHOT_ONLY?.split(',')
const selectedShots = requestedShots ? SHOTS.filter(shot => requestedShots.includes(shot.name)) : SHOTS
if (!selectedShots.length || requestedShots?.some(name => !SHOTS.some(shot => shot.name === name))) throw new Error('unknown SHOT_ONLY name')
for (const shot of selectedShots) await capture(browser, shot)

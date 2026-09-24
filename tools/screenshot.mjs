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
            resumedBoard: ${Boolean(sessionFixture)} ? globalThis.__voxalblast?.board?.() : null,
            gameLayers: [...document.querySelectorAll('.topbar, .game-layout')].map(el => ({ visibility: getComputedStyle(el).visibility, inert: el.inert, width: el.clientWidth, height: el.clientHeight })),
            candidateFrames: globalThis.__voxalblast?.candidateFrames?.() ?? [],
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
      if (!parsed.backdrop) failures.push('backdrop SVG fallback or viewport coverage missing')
      if (!parsed.backdropImage?.loaded) failures.push('background image missing or not loaded')
      if (parsed.viewport.width !== width || parsed.viewport.height !== height) failures.push('incorrect CSS viewport')
      if (parsed.screenshot.width !== width || parsed.screenshot.height !== height) failures.push('incorrect PNG dimensions')
      if (parsed.rendering?.meshes !== 98 || parsed.rendering?.uniqueCells !== 98) failures.push('board must contain exactly 98 unique meshes')
      if (parsed.rendering?.surfaceArt !== (SURFACE_FALLBACK ? 'fallback' : 'ready')) failures.push('block surface asset / fallback not ready')
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
        if (parsed.boot.homeOpen !== false || parsed.boot.homeVisible || parsed.boot.appHomeOpen) {
          failures.push(`the game did not open inside a run (${JSON.stringify(parsed.boot)})`)
        }
        // Game Over greys the strip on purpose (the run is over), so the gate is about
        // the states a player is meant to be able to play from.
        const stuckItems = mode === 'gameover' ? [] : (parsed.items || []).filter((item) => item.count > 0 && item.disabled)
        if (stuckItems.length) failures.push(`item buttons are left disabled although they have charges (${JSON.stringify(stuckItems)})`)
      }
      if (parsed.gameLayers.some(layer => layer.visibility !== (onHome ? 'hidden' : 'visible') || layer.inert !== onHome || !layer.width || !layer.height)) failures.push('game layer visibility, input isolation or preserved layout incorrect')
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

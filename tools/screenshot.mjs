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
// -mobile-board.png, then prints a DOM/error probe for each run.
//
// Pitfalls this driver already handles, do not re-solve them:
//   - Edge's headless layout viewport has a ~500px MINIMUM WIDTH. Asking for
//     --window-size=390,844 writes a 390px PNG whose LAYOUT was 500px wide, so the
//     right-hand third is missing and it looks like a layout bug. The phone capture
//     therefore uses 500×1082, which is the smallest honest portrait viewport here.
//   - A just-killed Edge keeps its debugging port and profile lock for a moment, so
//     the next launch can fail to open devtools at all. Every capture retries on a
//     fresh port (three attempts).
//   - `child.kill()` does not kill Edge's process tree on Windows; each capture uses
//     its own throwaway --user-data-dir under %TEMP% and removes it afterwards.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  { name: 'mobile-board', width: 500, height: 1082, mode: 'board' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findBrowser() {
  for (const path of EDGE_CANDIDATES) if (path && existsSync(path)) return path
  throw new Error(`no headless browser found; tried:\n  ${EDGE_CANDIDATES.join('\n  ')}`)
}

function send(ws, id, method, params = {}) {
  return new Promise((resolve_, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve_(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function capture(browser, shot) {
  const { width, height, mode } = shot
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 9300 + Math.floor(Math.random() * 400)
    const profile = `${process.env.TEMP}\\voxalblast-shot-${port}`
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
      '--run-all-compositor-stages-before-draw',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`, 'about:blank',
    ], { stdio: 'ignore' })

    try {
      let live = false
      for (let i = 0; i < 80; i += 1) {
        try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); live = true; break } catch { await sleep(250) }
      }
      if (!live) continue

      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise((ok, no) => {
        ws.addEventListener('open', ok, { once: true })
        ws.addEventListener('error', no, { once: true })
      })

      await send(ws, 1, 'Page.enable')
      await send(ws, 2, 'Runtime.enable')
      await send(ws, 3, 'Page.addScriptToEvaluateOnNewDocument', {
        source: 'globalThis.__errs = [];'
          + 'addEventListener("error", (e) => globalThis.__errs.push(String(e.message) + " @ " + String(e.filename) + ":" + String(e.lineno)));'
          + 'addEventListener("unhandledrejection", (e) => globalThis.__errs.push("rejection: " + String((e.reason && e.reason.stack) || e.reason)));',
      })
      await send(ws, 4, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
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
      await sleep(400)

      const probe = await send(ws, 8, 'Runtime.evaluate', {
        expression: `(() => {
          const layer = document.querySelector('.pastoral-backdrop')
          const svg = layer && layer.querySelector('svg')
          const r = layer && layer.getBoundingClientRect()
          return JSON.stringify({
            backdrop: !!layer && !!svg && Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight,
            backdropZ: layer ? getComputedStyle(layer).zIndex : null,
            woodGrain: getComputedStyle(document.documentElement).getPropertyValue('--wood-grain').slice(0, 26),
            version: ${JSON.stringify(version)},
            home: document.querySelector('#home').className,
            canvases: document.querySelectorAll('canvas').length,
            errors: (globalThis.__errs || []).slice(0, 6),
          })
        })()`,
        returnByValue: true,
      })
      if (probe.exceptionDetails) throw new Error(`${shot.name}: probe threw — ${probe.exceptionDetails.exception?.description || probe.exceptionDetails.text}`)

      const shot_ = await send(ws, 9, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const out = join(outDir, `v${version}-${shot.name}.png`)
      mkdirSync(outDir, { recursive: true })
      writeFileSync(out, Buffer.from(shot_.data, 'base64'))
      ws.close()
      const parsed = JSON.parse(probe.result.value)
      const clean = parsed.errors.length === 0
      console.log(`${clean ? 'OK  ' : 'FAIL'} ${shot.name.padEnd(13)} ${width}x${height}  ${out}`)
      console.log(`     ${probe.result.value}`)
      if (!clean) throw new Error(`${shot.name}: runtime errors`)
      return
    } finally {
      try { child.kill() } catch { /* already gone */ }
      await sleep(400)
      try { rmSync(profile, { recursive: true, force: true }) } catch { /* still locked; %TEMP% will take it */ }
    }
  }
  throw new Error(`${shot.name}: devtools never came up after 3 attempts`)
}

const browser = findBrowser()
console.log(`browser ${browser}\ntarget  ${url}\nversion v${version}\n`)
for (const shot of SHOTS) await capture(browser, shot)

// §6.4's last un-made deliverable: visible-projection evidence at the poses the handoff names
//   「不把"opacity>0""接收面存在"当视觉通过；必须提交实际可见投影截图。0°/45°/90° 检查穿插」
//
// Round 27 tried to reach those poses with the app's ROTATION KEYS and failed (the pose model has no
// free yaw: 12 presses moved the cube 26.01° -> 37.97° once, and the same ladder read Δ0 the second
// time). So this drives the SAME GESTURE the player uses — a downward drag in the cube's side band,
// exactly the geometry `tools/swipe-probe.mjs` uses (start 40px outside the cube box, drag 140px down
// in 8 moves). A completed drag is one face turn, so the drag's own progress gives the "45°" case for
// free: every move is captured, and the frame whose measured pose angle is closest to 45° is kept as
// the mid-turn shot. The pose angle is MEASURED from the cube's quaternion, not assumed from the drag
// distance — if the drag does not actually turn the cube, the output says so instead of labelling a
// rest pose as 90°.
//
// World is pinned to still-mode (§C0.4) so the three frames differ only by the cube's pose.
// Output is written in the GATE'S LOG FORMAT, so `tools/floating-world-shadow-window.mjs` measures it
// with the same pixel algorithm it runs on the acceptance gate's log.
//
//   node tools/floating-world-shadow-poses.mjs [url] [out.log]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:5173/?lang=zh-Hans'
const OUT_LOG = resolve(process.argv[3] || 'artifacts/fw/shadow-poses.log')
const OUT_DIR = resolve(OUT_LOG, '..')
const VIEWPORT = { width: 1440, height: 900 }
const BAND_OFFSET_PX = 40     // same as tools/swipe-probe.mjs
const DRAG_DOWN_PX = 140
const MOVE_STEPS = 8
const SETTLE_MS = 900

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => p && existsSync(p))
if (!EDGE) throw new Error('no headless browser found')

mkdirSync(OUT_DIR, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'vbfw-poses-'))
const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--force-device-scale-factor=1', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank'],
{ stdio: ['ignore', 'ignore', 'pipe'] })

const browserWs = await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error('no DevTools endpoint in 20s')), 20000)
  child.stderr.on('data', (buf) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(buf))
    if (m) { clearTimeout(timer); res(m[1]) }
  })
  child.on('exit', (code) => rej(new Error(`browser exited early (${code})`)))
})

const ws = new WebSocket(browserWs)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
})
let nextId = 1
const pending = new Map()
let sessionId
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: r, reject: j } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) j(new Error(msg.error.message)); else r(msg.result)
  }
})
const send = (method, params = {}, useSession = true) => new Promise((r, j) => {
  const id = nextId++
  pending.set(id, { resolve: r, reject: j })
  ws.send(JSON.stringify(useSession && sessionId ? { id, method, params, sessionId } : { id, method, params }))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false)
;({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false))
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: URL })

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate threw')
  return res.result.value
}
for (let i = 0; i < 60; i += 1) {
  if (await evaluate(`!!(globalThis.__voxalblastDev && globalThis.__voxalblast)`)) break
  await sleep(500)
}
await sleep(2500)
const pin = await evaluate(`(() => {
  globalThis.__voxalblastDev.setBoardFloat({ frozen: true, time: 0 })
  globalThis.__voxalblastDev.setAmbient({ frozen: true, time: 0 })
  return true
})()`)
if (!pin) throw new Error('dev handles unavailable')

const REPORT = `JSON.stringify((() => {
  const api = globalThis.__voxalblast
  const r = api.rendering()
  const f = api.framing()
  const rot = api.rotation()
  const tray = document.querySelector('.bottom-panel')
  return {
    rendering: { world: r.world },
    framing: f,
    trayMetrics: tray ? { y: tray.getBoundingClientRect().top } : null,
    gameLayers: [...document.querySelectorAll('.topbar, .game-layout')].map((el) => ({ visibility: getComputedStyle(el).visibility })),
    poseQuat: rot.pose,
    viewport: { width: innerWidth, height: innerHeight },
  }
})())`

const logLines = []
let restQuat = null
const angleFrom = (q) => {
  if (!restQuat || !q) return null
  const dot = Math.abs(q[0] * restQuat[0] + q[1] * restQuat[1] + q[2] * restQuat[2] + q[3] * restQuat[3])
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
}

async function capture(label, extra = '') {
  const report = JSON.parse(await evaluate(REPORT))
  if (!restQuat) restQuat = report.poseQuat
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, `shadow-pose-${label}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  logLines.push(`OK   ${label}  ${VIEWPORT.width}x${VIEWPORT.height}  ${file}`, `     ${JSON.stringify(report)}`)
  const angle = angleFrom(report.poseQuat)
  const sh = report.rendering.world.boardShadow
  console.log(`  ${label.padEnd(18)} pose angle ${angle === null ? '  0.0' : angle.toFixed(1).padStart(5)}°  `
    + `shadow anchor ${sh.screen.x.toFixed(0)},${sh.screen.y.toFixed(0)}  visible=${sh.visible}  ${extra}`)
  return { report, angle, file }
}

console.log(`url ${URL}  viewport ${VIEWPORT.width}x${VIEWPORT.height}  still-mode pinned: ${pin}`)
const rest = await capture('0-rest')

// One downward drag in the LEFT band = one face turn. Capture every move, keep the frame whose
// MEASURED angle is closest to 45° as the mid-turn shot.
const { solid } = JSON.parse(await evaluate('JSON.stringify(globalThis.__voxalblast.framing())'))
const startX = solid.minX - BAND_OFFSET_PX
const y = Math.min(Math.max((solid.minY + solid.maxY) / 2, 4), VIEWPORT.height - 4)
const hitTarget = await evaluate(`(() => { const el = document.elementFromPoint(${startX}, ${y}); return el ? (el.id || el.className || el.tagName) : null })()`)
console.log(`  drag from (${startX.toFixed(0)}, ${y.toFixed(0)}) down ${DRAG_DOWN_PX}px in ${MOVE_STEPS} moves; element at start: ${hitTarget}`)

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y, button: 'left', buttons: 1, clickCount: 1 })
const midFrames = []
for (let i = 1; i <= MOVE_STEPS; i += 1) {
  const t = i / MOVE_STEPS
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: y + DRAG_DOWN_PX * t, button: 'left', buttons: 1 })
  await sleep(60)
  const report = JSON.parse(await evaluate(REPORT))
  if (!restQuat) restQuat = report.poseQuat
  const angle = angleFrom(report.poseQuat) ?? 0
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, `shadow-pose-mid3${i}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  midFrames.push({ i, angle, report, file })
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX, y: y + DRAG_DOWN_PX, button: 'left', buttons: 0, clickCount: 1 })
await sleep(SETTLE_MS)
for (let i = 0; i < 10; i += 1) {
  if (!(await evaluate('Boolean(globalThis.__voxalblast.rotation().settling)'))) break
  await sleep(250)
}
const after = await capture('2-after-turn')

const best = midFrames.reduce((a, b) => (Math.abs(b.angle - 45) < Math.abs(a.angle - 45) ? b : a))
logLines.push(`OK   mid-turn(~45deg)  ${VIEWPORT.width}x${VIEWPORT.height}  ${best.file}`, `     ${JSON.stringify(best.report)}`)
console.log(`  mid-turn frame kept: move ${best.i}/${MOVE_STEPS}, measured ${best.angle.toFixed(1)}° (all moves: ${midFrames.map((f) => f.angle.toFixed(0)).join('/')}°)`)

// Did the drag actually complete a face turn? Say so, rather than trusting the label.
const turned = after.angle ?? 0
console.log('')
console.log(`turn check: rest -> after release measured ${turned.toFixed(1)}°  `
  + `${turned > 60 ? 'OK (a face turn happened)' : 'NOT a face turn — the 90° label would be wrong, do not use it as such'}`)
writeFileSync(OUT_LOG, logLines.join('\n') + '\n')
console.log(`wrote ${OUT_LOG} (${logLines.length / 2} shot(s))`)
console.log(`measure with: node tools/floating-world-shadow-window.mjs "${OUT_LOG}"`)

await send('Browser.close', {}, false).catch(() => {})
await sleep(400)
try { rmSync(profile, { recursive: true, force: true, maxRetries: 8 }) } catch {}

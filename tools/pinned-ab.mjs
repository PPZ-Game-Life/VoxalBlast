// Pinned in-page A/B: two screenshots from ONE page session with the world frozen, differing ONLY by
// the CSS under test. This is the isolation that screenshots-across-runs cannot give on this tree —
// a parallel session keeps editing the world renderer, so two gate runs differ for reasons that have
// nothing to do with the change being verified (measured earlier: 61.7% of the sky region).
//
//   node vbfw-pinned-ab.mjs <url> <out-a.png> <out-b.png> <restore.css>
//
// A = the tree as it is now. B = the same page with <restore.css> appended to <head> (the retired
// declarations put back in their original cascade position), i.e. the state before this round's
// removals. The diff between the two files is therefore the change, and nothing else.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [URL, OUT_A, OUT_B, RESTORE] = process.argv.slice(2)
if (!RESTORE) throw new Error('usage: node vbfw-pinned-ab.mjs <url> <out-a> <out-b> <restore.css>')

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => p && existsSync(p))
if (!EDGE) throw new Error('no headless browser found')

const restoreCss = readFileSync(RESTORE, 'utf8')
const profile = mkdtempSync(join(tmpdir(), 'vbfw-ab-'))
const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })

const browserWs = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no DevTools endpoint in 20s')), 20000)
  child.stderr.on('data', (buf) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(buf))
    if (m) { clearTimeout(timer); resolve(m[1]) }
  })
  child.on('exit', (code) => reject(new Error(`browser exited early (${code})`)))
})

const ws = new WebSocket(browserWs)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
})
let nextId = 1
const pending = new Map()
let sessionId
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
  }
})
const send = (method, params = {}, useSession = true) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify(useSession && sessionId ? { id, method, params, sessionId } : { id, method, params }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false)
;({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false))
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: URL })

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate threw')
  return res.result.value
}
for (let i = 0; i < 60; i += 1) {
  if (await evaluate(`!!(globalThis.__voxalblastDev && document.querySelectorAll('canvas').length >= 4)`)) break
  await new Promise((r) => setTimeout(r, 500))
}
await new Promise((r) => setTimeout(r, 2500))

// The still-mode pin (§C0.4). Without it two frames of this build are not comparable — the gate
// refuses to shoot for exactly this reason.
const pinned = await evaluate(`JSON.stringify((() => {
  const d = globalThis.__voxalblastDev
  if (!d || typeof d.setAmbient !== 'function') return { ok: false, why: 'no dev handles' }
  d.setBoardFloat({ frozen: true, time: 0 })
  if (typeof d.setAmbient === 'function') d.setAmbient({ frozen: true, time: 0 })
  return { ok: true, board: !!d.readBoardFloat, ambient: typeof d.setAmbient }
})())`)
await new Promise((r) => setTimeout(r, 1200))

const probe = `JSON.stringify((() => {
  const el = document.querySelector('.topbar .score-chip-value')
  const cs = getComputedStyle(el)
  return { stroke: cs.webkitTextStrokeWidth + ' ' + cs.webkitTextStrokeColor, shadow: cs.textShadow, color: cs.color }
})())`

const before = JSON.parse(await evaluate(probe))
const shotA = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT_A, Buffer.from(shotA.data, 'base64'))

const applied = await evaluate(`(() => {
  const s = document.createElement('style')
  s.id = 'vbfw-restore'
  s.textContent = ${JSON.stringify(restoreCss)}
  document.head.appendChild(s)          // appended last == where the module graph used to put it
  return s.sheet ? s.sheet.cssRules.length : 0
})()`)
await new Promise((r) => setTimeout(r, 600))
const after = JSON.parse(await evaluate(probe))
const shotB = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT_B, Buffer.from(shotB.data, 'base64'))

console.log(`pin                 ${pinned}`)
console.log(`restore stylesheet  ${restoreCss.length} chars, ${applied} rules parsed`)
console.log(`score-value stroke  A: ${before.stroke}   B: ${after.stroke}`)
console.log(`score-value shadow  A: ${before.shadow}   B: ${after.shadow}`)
console.log(`score-value color   A: ${before.color}   B: ${after.color}`)
console.log(`wrote               ${OUT_A}\n                    ${OUT_B}`)

await send('Browser.close', {}, false).catch(() => {})
await new Promise((r) => setTimeout(r, 400))
try { rmSync(profile, { recursive: true, force: true, maxRetries: 8 }) } catch {}

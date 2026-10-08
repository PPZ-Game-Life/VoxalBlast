// Production-artifact smoke check: `node tools/deploy-smoke.mjs <url>`
//
// WHY THIS EXISTS, AND WHAT IT IS NOT
//
// `tools/screenshot.mjs` is the acceptance gate, but it needs `__voxalblastDev.setAmbient()` /
// `setBoardFloat()` to pin the still-mode (§C0.4), and those handles DO NOT EXIST in a production
// build — measured, not assumed: on a built `dist` the handle is absent, so the gate throws
// "the scenery ambient clock was not pinned" on its very first capture and can never pass.
// That means every acceptance reading in the receipts is a reading of the DEV server, and there was
// no way at all to check a deployed URL. This is that check.
//
// It asserts only what a deployed artifact can be judged on without instrumentation, and it never
// pretends to replace the acceptance gate:
//   * no failed requests, no HTTP >= 400      <- the real deploy risk (paths, `base`, subpath hosting)
//   * no console errors, no uncaught exceptions
//   * the app is alive: canvases, #scene-wrap box, #app content, boot curtain gone
//   * no request for a RETIRED skin asset     <- reported as WARN, see the note below
// It also prints the asset manifest split by "content-hashed vs fixed name", which is what a cache
// rule has to be justified against, plus total transferred bytes.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = (process.argv[2] || 'http://127.0.0.1:4173/').replace(/\/?$/, '/')

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => p && existsSync(p))
if (!EDGE) throw new Error('no headless browser found')

const profile = mkdtempSync(join(tmpdir(), 'vbfw-smoke-'))
const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })

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
const requests = new Map()
const responses = []
const failures = []
const consoleErrors = []
let sessionId

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
    return
  }
  if (msg.sessionId !== sessionId) return
  if (msg.method === 'Network.requestWillBeSent') requests.set(msg.params.requestId, msg.params.request.url)
  if (msg.method === 'Network.responseReceived') {
    responses.push({ url: msg.params.response.url, status: msg.params.response.status, type: msg.params.type })
  }
  if (msg.method === 'Network.loadingFailed') {
    failures.push({ url: requests.get(msg.params.requestId) || '?', error: msg.params.errorText, canceled: !!msg.params.canceled })
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('UNCAUGHT: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '?'))
  }
})

const send = (method, params = {}, useSession = true) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify(useSession && sessionId ? { id, method, params, sessionId } : { id, method, params }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false)
;({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false))
await send('Network.enable')
await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL })

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate threw')
  return res.result.value
}

for (let i = 0; i < 60; i += 1) {
  if (await evaluate(`!!(document.querySelector('#app') && document.querySelectorAll('canvas').length >= 4)`)) break
  await new Promise((r) => setTimeout(r, 500))
}
await new Promise((r) => setTimeout(r, 3000))   // let the intro/decode work settle

const state = JSON.parse(await evaluate(`JSON.stringify((() => {
  const wrap = document.querySelector('#scene-wrap')
  const rect = wrap ? wrap.getBoundingClientRect() : null
  const boot = document.querySelector('#boot-screen')
  return {
    title: document.title,
    canvases: document.querySelectorAll('canvas').length,
    appChildren: document.querySelector('#app') ? document.querySelector('#app').children.length : -1,
    sceneWrapBox: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    bootCurtain: boot ? getComputedStyle(boot).display : 'absent',
    stillModeHandlesPresent: !!(globalThis.__voxalblastDev && typeof globalThis.__voxalblastDev.setAmbient === 'function'),
    // The release-build identity tag is #app-version (screenshot.mjs v0.8.21 reads the same id) —
    // its whole job is telling you which build a deployed page is actually running.
    // (No backticks in this comment: the whole expression below is a template literal, and one
    // stray backtick silently ends it — which costs a build error, not a warning.)
    versionBadge: (() => {
      const el = document.querySelector('#app-version')
      if (!el) return null
      const cs = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      return { text: el.textContent.trim(), display: cs.display, visibility: cs.visibility, w: Math.round(box.width), h: Math.round(box.height) }
    })(),
    hasWebGL: (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')) } catch (e) { return false } })(),
  }
})())`))

// A RETIRED asset being requested is a WARN rather than a failure on purpose: the one surviving
// reference is `index.html`'s hidden `<img class="garden-pedestal">`, kept because
// `tools/material-grounding-probe.mjs`'s `g1b-art-*` routes read it (receipt §4.1). A shipped page
// paying a request for retired art is still worth seeing in the report.
const RETIRED = /\/art\/(?:reference|ui-redesign|pastoral)\//
const retiredRequests = [...new Set(responses.map((r) => r.url))].filter((u) => RETIRED.test(u))

const byType = new Map()
for (const r of responses) byType.set(r.type, (byType.get(r.type) || 0) + 1)
const assets = [...new Set(responses.map((r) => r.url))]
const HASHED = /-[A-Za-z0-9_]{8,}\.(?:js|css|woff2?|png|jpe?g|webp|svg)$/
const hashed = assets.filter((u) => HASHED.test(u))
const fixed = assets.filter((u) => !HASHED.test(u))

const bad = responses.filter((r) => r.status >= 400)
const realFailures = failures.filter((f) => !f.canceled)
const problems = []
if (bad.length) problems.push(`${bad.length} HTTP >= 400 response(s)`)
if (realFailures.length) problems.push(`${realFailures.length} failed request(s)`)
if (consoleErrors.length) problems.push(`${consoleErrors.length} console error(s)`)
if (state.canvases < 4) problems.push(`expected >= 4 canvases, saw ${state.canvases}`)
if (!state.sceneWrapBox || state.sceneWrapBox.w <= 0 || state.sceneWrapBox.h <= 0) problems.push('the board hit box (#scene-wrap) has no area')
if (!state.hasWebGL) problems.push('WebGL is unavailable in this browser')
if (state.bootCurtain !== 'absent' && state.bootCurtain !== 'none') problems.push(`the boot curtain is still showing (display: ${state.bootCurtain})`)

console.log(`url                 ${URL}`)
console.log(`title               ${state.title}`)
console.log(`version badge       ${state.versionBadge ? `${state.versionBadge.text} (${state.versionBadge.display}, ${state.versionBadge.w}x${state.versionBadge.h})` : 'ABSENT'}`)
console.log(`canvases / #app     ${state.canvases} / ${state.appChildren} children   WebGL: ${state.hasWebGL}`)
console.log(`#scene-wrap box     ${state.sceneWrapBox ? `${state.sceneWrapBox.w}x${state.sceneWrapBox.h}` : 'ABSENT'}`)
console.log(`boot curtain        ${state.bootCurtain}`)
console.log(`still-mode handles  ${state.stillModeHandlesPresent ? 'present (the acceptance gate can run here)' : 'ABSENT — tools/screenshot.mjs cannot run against this artifact (§C0.4 pinning)'}`)
console.log(`requests            ${responses.length} response(s)  ${[...byType].map(([t, n]) => `${t}:${n}`).join('  ')}`)
console.log(`  content-hashed    ${hashed.length}`)
console.log(`  fixed-name        ${fixed.length}`)
console.log(`retired-asset reqs  ${retiredRequests.length}${retiredRequests.length ? '  <- ' + retiredRequests.join(', ') : ''}`)
if (bad.length) for (const r of bad.slice(0, 10)) console.log(`  HTTP ${r.status}  ${r.url}`)
if (realFailures.length) for (const f of realFailures.slice(0, 10)) console.log(`  FAILED  ${f.url}  ${f.error}`)
if (consoleErrors.length) for (const e of consoleErrors.slice(0, 10)) console.log(`  CONSOLE ${e.slice(0, 200)}`)
console.log(problems.length ? `\ndeploy-smoke: ${problems.length} problem(s): ${problems.join('; ')}` : '\ndeploy-smoke: OK — no failed requests, no console errors, app alive')

await send('Browser.close', {}, false).catch(() => {})
await new Promise((r) => setTimeout(r, 400))
try { rmSync(profile, { recursive: true, force: true, maxRetries: 8 }) } catch {}
process.exitCode = problems.length ? 1 : 0

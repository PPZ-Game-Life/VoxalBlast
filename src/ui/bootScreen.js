// Boot curtain (v0.11.2) — the screen the player looks at while the page is still assembling.
//
// Why it exists: reopening the game used to show the machinery. Between the first paint and the
// first playable frame the page displayed an empty candidate tray, a fully live item strip and
// the opening wave's primer stage — grey blocks with the cube's core showing through a half-built
// shell. The producer read that as 「卡在一个奇怪的页面」. The curtain is opaque from the static
// markup (index.html carries its first-paint floor inline), it swallows every pointer event while
// it is up, and it leaves only when the scene is COMPLETE.
//
// What this module OWNS: the element's state machine — showing → fading → done — and the one
// question "is the scene complete yet". What it does NOT own: what "complete" means. That is the
// caller's predicate (`isReady`), because only main knows when the tray has been dealt AND
// painted; a second opinion here would be a second definition of ready.
//
// Two guards matter more than the effect itself:
//   * TWO consecutive ready frames. `isReady()` turns true on the frame the tray's slots are
//     rendered, and the piece PREVIEWS are painted on the next one — lifting the curtain on the
//     first true frame would reveal a tray that is still blank.
//   * a HARD TIMEOUT. A loading screen that never goes away is far worse than the seam it hides:
//     if the deal never lands, the curtain lifts anyway and the run's own stuck flow (which
//     exists for exactly this) takes over in the player's sight.
export function createBootScreen({ els, isReady, minMs = 600, timeoutMs = 9000, fadeMs = 260 }) {
  const { bootEl } = els
  let state = 'showing' // showing | fading | done
  let reason = null
  let startedAt = performance.now()
  let liftedAt = 0
  let readyStreak = 0
  let frame = 0
  let fadeTimer = 0

  function finish(why) {
    if (state !== 'showing') return false
    state = 'fading'
    reason = why
    liftedAt = performance.now()
    bootEl.classList.add('done')
    bootEl.setAttribute('aria-hidden', 'true')
    fadeTimer = setTimeout(() => {
      state = 'done'
      // Removed, not merely transparent: an invisible full-screen element that still exists is
      // the thing that eats a click six months from now.
      bootEl.remove()
    }, fadeMs)
    return true
  }

  // Start watching. Called once, from main's boot tail, after the run exists and the wave has
  // been settled — so the first frame the player sees on the other side is a finished one.
  function release() {
    startedAt = performance.now()
    const tick = () => {
      frame = 0
      if (state !== 'showing') return
      const elapsed = performance.now() - startedAt
      if (elapsed >= timeoutMs) return finish('timeout')
      readyStreak = isReady() ? readyStreak + 1 : 0
      if (elapsed >= minMs && readyStreak >= 2) return finish('ready')
      frame = requestAnimationFrame(tick)
    }
    if (!frame) frame = requestAnimationFrame(tick)
    return report()
  }

  // Read-only projection for the headless checks: which state the curtain is in, WHY it left, and
  // how long it was up. `elapsed` FREEZES at the lift — it is the number a check can compare
  // against a budget, and a running clock would only say when it was read.
  function report() {
    return {
      state,
      reason,
      visible: state !== 'done',
      elapsed: Math.round((liftedAt || performance.now()) - startedAt),
    }
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame)
    if (fadeTimer) clearTimeout(fadeTimer)
    frame = 0
    fadeTimer = 0
  }

  return { release, report, stop }
}

// Device vibration capability — the ONE place that decides whether a Haptic buzz can actually
// reach the player's hand on this device (v0.9.19).
//
// Why this is a module and not `if (navigator.vibrate)` at the call site: **the function's
// existence proves nothing.** Measured on Windows Edge 154 with real CDP input and a stub that
// logged every call (the run is recorded in docs/Planning/04-MVP验收清单.md):
//
//   - Desktop Chrome/Edge EXPOSE `navigator.vibrate` and return `true` from it, but a desktop
//     has no vibrator, so every call is a no-op. A page that only asks "does the function
//     exist" will happily offer a switch that can never be felt.
//   - iOS Safari — and therefore every iOS browser and WebView (Chrome, WeChat) — does not
//     expose it at all. The call is skipped: the same silence for a different reason.
//   - Android Chrome and the WeChat X5 WebView DO vibrate, and the player's own tap already
//     satisfies the user-activation the API requires.
//
// So the test is "the API exists AND this is a mobile-class device". `navigator.userAgentData.mobile`
// is the accurate signal where it exists (Chromium); the UA regex is the fallback for engines
// that ship no UA-CH. It is deliberately forgiving: a false positive costs nothing (the
// hardware decides), while a false negative would take a working feature away from an Android
// player.
//
// The shipped preference ('voxalblast-haptics', absent = ON) is deliberately NOT read or
// written here: it is per-origin and belongs to the player, who may open the same game on a
// phone where the switch is live.
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i

function isMobileClass() {
  try {
    const uaData = navigator.userAgentData
    if (uaData && uaData.mobile === true) return true
  } catch {
    // A locked-down navigator: fall through to the UA string rather than reporting "no".
  }
  try {
    return MOBILE_UA.test(navigator.userAgent || '')
  } catch {
    return false
  }
}

// True only when a buzz could be FELT here. The settings row uses it to decide whether to offer
// the switch at all (03 §3.2); no gameplay path branches on it — the switch and the pattern are
// what the game cares about.
export function hapticsSupported() {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false
    return isMobileClass()
  } catch {
    return false
  }
}

// Fire a buzz, and report whether the platform ACCEPTED it — that is `navigator.vibrate`'s own
// contract: `false` means the call was ignored (no hardware, no user activation yet, or a
// policy refused it). Never throws: a hardened navigator must not take a placement down.
export function vibrate(pattern) {
  try {
    return navigator.vibrate(pattern) === true
  } catch {
    return false
  }
}

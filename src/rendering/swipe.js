// Pure decisions behind the cube's swipe-to-rotate model (v0.2.29).
//
// No DOM and no three.js in here on purpose: main.js feeds raw pointer deltas in
// and applies the result to the pose, and the headless probe can exercise these
// exact functions instead of a copy of them. Everything that depends on the
// canvas, the camera or the cube's current pose stays in main.js.
import { ROTATE_STYLE as style } from './config.js'

// Which part of the screen the finger went down in, as client x against the cube's
// own silhouette: 'cube' is the cube's horizontal span, 'left' / 'right' are the side
// bands outside it. Sampled once, where the gesture starts — a drag never changes
// meaning halfway through.
export function screenBand(clientX, bounds) {
  if (clientX < bounds.minX) return 'left'
  return clientX > bounds.maxX ? 'right' : 'cube'
}

// One gesture drives exactly ONE axis: the dominant screen direction wins, so a
// diagonal swipe can never tilt two axes at once.
export function pickGestureAxis(dx, dy, band) {
  return Math.abs(dx) >= Math.abs(dy) ? 'yaw' : band === 'cube' ? 'pitch' : 'roll'
}

// The roll's sign per band (v0.8.1). ROTATE_STYLE signs all three axes so the cube's
// surface travels WITH the finger, but a roll is an in-plane spin: "with the finger"
// only means something once you say WHICH edge the finger is holding. Hold the right
// edge, drag down, and the right edge has to travel down. Both bands took the same
// sign until v0.8.1, so exactly one of them followed the finger while the other
// fought it — reported as "a swipe in the right blank area is right, the left one
// turns the other way". rollDirection stays the single direction knob; the band only
// decides which way round that knob is applied.
//
// Screen sense, for the record: the camera sits on +Z, so a positive angle about
// world +Z is anticlockwise on screen. Downward drag in the RIGHT band = clockwise
// (rollDirection is -1, exactly as before), downward drag in the LEFT band =
// anticlockwise, which is the quarter the Q key plans.
export function bandRollSign(band) {
  return band === 'left' ? -1 : 1
}

// ...but "dominant" has to mean the direction the gesture is actually going, not
// just whichever direction happened to move first. Committing at the first 6px of
// travel meant a finger that started with a few px of sideways drift and then went
// straight down claimed YAW; a claimed gesture ignores the other axis, so the
// whole vertical drag was thrown away and the cube did not move at all — the
// "sometimes it just won't turn, it feels locked" report (v0.2.29).
//
// The claim now waits until the leading direction is decisive (`axisDominance`)
// over at least `axisLockPx` of travel; a drag that is still ambiguous after
// `axisHardLockPx` falls back to the plain larger-wins rule, so a deliberate
// diagonal can never stall. Re-tested on every move until it commits, so a
// hesitant start is free: the live angle is measured from where the finger went
// down, never from where the axis was claimed.
export function gestureAxisReady(dx, dy) {
  const lead = Math.max(Math.abs(dx), Math.abs(dy))
  if (lead < style.axisLockPx) return false
  if (lead >= style.axisHardLockPx) return true
  return lead >= style.axisDominance * Math.min(Math.abs(dx), Math.abs(dy))
}

// Drag -> angle for the claimed axis, in radians, signed by the per-axis direction
// knob and — for the roll — by the band the finger landed in. The ruler is the cube's
// on-screen silhouette (`span`, sampled by main.js where the gesture commits), not the
// canvas: a canvas-relative ruler made one face step cost ~185px of horizontal drag on
// a 1120px-wide desktop canvas while the same step cost ~65px on a phone, so on desktop
// an ordinary swipe simply sprang back — reported as "sometimes it won't turn"
// (v0.2.29).
export function swipeAngle(axis, dx, dy, span, band) {
  if (axis === 'yaw') return style.yawDirection * dx / span.x * Math.PI
  // Vertical: pitch inside the cube's span, roll (in-plane spin) in the side bands.
  // Roll spins the way the finger travels — which, for a spin, is the band's own edge:
  // down in the right band is clockwise, down in the left band is anticlockwise.
  if (axis === 'pitch') return style.pitchDirection * dy / span.y * Math.PI
  return style.rollDirection * bandRollSign(band) * dy / span.y * Math.PI
}

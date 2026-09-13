// Keyboard rotation for the PC build (v0.4.1) — docs/Planning/03 §13.
//
// Same discipline as swipe.js: no DOM, no three.js, just the decision. main.js owns
// the pose, the camera and the animation; this file only answers "which world axis
// does this key turn, and which way round".
//
// The mapping is deliberately expressed as THE SWIPE IT EQUALS, not as a direction
// of its own. A key press has to end on exactly the pose a committed one-face drag
// ends on, or the same cube would sit differently after W than after swiping up —
// two input methods, one model (§13.2).
//
//   W = swipe up      S = swipe down            -> pitch, world X
//   A = swipe left    D = swipe right           -> yaw,   world Y
//   Q = spin against  E = spin with the finger  -> roll,  world Z
//
// `spin` is the side-band gesture (§3): "with the finger" is a downward drag inside
// a side band, which is clockwise on screen. Q is its mirror.
//
// The returned `direction` is a MULTIPLIER on the per-axis knob in
// ROTATE_STYLE.yawDirection / pitchDirection / rollDirection — the same knob
// swipeAngle() multiplies — so flipping a direction there flips the keys with it and
// the two input methods can never disagree.
const KEY_MAP = new Map([
  ['w', { axis: 'pitch', direction: -1 }],
  ['s', { axis: 'pitch', direction: 1 }],
  ['a', { axis: 'yaw', direction: -1 }],
  ['d', { axis: 'yaw', direction: 1 }],
  ['q', { axis: 'roll', direction: -1 }],
  ['e', { axis: 'roll', direction: 1 }],
])

// The six bindings, in the order the controls card prints them. The card's rows are
// static HTML (the mini cube and its axis ring are hand-tuned CSS), so this list is
// the source of truth the headless check compares that HTML against: one row per
// binding, two keycaps per row, and every keycap has to resolve through
// axisForKey() — a legend that prints a key the game ignores is worse than no legend.
export const KEY_BINDINGS = Object.freeze([
  Object.freeze({ axis: 'pitch', primary: 'W', secondary: 'S', keys: Object.freeze(['w', 's']) }),
  Object.freeze({ axis: 'yaw', primary: 'A', secondary: 'D', keys: Object.freeze(['a', 'd']) }),
  Object.freeze({ axis: 'roll', primary: 'Q', secondary: 'E', keys: Object.freeze(['q', 'e']) }),
])

// `{ axis, direction }` for a key event's `key`, or null when the key is not a
// rotation binding. Case-insensitive, so a held Shift or Caps Lock cannot kill the
// controls; the six keys sit in the same place on the layouts we ship.
export function axisForKey(key) {
  if (typeof key !== 'string') return null
  return KEY_MAP.get(key.toLowerCase()) || null
}

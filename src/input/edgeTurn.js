import { PIECE_SPIN } from '../rendering/config.js'

const DIRECTIONS = {
  left: { axis: 'yaw', direction: -1 },
  right: { axis: 'yaw', direction: 1 },
  top: { axis: 'pitch', direction: -1 },
  bottom: { axis: 'pitch', direction: 1 },
}

// v0.9.11 — the trigger is the PIECE IN HAND, not the pointer and not the screen.
//
// `point` is the carried piece's own bounding-box CENTRE in client pixels (the ghost's group
// origin — the place the player sees the piece), and `bounds` is the CUBE's screen silhouette.
// The centre crossing one of that box's edges is the reading "the block is more than half off
// the cube", which is the gesture the producer asked for:
//   「其实方块超过一半……这个方块的重心到了这个六面体的边缘，超过了六面体的边缘，就进入这个
//     翻转的识别状态」.
// The rule it replaces measured the POINTER against a band at the edge of the VIEWPORT
// (PIECE_SPIN.edgePx = 36px), so the piece had to be dragged past the tray and past the meadows
// to the far side of the screen before the cube would even arm.
//
// `armPx` is the extra overhang past the edge the centre has to reach before the dwell starts:
// 0 = "the moment it is more than half out". There is deliberately NO inward hysteresis here.
// An earlier draft kept the chosen side until the centre came back `exitSlopPx` INSIDE the
// cube; that reads well on its own, but it breaks the placement gesture: while the arm is held,
// `updateDrag()` returns before `updatePreview()` ever runs, so a piece whose centre is over the
// cube again — a Dot, whose centre IS the whole block — keeps being carried and never re-attaches.
// `probe:drag` case C caught exactly that ("coming back less than one cell from the edge moves the
// piece" went red on both sides). The side is therefore chosen from scratch on every frame, and a
// centre over the cube is simply "not turning".
export function cubeEdge(point, bounds) {
  const overshoot = {
    left: bounds.minX - point.x,
    right: point.x - bounds.maxX,
    top: bounds.minY - point.y,
    bottom: point.y - bounds.maxY,
  }
  let best = null
  for (const edge of Object.keys(overshoot)) {
    if (overshoot[edge] <= PIECE_SPIN.armPx) continue
    if (best === null || overshoot[edge] > overshoot[best]) best = edge
  }
  return best
}

// v0.9.13 — THE WAY IN IS NOT A WAY OUT. Every candidate is dragged UP out of the tray, and the
// tray sits below the cube, so the piece's centre necessarily crosses the cube's BOTTOM edge on
// its way in. That crossing used to arm the dwell immediately: the block would sit at the cube's
// foot for 650ms on the way in and the cube would tip over before the player had placed anything
// (producer, 2026-09-28: 「推动备选区方块都是从下方推上来，过程中必然会触发」).
//
// The fix is a latch, not a threshold: until the piece has been INSIDE the cube's silhouette,
// nothing outside it can arm. The first crossing is the entry, and only a LATER exit counts.
// `inside` is that latch — it must be true once before `cubeEdge()` is allowed to answer.
//
// It is deliberately tied to the piece's own centre rather than to `drag.face`: the centre is
// what the whole rule is measured with, and a piece can be carried up past the bottom edge
// without ever attaching (a full face, or a drag that entered through a corner), so "it has been
// on a face" would leave those drags permanently unable to turn.
export function createEntryLatch() {
  let inside = false
  return {
    // Call with every new centre position, BEFORE asking `cubeEdge()`.
    observe(point, bounds) {
      if (!inside && point.x >= bounds.minX && point.x <= bounds.maxX
        && point.y >= bounds.minY && point.y <= bounds.maxY) inside = true
      return inside
    },
    // A new gesture starts outside the cube again: the piece is picked up from the tray.
    reset() { inside = false },
    get entered() { return inside },
  }
}

// A frame clock also handles a motionless finger and pauses the repeat dwell
// until the previous face has actually arrived. No timers survive cancel().
//
// `bounds` is read live (the cube is re-projected on every resize, zoom and turn), and the
// feedback carries the point where the edge was ARMED rather than the live one: the hint is
// drawn next to the piece, and a card that chased the finger would jitter under it.
export function createEdgeTurn({ bounds, blocked, turning, turn, feedback, haptic,
  now = () => performance.now(), frame = cb => requestAnimationFrame(cb),
  cancelFrame = id => cancelAnimationFrame(id) }) {
  let point = null
  let anchor = { x: 0, y: 0 }
  let edge = null
  let started = 0
  let phase = 'hold'
  let raf = null
  const entry = createEntryLatch()

  function report(progress) {
    feedback({ edge, phase, progress, x: anchor.x, y: anchor.y })
  }

  function cancel() {
    if (raf !== null) cancelFrame(raf)
    raf = null
    point = null
    anchor = { x: 0, y: 0 }
    edge = null
    feedback(null)
  }

  // One reading of "which side is this centre past, if any". The latch comes first, so a piece
  // that has never been inside the cube answers "none" however far out it is.
  function armAt(nextPoint, boundsNow) {
    if (!entry.observe(nextPoint, boundsNow)) return null
    return cubeEdge(nextPoint, boundsNow)
  }

  function tick() {
    raf = null
    if (blocked()) { cancel(); return }
    if (phase === 'turning') {
      // Our own turn is in flight. The arming test cannot run yet: the cube's silhouette is
      // MID-SLERP and grows past its settled box for a few frames (measured on a 430x900 phone:
      // x 79..356 -> 30..407 while the pose turns), so a stationary piece that is still past the
      // edge would read as "back inside" and the dwell would be dropped. Wait for the face to
      // land, then re-measure against the settled silhouette: still past it re-arms with a FRESH
      // dwell (holding off the cube browses faces, one dwell each), back inside cancels.
      if (turning()) { raf = frame(tick); return }
      const arrived = armAt(point, bounds())
      if (!arrived) { cancel(); return }
      edge = arrived
      phase = 'hold'
      started = now()
      report(0)
      raf = frame(tick)
      return
    }
    // A turn somebody else committed (a key, a view gesture) owns the pose. Hold the clock and
    // start a fresh dwell once it lands -- and do not measure the silhouette while it moves, for
    // the reason above.
    if (turning()) { started = now(); raf = frame(tick); return }
    if (armAt(point, bounds()) !== edge) { cancel(); return }
    const progress = Math.min(1, (now() - started) / PIECE_SPIN.holdMs)
    report(progress)
    if (progress >= 1 && turn(DIRECTIONS[edge])) {
      phase = 'turning'
      report(1)
      haptic(14)
    }
    raf = frame(tick)
  }

  function update(nextPoint) {
    const nextEdge = blocked() ? null : armAt(nextPoint, bounds())
    if (!nextEdge) { cancel(); return false }
    point = nextPoint
    if (nextEdge !== edge) {
      edge = nextEdge
      anchor = { x: nextPoint.x, y: nextPoint.y }
      started = now()
      phase = 'hold'
      report(0)
      haptic(6)
    }
    if (raf === null) raf = frame(tick)
    return true
  }

  return { update, cancel, resetEntry: () => entry.reset(),
    report: () => ({ edge, phase: edge ? phase : null, axis: edge ? DIRECTIONS[edge].axis : null,
      entered: entry.entered }) }
}

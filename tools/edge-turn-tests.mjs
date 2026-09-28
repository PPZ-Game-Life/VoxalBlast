import assert from 'node:assert/strict'
import { createEdgeTurn, createEntryLatch, cubeEdge } from '../src/input/edgeTurn.js'
import { PIECE_SPIN } from '../src/rendering/config.js'

// The CUBE's screen silhouette on a 430x900 phone (measured v0.9.11: x 79..356, y 286..601).
// The turn trigger is measured against THIS box and against the carried piece's own centre —
// never against the viewport, which is the rule v0.9.11 replaced.
const cube = { minX: 79, maxX: 356, minY: 286, maxY: 601 }
const points = {
  left: { x: 70, y: 450 },
  right: { x: 366, y: 450 },
  top: { x: 215, y: 278 },
  bottom: { x: 215, y: 610 },
}
const inside = { x: 217, y: 450 }
// v0.9.13: the entry latch. Every dwell test below has to have the piece INSIDE the cube first,
// because a piece that has never been in cannot arm at all (the tray→cube entry crosses the
// bottom edge by construction). `enter()` is that "carry it up into the cube" step.
function harness() {
  let time = 0, callback = null, blocked = false, turning = false, hint = null
  const turns = []
  const control = createEdgeTurn({
    bounds: () => cube, blocked: () => blocked, turning: () => turning,
    turn: direction => { turns.push(direction); turning = true; return true },
    feedback: state => { hint = state }, haptic: () => {}, now: () => time,
    frame: cb => { callback = cb; return 1 }, cancelFrame: () => { callback = null },
  })
  return { control, turns, hint: () => hint,
    enter: () => control.update(inside),
    block: () => { blocked = true }, arrive: () => { turning = false },
    advance(ms) { time += ms; const cb = callback; callback = null; cb?.() },
  }
}

for (const [edge, point] of Object.entries(points)) {
  const h = harness()
  h.enter()
  assert.equal(h.control.update(point), true)
  assert.equal(h.hint().edge, edge)
  assert.equal(h.hint().x, point.x, 'the card is anchored where the edge was armed')
  assert.equal(h.hint().y, point.y)
  h.advance(PIECE_SPIN.holdMs - 1)
  assert.equal(h.turns.length, 0, 'movement alone cannot skip the dwell')
  h.advance(1)
  assert.deepEqual(h.turns, [{ axis: ['left', 'right'].includes(edge) ? 'yaw' : 'pitch', direction: ['left', 'top'].includes(edge) ? -1 : 1 }])
  assert.equal(h.hint().phase, 'turning')
  h.advance(10000)
  assert.equal(h.turns.length, 1, 'never queue turns during animation')
  h.arrive(); h.advance(1); h.advance(PIECE_SPIN.holdMs - 1)
  assert.equal(h.turns.length, 1, 'repeat needs a full fresh dwell after arrival')
  h.advance(1)
  assert.equal(h.turns.length, 2)
  h.control.cancel(); h.advance(10000)
  assert.equal(h.turns.length, 2)
  assert.equal(h.hint(), null)
}

for (const interrupt of [h => h.control.cancel(), h => h.block(), h => h.control.update(inside)]) {
  const h = harness(); h.enter(); h.control.update(points.left); h.advance(300)
  interrupt(h); h.advance(10000)
  assert.equal(h.turns.length, 0, 'cancel / pause / carrying the piece back inside cannot turn later')
  assert.equal(h.hint(), null)
}
const h = harness()
h.enter(); h.control.update(points.left); h.advance(500); h.control.update(points.top); h.advance(500)
assert.equal(h.turns.length, 0, 'changing edges resets the dwell')
h.advance(150); assert.equal(h.turns[0].axis, 'pitch')

// v0.9.13 — THE WAY IN IS NOT A WAY OUT. A gesture starts in the tray, BELOW the cube, so its
// first crossing of the bottom edge is the entry. Nothing may arm before the piece has been in.
{
  const h = harness()
  assert.equal(h.control.update({ x: 217, y: 700 }), false, 'a piece still below the tray edge does not arm')
  assert.equal(h.control.update(points.bottom), false, 'and crossing the bottom edge on the way IN does not arm either')
  assert.equal(h.hint(), null, 'no card on the way in')
  h.advance(PIECE_SPIN.holdMs * 4)
  assert.equal(h.turns.length, 0, 'holding at the cube foot on the way in never turns it')
  // Up into the cube: the latch closes...
  assert.equal(h.control.update(inside), false)
  assert.equal(h.control.report().entered, true)
  // ...and from here the bottom edge is an EXIT, so it arms.
  assert.equal(h.control.update(points.bottom), true)
  assert.equal(h.hint().edge, 'bottom')
  h.advance(PIECE_SPIN.holdMs)
  assert.equal(h.turns.length, 1, 'leaving through the bottom edge after entering does turn')
}
// The latch is per gesture: a fresh drag starts outside the cube again.
{
  const h = harness()
  h.enter()
  assert.equal(h.control.report().entered, true)
  h.control.resetEntry()
  assert.equal(h.control.report().entered, false)
  assert.equal(h.control.update(points.bottom), false, 'the next drag has to enter again before it can turn')
}
// The latch itself, without the clock.
{
  const latch = createEntryLatch()
  assert.equal(latch.observe({ x: 217, y: 700 }, cube), false, 'starting below the cube leaves the latch open')
  assert.equal(latch.observe({ x: 217, y: 610 }, cube), false, 'crossing the bottom edge outward-in is not "inside" yet')
  assert.equal(latch.observe({ x: 217, y: 590 }, cube), true, 'crossing it into the cube closes the latch')
  assert.equal(latch.observe({ x: 217, y: 700 }, cube), true, 'and it stays closed once the piece leaves again')
  latch.reset()
  assert.equal(latch.entered, false, 'a new gesture starts outside again')
  assert.equal(latch.observe({ x: 217, y: 610 }, cube), false)
}
// The trigger itself: the carried piece's centre against the cube's own edges.
assert.equal(cubeEdge(inside, cube), null, 'a centre over the cube never arms')
assert.equal(cubeEdge({ x: cube.minX, y: 450 }, cube), null, 'exactly on the edge is not past it')
assert.equal(cubeEdge({ x: cube.minX - 0.5, y: 450 }, cube), 'left', 'past the edge arms at once (armPx 0)')
assert.equal(cubeEdge({ x: cube.maxX + 1, y: 450 }, cube), 'right')
assert.equal(cubeEdge({ x: 215, y: cube.minY - 1 }, cube), 'top')
assert.equal(cubeEdge({ x: 215, y: cube.maxY + 1 }, cube), 'bottom')
// Corner: the deeper overshoot wins, and the side is re-chosen from scratch every frame — there
// is NO inward hysteresis, because a held arm is exactly what would stop the piece re-attaching
// when it comes back over the cube (the placement gesture, pinned by probe:drag case C).
assert.equal(cubeEdge({ x: 70, y: 280 }, cube), 'left', 'the deeper overshoot wins a corner')
assert.equal(cubeEdge({ x: 74, y: 280 }, cube), 'top', 'and the side follows the crossover, with no memory of the last one')
assert.equal(cubeEdge({ x: cube.minX + 4, y: 450 }, cube), null, 'a centre back over the cube is simply not turning')
assert.equal(cubeEdge({ x: cube.maxX - 4, y: 450 }, cube), null)
console.log('Edge turns: four directions, cube-relative trigger, entry latch, dwell, repeat, cancellation and corners passed')

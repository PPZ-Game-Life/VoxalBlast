import assert from 'node:assert/strict'
import { createEdgeTurn, cubeEdge } from '../src/input/edgeTurn.js'
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
    block: () => { blocked = true }, arrive: () => { turning = false },
    advance(ms) { time += ms; const cb = callback; callback = null; cb?.() },
  }
}

for (const [edge, point] of Object.entries(points)) {
  const h = harness()
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
  const h = harness(); h.control.update(points.left); h.advance(300)
  interrupt(h); h.advance(10000)
  assert.equal(h.turns.length, 0, 'cancel / pause / carrying the piece back inside cannot turn later')
  assert.equal(h.hint(), null)
}
const h = harness()
h.control.update(points.left); h.advance(500); h.control.update(points.top); h.advance(500)
assert.equal(h.turns.length, 0, 'changing edges resets the dwell')
h.advance(150); assert.equal(h.turns[0].axis, 'pitch')

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
console.log('Edge turns: four directions, cube-relative trigger, dwell, repeat, cancellation and corners passed')

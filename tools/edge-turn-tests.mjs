import assert from 'node:assert/strict'
import { createEdgeTurn, screenEdge } from '../src/input/edgeTurn.js'
import { PIECE_SPIN } from '../src/rendering/config.js'

const bounds = { left: 0, top: 0, width: 430, height: 900 }
const points = { left: { x: 8, y: 450 }, right: { x: 422, y: 450 }, top: { x: 215, y: 8 }, bottom: { x: 215, y: 892 } }
function harness() {
  let time = 0, callback = null, blocked = false, turning = false, hint = null
  const turns = []
  const control = createEdgeTurn({
    bounds: () => bounds, blocked: () => blocked, turning: () => turning,
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

for (const interrupt of [h => h.control.cancel(), h => h.block(), h => h.control.update({ x: 215, y: 450 }), h => h.control.update({ x: -1, y: 450 })]) {
  const h = harness(); h.control.update(points.left); h.advance(300)
  interrupt(h); h.advance(10000)
  assert.equal(h.turns.length, 0, 'cancel / pause / retreat / leaving viewport cannot turn later')
  assert.equal(h.hint(), null)
}
const h = harness()
h.control.update(points.left); h.advance(500); h.control.update(points.top); h.advance(500)
assert.equal(h.turns.length, 0, 'changing edges resets the dwell')
h.advance(150); assert.equal(h.turns[0].axis, 'pitch')
assert.equal(screenEdge({ x: 5, y: 1 }, bounds, 'left'), 'left', 'corner stays on one axis')
assert.equal(screenEdge({ x: 40, y: 450 }, bounds, 'left'), 'left', 'small inward jitter stays armed')
assert.equal(screenEdge({ x: 45, y: 450 }, bounds, 'left'), null)
assert.equal(screenEdge({ x: 215, y: 450 }, bounds), null)
console.log('Edge turns: four directions, dwell, repeat, cancellation, corners and hysteresis passed')

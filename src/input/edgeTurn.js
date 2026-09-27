import { PIECE_SPIN } from '../rendering/config.js'

const DIRECTIONS = {
  left: { axis: 'yaw', direction: -1 },
  right: { axis: 'yaw', direction: 1 },
  top: { axis: 'pitch', direction: -1 },
  bottom: { axis: 'pitch', direction: 1 },
}

// Use the pointer, not the lifted ghost or the cube silhouette. Keep the chosen
// edge at corners until the pointer leaves it, so a shaky hold cannot switch axes.
export function screenEdge(point, bounds, current = null) {
  const { x, y } = point
  const { left, top, width, height } = bounds
  if (x < left || x > left + width || y < top || y > top + height) return null
  const band = Math.min(PIECE_SPIN.edgePx, width * 0.1, height * 0.1)
  const distances = { left: x - left, right: left + width - x, top: y - top, bottom: top + height - y }
  if (current && distances[current] <= band + PIECE_SPIN.exitSlopPx) return current
  return Object.keys(distances).filter(edge => distances[edge] <= band)
    .sort((a, b) => distances[a] - distances[b])[0] ?? null
}

// A frame clock also handles a motionless finger and pauses the repeat dwell
// until the previous face has actually arrived. No timers survive cancel().
export function createEdgeTurn({ bounds, blocked, turning, turn, feedback, haptic,
  now = () => performance.now(), frame = cb => requestAnimationFrame(cb),
  cancelFrame = id => cancelAnimationFrame(id) }) {
  let point = null
  let edge = null
  let started = 0
  let phase = 'hold'
  let raf = null

  function cancel() {
    if (raf !== null) cancelFrame(raf)
    raf = null
    point = null
    edge = null
    feedback(null)
  }

  function tick() {
    raf = null
    if (!edge || blocked() || screenEdge(point, bounds(), edge) !== edge) { cancel(); return }
    if (phase === 'turning') {
      if (!turning()) { phase = 'hold'; started = now() }
    } else if (turning()) {
      started = now()
    } else {
      const progress = Math.min(1, (now() - started) / PIECE_SPIN.holdMs)
      feedback({ edge, phase, progress })
      if (progress >= 1 && turn(DIRECTIONS[edge])) {
        phase = 'turning'
        feedback({ edge, phase, progress: 1 })
        haptic(14)
      }
    }
    raf = frame(tick)
  }

  function update(nextPoint) {
    const nextEdge = blocked() ? null : screenEdge(nextPoint, bounds(), edge)
    if (!nextEdge) { cancel(); return false }
    point = nextPoint
    if (nextEdge !== edge) {
      edge = nextEdge
      started = now()
      phase = 'hold'
      feedback({ edge, phase, progress: 0 })
      haptic(6)
    }
    if (raf === null) raf = frame(tick)
    return true
  }

  return { update, cancel, report: () => ({ edge, phase: edge ? phase : null,
    axis: edge ? DIRECTIONS[edge].axis : null }) }
}

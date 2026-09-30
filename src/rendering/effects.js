// Effects - paper celebration, line bands, marks, camera shake, slow motion and haptics (P5).
//
// docs/Technical/CLEAR_CELEBRATION_AUDIO_HANDOFF.md §2–§4, §7, §8 (implemented 2026-09-30, v0.10.1).
//
// What changed and why, in one paragraph: the old clear sprayed ADDITIVE-blended sprites and
// multiplied the burst by BOTH the number of cleared lines and the level's own scale, so a
// four-line L4 could put fifty times a single line's particles on screen and the whole thing
// read as sparks rather than paper (§1). Every number here is now allocated per EVENT: the
// level picks one budget, the cleared cells are DE-DUPLICATED (a shared edge is one cell, one
// space segment, one band), and no line can multiply anything. Paper is drawn with normal
// blending in the garden's three paper tones, the line band is a single restrained pulse, and
// the moment a new drag or tool scope appears the decoration gets out of its way (§7.2).
//
// The module still owns exactly what it owned after refactor P5 - the batched particle
// renderer, the transient list, the shake offset, the L5 slow-motion dip and the haptics - and
// no longer owns sound: the audio bus moved to src/audio/gameAudio.js (§9), because "one main
// cue per event" is a scheduling question that needed a master, a scene and a lifecycle.
//
// Everything main used to close over still arrives as a parameter: the scene and camera, the
// cube group and boardView's conversions (called, never re-derived), the resolved quality tier
// and haptics' switch as a LIVE getter, because a captured boolean would go stale the moment
// the player flips one.
import './threeCompat.js'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ConstantColor,
  ConstantValue,
  Gradient,
  ParticleSystem,
  PiecewiseBezier,
  RenderMode,
  SizeOverLife,
  SpeedOverLife,
} from 'three.quarks'
import { CELEBRATION, VFX_CONFIG, FEEDBACK_STYLE, BOARD_STYLE as style } from './config.js'
// The buzz is the platform's, not the renderer's: whether a vibrate call can be felt at all is
// a device question with its own measurements (platform/haptics.js header).
import { vibrate } from '../platform/haptics.js'

// §8: reduced motion is its own axis. It is queried, never stored, and it closes MOTION only -
// sound and haptics are different preferences with different switches (§6.3).
function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

// §4.2: a landscape phone or a small handset has no safe margin for a fan of paper. The answer is
// to decorate LESS, never to shrink the board — and the line band, the real score and the main
// sound are not decoration, so none of them is affected by this.
function crampedViewport() {
  return window.innerHeight <= CELEBRATION.cramped.maxHeight || window.innerWidth <= CELEBRATION.cramped.maxWidth
}

// The celebration's shapes come from the handoff's own SVG symbol paths (§2.1), parsed here so
// the 3D marks and any future HUD use of the same file cannot drift apart. Only the absolute
// commands the file actually uses are supported, and anything else throws loudly rather than
// silently drawing the wrong shape.
function pathShape(path, viewBox, size, out = new THREE.Shape()) {
  const [vbWidth, vbHeight] = viewBox
  const scale = size / vbWidth
  const tx = (x) => (x - vbWidth / 2) * scale
  const ty = (y) => (vbHeight / 2 - y) * scale
  const tokens = String(path).match(/[MLQCZmlqcz]|-?\d*\.?\d+/g) || []
  let command = null
  let index = 0
  const next = () => Number(tokens[index++])
  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index])) {
      command = tokens[index].toUpperCase()
      index += 1
      if (command !== 'M' && command !== 'L' && command !== 'Q' && command !== 'C' && command !== 'Z') {
        throw new Error(`celebration path uses an unsupported command: ${command}`)
      }
      continue
    }
    if (command === 'M' || command === 'L') {
      const x = next(); const y = next()
      if (command === 'M') out.moveTo(tx(x), ty(y)); else out.lineTo(tx(x), ty(y))
    } else if (command === 'Q') {
      const cx = next(); const cy = next(); const x = next(); const y = next()
      out.quadraticCurveTo(tx(cx), ty(cy), tx(x), ty(y))
    } else if (command === 'C') {
      const c1x = next(); const c1y = next(); const c2x = next(); const c2y = next(); const x = next(); const y = next()
      out.bezierCurveTo(tx(c1x), ty(c1y), tx(c2x), ty(c2y), tx(x), ty(y))
    } else if (command === 'Z') {
      out.closePath()
    }
  }
  return out
}

const SPARKLE_PATH = 'M32 5Q35 24 42 27L59 32Q40 35 37 42L32 59Q29 40 22 37L5 32Q24 29 27 22Z'
const SEAL_PATH = 'M29 6Q32 1 35 6L42 21L58 23Q64 24 59 29L47 41L50 57Q51 63 45 60L32 53L19 60Q13 63 14 57L17 41L5 29Q0 24 6 23L22 21Z'
const RIBBON_PATH = 'M18 4C-2 28 58 25 42 53C36 63 21 75 24 89L38 94C33 80 51 69 56 57C71 23 15 23 32 9Z'

function buildRoundedRectGeometry(width, height, radius) {
  const shape = new THREE.Shape()
  const x = -width / 2
  const y = -height / 2
  const r = Math.min(radius, Math.min(width, height) / 2)
  shape.moveTo(x + r, y)
  shape.lineTo(x + width - r, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + r)
  shape.lineTo(x + width, y + height - r)
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  shape.lineTo(x + r, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - r)
  shape.lineTo(x, y + r)
  shape.quadraticCurveTo(x, y, x + r, y)
  shape.closePath()
  return new THREE.ShapeGeometry(shape, 3)
}

export function createEffects({
  scene,
  camera,
  cubeGroup,
  cubeSide,
  // The lattice pitch is main's constant (main.js `cs`); the paper sizes the doc gives are in
  // CELLS, so one number has to cross the boundary rather than being assumed to be 1.
  cellPitch = 1,
  cellToWorld,
  cubeVector,
  findFrontFace,
  quality,
  getHapticsOn,
  // §7.2: the moment a new drag preview or a tool's own scope appears, decoration over that
  // range has to leave first. main owns both of those states; this arrives as a getter and is
  // read per frame, never captured.
  getInputBusy = () => false,
}) {
  // The effect surfaces (bands, marks) are scene-level: they are world-space objects, not part
  // of the cube, so they must not inherit its rotation.
  const fxGroup = new THREE.Group()
  scene.add(fxGroup)

  let cameraShake = 0
  let transientEffects = []
  // One record per live particle system. `until` is the wall-clock moment its own duration
  // ends, which is what makes `liveSystems` a REAL count instead of the dispose list the old
  // report exposed - three.quarks destroys a finished system itself (autoDestroy), and a Set
  // that only sheds references at the next restart cannot answer "how many are on screen now".
  const systemRecords = new Set()
  let eventId = 0
  let lastEvent = null
  let lastSideEmitAt = -Infinity
  let eventEpoch = 0

  const cellSize = cellPitch
  const celebrationColors = CELEBRATION.colors

  // ---------------------------------------------------------------- geometry pool
  // §7.3: shared geometry/material belong to the pool. A single event destroys its INSTANCES,
  // never the pool, because the next event is a millisecond away.
  const chipGeometries = CELEBRATION.paperTones.map((_, index) => {
    const ratio = CELEBRATION.chip.ratios[index % CELEBRATION.chip.ratios.length]
    const short = CELEBRATION.chip.shortSide * cellSize
    const long = short * ratio
    // A CARD, not a plane: quarks' world-space particles keep their own world rotation, so a
    // flat quad from a side or top face would be edge-on and invisible. The thin body is what
    // lets a five-pixel chip read from every face.
    const geometry = new RoundedBoxGeometry(long, short, short * 0.24, 1, short * 0.2)
    // The §2.2 「最多两次轻翻转」 is BAKED here, one tilt per paper tone. It cannot be a
    // `RotationOverLife` behavior: with RenderMode.Mesh three.quarks fills a QUATERNION rotation
    // attribute while that behavior writes a scalar angle, so every instance matrix comes out
    // NaN and the whole batch draws NOTHING — silently, with the particle count still reporting
    // the full budget. Measured, not guessed: the first version of this file did exactly that.
    //
    // The variance is mostly IN-PLANE (`rotateZ`): a card spun in its own plane stays a readable
    // card from every face, while an out-of-plane tilt that is too large turns it edge-on and the
    // capture shows three paper tones collapsing into one visible tone and two slivers.
    geometry.rotateZ(index * 0.5)
    geometry.rotateX((index - 1) * 0.18)
    return geometry
  })
  const sparkleGeometry = new THREE.ShapeGeometry(
    pathShape(SPARKLE_PATH, [64, 64], CELEBRATION.sparkle.size * cellSize), 4,
  )
  const sealGeometry = new THREE.ShapeGeometry(
    pathShape(SEAL_PATH, [64, 64], CELEBRATION.seal.size * cellSize), 4,
  )
  const recordSealGeometry = new THREE.ShapeGeometry(
    pathShape(SEAL_PATH, [64, 64], CELEBRATION.seal.recordSize * cellSize), 4,
  )
  const ribbonGeometry = new THREE.ShapeGeometry(
    pathShape(RIBBON_PATH, [64, 96], CELEBRATION.ribbon.length * cellSize), 8,
  )
  const bandGeometry = new THREE.BoxGeometry(
    cubeSide + CELEBRATION.band.overshoot * 2 * cellSize,
    CELEBRATION.band.thickness * cellSize,
    CELEBRATION.band.thickness * cellSize,
  )

  // Paper is NOT light: normal blending, depth-write off, and the world keeps its occlusion
  // (a chip behind the cube stays behind it, §3 「看不见的背面保留真实遮挡」).
  const paperMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })

  function markMaterial(color, opacity) {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
    })
  }

  const particleRenderer = new BatchedRenderer()
  scene.add(particleRenderer)

  function colorToVector4(color, alpha = 1) {
    const normalized = new THREE.Color(color)
    return new THREE.Vector4(normalized.r, normalized.g, normalized.b, alpha)
  }

  // ---------------------------------------------------------------- emitters
  // The lattice emitter: one particle per cleared cell, then a few more around it. Positions
  // are RELATIVE to the emitter (quarks transforms them by the emitter's matrix on emit), so
  // the emitter sits on the event centroid and the cells arrive already local.
  class CellEmitter {
    constructor(points, directions, speed) {
      this.type = 'cells'
      this.points = points
      this.directions = directions
      this.speed = speed
      this.spread = VFX_CONFIG.clear.spread
      this.sequence = 0
    }

    initialize(particle) {
      const index = this.sequence++
      const point = this.points[index % this.points.length]
      const direction = this.directions[index % this.directions.length]
      particle.position.copy(point)
      // A deterministic swirl per particle instead of a shared cone: paper leaving a line does
      // not travel in a sheet.
      const phase = index * 2.399963
      particle.velocity.copy(direction)
        .addScaledVector(this.perpendicular(point), Math.cos(phase) * this.spread)
        .normalize()
        .multiplyScalar(particle.startSpeed)
      if (!Number.isFinite(particle.velocity.x)) particle.velocity.set(0, 0.4, 1).normalize().multiplyScalar(particle.startSpeed)
    }

    perpendicular(point) {
      // A single-cell event has no direction to be perpendicular to; world Z is always a valid
      // flight axis off the front face, which is the docked pose.
      if (point.lengthSq() < 1e-6) return new THREE.Vector3(0, 0, 1)
      const axis = Math.abs(point.y) < 0.2 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
      return new THREE.Vector3().crossVectors(axis, point).normalize().add(new THREE.Vector3(0, 0, 1)).normalize()
    }

    toJSON() { return { type: this.type, speed: this.speed, spread: this.spread } }
    clone() { return new CellEmitter(this.points, this.directions, this.speed) }
  }

  // ---------------------------------------------------------------- world helpers
  function worldCell(cell) {
    return cellToWorld(cell[0], cell[1], cell[2]).applyMatrix4(cubeGroup.matrixWorld)
  }

  function faceNormalWorld(face) {
    return cubeVector(face, 'n').applyQuaternion(cubeGroup.quaternion).normalize()
  }

  /** §7.1: the cleared COORDINATES come from lines[].cells; `result.cellsCleared` is a COUNT. */
  function uniqueEntries(lines) {
    const seen = new Map()
    for (const line of lines || []) {
      for (const cell of line.cells) {
        const key = cell.join(',')
        if (seen.has(key)) continue
        seen.set(key, { cell, face: line.face })
      }
    }
    return [...seen.values()]
  }

  /** Two faces sharing an edge produce two lines over ONE space segment: same band, one pulse. */
  function segmentKey(line) {
    return line.cells.map((cell) => cell.join(',')).sort().join('|')
  }

  // The ONE rule that keeps paper visible: a lattice cell is the CENTRE of a block, so anything
  // spawned there is inside opaque geometry. Every effect starts on the FACE SURFACE — the same
  // `feedbackSurfaceOffset` the bands have always used — and flies along that face's own normal.
  function surfacePoint(entry) {
    return worldCell(entry.cell).addScaledVector(faceNormalWorld(entry.face), style.feedbackSurfaceOffset)
  }

  function centroidOfPoints(points) {
    const center = new THREE.Vector3()
    for (const point of points) center.add(point)
    return center.multiplyScalar(1 / Math.max(points.length, 1))
  }

  // ---------------------------------------------------------------- transient pool
  function addTransient({ object, duration, delay = 0, followCube = false, kind = 'decoration', update }) {
    object.userData.celebration = true
    fxGroup.add(object)
    transientEffects.push({
      object,
      kind,
      elapsed: -delay,
      duration,
      followCube,
      spawnQuat: followCube ? cubeGroup.quaternion.clone() : null,
      // §7.3: the tail is a WALL-CLOCK promise. The L5 dip scales the animation clock, and a
      // 1.4s tail stretched by 0.6x is exactly the bug the doc names.
      until: performance.now() + (duration + delay) * 1000,
      update,
    })
  }

  function spawnBand(line, index, tailSeconds) {
    const first = worldCell(line.cells[0])
    const last = worldCell(line.cells[line.cells.length - 1])
    const center = first.clone().add(last).multiplyScalar(0.5)
      .addScaledVector(faceNormalWorld(line.face), style.feedbackSurfaceOffset)
    const direction = last.clone().sub(first).normalize()
    if (!Number.isFinite(direction.x)) return
    const material = markMaterial(
      line.axis === 'row' ? celebrationColors.cream : celebrationColors.gold,
      CELEBRATION.band.opacity,
    )
    const band = new THREE.Mesh(bandGeometry, material)
    band.position.copy(center)
    // §7.2: the band is placed from cellToWorld + the cube's world matrix, never from a
    // face-local vector dropped straight into the scene.
    band.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction)
    const duration = Math.min(CELEBRATION.band.duration, tailSeconds)
    addTransient({
      object: band,
      duration,
      delay: index * CELEBRATION.timing.bandStagger,
      followCube: true,
      kind: 'band',
      update: (effect, delta) => {
        effect.elapsed += delta
        const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
        // §2.2: ONE pulse, no high-frequency flashing, no scale pop that reads as a shockwave.
        const pulse = progress < 0.22 ? progress / 0.22 : 1 - (progress - 0.22) / 0.78
        effect.object.material.opacity = Math.max(0, pulse) * CELEBRATION.band.opacity
        effect.object.scale.setScalar(progress < 0.22 ? 0.94 + progress * 0.28 : 1)
      },
    })
  }

  function spawnSparkle(position, delay, tailSeconds) {
    const material = markMaterial(celebrationColors.cream, 0)
    const sparkle = new THREE.Mesh(sparkleGeometry, material)
    sparkle.position.copy(position)
    const duration = Math.min(CELEBRATION.sparkle.duration, tailSeconds)
    addTransient({
      object: sparkle,
      duration,
      delay,
      update: (effect, delta) => {
        effect.elapsed += delta
        const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
        // 6–12 CSS px apparent, one flash and it is gone (§2.2). Billboarded so it reads from
        // every face; it never grows with the line count.
        effect.object.quaternion.copy(camera.quaternion)
        const pop = progress < 0.25 ? progress / 0.25 : 1 - (progress - 0.25) / 0.75
        effect.object.scale.setScalar(0.7 + Math.max(0, pop) * 0.45)
        effect.object.material.opacity = Math.max(0, pop) * 0.92
      },
    })
  }

  function spawnSeal(position, delay, tailSeconds, record = false) {
    const material = markMaterial(celebrationColors.gold, 0)
    const seal = new THREE.Mesh(record ? recordSealGeometry : sealGeometry, material)
    seal.position.copy(position)
    const duration = Math.min(CELEBRATION.seal.duration, tailSeconds)
    addTransient({
      object: seal,
      duration,
      delay,
      followCube: true,
      update: (effect, delta) => {
        effect.elapsed += delta
        const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
        effect.object.quaternion.copy(camera.quaternion)
        const stamp = progress < 0.18 ? 1.35 - (progress / 0.18) * 0.35 : 1
        effect.object.scale.setScalar(stamp)
        const fade = progress > 0.6 ? 1 - (progress - 0.6) / 0.4 : 1
        effect.object.material.opacity = Math.max(0, fade) * 0.95
      },
    })
  }

  function spawnRibbon(position, direction, delay, tailSeconds, color) {
    const material = markMaterial(color, 0)
    const ribbon = new THREE.Mesh(ribbonGeometry, material)
    ribbon.position.copy(position)
    const duration = Math.min(CELEBRATION.ribbon.duration, tailSeconds)
    const turn = direction.clone().normalize()
    addTransient({
      object: ribbon,
      duration,
      delay,
      update: (effect, delta) => {
        effect.elapsed += delta
        const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
        // §2.2: at most two light flips, a short travel, no long serpentine trail.
        effect.object.quaternion.copy(camera.quaternion)
          .multiply(new THREE.Quaternion().setFromEuler(
            new THREE.Euler(progress * Math.PI * 0.55, 0, Math.sin(progress * Math.PI) * 0.5),
          ))
        effect.object.position.copy(position)
          .addScaledVector(turn, progress * 0.34 * cellSize)
          .addScaledVector(camera.up, progress * 0.22 * cellSize)
        const fade = progress < 0.15 ? progress / 0.15 : progress > 0.55 ? 1 - (progress - 0.55) / 0.45 : 1
        effect.object.material.opacity = Math.max(0, fade) * 0.9
      },
    })
  }

  // ---------------------------------------------------------------- particle budgets
  function liveChipCount() {
    const now = performance.now()
    let total = 0
    for (const record of systemRecords) if (now < record.until) total += record.count
    return total
  }

  function spawnChips({ entries, count, tailSeconds, speed = 1.05, origin = null }) {
    if (count <= 0 || !entries.length) return 0
    const ceiling = quality.lowPower ? CELEBRATION.flyingCap.lowPower : CELEBRATION.flyingCap.standard
    const allowed = Math.min(count, Math.max(0, ceiling - liveChipCount()))
    if (allowed <= 0) return 0
    const world = entries.map(surfacePoint)
    const center = origin || centroidOfPoints(world)
    const points = world.map((point) => point.clone().sub(center))
    // Off the FACE, not along it: the normal leads so the paper leaves the surface, the
    // tangential term gives it the sideways scatter §4.1 asks for ("向两端散开"), and a small
    // downward bias is what makes it read as paper rather than as sparks.
    const directions = entries.map((entry, index) => {
      const normal = faceNormalWorld(entry.face)
      const lateral = points[index].clone().projectOnPlane(normal)
      const spread = new THREE.Vector3(0, -0.28, 0)
      if (lateral.lengthSq() > 1e-6) spread.addScaledVector(lateral.normalize(), 0.85)
      return normal.clone().multiplyScalar(0.75).add(spread).normalize()
    })
    const tones = CELEBRATION.paperTones
    const share = Math.max(1, Math.ceil(allowed / tones.length))
    const duration = Math.max(0.12, tailSeconds - CELEBRATION.timing.paperStart)
    let spawned = 0
    tones.forEach((tone, toneIndex) => {
      const remainder = allowed - spawned
      if (remainder <= 0) return
      const burst = Math.min(share, remainder)
      spawned += burst
      const color = new THREE.Vector3(...new THREE.Color(tone).toArray())
      const system = new ParticleSystem({
        autoDestroy: true,
        looping: false,
        duration,
        startLife: new ConstantValue(duration * 0.98),
        startSpeed: new ConstantValue(speed),
        startSize: new ConstantValue(1),
        startColor: new ConstantColor(colorToVector4(tone)),
        emissionOverTime: new ConstantValue(0),
        emissionBursts: [{ time: 0, count: new ConstantValue(burst), cycle: 1, interval: 0.01, probability: 1 }],
        shape: new CellEmitter(points, directions, speed),
        material: paperMaterial,
        instancingGeometry: chipGeometries[toneIndex % chipGeometries.length],        renderMode: RenderMode.Mesh,
        renderOrder: 3,
        worldSpace: true,
        behaviors: [
          // Alpha stops ascend in TIME (the renderer binary-searches them): fade in over the
          // first 6%, hold, then be gone before the tail ends.
          new ColorOverLife(new Gradient(
            [[color, 0], [color, 1]],
            [[0, 0], [1, 0.06], [1, 0.62], [0, 0.98]],
          )),
          new SizeOverLife(new PiecewiseBezier([[new Bezier(0.9, 1.04, 1, 0.86), 0]])),
          // Paper decelerates hard: it is thrown, then it hangs and drops.
          new SpeedOverLife(new PiecewiseBezier([[new Bezier(1, 0.95, 0.35, 0.06), 0]])),
          // NO `RotationOverLife`: with `RenderMode.Mesh` three.quarks fills a QUATERNION
          // rotation attribute, while that behavior writes a scalar angle — the instance matrix
          // comes out NaN and the whole batch silently draws nothing. The paper's flip is baked
          // into the chip GEOMETRY instead (see `chipGeometries`), which costs nothing per frame.
        ],
      })
      system.emitter.position.copy(center)
      scene.add(system.emitter)
      system.emitter.updateMatrixWorld(true)
      particleRenderer.addSystem(system)
      systemRecords.add({
        system,
        count: burst,
        until: performance.now() + (duration + CELEBRATION.timing.paperStart) * 1000 + 60,
      })
    })
    return spawned
  }

  // ---------------------------------------------------------------- the event
  /**
   * One settled placement = one event = one budget (§3). `level` is feedbackLevel()'s own
   * return value: this function never re-derives a level and never re-counts lines.
   */
  function spawnClearEffects(lines, level, { milestone = 0 } = {}) {
    const ranked = Math.min(Math.max(0, Math.trunc(level) || 0), 5)
    const reduced = prefersReducedMotion()
    // §4.2: no safe margin means less decoration, not a smaller board.
    const cramped = crampedViewport()
    const table = quality.lowPower ? CELEBRATION.budgets.lowPower : CELEBRATION.budgets.standard
    const tailSeconds = CELEBRATION.tailSeconds[ranked] || CELEBRATION.tailSeconds[1]
    const entries = uniqueEntries(lines)
    eventId += 1
    const id = eventId
    const surfaces = entries.length
      ? entries.map(surfacePoint)
      : [new THREE.Vector3().applyMatrix4(cubeGroup.matrixWorld)]
    const center = centroidOfPoints(surfaces)
    const now = performance.now()

    // Bands first: the player has to see WHERE it cleared before anything celebrates (§4.2).
    const seen = new Set()
    let bandIndex = 0
    for (const line of lines || []) {
      const key = segmentKey(line)
      if (seen.has(key)) continue
      seen.add(key)
      spawnBand(line, bandIndex, tailSeconds)
      bandIndex += 1
    }

    const decorationCap = quality.lowPower ? CELEBRATION.decorationCap.lowPower : CELEBRATION.decorationCap.standard
    let decorations = 0
    const budgetDecoration = (spawn) => {
      if (decorations >= decorationCap) return
      decorations += 1
      spawn()
    }

    if (reduced) {
      // §8: reduced motion keeps a STATIC small mark - the result is still announced, it just
      // does not move. One mark, no travel, no flip.
      budgetDecoration(() => spawnSeal(center.clone(), 0, 0.4))
    } else {
      budgetDecoration(() => spawnSparkle(center.clone(), 0.04, tailSeconds))
      if (ranked >= 3) budgetDecoration(() => spawnSeal(center.clone(), CELEBRATION.timing.bannerAt, tailSeconds))
      if (ranked >= 4 && !cramped) {
        // §3/§8: the two-sided fan is the ONE decoration that cools down (≥1.2s). Missing it
        // costs decoration only - the band, the score and the main sound all still happen.
        const sideReady = now - lastSideEmitAt >= CELEBRATION.sideCooldownMs
        if (sideReady) {
          lastSideEmitAt = now
          const left = center.clone().add(new THREE.Vector3(-0.9 * cellSize, 0.35 * cellSize, 0))
          const right = center.clone().add(new THREE.Vector3(0.9 * cellSize, 0.35 * cellSize, 0))
          const leftDir = new THREE.Vector3(-1, 0.3, 0)
          const rightDir = new THREE.Vector3(1, 0.3, 0)
          for (let i = 0; i < CELEBRATION.ribbon.max; i += 1) {
            budgetDecoration(() => spawnRibbon(left, leftDir, 0.02 + i * 0.03, tailSeconds, celebrationColors.sky))
            budgetDecoration(() => spawnRibbon(right, rightDir, 0.06 + i * 0.03, tailSeconds, celebrationColors.rose))
          }
        }
      }
    }

    const budget = reduced ? 0 : Math.round((table[ranked] ?? 0) * (cramped ? CELEBRATION.cramped.budgetFactor : 1))
    const spawned = spawnChips({ entries, count: budget, tailSeconds })
    lastEvent = {
      id,
      level: ranked,
      lines: (lines || []).length,
      uniqueCells: entries.length,
      budget,
      spawned,
      decorations,
      cramped,
      milestone,
      reducedMotion: reduced,
      startedAt: now,
      // §7.3 「效果注册到 eventId／runEpoch」: a restart, a scene change or a home press
      // cancels by epoch, so a tail can never survive into the next run.
      epoch: eventEpoch,
    }
    return { ...lastEvent }
  }

  // §4.3: the four tools are NOT four recolours of one burst. Each gets its own composition and
  // a duration of its own, and the caller passes the tool's `id` - the old signature's second
  // parameter was an unused axis hint, which is why "just change the sound" was never enough.
  function emitItemBurst(cells, id) {
    if (!cells || !cells.length) return null
    const reduced = prefersReducedMotion()
    const tool = id === 'hammer' || id === 'rocket' || id === 'bomb' || id === 'refresh' ? id : 'hammer'
    // Hammer/rocket/bomb touch the board; refresh repaints the TRAY and has no board burst at
    // all (§4.3) - the HUD owns that sweep, and a fake puff on the cube would be a lie about
    // what happened.
    if (tool === 'refresh') return { tool, chips: 0, decoration: 0 }
    const tailSeconds = tool === 'hammer' ? 0.24 : tool === 'rocket' ? 0.32 : 0.36
    // A tool's cells carry no face of their own, so the front face is the surface they came off —
    // the same one `findFrontFace()` hands the input layer — and the entries below start clear of
    // it exactly like a clear's do.
    const face = findFrontFace()
    const entries = cells.map((cell) => ({ cell, face }))
    const surfaces = entries.map(surfacePoint)
    const center = centroidOfPoints(surfaces)
    const normal = faceNormalWorld(face)
    const decorationCap = quality.lowPower ? CELEBRATION.decorationCap.lowPower : CELEBRATION.decorationCap.standard
    let decoration = 0
    if (!reduced && decorationCap > 0) {
      decoration += 1
      if (tool === 'rocket') {
        // Along the REAL row/column: the axis is derived from the cells' own spread.
        const spread = cells.reduce((acc, cell) => {
          acc.x = Math.max(acc.x, cell[0]) - Math.min(acc.x, cell[0])
          acc.y = Math.max(acc.y, cell[1]) - Math.min(acc.y, cell[1])
          acc.z = Math.max(acc.z, cell[2]) - Math.min(acc.z, cell[2])
          return acc
        }, { x: 0, y: 0, z: 0 })
        const axis = spread.x >= spread.y && spread.x >= spread.z
          ? new THREE.Vector3(1, 0, 0)
          : spread.y >= spread.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
        spawnSparkle(center.clone(), 0.03, tailSeconds)
        spawnRibbon(center.clone(), axis, 0, tailSeconds, celebrationColors.sky)
      } else if (tool === 'bomb') {
        // Four corner flowers over the real 2x2 scope, never a circular shockwave (§4.3).
        const box = cells.reduce((acc, cell) => ({
          minX: Math.min(acc.minX, cell[0]), maxX: Math.max(acc.maxX, cell[0]),
          minY: Math.min(acc.minY, cell[1]), maxY: Math.max(acc.maxY, cell[1]),
          minZ: Math.min(acc.minZ, cell[2]), maxZ: Math.max(acc.maxZ, cell[2]),
        }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity })
        const corners = [
          [box.minX, box.minY, box.minZ], [box.maxX, box.minY, box.maxZ],
          [box.minX, box.maxY, box.maxZ], [box.maxX, box.maxY, box.minZ],
        ]
        corners.forEach((corner, index) => {
          if (decoration + index >= decorationCap) return
          decoration += 1
          spawnSparkle(surfacePoint({ cell: corner, face }), index * 0.02, tailSeconds)
        })
      } else {
        spawnSparkle(center.clone(), 0, tailSeconds)
      }
    }
    const count = reduced ? 0 : tool === 'hammer' ? 4 : tool === 'rocket' ? 10 : 12
    const chips = spawnChips({
      entries,
      count,
      tailSeconds,
      speed: tool === 'rocket' ? 1.35 : tool === 'bomb' ? 1.1 : 0.95,
      origin: center,
    })
    return { tool, chips, decoration }
  }

  // ---------------------------------------------------------------- frame
  function pruneSystems() {
    const now = performance.now()
    for (const record of [...systemRecords]) {
      if (now < record.until) continue
      systemRecords.delete(record)
      // quarks' autoDestroy may already have taken this one out of the batch; disposing twice
      // is harmless but must never take the frame loop down with it (§7.3).
      try { record.system.dispose() } catch { /* already released */ }
    }
  }

  function updateTransientEffects(delta) {
    const now = performance.now()
    const cubeTurned = cubeGroup.quaternion
    transientEffects = transientEffects.filter((effect) => {
      // §7.2: a band that was glued to a face must not freeze into a world-space bar across
      // the cube the moment the player starts turning it - it fades in 80ms instead.
      if (effect.followCube && effect.spawnQuat && cubeTurned.angleTo(effect.spawnQuat) > 0.04) {
        effect.until = Math.min(effect.until, now + 80)
      }
      effect.update(effect, delta)
      if (now < effect.until && effect.elapsed < effect.duration) return true
      fxGroup.remove(effect.object)
      if (effect.object.material) effect.object.material.dispose()
      return false
    })
  }

  /** §7.2: a new drag preview or tool scope takes the range - decoration leaves first. */
  function retreatDecorations() {
    const now = performance.now()
    for (const effect of transientEffects) effect.until = Math.min(effect.until, now + 120)
    for (const record of systemRecords) record.until = Math.min(record.until, now + 120)
  }

  function update(delta) {
    particleRenderer.update(delta)
    updateTransientEffects(delta)
    pruneSystems()
    // Read live, never captured: the drag preview and the tool scope both belong to the input
    // layer and can appear between two frames.
    if (getInputBusy()) retreatDecorations()
  }

  function clearTransientEffects() {
    transientEffects.forEach((effect) => {
      fxGroup.remove(effect.object)
      if (effect.object.material) effect.object.material.dispose()
    })
    transientEffects = []
    systemRecords.forEach((record) => { try { record.system.dispose() } catch { /* already released */ } })
    systemRecords.clear()
  }

  function triggerShake(amount) { cameraShake = Math.max(cameraShake, amount) }

  // The camera's RESTING position is not this module's business: gameScene owns the orbit
  // distance, the zoom and the direction vector, and main restores that position before asking
  // for the shake. So what comes back from here is the OFFSET alone - same decay, same clock,
  // same three sine terms - and there is still exactly one place that computes where the camera
  // sits when nothing is shaking (plan section 5: neither side keeps its own cameraZoom).
  //
  // v0.10.1: the celebration's own shake target is 0 (CELEBRATION.shake). The offset machinery
  // stays because it is the only thing that knows how a decaying offset is composed, and the
  // report has to be able to say "it was zero" rather than "there is no such field".
  const shakeOffset = new THREE.Vector3()

  function updateShake(delta) {
    cameraShake = Math.max(0, cameraShake - delta * FEEDBACK_STYLE.shakeDecay)
    shakeOffset.set(0, 0, 0)
    if (cameraShake > 0) {
      const time = performance.now() * 0.045
      shakeOffset.x = Math.sin(time) * cameraShake
      shakeOffset.y = Math.cos(time * 1.17) * cameraShake * 0.7
      shakeOffset.z = Math.sin(time * 0.83) * cameraShake * 0.5
    }
    return shakeOffset
  }

  function resetShake() { cameraShake = 0 }
  function clearSlowMo() { slowMo = null }

  // v0.9.19: the call goes through platform/haptics.js, which owns the one fact this line
  // cannot know - on desktop `navigator.vibrate` EXISTS and returns true while nothing can
  // vibrate, so "the function is there" is not the test (that module's header has the
  // measurements). The switch is still read LIVE, here, at the moment of the event.
  function playHaptic(pattern = 15) {
    if (getHapticsOn()) vibrate(pattern)
  }

  // L5 ceremony (08 §6): the only time-dilation in the game, ≤400ms at 0.6x, and it only
  // scales the animation clock. Input never reads it, so a gesture during the dip is handled
  // exactly as usual - the rule is "不得阻断输入".
  let slowMo = null

  function triggerSlowMo(level) {
    // §8: reduced motion closes the dip. The producer's rule that it must never block input is
    // untouched either way.
    if (prefersReducedMotion()) return
    const config = FEEDBACK_STYLE.levels[level]?.slowMo
    if (config) slowMo = { scale: config.scale, until: performance.now() + config.ms }
  }

  // The frame loop's step. v0.10.1: main hands over the RAW delta, because the celebration is
  // scheduled on the wall clock (§7.3) and the dip therefore scales the cube's own animation
  // clock only.
  function timestep(rawDelta) {
    if (slowMo && performance.now() > slowMo.until) slowMo = null
    return slowMo ? rawDelta * slowMo.scale : rawDelta
  }

  // Read-only projection for the headless checks. `trackedSystems` is the DISPOSE list and is
  // kept for continuity; `liveSystems` and `liveChips` are the counts the §8 budget is
  // actually stated in, and they DO fall back to zero once an event's own duration is over -
  // which is the difference the old report could not express (it held finished systems until
  // the next restart and its `transients` list was the only thing that decayed).
  //
  // `bands` and `decorations` are counted apart on purpose: §8's cap (≤8, ≤4 on low power) is
  // stated for 「星章、闪点、彩带」 and §8 also says the side-emission cooldown 「不吞掉线带」 —
  // a line band is the RESULT being shown, not decoration, and conflating the two would make
  // the budget look blown on every three-line clear.
  function countKind(kind) {
    let total = 0
    for (const effect of transientEffects) if (effect.kind === kind) total += 1
    return total
  }

  function report() {
    // `liveParticles` is the system's OWN particle count: the budget says how many were ASKED
    // for, and this says how many exist. A budget that never becomes particles (a burst that does
    // not fire, a system disposed early) is invisible in every other read-out.
    let liveParticles = 0
    for (const record of systemRecords) {
      liveParticles += typeof record.system.particleNum === 'number' ? record.system.particleNum : 0
    }
    return {
      trackedSystems: systemRecords.size,
      liveSystems: systemRecords.size,
      liveChips: liveChipCount(),
      liveParticles,
      decorations: countKind('decoration'),
      bands: countKind('band'),
      transients: transientEffects.length,
      shake: Number(cameraShake.toFixed(4)),
      slowMo: slowMo !== null,
      reducedMotion: prefersReducedMotion(),
      lowPower: Boolean(quality.lowPower),
      event: lastEvent,
      eventId,
    }
  }

  return {
    // per-frame
    update,
    timestep,
    updateShake,
    report,
    // game events
    emitItemBurst,
    spawnClearEffects,
    retreatDecorations,
    triggerShake,
    triggerSlowMo,
    clearTransientEffects,
    resetShake,
    clearSlowMo,
    // haptics (sound lives in src/audio/gameAudio.js since v0.10.1)
    playHaptic,
  }
}

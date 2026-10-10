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
import { CARTOON_CLEAR, CELEBRATION, VFX_CONFIG, FEEDBACK_STYLE, BOARD_STYLE as style } from './config.js'
// The rules' OWN face lattice, used for one thing in this file: turning a CONTINUOUS face-local
// coordinate (the planner's origin, §4.3) into a lattice point. Re-deriving the six mappings here
// would be a second opinion about where a cell is, and the two would eventually disagree.
import { faceLattice } from '../game/board.js'
// v0.13.3: the normal clear's planner. Pure by construction -- see the module's own header for
// why the physical/face split cannot live in this file.
import {
  clearBudget,
  clearCaps,
  clearTailSeconds,
  emitterPositions,
  markPositions,
  planClear,
  planPropagation,
  vfxRandom,
  vfxSeed,
} from './cartoonClearPlan.js'
// v0.13.4 R1: the placement-driven layer. Everything it draws starts where the hand fell, so it
// needs the same pre-settle snapshot the planner got (PLACEMENT_IMPACT_FEEDBACK_HANDOFF §3–§5).
import { createImpactFeedback, budgetFor, severityOf } from './impactFeedback.js'
import { IMPACT_FEEDBACK } from './config.js'
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
  // v0.10.3 (SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §3.2): boardView's local centre of a face
  // plane. The FACE_CLEAR signature lights the face that was emptied, and the face's own centre
  // is the only anchor that is right for all six faces without a per-face table here.
  facePlaneLocalCenter = null,
  // The doc states the reward shake in CSS pixels and this layer works in world units. Rather
  // than baking a scale factor (the shipped framing makes one world unit ≈55px, so a guess
  // would be off by an order of magnitude), main injects gameScene's own projection conversion.
  getWorldPerPixel = () => 0.02,
  // §5.2 states the outline's width in CSS pixels and every other size in CELLS, so the one
  // number that converts between them -- one lattice cell's on-screen edge -- is injected by main
  // instead of being re-derived from the framing constants in here.
  getCellPx = () => 26,
  // The §3.1 sampling gate has to say WHERE each tile landed on screen, and only this module has
  // the camera the frame was drawn with. main injects gameScene's own canvas box so the gate does
  // not have to guess a second opinion about the viewport.
  getCanvasRect = null,
}) {
  // §6.2's dedicated FX layer. The clear's own sprites and contour are pulled out of the normal
  // prepass by the same layer gameScene draws them with. Declared here so every new
  // ParticleSystem is CONSTRUCTED with it: the batch key includes `layers.mask`, so a mask moved
  // afterwards would need the batch rebuilt rather than silently kept.
  const clearLayers = new THREE.Layers()
  clearLayers.set(CARTOON_CLEAR.fxLayer)

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

  // v0.13.4 R1: the placement-driven layer (§5). It draws the sweep, the endpoint bursts and the
  // 3D cube flight; this file keeps the skeleton it always had around them — the outline as the
  // understated confirmation, the chips as the secondary sprites, the scope, the clock and the
  // report. `surfaceOffset` is the SAME number the bands and the outline use, so the new art is
  // lifted off the real surface by the one convention the board already has (§8.2).
  const impact = createImpactFeedback({
    scene,
    cubeGroup,
    cellPitch,
    cellToWorld,
    cubeVector,
    quality,
    prefersReducedMotion,
    surfaceOffset: style.feedbackSurfaceOffset,
  })
  // The v1 sprite budget is the FALLBACK. When the pack is loaded, §5.2's `secondarySprites` row
  // is the chip count instead of §4.3's old all-in budget (which also paid for the marks, the
  // arcs and the dots that the sweep and the bursts have now replaced).
  const impactActive = () => impact.ready()
  function spriteBudget(severity, physical) {
    if (!impactActive()) {
      return {
        budget: clearBudget(physical, {
          lowPower: Boolean(quality.lowPower),
          reducedMotion: prefersReducedMotion(),
          cramped: crampedViewport(),
        }),
        secondaryOnly: false,
      }
    }
    // v0.13.4 R1: §5.2's `secondarySprites` replaces §4.3's all-in row for the CHIPS only — the
    // marks, the arcs and the dots it used to pay for are now the sweep and the bursts. The
    // 「手机横屏/安全边距不足：装饰预算减半」 rule is kept, because the chips are still decoration and
    // dropping it would quietly make a landscape phone busier than it was before.
    const base = budgetFor(impact.recipe(), severity, Boolean(quality.lowPower), 'secondarySprites')
    return { budget: crampedViewport() ? Math.round(base * 0.5) : base, secondaryOnly: true }
  }

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
  function addTransient({ object, duration, delay = 0, followCube = false, kind = 'decoration', pool = 'celebration', ownGeometry = false, update }) {
    object.userData.celebration = true
    fxGroup.add(object)
    const transient = {
      object,
      kind,
      pool,
      // §7.2 「轮廓合批」: the celebration's own geometries are a SHARED pool and must never be
      // disposed per event. The normal clear's contour is one merged BufferGeometry built for its
      // event alone, so it has to be released with it — measured: 100 cycles grew the renderer
      // from 27 geometries to 127 because nothing ever freed them.
      ownGeometry,
      elapsed: -delay,
      duration,
      followCube,
      spawnQuat: followCube ? cubeGroup.quaternion.clone() : null,
      // §7.3: the tail is a WALL-CLOCK promise. The L5 dip scales the animation clock, and a
      // 1.4s tail stretched by 0.6x is exactly the bug the doc names.
      until: performance.now() + (duration + delay) * 1000,
      update,
    }
    transientEffects.push(transient)
    return transient
  }

  /** The one place a finished transient gives its GPU objects back. */
  function releaseTransient(effect) {
    fxGroup.remove(effect.object)
    if (effect.object.material) effect.object.material.dispose()
    if (effect.ownGeometry && effect.object.geometry) effect.object.geometry.dispose()
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

  // ---- FACE_CLEAR marks (v0.10.3, handoff §3.2) --------------------------------
  // 「清空面的可见边框扫亮一次，面形小印章收束；背面只用文字/图标说明，不强转镜头」.
  // The sweep is a face-shaped plaque on the emptied face's own plane, ONE pulse, never a
  // flashing border and never a camera move: the pose is the player's, and a face that is
  // currently facing away simply does not show its sweep — which is what 「不强转镜头」 means.
  const faceSweepGeometry = buildRoundedRectGeometry(cubeSide * 0.86, cubeSide * 0.86, cubeSide * 0.12)
  const faceStampGeometry = buildRoundedRectGeometry(cellSize * 0.62, cellSize * 0.62, cellSize * 0.16)

  /** The world-space centre of a face plane, lifted off the surface like every other mark. */
  function faceCentre(face) {
    const local = facePlaneLocalCenter
      ? facePlaneLocalCenter(face).clone()
      : new THREE.Vector3(0, 0, 0)
    return local.applyMatrix4(cubeGroup.matrixWorld)
      .addScaledVector(faceNormalWorld(face), style.feedbackSurfaceOffset)
  }

  function spawnFaceSweep(face, delay, tailSeconds) {
    const material = markMaterial(celebrationColors.cream, 0)
    const sweep = new THREE.Mesh(faceSweepGeometry, material)
    const normal = faceNormalWorld(face)
    sweep.position.copy(faceCentre(face))
    // Laid ON the face plane, not billboarded: this is the face lighting up, so it has to keep
    // the face's own orientation as the cube turns under it.
    sweep.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
    const duration = Math.min(CELEBRATION.band.duration, tailSeconds)
    addTransient({
      object: sweep,
      duration,
      delay,
      followCube: true,
      kind: 'decoration',
      update: (effect, delta) => {
        effect.elapsed += delta
        const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
        // ONE pulse, and it starts at full size: a growing plaque would read as a shockwave,
        // which §2.2 rules out for the same reason it rules out a scale pop on the band.
        const pulse = progress < 0.18 ? progress / 0.18 : 1 - (progress - 0.18) / 0.82
        effect.object.material.opacity = Math.max(0, pulse) * CELEBRATION.band.opacity * 0.5
      },
    })
  }

  /** The small square stamp that closes the face clear — 面形, so it is a plaque, not the seal. */
  function spawnFaceStamp(face, delay, tailSeconds) {
    const material = markMaterial(celebrationColors.gold, 0)
    const stamp = new THREE.Mesh(faceStampGeometry, material)
    stamp.position.copy(faceCentre(face))
    const duration = Math.min(CELEBRATION.seal.duration, tailSeconds)
    addTransient({
      object: stamp,
      duration,
      delay,
      followCube: true,
      kind: 'decoration',
      update: (effect, delta) => {
        effect.elapsed += delta
        const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
        effect.object.quaternion.copy(camera.quaternion)
        // 收束: it comes in slightly oversize and settles — the same stamp the honour seal uses,
        // one size smaller and on the emptied face.
        effect.object.scale.setScalar(progress < 0.18 ? 1.3 - (progress / 0.18) * 0.3 : 1)
        const fade = progress > 0.6 ? 1 - (progress - 0.6) / 0.4 : 1
        effect.object.material.opacity = Math.max(0, fade) * 0.95
      },
    })
  }

  // ---------------------------------------------------------------- particle budgets
  // `pool` separates the two families the report has to keep apart (§4.3 「两个系统并行时的总live
  // 计数必须在report显式分项」): the celebration's own chips and the normal clear's cartoon
  // sprites. Each has its own ceiling and neither may borrow from the other's.
  function liveChipCount(pool = 'celebration') {
    const now = performance.now()
    let total = 0
    for (const record of systemRecords) {
      if (record.pool !== pool) continue
      if (now < record.until) total += record.count
    }
    return total
  }

  function spawnChips({ entries, count, tailSeconds, speed = 1.05, origin = null }) {
    if (count <= 0 || !entries.length) return 0
    const ceiling = quality.lowPower ? CELEBRATION.flyingCap.lowPower : CELEBRATION.flyingCap.standard
    const allowed = Math.min(count, Math.max(0, ceiling - liveChipCount('celebration')))
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
        // v0.13.3: `count` is a PLAIN NUMBER. `BurstParameters.count` is typed `number` in the
        // package's own declaration, and `ParticleSystem.spawn()` iterates it directly
        // (`for (i = 0; i < count; i++)`) — a `ConstantValue` compares as NaN and the burst emits
        // NOTHING while every counter in this module still reports the full budget. Measured on
        // HEAD bf03464f: `liveChips` reported 6 while `system.particleNum` stayed 0 and the board
        // area never changed a pixel (artifacts/cartoon-clear-v1/r0/evidence.json). The handoff
        // §6.1 note about passing a `ValueGenerator` here is wrong for 0.10.8; this is the fix.
        emissionBursts: [{ time: 0, count: Math.max(0, Math.round(burst)), cycle: 1, interval: 0.01, probability: 1 }],
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
        pool: 'celebration',
        id: toneIndex,
        emitAt: performance.now(),
        until: performance.now() + (duration + CELEBRATION.timing.paperStart) * 1000 + 60,
      })
    })
    return spawned
  }

  // ================================================================================
  // Cartoon clear (v0.13.3, CARTOON_CLEAR_VFX_HANDOFF §4–§7)
  // ================================================================================
  // The NORMAL clear's whole presentation, in a pool of its own. The item bursts, the record
  // card and every legacy path above keep using CELEBRATION and none of the numbers below touch
  // them (§0 「本交接接管正常消除的局部图形、时序、粒子与清理」).
  //
  // What this replaces, measured on HEAD bf03464f (artifacts/cartoon-clear-v1/r0/evidence.json):
  //   * the budget was chosen from board.js's RAW face-line count, so a shared edge/corner paid
  //     twice for one space segment (a crossing clear arrived as 3 lines, a five-line clear as 7);
  //   * a single line stayed on screen for 466ms against §5's 360ms window;
  //   * the burst fired at the system's own t=0 regardless of the doc's `paperStart`.
  // All three are fixed by construction here: the planner supplies `physicalLineCount`, the tail
  // is the table's own number, and the emission time is a REAL wall-clock delay (`paused` until
  // the beat) rather than a nominal constant.
  const cartoon = {
    status: 'idle', // idle | loading | ready | failed
    texture: null,
    error: null,
    frames: null,
    seq: 0,
    scopeEpoch: 0,
    events: [],
    lastPlan: null,
    lastPropagation: null,
    lastEvent: null,
    spawnedTotal: 0,
    droppedByCap: 0,
    droppedByEvents: 0,
  }

  function atlasUrl(relative) {
    const base = import.meta.env?.BASE_URL || '/'
    return `${base.endsWith('/') ? base : `${base}/`}${relative}`
  }

  // §3.1's sampling contract, and the reason the tile numbering starts at the PNG's TOP row: the
  // quarks UV chunk computes `row = vTileCount - 1 - floor(uvTile / uTileCount)`, and
  // `flipY = true` is what makes tile 0 land on the top-left tile the pack numbered first.
  function loadCartoonAtlas() {
    if (cartoon.status !== 'idle') return
    cartoon.status = 'loading'
    new THREE.TextureLoader().load(
      atlasUrl(CARTOON_CLEAR.atlas.image),
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        texture.flipY = true
        texture.generateMipmaps = false
        texture.minFilter = THREE.LinearFilter
        texture.magFilter = THREE.LinearFilter
        texture.wrapS = THREE.ClampToEdgeWrapping
        texture.wrapT = THREE.ClampToEdgeWrapping
        texture.premultiplyAlpha = false
        texture.needsUpdate = true
        cartoon.texture = texture
        atlasMaterial.map = texture
        atlasMaterial.needsUpdate = true
        cartoon.status = 'ready'
      },
      undefined,
      (error) => {
        // §3.1: a failed atlas is NOT allowed to block the first move — the procedural quads
        // keep drawing and the failure is recorded for the probe instead of thrown.
        cartoon.status = 'failed'
        cartoon.error = String(error?.message || error || 'atlas load failed')
      },
    )
    fetch(atlasUrl(CARTOON_CLEAR.atlas.json))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data?.frames) cartoon.frames = data.frames })
      .catch(() => { /* the tile order plus the fallback coverage is enough to draw */ })
  }

  /**
   * §5.2 「用 JSON alphaBounds 换算可见尺寸：某粒子图形只占tile宽70%，quad宽要除以0.7」. The
   * coverage is how much of the 128px tile the graphic really occupies; a quad is divided by it so
   * the VISIBLE graphic, not the transparent margin, is the size the doc states.
   */
  function tileCoverage(id) {
    const frame = cartoon.frames?.[id]
    const fallback = { x: 0.7, y: 0.7 }
    if (!frame?.alphaBounds) return fallback
    const [left, top, right, bottom] = frame.alphaBounds
    return {
      x: Math.max(0.2, (right - left) / CARTOON_CLEAR.atlas.tile),
      y: Math.max(0.2, (bottom - top) / CARTOON_CLEAR.atlas.tile),
    }
  }

  const tileIndex = (id) => {
    const index = CARTOON_CLEAR.atlas.order.indexOf(id)
    return index < 0 ? 0 : index
  }

  // Two shared materials, one per sampling route. Both are `MeshBasicMaterial` so the two may
  // never end up in different batches by `type`; the atlas one is white because every sprite's
  // colour is baked into its own tile (§5.2 「不能每条线换一套随机色」).
  const atlasMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const fallbackMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })

  /** §5.2's gravity: a short arc that comes back down, not a fountain. */
  class GravityBehavior {
    constructor(gravity) {
      this.type = 'cartoonGravity'
      this.gravity = gravity
    }

    initialize() {}

    update(particle, delta) {
      // 向上是场景的 +Y；加速度向 −Y。速度由 quarks 自己积分（position += velocity·delta），
      // 这里只改速度，绝不会既写位置又让引擎重复积分速度。
      particle.velocity.y -= this.gravity * delta
    }

    frameUpdate() {}

    reset() {}

    toJSON() { return { type: this.type, gravity: this.gravity } }

    clone() { return new GravityBehavior(this.gravity) }
  }

  /**
   * One particle = one planned position, velocity, screen rotation and size. Written out rather
   * than reusing `CellEmitter` because the sprites need all four per particle and the emitter
   * has to be able to override `startSize` (which `SizeOverLife` multiplies, so a per-particle
   * size really does reach the GPU).
   */
  class CartoonSpriteEmitter {
    constructor({ points, velocities, rotations, sizes }) {
      this.type = 'cartoon'
      this.points = points
      this.velocities = velocities
      this.rotations = rotations
      this.sizes = sizes
      this.sequence = 0
    }

    initialize(particle) {
      const index = this.sequence++
      const point = this.points[index % this.points.length]
      const velocity = this.velocities[index % this.velocities.length]
      if (point) particle.position.copy(point)
      if (velocity) particle.velocity.copy(velocity)
      if (this.rotations) particle.rotation = this.rotations[index % this.rotations.length] || 0
      if (this.sizes) particle.startSize = this.sizes[index % this.sizes.length]
      if (!Number.isFinite(particle.velocity.x)) particle.velocity.set(0, 0, 0)
    }

    toJSON() { return { type: this.type } }

    clone() {
      return new CartoonSpriteEmitter({
        points: this.points, velocities: this.velocities, rotations: this.rotations, sizes: this.sizes,
      })
    }
  }

  /** A lattice-space unit vector, in the cube's own current world frame. */
  function latticeDirWorld(cell, dir) {
    const from = cellToWorld(cell[0], cell[1], cell[2])
    const to = cellToWorld(cell[0] + dir[0], cell[1] + dir[1], cell[2] + dir[2])
    const world = to.sub(from).normalize().applyQuaternion(cubeGroup.quaternion)
    return Number.isFinite(world.x) ? world : new THREE.Vector3(0, 0, 0)
  }

  /**
   * §5.2 「短弯尖朝 +X」: a swoosh/dash tile is authored pointing along its own +X, so it is
   * rotated by the screen angle of the direction it is travelling in. Billboard rotation is a
   * scalar in the view plane, which is why this is a projection and not a quaternion.
   */
  const screenProbeA = new THREE.Vector3()
  const screenProbeB = new THREE.Vector3()
  function screenAngleDeg(position, direction) {
    screenProbeA.copy(position).project(camera)
    screenProbeB.copy(position).addScaledVector(direction, Math.max(0.05, cellSize)).project(camera)
    // NDC y is up-positive and the billboard's own +Y is view-up, so the angle needs no flip.
    return Math.atan2(screenProbeB.y - screenProbeA.y, screenProbeB.x - screenProbeA.x)
  }

  /** Cells -> world units, divided by how much of the tile the graphic really covers (§5.2). */
  function visibleSize(cells, coverage) {
    return finite(cells * cellSize, `visibleSize(${cells})`, 'size') / Math.max(0.2, coverage)
  }

  /** The face a plan's first line reports, used only when a plan has no emitter ends at all. */
  const frontFaceOf = (plan) => plan.physicalLines[0]?.face || '+z'

  function liveCartoonSprites() {
    const now = performance.now()
    let total = 0
    for (const record of systemRecords) {
      if (record.pool !== 'cartoon') continue
      if (now < record.emitAt) continue // not emitted yet, so it is not on screen
      if (now > record.until) continue
      total += record.count
    }
    return total
  }

  function liveCartoonEvents() {
    const now = performance.now()
    return cartoon.events.filter((event) => event.until > now)
  }

  /** §7.1: a third overlapping clear retires the OLDEST tail; the current line keeps its marks. */
  function enforceCartoonEventCap(now) {
    const live = liveCartoonEvents()
    while (live.length >= CARTOON_CLEAR.maxEvents) {
      const oldest = live.shift()
      if (!oldest) break
      cartoon.droppedByEvents += 1
      oldest.until = now
      for (const record of oldest.records) {
        record.until = Math.min(record.until, now)
        record.pruneAt = Math.min(record.pruneAt ?? record.until, now)
      }
      for (const transient of oldest.transients) transient.until = Math.min(transient.until, now)
      // Retiring a tail is presentation only: the score, the sound and the hand were already
      // settled by main.onDrop(). Nothing here touches them (§7.1 「不丢结算/声音」).
    }
  }

  /**
   * The one place a normal clear is presented. Returns the event record the report exposes.
   *
   * `frontFace` and `visibleFaces` come from main (boardView's `findFrontFace()` and the camera's
   * own visibility order) because the planner is pure and must not guess which side of the cube
   * the player is looking at.
   */
  function spawnCartoonClear(lines, level, {
    reward = null,
    frontFace = null,
    visibleFaces = [],
    placement = null,
  } = {}) {
    const reduced = prefersReducedMotion()
    const cramped = crampedViewport()
    const plan = planClear(lines, {
      frontFace,
      visibleFaces,
      maxOutlineCells: CARTOON_CLEAR.outline.maxCells,
    })
    // §4: WHERE each physical line was entered. `placement` is main's pre-settle snapshot (§3.1);
    // a caller that has none (the DEV demo, a legacy fixture) still gets a finite, honest plan —
    // every line reports `originFallback` and the report says so instead of inventing an origin.
    const propagation = planPropagation(plan, placement)
    cartoon.seq += 1
    const eventKey = `${cartoon.scopeEpoch}:${cartoon.seq}`
    const physical = plan.physicalLineCount
    const severity = severityOf(physical)
    const sprites = spriteBudget(severity, physical)
    const budget = reduced ? 0 : sprites.budget
    const secondaryOnly = sprites.secondaryOnly
    const caps = clearCaps(Math.max(1, physical))
    const tail = clearTailSeconds(physical)
    const now = performance.now()
    const record = {
      id: cartoon.seq,
      key: eventKey,
      epoch: cartoon.scopeEpoch,
      startedAt: now,
      until: now + (tail + 0.05) * 1000,
      physicalLineCount: physical,
      rawLineCount: plan.rawLineCount,
      duplicateReports: plan.duplicatedReports,
      uniqueCells: plan.uniqueCellCount,
      intersections: plan.intersections.length,
      budget,
      spawned: 0,
      marks: 0,
      arcs: 0,
      outlineCells: plan.outlineCellCount,
      outlineDropped: false,
      // v0.13.4 R0 §4: the placement's own numbers, recorded so a probe can assert the doc's
      // arrivals without re-deriving them and so `hits === 0` on a legal drop is a REPORTED
      // failure (§4.1) rather than a silently centred sweep.
      placedCells: propagation.placedCellCount,
      originFallbackLines: propagation.fallbackLines,
      earliestEndMs: propagation.earliestEndMs,
      faceRays: propagation.faceRays.length,
      endpoints: propagation.endpoints.length,
      cramped,
      reducedMotion: reduced,
      // The headline category this event was presented as, or null for a plain clear. Kept under
      // the name the celebration probe and the reward demo already read (§4.1 of the v0.10.3
      // handoff); the "note was owed" vs "note was painted" distinction is that probe's.
      primaryType: reward?.primaryType || null,
      rewardType: reward?.primaryType || null,
      // The faces the rules layer reported as emptied, and the streak count when one was paid.
      // §4.1 is explicit that neither may choose the BUDGET (a shared edge reports two faces, so
      // `wipedFaces` would light a face that was never emptied) -- they are recorded here because
      // the existing probe reads them to tell "the note was owed" from "the note was painted".
      wipedFaces: Array.isArray(reward?.wipedFaces) ? [...reward.wipedFaces] : [],
      streak: (reward?.rewards || []).find((entry) => entry.type === 'CLEAR_STREAK')?.count || 0,
      records: [],
      transients: [],
      scope: true,
    }
    cartoon.lastPlan = plan
    cartoon.lastPropagation = propagation
    enforceCartoonEventCap(now)

    if (physical <= 0) {
      cartoon.lastEvent = { ...record, records: undefined, transients: undefined }
      cartoon.events.push(record)
      return cartoon.lastEvent
    }

    // ---- 1. the line outlines: the confirmation the player reads FIRST (§5, 0–65ms) ---------
    // Never traded away for decoration, never split by the sprite budget, and per §7.1 they leave
    // within 80ms once the cube starts turning or a new drag appears.
    // §6.2 「轮廓必须贴实际面 … 距真实表面外偏」. The offset is taken from BOARD_STYLE's own
    // `feedbackSurfaceOffset` rather than from the doc's 0.005–0.012 lattice figure: the shell's
    // tiles are rounded blocks that stand proud of the face plane, so a 0.012 offset puts the
    // ribbon INSIDE them and the contour never appears at all (measured — the first version drew
    // it there and the 65ms capture was empty while every counter said the outline existed).
    const widthWorld = Math.max(0.006, (CARTOON_CLEAR.outline.widthPx[1] / Math.max(1, getCellPx())) * cellSize)
    const offsetWorld = style.feedbackSurfaceOffset
    const outlineGeometry = buildCartoonOutlineGeometry(plan, widthWorld, offsetWorld)
    if (outlineGeometry) {
      const material = markMaterial(CARTOON_CLEAR.colors.outline, 0)
      const outline = new THREE.Mesh(outlineGeometry, material)
      // §6.2: a parent Group carrying the layer does NOT recurse to its children, so the contour
      // sets it object by object.
      outline.layers.set(CARTOON_CLEAR.fxLayer)
      const duration = Math.min(CARTOON_CLEAR.outline.duration, tail)
      const transient = addTransient({
        object: outline,
        duration,
        delay: CARTOON_CLEAR.timing.outlineIn,
        followCube: true,
        kind: 'outline',
        pool: 'cartoon',
        ownGeometry: true,
        update: (effect, delta) => {
          effect.elapsed += delta
          const progress = THREE.MathUtils.clamp(effect.elapsed / Math.max(effect.duration, 1e-4), 0, 1)
          // ONE rise and one settle: a linear in/out envelope, never a flash.
          const envelope = progress < 0.25 ? progress / 0.25 : 1 - (progress - 0.25) / 0.75
          effect.object.material.opacity = Math.max(0, envelope) * CARTOON_CLEAR.outline.opacity
        },
      })
      record.transients.push(transient)
    } else {
      record.outlineDropped = true
    }

    if (tail > 0) {
      const spawned = spawnCartoonSprites({ plan, budget, caps, tail, record, reduced, secondaryOnly })
      record.spawned = spawned.spawned
      record.marks = spawned.marks
      record.arcs = spawned.arcs
    }

    // ---- 2. the placement-driven layer (§5) -------------------------------------------------
    // Started AFTER the board has already settled: §3.1 「仍然原顺序结算、更新棋盘、声音/短签、保存；
    // 不等刷光才删除格或更新分数」. It draws nothing at all when the pack is not loaded, and the v1
    // confirmation above has already been drawn either way — a failed load must never cost the
    // player their line, and must never leave a Loading screen behind.
    const impactEvent = impactActive() && !reduced
      ? impact.spawn({ eventKey, plan, propagation })
      : null
    record.impact = impactEvent
      ? { sweeps: impactEvent.sweeps, bursts: impactEvent.bursts, cubes: impactEvent.cubes, severity: impactEvent.severity }
      : null
    if (impactActive() && !reduced) spawnPlacementPulse(propagation, tail, record)

    cartoon.events.push(record)
    // The event log is the probe's own read-out; it is bounded so a long session cannot grow it.
    if (cartoon.events.length > 8) cartoon.events = cartoon.events.slice(-8)
    cartoon.spawnedTotal += record.spawned
    const { records, transients, ...summary } = record
    cartoon.lastEvent = {
      ...summary,
      // Kept in the record for the report but never serialised into the return value's identity.
      systems: records.length,
      liveEvents: liveCartoonEvents().length,
    }
    return cartoon.lastEvent
  }

  /**
   * The sprites themselves. §4.3's `budget` is the WHOLE event's new decoration count, the caps
   * slice it into kinds, and the global pool ceiling can trim it further — trimming decoration is
   * always preferred to dropping a line outline, which is drawn above and is not part of `budget`.
   */
  function spawnCartoonSprites({ plan, budget, caps, tail, record, reduced, secondaryOnly = false }) {
    const now = performance.now()
    const ends = emitterPositions(plan, { max: CARTOON_CLEAR.emitterCap })
    const fallbackPoint = plan.uniqueCells.length
      ? worldCell(plan.uniqueCells[0])
      : new THREE.Vector3().applyMatrix4(cubeGroup.matrixWorld)
    const anchors = ends.length
      ? ends
      : [{ cell: plan.uniqueCells[0] || [0, 0, 0], face: frontFaceOf(plan), outward: [1, 0, 0] }]
    const center = centroidOfPoints(anchors.map((end) => worldCell(end.cell)))
    const random = vfxRandom(vfxSeed(record.key, plan))
    const liveRoom = Math.max(0, (quality.lowPower ? CARTOON_CLEAR.live.lowPower : CARTOON_CLEAR.live.standard) - liveCartoonSprites())

    // §8 reduced motion is its own axis: no flight and no arc, but the result is still announced
    // with ONE static flash, and the board outline above still appears.
    if (reduced) {
      const position = worldCell(plan.uniqueCells[0] ?? [0, 0, 0])
      const systems = addCartoonSystems([{
        id: 'sparkle-cream',
        count: 1,
        delay: 0,
        life: 0.12,
        speed: 1,
        points: [position.clone().sub(center).addScaledVector(faceNormalWorld(frontFaceOf(plan)), style.feedbackSurfaceOffset)],
        velocities: [new THREE.Vector3(0, 0, 0)],
        sizes: [visibleSize(0.18, tileCoverage('sparkle-cream').x)],
        rotations: [0],
        gravity: 0,
      }], record, center)
      return { spawned: systems.count, marks: 1, arcs: 0 }
    }

    // The kinds, in §4.3's own order of importance: marks and arcs are reserved first, the
    // confetti fills what is left, and nothing may exceed the event's budget.
    const marks = secondaryOnly || reduced ? 0 : markPositions(plan, caps.marks).length
    const arcs = secondaryOnly ? 0 : caps.arcs
    const dots = secondaryOnly || quality.lowPower ? 0 : Math.min(2, Math.floor(budget / 8))
    const confetti = Math.max(0, budget - marks - arcs - dots)
    const pink = Math.round(confetti * CARTOON_CLEAR.confetti.pinkShare)
    const blue = Math.ceil((confetti - pink) / 2)
    const teal = confetti - pink - blue

    const specs = []
    const emitConfetti = (id, count, sizeCells) => {
      if (count <= 0) return
      const coverage = tileCoverage(id)
      const points = []
      const velocities = []
      const rotations = []
      const sizes = []
      for (let index = 0; index < count; index += 1) {
        const anchor = anchors[(index + specs.length) % anchors.length]
        const normal = faceNormalWorld(anchor.face)
        const along = latticeDirWorld(anchor.cell, anchor.outward)
        const tangent = new THREE.Vector3().crossVectors(normal, along)
        if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0)
        tangent.normalize()
        const phase = random() * Math.PI * 2
        const alongSpeed = lerp(CARTOON_CLEAR.confetti.alongSpeed, random()) * cellSize
        const tangentSpeed = lerp(CARTOON_CLEAR.confetti.tangentSpeed, random()) * cellSize * Math.cos(phase)
        const normalSpeed = lerp(CARTOON_CLEAR.confetti.normalSpeed, random()) * cellSize
        const velocity = along.clone().multiplyScalar(alongSpeed)
          .addScaledVector(tangent, tangentSpeed)
          .addScaledVector(normal, normalSpeed)
          .addScaledVector(SCENE_UP, CARTOON_CLEAR.confetti.upBias * alongSpeed)
        points.push(worldCell(anchor.cell).sub(center).addScaledVector(normal, style.feedbackSurfaceOffset))
        velocities.push(velocity)
        // §5.2 「旋转≤80°，不翻成细线」: an in-plane spin of the billboard, never a tumble that
        // turns the chip edge-on.
        rotations.push((random() * 2 - 1) * (CARTOON_CLEAR.confetti.spinMaxDeg * Math.PI / 180))
        sizes.push(visibleSize(sizeCells, random() > 0.5 ? coverage.x : coverage.y))
      }
      specs.push({
        id,
        count,
        delay: CARTOON_CLEAR.timing.emitFrom,
        life: Math.max(0.08, tail - CARTOON_CLEAR.timing.emitFrom),
        speed: 1,
        points,
        velocities,
        rotations,
        sizes,
        gravity: lerp(CARTOON_CLEAR.confetti.gravity, random()) * cellSize,
      })
    }
    emitConfetti('confetti-blue', blue, 0.16)
    emitConfetti('confetti-teal', teal, 0.19)
    emitConfetti('confetti-pink', pink, 0.13)

    // The stars: §5's 65–140ms beat, one 0.8→1.1→0 envelope, at the intersections and the ends.
    if (marks > 0 && liveRoom > 0) {
      const positions = []
      const velocities = []
      const sizes = []
      const coverage = tileCoverage('star-pop')
      for (const mark of markPositions(plan, caps.marks)) {
        const normal = faceNormalWorld(mark.face || '+z')
        positions.push(worldCell(mark.cell).sub(center).addScaledVector(normal, style.feedbackSurfaceOffset))
        velocities.push(new THREE.Vector3(0, 0, 0))
        sizes.push(visibleSize(Math.min(CARTOON_CLEAR.star.maxSize, Math.max(CARTOON_CLEAR.star.minSize, cellPitch * 0.24)), coverage.x))
      }
      specs.push({
        id: 'star-pop',
        count: positions.length,
        delay: CARTOON_CLEAR.timing.arcFrom,
        life: CARTOON_CLEAR.timing.arcTo - CARTOON_CLEAR.timing.arcFrom,
        speed: 1,
        points: positions,
        velocities,
        rotations: positions.map(() => 0),
        sizes,
        gravity: 0,
      })
    }

    // The arcs: §5.2 「沿线轴向外，不超过端点0.45格」 — a short directional streak, not a trail.
    if (arcs > 0 && liveRoom > 0) {
      const positions = []
      const velocities = []
      const rotations = []
      const sizes = []
      for (let index = 0; index < arcs; index += 1) {
        const anchor = anchors[index % anchors.length]
        const normal = faceNormalWorld(anchor.face)
        const along = latticeDirWorld(anchor.cell, anchor.outward)
        const start = worldCell(anchor.cell).sub(center).addScaledVector(normal, style.feedbackSurfaceOffset * 1.2)
        const tan = new THREE.Vector3().crossVectors(normal, along).normalize()
        positions.push(start)
        velocities.push(along.clone().multiplyScalar(lerp(ARC_LENGTH_RANGE, random()) * cellSize / Math.max(1e-3, CARTOON_CLEAR.timing.arcTo - CARTOON_CLEAR.timing.arcFrom))
          .addScaledVector(tan, 0.2 * cellSize))
        rotations.push(screenAngleDeg(start.clone().add(center), along))
        sizes.push(visibleSize(lerp(ARC_LENGTH_RANGE, random()), tileCoverage('swoosh-cream').x))
      }
      specs.push({
        id: 'swoosh-cream',
        count: positions.length,
        delay: CARTOON_CLEAR.timing.arcFrom,
        life: Math.max(0.05, CARTOON_CLEAR.timing.arcTo - CARTOON_CLEAR.timing.arcFrom),
        speed: 1,
        points: positions,
        velocities,
        rotations,
        sizes,
        gravity: 0,
      })
    }

    // The dots: §5.2 「小于2px就不发，低配优先剔除」.
    if (dots > 0 && liveRoom > 0) {
      const coverage = tileCoverage('dot-blue')
      const points = []
      const velocities = []
      const sizes = []
      for (let index = 0; index < dots; index += 1) {
        const anchor = anchors[index % anchors.length]
        const normal = faceNormalWorld(anchor.face)
        const along = latticeDirWorld(anchor.cell, anchor.outward)
        points.push(worldCell(anchor.cell).sub(center).addScaledVector(normal, style.feedbackSurfaceOffset))
        velocities.push(along.clone().multiplyScalar(lerp(CARTOON_CLEAR.confetti.alongSpeed, random()) * 0.6 * cellSize))
        sizes.push(visibleSize(lerp(DOT_SIZE_RANGE, random()), coverage.x))
      }
      specs.push({
        id: 'dot-blue',
        count: points.length,
        delay: CARTOON_CLEAR.timing.emitFrom,
        life: Math.max(0.08, tail - CARTOON_CLEAR.timing.emitFrom),
        speed: 1,
        points,
        velocities,
        rotations: points.map(() => 0),
        sizes,
        gravity: lerp(CARTOON_CLEAR.confetti.gravity, random()) * cellSize,
      })
    }

    // §4.2 「所有发射在140ms前完成」: the deadline is an assertion, not a comment.
    let trimmed = 0
    const allowed = specs.map((spec) => {
      if (spec.delay >= CARTOON_CLEAR.timing.emissionDeadline) {
        trimmed += spec.count
        return { ...spec, count: 0 }
      }
      return spec
    })
    const total = allowed.reduce((sum, spec) => sum + spec.count, 0)
    if (total > liveRoom) {
      // Trim the LEAST load-bearing kinds first (dots, then confetti), never the marks.
      const room = Math.max(0, liveRoom)
      let left = room
      for (const spec of allowed) {
        const keep = Math.min(spec.count, Math.max(0, left - 0))
        trimmed += spec.count - keep
        spec.count = keep
        left -= keep
      }
      cartoon.droppedByCap += trimmed
    }
    const spawned = addCartoonSystems(allowed, record, center)
    return { spawned: spawned.count, marks: spawned.byId['star-pop'] || 0, arcs: spawned.byId['swoosh-cream'] || 0 }
  }

  /**
   * §5.1 「落点脉冲：一个短奶油色确认，强调'这一手'；单次局部提示，不按新格数量倍增」.
   *
   * The pack ships no pulse sprite and §5.1 keeps the existing atlas for exactly this kind of
   * supporting mark, so the pulse is the v1 `sparkle-cream` tile at its own small size — one
   * instance at the placement's centroid, never one per placed cell. The anchor is the snapshot's
   * own centre (§3.1), so the flash is where the hand fell rather than where the pointer lifted.
   */
  function spawnPlacementPulse(propagation, tail, record) {
    const pulse = propagation?.pulse
    if (!pulse || !pulse.uv) return false
    const [u, v] = pulse.uv
    const cell = faceLattice(pulse.face, u, v)
    const position = worldCell(cell).addScaledVector(faceNormalWorld(pulse.face), style.feedbackSurfaceOffset)
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      nanGuards.pivot += 1
      return false
    }
    const coverage = tileCoverage('sparkle-cream')
    const center = position.clone()
    const systems = addCartoonSystems([{
      id: 'sparkle-cream',
      count: 1,
      delay: 0,
      life: Math.max(0.1, Math.min(0.22, tail)),
      speed: 1,
      points: [position.clone().sub(center)],
      velocities: [new THREE.Vector3(0, 0, 0)],
      sizes: [visibleSize(IMPACT_FEEDBACK.pulseCells, coverage.x)],
      rotations: [0],
      gravity: 0,
    }], record, center)
    record.pulse = systems.count === 1
    return record.pulse
  }

  const SCENE_UP = new THREE.Vector3(0, 1, 0)
  // v0.13.4 R0 (PLACEMENT_IMPACT_FEEDBACK_HANDOFF.md §2): `lerp` was called with three SCALARS
  // (`arc.minLength`, `arc.maxLength`, `dot.maxSize`) while its own contract is a `[min,max]`
  // pair, so those three call sites produced `undefined + NaN` and fed a NaN size/velocity
  // straight into the particle emitter — the §9.1 `Number.isFinite` row exists for exactly this.
  // The pair is now named once (so the arc and the dot cannot sample from two different bands),
  // and the function REFUSES anything that is not a pair rather than silently returning NaN: a
  // wrong argument here is a programming error, and the whole point of R0 is that it must not be
  // masked by a new texture on top of it.
  const ARC_LENGTH_RANGE = Object.freeze([CARTOON_CLEAR.arc.minLength, CARTOON_CLEAR.arc.maxLength])
  const DOT_SIZE_RANGE = Object.freeze([CARTOON_CLEAR.dot.minSize, CARTOON_CLEAR.dot.maxSize])
  const nanGuards = { lerp: 0, size: 0, velocity: 0, rotation: 0, arrival: 0, pivot: 0 }
  const lerp = (range, t) => {
    if (!Array.isArray(range) || range.length < 2 || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) {
      throw new Error(`lerp expects a finite [min,max] pair, received ${JSON.stringify(range)}`)
    }
    const value = range[0] + (range[1] - range[0]) * t
    if (!Number.isFinite(value)) {
      nanGuards.lerp += 1
      throw new Error(`lerp produced ${value} from [${range[0]}, ${range[1]}] at t=${t}`)
    }
    return value
  }
  /**
   * §9.1 「Number.isFinite覆盖size/velocity/rotation/arrival/pivot」. Every value that leaves this
   * file for the GPU or for the shake passes through here first: a NaN position silently draws
   * NOTHING (three.quarks fills a NaN matrix and the whole batch disappears while the counters
   * still report the full budget — measured, see the geometry pool's own note), so "it is finite"
   * is not a nicety, it is the difference between the effect existing and not.
   */
  function finite(value, label, kind = 'size') {
    if (Number.isFinite(value)) return value
    nanGuards[kind] = (nanGuards[kind] || 0) + 1
    throw new Error(`${label} is not finite: ${value}`)
  }

  function addCartoonSystems(specs, record, center) {
    const byId = {}
    let total = 0
    for (const spec of specs) {
      if (spec.count <= 0) continue
      const coverage = tileCoverage(spec.id)
      const size = spec.sizes?.[0] ?? visibleSize(0.16, coverage.x)
      const system = new ParticleSystem({
        autoDestroy: true,
        looping: false,
        duration: Math.max(0.02, spec.delay + spec.life),
        startLife: new ConstantValue(Math.max(0.02, spec.life)),
        startSpeed: new ConstantValue(spec.speed ?? 1),
        startSize: new ConstantValue(size),
        startColor: new ConstantColor(new THREE.Vector4(1, 1, 1, 1)),
        startTileIndex: new ConstantValue(tileIndex(spec.id)),
        uTileCount: CARTOON_CLEAR.atlas.columns,
        vTileCount: CARTOON_CLEAR.atlas.rows,
        emissionOverTime: new ConstantValue(0),
        emissionBursts: [{ time: 0, count: Math.max(0, Math.round(spec.count)), cycle: 1, interval: 0.01, probability: 1 }],
        shape: new CartoonSpriteEmitter({
          points: spec.points, velocities: spec.velocities, rotations: spec.rotations, sizes: spec.sizes,
        }),
        material: cartoon.status === 'ready' ? atlasMaterial : fallbackMaterial,
        renderMode: RenderMode.BillBoard,
        renderOrder: 4,
        worldSpace: true,
        behaviors: [
          new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 1, 0.6, 0.25), 0]])),
          ...(spec.gravity > 0 ? [new GravityBehavior(spec.gravity)] : []),
        ],
        // v0.13.0 R5's layer switch is idempotent and always points at the same mask; the batch
        // key includes it, so it is set at construction and never moved afterwards (§6.2).
        layers: clearLayers,
      })
      // §5's REAL delay: the system exists, is batched, and is PAUSED until its beat. Nothing is
      // scheduled with setTimeout, and no nominal `paperStart` stands in for a real emission time.
      system.paused = spec.delay > 0
      system.emitter.position.copy(center)
      scene.add(system.emitter)
      system.emitter.updateMatrixWorld(true)
      particleRenderer.addSystem(system)
      const until = performance.now() + (spec.delay + spec.life) * 1000
      const systemRecord = {
        system,
        count: spec.count,
        pool: 'cartoon',
        id: spec.id,
        emitAt: performance.now() + spec.delay * 1000,
        // `until` is the moment the LAST particle dies -- the only clock a budget check may use.
        // `pruneAt` adds the small release margin: disposing is bookkeeping, and letting the
        // margin leak into `until` would make a 360ms effect report as alive at 420ms.
        until,
        pruneAt: until + 60,
        scopeEpoch: cartoon.scopeEpoch,
      }
      systemRecords.add(systemRecord)
      record.records.push(systemRecord)
      byId[spec.id] = spec.count
      total += spec.count
    }
    return { count: total, byId }
  }

  /** The merged, batched contour: one mesh and one material per event, never one per cell. */
  function buildCartoonOutlineGeometry(plan, widthWorld, offsetWorld) {
    const positions = []
    const indices = []
    for (const footprint of plan.faceFootprints) {
      const normal = faceNormalWorld(footprint.face)
      const first = worldCell(footprint.cells[0])
      const last = worldCell(footprint.cells[footprint.cells.length - 1])
      const along = last.clone().sub(first)
      if (along.lengthSq() < 1e-9) continue
      const direction = along.clone().normalize()
      const side = new THREE.Vector3().crossVectors(normal, direction)
      if (side.lengthSq() < 1e-9) continue
      side.normalize().multiplyScalar(widthWorld * 0.5)
      const extension = direction.clone().multiplyScalar(cellSize * 0.5)
      const a0 = first.clone().sub(extension).addScaledVector(normal, offsetWorld)
      const a1 = last.clone().add(extension).addScaledVector(normal, offsetWorld)
      const base = positions.length / 3
      positions.push(
        a0.x - side.x, a0.y - side.y, a0.z - side.z,
        a0.x + side.x, a0.y + side.y, a0.z + side.z,
        a1.x + side.x, a1.y + side.y, a1.z + side.z,
        a1.x - side.x, a1.y - side.y, a1.z - side.z,
      )
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    if (!indices.length) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    return geometry
  }

  /**
   * §7.1's scope cancel. A settings panel, the help card, the home cover, a hidden tab, the end
   * of the run, a restart and a resume all close the NORMAL clear's scope: `clearScopeEpoch`
   * advances so any late callback is stale, and the clear's own particles and contours go away.
   * It deliberately does NOT touch the item bursts, the record card, the reward note or the audio.
   */
  /**
   * §3.1's FIRST gate: show all eight tiles, one at a time, through the very path the runtime
   * clear uses -- Quarks `RenderMode.BillBoard` + `startTileIndex` + the shipped material -- so a
   * capture can prove the atlas is sampled at the right tile, right way up, with the right
   * direction, instead of proving that a file finished loading. Returns the world centre of each
   * quad so a probe can measure what it actually got.
   */
  function showAtlasGate({ tileWorld = 1.1, spacing = 1.7, yOffset = 2.6, plate = false, tiles = true } = {}) {
    const ids = CARTOON_CLEAR.atlas.order
    const columns = CARTOON_CLEAR.atlas.columns
    const rows = CARTOON_CLEAR.atlas.rows
    const start = performance.now()
    const specs = ids.map((id, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      const point = new THREE.Vector3(
        (column - (columns - 1) / 2) * spacing,
        ((rows - 1) / 2 - row) * spacing + yOffset,
        6,
      )
      return {
        id,
        index,
        centre: point,
        count: 1,
        delay: 0,
        life: 6,
        speed: 1,
        points: [point.clone()],
        velocities: [new THREE.Vector3(0, 0, 0)],
        rotations: [0],
        // The quad is the tile's own 128px square, so the gate measures the whole tile rather
        // than the graphic inside it -- `visibleSize()`'s coverage correction is for the runtime
        // clear and would make the gate read as a size test.
        sizes: [tileWorld],
        gravity: 0,
      }
    })
    // The gate can put a dark plate behind itself, because a cream star or a cream swoosh drawn
    // in front of the cream board is a difference of nearly zero -- the only measurable pixels
    // are the graphic outline, and the mask then fills its whole window.
    //
    // A caller that wants the plate captured EMPTY and then with the tiles must create it in the
    // first call and leave it alive: creating a fresh plate for the second capture produced two
    // frames that differed by nothing at all, because the tiles of the second call were never in
    // the picture.
    if (plate) {
      const plateGeometry = new THREE.PlaneGeometry(spacing * columns + 0.7, spacing * rows + 0.7)
      const plateMesh = new THREE.Mesh(plateGeometry, markMaterial(0x2a3550, 0.94))
      plateMesh.position.set(0, yOffset, 6 - 0.22)
      addTransient({ object: plateMesh, duration: 12, kind: 'decoration', ownGeometry: true, update: () => {} })
    }
    const record = { records: [], transients: [] }
    const spawn = tiles
      ? addCartoonSystems(specs, record, new THREE.Vector3(0, 0, 0))
      : { count: 0, byId: {} }
    specs.length = tiles ? specs.length : 0
    // One synchronous step so the burst exists by the time the caller screenshots, rather than
    // depending on whether a frame happened to land in between.
    particleRenderer.update(0.001)
    camera.updateMatrixWorld()
    const box = getCanvasRect?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    const scratch = new THREE.Vector3()
    return {
      spawned: spawn.count,
      systems: record.records.length,
      startedAt: start,
      atlas: cartoon.status,
      columns,
      rows,
      tileWorld,
      spacing,
      tiles: specs.map((spec) => {
        // CSS pixels inside the canvas box the frame is drawn into. `project()` is the canonical
        // camera; the render camera is a copy of it, so both agree on where the board is.
        const projected = scratch.copy(spec.centre).project(camera)
        const toScreen = (dx, dy) => {
          const p = new THREE.Vector3(spec.centre.x + dx, spec.centre.y + dy, spec.centre.z).project(camera)
          return {
            x: box.left + (p.x * 0.5 + 0.5) * box.width,
            y: box.top + (0.5 - p.y * 0.5) * box.height,
          }
        }
        const centre = {
          x: box.left + (projected.x * 0.5 + 0.5) * box.width,
          y: box.top + (0.5 - projected.y * 0.5) * box.height,
        }
        // The tile's OWN on-screen size, measured from its own corners. A single global pitch was
        // tried first and under-measured the central tiles by ~10%: the camera looks at the origin
        // from an angle, so a tile four units off-axis is not at the same depth as its neighbour.
        const half = tileWorld / 2
        const right = toScreen(half, 0)
        const top = toScreen(0, half)
        return {
          id: spec.id,
          index: tileIndex(spec.id),
          world: spec.centre.toArray(),
          screen: centre,
          screenSize: {
            width: Math.hypot(right.x - centre.x, right.y - centre.y) * 2,
            height: Math.hypot(top.x - centre.x, top.y - centre.y) * 2,
          },
        }
      }),
      live: liveCartoonSprites(),
    }
  }

  function cancelCartoonScope() {
    cartoon.scopeEpoch += 1
    const now = performance.now()
    for (const record of [...systemRecords]) {
      if (record.pool !== 'cartoon') continue
      record.until = Math.min(record.until, now)
      record.pruneAt = Math.min(record.pruneAt ?? record.until, now)
    }
    // The contours are REMOVED here, not merely marked. Marking them and letting the frame loop
    // compact the list looked equivalent but was not: every §7.1 transition also PAUSES the frame
    // loop (the settings panel, the help card, the cover), so `effects.update()` never ran and a
    // cancelled contour stayed in the list for as long as the pause lasted.
    transientEffects = transientEffects.filter((effect) => {
      if (effect.pool !== 'cartoon') return true
      releaseTransient(effect)
      return false
    })
    for (const event of cartoon.events) event.until = Math.min(event.until, now)
    // §8.3: the placement-driven layer closes on the SAME transition, with the same stale-token
    // contract — a queued burst or a cube in flight must not come back after a settings panel.
    impact.cancelScope()
  }

  function cartoonReport() {
    const live = liveCartoonEvents()
    const now = performance.now()
    return {
      atlas: { status: cartoon.status, error: cartoon.error, hasFrames: Boolean(cartoon.frames), tileSize: CARTOON_CLEAR.atlas.tile },
      // §7.2's draw-call budget is spent by BATCHES, and quarks keeps an emptied batch in the
      // scene, so "how many batches exist" is the number a draw-call delta has to be read against.
      batches: particleRenderer.children.length,
      layers: { clearMask: clearLayers.mask },
      scopeEpoch: cartoon.scopeEpoch,
      liveEvents: live.length,
      liveSprites: liveCartoonSprites(),
      liveCap: quality.lowPower ? CARTOON_CLEAR.live.lowPower : CARTOON_CLEAR.live.standard,
      liveSystems: [...systemRecords].filter((record) => record.pool === 'cartoon' && now < record.until).length,
      droppedByCap: cartoon.droppedByCap,
      droppedByEvents: cartoon.droppedByEvents,
      spawnedTotal: cartoon.spawnedTotal,
      lastEvent: cartoon.lastEvent,
      lastPlan: cartoon.lastPlan
        ? {
          physicalLineCount: cartoon.lastPlan.physicalLineCount,
          rawLineCount: cartoon.lastPlan.rawLineCount,
          duplicatedReports: cartoon.lastPlan.duplicatedReports,
          uniqueCellCount: cartoon.lastPlan.uniqueCellCount,
          intersections: cartoon.lastPlan.intersections.length,
          outlineCellCount: cartoon.lastPlan.outlineCellCount,
          outlineTruncated: cartoon.lastPlan.outlineTruncated,
          faces: cartoon.lastPlan.faceFootprints.map((footprint) => `${footprint.face}:${footprint.axis}${footprint.index}`),
        }
        : null,
      // §4's own read-out: the origin each line was entered at, the two distances and the two
      // arrivals the doc states. A probe can recompute every number here from `cellPulsePlan`'s
      // formula alone, which is the point — "the light leaves from where the hand fell" has to be
      // assertable, not just claimable.
      lastPropagation: cartoon.lastPropagation
        ? {
          placedCellCount: cartoon.lastPropagation.placedCellCount,
          placedKnown: cartoon.lastPropagation.placedKnown,
          fallbackLines: cartoon.lastPropagation.fallbackLines,
          earliestEndMs: cartoon.lastPropagation.earliestEndMs,
          maxDistanceCells: cartoon.lastPropagation.maxArrivalMs,
          contract: cartoon.lastPropagation.contract,
          faceRays: cartoon.lastPropagation.faceRays.length,
          pulse: cartoon.lastPropagation.pulse
            ? { face: cartoon.lastPropagation.pulse.face, uv: cartoon.lastPropagation.pulse.uv, color: cartoon.lastPropagation.pulse.color }
            : null,
          lines: cartoon.lastPropagation.lines.map((line) => ({
            key: line.key,
            face: line.face,
            hits: line.hitIndexes,
            originT: line.originT,
            originUv: line.originUv,
            minusMs: line.minus.arrivalMs,
            plusMs: line.plus.arrivalMs,
            originFallback: line.originFallback,
          })),
          endpoints: cartoon.lastPropagation.endpoints.map((end) => ({
            cell: end.cell, face: end.face, direction: end.direction, arrivalMs: end.arrivalMs,
          })),
        }
        : null,
      nanGuards: { ...nanGuards },
    }
  }

  // ---------------------------------------------------------------- the event
  /**
   * One settled placement = one event = one budget (§3). `level` is the rules layer's own
   * feedback level (scoring.js `rewardLevel` for a version-2 run, honors.js `feedbackLevel` for
   * a legacy one): this function never re-derives a level and never re-counts lines.
   *
   * v0.13.3: the NORMAL clear is now the cartoon clear below. What used to live here -- the paper
   * budget chosen from `level`, the L1-L5 tail, the per-level decoration ladder and the
   * `spawnChips()` allocation -- is superseded by §4.3's `physicalLineCount` table, so `level` and
   * `reward` are still accepted (every caller passes them) and are recorded, but neither picks a
   * budget any more. §4.1 states why: `level` is derived from the RAW face-line count, and a
   * shared edge/corner inflates that. The reward's own presentation (the merged note, the main
   * cue, the reward shake) is main's, and §6.4 keeps it exactly as it is.
   */
  function spawnClearEffects(lines, level, { reward = null, frontFace = null, visibleFaces = [], placement = null } = {}) {
    const ranked = Math.min(Math.max(0, Math.trunc(level) || 0), 5)
    eventId += 1
    const id = eventId
    const event = spawnCartoonClear(lines, ranked, { reward, frontFace, visibleFaces, placement })
    // The two fields the old record carried that callers still read: which event this was, and
    // which level the rules layer announced. Neither picks a budget any more (§4.1).
    lastEvent = { ...event, id, level: ranked, rewardType: reward?.primaryType || null }
    return lastEvent
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
      if (now < (record.pruneAt ?? record.until)) continue
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
      releaseTransient(effect)
      return false
    })
  }

  /** §7.2: a new drag preview or tool scope takes the range - decoration leaves first. */
  function retreatDecorations() {
    const now = performance.now()
    for (const effect of transientEffects) {
      // §7.1 「新拖拽/工具瞄准：旧飞行装饰≤80ms退出；覆盖落点的轮廓立即退出」. The clear's own
      // contours get the doc's 80ms rather than the celebration's longer, gentler 120ms — a
      // contour over the landing cells would fight the ghost for the same pixels.
      const window = effect.pool === 'cartoon' ? 80 : 120
      effect.until = Math.min(effect.until, now + window)
    }
    for (const record of systemRecords) {
      const window = record.pool === 'cartoon' ? 80 : 120
      record.until = Math.min(record.until, now + window)
    }
  }

  /**
   * §5's REAL emission delay. A system is created (and batched) at t=0 but stays PAUSED until its
   * own beat, so 「110ms 弹出」 is measured from the settled placement and not from a nominal
   * constant that the burst ignored. This is the one clock: the frame loop, never setTimeout.
   */
  function releaseCartoonEmission(now) {
    for (const record of systemRecords) {
      if (record.pool !== 'cartoon') continue
      if (!record.system.paused) continue
      if (now >= record.emitAt) record.system.paused = false
    }
  }

  /**
   * §7.1 「Reduced-motion 动态开启：当帧停飞行/弧线，余下仅短静态确认；不是必须刷新才生效」.
   * The preference is queried per event, but an event that is ALREADY in flight when the player
   * flips the OS switch has to stop too — otherwise the setting only takes effect on the next
   * clear, which is exactly the "must reload" behaviour the doc rules out.
   */
  let lastReducedMotion = null
  function honourReducedMotionToggle(now) {
    const reduced = prefersReducedMotion()
    if (lastReducedMotion === null) { lastReducedMotion = reduced; return }
    if (reduced === lastReducedMotion) return
    lastReducedMotion = reduced
    if (!reduced) return
    for (const record of systemRecords) {
      if (record.pool !== 'cartoon') continue
      record.until = Math.min(record.until, now)
      record.pruneAt = Math.min(record.pruneAt ?? record.until, now)
    }
    for (const effect of transientEffects) {
      if (effect.pool !== 'cartoon') continue
      // The contour is the CONFIRMATION, not decoration: it is allowed to finish its one fade-out
      // (§5.2 「一次亮起收净」) instead of being cut mid-pulse. Only the flying sprites stop.
      if (effect.kind === 'outline') continue
      effect.until = Math.min(effect.until, now)
    }
  }

  function update(delta) {
    const now = performance.now()
    honourReducedMotionToggle(now)
    releaseCartoonEmission(now)
    particleRenderer.update(delta)
    updateTransientEffects(delta)
    // v0.13.4 R1: the placement-driven layer steps on the SAME wall clock. It is not the particle
    // renderer and it is not slowed by the L5 dip (§8.3 「事件时间使用wall clock，不乘L5慢放」).
    impact.update(delta)
    pruneSystems()
    // Read live, never captured: the drag preview and the tool scope both belong to the input
    // layer and can appear between two frames.
    if (getInputBusy()) {
      retreatDecorations()
      // §3.2: 「新拖拽开始立即收敛」. The reward shake is the one offset that could still be
      // running when a new drag begins, and the drag's own hit-test raycasts through the very
      // camera this offset moves — so it is cancelled here rather than left to decay.
      cancelRewardShake()
    }
  }

  function clearTransientEffects() {
    transientEffects.forEach((effect) => { releaseTransient(effect) })
    transientEffects = []
    systemRecords.forEach((record) => { try { record.system.dispose() } catch { /* already released */ } })
    systemRecords.clear()
  }

  function triggerShake(amount) { cameraShake = Math.max(cameraShake, amount) }

  // v0.10.3 (handoff §3.2): the REWARD shake, stated in CSS pixels and lasting a stated
  // window. It is deliberately NOT `triggerShake(px)`:
  //   * `px` is converted through the camera's own projection, so 「2px」 is 2px on screen at
  //     any zoom or aspect instead of 2 world units (~55px at the shipped framing);
  //   * it ENDS inside its window — a decaying amplitude (shakeDecay 0.42/s) would still be
  //     moving a second later, which is not 「80ms」;
  //   * reduced motion closes it outright (§3.2), and a new drag cancels it immediately
  //     (§3.2 「新拖拽开始立即收敛」, in update() below).
  // The offset is applied to the camera position ONLY, after main restores the resting
  // position — the logical camera, the HUD, the candidate tray and the drag hit-test are not
  // moved by it (main.js's frame loop reads `effects.updateShake` for the picture alone).
  let shakePulse = null

  function triggerRewardShake(px, ms) {
    if (prefersReducedMotion()) return false
    const pixels = Number(px)
    const window = Number(ms)
    if (!(pixels > 0) || !(window > 0)) return false
    const worldPerPx = Number(getWorldPerPixel()) || 0
    if (!(worldPerPx > 0)) return false
    shakePulse = { amplitude: pixels * worldPerPx, startedAt: performance.now(), ms: window, px: pixels }
    return true
  }

  function cancelRewardShake() { shakePulse = null }

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
    let amplitude = cameraShake
    if (shakePulse) {
      const k = (performance.now() - shakePulse.startedAt) / shakePulse.ms
      // A linear ramp to exactly zero: the offset is gone at the end of its own window rather
      // than trailing off as an exponential tail.
      if (k >= 1) shakePulse = null
      else amplitude += shakePulse.amplitude * (1 - k)
    }
    shakeOffset.set(0, 0, 0)
    if (amplitude > 0) {
      const time = performance.now() * 0.045
      shakeOffset.x = Math.sin(time) * amplitude
      shakeOffset.y = Math.cos(time * 1.17) * amplitude * 0.7
      shakeOffset.z = Math.sin(time * 0.83) * amplitude * 0.5
    }
    return shakeOffset
  }

  function resetShake() { cameraShake = 0; shakePulse = null }
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

  // v0.13.0 R5 (handoff §9.4): `setGameplayVisualsVisible(!home)` needs a handle for the EFFECTS,
// not only for the cube. A clear burst that was mid-flight when the cover opened belongs to the
// frame the board was in, so it goes away with the board — and when the cover closes the systems
// are still there, still running, which is what "隐藏游戏 FX 不等于清空游戏状态" asks for.
function setVisible(on) {
  const visible = Boolean(on)
  fxGroup.visible = visible
  particleRenderer.visible = visible
  // v0.13.4 R1: the placement layer's two groups take the same switch as the board's own effects.
  impact.setVisible(visible)
  return { fxGroup: fxGroup.visible, particleRenderer: particleRenderer.visible }
}

function report() {    // `liveParticles` is the system's OWN particle count: the budget says how many were ASKED
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
      outlines: countKind('outline'),
      transients: transientEffects.length,
      shake: Number(cameraShake.toFixed(4)),
      // The reward pulse, in the unit it was ASKED for and in the unit it is applied in. A
      // headless check can then assert 「2px for 100ms」 without knowing the framing.
      rewardShake: shakePulse
        ? {
          px: shakePulse.px,
          ms: shakePulse.ms,
          amplitude: Number(shakePulse.amplitude.toFixed(4)),
          elapsed: Math.round(performance.now() - shakePulse.startedAt),
        }
        : null,
      slowMo: slowMo !== null,
      reducedMotion: prefersReducedMotion(),
      lowPower: Boolean(quality.lowPower),
      event: lastEvent,
      eventId,
      // §4.3 「两个系统并行时的总live计数必须在report显式分项」: the celebration's own pool and the
      // normal clear's are counted apart, so "the new pool looks fine" can never hide a total that
      // is over. `cartoon` carries the planner's own numbers as well.
      celebrationChips: liveChipCount('celebration'),
      cartoon: cartoonReport(),
      // v0.13.4 R1 (§5.2/§8.3): the new layer has its own line in the read-out — a budget that is
      // "fine" in one pool can never hide a total that is over, so the sweep, the bursts, the
      // cubes and the pack's own asset contracts are all reported apart from the v1 counts.
      impact: impact.report(),
    }
  }

  return {
    // per-frame
    update,
    timestep,
    updateShake,
    report,
    // v0.13.0 R5 (handoff §9.4): the home cover hides the BOARD's own objects, not the world —
    // the scene still renders behind it. "Hide the cube" is not the same sentence as "hide the
    // clear particles that were mid-flight when the cover opened", so both top-level scene
    // objects take one switch and no caller has to remember where each kind of effect lives.
    setVisible,
    // game events
    emitItemBurst,
    spawnClearEffects,
    retreatDecorations,
    triggerShake,
    // v0.10.3: the reward signature's own offset (CSS px + window), and the cancel that a new
    // drag performs. `triggerShake` stays for the world-unit callers that already exist.
    triggerRewardShake,
    cancelRewardShake,
    triggerSlowMo,
    clearTransientEffects,
    resetShake,
    clearSlowMo,
    // v0.13.3 (handoff §3.1/§7.1): the atlas is loaded lazily and never blocks the first move,
    // `cancelCartoonScope` is the scoped cancel §7.1 asks for, and `cartoonReport` is the
    // planner's own read-out.
    loadCartoonAtlas,
    // v0.13.4 R1 (§8.1): the impact pack loads lazily and never blocks a move. `impactReport` is
    // the pack's own asset read-out plus its live counters.
    loadImpactAssets: () => impact.load(),
    impactReport: () => impact.report(),
    // DEV only: freeze the impact layer's clock and run one real frame (§9.1's recomputable rows).
    impactStep: (tMs, delta) => impact.devStep(tMs, delta),
    cancelCartoonScope,
    cartoonReport,
    // The §3.1 sampling gate. DEV-only caller (main's `__voxalblastDev.atlasGate`), but the
    // function has to live here because it is the Quarks path, not a mock of it.
    showAtlasGate,
    // haptics (sound lives in src/audio/gameAudio.js since v0.10.1)
    playHaptic,
  }
}

// Effects - particles, line beams, stars, camera shake, slow motion and audio (refactor P5).
//
// Plan section 2 `effects.js`: it owns the batched particle renderer and every system added to
// it, the transient list (the clear beams and stars), the shake amount, the L5 slow-motion dip
// and the AudioContext with the tone/haptic output. It does NOT own the score, the board, the
// input lock, the HUD DOM animations (ui/hud) or the intro wave (boardView) - and it never
// computes the camera's resting position, only the shake offset added to it.
//
// Everything main used to close over arrives as a parameter: the scene and the camera, the cube
// group and boardView's conversions (called, never re-derived), the resolved quality tier
// (particle counts follow it) and settings' two switches as LIVE getters, because a captured
// boolean would go stale the moment the player flips one.
//
// The compat bridge is imported first on purpose: three.quarks needs it, and relying on main's
// import order would be relying on accident (plan section 7).
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
} from 'three.quarks'
import { VFX_CONFIG, FEEDBACK_STYLE, RENDER_PALETTE as palette, BOARD_STYLE as style } from './config.js'

export function createEffects({
  scene,
  camera,
  cubeGroup,
  // The cube's side length, for the one geometry that is scaled to the cube (the clear beam is a
  // hair longer than the board it crosses). The lattice arithmetic itself stays main's.
  cubeSide,
  cellToWorld,
  cubeVector,
  findFrontFace,
  quality,
  getSoundOn,
  getHapticsOn,
}) {
  // The effect surfaces (beams, stars) are scene-level: they are world-space objects, not part
  // of the cube, so they must not inherit its rotation.
  const fxGroup = new THREE.Group()
  scene.add(fxGroup)

  // Plan section 2 state table: these four are effects' own.
  let audioContext
  let cameraShake = 0
  let transientEffects = []
  const particleSystems = new Set()

  const particleGeometry = new RoundedBoxGeometry(0.18, 0.18, 0.18, 2, 0.04)
  const beamGeometry = new THREE.BoxGeometry(cubeSide + 0.06, 0.07, 0.07)
  function buildStarShape(outer = 0.5, inner = 0.2, points = 5) {
    const shape = new THREE.Shape()
    for (let i = 0; i < points * 2; i += 1) {
      const radius = i % 2 === 0 ? outer : inner
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2
      const x = Math.cos(angle) * radius
      const y = Math.sin(angle) * radius
      if (i === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    }
    shape.closePath()
    return new THREE.ShapeGeometry(shape)
  }
  const starGeometry = buildStarShape(0.5, 0.22, 5)
  const particleMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  })
  const particleRenderer = new BatchedRenderer()
  scene.add(particleRenderer)

  function colorToVector4(color, alpha = 1) {
    const normalized = new THREE.Color(color)
    return new THREE.Vector4(normalized.r, normalized.g, normalized.b, alpha)
  }

  class AxisEmitter {
    constructor(direction, spread = VFX_CONFIG.clear.spread) {
      this.type = 'axis'
      this.direction = direction.clone().normalize()
      this.spread = spread
      this.sequence = 0
    }

    initialize(particle) {
      const helper = Math.abs(this.direction.y) < 0.8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
      const side = new THREE.Vector3().crossVectors(helper, this.direction).normalize()
      const other = new THREE.Vector3().crossVectors(this.direction, side).normalize()
      const phase = this.sequence++ * 2.399963
      particle.position.set(0, 0, 0)
      particle.velocity.copy(this.direction)
        .addScaledVector(side, Math.cos(phase) * this.spread)
        .addScaledVector(other, Math.sin(phase) * this.spread * 0.7)
        .normalize()
        .multiplyScalar(particle.startSpeed)
    }

    toJSON() { return { type: this.type, direction: this.direction.toArray(), spread: this.spread } }
    clone() { return new AxisEmitter(this.direction, this.spread) }
  }

  function spawnLineParticles(line, scale = 1) {
    const worldU = cubeVector(line.face, 'u').applyQuaternion(cubeGroup.quaternion)
    const worldV = cubeVector(line.face, 'v').applyQuaternion(cubeGroup.quaternion)
    const direction = line.axis === 'row' ? worldU : worldV
    const color = palette.line[line.axis === 'row' ? 'x' : 'y']
    const brightEnd = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.42)
    const center = lineCenterWorld(line)
    // The feedback ladder raises the particle count and size with the level (08 §6):
    // L1 runs the baseline burst, L5 lands at 5×.
    const burst = Math.max(3, Math.round(quality.particlesPerLine * scale))
    const system = new ParticleSystem({
      autoDestroy: true,
      looping: false,
      duration: 0.72,
      startLife: new ConstantValue(0.62),
      startSpeed: new ConstantValue(1.45),
      startSize: new ConstantValue(0.09 * (1 + (scale - 1) * 0.12)),
      startColor: new ConstantColor(colorToVector4(color)),
      emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(burst), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new AxisEmitter(direction),
      material: particleMaterial,
      instancingGeometry: particleGeometry,
      renderMode: RenderMode.Mesh,
      renderOrder: 4,
      worldSpace: true,
      behaviors: [
        new ColorOverLife(new Gradient([
          [new THREE.Vector3(new THREE.Color(color).r, new THREE.Color(color).g, new THREE.Color(color).b), 0],
          [new THREE.Vector3(brightEnd.r, brightEnd.g, brightEnd.b), 1],
        ], [[1, 0.95], [0, 0.02]])),
        new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 1.15, 0.4, 0), 0]])),
      ],
    })
    system.emitter.position.copy(center)
    scene.add(system.emitter)
    system.emitter.updateMatrixWorld(true)
    particleRenderer.addSystem(system)
    particleSystems.add(system)
  }

  function lineCenterWorld(line) {
    const cell = line.cells[Math.floor(line.cells.length / 2)]
    return cellToWorld(cell[0], cell[1], cell[2])
      .addScaledVector(cubeVector(line.face, 'n'), style.feedbackSurfaceOffset)
      .applyMatrix4(cubeGroup.matrixWorld)
  }

  function spawnLineBeam(line, index, scale = 1) {
    const center = lineCenterWorld(line)
    const worldU = cubeVector(line.face, 'u').applyQuaternion(cubeGroup.quaternion)
    const worldV = cubeVector(line.face, 'v').applyQuaternion(cubeGroup.quaternion)
    const dir = line.axis === 'row' ? worldU : worldV
    const beam = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({
      color: palette.line[line.axis === 'row' ? 'x' : 'y'],
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }))
    beam.position.copy(center)
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir)
    fxGroup.add(beam)
    transientEffects.push({
      object: beam,
      elapsed: -index * 0.035,
      duration: 0.56,
      update: (effect, delta) => {
        effect.elapsed += delta
        const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
        const pulse = progress < 0.25 ? progress / 0.25 : 1 - (progress - 0.25) / 0.75
        effect.object.material.opacity = Math.max(0, pulse) * VFX_CONFIG.clear.beamOpacity
        const scale = progress < 0.25 ? 0.72 + progress * 1.12 : 1.0
        effect.object.scale.setScalar(scale)
      },
    })
    spawnLineParticles(line, scale)
  }

  function spawnClearStars(line, index, starScale = 1) {
    const center = lineCenterWorld(line)
    ;[0xffd32a, 0xff9c3d].forEach((color, starIndex) => {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      })
      const star = new THREE.Mesh(starGeometry, material)
      star.position.copy(center)
      fxGroup.add(star)
      transientEffects.push({
        object: star,
        elapsed: -index * 0.02,
        duration: VFX_CONFIG.clear.starDuration,
        update: (effect, delta) => {
          effect.elapsed += delta
          const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
          const pop = progress < 0.22 ? 0.1 + (progress / 0.22) * 1.0 : 1.1 - ((progress - 0.22) / 0.78) * 0.18
          const base = starIndex === 0 ? 1 : 0.6
          effect.object.quaternion.copy(camera.quaternion)
          effect.object.scale.setScalar(base * pop * VFX_CONFIG.clear.starMaxScale * starScale)
          const fade = progress < 0.12 ? progress / 0.12 : progress > 0.55 ? 1 - (progress - 0.55) / 0.45 : 1
          effect.object.material.opacity = Math.max(0, fade) * 0.85
        },
      })
    })
  }

  function spawnClearEffects(lines, level = 1) {
    // One place that turns a feedback LEVEL (honors.js) into strength (08 §6): the
    // ladder is what makes a 4-line clear visibly heavier than a single line.
    const feedback = FEEDBACK_STYLE.levels[level] || FEEDBACK_STYLE.levels[1]
    const scale = feedback.particleScale || 1
    lines.forEach((line, index) => {
      spawnLineBeam(line, index, scale)
      spawnClearStars(line, index, Math.min(2, 1 + (scale - 1) * 0.25))
    })
    triggerShake(feedback.shake)
  }

  function updateTransientEffects(delta) {
    transientEffects = transientEffects.filter((effect) => {
      effect.update(effect, delta)
      if (effect.elapsed < effect.duration) return true
      fxGroup.remove(effect.object)
      if (effect.object.material) effect.object.material.dispose()
      return false
    })
  }

  function clearTransientEffects() {
    transientEffects.forEach((effect) => {
      fxGroup.remove(effect.object)
      if (effect.object.material) effect.object.material.dispose()
    })
    transientEffects = []
    particleSystems.forEach((system) => system.dispose())
    particleSystems.clear()
  }

  function triggerShake(amount) { cameraShake = Math.max(cameraShake, amount) }
  // The camera's RESTING position is not this module's business: gameScene owns the orbit
  // distance, the zoom and the direction vector, and main restores that position before asking
  // for the shake. So what comes back from here is the OFFSET alone - same decay, same clock,
  // same three sine terms - and there is still exactly one place that computes where the camera
  // sits when nothing is shaking (plan section 5: neither side keeps its own cameraZoom).
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

  // The two resets a new run or a re-applied session performs: main used to assign the variables
  // directly, now it calls these where it used to.
  function resetShake() { cameraShake = 0 }
  function clearSlowMo() { slowMo = null }

  function emitItemBurst(cells, axisHint) {
    if (!cells.length) return
    const frontFace = findFrontFace()
    const uDir = cubeVector(frontFace, 'u').applyQuaternion(cubeGroup.quaternion)
    const vDir = cubeVector(frontFace, 'v').applyQuaternion(cubeGroup.quaternion)
    const worldCenter = new THREE.Vector3()
    cells.forEach(([x, y, z]) => worldCenter.add(cellToWorld(x, y, z).applyMatrix4(cubeGroup.matrixWorld)))
    worldCenter.multiplyScalar(1 / cells.length)
    worldCenter.addScaledVector(cubeVector(frontFace, 'n').applyQuaternion(cubeGroup.quaternion), style.feedbackSurfaceOffset)
    const count = THREE.MathUtils.clamp(cells.length * 6, 6, 48)
    const direction = uDir.clone().add(vDir).normalize()
    const warm = new THREE.Vector3(1, 0.83, 0.16)
    const bright = new THREE.Vector3(1, 0.96, 0.45)
    const system = new ParticleSystem({
      autoDestroy: true,
      looping: false,
      duration: 0.55,
      startLife: new ConstantValue(0.45),
      startSpeed: new ConstantValue(1.15),
      startSize: new ConstantValue(0.1),
      startColor: new ConstantColor(colorToVector4(0xffd32a)),
      emissionOverTime: new ConstantValue(0),
      // three.quarks types `emissionBursts[].count` as a ValueGenerator and calls
      // count.genValue() when the burst fires — a raw number throws there and takes
      // the whole frame down with it (animate() aborts before composer.render, so the
      // canvas freezes while the game keeps running). Wrap it.
      emissionBursts: [{ time: 0, count: new ConstantValue(count), cycle: 1, interval: 0.01, probability: 1 }],
      shape: new AxisEmitter(direction, 0.5),
      material: particleMaterial,
      instancingGeometry: particleGeometry,
      renderMode: RenderMode.Mesh,
      renderOrder: 4,
      worldSpace: true,
      behaviors: [
        new ColorOverLife(new Gradient([[warm, 0], [bright, 1]], [[1, 0.95], [0, 0.02]])),
        new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 1.1, 0.3, 0), 0]])),
      ],
    })
    system.emitter.position.copy(worldCenter)
    scene.add(system.emitter)
    system.emitter.updateMatrixWorld(true)
    particleRenderer.addSystem(system)
    particleSystems.add(system)
  }

  function playTone(frequency, duration = 0.08, volume = 0.045, delay = 0) {
    if (!getSoundOn()) return
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return
    audioContext ||= new AudioContext()
    if (audioContext.state === 'suspended') audioContext.resume()
    const start = audioContext.currentTime + delay
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, start)
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.08, start + duration)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(gain).connect(audioContext.destination)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.02)
  }

  function playPlaceSound(lineCount) {
    if (lineCount > 0) {
      playTone(520, 0.12, 0.055)
      playTone(lineCount > 1 ? 880 : 720, 0.16, 0.05, 0.055)
    } else playTone(330, 0.075, 0.036)
  }

  // Feedback ladder (08 §6 / 03 §7): the level comes from honors.js, these are the
  // noises that go with it. L1/L2 are still just chords — the banner is earned at L3.
  function playHonorSound(level) {
    if (level >= 5) [660, 830, 990, 1320].forEach((tone, index) => playTone(tone, 0.22, 0.05, index * 0.11))
    else if (level === 4) {
      playTone(680, 0.16, 0.05)
      playTone(1020, 0.22, 0.045, 0.07)
      playTone(1360, 0.3, 0.04, 0.15)
    } else if (level === 3) [620, 780, 930].forEach((tone, index) => playTone(tone, 0.2, 0.045, index * 0.05))
    else if (level === 2) {
      playTone(700, 0.14, 0.042)
      playTone(940, 0.18, 0.038, 0.06)
    }
  }

  function playChainSound(chain) {
    if (chain >= 2) playTone(560 + Math.min(chain, 12) * 45, 0.13, 0.04)
  }

  // 断链 must be FELT (08 §4.4): a chain nobody can see is not a stake. Grey flash on
  // the pill plus a descending tone, on the way down only.
  function playChainBreakSound(chain) {
    const base = 420 + Math.min(chain, 8) * 20
    playTone(base, 0.2, 0.045)
    playTone(base * 0.74, 0.24, 0.04, 0.08)
    playTone(base * 0.52, 0.3, 0.034, 0.17)
  }

  function playHaptic(pattern = 15) {
    if (getHapticsOn() && navigator.vibrate) navigator.vibrate(pattern)
  }

  // L5 ceremony (08 §6): the only time-dilation in the game, ≤400ms at 0.6×, and it
  // only scales the animation clock. Input never reads it, so a gesture during the
  // dip is handled exactly as usual — the rule is "不得阻断输入".
  let slowMo = null

  function triggerSlowMo(level) {
    const config = FEEDBACK_STYLE.levels[level]?.slowMo
    if (config) slowMo = { scale: config.scale, until: performance.now() + config.ms }
  }

  // The frame loop's two per-frame steps, in the order the old inline pair ran.
  function update(delta) {
    particleRenderer.update(delta)
    updateTransientEffects(delta)
  }

  // The L5 ceremony (08 section 6) is the only time dilation in the game: 400ms or less, and it
  // scales the ANIMATION clock only. Input never reads it, so a gesture during the dip is
  // handled exactly as usual - the rule is that input must never be blocked (03 section 7).
  function timestep(rawDelta) {
    if (slowMo && performance.now() > slowMo.until) slowMo = null
    return slowMo ? rawDelta * slowMo.scale : rawDelta
  }

  // Read-only projection for the headless checks. The plan's P5 acceptance asks for two things
  // that cannot be asserted from outside without one — "no stale particles after a restart" and
  // "the sound switch really silences it" — and the particle systems are otherwise invisible:
  // they are not board meshes, so no mesh count can prove they were released. Nothing in the game
  // reads this.
  //
  // `trackedSystems` is the DISPOSE list, not a live count: three.quarks destroys a finished
  // system itself (autoDestroy), but main keeps the reference until the next restart disposes it
  // in bulk. That is the pre-existing behaviour and it is why this field does NOT fall back to
  // zero on its own, while `transients` — the beams and stars main steps by hand — does.
  function report() {
    return {
      trackedSystems: particleSystems.size,
      transients: transientEffects.length,
      shake: Number(cameraShake.toFixed(4)),
      slowMo: slowMo !== null,
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
    triggerShake,
    triggerSlowMo,
    clearTransientEffects,
    resetShake,
    clearSlowMo,
    // audio
    playTone,
    playHaptic,
    playPlaceSound,
    playHonorSound,
    playChainSound,
    playChainBreakSound,
  }
}

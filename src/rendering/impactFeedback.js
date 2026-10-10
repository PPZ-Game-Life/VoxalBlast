// Impact feedback v2 — the placement-driven layer (PLACEMENT_IMPACT_FEEDBACK_HANDOFF.md §5, §8).
//
// What this module is for, in one sentence: the v1 clear confirmed a line with a thin band and a
// handful of chips, and the new round's whole subject is the OPPOSITE — 「让玩家看见这一手落在这里，
// 因此光从这里传出去」. So this layer draws three things and nothing else:
//
//   * a WIDE SWEEP per branch, starting at the placement's own origin and running to each end at
//     32 cell/s, with its art chosen by how far that branch has travelled;
//   * an ENDPOINT BURST when a branch arrives, and a real 3D cube flight behind it;
//   * (the placement pulse and the secondary chips stay with the v1 layer in effects.js, which is
//     where the shipped atlas already lives.)
//
// Three architectural facts the rest of the file follows from:
//
//  1. SURFACE vs SPACE. The sweep and the bursts are drawn on the cube's surface, so they live in
//     a group whose matrix is the cube's own world matrix, refreshed once per frame — turning the
//     cube carries them with it. The cubes FLY, so they live in world space like the v1 chips and
//     are deliberately not re-rotated when the player turns the board (§8.3).
//  2. THE TAIL IS CLIPPED, THE HEAD IS GLUED. A branch's visible span is its own travelled
//     interval, so the quad's four vertices are rebuilt each frame from that interval and the uv's
//     are scaled to match. That is what keeps a 1.4-cell soft tail from being parked on both sides
//     of the origin before the branch has moved; it is geometry work — no shader, no clipping
//     planes, no renderer-wide flag — and the stock `MeshBasicMaterial` keeps the pack's sRGB
//     straight-alpha contract (§8.1).
//  3. ONE MATERIAL PER ROLE, UVs IN THE GEOMETRY. Every sweep shares one material and every burst
//     another; the frame index lives in the quad's uv, so 120 face-rays cannot become 120 materials
//     (§8.3's draw-call ceiling).
import * as THREE from 'three'
import { faceLattice } from '../game/board.js'
import { IMPACT_FEEDBACK } from './config.js'
import { createImpactAssets } from './impactAssets.js'
import { faceUv } from './cartoonClearPlan.js'

export const SEVERITY_ORDER = Object.freeze(['single', 'double', 'threePlus'])

export function severityOf(physicalLineCount) {
  const count = Math.max(0, Math.trunc(physicalLineCount) || 0)
  if (count <= 0) return null
  if (count === 1) return 'single'
  if (count === 2) return 'double'
  return 'threePlus'
}

/** The recipe's own `severity-by-quality-v1` lookup, in the unit it is written in. */
export function budgetFor(recipe, severity, lowPower, key) {
  const table = recipe?.clearBudgets?.perClearEvent?.[key]
  if (!table || !severity) return 0
  const index = SEVERITY_ORDER.indexOf(severity)
  const row = table[lowPower ? 'low' : 'standard']
  return Math.max(0, row?.[index] ?? 0)
}

export function globalCap(recipe, lowPower, key) {
  const table = recipe?.clearBudgets?.globalLiveCaps?.[key]
  if (!table) return 0
  return table[lowPower ? 'low' : 'standard'] ?? 0
}

/** The face-local interval a line's cells occupy, and which of (u, v) the branch travels along. */
export function rayAxis(ray) {
  const [u0, v0] = faceUv(ray.face, ray.cells[0])
  const [u1, v1] = faceUv(ray.face, ray.cells[ray.cells.length - 1])
  const travelIsU = u0 !== u1
  const travelLo = travelIsU ? Math.min(u0, u1) : Math.min(v0, v1)
  const travelHi = travelIsU ? Math.max(u0, u1) : Math.max(v0, v1)
  return {
    travelIsU,
    travelLo,
    travelHi,
    perp: travelIsU ? v0 : u0,
    // The line's own index space starts here, so `originT` (a 0..n-1 index) becomes a face-local
    // coordinate by adding this — never by assuming the line starts at the face's edge.
    travelFirst: travelIsU ? u0 : v0,
    faceU: (s, perp) => (travelIsU ? [s, perp] : [perp, s]),
  }
}

export function createImpactFeedback({
  scene,
  cubeGroup,
  cellPitch = 1,
  cellToWorld,
  cubeVector,
  quality,
  // §6.4 of the v1 handoff, kept: reduced motion is its own axis and it closes the moving parts.
  prefersReducedMotion = () => false,
  surfaceOffset = 0.62,
}) {
  const assets = createImpactAssets()
  const recipe = () => assets.recipe()

  // Two groups, two spaces (§8.2). `surfaceGroup` follows the cube; `worldGroup` does not. Neither
  // is the particle renderer, and neither is the cube group itself — §8.2 forbids re-parenting the
  // existing world-space particle group under the cube.
  const surfaceGroup = new THREE.Group()
  const worldGroup = new THREE.Group()
  for (const group of [surfaceGroup, worldGroup]) {
    group.layers.set(IMPACT_FEEDBACK.fxLayer)
    scene.add(group)
  }

  const sweepMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: IMPACT_FEEDBACK.sweepOpacity,
    blending: THREE.NormalBlending, depthTest: true, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  })
  const burstMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: IMPACT_FEEDBACK.endpointPopOpacity,
    blending: THREE.NormalBlending, depthTest: true, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  })

  const state = {
    scopeEpoch: 0,
    events: [],
    seq: 0,
    lastEvent: null,
    droppedByEvents: 0,
    droppedByCap: 0,
    spawned: { sweeps: 0, bursts: 0, cubes: 0 },
    nanGuards: 0,
    warmUp: 0,
    virtualMs: null,
  }

  // §9.1 「居中落子：两端同速、对称到达；靠端落子：近端先到」 — the arrival times, the frame index
  // and the tail clip are all questions about a 148ms window that a software rasteriser renders
  // five frames of. `devStep()` therefore freezes the clock at a value the caller chooses and runs
  // ONE real frame, so the browser check grades the shipped geometry rather than the frame rate.
  // It is DEV-only and it changes nothing about how the effect runs in play.
  const clock = () => (state.virtualMs === null ? performance.now() : state.virtualMs)

  const pools = { sweeps: [], bursts: [] }
  const cubes = []
  const cubeMeshes = new Map()

  // ---------------------------------------------------------------- surface quads
  function makeQuad(kind, material) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(4 * 2), 2))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.layers.set(IMPACT_FEEDBACK.fxLayer)
    mesh.visible = false
    surfaceGroup.add(mesh)
    return {
      kind, mesh, geometry,
      position: geometry.getAttribute('position'),
      uv: geometry.getAttribute('uv'),
      alive: false,
    }
  }

  function initPool(kind, count) {
    const key = kind === 'sweep' ? 'sweeps' : 'bursts'
    const material = kind === 'sweep' ? sweepMaterial : burstMaterial
    while (pools[key].length < count) pools[key].push(makeQuad(kind, material))
  }

  // The pools are sized ONCE, at construction, to the largest event the recipe can ask for (§5.2:
  // 120 face-rays per event, capped here by the decorative ceiling a real clear can reach). An
  // invisible mesh costs no draw call, and preallocating is what keeps the renderer's geometry
  // count FLAT across a hundred clears instead of growing on every new worst case — §8.3's
  // 「共享资源不逐轮增长」 read as a number rather than as a promise.
  initPool('sweep', 16)
  initPool('burst', 8)

  function acquire(kind) {
    const key = kind === 'sweep' ? 'sweeps' : 'bursts'
    return pools[key].find((entry) => !entry.alive) || null
  }

  function release(instance) {
    instance.alive = false
    instance.mesh.visible = false
  }

  /**
   * Write one face-local rectangle into a quad. The two in-plane coordinates are `(s, perp)`:
   * `s` runs along the branch, `perp` is the line's own fixed coordinate. The 3D corners come from
   * board.js's own `faceLattice` evaluated at FRACTIONAL coordinates — the lattice transform is
   * affine, so a fractional input is exactly the point the doc asks for (§4.3 「由同一晶格/棋盘变换
   * 对连续originT求出」), and re-using the rules' own table means this layer cannot disagree with
   * where the game thinks a cell is.
   */
  function writeQuad(instance, face, sLo, sHi, perpLo, perpHi, uvAtS, uvV) {
    const axis = instance.axis || null
    const normal = cubeVector(face, 'n')
    const cornersS = [sLo, sHi, sHi, sLo]
    const cornersP = [perpLo, perpLo, perpHi, perpHi]
    for (let index = 0; index < 4; index += 1) {
      const [u, v] = axis.travelIsU ? [cornersS[index], cornersP[index]] : [cornersP[index], cornersS[index]]
      const cell = faceLattice(face, u, v)
      const point = cellToWorld(cell[0], cell[1], cell[2])
      point.addScaledVector(normal, surfaceOffset)
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
        state.nanGuards += 1
        release(instance)
        return false
      }
      instance.position.setXYZ(index, point.x, point.y, point.z)
      instance.uv.setXY(index, uvAtS(cornersS[index]), index < 2 ? uvV[0] : uvV[1])
    }
    instance.position.needsUpdate = true
    instance.uv.needsUpdate = true
    instance.mesh.visible = true
    return true
  }

  // ---------------------------------------------------------------- cubes
  function ensureCubeMesh(id) {
    if (cubeMeshes.has(id)) return cubeMeshes.get(id)
    const source = assets.cube(id)
    if (!source) return null
    const capacity = Math.max(4, globalCap(recipe(), Boolean(quality.lowPower), 'cubes'))
    const mesh = new THREE.InstancedMesh(source.geometry, source.material, capacity)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.layers.set(IMPACT_FEEDBACK.fxLayer)
    worldGroup.add(mesh)
    cubeMeshes.set(id, mesh)
    return mesh
  }

  function latticeDirWorld(cell, dir) {
    const from = cellToWorld(cell[0], cell[1], cell[2])
    const to = cellToWorld(cell[0] + dir[0], cell[1] + dir[1], cell[2] + dir[2])
    return to.sub(from).normalize().applyQuaternion(cubeGroup.quaternion)
  }

  function worldCell(cell) {
    return cellToWorld(cell[0], cell[1], cell[2]).applyMatrix4(cubeGroup.matrixWorld)
  }

  function spawnCube(endpoint, variant, context) {
    if (!assets.cube(variant) || !ensureCubeMesh(variant)) return null
    const normal = cubeVector(endpoint.face, 'n').applyQuaternion(cubeGroup.quaternion).normalize()
    const outward = latticeDirWorld(endpoint.cell, endpoint.outward)
    const origin = worldCell(endpoint.cell).addScaledVector(normal, surfaceOffset)
    const recipeNow = recipe()
    const edgeCells = recipeNow?.cube?.visibleEdgeCells?.[1] ?? 0.52
    cubes.push({
      variant,
      position: origin,
      velocity: outward.multiplyScalar(2.6 * cellPitch).addScaledVector(normal, 1.2 * cellPitch),
      axis: new THREE.Vector3(0.4, 1, 0.22).normalize(),
      spin: 5.5,
      // §5.1 「可见边约0.36–0.52格」: the model's own unit bounding box is scaled to a CELL size,
      // taken from the middle of the permitted band rather than its ceiling, so the flight does
      // not read as a second board.
      scale: cellPitch * edgeCells * 0.85,
      bornAt: context.startedAt + endpoint.arrivalMs,
      lifeMs: Math.max(180, context.clearEndMs - endpoint.arrivalMs),
      until: Infinity,
      epoch: state.scopeEpoch,
    })
    const cube = cubes[cubes.length - 1]
    state.spawned.cubes += 1
    return cube
  }

  // ---------------------------------------------------------------- the event
  /**
   * §5.2 「按physicalLineCount分配，而非level/raw face数」. One normal clear = one event here, with the
   * recipe's own per-event totals; a third overlapping event retires the OLDEST tail — the same rule
   * the v1 layer already enforces, and it never touches the score, the sound or the note.
   */
  function spawn({ eventKey, plan, propagation, now = clock() }) {
    if (assets.status() !== 'ready') return null
    const severity = severityOf(plan.physicalLineCount)
    if (!severity) return null
    const lowPower = Boolean(quality.lowPower)
    const recipeNow = recipe()
    state.seq += 1
    const maxEvents = recipeNow?.clearBudgets?.maxClearEvents ?? 2
    retireBeyond(maxEvents, now)

    const reduced = prefersReducedMotion()
    const context = {
      key: eventKey,
      startedAt: now,
      clearEndMs: severity === 'single'
        ? (recipeNow?.cube?.clearEndMs?.single ?? 420)
        : (recipeNow?.cube?.clearEndMs?.multi ?? 480),
      epoch: state.scopeEpoch,
    }
    const record = {
      key: eventKey,
      severity,
      startedAt: now,
      until: now + context.clearEndMs + 60,
      physicalLineCount: plan.physicalLineCount,
      faceRays: propagation.faceRays.length,
      endpoints: propagation.endpoints.length,
      sweeps: 0,
      bursts: 0,
      cubes: 0,
      reducedMotion: reduced,
      epoch: state.scopeEpoch,
      sweepInstances: [],
      burstInstances: [],
      cubeRefs: [],
      slots: { endpointPops: 0, cubes: 0 },
    }

    // §5.2 reduced-motion: no flight, no moving sweep, no camera shake. The v1 outline and the
    // chips keep their own (already gated) behaviour, and this layer simply stands down.
    if (reduced) {
      state.events.push(record)
      state.lastEvent = summarize(record)
      return state.lastEvent
    }

    const sweepSequence = assets.sequence('sweep')
    const burstSequence = assets.sequence('endpointPop')
    const rayBudget = Math.min(
      propagation.faceRays.length,
      recipeNow?.clearBudgets?.faceRays?.maxPerEvent ?? 120,
    )
    initPool('sweep', Math.max(4, Math.min(16, rayBudget)))
    initPool('burst', Math.max(2, Math.min(8, propagation.endpoints.length)))
    for (const ray of propagation.faceRays.slice(0, rayBudget)) {
      const instance = sweepSequence ? acquire('sweep') : null
      if (!instance) { state.droppedByCap += 1; continue }
      instance.alive = true
      instance.ray = ray
      instance.axis = rayAxis(ray)
      instance.metrics = sweepSequence.metrics
      instance.startedAt = context.startedAt + (recipeNow?.sweep?.startMs ?? 35)
      instance.arrivalMs = ray.arrivalMs
      instance.travelled = 0
      instance.frameIndex = -1
      instance.epoch = state.scopeEpoch
      record.sweepInstances.push(instance)
      record.sweeps += 1
      state.spawned.sweeps += 1
    }

    const popBudget = Math.min(
      budgetFor(recipeNow, severity, lowPower, 'endpointPops'),
      propagation.endpoints.length,
    )
    propagation.endpoints.forEach((endpoint, index) => {
      if (index >= popBudget || !burstSequence) return
      const instance = acquire('burst')
      if (!instance) { state.droppedByCap += 1; return }
      instance.alive = true
      instance.endpoint = endpoint
      instance.axis = rayAxis({ face: endpoint.face, cells: [endpoint.cell, endpoint.cell] })
      instance.metrics = burstSequence.metrics
      instance.startedAt = context.startedAt + endpoint.arrivalMs
      instance.frameIndex = -1
      instance.epoch = state.scopeEpoch
      record.burstInstances.push(instance)
      record.bursts += 1
      record.slots.endpointPops += 1
      state.spawned.bursts += 1
    })

    // §5.2 「先做物理端点去重，再稳定轮转分配，尽量覆盖不同物理线」: the cubes round-robin over the
    // DEDUPED endpoints, so two cubes at one end are two real instances rather than one scaled up.
    const cubeBudget = budgetFor(recipeNow, severity, lowPower, 'cubes')
    const variants = (lowPower ? IMPACT_FEEDBACK.lowPowerCubeIds : IMPACT_FEEDBACK.cubes.map((entry) => entry.id))
      .filter((id) => assets.cube(id))
    let slot = 0
    for (let index = 0; index < cubeBudget && propagation.endpoints.length; index += 1) {
      const endpoint = propagation.endpoints[index % propagation.endpoints.length]
      const variant = variants[slot % Math.max(1, variants.length)]
      slot += 1
      const cube = spawnCube(endpoint, variant, context)
      if (!cube) { state.droppedByCap += 1; continue }
      record.cubeRefs.push(cube)
      record.cubes += 1
      record.slots.cubes += 1
    }

    state.events.push(record)
    if (state.events.length > 8) state.events = state.events.slice(-8)
    state.lastEvent = summarize(record)
    return state.lastEvent
  }

  function summarize(record) {
    const { sweepInstances, burstInstances, cubeRefs, ...rest } = record
    return rest
  }

  function retireBeyond(maxEvents, now) {
    const live = state.events.filter((event) => event.until > now)
    while (live.length >= maxEvents) {
      const oldest = live.shift()
      if (!oldest) break
      state.droppedByEvents += 1
      oldest.until = now
      for (const instance of oldest.sweepInstances) release(instance)
      for (const instance of oldest.burstInstances) release(instance)
      for (const cube of oldest.cubeRefs) cube.until = now
    }
  }

  // ---------------------------------------------------------------- per frame
  function updateSweeps(now) {
    const recipeNow = recipe()
    const speed = recipeNow?.sweep?.speedCellsPerSecond ?? 32
    const tipCells = sweepTipCells()
    for (const instance of pools.sweeps) {
      if (!instance.alive) continue
      const ray = instance.ray
      const elapsed = now - instance.startedAt
      if (elapsed < 0) continue
      const metrics = instance.metrics
      const travelled = Math.min(ray.distanceCells, (elapsed / 1000) * speed)
      const progress = ray.distanceCells > 1e-6 ? Math.min(1, travelled / ray.distanceCells) : 1
      instance.travelled = travelled
      const arrived = travelled >= ray.distanceCells - 1e-9
      if (arrived && elapsed >= instance.arrivalMs - (recipeNow?.sweep?.startMs ?? 35) + 24) {
        release(instance)
        continue
      }
      // §5.1 「sweep序列帧由该分支的travelProgress选帧；不得给所有长短分支固定205ms动画」.
      instance.frameIndex = Math.min(metrics.frames.length - 1, Math.floor(progress * metrics.frames.length))

      const frameWidthCells = metrics.frameWorldWidth / cellPitch
      const pivotFromLeft = metrics.pivotOffsetX / cellPitch + frameWidthCells / 2
      const frameHeightCells = metrics.frameWorldHeight / cellPitch
      const dir = ray.direction
      const axis = instance.axis
      const originS = axis.travelFirst + ray.originT
      const head = originS + dir * travelled
      const left = dir > 0 ? head - pivotFromLeft : head - (frameWidthCells - pivotFromLeft)
      const right = left + frameWidthCells
      // §5.1: the visible span is the travelled interval only. Nothing may appear behind the
      // origin, the face's own outer boundary still clips, and the head may lead by the art's tip.
      const clipLo = dir > 0 ? originS : head - tipCells
      const clipHi = dir > 0 ? head + tipCells : originS
      const lo = Math.max(left, clipLo, axis.travelLo - 0.5)
      const hi = Math.min(right, clipHi, axis.travelHi + 0.5)
      if (!(hi > lo)) { instance.mesh.visible = false; continue }
      instance.lastLo = lo
      instance.lastHi = hi
      const rect = metrics.frameUv(instance.frameIndex)
      const uvAtS = (s) => {
        const local = dir > 0 ? (s - left) / frameWidthCells : (right - s) / frameWidthCells
        const clamped = Math.min(1, Math.max(0, local))
        return rect.u0 + (rect.u1 - rect.u0) * clamped
      }
      writeQuad(
        instance, ray.face, lo, hi,
        axis.perp - frameHeightCells / 2, axis.perp + frameHeightCells / 2,
        uvAtS, [rect.v0, rect.v1],
      )
    }
  }

  function sweepTipCells() {
    const sequence = assets.sequence('sweep')
    if (!sequence) return 0
    const px = sequence.meta.placement?.maxLeadingExtentFromAnchorPx ?? 3
    const cellsPerPx = (sequence.metrics.frameWorldWidth / cellPitch) / sequence.metrics.frameWidth
    return px * cellsPerPx
  }

  function updateBursts(now) {
    for (const instance of pools.bursts) {
      if (!instance.alive) continue
      const elapsed = now - instance.startedAt
      if (elapsed < 0) continue
      const metrics = instance.metrics
      const total = metrics.totalDurationMs || metrics.declaredTotalDurationMs || 140
      if (elapsed >= total) { release(instance); continue }
      // §5.1 「读取正式一次性序列，不循环」: the frame advances on its own authored duration and the
      // quad's box never changes — the expansion is IN the art, not in a per-frame scale (§5.1
      // forbids compensating from `contentAlphaBoundsMeasuredOnly`).
      let index = metrics.frames.length - 1
      let acc = 0
      for (let frame = 0; frame < metrics.frames.length; frame += 1) {
        acc += metrics.frames[frame].durationMs || 0
        if (elapsed < acc) { index = frame; break }
      }
      const rect = metrics.frameUv(index)
      const axis = instance.axis
      const half = (metrics.frameWorldWidth / cellPitch) / 2
      const halfV = (metrics.frameWorldHeight / cellPitch) / 2
      const centre = axis.travelFirst
      instance.frameIndex = index
      // A burst is a SQUARE in the face plane centred on the endpoint: the surface carries it, so
      // it never turns to face the camera on its own (§8.2 「不靠depthTest=false把背面光穿出来」).
      writeQuad(
        instance, instance.endpoint.face,
        centre - half, centre + half,
        axis.perp - halfV, axis.perp + halfV,
        (value) => rect.u0 + (rect.u1 - rect.u0) * Math.min(1, Math.max(0, (value - (centre - half)) / (half * 2))),
        [rect.v0, rect.v1],
      )
    }
  }

  const tmpMatrix = new THREE.Matrix4()
  const tmpQuat = new THREE.Quaternion()
  const tmpScale = new THREE.Vector3()
  const farAway = new THREE.Vector3(0, -1e4, 0)

  /**
   * §8.1 「不阻塞落子」, measured rather than promised: the FIRST clear in a session was compiling
   * three programs and uploading a texture mid-event, which the probe caught as a 179ms stall
   * between two animation frames — the whole sweep is over in 148ms, so that hitch IS the effect
   * failing to appear. The fix is to draw one throwaway quad of each role and one instance of each
   * cube variant FAR OUTSIDE the board for one frame, right after the pack loads: the programs
   * compile there, nothing is visible, and the first real clear costs nothing extra. The geometry
   * is the pool's own first quad, so `frustumCulled = false` keeps the draw in the batch and no
   * extra resource is created.
   */
  function warmUpShaders() {
    if (state.warmUp <= 0) return
    for (const key of ['sweeps', 'bursts']) {
      const instance = pools[key][0]
      if (!instance || instance.alive) continue
      for (let index = 0; index < 4; index += 1) {
        instance.position.setXYZ(index, farAway.x, farAway.y, farAway.z)
        instance.uv.setXY(index, index === 0 || index === 3 ? 0 : 1, index < 2 ? 0 : 1)
      }
      instance.position.needsUpdate = true
      instance.uv.needsUpdate = true
      instance.mesh.visible = true
    }
    const variants = quality.lowPower ? IMPACT_FEEDBACK.lowPowerCubeIds : IMPACT_FEEDBACK.cubes.map((entry) => entry.id)
    for (const id of variants) {
      const mesh = ensureCubeMesh(id)
      if (!mesh) continue
      tmpMatrix.makeTranslation(farAway.x, farAway.y, farAway.z)
      mesh.setMatrixAt(0, tmpMatrix)
      mesh.count = 1
      mesh.instanceMatrix.needsUpdate = true
    }
    state.warmUp -= 1
    if (state.warmUp === 0) {
      for (const key of ['sweeps', 'bursts']) {
        const instance = pools[key][0]
        if (instance && !instance.alive) instance.mesh.visible = false
      }
    }
  }

  function updateCubes(now, delta) {
    const byVariant = new Map()
    for (let index = cubes.length - 1; index >= 0; index -= 1) {
      const cube = cubes[index]
      const age = now - cube.bornAt
      const end = Math.min(cube.bornAt + cube.lifeMs, cube.until)
      if (age < 0) continue
      if (now >= end) { cubes.splice(index, 1); continue }
      cube.velocity.y -= 5.5 * cellPitch * delta
      cube.position.addScaledVector(cube.velocity, delta)
      const age01 = Math.min(1, age / Math.max(1, cube.lifeMs))
      const hold = recipe()?.cube?.holdScaleUntilNormalizedAge ?? 0.45
      // §5.1 「前45%寿命保持体积，再收缩退场」 — a hold then a shrink. The scale is stated in LOCAL
      // units and never corrected from the projected bounding box, which is what would produce the
      // 「不自然的体积呼吸」 the doc names.
      const shrink = age01 <= hold ? 1 : Math.max(0, 1 - (age01 - hold) / (1 - hold))
      tmpQuat.setFromAxisAngle(cube.axis, cube.spin * (age / 1000))
      tmpScale.setScalar(cube.scale * (0.55 + 0.45 * shrink))
      tmpMatrix.compose(cube.position, tmpQuat, tmpScale)
      if (!byVariant.has(cube.variant)) byVariant.set(cube.variant, [])
      byVariant.get(cube.variant).push(tmpMatrix.clone())
    }
    for (const [variant, matrices] of byVariant) {
      const mesh = ensureCubeMesh(variant)
      if (!mesh) continue
      const count = Math.min(matrices.length, mesh.instanceMatrix.count)
      for (let index = 0; index < count; index += 1) mesh.setMatrixAt(index, matrices[index])
      mesh.count = count
      mesh.instanceMatrix.needsUpdate = true
    }
    for (const [variant, mesh] of cubeMeshes) {
      if (!byVariant.has(variant)) { mesh.count = 0; mesh.instanceMatrix.needsUpdate = true }
    }
  }

  function update(delta) {
    const now = clock()
    // One matrix read per frame, and the surface group IS the cube's own frame — including the
    // board's breathing float, so the sweep rides the board exactly like the v1 bands did.
    cubeGroup.updateMatrixWorld()
    surfaceGroup.matrix.copy(cubeGroup.matrixWorld)
    surfaceGroup.matrixWorldNeedsUpdate = true
    surfaceGroup.matrixAutoUpdate = false
    updateSweeps(now)
    updateBursts(now)
    updateCubes(now, delta)
    warmUpShaders()
  }

  /** §7.1's scope cancel, the same contract the v1 clear already has: late callbacks go stale. */
  function cancelScope() {
    state.scopeEpoch += 1
    for (const instance of pools.sweeps) release(instance)
    for (const instance of pools.bursts) release(instance)
    cubes.length = 0
    for (const mesh of cubeMeshes.values()) { mesh.count = 0; mesh.instanceMatrix.needsUpdate = true }
    for (const event of state.events) event.until = -1
  }

  function setVisible(on) {
    const visible = Boolean(on)
    surfaceGroup.visible = visible
    worldGroup.visible = visible
    return { surface: surfaceGroup.visible, world: worldGroup.visible }
  }

  function liveCounts() {
    const now = clock()
    let sweeps = 0
    let bursts = 0
    for (const instance of pools.sweeps) if (instance.alive && instance.mesh.visible) sweeps += 1
    for (const instance of pools.bursts) if (instance.alive && instance.mesh.visible) bursts += 1
    let cubesLive = 0
    for (const cube of cubes) if (now >= cube.bornAt && now < cube.bornAt + cube.lifeMs) cubesLive += 1
    return { sweeps, bursts, cubes: cubesLive }
  }

  function assetReport() {
    const sequences = {}
    for (const [key, entry] of Object.entries(assets.reports().sequences)) {
      sequences[key] = {
        id: entry.metrics.id,
        sheet: [entry.metrics.sheetWidth, entry.metrics.sheetHeight],
        layout: [entry.metrics.columns, entry.metrics.rows],
        frameSize: [entry.metrics.frameWidth, entry.metrics.frameHeight],
        unionAlphaBounds: entry.meta.normalization.unionAlphaBounds,
        unionIsReference: entry.metrics.unionIsReference,
        pivotWorldOffset: [entry.metrics.pivotOffsetX, entry.metrics.pivotOffsetY],
        frameWorld: [entry.metrics.frameWorldWidth, entry.metrics.frameWorldHeight],
        visibleWorld: [entry.metrics.visibleWidthWorld, entry.metrics.visibleHeightWorld],
        frames: entry.metrics.frames.map((frame) => ({
          index: frame.index,
          durationMs: frame.durationMs,
          interval: frame.interval,
          measuredBounds: frame.measuredBounds,
        })),
        totalDurationMs: entry.metrics.totalDurationMs,
        declaredTotalDurationMs: entry.metrics.declaredTotalDurationMs,
        reducedFrameIndex: entry.metrics.reducedFrameIndex,
        mirrorForNegativeDirection: entry.meta.placement?.mirrorForNegativeDirection ?? null,
        rotateAroundHeadAnchor: entry.meta.placement?.rotateAroundHeadAnchor ?? null,
      }
    }
    const cubesReport = {}
    for (const [id, cube] of Object.entries(assets.reports().cubes)) {
      const mesh = cubeMeshes.get(id)
      cubesReport[id] = {
        node: cube.node,
        primitives: cube.primitives,
        hasVertexColors: cube.hasVertexColors,
        hasNormals: cube.hasNormals,
        vertexCount: cube.vertexCount,
        indexCount: cube.indexCount,
        localEdge: cube.localEdge,
        localBox: [cube.box.min.toArray(), cube.box.max.toArray()],
        edgeWorld: (cellPitch * (recipe()?.cube?.visibleEdgeCells?.[1] ?? 0.52)) * 0.85,
        instances: mesh ? mesh.count : 0,
        sharedGeometry: Boolean(mesh && mesh.geometry === cube.geometry),
        sharedMaterial: Boolean(mesh && mesh.material === cube.material),
        materialised: Boolean(mesh),
      }
    }
    return {
      status: assets.status(),
      error: assets.error(),
      failures: assets.reports().failures,
      recipeLoaded: Boolean(assets.recipe()),
      sequences,
      cubes: cubesReport,
    }
  }

  return {
    load: () => assets.load().then((status) => {
      if (status !== 'ready') return status
      // The two shared materials take their maps HERE, not at construction: until the pack has
      // really loaded there is no texture to point at, and a `MeshBasicMaterial` with no map draws
      // a solid white quad — measured, and exactly the kind of "the counters say it spawned" failure
      // the screenshots caught (a white square where the burst should be).
      const sweepSequence = assets.sequence('sweep')
      if (sweepSequence) {
        sweepMaterial.map = sweepSequence.texture
        sweepMaterial.needsUpdate = true
      }
      const burstSequence = assets.sequence('endpointPop')
      if (burstSequence) {
        burstMaterial.map = burstSequence.texture
        burstMaterial.needsUpdate = true
      }
      // The shader warm-up waits for the pack, because until it is ready there is nothing to
      // compile and the layer draws nothing at all.
      state.warmUp = 2
      return status
    }),
    ready: () => assets.status() === 'ready',
    status: () => assets.status(),
    error: () => assets.error(),
    recipe,
    spawn,
    update,
    /**
     * DEV ONLY (§9.1's recomputable rows). Freeze the clock at `tMs` and run ONE real frame of the
     * shipped update path, so a browser check can step 0→200ms in 2ms increments and grade the
     * arrival times, the frame index and the tail clip exactly — instead of describing how many
     * frames a software rasteriser happened to draw inside a 148ms window. `tMs = null` restores
     * the wall clock; nothing in the gameplay path ever calls this.
     */
    devStep: (tMs, delta = 1 / 60) => {
      state.virtualMs = Number.isFinite(tMs) ? tMs : null
      update(delta)
      return state.virtualMs === null ? null : state.virtualMs
    },
    cancelScope,
    setVisible,
    report: () => ({
      status: assets.status(),
      error: assets.error(),
      scopeEpoch: state.scopeEpoch,
      liveEvents: state.events.filter((event) => event.until > clock()).length,
      live: liveCounts(),
      caps: {
        cubes: globalCap(recipe(), Boolean(quality.lowPower), 'cubes'),
        endpointPops: globalCap(recipe(), Boolean(quality.lowPower), 'endpointPops'),
        secondarySprites: globalCap(recipe(), Boolean(quality.lowPower), 'secondarySprites'),
        // §5.2's per-event table, in the recipe's own shape, so a check can grade an allocation
        // against the numbers the RUNNING layer read instead of a retyped copy of them.
        perEvent: recipe()?.clearBudgets?.perClearEvent ?? null,
        severityOrder: recipe()?.clearBudgets?.severityOrder ?? SEVERITY_ORDER,
        maxClearEvents: recipe()?.clearBudgets?.maxClearEvents ?? 2,
        faceRaysPerEvent: recipe()?.clearBudgets?.faceRays?.maxPerEvent ?? 120,
      },
      records: { meshes: cubeMeshes.size },
      spawned: { ...state.spawned },
      droppedByCap: state.droppedByCap,
      droppedByEvents: state.droppedByEvents,
      nanGuards: state.nanGuards,
      lastEvent: state.lastEvent,
      // §9.1/§9.2: the live geometry a probe has to grade — where each branch is, which frame it
      // is on and what interval it is currently clipped to. Counters alone cannot tell a sweep
      // that started at the placement from one that started at the line's centre.
      liveSweeps: pools.sweeps.filter((instance) => instance.alive).map((instance) => ({
        face: instance.ray.face,
        direction: instance.ray.direction,
        originT: instance.ray.originT,
        originS: instance.axis.travelFirst + instance.ray.originT,
        distanceCells: instance.ray.distanceCells,
        arrivalMs: instance.ray.arrivalMs,
        travelled: Number(instance.travelled.toFixed(4)),
        frameIndex: instance.frameIndex,
        interval: [Number((instance.lastLo ?? NaN).toFixed(4)), Number((instance.lastHi ?? NaN).toFixed(4))],
        travelIsU: instance.axis.travelIsU,
        perp: instance.axis.perp,
        visible: instance.mesh.visible,
      })),
      liveBursts: pools.bursts.filter((instance) => instance.alive).map((instance) => ({
        face: instance.endpoint.face,
        frameIndex: instance.frameIndex,
        arrivalMs: instance.endpoint.arrivalMs,
        visible: instance.mesh.visible,
      })),
      assets: assetReport(),
    }),
  }
}

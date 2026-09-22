// Board view — the cube's coordinate system, its pose model, the 98 tiles and the opening wave.
//
// Refactor P3a-P3d (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §2 `boardView.js`).
//
// P3a — the coordinate half, because that half has a job of its own: the plan calls out
// "cubeVector 与局部/世界坐标转换 | boardView | 统一给 input/pieceView 用，**禁止复制公式**".
// Every consumer that needs to turn a face cell into a place on screen — the landing preview,
// the drag ghost's face basis, the item overlay, the rocket's line picker, the intro's
// per-tile placement and the `placement()` read-out — goes through these functions, and none
// of them may grow its own copy. `pieceView` (P4) and `gameInput` (P7) are the next two
// callers, which is exactly why this moved before them.
//
// P3b — the POSE MODEL, moved as ONE unit: the plan forbids pulling it apart ("姿态变量和操作
// 函数一起迁移，不逐个拆散 cubeBase/cubeQuat/cubeLive/cubeSnapAnim"). It owns the logical grid
// pose, the quaternion actually rendered, the player's bearing, the live gesture, the settle
// animation, and every function that reads or writes them. Input still lives in main; it
// drives the pose through these functions and never writes a quaternion itself.
//
// P3c — the 98 TILES: `gridGroup` plus the material each tile wears. The Board in main stays
// the only writeable source of truth; sync(cells) takes a snapshot of the painted cells and
// repaints from it, and `tileFrontFace` remembers which face was painted for so the frame
// loop can skip 98 material assignments. The group is ATTACHED by main through attachTiles(),
// at the point it always was: cubeGroup's child order is load-bearing.
//
// P3d — the OPENING CREATION WAVE: the blocks' transforms, the one wave material each tile
// reuses, the schedule sorted against the live camera, the single rAF clock and the pause
// lock it raises. It reads and never writes the game, which is what lets `intro()` in the
// read-only hook prove the board is byte-identical after a wave. Intro is ONE instance:
// armIntro() settles whatever is in flight before it starts another.
//
// Binding rule, and the reason ~150 call sites are untouched: `cubeBase` / `cubeQuat` /
// `cubeSnapAnim` are const objects mutated in place, so main destructures them into the names
// it has always used. The two `let`s cannot be handed out that way, so they are exposed as
// getBearing()/setBearing(yaw, pitch) and getLive()/setLive(live), and only the few sites that
// actually reassign them were rewritten.
//
// `metrics` and `getCubeGroup` are LAZY getters for the same reason as in gameScene.js: the
// pitch and half-side are the BOARD's arithmetic and stay in main's constants (the plan
// forbids a second copy of the lattice mapping here), while the group is assembled — and owns
// its own pose — in main. `getBlocks` is lazy for the same reason again: the resource factory
// is built after this one. `camera`, `getAppliedCanvasSize`, `isPaused` and `onIntroLock` are
// plain parameters -- the front face is read against the real camera, the wave re-sorts itself
// once against the applied canvas size, and the pause lock goes OUT through the injected
// callback instead of this module reaching into main's pause calculation. Dropping a
// half-finished pointer gesture when the pose resets stays input's business (the gesture
// record lives in main until gameInput, P7).
import * as THREE from 'three'
import { FACES, SH, faceLattice } from '../game/board.js'
import { normalizeCells } from '../game/shapes.js'
import { INTRO_STYLE, ROTATE_STYLE as rotateStyle } from './config.js'

export function createBoardView({
  metrics,
  getCubeGroup,
  camera,
  getBlocks,
  // The wave re-sorts itself once against the applied canvas size (P3d), the lock it raises
  // goes out through onIntroLock, and isPaused is read back for the report only.
  getAppliedCanvasSize,
  onIntroLock,
  isPaused,
  onRotationReset,
}) {
  // Per-face placement plane in cube-local space. n = outward face normal,
  // u/v = the in-plane axes matching the board's face->lattice mapping.
  const FACE_PLANE = {
    '+x': { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    '-x': { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    '+y': { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    '-y': { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    '+z': { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    '-z': { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
  }

  // A fresh Vector3 per call, deliberately: callers hand the result straight to
  // `applyQuaternion` / `multiplyScalar` / `addScaledVector` and would corrupt a shared one.
  function cubeVector(face, axis) {
    const b = FACE_PLANE[face]
    if (axis === 'n') return new THREE.Vector3(...b.n)
    if (axis === 'u') return new THREE.Vector3(...b.u)
    return new THREE.Vector3(...b.v)
  }

  // World-space lattice cell -> 3D position (cells are flush on the shell).
  function cellToWorld(x, y, z) {
    const { cs, half } = metrics()
    return new THREE.Vector3(
      x * cs - half + cs / 2,
      y * cs - half + cs / 2,
      z * cs - half + cs / 2,
    )
  }

  // Cube-local position of a face cell (from its lattice coordinate).
  function cellLocal(face, u, v) {
    const [x, y, z] = faceLattice(face, u, v)
    return cellToWorld(x, y, z)
  }

  // Center of a face's placement plane (the outer shell surface), cube-local.
  function facePlaneLocalCenter(face) {
    return cubeVector(face, 'n').multiplyScalar(metrics().half)
  }

  // The same cell in WORLD space, which is what the projected/screen-space consumers need.
  // It has to read the group through the getter every call: the cube rotates, and a cached
  // matrix would freeze the landing marker to the pose it was first drawn at.
  function cellWorld(face, u, v) {
    return cellLocal(face, u, v).applyMatrix4(getCubeGroup().matrixWorld)
  }

  // ---- Cube pose model (v0.8.8: logical pose + a player-tunable bearing) -------
  // The three gesture axes are FIXED to the screen/world and never follow the
  // cube: yaw is always world Y, pitch always world X, roll always world Z. Each
  // gesture is applied to whatever pose the cube currently has, i.e. "settle
  // first, then turn the cube about the axis the finger drove".
  //
  // v0.2.25/26 stored three Euler components (pitch/yaw/roll) and wrote one of
  // them per gesture. That made a gesture's REAL axis depend on the other two
  // angles: once the cube was yawed 90°, Rz·Ry·Rx turned a vertical swipe into a
  // spin about world Z (an in-plane roll) instead of the screen-horizontal flip,
  // which reads exactly as "the X/Y axes rotated along with the cube".
  //
  // The pose is two things with one owner each:
  //
  //   cubeBase   the LOGICAL pose — a product of whole 90° steps about world axes,
  //              so it is always face-aligned and can never drift.
  //   bearing    how far off the face the player has dialled the view, in SCREEN
  //              space (world Y rotation then world X rotation), plus the live
  //              gesture's own rotation while a finger is down.
  //
  //   rendered = Rx(bearingPitch) ∘ Ry(bearingYaw) ∘ cubeBase
  //            = Rx(bearingPitch) ∘ Ry(bearingYaw) ∘ R_axis(live) ∘ cubeBase
  //
  // Only the logical half is ever read back by gameplay: face detection, the step
  // decision and the saved pose all use cubeBase, and a new gesture always starts
  // from cubeBase with the bearing outside it, so the bearing can never accumulate
  // into the geometry.
  //
  // THE BEARING IS THE PLAYER'S, NOT A CONSTANT (v0.8.8). Until v0.8.7 it was a
  // fixed tilt that every gesture settled back onto, so every turn ended on exactly
  // the same angle no matter how the player had dragged — reported as "每次转完，
  // 都是到达同一个角度". Now a release that does NOT commit a face keeps whatever
  // offset the drag left behind, and that offset is remembered across face turns:
  // the cube returns to the bearing the player dialled, on the new face. See
  // planAxisRelease() for the band that separates "fine-tune" from "next face".
  const ROT_STEP = Math.PI / 2
  const AXIS_OF = {
    yaw: new THREE.Vector3(0, 1, 0),
    pitch: new THREE.Vector3(1, 0, 0),
    roll: new THREE.Vector3(0, 0, 1),
  }
  const cubeBase = new THREE.Quaternion() // face-aligned grid pose (the logical pose)
  const cubeQuat = new THREE.Quaternion() // pose actually rendered
  // The player's view bearing. Starts at the shipped default and is dialled by
  // sub-threshold drags; `roll` has no bearing (Z is the straighten gesture, and a
  // residual spin would show up as a skewed grid).
  let bearingYaw = rotateStyle.bearingYaw
  let bearingPitch = rotateStyle.bearingPitch
  let cubeLive = null // the gesture in flight, see beginAxisGesture()
  const cubeSnapAnim = {
    active: false,
    from: new THREE.Quaternion(),
    to: new THREE.Quaternion(),
    t: 0,
    duration: rotateStyle.snapDuration,
  }
  const scratchQuat = new THREE.Quaternion()
  const scratchLogical = new THREE.Quaternion()
  // v0.2.30 dropped the pitch pole limit (and its `pitchReach` bookkeeping). It was
  // the fixed-axis restatement of v0.2.25's Euler "clamp pitch to ±90°", but in the
  // quaternion model there is nothing to protect: pitching past a pole is an
  // ordinary quarter turn that brings the back face round, exactly like yaw. What
  // the limit DID do was refuse a step after the drag had already rendered it — the
  // player turned the cube a full face with their finger and watched the release
  // undo all of it (probe: drag 105.5° -> bounce 89.5°, and every repeat in that
  // direction stayed dead). No axis can now be entered into a dead direction.

  // Quarter turn about one FIXED world axis. `steps` is in 90° units.
  function stepQuaternion(axis, steps) {
    return new THREE.Quaternion().setFromAxisAngle(AXIS_OF[axis], steps * ROT_STEP)
  }

  // How the bearing is composed, and the one ordering rule that matters:
  // PITCH FIRST, YAW LAST, i.e. `Rx(bearingPitch) · Ry(bearingYaw)`.
  //
  // A rotation about world Y cannot move the world-Y direction, and the world-Y
  // direction IS the cube's vertical edge; composing in this order therefore leaves
  // the cube plumb for EVERY bearing, which is what lets the player dial an angle
  // at all without the board starting to lean. The reverse order does not: v0.8.6
  // wrote `Ry(yaw) · Rx(pitch)` with a 17.5°/15.5° tilt and leaned the whole board
  // −4.8° on screen, reported as "视觉上还比较歪". Keep this order.
  const bearingScratch = new THREE.Quaternion()
  function bearingQuat(yaw, pitch, out = scratchLogical) {
    return out.copy(scratchQuat.setFromAxisAngle(AXIS_OF.pitch, pitch))
      .multiply(bearingScratch.setFromAxisAngle(AXIS_OF.yaw, yaw))
      .normalize()
  }

  function applyCubeRotation() {
    const cubeGroup = getCubeGroup()
    cubeGroup.quaternion.copy(cubeQuat)
    cubeGroup.updateMatrixWorld(true)
  }

  // Start a gesture on one axis. The live rotation starts at 0, so the pose at
  // pointerdown is exactly the resting pose and the first moved pixel is already
  // part of the gesture's own delta — the bearing never becomes the next gesture's
  // starting angle.
  function beginAxisGesture(axis) {
    cubeLive = { axis, angle: 0, rendered: 0, base: cubeBase.clone(), yaw: bearingYaw, pitch: bearingPitch }
    setLiveAngle(0)
  }

  // Pose while the finger is down. A yaw or pitch drag moves THE BEARING itself
  // rather than composing a second rotation on top of it, which is what makes the
  // release continuous: the pose at the moment of release is already the pose the
  // fine-tune keeps, so a nudge that does not commit a face simply stays where the
  // finger left it (no spring-back, no second animation).
  function setLiveAngle(angle) {
    const clamped = THREE.MathUtils.clamp(angle, -ROT_STEP, ROT_STEP)
    cubeLive.angle = clamped
    cubeLive.rendered = clamped
    let yaw = cubeLive.yaw
    let pitch = cubeLive.pitch
    if (cubeLive.axis === 'yaw') yaw += clamped
    else if (cubeLive.axis === 'pitch') pitch += clamped
    bearingQuat(yaw, pitch)
    if (cubeLive.axis === 'roll') {
      // The spin is the one gesture that is NOT a bearing: it turns the cube on the
      // face and springs back to the exact grid, because a residual in-plane spin is
      // exactly the "残余小角度" the layout must not have.
      scratchQuat.setFromAxisAngle(AXIS_OF.roll, clamped).premultiply(scratchLogical)
      cubeQuat.copy(scratchQuat).multiply(cubeLive.base).normalize()
    } else {
      cubeQuat.copy(scratchLogical).multiply(cubeLive.base).normalize()
    }
    applyCubeRotation()
  }

  // What a release commits. `bearing` is where the gesture's axis would end up if the
  // offset were kept; a fine-tune is kept only while it stays inside the band, so
  // "more than about a third of a face off the face" is the same decision for a drag
  // and for a bearing the player has already dialled. Past it the gesture turns exactly
  // ONE face in the drag direction (never "the nearest face"), the offset is dropped,
  // and the bearing the player dialled is restored — i.e. the cube turns to the tuned
  // bearing on the next face.
  //
  // The kept value is then clamped into `ROTATE_STYLE.bearingBand[axis]`, which is
  // ASYMMETRIC and much tighter on the frontal side. That clamp is what stops a player
  // from dialling the cube into a flat plate — measured 100% main / 0% / 0% at
  // yaw +25°/pitch −25° — and, worse, having it STICK there, because a bearing is
  // remembered across face turns and saved with the run. Hitting the clamp just means
  // the cube stops turning further in that direction; there is nothing else it may
  // safely do (§KNOWN_GAPS).
  //
  // `roll` never keeps an offset at all, so it always steps or springs back on the grid.
  function planAxisRelease(axis, startBearing, angle) {
    if (axis === 'roll') {
      const stepped = Math.abs(angle) >= rotateStyle.stepThreshold ? Math.sign(angle) : 0
      return { fineTune: false, stepped, bearing: startBearing }
    }
    const live = startBearing + angle
    if (Math.abs(live) <= rotateStyle.stepThreshold) {
      const band = rotateStyle.bearingBand[axis]
      return { fineTune: true, stepped: 0, bearing: THREE.MathUtils.clamp(live, band.min, band.max) }
    }
    return { fineTune: false, stepped: Math.sign(angle), bearing: startBearing }
  }

  function easeOutCubic(p) {
    return 1 - (1 - p) ** 3
  }

  function startCubeSnap(gesture) {
    const startBearing = gesture.axis === 'pitch' ? gesture.pitch : gesture.yaw
    const plan = planAxisRelease(gesture.axis, startBearing, gesture.angle)
    cubeSnapAnim.from.copy(cubeQuat)
    if (plan.stepped !== 0) {
      cubeBase.copy(gesture.base).premultiply(stepQuaternion(gesture.axis, plan.stepped)).normalize()
    } else if (gesture.axis === 'yaw') bearingYaw = plan.bearing
    else if (gesture.axis === 'pitch') bearingPitch = plan.bearing
    cubeSnapAnim.to.copy(bearingQuat(bearingYaw, bearingPitch)).multiply(cubeBase).normalize()
    cubeSnapAnim.active = true
    cubeSnapAnim.t = 0
    cubeSnapAnim.duration = rotateStyle.snapDuration
    cubeLive = null
    if (plan.fineTune) {
      // Nothing to animate: the pose the finger left is the pose that is kept. Land
      // it bit-exactly rather than running a zero-distance settle.
      cubeQuat.copy(cubeSnapAnim.to)
      cubeSnapAnim.active = false
      applyCubeRotation()
      return
    }
    updateCubeSnap(0) // render frame 0 now, so the first frame after release does not jump
  }

  // A new gesture must start from a stable pose: settle any running animation
  // instantly, otherwise the drag would be writing over an animation in flight.
  function settleCubeSnap() {
    if (!cubeSnapAnim.active) return
    cubeSnapAnim.active = false
    cubeQuat.copy(cubeSnapAnim.to)
    applyCubeRotation()
  }

  // Return to the face-aligned start pose and the shipped bearing (Reset Game).
  function resetCubeRotation() {
    cubeSnapAnim.active = false
    cubeLive = null
    // A reset can land in the middle of a gesture; drop it so the pointerup that
    // may never come cannot leave rotation permanently blocked. The gesture record is
    // main's pointer state (gameInput, P7), so the drop is asked for by callback.
    onRotationReset?.()
    cubeBase.identity()
    bearingYaw = rotateStyle.bearingYaw
    bearingPitch = rotateStyle.bearingPitch
    cubeQuat.copy(bearingQuat(bearingYaw, bearingPitch))
    applyCubeRotation()
  }

  // Settle animation: a slerp from where the finger left the pose to the target
  // pose, on the bearing the release decided. easeOutCubic, no overshoot — a spring
  // past the face and a second wobble after it were both explicitly rejected. The
  // target is reached bit-exactly, so every committed turn lands on the 90° grid.
  function updateCubeSnap(delta) {
    if (!cubeSnapAnim.active) return
    cubeSnapAnim.t += delta
    const p = THREE.MathUtils.clamp(cubeSnapAnim.t / cubeSnapAnim.duration, 0, 1)
    cubeQuat.copy(cubeSnapAnim.from).slerp(cubeSnapAnim.to, easeOutCubic(p)).normalize()
    applyCubeRotation()
    if (p >= 1) {
      cubeQuat.copy(cubeSnapAnim.to)
      cubeSnapAnim.active = false
      applyCubeRotation()
    }
  }

  // ---- Candidate orientation on the front face (v0.2.28) ----------------------
  // Front face = the one whose outward normal (rotated into world) points most
  // toward the camera. Read off the RENDERED pose, which is what the raycast and
  // the player's eye both use; the presentation tilt is far under 45°, so it can
  // never change which face wins.
  const frontProbe = new THREE.Vector3()
  const toCameraProbe = new THREE.Vector3()
  function frontFaceOf(quat) {
    const cubeGroup = getCubeGroup()
    const toCamera = toCameraProbe.copy(camera.position).sub(cubeGroup.position).normalize()
    let best = '+z'
    let bestDot = -Infinity
    for (const face of FACES) {
      frontProbe.set(...FACE_PLANE[face].n).applyQuaternion(quat)
      const dot = frontProbe.dot(toCamera)
      if (dot > bestDot) { bestDot = dot; best = face }
    }
    return best
  }
  function findFrontFace() {
    return frontFaceOf(getCubeGroup().quaternion)
  }

  // Shape data and the flat slot both use a top-left origin: piece +u points
  // screen-right and piece +v points screen-down. A face's own (u, v) lattice axes
  // turn WITH the cube, so placing raw cells would spin or flip the piece whenever
  // the cube turns. Re-express both source axes in the front face's current
  // screen-right / screen-down basis so the drop preserves the exact silhouette
  // shown in the slot, including asymmetric L/J/S/Z pieces.
  const screenRightLocal = new THREE.Vector3()
  const screenDownLocal = new THREE.Vector3()
  const cubeInverseQuat = new THREE.Quaternion()

  function updateScreenAxesLocal() {
    const cubeGroup = getCubeGroup()
    camera.updateMatrixWorld()
    cubeGroup.updateMatrixWorld()
    // The placement preview lives in the cube's local frame, so express the
    // camera's right/down directions there. Camera matrix column 1 is screen-up.
    cubeInverseQuat.copy(cubeGroup.quaternion).invert()
    screenRightLocal.setFromMatrixColumn(camera.matrixWorld, 0).applyQuaternion(cubeInverseQuat)
    screenDownLocal.setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(-1).applyQuaternion(cubeInverseQuat)
  }

  // The front face's residual tilt is far under 45°, so each projected screen
  // direction resolves to exactly one signed lattice axis. Mapping source +u and
  // +v independently is intentional: the face lattice conventions do not all
  // share the slot's top-left handedness, while the on-screen silhouette must.
  function faceOrientedCells(face, cells) {
    updateScreenAxesLocal()
    const normal = cubeVector(face, 'n')
    const right = screenRightLocal.clone().addScaledVector(normal, -screenRightLocal.dot(normal)).normalize()
    const down = screenDownLocal.clone().addScaledVector(normal, -screenDownLocal.dot(normal)).normalize()
    const uAxis = cubeVector(face, 'u')
    const vAxis = cubeVector(face, 'v')
    const uRight = uAxis.dot(right)
    const vRight = vAxis.dot(right)
    const across = Math.abs(uRight) >= Math.abs(vRight)
      ? { u: uRight >= 0 ? 1 : -1, v: 0 }
      : { u: 0, v: vRight >= 0 ? 1 : -1 }
    const along = across.u !== 0
      ? { u: 0, v: vAxis.dot(down) >= 0 ? 1 : -1 }
      : { u: uAxis.dot(down) >= 0 ? 1 : -1, v: 0 }
    return normalizeCells(cells.map(([u, v]) => [
      u * across.u + v * along.u,
      u * across.v + v * along.v,
    ]))
  }

  // ---- The 98 tiles and the material they wear (P3c) --------------------------
  // Moved from main.js. `gridGroup` is created here but ATTACHED by main through
  // attachTiles(), at the exact point it always was: cubeGroup's child order is
  // load-bearing (cubeBody carries renderOrder -2 and the preview groups come after it).
  // Six 5×5 faces share their edge/corner cells: 98 unique blocks on the board,
  // and every one of them is the SAME cube at the same gap from its neighbours, so
  // no block can ever look taller, thicker or larger than any other. Placing a piece
  // paints one of them; it does not add, grow, lift or move anything.
  const gridGroup = new THREE.Group()
  // The wood and paint material family — one material per (state x tone step), plus a cache
  // of paint per colour — and the deterministic per-cell tone hash both live in
  // rendering/blockResources.js, reached through `blocks` above.

  function buildFaceTiles() {
    const cells = new Map()
    FACES.forEach((face) => {
      const group = new THREE.Group()
      group.userData.face = face
      for (let u = 0; u < SH; u += 1) {
        for (let v = 0; v < SH; v += 1) {
          const cell = faceLattice(face, u, v)
          const key = cell.join(',')
          if (cells.has(key)) {
            cells.get(key).userData.faces.push(face)
            continue
          }
          const tone = getBlocks().toneIndexFor(...cell)
          const mesh = new THREE.Mesh(getBlocks().blockGeometry, getBlocks().blockWoodMaterials[tone].idle)
          // A block is a cube centred in its cell: no orientation needed, and its
          // outer face lands flush with the big cube's surface.
          mesh.position.copy(cellLocal(face, u, v))
          mesh.castShadow = true
          mesh.receiveShadow = true
          mesh.userData.cell = cell
          mesh.userData.faces = [face]
          mesh.userData.tone = tone
          cells.set(key, mesh)
          group.add(mesh)
        }
      }
      gridGroup.add(group)
    })
  }

  // ============================================================
  // Board rendering
  // ============================================================
  // cellWorld (same cell in world space) is boardView's, destructured above.

  // Occupancy is paint, not geometry. Each unique lattice cell keeps one mesh and
  // one material; its adjacent faces share that same solid corner block.
  let occupiedColors = new Map()
  let tileFrontFace = null

  // The single place that decides which material a tile wears. The per-frame front
  // face pass and the board render both go through here, so the two can never
  // disagree about what colour a cell is.
  function applyTileMaterials() {
    const front = findFrontFace()
    tileFrontFace = front
    gridGroup.children.forEach((group) => {
      group.children.forEach((tile) => {
        const active = tile.userData.faces.includes(front)
        const color = occupiedColors.get(tile.userData.cell.join(','))
        if (color !== undefined) tile.material = getBlocks().paintMaterial(color, tile.userData.tone)
        else tile.material = getBlocks().blockWoodMaterials[tile.userData.tone][active ? 'active' : 'idle']
      })
    })
  }

  // Attach the lattice to the cube and build it. Kept as one call so main keeps the timing
  // it always had -- nothing between the old add and the old build touched the group.
  function attachTiles() {
    getCubeGroup().add(gridGroup)
    buildFaceTiles()
  }

  // The board's own single source of truth hands over the painted cells and the tiles are
  // repainted from them. main's renderBoard() still calls updateHud() right after this, in
  // the same order it always did.
  function sync(cells) {
    occupiedColors = new Map(cells.map((cell) => [`${cell.x},${cell.y},${cell.z}`, cell.color]))
    applyTileMaterials()
  }

  // Which face the tiles were last painted for. The frame loop re-applies the materials only
  // when the front face has actually changed, so it needs to read this back.
  function getTileFrontFace() { return tileFrontFace }

  // ============================================================
  // Opening creation wave (v0.8.21, 03 §「进入单局」)
  // ============================================================
  // The board is ASSEMBLED, not revealed: one wavefront crosses the cube along the
  // screen diagonal (bottom-left → top-right) and the 98 surface blocks are built as
  // it passes, so the six faces are written by a single continuous sweep instead of
  // six planes lighting up in turn.
  //
  // Three rules this block obeys, and they are the whole reason it is written the way
  // it is:
  //   1. IT READS, IT NEVER WRITES. The wave's only view of the game is `occupiedColors`
  //      — the same Map the tiles are painted from — the tiles' own authored transforms,
  //      and the camera. No second board, no per-block write to game state, and
  //      `intro()` in the read-only hook proves the board is byte-identical afterwards.
  //   2. IT OWNS NOTHING WHEN IT IS DONE. Blocks are put back on their authored
  //      transform and handed the SHARED material instance they came in with; the
  //      per-block clones are reused by the next wave, never leaked into the board.
  //   3. IT IS THE ONLY CLOCK. No timers, no tweens: `updateIntro(delta)` is driven by
  //      the same rAF loop that draws the game, so a cancelled or backgrounded wave
  //      cannot leave anything running behind it.
  //
  // Input is locked while it plays, and the lock is the game's own single switch:
  // onIntroLock() reads introPlaying(), so every existing gate (drag, view drag, items,
  // keyboard, candidate selection) is closed by the one flag and released by it too.
  let intro = null
  // How many waves have been armed since the page loaded. Read-only bookkeeping for the
  // checks: "a refresh plays exactly one wave" cannot be asserted from the wave's own
  // state once it has finished (which, on a boot-time wave, it usually has by the time a
  // probe can look).
  let introPlays = 0

  function introPlaying() { return intro !== null }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  }

  // Deterministic 0..1 from a lattice cell: the same block always scatters the same
  // way, so two runs of the same opening can be compared frame for frame. Deliberately
  // not Math.random() — this is the same reason the timber tones are hashed, not drawn.
  function cellScatter([x, y, z]) {
    const hash = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791)
    return ((hash >>> 0) % 997) / 997
  }

  // The wave needs one material per block (opacity, and the painted blocks' shine, are
  // per-block) while the board itself shares one material per colour × tone step. So
  // each tile keeps ONE clone for its whole lifetime, created once and re-filled by
  // copy() on every wave — the maps and the physical parameters come over by
  // reference, so a wave costs no GPU upload and no per-run allocation.
  function introMaterialFor(tile) {
    if (!tile.userData.introMaterial) {
      tile.userData.introMaterial = new THREE.MeshPhysicalMaterial()
      tile.userData.introMaterial.needsUpdate = true
    }
    return tile.userData.introMaterial
  }

  function buildIntroEntries(reduced) {
    const entries = []
    gridGroup.children.flatMap((group) => group.children).forEach((tile) => {
      const material = introMaterialFor(tile)
      material.copy(tile.material)
      // Stage 1 wears the primer: the block's own surface maps stay (they are neutral
      // pen-stroke luminance/bump maps, so the colour is what reads), but colour and the
      // physical response are pulled to one coat so the primed cube looks like ONE object
      // rather than like the finished board with the colours switched off.
      const primerColor = INTRO_STYLE.primer.colors[primerBandFor(tile.userData.cell)]
      material.color.set(primerColor)
      material.roughness = INTRO_STYLE.primer.roughness
      material.clearcoat = INTRO_STYLE.primer.clearcoat
      material.bumpScale = INTRO_STYLE.primer.bumpScale
      material.transparent = true
      material.opacity = 0
      material.emissive.set(INTRO_STYLE.paint.shineColor)
      material.emissiveIntensity = 0
      const home = tile.position.clone()
      // A block starts inside its own cell and travels out along the direction its face
      // points. For the 12 edge and 8 corner cells — shared by two or three faces — that
      // direction is the sum of those normals, i.e. the cube-local radial, which is the
      // one direction that is the same whichever face you ask.
      const inward = home.clone().normalize().negate()
      const entry = {
        tile,
        material,
        home,
        inward,
        start: home.clone().addScaledVector(inward, INTRO_STYLE.build.inset),
        base: tile.material,
        primerColor: new THREE.Color(primerColor),
        // Where stage 2 has to land: the colour the board itself is wearing. Read off the
        // material the tile came in with, so the last frame of the wave IS the board —
        // nothing is recomputed from the shape pool, and a resumed run's colours are
        // whatever the save says they are.
        finalColor: tile.material.color.clone(),
        painted: occupiedColors.has(tile.userData.cell.join(',')),
        buildDelay: 0,
        paintDelay: 0,
        key: 0,
      }
      entries.push(entry)
      tile.material = material
      // prefers-reduced-motion gets a whole-board FADE: the blocks stay exactly where
      // they are and only their opacity moves, so there is no per-block motion to
      // reduce and nothing for a shadow to slide under.
      if (!reduced) {
        tile.scale.setScalar(INTRO_STYLE.build.scaleFrom)
        tile.position.copy(entry.start)
      }
    })
    return entries
  }

  // Which primer value a block wears: its height on the cube. The shell's own top and
  // bottom rows are the ends of the family, the middle row is the middle value — a
  // stratified coat that reads the same from every camera angle, which a screen-space
  // pattern would not (the cube can be turned before the wave runs).
  function primerBandFor([, y]) {
    const colors = INTRO_STYLE.primer.colors.length
    if (colors < 2) return 0
    return Math.round((y / Math.max(1, SH - 1)) * (colors - 1))
  }

  // Delays are fixed once, on the first frame the board is actually on screen — that
  // is when the camera and the cube pose the player will see are the ones in play.
  // Everything after this is arithmetic.
  function scheduleIntroWave() {
    camera.updateMatrixWorld()
    getCubeGroup().updateMatrixWorld(true)
    const probe = new THREE.Vector3()
    let min = Infinity
    let max = -Infinity
    intro.entries.forEach((entry) => {
      // Screen-space diagonal: NDC has +x right and +y up, so (x + y) runs exactly
      // bottom-left → top-right. The depth term keeps the far side of the cube a
      // fraction of a beat behind the near side instead of interleaving with it, which
      // is what makes the front travel across the VISIBLE faces in one pass.
      probe.copy(entry.home).applyMatrix4(getCubeGroup().matrixWorld).project(camera)
      entry.key = probe.x + probe.y + INTRO_STYLE.build.depthBias * probe.z
      min = Math.min(min, entry.key)
      max = Math.max(max, entry.key)
    })
    const span = Math.max(max - min, 1e-6)
    const build = INTRO_STYLE.build
    const paint = INTRO_STYLE.paint
    const bands = Math.max(1, build.bandCount)
    intro.entries.forEach((entry) => {
      const band = Math.round(((entry.key - min) / span) * (bands - 1))
      const scatter = (cellScatter(entry.tile.userData.cell) - 0.5) * build.jitter
      entry.buildDelay = band * build.bandStagger + scatter
      // Stage 2 runs the SAME order, one lap later, so the second pass reads as the same
      // wave coming round again rather than as a second, unrelated animation.
      entry.paintDelay = band * paint.bandStagger + scatter
        + (entry.painted ? paint.occupiedDelay : 0)
    })
    intro.buildWindow = (bands - 1) * build.bandStagger + build.duration
    intro.paintStart = intro.buildWindow + INTRO_STYLE.hold
    intro.total = intro.paintStart + (bands - 1) * paint.bandStagger + paint.duration
      + paint.occupiedDelay
    intro.scheduled = true
    intro.scheduledSize = getAppliedCanvasSize()
    intro.bandCount = bands
  }

  // Arm a wave. Called from every entry point that puts a live run in front of the
  // player; a wave already in flight is settled first, so a restart can never stack two.
  function armIntro() {
    settleIntro()
    if (!INTRO_STYLE.enabled) return false
    // The colours and the front face's lighter timber are settled BEFORE they are
    // copied: the wave clones what the board is honestly wearing, including a resumed
    // run's painted cells.
    applyTileMaterials()
    const reduced = prefersReducedMotion()
    intro = {
      entries: buildIntroEntries(reduced),
      elapsed: 0,
      total: reduced ? INTRO_STYLE.reducedMotionDuration : 0,
      buildWindow: 0,
      paintStart: 0,
      bandCount: INTRO_STYLE.build.bandCount,
      reduced,
      scheduled: reduced,
      scheduledSize: null,
    }
    introPlays += 1
    onIntroLock()
    return true
  }

  // How much of stage 1 a block has finished, 0..1 (1 = it has landed on the cube).
  function introBuildProgress(entry, elapsed) {
    return THREE.MathUtils.clamp((elapsed - entry.buildDelay) / INTRO_STYLE.build.duration, 0, 1)
  }

  // How far a block is through its repaint, 0..1.
  function introPaintProgress(entry, elapsed) {
    if (elapsed <= intro.paintStart) return 0
    return THREE.MathUtils.clamp(
      (elapsed - intro.paintStart - entry.paintDelay) / INTRO_STYLE.paint.duration, 0, 1,
    )
  }

  function updateIntro(delta) {
    if (!intro) return
    if (!intro.scheduled) scheduleIntroWave()
    // The layout settles a frame or two after a boot-time arm (the trays fill, the canvas
    // shrinks, the camera is re-fitted). Re-sorting once, before anything has been built,
    // keeps the diagonal honest; after that the order is fixed and never recomputed.
    else if (intro.elapsed < 0.08 && intro.scheduledSize
      && (getAppliedCanvasSize().width !== intro.scheduledSize.width
        || getAppliedCanvasSize().height !== intro.scheduledSize.height)) {
      scheduleIntroWave()
    }
    intro.elapsed += delta
    const S = INTRO_STYLE
    if (intro.reduced) {
      const a = easeOutCubic(THREE.MathUtils.clamp(intro.elapsed / S.reducedMotionDuration, 0, 1))
      intro.entries.forEach((entry) => {
        // Reduced motion skips the primer entirely: it fades straight into the board.
        entry.material.color.copy(entry.finalColor)
        entry.material.opacity = a
      })
    } else {
      intro.entries.forEach((entry) => {
        // ---- stage 1: build the block and put it in its primer coat ----------------
        const p = introBuildProgress(entry, intro.elapsed)
        if (p <= 0) {
          entry.material.opacity = 0
          entry.material.depthWrite = false
          entry.material.emissiveIntensity = 0
          entry.tile.castShadow = false
          entry.tile.scale.setScalar(S.build.scaleFrom)
          entry.tile.position.copy(entry.start)
          return
        }
        // Arrive early, peak once, settle: `rise` is the build itself, `settle` is what
        // takes the 1.04 peak back to exactly 1. At p = 1 both are 1 and the scale is
        // exactly scaleFrom + (overshoot − scaleFrom) − (overshoot − 1) = 1.
        const rise = easeOutCubic(Math.min(1, p / S.build.overshootAt))
        const fall = p <= S.build.overshootAt ? 0 : easeOutCubic((p - S.build.overshootAt) / (1 - S.build.overshootAt))
        const opacity = easeOutCubic(Math.min(1, p / S.build.fadeAt))
        entry.material.opacity = opacity
        // A block that is still fading must not write depth: an invisible block that
        // does would cut a hole in the hull behind it. Same for its shadow — a shadow
        // of a block that does not exist yet is a bug you can see.
        entry.material.depthWrite = opacity > 0.99
        entry.tile.castShadow = opacity > 0.99
        entry.tile.scale.setScalar(S.build.scaleFrom + (S.build.scaleOvershoot - S.build.scaleFrom) * rise - (S.build.scaleOvershoot - 1) * fall)
        entry.tile.position.copy(entry.home).addScaledVector(entry.inward, S.build.inset * (1 - rise))

        // ---- stage 2: repaint it into the colour the board actually has ------------
        // The repaint runs after the hold, on the same wavefront. Nothing is allocated
        // and no material is swapped: the block lerps from its primer colour to its own
        // final colour, and the surface response follows it back to the board's values.
        const k = introPaintProgress(entry, intro.elapsed)
        if (k <= 0) {
          entry.material.emissiveIntensity = 0
          return
        }
        const step = easeOutCubic(k)
        entry.material.color.lerpColors(entry.primerColor, entry.finalColor, step)
        entry.material.roughness = THREE.MathUtils.lerp(S.primer.roughness, entry.base.roughness, step)
        entry.material.clearcoat = THREE.MathUtils.lerp(S.primer.clearcoat, entry.base.clearcoat, step)
        entry.material.bumpScale = THREE.MathUtils.lerp(S.primer.bumpScale, entry.base.bumpScale, step)
        // The repaint lands with a small tap, and the painted blocks — the ones that tell
        // the player what is already built — get the only brightness lift in the wave.
        entry.tile.scale.setScalar(1 + (S.paint.scalePulse - 1) * Math.sin(Math.PI * k))
        entry.material.emissiveIntensity = entry.painted ? S.paint.shine * Math.sin(Math.PI * k) : 0
      })
    }
    if (intro.elapsed >= intro.total) settleIntro()
  }

  // The end of every wave, and the only place a block is put back. The transform is
  // restored EXPLICITLY from the copy taken at arm time rather than left at whatever
  // the last frame's arithmetic produced, so no block can drift a fraction of a
  // millimetre off the flush surface over a session of restarts.
  function settleIntro() {
    if (!intro) return
    const entries = intro.entries
    intro = null // cleared first: the repaint below must not see a live wave
    entries.forEach((entry) => {
      entry.tile.position.copy(entry.home)
      entry.tile.scale.setScalar(1)
      entry.tile.castShadow = true
      entry.tile.material = entry.base
      entry.material.opacity = 1
      entry.material.depthWrite = true
      entry.material.emissiveIntensity = 0
    })
    // Then let the board's own single source of truth repaint them, so the front
    // face's tone is right even if the wave ended in a different pose.
    applyTileMaterials()
    onIntroLock()
  }

  // v0.8.21 opening wave, read-only. Two halves, because the wave has to be graded on
  // both of them: what it is doing mid-flight (progress + the per-block schedule, so a
  // check can prove the front really runs bottom-left → top-right) and what it left
  // behind (`integrity`, measured against the AUTHORED transform of every block and
  // the shared material it must be wearing — not against whatever the last frame
  // happened to compute).
  function introReport() {
    const tiles = gridGroup.children.flatMap((group) => group.children)
    const integrity = { tiles: tiles.length, scaleOff: 0, positionOff: 0, materialOff: 0, opacityOff: 0, shadowOff: 0, maxScaleErr: 0, maxPositionErr: 0 }
    tiles.forEach((tile) => {
      const scaleErr = Math.abs(tile.scale.x - 1) + Math.abs(tile.scale.y - 1) + Math.abs(tile.scale.z - 1)
      const positionErr = tile.position.distanceTo(cellToWorld(...tile.userData.cell))
      if (scaleErr > 1e-9) integrity.scaleOff += 1
      if (positionErr > 1e-6) integrity.positionOff += 1
      // The tile must NOT still be holding the per-block wave clone.
      if (tile.material === tile.userData.introMaterial) integrity.materialOff += 1
      if (tile.material.opacity !== 1) integrity.opacityOff += 1
      if (!tile.castShadow) integrity.shadowOff += 1
      integrity.maxScaleErr = Math.max(integrity.maxScaleErr, scaleErr)
      integrity.maxPositionErr = Math.max(integrity.maxPositionErr, positionErr)
    })
    if (!intro) {
      return { active: false, plays: introPlays, locked: isPaused(), integrity, blocks: tiles.length, progress: [] }
    }
    camera.updateMatrixWorld()
    getCubeGroup().updateMatrixWorld(true)
    const probe = new THREE.Vector3()
    const primerHex = INTRO_STYLE.primer.colors.map((color) => `#${new THREE.Color(color).getHexString()}`)
    const progress = intro.entries.map((entry) => {
      probe.copy(entry.home).applyMatrix4(getCubeGroup().matrixWorld).project(camera)
      const color = `#${entry.material.color.getHexString()}`
      return {
        cell: entry.tile.userData.cell.join(','),
        faces: entry.tile.userData.faces,
        painted: entry.painted,
        buildDelay: Number(entry.buildDelay.toFixed(4)),
        paintDelay: Number(entry.paintDelay.toFixed(4)),
        opacity: Number(entry.material.opacity.toFixed(4)),
        scale: Number(entry.tile.scale.x.toFixed(4)),
        emissive: Number(entry.material.emissiveIntensity.toFixed(4)),
        color,
        // Stage 1 must never show a game colour, and stage 2 must end on one: these two
        // flags are what the checks grade the two passes on.
        primer: primerHex.includes(color),
        final: color === `#${entry.finalColor.getHexString()}`,
        // Where the block's own place on the cube lands on screen, in NDC: the
        // diagonal (x·0.5 + y·0.5 + 0.5) is the wave's own coordinate.
        x: Number(probe.x.toFixed(4)),
        y: Number(probe.y.toFixed(4)),
      }
    })
    const stage = intro.elapsed < intro.buildWindow ? 'build'
      : intro.elapsed < intro.paintStart ? 'hold' : 'paint'
    return {
      active: true,
      plays: introPlays,
      reduced: intro.reduced,
      scheduled: intro.scheduled,
      stage,
      elapsed: Number(intro.elapsed.toFixed(4)),
      buildWindow: Number(intro.buildWindow.toFixed(4)),
      paintStart: Number(intro.paintStart.toFixed(4)),
      total: Number(intro.total.toFixed(4)),
      locked: isPaused(),
      blocks: tiles.length,
      built: progress.filter((entry) => entry.opacity > 0.99).length,
      pending: progress.filter((entry) => entry.opacity <= 0).length,
      primed: progress.filter((entry) => entry.primer).length,
      repainted: progress.filter((entry) => entry.final && !entry.primer).length,
      primerHex,
      config: {
        build: { ...INTRO_STYLE.build },
        primer: { ...INTRO_STYLE.primer, colors: [...INTRO_STYLE.primer.colors] },
        hold: INTRO_STYLE.hold,
        paint: { ...INTRO_STYLE.paint },
        reducedMotionDuration: INTRO_STYLE.reducedMotionDuration,
      },
      integrity,
      progress,
    }
  }

  // ---- Accessors for the two `let`s -------------------------------------------
  // `bearingYaw` / `bearingPitch` and `cubeLive` are REASSIGNED, not mutated in place, so
  // destructuring them would hand main a stale snapshot. These four functions are the only
  // way in from outside. Nothing here is a second store: they read and write the same two
  // bindings the gesture code above uses.
  //
  // getBearing() returns a COPY, so a caller cannot alias (or accidentally write) the
  // module's own state. getLive() deliberately returns the record itself: the keyboard path
  // writes `angle` onto the live gesture without rendering it (see rotateCubeByKey in main),
  // and then hands the very same object back to startCubeSnap().
  function getBearing() {
    return { yaw: bearingYaw, pitch: bearingPitch }
  }
  function setBearing(yaw, pitch) {
    bearingYaw = yaw
    bearingPitch = pitch
  }
  function getLive() {
    return cubeLive
  }
  function setLive(live) {
    cubeLive = live
  }

  return {
    FACE_PLANE,
    cubeVector,
    cellToWorld,
    cellLocal,
    cellWorld,
    facePlaneLocalCenter,
    // The 98 tiles and the material they wear (P3c). `gridGroup` is a const Group mutated in
    // place, so it is handed out directly and binds back to the name main has always used:
    // the frame loop, the two read-only hooks and the home cover's clone all walk it.
    // `buildFaceTiles`, `occupiedColors` and `tileFrontFace` stay private.
    gridGroup,
    attachTiles,
    sync,
    applyTileMaterials,
    getTileFrontFace,
    // The opening creation wave (P3d). Intro is a single instance: armIntro() settles whatever
    // is in flight first, so a restart can never stack two waves over the same tiles.
    introPlaying,
    armIntro,
    settleIntro,
    updateIntro,
    introReport,
    // Pose state. The three const objects are owned here and mutated in place; main binds
    // them back to the names it has always used. The two `let`s go through the accessors.
    ROT_STEP,
    cubeBase,
    cubeQuat,
    cubeSnapAnim,
    getBearing,
    setBearing,
    getLive,
    setLive,
    // Pose commands and queries. `stepQuaternion`, `planAxisRelease`, `frontFaceOf` and
    // `updateScreenAxesLocal` are internals of this model and stay private.
    bearingQuat,
    applyCubeRotation,
    beginAxisGesture,
    setLiveAngle,
    startCubeSnap,
    settleCubeSnap,
    updateCubeSnap,
    resetCubeRotation,
    findFrontFace,
    faceOrientedCells,
  }
}

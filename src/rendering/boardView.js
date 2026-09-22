// Board view — the cube's coordinate system and its pose model, and (in the last slice,
// P3c) the 98 tiles and the opening wave.
//
// Refactor P3a/P3b (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §2 `boardView.js`).
//
// P3a — the coordinate half, because that half has a job of its own: the plan calls out
// "cubeVector 与局部/世界坐标转换 | boardView | 统一给 input/pieceView 用，**禁止复制公式**".
// Every consumer that needs to turn a face cell into a place on screen — the landing preview,
// the drag ghost's face basis, the item overlay, the rocket's line picker, the intro's
// per-tile placement and the `placement()` read-out — goes through these functions, and none
// of them may grow its own copy. `pieceView` (P4) and `gameInput` (P7) are the next two
// callers, which is exactly why this moves before them.
//
// P3b — the POSE MODEL, moved as ONE unit: the plan forbids pulling it apart ("姿态变量和操作
// 函数一起迁移，不逐个拆散 cubeBase/cubeQuat/cubeLive/cubeSnapAnim"). It owns the logical grid
// pose, the quaternion actually rendered, the player's bearing, the live gesture, the settle
// animation, and every function that reads or writes them. Input still lives in main; it
// drives the pose through these functions and never writes a quaternion itself.
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
// its own pose — in main. `camera` and `onRotationReset` are plain parameters: the front face
// is read against the real camera, and dropping a half-finished pointer gesture when the pose
// resets is input's business (the gesture record stays in main until gameInput, P7).
import * as THREE from 'three'
import { FACES, faceLattice } from '../game/board.js'
import { normalizeCells } from '../game/shapes.js'
import { ROTATE_STYLE as rotateStyle } from './config.js'

export function createBoardView({ metrics, getCubeGroup, camera, onRotationReset }) {
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
    // The opening wave (still in main until P3c) eases with this too — one definition,
    // shared, rather than a second copy of the same curve.
    easeOutCubic,
  }
}

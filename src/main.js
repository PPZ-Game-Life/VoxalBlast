import packageInfo from '../package.json'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
} from 'postprocessing'
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
import { Board, SH, FACES, faceLattice } from './game/board.js'
import { SHAPES, normalizeCells, maxOrigin } from './game/shapes.js'
import { createCrazyGamesAdapter } from './platform/crazygames.js'
import { getRenderQuality, OPENING_LAYOUT, RENDER_PALETTE as palette, BOARD_STYLE as style, ROTATE_STYLE as rotateStyle, VFX_CONFIG } from './rendering/config.js'
import { gestureAxisReady, pickGestureAxis, swipeAngle } from './rendering/swipe.js'
import './styles.css'

const board = new Board()
const platform = createCrazyGamesAdapter()
const sceneWrap = document.querySelector('#scene-wrap')
const scoreEl = document.querySelector('#score')
const statusEl = document.querySelector('#status')
const toastEl = document.querySelector('#toast')
const slotsEl = document.querySelector('#piece-slots')
const piecesPanelEl = document.querySelector('.bottom-panel')
const cancelZoneEl = document.querySelector('#cancel-zone')
const itemBarEl = document.querySelector('#item-bar')
const axisPickEl = document.querySelector('#axis-pick')
const gameOverEl = document.querySelector('#game-over')
const finalScoreEl = document.querySelector('#final-score')
const versionEl = document.querySelector('#app-version')
const settingsEl = document.querySelector('#settings-modal')
const settingsButtonEl = document.querySelector('#settings-button')
const soundSettingEl = document.querySelector('#sound-setting')
const hapticsSettingEl = document.querySelector('#haptics-setting')

const soundKey = 'voxalblast-sound'
const hapticsKey = 'voxalblast-haptics'
versionEl.textContent = `v${packageInfo.version}`
let pieces = []
let selectedPiece = null
let drag = null
let viewDrag = null
let isPaused = false
let gameEnded = false
let settingsOpen = false
let soundOn = localStorage.getItem(soundKey) !== 'off'
let hapticsOn = localStorage.getItem(hapticsKey) !== 'off'
let audioContext
let toastTimer
let cameraShake = 0
let transientEffects = []
let suppressPieceClickUntil = 0
const particleSystems = new Set()
const piecePreviews = new Map()

const quality = getRenderQuality()

const scene = new THREE.Scene()
scene.background = null
scene.fog = new THREE.Fog(palette.background, 17, 30)
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
const cameraTarget = new THREE.Vector3(0, 0, 0)
let cameraZoom = 1
const minCameraZoom = 0.7
const maxCameraZoom = 1.7

// ============================================================
// Cube-face geometry
// ============================================================
const cs = 1.0 // cell pitch (lattice unit)
const half = (SH * cs) / 2 // 2.5 — cube half side
const cubeSide = SH * cs // 5
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

const cubeGroup = new THREE.Group()
const cellsGroup = new THREE.Group()
cubeGroup.add(cellsGroup)
scene.add(cubeGroup)

// Floating space board (v0.2.23): the old near-solid cube body is gone. What
// remains is a barely-there deep-navy volume tint that still hints at the
// 5×5×5 space on an empty board, plus a faint space-boundary cage. Placed
// blocks are pushed slightly out of the shell and carry the depth.
const cubeBodyMaterial = new THREE.MeshStandardMaterial({
  color: style.hullColor,
  roughness: style.hullRoughness,
  metalness: 0,
  transparent: true,
  opacity: style.hullOpacity,
  depthWrite: false,
})
const cubeBody = new THREE.Mesh(new RoundedBoxGeometry(cubeSide - 0.08, cubeSide - 0.08, cubeSide - 0.08, 5, 0.16), cubeBodyMaterial)
cubeBody.renderOrder = -2
cubeBody.castShadow = false
cubeBody.receiveShadow = true
cubeGroup.add(cubeBody)
const cubeEdge = new THREE.LineSegments(new THREE.EdgesGeometry(cubeBody.geometry), new THREE.LineBasicMaterial({ color: style.edgeColor, transparent: true, opacity: style.edgeOpacity, depthWrite: false }))
cubeEdge.renderOrder = -1
cubeGroup.add(cubeEdge)

function cubeVector(face, axis) {
  const b = FACE_PLANE[face]
  if (axis === 'n') return new THREE.Vector3(...b.n)
  if (axis === 'u') return new THREE.Vector3(...b.u)
  return new THREE.Vector3(...b.v)
}

// World-space lattice cell -> 3D position (cells are flush on the shell).
function cellToWorld(x, y, z) {
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
  return cubeVector(face, 'n').multiplyScalar(half)
}

// Outward direction from the cube centre for a shell cell (radial: face cells
// push along their face normal, shared edge/corner cells push along the
// diagonal). Placed voxels float this far off the shell.
function shellRaise(x, y, z) {
  const base = cellToWorld(x, y, z)
  return base.normalize().multiplyScalar(style.voxelRaise)
}

// Cube-local position of a rendered voxel (lattice cell raised off the shell).
function placedLocal(x, y, z) {
  return cellToWorld(x, y, z).add(shellRaise(x, y, z))
}

// Build the faint N×N grid overlay on every face.
const gridGroup = new THREE.Group()
cubeGroup.add(gridGroup)
function buildFaceGridLines() {
  const off = half + 0.005
  const halfG = (SH * cs) / 2
  const positions = []
  for (const face of FACES) {
    const b = FACE_PLANE[face]
    for (let i = 0; i <= SH; i += 1) {
      const cu = i * cs - halfG
      positions.push(
        b.u[0] * cu + b.v[0] * -halfG + b.n[0] * off,
        b.u[1] * cu + b.v[1] * -halfG + b.n[1] * off,
        b.u[2] * cu + b.v[2] * -halfG + b.n[2] * off,
        b.u[0] * cu + b.v[0] * halfG + b.n[0] * off,
        b.u[1] * cu + b.v[1] * halfG + b.n[1] * off,
        b.u[2] * cu + b.v[2] * halfG + b.n[2] * off,
      )
    }
    for (let j = 0; j <= SH; j += 1) {
      const cv = j * cs - halfG
      positions.push(
        b.u[0] * -halfG + b.v[0] * cv + b.n[0] * off,
        b.u[1] * -halfG + b.v[1] * cv + b.n[1] * off,
        b.u[2] * -halfG + b.v[2] * cv + b.n[2] * off,
        b.u[0] * halfG + b.v[0] * cv + b.n[0] * off,
        b.u[1] * halfG + b.v[1] * cv + b.n[1] * off,
        b.u[2] * halfG + b.v[2] * cv + b.n[2] * off,
      )
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const mat = new THREE.LineBasicMaterial({ color: style.gridColor, transparent: true, opacity: style.gridOpacity, depthWrite: false })
  gridGroup.add(new THREE.LineSegments(geo, mat))
}
buildFaceGridLines()

// ============================================================
// Camera fit (cube rotates; camera stays put)
// ============================================================
const CAMERA_DIR = new THREE.Vector3(0.3, 0.4, 1.05).normalize()
// Fit bound covers the raised voxels (shell 3.0 + voxelRaise + rounded half).
const CUBE_EXTENT = half + 0.55
const frameCorner = new THREE.Vector3()
const frameRight = new THREE.Vector3()
const frameUp = new THREE.Vector3()
let orbitDistance = 12

function distanceForViewDirection(direction) {
  camera.position.copy(direction)
  camera.lookAt(cameraTarget)
  camera.updateMatrixWorld(true)
  const right = frameRight.setFromMatrixColumn(camera.matrixWorld, 0)
  const up = frameUp.setFromMatrixColumn(camera.matrixWorld, 1)
  const verticalTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
  const horizontalTan = verticalTan * camera.aspect
  const isMobile = sceneWrap.clientWidth < 700
  const safeFactor = isMobile ? style.safeFactorMobile : style.safeFactorDesktop
  const min = -CUBE_EXTENT
  const max = CUBE_EXTENT
  let distance = 0
  for (const x of [min, max]) for (const y of [min, max]) for (const z of [min, max]) {
    const corner = frameCorner.set(x, y, z)
    const depthOffset = corner.dot(direction)
    distance = Math.max(
      distance,
      depthOffset + Math.abs(corner.dot(right)) / (horizontalTan * safeFactor),
      depthOffset + Math.abs(corner.dot(up)) / (verticalTan * safeFactor),
    )
  }
  return distance
}

function refreshCameraProjection() {
  const isMobile = sceneWrap.clientWidth < 700
  camera.fov = isMobile ? 37 : 34
  camera.aspect = Math.max(sceneWrap.clientWidth / Math.max(sceneWrap.clientHeight, 1), 0.5)
  camera.updateProjectionMatrix()
  // Re-centre the cube inside the tall central canvas per platform.
  cameraTarget.y = isMobile ? style.targetYMobile : style.targetYDesktop
  cameraTarget.x = 0
  orbitDistance = distanceForViewDirection(CAMERA_DIR)
  keepCubeInsideCanvas()
  centreCubeHorizontally()
}

function fitCameraToPlaySpace() {
  camera.position.copy(CAMERA_DIR).multiplyScalar(orbitDistance * cameraZoom)
  camera.lookAt(cameraTarget)
}

// The tuned framing sits close to the edge (the cube IS the operation area), and
// how much of the canvas a given `safeFactor` buys depends on the viewport
// aspect. This guard keeps that promise device-independent: if the visible cube
// would leave the canvas, the camera is nudged back until `inset` px of slack
// remain on every side.
function keepCubeInsideCanvas(inset = 6) {
  // `refreshCameraProjection()` runs before the camera is placed, so put it at
  // the freshly solved distance first — measuring from a stale/inside-the-cube
  // camera would project nonsense and run the correction away.
  fitCameraToPlaySpace()
  for (let i = 0; i < 6; i += 1) {
    const bounds = cubeScreenBounds()
    const rect = renderer.domElement.getBoundingClientRect()
    const overflow = Math.max(
      rect.left + inset - bounds.minX,
      bounds.maxX - (rect.right - inset),
      rect.top + inset - bounds.minY,
      bounds.maxY - (rect.bottom - inset),
    )
    if (overflow <= 0) return
    orbitDistance *= 1 + overflow / Math.max(rect.height, 1)
    fitCameraToPlaySpace()
  }
}

// The 3/4 view puts the cube's silhouette a few percent off the canvas centre
// (further off on narrow canvases), which made the two "swipe outside the cube"
// roll bands lopsided (28px vs 50px on mobile). Aim the camera so both bands end
// up equal: measure the silhouette's horizontal offset and shift the look-at
// point by the equivalent world distance, then re-measure.
function centreCubeHorizontally() {
  const rect = renderer.domElement.getBoundingClientRect()
  const centreX = rect.left + rect.width * 0.5
  const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * orbitDistance) / Math.max(rect.height, 1)
  for (let i = 0; i < 3; i += 1) {
    const bounds = cubeScreenBounds()
    const offset = (bounds.minX + bounds.maxX) * 0.5 - centreX
    if (Math.abs(offset) < 1) return
    cameraTarget.x += offset * worldPerPx
    fitCameraToPlaySpace()
  }
}

// Screen-space box of the cube (client pixels). v0.2.25 uses it to split the
// vertical swipe by region: a finger that lands inside the cube's horizontal
// span pitches it (screen X), one that lands outside it rolls it (screen Z).
// CUBE_SOLID_EXTENT is the visible body (outermost voxel centres + the raised
// rounded block), so the region matches the silhouette the player sees.
const CUBE_SOLID_EXTENT = half - cs / 2 + 0.46 + style.voxelRaise
const cubeBoundsProbe = new THREE.Vector3()
function projectCubeBounds(extent) {
  camera.updateMatrixWorld()
  const rect = renderer.domElement.getBoundingClientRect()
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    cubeBoundsProbe.set(sx * extent, sy * extent, sz * extent)
      .applyMatrix4(cubeGroup.matrixWorld)
      .project(camera)
    const x = rect.left + (cubeBoundsProbe.x + 1) * 0.5 * rect.width
    const y = rect.top + (1 - cubeBoundsProbe.y) * 0.5 * rect.height
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return { minX, maxX, minY, maxY }
}
function cubeScreenBounds() {
  return projectCubeBounds(CUBE_SOLID_EXTENT)
}

// Gesture partition: vertical swipes inside the cube's x-span turn it about the
// screen X axis, vertical swipes outside that span spin it about the screen Z
// axis (an in-plane roll). Sampled where the finger lands.
function isHorizontallyOnCube(clientX) {
  const bounds = cubeScreenBounds()
  return clientX >= bounds.minX && clientX <= bounds.maxX
}

// Drag -> angle ruler: the cube's own silhouette on screen, sampled once where the
// gesture claims its axis (the axis rules themselves live in rendering/swipe.js).
// A canvas-relative ruler made the same face step cost 185px of horizontal drag on
// a 1120px-wide desktop canvas but 65px on a phone, which is why "sometimes it
// won't turn" showed up on PC and not on mobile. The floor only guards a
// degenerate projection.
function gestureSpan() {
  const bounds = cubeScreenBounds()
  return {
    x: Math.max(bounds.maxX - bounds.minX, 120),
    y: Math.max(bounds.maxY - bounds.minY, 120),
  }
}

// ============================================================
// Renderer / post / lights
// ============================================================
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioMax))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.02
renderer.setClearColor(0x000000, 0)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
sceneWrap.appendChild(renderer.domElement)

const composer = new EffectComposer(renderer, { multisampling: quality.multisampling })
const renderPass = new RenderPass(scene, camera)
const bloomEffect = new BloomEffect({
  intensity: quality.bloomIntensity,
  luminanceThreshold: VFX_CONFIG.bloom.luminanceThreshold,
  luminanceSmoothing: VFX_CONFIG.bloom.luminanceSmoothing,
  mipmapBlur: true,
  radius: VFX_CONFIG.bloom.radius,
  levels: quality.lowPower ? VFX_CONFIG.bloom.lowPowerLevels : VFX_CONFIG.bloom.levels,
})
const smaaEffect = new SMAAEffect({ preset: quality.lowPower ? SMAAPreset.LOW : SMAAPreset.HIGH })
const effectPass = new EffectPass(camera, bloomEffect, smaaEffect)
composer.addPass(renderPass)
composer.addPass(effectPass)

const hemiLight = new THREE.HemisphereLight(0xf4fbff, 0x1d3264, 2.55)
scene.add(hemiLight)
const keyLight = new THREE.DirectionalLight(0xffffff, 4.6)
keyLight.position.set(5.5, 10, 7)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.camera.left = -8
keyLight.shadow.camera.right = 8
keyLight.shadow.camera.top = 8
keyLight.shadow.camera.bottom = -8
keyLight.shadow.bias = -0.0004
scene.add(keyLight)
const rimLight = new THREE.DirectionalLight(0x72aaff, 1.25)
rimLight.position.set(-8, 4, -6)
scene.add(rimLight)
const fillLight = new THREE.PointLight(0x9de8ff, 10, 15, 2)
fillLight.position.set(0, 5, 2)
scene.add(fillLight)

const previewGroup = new THREE.Group()
const candidateGroup = new THREE.Group()
const fxGroup = new THREE.Group()
// The drag preview and the item-target overlay sit in the cube's local frame so
// they rotate with the cube (cells are positioned in cube-local coordinates).
cubeGroup.add(previewGroup)
scene.add(candidateGroup, fxGroup)

// ---- Cube rotation state (v0.2.28: fixed axes + strict Z settle) ------------
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
// Now the grid pose is a quaternion: cubeBase accumulates whole 90° steps about
// world axes and is therefore ALWAYS face-aligned (it can never drift off the
// grid), while `cubeRest*` hold the small ≤8° presentation tilt that keeps the
// cube from looking like a flat square. The rendered pose is tilt ∘ base.
const ROT_STEP = Math.PI / 2
const AXIS_OF = {
  yaw: new THREE.Vector3(0, 1, 0),
  pitch: new THREE.Vector3(1, 0, 0),
  roll: new THREE.Vector3(0, 0, 1),
}
const cubeBase = new THREE.Quaternion() // face-aligned grid pose
const cubeQuat = new THREE.Quaternion() // pose actually rendered
let cubeRestYaw = 0
let cubeRestPitch = 0
let cubeLive = null // the gesture in flight, see beginAxisGesture()
const cubeSnapAnim = { active: false, from: new THREE.Quaternion(), to: new THREE.Quaternion(), t: 0, duration: rotateStyle.snapDuration }
const scratchQuat = new THREE.Quaternion()
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

// The small resting tilt: world Y first, then world X. Roll never contributes —
// a residual Z spin would show up as a skewed face (see ROTATE_STYLE).
function buildTilt(yaw, pitch) {
  return new THREE.Quaternion()
    .setFromAxisAngle(AXIS_OF.yaw, yaw)
    .multiply(scratchQuat.setFromAxisAngle(AXIS_OF.pitch, pitch))
}

function cubeTilt() {
  return buildTilt(cubeRestYaw, cubeRestPitch)
}

function applyCubeRotation() {
  cubeGroup.quaternion.copy(cubeQuat)
  cubeGroup.updateMatrixWorld(true)
}

// Start a gesture on one axis. The pose must stay continuous, so the tilt the
// cube is currently resting with is folded into the gesture's own starting
// angle (the rest of the tilt stays outside the gesture as a frozen factor):
// at angle === start the pose is bit-identical to the pose before the touch.
function beginAxisGesture(axis) {
  const tilt = cubeTilt()
  let start = 0
  if (axis === 'yaw') {
    start = cubeRestYaw
    tilt.setFromAxisAngle(AXIS_OF.pitch, cubeRestPitch)
  } else if (axis === 'pitch') {
    start = cubeRestPitch
    tilt.setFromAxisAngle(AXIS_OF.yaw, cubeRestYaw)
  }
  cubeLive = { axis, start, angle: start, base: cubeBase.clone(), rest: tilt }
  setLiveAngle(start)
}

// Pose while the finger is down: the live rotation about the FIXED world axis,
// applied on top of the frozen (tilt, base) pair. Because it is the outermost
// factor, an increment of the angle is exactly a rotation about that world axis
// no matter what the cube looks like at that moment.
//
// The angle is clamped to the single face a gesture can commit (v0.2.30): the
// drag renders AT MOST what the release will keep. Without the clamp a long drag
// wound the cube past the face it had earned and the release had to unwind the
// excess, which the player reads as "it turned while my finger was down, then
// bounced back" (probe: the drag showed 136.4°, the release kept 90° and gave
// 38.4° back). The clamp makes the finger a promise the release can always honour;
// the only rotation a release still takes back is the sub-threshold flick, which
// never gets past `stepThreshold` (≈30°) in the first place.
function setLiveAngle(angle) {
  cubeLive.angle = THREE.MathUtils.clamp(angle, cubeLive.start - ROT_STEP, cubeLive.start + ROT_STEP)
  cubeQuat.copy(cubeLive.rest).premultiply(scratchQuat.setFromAxisAngle(AXIS_OF[cubeLive.axis], cubeLive.angle)).multiply(cubeLive.base).normalize()
  applyCubeRotation()
}

// Plane one axis of the settle, in the fixed-axis model. `live` is where the
// drag left the angle, `start` is the angle the gesture began at (the tilt it
// had folded in), `base` is the face-aligned pose it began from. Over the
// threshold the gesture turns exactly one face in the drag direction (never
// "the nearest face"); under it the cube returns to its starting face. Either
// way the overshoot past that face survives as a bounded resting tilt — except
// on Z, where the budget is zero and the spin must land dead on the grid.
function planAxisStep(live, start, offsetMax) {
  const delta = live - start
  const stepped = Math.abs(delta) >= rotateStyle.stepThreshold ? Math.sign(delta) : 0
  const rest = THREE.MathUtils.clamp(live - stepped * ROT_STEP, -offsetMax, offsetMax)
  return { stepped, rest }
}

// Front face = the one whose outward normal (rotated into world) points most
// toward the camera.
const frontProbe = new THREE.Vector3()
const toCameraProbe = new THREE.Vector3()
function frontFaceOf(quat) {
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
  return frontFaceOf(cubeGroup.quaternion)
}

// ---- Candidate orientation on the front face (v0.2.28) ----------------------
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

// Spring-ish settle: easeOutBack so the pose springs a few degrees past the
// face it is landing on and then comes back. It always ENDS exactly on the
// planned rest angles, so the Z axis still lands dead on the 90° grid.
function easeOutBack(p, strength) {
  const q = p - 1
  return 1 + (strength + 1) * q * q * q + strength * q * q
}

function startCubeSnap(gesture) {
  const axis = gesture.axis
  const offsetMax = axis === 'roll' ? rotateStyle.restOffsetRoll
    : axis === 'yaw' ? rotateStyle.restOffsetYaw : rotateStyle.restOffsetPitch
  // The release decision is the whole story now (v0.2.30): one face at most, or
  // the sub-threshold flick back to the face the gesture started on. Nothing can
  // veto the step after the finger has already seen it — the live angle is
  // clamped to the same single face in setLiveAngle().
  const { stepped, rest } = planAxisStep(gesture.angle, gesture.start, offsetMax)
  if (stepped !== 0) cubeBase.premultiply(stepQuaternion(axis, stepped)).normalize()
  if (axis === 'yaw') cubeRestYaw = rest
  else if (axis === 'pitch') cubeRestPitch = rest
  else {
    // A Z spin is the player's explicit "straighten this face" gesture. Clear
    // yaw/pitch presentation offsets left by earlier swipes as well as the roll
    // remainder; otherwise tilt * Rz(90°) is grid-exact internally but still
    // looks a few degrees crooked when the settle animation ends.
    cubeRestYaw = 0
    cubeRestPitch = 0
  }
  cubeLive = null
  cubeSnapAnim.active = true
  cubeSnapAnim.from.copy(cubeQuat)
  // The Z target is the bare grid pose. Yaw/pitch targets retain their bounded
  // presentation tilt so the resting cube still reads as three-dimensional.
  cubeSnapAnim.to.copy(cubeTilt()).multiply(cubeBase).normalize()
  cubeSnapAnim.t = 0
  cubeSnapAnim.duration = rotateStyle.snapDuration
}

// A new gesture must start from a stable pose: settle any running animation
// instantly, otherwise the drag would be writing over an animation in flight.
function settleCubeSnap() {
  if (!cubeSnapAnim.active) return
  cubeSnapAnim.active = false
  cubeQuat.copy(cubeSnapAnim.to)
  applyCubeRotation()
}

// Return to the face-aligned start pose (used by Reset Game).
function resetCubeRotation() {
  cubeSnapAnim.active = false
  cubeLive = null
  // A reset can land in the middle of a gesture; drop it so the pointerup that
  // may never come cannot leave rotation permanently blocked.
  viewDrag = null
  cubeBase.identity()
  cubeQuat.identity()
  cubeRestYaw = 0
  cubeRestPitch = 0
  applyCubeRotation()
}

// Settle animation: a slerp from wherever the finger left the pose to the exact
// resting pose, with a small easeOutBack overshoot for the spring feel. Slerping
// the whole pose (rather than three angles) is what lets the fixed-axis gesture
// end on a pose the angle couldn't reach directly, and it still lands bit-exact
// on the target — the Z spin therefore straightens up exactly.
function updateCubeSnap(delta) {
  if (!cubeSnapAnim.active) return
  cubeSnapAnim.t += delta
  const p = THREE.MathUtils.clamp(cubeSnapAnim.t / cubeSnapAnim.duration, 0, 1)
  const eased = easeOutBack(p, rotateStyle.snapOvershoot)
  cubeQuat.copy(cubeSnapAnim.from).slerp(cubeSnapAnim.to, eased).normalize()
  applyCubeRotation()
  if (p >= 1) {
    cubeQuat.copy(cubeSnapAnim.to)
    cubeSnapAnim.active = false
    applyCubeRotation()
  }
}

// ============================================================
// Materials / helpers
// ============================================================
function colorToVector4(color, alpha = 1) {
  const normalized = new THREE.Color(color)
  return new THREE.Vector4(normalized.r, normalized.g, normalized.b, alpha)
}

function makeMaterial(color, opacity = 1) {
  const materialColor = new THREE.Color(color)
  return new THREE.MeshStandardMaterial({
    color: materialColor,
    roughness: style.voxelRoughness,
    metalness: 0,
    transparent: opacity < 1,
    opacity,
  })
}

const cubeGeometry = new RoundedBoxGeometry(0.92, 0.92, 0.92, 4, 0.105)
const edgeGeometry = new THREE.EdgesGeometry(cubeGeometry)
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

function disposeNode(node) {
  node.traverse((child) => {
    if (child.geometry && child.geometry !== cubeGeometry && child.geometry !== edgeGeometry && child.geometry !== cubeBody.geometry) child.geometry.dispose()
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose())
    else if (child.material) child.material.dispose()
  })
}

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children.pop()
    if (child) disposeNode(child)
  }
}

// ============================================================
// Board rendering
// ============================================================
function cellWorld(face, u, v) {
  return cellLocal(face, u, v).applyMatrix4(cubeGroup.matrixWorld)
}

function renderBoard() {
  clearGroup(cellsGroup)
  board.occupied().forEach((cell) => {
    const mesh = new THREE.Mesh(cubeGeometry, makeMaterial(cell.color))
    mesh.position.copy(placedLocal(cell.x, cell.y, cell.z))
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({
      color: style.voxelEdgeColor,
      transparent: true,
      opacity: style.voxelEdgeOpacity,
      depthWrite: false,
    })))
    cellsGroup.add(mesh)
  })
  updateHud()
}

// ============================================================
// HUD / pieces / previews
// ============================================================
function updateHud() {
  scoreEl.textContent = String(board.score).padStart(4, '0')
}

function makePiece(shape) {
  return { shape, cells: normalizeCells(shape.cells), used: false }
}

function currentCells(piece) {
  return piece.cells
}

function nextPieces() {
  pieces = Array.from({ length: 3 }, () => makePiece(SHAPES[Math.floor(Math.random() * SHAPES.length)]))
  selectedPiece = null
  renderPieceSlots()
}

function colorHex(color) {
  return `#${new THREE.Color(color).getHexString()}`
}

// Flat, face-on preview positions: (u,v) -> screen space (x right, y down).
function flatPreviewPositions(cells) {
  const maxU = Math.max(...cells.map(([u]) => u))
  const maxV = Math.max(...cells.map(([, v]) => v))
  const cx = maxU / 2
  const cy = maxV / 2
  return cells.map(([u, v]) => new THREE.Vector3((u - cx) * 0.8, (cy - v) * 0.8, 0))
}

function disposePiecePreviews() {
  piecePreviews.forEach((preview) => {
    preview.meshes.forEach((mesh) => {
      mesh.material.dispose()
      mesh.children.forEach((child) => child.material?.dispose())
    })
    preview.renderer.dispose()
    preview.renderer.forceContextLoss?.()
  })
  piecePreviews.clear()
}

function createPiecePreview(piece, canvas, slot) {
  const previewRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  previewRenderer.outputColorSpace = THREE.SRGBColorSpace
  previewRenderer.toneMapping = THREE.ACESFilmicToneMapping
  previewRenderer.toneMappingExposure = 1.16
  previewRenderer.setClearColor(0x000000, 0)

  const previewScene = new THREE.Scene()
  previewScene.add(new THREE.HemisphereLight(0xffffff, 0x6f82b7, 2.8))
  const previewKey = new THREE.DirectionalLight(0xffffff, 4.4)
  previewKey.position.set(2, 3, 6)
  previewScene.add(previewKey)
  const previewRim = new THREE.DirectionalLight(0x7ec8ff, 1.2)
  previewRim.position.set(-3, 1, 4)
  previewScene.add(previewRim)

  const previewCamera = new THREE.OrthographicCamera(-2.5, 2.5, 2.2, -2.2, 0.1, 40)
  previewCamera.position.set(2.5, 2.9, 5.4)
  previewCamera.lookAt(0, 0, 0)
  const root = new THREE.Group()
  previewScene.add(root)
  const positions = flatPreviewPositions(currentCells(piece))
  const size = new THREE.Box3().setFromPoints(positions.map((p) => p.clone())).getSize(new THREE.Vector3()).addScalar(0.62)
  const baseScale = THREE.MathUtils.clamp(3.2 / Math.max(size.x, size.y, size.z), 0.96, VFX_CONFIG.preview.maxScale)
  root.scale.setScalar(baseScale)
  const outlineColor = new THREE.Color(piece.shape.color).multiplyScalar(0.58)
  const meshes = positions.map((position) => {
    const mesh = new THREE.Mesh(cubeGeometry, makeMaterial(piece.shape.color))
    mesh.scale.setScalar(0.7)
    mesh.position.copy(position)
    mesh.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: outlineColor, transparent: true, opacity: 0.66 })))
    root.add(mesh)
    return mesh
  })
  piecePreviews.set(piece, { piece, slot, renderer: previewRenderer, scene: previewScene, camera: previewCamera, root, meshes })
}

function updatePieceSlotSelection() {
  piecePreviews.forEach((preview, piece) => {
    preview.slot.classList.toggle('selected', selectedPiece === piece)
    preview.slot.classList.toggle('used', piece.used)
  })
}

function updatePiecePreviews() {
  piecePreviews.forEach((preview) => {
    const width = Math.max(preview.renderer.domElement.clientWidth, 1)
    const height = Math.max(preview.renderer.domElement.clientHeight, 1)
    if (preview.renderer.domElement.width !== Math.round(width * preview.renderer.getPixelRatio()) || preview.renderer.domElement.height !== Math.round(height * preview.renderer.getPixelRatio())) {
      preview.renderer.setSize(width, height, false)
      const halfHeight = 1.6
      const halfWidth = halfHeight * width / height
      preview.camera.left = -halfWidth
      preview.camera.right = halfWidth
      preview.camera.top = halfHeight
      preview.camera.bottom = -halfHeight
      preview.camera.updateProjectionMatrix()
    }
    preview.camera.position.set(2.5, 2.9, 5.4)
    preview.camera.lookAt(0, 0, 0)
    preview.renderer.render(preview.scene, preview.camera)
  })
}

function renderPieceSlots() {
  disposePiecePreviews()
  slotsEl.innerHTML = ''
  pieces.forEach((piece, index) => {
    const slot = document.createElement('button')
    slot.className = `piece-slot${piece.used ? ' used' : ''}${selectedPiece === piece ? ' selected' : ''}`
    slot.type = 'button'
    slot.dataset.index = index
    slot.style.setProperty('--piece-color', colorHex(piece.shape.color))
    slot.setAttribute('aria-label', `${piece.shape.name}, ${piece.shape.cells.length} blocks`)

    const thumb = document.createElement('span')
    thumb.className = 'piece-thumb'
    const canvas = document.createElement('canvas')
    canvas.className = 'piece-preview-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    thumb.appendChild(canvas)

    slot.append(thumb)
    slot.addEventListener('pointerdown', (event) => beginDrag(event, piece))
    slot.addEventListener('click', () => {
      if (!piece.used && !drag && !itemActive && performance.now() >= suppressPieceClickUntil) {
        selectedPiece = piece
        updatePieceSlotSelection()
        setStatus('Drag to a face')
      }
    })
    slotsEl.appendChild(slot)
    createPiecePreview(piece, canvas, slot)
  })
}

function setStatus(text) { statusEl.textContent = text }
function showToast(text) {
  toastEl.textContent = text
  toastEl.classList.add('visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 1500)
}

function setCancelZone(active, highlighted = false) {
  piecesPanelEl.classList.toggle('cancel-mode', active)
  piecesPanelEl.classList.toggle('cancel-hot', active && highlighted)
  cancelZoneEl.setAttribute('aria-hidden', String(!active))
}

function isInsidePieceArea(event) {
  const rect = piecesPanelEl.getBoundingClientRect()
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
}

function cancelActiveDrag(showFeedback = true) {
  if (!drag) return false
  const currentDrag = drag
  drag = null
  releaseDragPointer(currentDrag.source, currentDrag.pointerId)
  clearGroup(previewGroup)
  selectedPiece = null
  suppressPieceClickUntil = performance.now() + 260
  setCancelZone(false)
  updatePieceSlotSelection()
  setStatus('Pick a shape')
  if (showFeedback) {
    showToast('Placement cancelled')
    playHaptic(10)
  }
  return true
}

// ============================================================
// Settings / audio / haptics
// ============================================================
function updateSettingsUi() {
  soundSettingEl.classList.toggle('enabled', soundOn)
  soundSettingEl.setAttribute('aria-pressed', String(soundOn))
  hapticsSettingEl.classList.toggle('enabled', hapticsOn)
  hapticsSettingEl.setAttribute('aria-pressed', String(hapticsOn))
}

function openSettings() {
  if (gameEnded) return
  settingsOpen = true
  isPaused = true
  if (drag) cancelActiveDrag(false)
  cancelItemSelection(true)
  clearGroup(previewGroup)
  settingsEl.classList.remove('hidden')
  platform.gameplayStop()
  setStatus('Paused')
  updateSettingsUi()
  document.querySelector('#settings-close').focus()
}

function closeSettings() {
  if (!settingsOpen) return
  settingsOpen = false
  settingsEl.classList.add('hidden')
  isPaused = document.hidden || gameEnded
  if (!isPaused) {
    platform.gameplayStart()
    setStatus('Pick a shape')
  }
  settingsButtonEl.focus()
}

function playTone(frequency, duration = 0.08, volume = 0.045, delay = 0) {
  if (!soundOn) return
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

function playHaptic(pattern = 15) {
  if (hapticsOn && navigator.vibrate) navigator.vibrate(pattern)
}

function showScorePop(points, lineCount) {
  const pop = document.createElement('div')
  pop.className = 'score-pop'
  pop.innerHTML = `<strong>+${points}</strong><span>${lineCount} LINE${lineCount === 1 ? '' : 'S'}</span>`
  sceneWrap.appendChild(pop)
  requestAnimationFrame(() => pop.classList.add('visible'))
  setTimeout(() => pop.remove(), 920)
}

// ============================================================
// Items (front-face based)
// ============================================================
const ITEM_TOOLS = Object.freeze([
  { id: 'refresh', name: 'Refresh', icon: '↻', start: 2, cap: 3 },
  { id: 'hammer', name: 'Hammer', icon: '🔨', start: 1, cap: 2 },
  { id: 'rocket', name: 'Rocket', icon: '🚀', start: 1, cap: 2 },
  { id: 'bomb', name: 'Bomb', icon: '💣', start: 1, cap: 2 },
])
const itemPreviewGroup = new THREE.Group()
cubeGroup.add(itemPreviewGroup)
let itemCounts = Object.fromEntries(ITEM_TOOLS.map((tool) => [tool.id, tool.start]))
let itemActive = null // { id, face, u, v }
let itemBusyUntil = 0
let lastItemHoverKey = null

function canUseItemsNow() {
  return !gameEnded && !isPaused && !drag && !settingsOpen && performance.now() >= itemBusyUntil
}

function renderItemBar() {
  itemBarEl.querySelectorAll('.item-button').forEach((button) => {
    const id = button.dataset.item
    const count = itemCounts[id]
    const ready = canUseItemsNow() && count > 0
    button.classList.toggle('disabled', !ready)
    button.classList.toggle('active', itemActive?.id === id)
    button.setAttribute('aria-pressed', String(itemActive?.id === id))
    const countEl = button.querySelector('.item-count')
    if (countEl) countEl.textContent = String(count)
  })
}

function cancelItemSelection(silent = false) {
  if (!itemActive) {
    axisPickEl.classList.add('hidden')
    clearGroup(itemPreviewGroup)
    return
  }
  itemActive = null
  lastItemHoverKey = null
  clearGroup(itemPreviewGroup)
  axisPickEl.classList.add('hidden')
  if (!silent) setStatus('Pick a shape')
  renderItemBar()
}

function resetItems() {
  itemCounts = Object.fromEntries(ITEM_TOOLS.map((tool) => [tool.id, tool.start]))
  itemActive = null
  itemBusyUntil = 0
  lastItemHoverKey = null
  clearGroup(itemPreviewGroup)
  axisPickEl.classList.add('hidden')
  renderItemBar()
}

function eventNdc(event) {
  const rect = renderer.domElement.getBoundingClientRect()
  return new THREE.Vector2(
    ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
    -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
  )
}

// Convert an NDC into the front face's (u, v) grid cell nearest to the pointer.
function ndcToCell(face, ndc) {
  const plane = new THREE.Plane()
  const nWorld = cubeVector(face, 'n').applyQuaternion(cubeGroup.quaternion).normalize()
  const centerWorld = facePlaneLocalCenter(face).applyMatrix4(cubeGroup.matrixWorld)
  plane.setFromNormalAndCoplanarPoint(nWorld, centerWorld)
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, camera)
  const point = new THREE.Vector3()
  if (!raycaster.ray.intersectPlane(plane, point)) return null
  const localP = point.applyMatrix4(new THREE.Matrix4().copy(cubeGroup.matrixWorld).invert())
  const rel = localP.sub(facePlaneLocalCenter(face))
  const uF = rel.dot(cubeVector(face, 'u')) / cs + (SH - 1) / 2
  const vF = rel.dot(cubeVector(face, 'v')) / cs + (SH - 1) / 2
  return { u: Math.round(uF), v: Math.round(vF) }
}

// For a placed set of cells, enumerate legal origins on the front face and pick
// the one whose world projection is nearest the pointer (mirrors BlockBlast snap).
function nearestOriginOnFace(face, ndc, cells) {
  const projected = new THREE.Vector3()
  const { u: uMax, v: vMax } = maxOrigin(cells, SH)
  let bestOrigin = { u: 0, v: 0 }
  let bestDistance = Infinity
  let found = false
  for (let u = 0; u < uMax; u += 1) for (let v = 0; v < vMax; v += 1) {
    if (!board.canPlace(face, cells, { u, v })) continue
    projected.copy(cellWorld(face, u, v)).project(camera)
    const distance = Math.hypot(projected.x - ndc.x, projected.y - ndc.y)
    if (distance < bestDistance) { bestDistance = distance; bestOrigin = { u, v }; found = true }
  }
  if (found) return bestOrigin
  return null
}

function toolScopeCells(id, face, u, v) {
  if (id === 'hammer') return [faceLattice(face, u, v)]
  if (id === 'rocket') {
    const cells = []
    if (itemActive?.orientation === 'col') for (let i = 0; i < SH; i += 1) cells.push(faceLattice(face, u, i))
    else for (let i = 0; i < SH; i += 1) cells.push(faceLattice(face, i, v))
    return cells
  }
  // bomb: 2×2 square on the face, growing toward +u/+v, trimmed to bounds
  const cells = []
  for (let du = 0; du <= 1; du += 1) for (let dv = 0; dv <= 1; dv += 1) {
    const cu = u + du
    const cv = v + dv
    if (cu < SH && cv < SH) cells.push(faceLattice(face, cu, cv))
  }
  return cells
}

function rebuildItemOverlay() {
  clearGroup(itemPreviewGroup)
  if (!itemActive || itemActive.u === undefined || itemActive.v === undefined) return
  const scope = toolScopeCells(itemActive.id, itemActive.face, itemActive.u, itemActive.v)
  scope.forEach(([x, y, z]) => {
    const occupied = board.has(x, y, z)
    const mesh = new THREE.Mesh(cubeGeometry, makeMaterial(palette.valid, occupied ? 0.5 : 0.2))
    mesh.scale.setScalar(occupied ? 1 : 0.72)
    mesh.position.copy(placedLocal(x, y, z))
    itemPreviewGroup.add(mesh)
  })
}

function updateItemHover(ndc) {
  if (!itemActive || itemActive.id === 'refresh') return
  const frontFace = findFrontFace()
  const cellAt = ndcToCell(frontFace, ndc)
  itemActive.face = frontFace
  itemActive.u = cellAt ? cellAt.u : 0
  itemActive.v = cellAt ? cellAt.v : 0
  const key = `${itemActive.id}:${frontFace}:${itemActive.u},${itemActive.v}:${itemActive.orientation || ''}`
  if (key !== lastItemHoverKey) {
    lastItemHoverKey = key
    rebuildItemOverlay()
  }
}

function selectItemAt(event) {
  const ndc = eventNdc(event)
  const frontFace = findFrontFace()
  const cellAt = ndcToCell(frontFace, ndc)
  if (!cellAt) { setStatus('Pick a face cell'); return }
  itemActive.face = frontFace
  itemActive.u = cellAt.u
  itemActive.v = cellAt.v
  confirmItem()
}

function confirmItem() {
  const { id, face, u, v } = itemActive
  if (u === undefined || v === undefined) return
  const scope = toolScopeCells(id, face, u, v)
  const removed = board.removeCells(scope)
  if (!removed.length) {
    setStatus('Nothing to clear there')
    return
  }
  consumeItem(id)
  itemBusyUntil = performance.now() + 420
  setTimeout(renderItemBar, 450)
  emitItemBurst(removed, id)
  renderBoard()
  cancelItemSelection(true)
  setStatus('Pick a shape')
  renderItemBar()
  checkStuckAndPrompt()
}

function consumeItem(id) {
  itemCounts[id] = Math.max(0, itemCounts[id] - 1)
}

function activateItem(id) {
  if (itemActive) cancelItemSelection(true)
  if (!canUseItemsNow() || itemCounts[id] <= 0) {
    renderItemBar()
    return
  }
  if (id === 'refresh') {
    consumeItem('refresh')
    rerollPieces()
    return
  }
  itemActive = { id, face: null, u: undefined, v: undefined, orientation: id === 'bomb' ? '2x2' : 'row' }
  lastItemHoverKey = null
  axisPickEl.classList.toggle('hidden', id !== 'rocket')
  setStatus(id === 'hammer' ? 'Pick a block to remove' : id === 'rocket' ? 'Pick a line to clear' : 'Pick a 2×2 area')
  renderItemBar()
}

function rerollPieces() {
  const before = pieces.map((piece) => piece.shape.name).join('|')
  for (let attempt = 0; attempt < 24; attempt += 1) {
    pieces = Array.from({ length: 3 }, () => makePiece(SHAPES[Math.floor(Math.random() * SHAPES.length)]))
    if (pieces.map((piece) => piece.shape.name).join('|') !== before) break
  }
  selectedPiece = null
  renderPieceSlots()
  showToast('Refreshed')
  playHaptic(10)
  renderItemBar()
  checkStuckAndPrompt()
}

function hasPlaceablePiece() {
  return pieces.some((piece) => !piece.used && board.anyPlacement(piece.cells))
}

function checkStuckAndPrompt() {
  if (gameEnded || isPaused || !pieces.length) return
  if (hasPlaceablePiece()) return
  if (itemCounts.refresh > 0) {
    setStatus('No spot - use Refresh')
    showToast('No spot - try Refresh')
    return
  }
  endGame()
}

function emitItemBurst(cells, axisHint) {
  if (!cells.length) return
  const frontFace = findFrontFace()
  const uDir = cubeVector(frontFace, 'u').applyQuaternion(cubeGroup.quaternion)
  const vDir = cubeVector(frontFace, 'v').applyQuaternion(cubeGroup.quaternion)
  const worldCenter = new THREE.Vector3()
  cells.forEach(([x, y, z]) => worldCenter.add(cellToWorld(x, y, z).applyMatrix4(cubeGroup.matrixWorld)))
  worldCenter.multiplyScalar(1 / cells.length)
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
    emissionBursts: [{ time: 0, count, cycle: 1, interval: 0.01, probability: 1 }],
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

for (const button of itemBarEl.querySelectorAll('.item-button')) {
  button.addEventListener('click', () => activateItem(button.dataset.item))
}
for (const button of axisPickEl.querySelectorAll('button')) {
  button.addEventListener('click', () => {
    if (!itemActive || itemActive.id !== 'rocket') return
    itemActive.orientation = button.dataset.axis === 'col' ? 'col' : 'row'
    lastItemHoverKey = null
    if (itemActive.u !== undefined) rebuildItemOverlay()
    setStatus(`Rocket line: ${itemActive.orientation === 'col' ? 'Column' : 'Row'}`)
  })
}

// ============================================================
// Piece placement drag
// ============================================================
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

function beginDrag(event, piece) {
  if (piece.used || isPaused || drag || itemActive) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  selectedPiece = piece
  drag = {
    piece,
    pointerId: event.pointerId,
    source: event.currentTarget,
    ndc: eventNdc(event),
    face: null,
    origin: null,
    cells: null,
    valid: false,
    active: false,
    inCancelZone: false,
    startX: event.clientX,
    startY: event.clientY,
  }
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // Some embedded browsers reject capture during an interrupted gesture.
  }
  event.currentTarget.classList.add('selected')
  setStatus('Drag to a face')
}

function updatePreview(ndc) {
  clearGroup(previewGroup)
  if (!selectedPiece || !ndc || !drag?.active) return
  const face = findFrontFace()
  // Laid out on the front face the way the slot drew it — see
  // faceOrientedCells(). The board gets these exact cells on release.
  const cells = faceOrientedCells(face, currentCells(selectedPiece))
  const origin = nearestOriginOnFace(face, ndc, cells)
  drag.face = face
  if (!origin) {
    drag.valid = false
    drag.origin = null
    drag.cells = null
    setStatus('No room on this face')
    return
  }
  const valid = board.canPlace(face, cells, origin)
  drag.valid = valid
  drag.origin = origin
  drag.cells = cells
  cells.forEach(([u, v]) => {
    const mesh = new THREE.Mesh(cubeGeometry, makeMaterial(valid ? palette.valid : palette.invalid, 0.52))
    mesh.position.copy(placedLocal(...faceLattice(face, u + origin.u, v + origin.v)))
    mesh.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({
      color: valid ? 0x083c39 : 0x6b1024,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    })))
    previewGroup.add(mesh)
  })
  setStatus(valid ? 'Release to place' : 'No room here')
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

function spawnLineParticles(line) {
  const worldU = cubeVector(line.face, 'u').applyQuaternion(cubeGroup.quaternion)
  const worldV = cubeVector(line.face, 'v').applyQuaternion(cubeGroup.quaternion)
  const direction = line.axis === 'row' ? worldU : worldV
  const color = palette.line[line.axis === 'row' ? 'x' : 'y']
  const brightEnd = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.42)
  const center = lineCenterWorld(line)
  const system = new ParticleSystem({
    autoDestroy: true,
    looping: false,
    duration: 0.72,
    startLife: new ConstantValue(0.62),
    startSpeed: new ConstantValue(1.45),
    startSize: new ConstantValue(0.09),
    startColor: new ConstantColor(colorToVector4(color)),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [{ time: 0, count: quality.particlesPerLine, cycle: 1, interval: 0.01, probability: 1 }],
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
  return cellToWorld(cell[0], cell[1], cell[2]).applyMatrix4(cubeGroup.matrixWorld)
}

function spawnLineBeam(line, index) {
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
  spawnLineParticles(line)
}

function spawnClearStars(line, index) {
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
        effect.object.scale.setScalar(base * pop * VFX_CONFIG.clear.starMaxScale)
        const fade = progress < 0.12 ? progress / 0.12 : progress > 0.55 ? 1 - (progress - 0.55) / 0.45 : 1
        effect.object.material.opacity = Math.max(0, fade) * 0.85
      },
    })
  })
}

function spawnClearEffects(lines) {
  lines.forEach((line, index) => {
    spawnLineBeam(line, index)
    spawnClearStars(line, index)
  })
  triggerShake(lines.length > 1 ? 0.12 : 0.055)
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
function updateCameraShake(delta) {
  cameraShake = Math.max(0, cameraShake - delta * 0.42)
  camera.position.copy(CAMERA_DIR).multiplyScalar(orbitDistance * cameraZoom)
  if (cameraShake > 0) {
    const time = performance.now() * 0.045
    camera.position.x += Math.sin(time) * cameraShake
    camera.position.y += Math.cos(time * 1.17) * cameraShake * 0.7
    camera.position.z += Math.sin(time * 0.83) * cameraShake * 0.5
  }
  camera.lookAt(cameraTarget)
}

function releaseDragPointer(source, pointerId) {
  try {
    source?.releasePointerCapture?.(pointerId)
  } catch {
    // The browser may have already cancelled the pointer capture.
  }
}

function finishDrag(event) {
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
  const currentDrag = drag
  drag = null
  releaseDragPointer(currentDrag.source, currentDrag.pointerId)
  clearGroup(previewGroup)
  setCancelZone(false)
  if (!currentDrag.active) {
    selectedPiece = currentDrag.piece
    updatePieceSlotSelection()
    setStatus('Drag to a face')
    return
  }
  suppressPieceClickUntil = performance.now() + 260
  if (currentDrag.inCancelZone) {
    selectedPiece = null
    updatePieceSlotSelection()
    setStatus('Pick a shape')
    showToast('Placement cancelled')
    playHaptic(10)
    return
  }
  if (!currentDrag.valid || !currentDrag.origin || !currentDrag.face) {
    selectedPiece = null
    updatePieceSlotSelection()
    setStatus('Pick a shape')
    showToast('Try another spot')
    return
  }
  const face = currentDrag.face
  // Place the cells the preview actually showed (screen-facing orientation on
  // the front face), never a fresh re-derivation — the drop must match what the
  // player saw under their finger.
  const result = board.place(face, currentDrag.cells, currentDrag.origin, currentDrag.piece.shape.color)
  playPlaceSound(result.lines.length)
  playHaptic(result.lines.length > 1 ? [18, 35, 22] : result.lines.length ? [18, 28, 16] : 12)
  currentDrag.piece.used = true
  selectedPiece = null
  renderBoard()
  updatePieceSlotSelection()
  if (result.lines.length) {
    const multiplier = result.lines.length === 1 ? 'x1' : result.lines.length === 2 ? 'x3' : result.lines.length === 3 ? 'x6' : 'x10'
    showToast(`${result.lines.length} LINE${result.lines.length === 1 ? '' : 'S'}  ${multiplier}  +${result.points}`)
    showScorePop(result.points, result.lines.length)
    spawnClearEffects(result.lines)
    itemBusyUntil = performance.now() + 650
    setTimeout(renderItemBar, 720)
    setStatus('Clear! Keep building')
  } else setStatus('Pick a shape')
  if (pieces.every((piece) => piece.used)) nextPieces()
  checkStuckAndPrompt()
}

function endGame() {
  if (gameEnded) return
  gameEnded = true
  isPaused = true
  platform.gameplayStop()
  finalScoreEl.textContent = String(board.score).padStart(4, '0')
  gameOverEl.classList.remove('hidden')
}

function resetGame() {
  clearTransientEffects()
  board.clear()
  // v0.2.31: the cube starts with an opening layout instead of a bare shell
  // (config.js OPENING_LAYOUT). Seeding never scores or clears lines, so the HUD
  // still starts at 0 and the first placement is settled like any other.
  board.seedOpening(SHAPES, OPENING_LAYOUT)
  resetItems()
  gameEnded = false
  settingsOpen = false
  isPaused = document.hidden
  cameraShake = 0
  settingsEl.classList.add('hidden')
  gameOverEl.classList.add('hidden')
  selectedPiece = null
  drag = null
  setCancelZone(false)
  resetCubeRotation()
  nextPieces()
  renderBoard()
  setStatus('Pick a shape')
  if (!isPaused) platform.gameplayStart()
}

function beginViewDrag(event) {
  if (isPaused || drag || event.pointerType === 'mouse' && event.button !== 0) return
  // A gesture whose pointerup never arrived must not block this one: if we held
  // the pointer capture for it and the capture is gone, that pointer is gone too.
  if (viewDrag && viewDrag.pointerId !== event.pointerId && viewDrag.captured
    && viewDrag.source?.hasPointerCapture?.(viewDrag.pointerId) === false) cancelViewDrag()
  if (viewDrag) return
  event.preventDefault()
  // Start from a stable pose so the gesture's own delta is the only thing the
  // settle logic sees.
  settleCubeSnap()
  viewDrag = {
    pointerId: event.pointerId,
    source: event.currentTarget,
    startX: event.clientX,
    startY: event.clientY,
    // Region is sampled once, where the finger goes down: a gesture never
    // switches meaning halfway through.
    overCube: isHorizontallyOnCube(event.clientX),
    axis: null,
    span: null, // drag -> angle ruler, sampled where the axis is claimed
    captured: false,
  }
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
    viewDrag.captured = event.currentTarget.hasPointerCapture?.(event.pointerId) ?? false
  } catch {
    // Some embedded browsers can reject capture after an interrupted gesture.
  }
}

function finishViewDrag(event) {
  if (!viewDrag || (event?.pointerId !== undefined && event.pointerId !== viewDrag.pointerId)) return
  const currentViewDrag = viewDrag
  viewDrag = null
  releaseDragPointer(currentViewDrag.source, currentViewDrag.pointerId)
  // No axis was claimed (a tap, or a drag that never committed): the pose never moved.
  if (cubeLive) startCubeSnap(cubeLive)
}

// A view gesture can outlive its pointer: the page goes hidden, a native gesture
// hijacks the touch, the window loses focus with the button still down. The
// pointerup then never arrives, and because beginViewDrag() refuses to start a new
// gesture while `viewDrag` is set, rotation would stay dead for the rest of the
// session (placement keeps working, which is exactly how this shows up: "it won't
// turn, it feels locked"). Every path that can lose a pointer ends the gesture
// here and settles the halfway pose it left behind.
function cancelViewDrag() {
  if (!viewDrag && !cubeLive) return
  viewDrag = null
  if (cubeLive) startCubeSnap(cubeLive)
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (itemActive) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    selectItemAt(event)
    return
  }
  beginViewDrag(event)
})
window.addEventListener('pointermove', (event) => {
  if (viewDrag && event.pointerId === viewDrag.pointerId) {
    event.preventDefault()
    const dx = event.clientX - viewDrag.startX
    const dy = event.clientY - viewDrag.startY
    if (!viewDrag.axis) {
      // Until a decisive dominant direction claims the gesture the pose does not
      // move at all: a few px of sideways drift must never be able to swallow a
      // vertical swipe (rendering/swipe.js).
      if (!gestureAxisReady(dx, dy)) return
      viewDrag.axis = pickGestureAxis(dx, dy, viewDrag.overCube)
      viewDrag.span = gestureSpan()
      // Claimed: snapshot the pose the gesture starts from (tilt + grid pose).
      beginAxisGesture(viewDrag.axis)
    }
    // Drag rotates the cube (not the camera). The claimed axis is the only one
    // that moves, and it is a FIXED world axis: the angle is applied to the pose
    // the cube happens to have, so it never turns with the cube. Each axis
    // carries its own direction sign and its own ruler (ROTATE_STYLE, swipe.js).
    setLiveAngle(cubeLive.start + swipeAngle(viewDrag.axis, dx, dy, viewDrag.span))
    return
  }
  if (itemActive) {
    updateItemHover(eventNdc(event))
    return
  }
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
  if (!drag.active) {
    drag.active = true
    setCancelZone(true)
  }
  drag.inCancelZone = isInsidePieceArea(event)
  setCancelZone(true, drag.inCancelZone)
  if (drag.inCancelZone) {
    drag.valid = false
    drag.origin = null
    drag.cells = null
    clearGroup(previewGroup)
    setStatus('Release to cancel')
    return
  }
  const ndc = eventNdc(event)
  drag.ndc = ndc
  updatePreview(ndc)
  setStatus(drag.valid ? 'Release to place' : 'No room here')
}, { passive: false })
window.addEventListener('pointerup', (event) => {
  finishViewDrag(event)
  finishDrag(event)
})
window.addEventListener('pointercancel', (event) => {
  finishViewDrag(event)
  if (!drag || event.pointerId !== drag.pointerId) return
  cancelActiveDrag(false)
})
renderer.domElement.addEventListener('wheel', (event) => {
  event.preventDefault()
  cameraZoom = THREE.MathUtils.clamp(cameraZoom * (event.deltaY > 0 ? 0.92 : 1.08), minCameraZoom, maxCameraZoom)
  fitCameraToPlaySpace()
}, { passive: false })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && itemActive) { event.preventDefault(); cancelItemSelection(); return }
  if (event.key === 'Escape' && drag) { event.preventDefault(); cancelActiveDrag(); return }
  if (event.key === 'Escape' && settingsOpen) { closeSettings(); return }
  if (settingsOpen) return
  if (itemActive?.id === 'rocket' && ['r', 'c'].includes(event.key.toLowerCase())) {
    itemActive.orientation = event.key.toLowerCase() === 'c' ? 'col' : 'row'
    lastItemHoverKey = null
    rebuildItemOverlay()
    setStatus(`Rocket line: ${itemActive.orientation === 'col' ? 'Column' : 'Row'}`)
  }
})
window.addEventListener('contextmenu', (event) => {
  if (itemActive) { event.preventDefault(); cancelItemSelection(); return }
  if (!drag) return
  event.preventDefault()
  cancelActiveDrag()
})
for (const button of document.querySelectorAll('#reset-button, #reset-modal')) button.addEventListener('click', resetGame)
settingsButtonEl.addEventListener('click', openSettings)
document.querySelector('#settings-close').addEventListener('click', closeSettings)
settingsEl.addEventListener('pointerdown', (event) => { if (event.target === settingsEl) closeSettings() })
soundSettingEl.addEventListener('click', () => {
  soundOn = !soundOn
  localStorage.setItem(soundKey, soundOn ? 'on' : 'off')
  updateSettingsUi()
  if (soundOn) playTone(520, 0.08, 0.035)
})
hapticsSettingEl.addEventListener('click', () => {
  hapticsOn = !hapticsOn
  localStorage.setItem(hapticsKey, hapticsOn ? 'on' : 'off')
  updateSettingsUi()
  if (hapticsOn) playHaptic(18)
})
document.querySelector('#restart-setting').addEventListener('click', resetGame)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && itemActive) cancelItemSelection(true)
  if (document.hidden && drag) cancelActiveDrag(false)
  // A page that goes hidden never delivers the pointerup of a finger that was
  // down, so the rotation gesture has to be ended here (see cancelViewDrag()).
  if (document.hidden) cancelViewDrag()
  isPaused = document.hidden || gameEnded || settingsOpen
  if (document.hidden) { platform.gameplayStop(); setStatus('Paused') }
  else if (gameEnded || settingsOpen) return
  else { platform.gameplayStart(); setStatus('Pick a shape') }
})
// Losing the window ends a mouse gesture the same way (button released outside).
window.addEventListener('blur', cancelViewDrag)
updateSettingsUi()

function resize() {
  const width = sceneWrap.clientWidth
  const height = sceneWrap.clientHeight
  renderer.setSize(width, height, false)
  composer.setSize(width, height)
  refreshCameraProjection()
  fitCameraToPlaySpace()
}
window.addEventListener('resize', resize)
resize()
resetGame()
platform.initialize().catch(() => showToast('Offline mode'))

const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  if (!isPaused) {
    particleRenderer.update(delta)
    updateTransientEffects(delta)
    updateCubeSnap(delta)
  }
  updatePiecePreviews()
  updateCameraShake(delta)
  composer.render(delta)
}
// Read-only introspection hook for the headless verification runs (the CDP
// checks assert that a swipe settles on a face-aligned pose). It exposes no
// mutable game state and is not used by any gameplay code path.
globalThis.__voxalblast = Object.freeze({
  version: packageInfo.version,
  // `pose` is the rendered orientation; `base` is the grid pose it settles
  // around (a product of whole 90° steps about world axes, so it can never drift
  // off the grid); `tilt` is the ≤8° presentation tilt sitting on top of it. The
  // Euler triples are readability helpers for the checks (a pure yaw/pitch/roll
  // pose decomposes exactly in ZYX order).
  rotation: () => {
    const poseEuler = new THREE.Euler().setFromQuaternion(cubeQuat, 'ZYX')
    const baseEuler = new THREE.Euler().setFromQuaternion(cubeBase, 'ZYX')
    const tiltEuler = new THREE.Euler().setFromQuaternion(cubeTilt(), 'ZYX')
    return {
      yaw: poseEuler.y,
      pitch: poseEuler.x,
      roll: poseEuler.z,
      baseYaw: baseEuler.y,
      basePitch: baseEuler.x,
      baseRoll: baseEuler.z,
      tiltYaw: tiltEuler.y,
      tiltPitch: tiltEuler.x,
      pose: cubeQuat.toArray(),
      base: cubeBase.toArray(),
      front: findFrontFace(),
      settling: cubeSnapAnim.active,
      live: cubeLive ? { axis: cubeLive.axis, angle: cubeLive.angle } : null,
    }
  },
  // Screen-space cube box + framing numbers, used to check the "inside vs
  // outside the cube" gesture split and how much of the canvas the cube fills.
  bounds: () => cubeScreenBounds(),
  // Candidate orientation on the current front face. `raw` is the top-left
  // layout the slot draws, `oriented` is what would actually be dropped, and
  // `uAxis` / `vAxis` project the lattice step the piece's +u / +v take, in
  // client pixels with dx > 0 = rightward and dy > 0 = upward (NDC convention).
  // A matching placement therefore has +u rightward and +v downward.
  placement: () => {
    const face = findFrontFace()
    const piece = pieces.find((candidate) => !candidate.used) || pieces[0]
    const rect = renderer.domElement.getBoundingClientRect()
    const stepScreen = (probeCells) => {
      const [from, to] = faceOrientedCells(face, probeCells)
      const du = to[0] - from[0]
      const dv = to[1] - from[1]
      const start = cellWorld(face, 0, 0).project(camera)
      const end = cellWorld(face, du, dv).project(camera)
      return {
        step: [du, dv],
        dx: (end.x - start.x) * 0.5 * rect.width,
        dy: (end.y - start.y) * 0.5 * rect.height, // NDC y is already up-positive
      }
    }
    return {
      face,
      piece: piece ? piece.shape.name : null,
      raw: piece ? currentCells(piece) : [],
      oriented: piece ? faceOrientedCells(face, currentCells(piece)) : [],
      uAxis: stepScreen([[0, 0], [1, 0]]),
      vAxis: stepScreen([[0, 0], [0, 1]]),
    }
  },
  framing: () => {
    const rect = renderer.domElement.getBoundingClientRect()
    const solid = cubeScreenBounds()
    const fitBox = projectCubeBounds(CUBE_EXTENT)
    return {
      canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.left + rect.width, bottom: rect.top + rect.height },
      solid,
      fitBox,
      fillX: (solid.maxX - solid.minX) / Math.max(rect.width, 1),
      fillY: (solid.maxY - solid.minY) / Math.max(rect.height, 1),
      bandLeft: solid.minX - rect.left,
      bandRight: rect.left + rect.width - solid.maxX,
      clipped: solid.minX < rect.left || solid.maxX > rect.left + rect.width || solid.minY < rect.top || solid.maxY > rect.top + rect.height,
      orbitDistance,
      zoom: cameraZoom,
      fov: camera.fov,
      aspect: camera.aspect,
    }
  },
  // Board read-out for the headless checks (v0.2.31): the occupied shell cells as
  // [x, y, z, color] — the color is the shape type, so a check can prove the
  // opening layout draws from the candidate pool — plus the score and any face
  // line that is already full. Read-only, like the rest of this hook.
  board: () => ({
    cells: board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]),
    score: board.score,
    totalLines: board.totalLines,
    fullLines: FACES.flatMap((face) => board.findFullLines(face)
      .map((line) => `${face}:${line.axis}:${line.axis === 'row' ? line.v : line.u}`)),
  }),
  // The candidate pool itself: name, color and cell count per type.
  shapes: () => SHAPES.map((shape) => ({ name: shape.name, color: shape.color, size: shape.cells.length })),
})

applyCubeRotation()
animate()

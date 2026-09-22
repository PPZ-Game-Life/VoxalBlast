import packageInfo from '../package.json'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
// MUST come before the three.quarks import below: it bridges the r159 `updateRange` removal
// that otherwise throws inside animate() and freezes the canvas. rendering/gameScene.js owns
// the composer and imports this bridge for `skipComposerDepthBlit`, but gameScene itself is
// imported further down (after quarks), so relying on that would be relying on accident.
// Modules evaluate once, so this side-effect import and gameScene's named import are the
// same instance — it only pins the ORDER.
import './rendering/threeCompat.js'
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
import { Board, SH, FACES, faceLattice, isShell } from './game/board.js'
import { SHAPES, pickShape, normalizeCells, maxOrigin } from './game/shapes.js'
import { moveScore, lineMultiplier, nextChain } from './game/scoring.js'
import { resolveHonors, feedbackLevel, HONORS } from './game/honors.js'
import { recordStore } from './game/records.js'
import { sessionStore } from './game/session.js'
import { createCrazyGamesAdapter } from './platform/crazygames.js'
import { DRAG_GHOST, FEEDBACK_STYLE, getRenderQuality, HUD_STYLE, INTRO_STYLE, OPENING_LAYOUT, RENDER_PALETTE as palette, BOARD_STYLE as style, ROTATE_STYLE as rotateStyle, VFX_CONFIG } from './rendering/config.js'
import { gestureAxisReady, pickGestureAxis, screenBand, swipeAngle } from './rendering/swipe.js'
import { KEY_BINDINGS, axisForKey } from './rendering/keyboard.js'
import './styles.css'
import './toy.css'
import { addToyLights } from './rendering/toyLights.js'
import { installWoodSkin, woodGrainTextureRepeating, blockSurfaceArtStatus } from './rendering/woodTexture.js'
import { createBlockResources } from './rendering/blockResources.js'
import { createGameScene } from './rendering/gameScene.js'
import { createBoardView } from './rendering/boardView.js'
import { installPastoralBackdrop } from './rendering/pastoralBackdrop.js'
import { installToyIcons } from './ui/icons.js'
import { collectDom } from './ui/dom.js'
import { createGameOver } from './ui/gameOver.js'
import { createHud } from './ui/hud.js'
import { createHome } from './ui/home.js'
import { createSettings } from './ui/settings.js'

installToyIcons()

const board = new Board()
const platform = createCrazyGamesAdapter()
// Static DOM handles (refactor P1). The names are kept EXACTLY as they were when this file
// queried the document itself, so every use site below still reads the identifier it
// always did — this is a change of owner, not a change of behaviour. The scattered
// `#settings-close` / `#home-hero` / `#app` / `.topbar, .game-layout` queries further down
// stay where they are for now: each belongs to the panel that will own it (P1b-2), and
// moving them here would only move the scattering, not remove it.
const {
  sceneWrap,
  app: appEl,
  versionEl,
  scoreEl,
  bestEl,
  chainEl,
  chainValueEl,
  chainBarEl,
  statusEl,
  toastEl,
  honorLayerEl,
  slotsEl,
  piecesPanelEl,
  cancelZoneEl,
  itemBarEl,
  axisPickEl,
  axisCancelEl,
  settingsEl,
  settingsButtonEl,
  soundSettingEl,
  hapticsSettingEl,
  controlsEl,
  controlsButtonEl,
  controlsSettingEl,
  controlsCloseEl,
  axisHintEl,
  axisHintKeyEl,
  axisHintAxisEl,
  controlRows,
  gameOverEl,
  finalScoreEl,
  gameOverBestEl,
  gameOverFacesEl,
  gameOverHonorsEl,
  gameOverStatsEl,
  leaderboardButtonEl,
  leaderboardEl,
  leaderboardBodyEl,
  leaderboardCloseEl,
  leaderboardPlatformEl,
  homeEl,
  homeHeroEl,
  homePrimaryEl,
  homePrimaryLabelEl,
  homeBestEl,
  homeResumeNoteEl,
  homeLeaderboardEl,
  homeSettingsEl,
  homeSettingEl,
  gameLayers,
  settingsCloseEl,
  restartSettingEl,
} = collectDom()

// The version tag is ALWAYS shown (04「UI 与发布」; v0.2.20 regression, and the v0.8.21
// report that it was missing on a phone). It ships in the release build like everything
// else: "which build is this device actually running" is the one question a badge
// exists to answer, and a badge that only exists on the dev server cannot answer it.
// It only shrinks on narrow screens — never display:none.
versionEl.textContent = `v${packageInfo.version}`
let pieces = []
let selectedPiece = null
let drag = null
let viewDrag = null
let isPaused = false
let gameEnded = false
// The settings / controls open flags, the sound+haptics preferences and the legend's
// per-axis spin counters now live in ui/settings.js (plan §3 state table). Read back
// through `settingsUi.isOpen()` / `isControlsOpen()` / `getSoundOn()` / `getHapticsOn()`.
// v0.4 home screen: the cover's open flag lives in ui/home.js, read back through
// `homeUi.isOpen()`. `runLive` means "the player has entered a board and has not finished
// it", which is what makes a resume snapshot worth writing. They are separate on purpose:
// the game boots on the home screen with no run open, and writing a slot there would offer
// 继续游戏 on a board nobody has touched.
let runLive = false
let audioContext
let cameraShake = 0
let transientEffects = []
let suppressPieceClickUntil = 0
const particleSystems = new Set()
const piecePreviews = new Map()

// ============================================================
// Run state (v0.3 honors / records)
// ============================================================
// Everything the chain indicator, the Game Over panel and the record wall need to
// know about the run in progress. Nothing here is persisted as-is: endGame() hands
// it to recordStore, which owns the snapshot format and its migration.
const run = {
  chain: 0, // consecutive clearing placements; a dead turn zeroes it (08 §4.4)
  bestChain: 0,
  maxLinesOneMove: 0,
  maxFacesOneMove: 0,
  facesLit: new Set(), // faces cleared at least once this run (六面制霸 progress)
  faceWipes: 0,
  honors: [], // ids in the order they were earned
  honorCounts: {},
}
let runId = 0 // one token per game, so a score is never submitted twice
let bestScore = recordStore.best().score

// The Game Over card's presentation, wired to the run through a getter (see ui/gameOver.js).
const gameOverUi = createGameOver({
  els: { gameOverBestEl, gameOverFacesEl, gameOverHonorsEl, gameOverStatsEl },
  getRun: () => run,
})

// HUD presentation (see ui/hud.js). The factory only stores closures, so it can be built
// here: every getter is lazy and the item state it reads is declared further down.
const hud = createHud({
  els: {
    statusEl, toastEl, scoreEl, bestEl, chainEl, chainValueEl, chainBarEl,
    sceneWrap, honorLayerEl, itemBarEl, axisPickEl,
  },
  getScore: () => board.score,
  getBest: () => bestScore,
  getChain: () => run.chain,
  getItemCounts: () => itemCounts,
  getItemActive: () => itemActive,
  canUseItems: () => canUseItemsNow(),
  onChainBreak: (chain) => playChainBreakSound(chain),
})

// Bound to the module's own names so every existing call site below reads exactly as it
// always did — the bodies moved, the call sites did not.
const {
  setStatus,
  showToast,
  updateHud,
  showScorePop,
  updateChainHud,
  breakChainFeedback,
  showHonorBanner,
  clearHonorLayer,
  renderItemBar,
  renderAxisPick,
} = hud

function resetRun() {
  run.chain = 0
  run.bestChain = 0
  run.maxLinesOneMove = 0
  run.maxFacesOneMove = 0
  run.facesLit.clear()
  run.faceWipes = 0
  run.honors = []
  run.honorCounts = {}
  runId += 1
}

const quality = getRenderQuality()

// Wood grain is a canvas texture, and the signboards are DOM: paint them before
// the first frame so nothing pops in a frame late.
installWoodSkin()
installPastoralBackdrop(document.querySelector('#app'))

// The main scene — scene graph root, camera, renderer, the post chain, the framing solver
// and the resize path — now lives in rendering/gameScene.js (refactor P2b). Its objects are
// bound back to the names this file has always used, so every `camera.*` / `renderer.*` /
// `composer.*` use site below is unchanged: a change of owner, not of call sites.
// `getCubeGroup` and `metrics` are LAZY so the factory can run here, before `cubeGroup` and
// the lattice constants exist, while those values still come from ONE source — main's board
// constants (the plan forbids gameScene holding a second copy of the lattice arithmetic).
// It must run before `scene.add(cubeGroup)` below, which is why it sits here and not at the
// old renderer block.
const scene3d = createGameScene({
  sceneWrap,
  quality,
  getCubeGroup: () => cubeGroup,
  metrics: () => ({ half, cs, blockHalf: BLOCK_HALF }),
})
const {
  scene,
  camera,
  cameraTarget,
  renderer,
  composer,
  normalPass,
  contactDepth,
  occlusionEffect,
  toneMappingEffect,
  projectCubeBounds,
  cubeScreenBounds,
  gestureSpan,
  cubeExtent,
  resize,
  fitCameraToPlaySpace,
  zoomBy,
  getCameraZoom,
  getOrbitDistance,
  getCameraDir,
  getAppliedCanvasSize,
} = scene3d

// ============================================================
// Cube-face geometry
// ============================================================
const cs = 1.0 // cell pitch (lattice unit)
const half = (SH * cs) / 2 // 2.5 — cube half side
const cubeSide = SH * cs // 5

const cubeGroup = new THREE.Group()
scene.add(cubeGroup)

// The cube's coordinate system — per-face normals/in-plane axes, lattice cell -> local ->
// world — lives in rendering/boardView.js (refactor P3a). Bound back to the names this file
// has always used, so every conversion below is unchanged. The pitch and half-side stay
// main's own constants via `metrics()`: the plan forbids boardView holding a second copy of
// the lattice mapping. The group is read through a getter because it rotates.
const boardView = createBoardView({
  metrics: () => ({ cs, half }),
  getCubeGroup: () => cubeGroup,
})
const {
  FACE_PLANE,
  cubeVector,
  cellToWorld,
  cellLocal,
  cellWorld,
  facePlaneLocalCenter,
} = boardView

// Opaque timber body. The shell is only a BACKING: it occludes the far faces and
// fills the narrow notches between blocks (which is why it is darker than they are).
// It is inset behind them so that the blocks — not the shell — make up the surface
// of the big cube.
const cubeBodyMaterial = new THREE.MeshPhysicalMaterial({
  color: style.hullColor,
  map: woodGrainTextureRepeating(style.hullGrainRepeat),
  roughness: style.hullRoughness,
  clearcoat: style.hullClearcoat,
  clearcoatRoughness: 0.42,
  metalness: 0,
  transparent: false,
  opacity: style.hullOpacity,
  depthWrite: true,
})
const cubeBody = new THREE.Mesh(
  new RoundedBoxGeometry(cubeSide - style.hullInset, cubeSide - style.hullInset, cubeSide - style.hullInset, 3, style.hullRadius),
  cubeBodyMaterial,
)
cubeBody.renderOrder = -2
cubeBody.castShadow = false
cubeBody.receiveShadow = true
cubeGroup.add(cubeBody)

// The lattice <-> local <-> world conversions now live in rendering/boardView.js (P3a); the
// destructured names above are that module's functions.

// Every block on the board is centred in its lattice cell, exactly like the piece
// in the player's hand: half a block + the nudge the shell gives back is all the
// arithmetic there is, and it is written once.
const BLOCK_HALF = style.blockSize / 2
const PREVIEW_LIFT = BLOCK_HALF + style.previewLift
// THE block. ONE geometry instance is shared by the board's 98 blocks, the three
// candidate slots and the drag ghost, so a piece in the hand and a piece on the
// board are literally the same object — same size, same six flat faces, same bevel.
const blocks = createBlockResources({ cubeBody })

// Six 5×5 faces share their edge/corner cells: 98 unique blocks on the board,
// and every one of them is the SAME cube at the same gap from its neighbours, so
// no block can ever look taller, thicker or larger than any other. Placing a piece
// paints one of them; it does not add, grow, lift or move anything.
const gridGroup = new THREE.Group()
cubeGroup.add(gridGroup)
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
        const tone = blocks.toneIndexFor(...cell)
        const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.blockWoodMaterials[tone].idle)
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
buildFaceTiles()

// ============================================================
// Camera fit (cube rotates; camera stays put)
// ============================================================
// The camera-fit solver, the screen-space bounds queries and the gesture ruler all live in
// rendering/gameScene.js (refactor P2b) — reached through the destructured names above.

// ============================================================
// Renderer / post / lights
// ============================================================
// The renderer, the composer and the whole post chain are built in rendering/gameScene.js
// (refactor P2b); `renderer` / `composer` / `toneMappingEffect` / `normalPass` /
// `contactDepth` / `occlusionEffect` above are that module's instances.

addToyLights(scene, { shadows: true, lowPower: quality.lowPower })

const previewGroup = new THREE.Group()
const candidateGroup = new THREE.Group()
const fxGroup = new THREE.Group()
// The drag preview and the item-target overlay sit in the cube's local frame so
// they rotate with the cube (cells are positioned in cube-local coordinates).
cubeGroup.add(previewGroup)
scene.add(candidateGroup, fxGroup)

// ---- Drag ghost (v0.4.4) ----------------------------------------------------
// The piece the finger is carrying (see DRAG_GHOST in rendering/config.js). It
// hangs off the CAMERA rather than the cube: it must always face the player and
// never inherit the cube's rotation, and camera space turns "put it at this
// pixel, this big" into plain arithmetic (syncDragGhost). depthTest is off on
// every ghost material because the ghost is the one thing a drag may never hide:
// whatever it overlaps, the player has to be able to see the shape in hand.
const dragGhost = new THREE.Group()
dragGhost.visible = false
camera.add(dragGhost)
scene.add(camera) // the ghost rides the camera, so the camera joins the graph
// Reused per drag so tinting an invalid drop never reallocates a Color.
const dragGhostInvalid = new THREE.Color(palette.invalid)
const dragGhostInvalidEdge = new THREE.Color(palette.invalid).multiplyScalar(0.62)

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
  // may never come cannot leave rotation permanently blocked.
  viewDrag = null
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

// ============================================================
// Materials / helpers
// ============================================================
function colorToVector4(color, alpha = 1) {
  const normalized = new THREE.Color(color)
  return new THREE.Vector4(normalized.r, normalized.g, normalized.b, alpha)
}

// A piece in the hand is PAINTED WOOD: opaque colour over the same grain the shell
// uses, with a real varnish layer on top. The shared grain map is what ties the
// board to the signboards — the UI and the cube are visibly the same material
// (05「同源」), and a piece keeps this exact material from the tray, through the
// drag, onto the board.
// `makeMaterial`, the shared edge outline and the list of geometries a node may NOT
// dispose all live in rendering/blockResources.js (reached through `blocks`).
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
    if (child.geometry && !blocks.sharedGeometries.includes(child.geometry)) child.geometry.dispose()
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
      if (color !== undefined) tile.material = blocks.paintMaterial(color, tile.userData.tone)
      else tile.material = blocks.blockWoodMaterials[tile.userData.tone][active ? 'active' : 'idle']
    })
  })
}

function renderBoard() {
  occupiedColors = new Map(board.occupied().map((cell) => [`${cell.x},${cell.y},${cell.z}`, cell.color]))
  applyTileMaterials()
  updateHud()
}

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
// syncPause() reads introPlaying(), so every existing gate (drag, view drag, items,
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
  cubeGroup.updateMatrixWorld(true)
  const probe = new THREE.Vector3()
  let min = Infinity
  let max = -Infinity
  intro.entries.forEach((entry) => {
    // Screen-space diagonal: NDC has +x right and +y up, so (x + y) runs exactly
    // bottom-left → top-right. The depth term keeps the far side of the cube a
    // fraction of a beat behind the near side instead of interleaving with it, which
    // is what makes the front travel across the VISIBLE faces in one pass.
    probe.copy(entry.home).applyMatrix4(cubeGroup.matrixWorld).project(camera)
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
  syncPause()
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
  syncPause()
}

// The wave starts when the player can SEE the board. beginRun() is also called with
// the home cover still up (the 新游戏 path), and a wave played behind a cover would
// be over before the player arrived — so the two call sites are "a run just became
// visible" and "a run was rebuilt in place".
function armIntroIfVisible() {
  if (!homeUi.isOpen()) armIntro()
}

// ============================================================
// HUD / pieces / previews
// ============================================================
function makePiece(shape) {
  return { shape, cells: normalizeCells(shape.cells), used: false }
}

function currentCells(piece) {
  return piece.cells
}

function nextPieces() {
  pieces = Array.from({ length: 3 }, () => makePiece(pickShape()))
  selectedPiece = null
  renderPieceSlots()
}

function colorHex(color) {
  return `#${new THREE.Color(color).getHexString()}`
}

// Flat, face-on preview positions: (u,v) -> screen space (x right, y down).
// `pitch` is the cell edge: the slot thumbnails pack the cells tighter (0.8) so
// the outline fits the card, the drag ghost uses the board's own 1.0 pitch.
function flatPreviewPositions(cells, pitch = 0.8) {
  const maxU = Math.max(...cells.map(([u]) => u))
  const maxV = Math.max(...cells.map(([, v]) => v))
  const cx = maxU / 2
  const cy = maxV / 2
  return cells.map(([u, v]) => new THREE.Vector3((u - cx) * pitch, (cy - v) * pitch, 0))
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
  previewRenderer.toneMappingExposure = style.exposure
  previewRenderer.setClearColor(0x000000, 0)

  const previewScene = new THREE.Scene()
  addToyLights(previewScene)

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
    const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(piece.shape.color))
    mesh.scale.setScalar(0.7)
    mesh.position.copy(position)
    mesh.add(new THREE.LineSegments(blocks.edgeGeometry, new THREE.LineBasicMaterial({ color: outlineColor, transparent: true, opacity: style.voxelEdgeOpacity })))
    root.add(mesh)
    return mesh
  })
  piecePreviews.set(piece, { piece, slot, renderer: previewRenderer, scene: previewScene, camera: previewCamera, root, meshes, frameWidth: 0, frameHeight: 0 })
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
    if (preview.frameWidth !== width || preview.frameHeight !== height) {
      preview.renderer.setSize(width, height, false)
      preview.frameWidth = width
      preview.frameHeight = height
      // Fit the actual projected volume, including the cubes' depth. A 3×3
      // shape's oblique projection was taller than the old fixed 3.2-unit view.
      preview.root.updateMatrixWorld(true)
      preview.camera.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(preview.root).applyMatrix4(preview.camera.matrixWorldInverse)
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      const usable = Math.max(0.5, 1 - 20 / Math.min(width, height))
      const halfHeight = Math.max(1.6, size.y / (2 * usable), size.x * height / (2 * width * usable))
      const halfWidth = halfHeight * width / height
      preview.camera.left = center.x - halfWidth
      preview.camera.right = center.x + halfWidth
      preview.camera.top = center.y + halfHeight
      preview.camera.bottom = center.y - halfHeight
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

function setCancelZone(active, highlighted = false) {
  piecesPanelEl.classList.toggle('cancel-mode', active)
  piecesPanelEl.classList.toggle('cancel-hot', active && highlighted)
  cancelZoneEl.setAttribute('aria-hidden', String(!active))
}

// The cancel target is the UI strip the drag came from, not one element: since v0.4.3
// the item bar is a sibling of the candidate panel (it moves to the top on phones), and
// releasing a piece over either strip has always meant "put it back".
function isInsidePieceArea(event) {
  return [piecesPanelEl, itemBarEl].some((element) => {
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return false
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom
  })
}

function cancelActiveDrag(showFeedback = true) {
  if (!drag) return false
  const currentDrag = drag
  drag = null
  releaseDragPointer(currentDrag.source, currentDrag.pointerId)
  clearGroup(previewGroup)
  clearDragGhost()
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
// One place decides whether the board is live. Before v0.4 every call site wrote
// `isPaused` itself, which is the kind of state machine that grows a hole the
// moment a screen is added — and the home screen is that screen. Returns the new
// value so a caller can branch on it in the same statement.
function syncPause() {
  const previous = isPaused
  isPaused = homeUi.isOpen() || document.hidden || gameEnded
    || settingsUi.isOpen() || settingsUi.isControlsOpen() || introPlaying()
  // The item strip's only "not yet" affordance is a class derived from isPaused
  // (canUseItemsNow), so whoever changes the pause state has to restore it: the opening
  // wave and the settings panel both grey the buttons on the way in, and without this the
  // greying would outlive its reason. Caught by the v0.8.22 board shot — the four item
  // buttons were still grey after the wave had settled.
  if (isPaused !== previous) renderItemBar()
  return isPaused
}

function openSettings() {
  // Reachable from the home screen and from a finished run too: 回到主页 has to be
  // available "at any time", and the sounds/haptics switches are not less useful
  // after a game over than during one.
  // The pause source is set BEFORE the gestures are cancelled, exactly as before: the
  // cancel path reaches renderItemBar(), which reads the pause state.
  settingsUi.setSettingsOpen(true)
  if (drag) cancelActiveDrag(false)
  cancelItemSelection(true)
  clearGroup(previewGroup)
  clearDragGhost()
  settingsUi.showSettings()
  platform.gameplayStop()
  setStatus('Paused')
  settingsUi.updateSettingsUi()
  settingsUi.focusSettingsClose()
}

function closeSettings() {
  if (!settingsUi.isOpen()) return
  settingsUi.setSettingsOpen(false)
  settingsUi.hideSettings()
  if (!isPaused) {
    platform.gameplayStart()
    setStatus('Pick a shape')
  }
  settingsUi.focusSettingsButton()
}

// ============================================================
// PC keyboard rotation + its legend (v0.4.1, 03 §13)
// ============================================================
// A key press is not a second rotation model: it builds the very steps a committed
// one-face swipe builds — beginAxisGesture() snapshots the pose to turn from and the
// per-axis direction knob swipeAngle() multiplies, and startCubeSnap() planes it onto
// the 90° grid with the same spring. Turn the cube with W and with an upward swipe and
// it lands on the same pose, to the bit (asserted in the headless run: the pose delta
// is exactly a 90° rotation about the world axis).
//
// The one thing a key must NOT copy from a release is where the pose already is. A
// release hands over an angle the finger has spent 220ms pulling, so there is nothing
// left to animate; a key has no finger, and writing the angle through setLiveAngle()
// would put the cube straight onto the target pose — the settle would then animate
// pose-to-pose over zero distance and the cube would TELEPORT (v0.4.1 first pass, seen
// in the shot run). So the angle is written onto the gesture without rendering it, and
// the settle animates from the logical pose the cube is actually in (the gesture's
// `rendered` angle stays 0) — same duration, same easeOutCubic, same presentation
// fade-out-and-back as a drag that ends mid-flight.
function rotateCubeByKey(axis, direction) {
  // A turn still in flight is settled instantly rather than queued: fast repeated
  // presses stay with the fingers instead of lagging behind a backlog.
  if (cubeSnapAnim.active) settleCubeSnap()
  if (cubeLive) return false // a drag owns the pose right now
  beginAxisGesture(axis)
  const knob = axis === 'yaw' ? rotateStyle.yawDirection
    : axis === 'pitch' ? rotateStyle.pitchDirection : rotateStyle.rollDirection
  cubeLive.angle = direction * knob * ROT_STEP
  startCubeSnap(cubeLive)
  return true
}

// The legend's own feedback lives in ui/settings.js (`spinControlCube` / `showAxisHint`);
// this is the only remaining caller and it just routes the key.
//
// Returns true when the event was a rotation binding and has been consumed.
function handleRotateKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const binding = axisForKey(event.key)
  if (!binding) return false
  if (settingsUi.isControlsOpen()) {
    settingsUi.spinControlCube(binding.axis, binding.direction, event.key)
    return true
  }
  // Hold-to-repeat is off: one press = one face, exactly like one gesture = one face
  // (§3). A held key that spun the cube would be the only input in the game that can
  // outrun what the player sees.
  if (event.repeat) return true
  if (isPaused || drag || itemActive || homeUi.isOpen() || settingsUi.isOpen()) return false
  if (!rotateCubeByKey(binding.axis, binding.direction)) return true
  settingsUi.showAxisHint(event.key, binding.axis)
  return true
}

function openControls() {
  if (!settingsUi.openControls()) return
  platform.gameplayStop()
  setStatus('Paused')
  settingsUi.focusControlsClose()
}

function closeControls() {
  if (!settingsUi.closeControls()) return
  if (!isPaused) {
    platform.gameplayStart()
    setStatus('Pick a shape')
  }
  settingsUi.restoreControlsFocus()
}

function playTone(frequency, duration = 0.08, volume = 0.045, delay = 0) {
  if (!settingsUi.getSoundOn()) return
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
  if (settingsUi.getHapticsOn() && navigator.vibrate) navigator.vibrate(pattern)
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
let itemActive = null // { id, face, u, v, orientation }
let itemBusyUntil = 0
let lastItemHoverKey = null
// A press that has not moved far enough to become a cube turn (07 §3.1 A1/A2). An
// armed tool fires on RELEASE, not on press, so a mis-touch can still be turned into
// a rotation by moving the finger instead of spending the item; `itemUndo` below is
// the second safety net for everything the slop cannot catch.
let itemTap = null
// { id, records } while the 3s undo window is open (07 §3.1 A9).
let itemUndo = null
let itemUndoTimer = 0
// Same 6px slop the candidate drag uses to tell a tap from a gesture.
const ITEM_TAP_SLOP = 6

function itemTool(id) {
  return ITEM_TOOLS.find((tool) => tool.id === id)
}

function clampCellIndex(value) {
  return THREE.MathUtils.clamp(value, 0, SH - 1)
}

function canUseItemsNow() {
  return !gameEnded && !isPaused && !drag && !settingsUi.isOpen() && performance.now() >= itemBusyUntil
}

function setRocketOrientation(axis) {
  if (itemActive?.id !== 'rocket') return
  itemActive.orientation = axis === 'col' ? 'col' : 'row'
  lastItemHoverKey = null
  if (itemActive.u !== undefined) rebuildItemOverlay()
  renderAxisPick()
  setStatus(`Rocket line: ${itemActive.orientation === 'col' ? 'Column' : 'Row'}`)
}

// Closing the undo window also un-arms the toast, so a stale window can never keep a
// clickable "Undo" on screen after a placement or a new clear.
function clearItemUndo() {
  itemUndo = null
  if (itemUndoTimer) clearTimeout(itemUndoTimer)
  itemUndoTimer = 0
  toastEl.classList.remove('undoable')
}

// v0.6 (07 §3.1 A9): a clear is the one irreversible thing a mis-tap can do — the
// cubes come back with their original colours, the charge comes back, and the save
// slot is rewritten, so the undo is exact rather than cosmetic.
function undoItem() {
  if (!itemUndo) return
  const { id, records } = itemUndo
  clearItemUndo()
  toastEl.classList.remove('visible')
  const restored = board.addCells(records)
  const tool = itemTool(id)
  itemCounts[id] = Math.min(tool ? tool.cap : itemCounts[id] + 1, itemCounts[id] + 1)
  itemBusyUntil = 0
  renderBoard()
  renderItemBar()
  saveSession()
  playHaptic(8)
  setStatus('Pick a shape')
  showToast(restored ? `${restored} restored` : 'Nothing to restore')
  // Undoing back into the stuck board the clear had rescued is a real state, and the
  // only honest answer is the same check a placement runs: the run is over unless
  // something can still be played (07 §1.3).
  checkStuckAndPrompt()
}

function cancelItemSelection(silent = false) {
  itemTap = null
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
  itemTap = null
  itemBusyUntil = 0
  lastItemHoverKey = null
  clearGroup(itemPreviewGroup)
  axisPickEl.classList.add('hidden')
  clearItemUndo()
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
  // `fu`/`fv` are the unrounded lattice coordinates: where inside the cell the
  // pointer landed, which is what the rocket reads to pick its line (07 §3.1 A5).
  return { u: Math.round(uF), v: Math.round(vF), fu: uF, fv: vF }
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
  const normal = cubeVector(itemActive.face, 'n')
  scope.forEach(([x, y, z]) => {
    const occupied = board.has(x, y, z)
    const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(palette.valid, occupied ? 0.55 : 0.22))
    mesh.scale.setScalar(occupied ? 1 : 0.72)
    // The marker is a ghost of the BLOCK that would sit in this cell, lifted just
    // clear of the one already there so the two cannot z-fight.
    mesh.position.copy(cellToWorld(x, y, z)).addScaledVector(normal, PREVIEW_LIFT)
    itemPreviewGroup.add(mesh)
  })
}

// v0.6 (07 §3.1 A1/A2/A5/A8). Two fixes live here. The pointer only counts as a
// target when it is actually over the cube's screen silhouette — v0.5 intersected
// the front face's infinite plane instead, so aiming past the cube dragged the
// highlight onto a corner cell the player never pointed at. And the rocket picks
// Row/Col from where inside the cell the pointer sits (on the vertical centreline it
// reads as a column), with the panel left in place as the manual override.
function updateItemHover(ndc, allowOrientation = true) {
  if (!itemActive || itemActive.id === 'refresh') return
  const frontFace = findFrontFace()
  const cellAt = isPointerOnCube(ndc) ? ndcToCell(frontFace, ndc) : null
  if (!cellAt) return
  itemActive.face = frontFace
  itemActive.u = clampCellIndex(cellAt.u)
  itemActive.v = clampCellIndex(cellAt.v)
  if (allowOrientation && itemActive.id === 'rocket') {
    const du = cellAt.fu - cellAt.u
    const dv = cellAt.fv - cellAt.v
    const want = Math.abs(du) < Math.abs(dv) ? 'col' : 'row'
    if (want !== itemActive.orientation) {
      itemActive.orientation = want
      renderAxisPick()
    }
  }
  const key = `${itemActive.id}:${frontFace}:${itemActive.u},${itemActive.v}:${itemActive.orientation || ''}`
  if (key !== lastItemHoverKey) {
    lastItemHoverKey = key
    rebuildItemOverlay()
  }
}

function selectItemAt(event) {
  const ndc = eventNdc(event)
  const frontFace = findFrontFace()
  const cellAt = isPointerOnCube(ndc) ? ndcToCell(frontFace, ndc) : null
  if (!cellAt) {
    // Releasing off the cube is a miss, not a confirmation on some corner cell.
    setStatus('Tap a face cell')
    showToast('Tap a face cell')
    return
  }
  itemActive.face = frontFace
  itemActive.u = clampCellIndex(cellAt.u)
  itemActive.v = clampCellIndex(cellAt.v)
  confirmItem()
}

function confirmItem() {
  const { id, face, u, v } = itemActive
  if (u === undefined || v === undefined) return
  const scope = toolScopeCells(id, face, u, v)
  // Read the records before the removal: undo needs the colours, and `removeCells`
  // only hands back coordinates (07 §3.1 A9).
  const records = board.peekCells(scope)
  const removed = board.removeCells(scope)
  if (!removed.length) {
    // A silent miss read as "the button is broken" (07 §3.1 A6), so the failure now
    // says so on the toast and buzzes as well as setting the status line.
    setStatus('Nothing to clear there')
    showToast('Nothing to clear there')
    playHaptic(24)
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
  saveSession()
  clearItemUndo()
  itemUndo = { id, records }
  showToast(`Cleared ${removed.length} - Undo`, 3000)
  toastEl.classList.add('undoable')
  itemUndoTimer = setTimeout(() => {
    clearItemUndo()
    toastEl.classList.remove('visible')
  }, 3000)
  playHaptic(12)
  checkStuckAndPrompt()
}

function consumeItem(id) {
  itemCounts[id] = Math.max(0, itemCounts[id] - 1)
}

function activateItem(id) {
  // Tapping the armed tool again puts it away (07 §3.1 A3). Before v0.6 the same tap
  // cancelled and immediately re-armed, so a phone player — who has no Esc — could
  // not leave the mode without spending the item.
  if (itemActive?.id === id) {
    cancelItemSelection()
    return
  }
  if (itemActive) cancelItemSelection(true)
  if (!canUseItemsNow()) {
    renderItemBar()
    return
  }
  if (itemCounts[id] <= 0) {
    // Silence here is what made an empty slot feel broken (07 §3.1 A4).
    showToast(`No ${itemTool(id)?.name ?? id} left`)
    playHaptic(20)
    renderItemBar()
    return
  }
  if (id === 'refresh') {
    consumeItem('refresh')
    rerollPieces()
    return
  }
  itemActive = { id, face: null, u: undefined, v: undefined, orientation: id === 'bomb' ? '2x2' : 'row' }
  itemTap = null
  lastItemHoverKey = null
  // Arming a tool is moving on: a live undo toast must not stay clickable underneath
  // the targeting mode that is about to replace it (07 §3.1 A9).
  clearItemUndo()
  axisPickEl.classList.toggle('hidden', id !== 'rocket')
  renderAxisPick()
  setStatus(id === 'hammer' ? 'Tap a block to remove' : id === 'rocket' ? 'Tap a line to clear' : 'Tap a 2x2 area')
  renderItemBar()
}

function rerollPieces() {
  // A refresh replaces the batch the undo was recorded against, so the window closes.
  clearItemUndo()
  const before = pieces.map((piece) => piece.shape.name).join('|')
  for (let attempt = 0; attempt < 24; attempt += 1) {
    pieces = Array.from({ length: 3 }, () => makePiece(pickShape()))
    if (pieces.map((piece) => piece.shape.name).join('|') !== before) break
  }
  selectedPiece = null
  renderPieceSlots()
  showToast('Refreshed')
  playHaptic(10)
  renderItemBar()
  saveSession()
  checkStuckAndPrompt()
}

function hasPlaceablePiece() {
  return pieces.some((piece) => !piece.used && board.anyPlacement(piece.cells))
}

// 07 §3.1 B1 (v0.8.16): a jam no longer ends the run while a blocking-clear tool is
// still charged — the item that can open a hole has to be allowed to be used, or three
// of the four tools are decorative exactly when they matter. This is deliberately NOT a
// solvability check: whether hammer / rocket / bomb can actually open a legal spot is
// the player's judgement, and the exhaustive search (6 faces × 25 targets × 3 tools × 3
// candidate cells × their orientations) costs far more than it is worth. The charges
// are what keep this from looping: every prompt names a tool the player can spend, and
// the run ends when the last one is gone.
function hasBlockingClearTool() {
  return itemCounts.hammer > 0 || itemCounts.rocket > 0 || itemCounts.bomb > 0
}

function checkStuckAndPrompt() {
  if (gameEnded || isPaused || !pieces.length) return
  if (hasPlaceablePiece()) return
  if (itemCounts.refresh > 0) {
    setStatus('No spot - use Refresh')
    showToast('No spot - try Refresh')
    return
  }
  if (hasBlockingClearTool()) {
    setStatus('No spot - clear a path')
    showToast('No spot - clear a path')
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

for (const button of itemBarEl.querySelectorAll('.item-button')) {
  button.addEventListener('click', () => activateItem(button.dataset.item))
}
for (const button of axisPickEl.querySelectorAll('button[data-axis]')) {
  button.addEventListener('click', () => setRocketOrientation(button.dataset.axis))
}
axisCancelEl.addEventListener('click', () => cancelItemSelection())
toastEl.addEventListener('click', () => { if (itemUndo) undoItem() })

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
    // Where the piece was grabbed on the face (pointer px + the origin it attached
    // at). The piece then follows the finger RELATIVELY from here — see
    // updatePreview(). Null means "not attached": set on attach, cleared on detach.
    anchor: null,
  }
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // Some embedded browsers reject capture during an interrupted gesture.
  }
  // Built here (hidden) so the first pointermove that crosses the drag threshold
  // has the piece ready instead of popping it in a frame late.
  buildDragGhost(piece)
  event.currentTarget.classList.add('selected')
  setStatus('Drag to a face')
}

// Is the pointer on (or within snapMarginPx of) the cube's silhouette? The drag
// has exactly two states and this is the line between them: off the cube the
// piece is still IN HAND (only the ghost exists), on it the piece has ATTACHED to
// a face (only the landing preview exists). See DRAG_GHOST in rendering/config.js.
function isPointerOnCube(ndc) {
  const rect = renderer.domElement.getBoundingClientRect()
  const clientX = rect.left + (ndc.x * 0.5 + 0.5) * rect.width
  const clientY = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height
  const bounds = cubeScreenBounds()
  const margin = DRAG_GHOST.snapMarginPx
  return clientX >= bounds.minX - margin && clientX <= bounds.maxX + margin
    && clientY >= bounds.minY - margin && clientY <= bounds.maxY + margin
}

// One lattice step of a face, in client pixels. A finger delta is converted into
// (du, dv) on THIS basis, which is what makes the piece follow the finger's own
// direction on the face — including when the cube has been rotated to another face.
function faceStepScreen(face) {
  const rect = renderer.domElement.getBoundingClientRect()
  const toClient = (v) => {
    const p = v.project(camera)
    return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height }
  }
  const base = toClient(cellWorld(face, 0, 0))
  const stepU = toClient(cellWorld(face, 1, 0))
  const stepV = toClient(cellWorld(face, 0, 1))
  return {
    u: { x: stepU.x - base.x, y: stepU.y - base.y },
    v: { x: stepV.x - base.x, y: stepV.y - base.y },
  }
}

// Keep an origin inside the face's own bounds before asking the board about it.
function clampOrigin(cells, u, v) {
  const { u: uMax, v: vMax } = maxOrigin(cells, SH)
  return {
    u: THREE.MathUtils.clamp(u, 0, Math.max(uMax - 1, 0)),
    v: THREE.MathUtils.clamp(v, 0, Math.max(vMax - 1, 0)),
  }
}

// Returns true when a landing preview was actually drawn (i.e. the piece is
// attached to a face). Every field it owns is reset first: `finishDrag()` reads
// them as the drop decision, so "not attached" has to be a real, empty state.
//
// v0.4.6 — RELATIVE movement once attached. The piece is anchored where the finger
// first grabbed the face, and then follows the finger's own travel: one lattice
// step per cell of movement measured on the face's screen axes. Re-picking "the
// origin nearest the pointer" every frame (up to v0.4.5) meant the piece only moved
// once the finger had travelled all the way to the NEXT cell's centre — and with
// occupied cells in the way it could jump a long way, because the nearest LEGAL
// origin was no longer the nearest origin.
function updatePreview(event, ndc) {
  clearGroup(previewGroup)
  const previous = drag?.origin ?? null
  drag.face = null
  drag.origin = null
  drag.cells = null
  drag.valid = false
  if (!selectedPiece || !ndc || !drag?.active) { drag.anchor = null; return false }
  // Off the cube the piece goes back to being carried, and the next grab re-anchors.
  if (!isPointerOnCube(ndc)) { drag.anchor = null; return false }
  const face = findFrontFace()
  // Laid out on the front face the way the slot drew it — see
  // faceOrientedCells(). The board gets these exact cells on release.
  const cells = faceOrientedCells(face, currentCells(selectedPiece))
  drag.face = face
  drag.cells = cells

  const step = faceStepScreen(face)
  const det = step.u.x * step.v.y - step.u.y * step.v.x
  let origin = null
  if (drag.anchor && Math.abs(det) > 1e-3) {
    const dx = event.clientX - drag.anchor.x
    const dy = event.clientY - drag.anchor.y
    const u = drag.anchor.u + Math.round((dx * step.v.y - dy * step.v.x) / det)
    const v = drag.anchor.v + Math.round((step.u.x * dy - step.u.y * dx) / det)
    const target = clampOrigin(cells, u, v)
    // Sticky: an unreachable target leaves the piece where the player last had it.
    // It never re-snaps somewhere else, so the piece cannot jump out from under the
    // finger — and because the mapping stays anchored, it resumes exactly in step
    // with the finger once the way is clear again.
    origin = board.canPlace(face, cells, target) ? target : previous
  }
  if (!origin) origin = nearestOriginOnFace(face, ndc, cells)
  if (!origin) return false
  if (!drag.anchor) drag.anchor = { x: event.clientX, y: event.clientY, u: origin.u, v: origin.v }

  const valid = board.canPlace(face, cells, origin)
  drag.valid = valid
  drag.origin = origin
  const faceNormal = cubeVector(face, 'n')
  // The marker is a translucent ghost OF THE PIECE IN HAND, so it takes the piece's
  // OWN paint, not a fixed green: a green marker next to a purple piece in the tray
  // reads as two different objects, and it throws away the one colour that says which
  // of the three candidates is being placed. 05 §… "候选预览与棋盘同源" — the same
  // reasoning that makes the board, the tray and the drag ghost share one material.
  // Only the INVALID state keeps a colour of its own (`palette.invalid`, terracotta),
  // because there the colour is carrying a different message: "no room here".
  const markerColor = valid ? selectedPiece.shape.color : palette.invalid
  const markerEdge = valid
    ? new THREE.Color(selectedPiece.shape.color).multiplyScalar(0.58)
    : new THREE.Color(0x7a2a17)
  cells.forEach(([u, v]) => {
    const [cx, cy, cz] = faceLattice(face, u + origin.u, v + origin.v)
    // The landing marker IS a ghost of the block: same cube, same cell, same gap to
    // its neighbours. The player therefore sees the board it is about to get, not a
    // highlight floating over it (05 §6「落点预览」).
    const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(markerColor, 0.72))
    mesh.position.copy(cellToWorld(cx, cy, cz)).addScaledVector(faceNormal, PREVIEW_LIFT)
    mesh.add(new THREE.LineSegments(blocks.edgeGeometry, new THREE.LineBasicMaterial({
      color: markerEdge,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    })))
    previewGroup.add(mesh)
  })
  return true
}

// ---- Drag ghost (v0.4.4) ----------------------------------------------------
// 03 §4 has always asked for「鼠标按下方块后进入拖拽态，方块跟随光标移动」; until
// v0.4.4 the drag drew the landing cells on the board and nothing else, so the
// piece the player was holding had no on-screen existence at all. These four
// helpers are the whole feature: build it once when the gesture starts, place it
// on every pointermove, tint it by the drop state, drop it when the gesture ends.
function clearDragGhost() {
  dragGhost.visible = false
  clearGroup(dragGhost)
}

// One rounded voxel per cell, in the piece's own colour, with the slot preview's
// darkened outline — the ghost must read as the SAME object the player picked up
// (05「候选预览与棋盘同源」), not as a second visual language for dragging.
function buildDragGhost(piece) {
  clearGroup(dragGhost)
  const fill = new THREE.Color(piece.shape.color)
  const outline = fill.clone().multiplyScalar(0.58)
  const cells = currentCells(piece)
  // Rows the shape spans on screen: what the fingertip clearance is measured from.
  dragGhost.userData.rows = cells.reduce((max, [, v]) => Math.max(max, v), 0) + 1
  for (const position of flatPreviewPositions(cells, 1)) {
      const material = blocks.makeMaterial(piece.shape.color, DRAG_GHOST.opacity)
    // Fog is a depth cue for the board; at the ghost plane it would only wash the
    // piece out as the camera zooms.
    material.fog = false
    // Always on top: the ghost may never be swallowed by the cube it is about to
    // land on. Kept transparent from the start so tinting never has to rebuild
    // the material.
    material.depthTest = false
    material.depthWrite = false
    material.transparent = true
    const mesh = new THREE.Mesh(blocks.blockGeometry, material)
    mesh.position.copy(position)
    mesh.renderOrder = 12
    mesh.userData.fillColor = fill.clone()
    mesh.userData.edgeColor = outline.clone()
    const edges = new THREE.LineSegments(blocks.edgeGeometry, new THREE.LineBasicMaterial({
      color: outline,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      depthWrite: false,
    }))
    edges.renderOrder = 13
    mesh.add(edges)
    dragGhost.add(mesh)
  }
  dragGhost.visible = false
}

// `mode` is the state the drag is in: 'carry' (in hand, off the cube), 'snap' (the
// piece is on the board now — the ghost goes away, the landing preview is the
// piece), 'invalid' (on the cube but this face has no room) or 'cancel' (dragged
// back over the candidate/item strip).
function tintDragGhost(mode) {
  const invalid = mode === 'invalid'
  const opacity = mode === 'cancel' ? DRAG_GHOST.cancelOpacity
    : invalid ? DRAG_GHOST.invalidOpacity : DRAG_GHOST.opacity
  dragGhost.userData.mode = mode
  for (const mesh of dragGhost.children) {
    mesh.material.color.copy(invalid ? dragGhostInvalid : mesh.userData.fillColor)
    mesh.material.opacity = opacity
    const edges = mesh.children[0]
    if (edges) edges.material.color.copy(invalid ? dragGhostInvalidEdge : mesh.userData.edgeColor)
  }
}

// Put the ghost where the finger is. It lives in the camera's frame, so "at this
// pixel, this big" is linear algebra rather than a raycast — but the two corner
// rays are taken from the REAL projection matrices (unproject + worldToLocal)
// instead of a hand-rolled tan(fov/2). The camera's aspect belongs to the canvas
// the renderer actually draws into; whenever that disagreed with the CSS box, a
// hand-rolled formula sized and placed the ghost by the wrong factor with no
// error anywhere (v0.4.5: it was 16% off on desktop, which is part of what made
// the first version feel like it was not following the drag). unproject() cannot
// disagree with the renderer, because it is the renderer's own matrices.
const ghostPlaneMin = new THREE.Vector3()
const ghostPlaneMax = new THREE.Vector3()

function syncDragGhost(event, mode) {
  if (!drag || !dragGhost.children.length) return
  // v0.4.5: ONE piece per turn. The moment the piece attaches to a face the board
  // draws it, and the one in hand must not be there as well — the player read the
  // pair as "two blocks", which is exactly what it was.
  if (mode === 'snap') {
    dragGhost.visible = false
    dragGhost.userData.mode = mode
    return
  }
  const rect = renderer.domElement.getBoundingClientRect()
  const canvasHeight = Math.max(rect.height, 1)
  const distance = DRAG_GHOST.planeDistance
  camera.updateMatrixWorld(true)
  ghostPlaneMin.set(-1, -1, 0.5).unproject(camera)
  camera.worldToLocal(ghostPlaneMin)
  ghostPlaneMax.set(1, 1, 0.5).unproject(camera)
  camera.worldToLocal(ghostPlaneMax)
  const toPlane = distance / Math.max(-ghostPlaneMin.z, 1e-6)
  const halfWidth = (ghostPlaneMax.x - ghostPlaneMin.x) * 0.5 * toPlane
  const halfHeight = (ghostPlaneMax.y - ghostPlaneMin.y) * 0.5 * toPlane
  const worldPerPx = (2 * halfHeight) / canvasHeight

  const bounds = cubeScreenBounds()
  const cellPx = Math.max(bounds.maxX - bounds.minX, 1) / SH * DRAG_GHOST.cellRatio
  const ndc = eventNdc(event)
  // Touch carries the piece just above the fingertip: half its own height plus a
  // small clearance, so the whole shape clears the thumb instead of losing its
  // bottom row under it. The mouse gets a small fixed lift only — a shape-scaled
  // offset under a mouse reads as "not following the drag" (see DRAG_GHOST).
  const rows = dragGhost.userData.rows || 1
  const liftPx = event.pointerType === 'mouse'
    ? DRAG_GHOST.liftMousePx
    : DRAG_GHOST.liftTouchPx + Math.min(rows * cellPx * DRAG_GHOST.liftRatio, DRAG_GHOST.liftMaxPx)

  dragGhost.visible = true
  dragGhost.scale.setScalar(cellPx * worldPerPx)
  // Camera space: +X is screen-right and +Y is screen-up, exactly as NDC. (The X
  // term used to be negated — invisible in every check because they all aimed at
  // the canvas centre, where ndc.x is 0.)
  dragGhost.position.set(ndc.x * halfWidth, ndc.y * halfHeight + liftPx * worldPerPx, -distance)
  tintDragGhost(mode)
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
function updateCameraShake(delta) {
  cameraShake = Math.max(0, cameraShake - delta * FEEDBACK_STYLE.shakeDecay)
  camera.position.copy(getCameraDir()).multiplyScalar(getOrbitDistance() * getCameraZoom())
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

// One settled placement, in the order the design fixes it: settle every face
// (board.js) → chain → honors → score (§4.5) → present (§6). Keeping the whole
// sequence here is what makes the HUD number auditable — it is the sum of the
// named parts, and the parts are the ones the docs name.
function settlePlacement(face, cells, origin, color) {
  // A placement changes the board the undo was recorded against, so the window closes
  // before anything else happens (07 §3.1 A9).
  clearItemUndo()
  const result = board.place(face, cells, origin, color)
  const lines = result.lines
  const lineCount = lines.length
  const previousChain = run.chain
  run.chain = nextChain(previousChain, lineCount)
  if (lineCount > 0) {
    run.bestChain = Math.max(run.bestChain, run.chain)
    lines.forEach((line) => run.facesLit.add(line.face))
  }
  const honors = resolveHonors({ lines: lineCount, faces: result.facesHit })
  const level = feedbackLevel({ lines: lineCount, faces: result.facesHit })
  const score = moveScore({
    cellCount: cells.length,
    lines: lineCount,
    faces: result.facesHit,
    chain: run.chain,
    honorBonus: honors.bonus,
  })
  board.addScore(score.total, lineCount)
  run.maxLinesOneMove = Math.max(run.maxLinesOneMove, lineCount)
  run.maxFacesOneMove = Math.max(run.maxFacesOneMove, result.facesHit)
  run.faceWipes += result.faceWiped.length
  honors.ids.forEach((id) => {
    run.honors.push(id)
    run.honorCounts[id] = (run.honorCounts[id] || 0) + 1
  })
  return { result, lines, lineCount, honors, level, score, previousChain }
}

function finishDrag(event) {
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
  const currentDrag = drag
  drag = null
  releaseDragPointer(currentDrag.source, currentDrag.pointerId)
  clearGroup(previewGroup)
  clearDragGhost()
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
  const {
    result, lines, lineCount, honors, level, score, previousChain,
  } = settlePlacement(face, currentDrag.cells, currentDrag.origin, currentDrag.piece.shape.color)
  playPlaceSound(lineCount)
  playHaptic(lineCount > 1 ? [18, 35, 22] : lineCount ? [18, 28, 16] : 12)
  currentDrag.piece.used = true
  selectedPiece = null
  renderBoard()
  updateChainHud()
  updatePieceSlotSelection()
  if (lineCount) {
    showToast(`${lineCount} LINE${lineCount === 1 ? '' : 'S'}  x${lineMultiplier(lineCount)}  +${score.total}`)
    showScorePop(score.total, { lines: lineCount, faces: result.facesHit, honor: honors.primary })
    showHonorBanner(honors, level)
    spawnClearEffects(lines, level)
    playHonorSound(level)
    playChainSound(run.chain)
    triggerSlowMo(level)
    itemBusyUntil = performance.now() + 650
    setTimeout(renderItemBar, 720)
    setStatus('Clear! Keep building')
  } else {
    // §4.1: a building turn still pays, and still says so. A chain that was real
    // enough to be on screen must be seen breaking (§4.4).
    showScorePop(score.total, { quiet: true })
    if (previousChain >= HUD_STYLE.chainMinVisible) breakChainFeedback(previousChain)
    setStatus('Pick a shape')
  }
  if (pieces.every((piece) => piece.used)) nextPieces()
  // The resume slot is written on the same beat as the board change, and BEFORE the
  // stuck check: checkStuckAndPrompt() may end the run, and a snapshot written after
  // that would be a save of a finished game (saveSession refuses those anyway).
  saveSession()
  checkStuckAndPrompt()
}

// ============================================================
// Home screen + resume slot (v0.4, 03 §「主页与断点续玩」)
// ============================================================
// The home screen is an opaque cover over a live scene, not a second page: the
// board, the pose and the candidate previews all survive going home, and the only
// thing that has to be rebuilt after a page load is what session.js stored.
const shapeByName = new Map(SHAPES.map((shape) => [shape.name, shape]))

function sessionSnapshot() {
  return {
    board: {
      cells: board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]),
      score: board.score,
      totalLines: board.totalLines,
    },
    // Names, not shape objects: the pool is the single source of truth for a
    // candidate's colour and cells, so a snapshot can never resurrect a shape that
    // was retired from the pool (v0.2.24 的 5 长线、v0.2.31 的 4 长线).
    pieces: pieces.map((piece) => ({ name: piece.shape.name, used: piece.used })),
    items: { ...itemCounts },
    run: {
      chain: run.chain,
      bestChain: run.bestChain,
      maxLinesOneMove: run.maxLinesOneMove,
      maxFacesOneMove: run.maxFacesOneMove,
      facesLit: [...run.facesLit],
      faceWipes: run.faceWipes,
      honors: [...run.honors],
      honorCounts: { ...run.honorCounts },
    },
    pose: {
      // The LOGICAL pose plus the player's dialled bearing. The rendered quaternion
      // is a mid-animation value on the frames a save can land on, so it is never
      // saved; the bearing however IS player state now (v0.8.8) — a resumed run has
      // to come back at the angle the player dialled, not at the shipped default.
      // Old saves carrying `quat`/`yaw`/`pitch` still load: `base` was the only
      // load-bearing field they had.
      base: cubeBase.toArray(),
      bearingYaw,
      bearingPitch,
    },
  }
}

// Written after every mutation that changes the board or the candidates, so a
// browser closed mid-run resumes on the last placement rather than on the last
// visit home. Refuses once the run is over: endGame() clears the slot, and a save
// written after it would offer 继续游戏 on a finished game.
function saveSession() {
  if (!runLive || gameEnded) return false
  return sessionStore.save(sessionSnapshot())
}

function clearSession() {
  runLive = false
  return sessionStore.clear()
}

// Home cover + leaderboard (see ui/home.js). `openHome`/`leaveHome` stay here: they settle
// the intro wave, cancel a live drag, drop the item selection and write the resume snapshot.
// The cover's open flag lives in the module and is read back through `isOpen()`.
const homeUi = createHome({
  els: {
    app: appEl,
    homeEl,
    homeHeroEl,
    homePrimaryEl,
    homePrimaryLabelEl,
    homeBestEl,
    homeResumeNoteEl,
    leaderboardEl,
    leaderboardBodyEl,
    leaderboardCloseEl,
    leaderboardPlatformEl,
    gameLayers,
  },
  getSavedRun: () => sessionStore.read(),
  getBest: () => bestScore,
  getRecords: () => recordStore.all(),
  platform,
  cloneSources: { cubeBody, gridGroup },
  // Whoever changes the open state recomputes the pause lock — one place decides.
  onOpen: () => syncPause(),
  onClose: () => syncPause(),
})

// Bound to the module's own names so the existing call sites below read as they always did.
const {
  refreshHome,
  renderHomeBoard,
  openLeaderboard,
  closeLeaderboard,
} = homeUi

function openHome() {
  if (homeUi.isOpen()) return
  // The cover is about to be painted over the board, and the home's own hero is a
  // CLONE of the live tiles: settling first is what keeps a wave caught mid-flight
  // from being cloned into the hero as a half-built cube.
  settleIntro()
  if (drag) cancelActiveDrag(false)
  cancelItemSelection(true)
  clearGroup(previewGroup)
  clearDragGhost()
  // The panel is closed rather than kept behind the cover: it would otherwise still
  // be open (and still holding the socket) the next time the player opens it.
  settingsUi.setSettingsOpen(false)
  settingsUi.hideSettingsSilently()
  // Snapshot before the board stops being visible, so whatever was built is still
  // there behind the 继续游戏 button.
  saveSession()
  if (!homeUi.showCover()) return
  platform.gameplayStop()
  setStatus('Home')
  // Last, exactly where it was: focus lands on the cover's primary button only once the
  // cover is up and the run has announced itself to the platform.
  homeUi.focusPrimary()
}

function leaveHome() {
  homeUi.hideCover()
  renderItemBar()
  if (!isPaused) {
    platform.gameplayStart()
    setStatus('Pick a shape')
  }
  // Last, so the run has already announced itself to the platform before the wave
  // takes the input lock (syncPause() is the lock).
  armIntroIfVisible()
}

// Every entry point that starts a REAL run for the player (home 新游戏, the settings
// RESTART action, PLAY AGAIN) comes through here: a reset board is only a run once
// the player is looking at it, which is why the boot-time resetGame() does not.
function beginRun() {
  resetGame()
  runLive = true
  saveSession()
  // RESTART and PLAY AGAIN rebuild the run in place, with the player already looking
  // at the board: the wave plays again here. The 新游戏 path leaves this to
  // leaveHome(), which arms it once the run is actually visible.
  armIntroIfVisible()
}

function continueRun() {
  const saved = sessionStore.read()
  if (saved) {
    applySession(saved)
    runLive = true
  } else {
    beginRun()
  }
  leaveHome()
}

// The home screen's one play button. Its meaning comes from the slot, never from the
// label: a snapshot that appeared between two renders must not be lost to a stale
// class name on the button.
function startFromHome() {
  if (sessionStore.read()) continueRun()
  else {
    beginRun()
    leaveHome()
  }
}

function applySession(saved) {
  clearTransientEffects()
  clearHonorLayer()
  cameraShake = 0
  slowMo = null
  drag = null
  clearDragGhost()
  selectedPiece = null
  gameEnded = false
  setCancelZone(false)
  board.restore(saved.board)
  run.chain = saved.run.chain
  run.bestChain = saved.run.bestChain
  run.maxLinesOneMove = saved.run.maxLinesOneMove
  run.maxFacesOneMove = saved.run.maxFacesOneMove
  run.facesLit = new Set(saved.run.facesLit)
  run.faceWipes = saved.run.faceWipes
  run.honors = [...saved.run.honors]
  run.honorCounts = { ...saved.run.honorCounts }
  pieces = saved.pieces
    .map((entry) => {
      const shape = shapeByName.get(entry.name)
      if (!shape) return null
      const piece = makePiece(shape)
      piece.used = entry.used
      return piece
    })
    .filter(Boolean)
  // A retired shape can leave fewer than three candidates; deal the missing slots
  // instead of resuming with a short strip (the layout is a fixed row of three).
  while (pieces.length < 3) pieces.push(makePiece(pickShape()))
  itemCounts = Object.fromEntries(ITEM_TOOLS.map((tool) => [
    tool.id,
    THREE.MathUtils.clamp(Number.isFinite(saved.items[tool.id]) ? saved.items[tool.id] : tool.start, 0, tool.cap),
  ]))
  itemActive = null
  itemBusyUntil = 0
  lastItemHoverKey = null
  clearGroup(itemPreviewGroup)
  axisPickEl.classList.add('hidden')
  // Pose is restored from the LOGICAL base quaternion, so the cube comes back on
  // exactly the face it was left on (a face-aligned pose matters: the candidate's
  // drop orientation is derived from it), with the bearing the player had dialled —
  // clamped to the band, so a hand-edited or stale save cannot produce a bearing the
  // game would never have allowed. An unreadable pose starts face-aligned.
  if (saved.pose?.base) {
    cubeSnapAnim.active = false
    cubeLive = null
    viewDrag = null
    cubeBase.fromArray(saved.pose.base).normalize()
    const bandYaw = rotateStyle.bearingBand.yaw
    const bandPitch = rotateStyle.bearingBand.pitch
    bearingYaw = Number.isFinite(saved.pose.bearingYaw)
      ? THREE.MathUtils.clamp(saved.pose.bearingYaw, bandYaw.min, bandYaw.max) : rotateStyle.bearingYaw
    bearingPitch = Number.isFinite(saved.pose.bearingPitch)
      ? THREE.MathUtils.clamp(saved.pose.bearingPitch, bandPitch.min, bandPitch.max) : rotateStyle.bearingPitch
    cubeQuat.copy(bearingQuat(bearingYaw, bearingPitch)).multiply(cubeBase).normalize()
    applyCubeRotation()
  } else {
    resetCubeRotation()
  }
  renderPieceSlots()
  renderBoard()
  updateChainHud()
  renderItemBar()
  syncPause()
  setStatus('Pick a shape')
}

// L5 ceremony (08 §6): the only time-dilation in the game, ≤400ms at 0.6×, and it
// only scales the animation clock. Input never reads it, so a gesture during the
// dip is handled exactly as usual — the rule is "不得阻断输入".
let slowMo = null

function triggerSlowMo(level) {
  const config = FEEDBACK_STYLE.levels[level]?.slowMo
  if (config) slowMo = { scale: config.scale, until: performance.now() + config.ms }
}

function endGame() {
  if (gameEnded) return
  gameEnded = true
  clearItemUndo()
  syncPause()
  platform.gameplayStop()
  clearHonorLayer()
  const finalScore = board.score
  finalScoreEl.textContent = String(finalScore).padStart(4, '0')
  // Layer 1 first, and unconditionally (§7.4): a platform failure must never cost
  // the player their local record, and a missing localStorage must not throw here.
  const summary = recordStore.recordRun({
    score: finalScore,
    lines: board.totalLines,
    chain: run.bestChain,
    maxChain: run.bestChain,
    maxLinesOneMove: run.maxLinesOneMove,
    maxFacesOneMove: run.maxFacesOneMove,
    facesLit: run.facesLit.size,
    faceWipes: run.faceWipes,
    pureCubes: board.occupied().length === 0 ? 1 : 0,
    honors: run.honors,
    at: Date.now(),
  })
  bestScore = summary.bestScore
  updateHud()
  gameOverUi.renderGameOver(summary)
  // The run is in the record book now, so the save slot goes: a finished game must
  // never come back as 继续游戏. Cleared unconditionally, including when the player
  // reached it through the platform-less degraded path.
  clearSession()
  refreshHome()
  // Layer 2: exactly one submission per run, dropped silently when the game has no
  // leaderboard invitation (§7.4).
  platform.submitScore(finalScore, runId)
  gameOverEl.classList.remove('hidden')
}

function resetGame() {
  clearTransientEffects()
  clearHonorLayer()
  closeLeaderboard()
  board.clear()
  // v0.2.31: the cube starts with an opening layout instead of a bare shell
  // (config.js OPENING_LAYOUT). Seeding never scores or clears lines, so the HUD
  // still starts at 0 and the first placement is settled like any other.
  board.seedOpening(SHAPES, OPENING_LAYOUT)
  resetItems()
  resetRun()
  gameEnded = false
  settingsUi.setSettingsOpen(false)
  cameraShake = 0
  slowMo = null
  settingsUi.hideSettingsSilently()
  gameOverEl.classList.add('hidden')
  selectedPiece = null
  drag = null
  clearDragGhost()
  setCancelZone(false)
  resetCubeRotation()
  nextPieces()
  renderBoard()
  updateChainHud()
  setStatus('Pick a shape')
  syncPause()
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
    // The band is sampled once, where the finger goes down: a gesture never
    // switches meaning halfway through — neither its axis (cube span vs side band)
    // nor, in a side band, the direction the roll turns. Sampled after
    // settleCubeSnap() above, so it sees the pose the gesture will actually start
    // from.
    band: screenBand(event.clientX, cubeScreenBounds()),
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
    // Armed tool (v0.6, 07 §3.1 A1/A2). The press now does two things at once: it
    // aims (so a touch player, who has no hover, sees the highlight under their
    // finger before committing) and it hands the gesture to the view drag, so the
    // cube can still be turned to reach the face they want. Nothing fires here — the
    // release decides, and only if the pointer stayed inside ITEM_TAP_SLOP.
    itemTap = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY }
    updateItemHover(eventNdc(event))
    // beginViewDrag() prevents the default itself, but it bails out early while paused
    // or mid-drag — the item branch used to prevent unconditionally, so keep that.
    event.preventDefault()
    beginViewDrag(event)
    return
  }
  beginViewDrag(event)
})
window.addEventListener('pointermove', (event) => {
  if (viewDrag && event.pointerId === viewDrag.pointerId) {
    event.preventDefault()
    // Keep the armed target under the pointer, including while the cube turns to
    // bring another face round (07 §3.1 A1). The rocket only re-reads its Row/Col
    // from the cell offset while the gesture is still a tap: during a committed turn
    // the offsets change for reasons that have nothing to do with what was aimed at.
    if (itemActive) updateItemHover(eventNdc(event), !viewDrag.axis)
    const dx = event.clientX - viewDrag.startX
    const dy = event.clientY - viewDrag.startY
    if (!viewDrag.axis) {
      // Until a decisive dominant direction claims the gesture the pose does not
      // move at all: a few px of sideways drift must never be able to swallow a
      // vertical swipe (rendering/swipe.js).
      if (!gestureAxisReady(dx, dy)) return
      viewDrag.axis = pickGestureAxis(dx, dy, viewDrag.band)
      viewDrag.span = gestureSpan()
      // Claimed: snapshot the pose the gesture starts from (tilt + grid pose).
      beginAxisGesture(viewDrag.axis)
    }
    // Drag rotates the cube (not the camera). The claimed axis is the only one
    // that moves, and it is a FIXED world axis: the angle is applied to the pose
    // the cube happens to have, so it never turns with the cube. Each axis
    // carries its own direction sign and its own ruler (ROTATE_STYLE, swipe.js);
    // the roll is additionally signed by the band the gesture started in.
    setLiveAngle(swipeAngle(viewDrag.axis, dx, dy, viewDrag.span, viewDrag.band))
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
    // Back in the strip the piece is being put down, not held over a face: the next
    // arrival on the cube re-grabs wherever the finger is (v0.4.6).
    drag.anchor = null
    clearGroup(previewGroup)
    syncDragGhost(event, 'cancel')
    setStatus('Release to cancel')
    return
  }
  const ndc = eventNdc(event)
  drag.ndc = ndc
  const attached = updatePreview(event, ndc)
  // One piece per turn (v0.4.4): the ghost exists exactly while the piece is being
  // carried. Once it is attached to a face the board draws it and the carried copy
  // disappears; if the pointer is on the cube but this face has no room, the piece
  // stays in hand and turns red instead of silently vanishing.
  syncDragGhost(event, attached ? 'snap' : isPointerOnCube(ndc) ? 'invalid' : 'carry')
  if (attached) setStatus(drag.valid ? 'Release to place' : 'No room here')
  else setStatus(isPointerOnCube(ndc) ? 'No room on this face' : 'Drag to a face')
}, { passive: false })
window.addEventListener('pointerup', (event) => {
  const tap = itemTap
  itemTap = null
  finishViewDrag(event)
  finishDrag(event)
  if (!tap || event.pointerId !== tap.pointerId || !itemActive) return
  // Beyond the slop the gesture was a cube turn, not a target: nothing is spent.
  if (Math.hypot(event.clientX - tap.startX, event.clientY - tap.startY) >= ITEM_TAP_SLOP) return
  selectItemAt(event)
})
window.addEventListener('pointercancel', (event) => {
  itemTap = null
  finishViewDrag(event)
  if (!drag || event.pointerId !== drag.pointerId) return
  cancelActiveDrag(false)
})
renderer.domElement.addEventListener('wheel', (event) => {
  event.preventDefault()
  zoomBy(event.deltaY > 0 ? 0.92 : 1.08)
  fitCameraToPlaySpace()
}, { passive: false })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !leaderboardEl.classList.contains('hidden')) { event.preventDefault(); closeLeaderboard(); return }
  if (event.key === 'Escape' && settingsUi.isControlsOpen()) { event.preventDefault(); closeControls(); return }
  if (event.key === 'Escape' && itemActive) { event.preventDefault(); cancelItemSelection(); return }
  if (event.key === 'Escape' && drag) { event.preventDefault(); cancelActiveDrag(); return }
  if (event.key === 'Escape' && settingsUi.isOpen()) { closeSettings(); return }
  // W/S = X, A/D = Y, Q/E = Z (03 §13). Handled before the modal guard so the legend
  // can be learned while it is open, and before the rocket keys so nothing steals them.
  if (handleRotateKey(event)) { event.preventDefault(); return }
  if (settingsUi.isOpen() || settingsUi.isControlsOpen()) return
  if (itemActive?.id === 'rocket' && ['r', 'c'].includes(event.key.toLowerCase())) {
    setRocketOrientation(event.key.toLowerCase() === 'c' ? 'col' : 'row')
  }
})
window.addEventListener('contextmenu', (event) => {
  if (itemActive) { event.preventDefault(); cancelItemSelection(); return }
  if (!drag) return
  event.preventDefault()
  cancelActiveDrag()
})
leaderboardButtonEl.addEventListener('click', () => {
  if (gameEnded) openLeaderboard()
})
leaderboardCloseEl.addEventListener('click', () => {
  closeLeaderboard()
})
leaderboardEl.addEventListener('click', (event) => {
  if (event.target === leaderboardEl) closeLeaderboard()
})
// v0.4.1 controls card: the top bar entry (PC widths only), the settings row, and the
// backdrop/Escape ways out — the same three ways in as the other panels have. The settings
// panel's own listeners (gear, close, backdrop, the two switches, the restart row) and the
// controls card's four are registered by ui/settings.js from its own `bind()`, once.
// v0.4 home screen. 排行榜 opens the same Layer-1 panel the Game Over screen opens
// (the 总榜 reading of the board: 单局最高分 + 最近十局 + 荣誉收集), plus the platform
// entry at the bottom of the card.
homePrimaryEl.addEventListener('click', startFromHome)
homeLeaderboardEl.addEventListener('click', () => openLeaderboard())
homeSettingsEl.addEventListener('click', () => openSettings())
homeSettingEl.addEventListener('click', () => {
  // Already home: the row only has to close the panel it sits in.
  if (homeUi.isOpen()) closeSettings()
  else openHome()
})
// PLAY AGAIN / RESTART both start a real run, which means both have to open a resume
// slot: the reset board is the new unfinished game.
for (const button of document.querySelectorAll('#reset-button, #reset-modal')) button.addEventListener('click', beginRun)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && itemActive) cancelItemSelection(true)
  if (document.hidden && drag) cancelActiveDrag(false)
  // The undo toast is a pointer target, and a backgrounded tab must not leave a live
  // one behind for a click that will never come (07 §3.1 A9).
  if (document.hidden) clearItemUndo()
  // A page that goes hidden never delivers the pointerup of a finger that was
  // down, so the rotation gesture has to be ended here (see cancelViewDrag()).
  if (document.hidden) cancelViewDrag()
  // A run that is simply closed (tab, phone, browser) has to be resumable without
  // having visited the home screen first.
  if (document.hidden) saveSession()
  // A wave cannot play while the page is not painting, and a half-built cube waiting
  // behind a backgrounded tab is not what the player should come back to: it is
  // settled here rather than left for the browser to resume mid-air.
  if (document.hidden) settleIntro()
  syncPause()
  if (document.hidden) { platform.gameplayStop(); setStatus(homeUi.isOpen() ? 'Home' : 'Paused') }
  else if (gameEnded || settingsUi.isOpen() || homeUi.isOpen()) return
  else { platform.gameplayStart(); setStatus('Pick a shape') }
})
// Losing the window ends a mouse gesture the same way (button released outside).
window.addEventListener('blur', cancelViewDrag)

// Settings panel, controls card and their entries (see ui/settings.js). Built and bound
// once, here, after every orchestration function it calls exists. `bind()` returns a
// disposer and refuses to bind twice, so a future re-entry cannot double-register.
const settingsUi = createSettings({
  settingsEl,
  settingsButtonEl,
  settingsCloseEl,
  soundSettingEl,
  hapticsSettingEl,
  restartSettingEl,
  controlsButtonEl,
  controlsSettingEl,
  controlsEl,
  controlsCloseEl,
  axisHintEl,
  axisHintKeyEl,
  axisHintAxisEl,
  controlRows,
  onOpen: () => syncPause(),
  onClose: () => syncPause(),
})
settingsUi.bind({
  openSettings,
  closeSettings,
  openControls,
  closeControls,
  beginRun,
  playTone,
  playHaptic,
})
settingsUi.updateSettingsUi()

// The canvas is sized from the wrap's client box, but that box keeps changing
// AFTER the boot-time resize(): resetGame() is what fills `#piece-slots` and
// `#item-bar`, and those panels share the flex column with the board — so the wrap
// ends up ~100px shorter than it was when the renderer was last sized, and a
// content change fires no window `resize`. v0.4.5 found the consequence: on
// desktop the drawing buffer stayed 1048×720 while the CSS box was 1048×620, so
// the whole scene was displayed squashed ~14% vertically, and EVERY screen-space
// calculation (camera aspect, gesture ruler, drag ghost) was off by the same 16%.
// A ResizeObserver on the wrap is what actually tracks the layout. `setSize` runs
// with updateStyle=false, so re-running it cannot feed back into the observer.
// The canvas, the composer sizing and the observer all live in rendering/gameScene.js
// (refactor P2b). `resize` above is that module's function, called at the same two points
// in the boot sequence as before; the observer is registered here, once, where two lines
// used to register it.
scene3d.observeResize()
resize()
// v0.8.22 (03 §1): the game opens INSIDE a run. A refresh resumes the unfinished run if
// there is one and deals a new one if there is not — it never lands on the home cover,
// which used to cost a click before anything could be played. 主页 is now reachable only
// from the in-game settings (回到主页), which is also the only place that snapshots the
// run on the way out.
if (sessionStore.read()) {
  continueRun()
} else {
  beginRun()
  leaveHome()
}
// The trays were just filled, so the board's wrapper is shorter than it was when resize()
// measured it a moment ago; the ResizeObserver catches that, and the wave re-sorts itself
// once if it armed before the new size landed (see updateIntro()).
resize()
platform.initialize().catch(() => showToast('Offline mode'))

const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  const measure = clock.getDelta()
  const raw = Math.min(measure, 0.05)
  if (slowMo && performance.now() > slowMo.until) slowMo = null
  // The L5 dip scales the animation clock only — never input, never the board state.
  const delta = slowMo ? raw * slowMo.scale : raw
  // The home cover hides the canvas: nothing behind it is on screen, and the board
  // under it must not drift (the pose snap is part of the paused branch anyway).
  if (homeUi.isOpen()) return
  // The opening wave runs on its own clock. It is deliberately NOT inside the
  // `!isPaused` branch below: it is the thing that raised isPaused (that is the input
  // lock), so gating it there would deadlock it on its own first frame. It also gets
  // the UNCLAMPED delta: the 0.05s clamp exists so a stalled frame cannot teleport a
  // snap or a particle system, but applying it to the wave would stretch a 1.05s
  // introduction into five seconds of half-built cube on a device that cannot hold
  // 60fps. If the frames are that slow, the wave should simply be over.
  updateIntro(measure)
  if (!isPaused) {
    particleRenderer.update(delta)
    updateTransientEffects(delta)
    updateCubeSnap(delta)
  }
  // Bare tiles wear the lighter timber on the face the player is working on
  // (05 §2). 98 material assignments is cheap, but the cached front face means it
  // only happens on the frames where the cube actually finished turning. While a wave
  // is playing the blocks wear their own wave material instead and must not be
  // repainted under it.
  if (!introPlaying() && findFrontFace() !== tileFrontFace) applyTileMaterials()
  updatePiecePreviews()
  updateCameraShake(delta)
  composer.render(delta)
}
// Read-only introspection hook for the headless verification runs (the CDP
// checks assert that a swipe settles on a face-aligned pose). It exposes no
// mutable game state and is not used by any gameplay code path.
globalThis.__voxalblast = Object.freeze({
  version: packageInfo.version,
  rendering: () => {
    const tiles = gridGroup.children.flatMap((group) => group.children)
    return {
      meshes: tiles.length,
      uniqueCells: new Set(tiles.map((tile) => tile.userData.cell.join(','))).size,
      trianglesPerBlock: blocks.blockGeometry.attributes.position.count / 3,
      surfaceArt: blockSurfaceArtStatus(),
      environment: Boolean(scene.environment),
      hdr: composer.inputBuffer.texture.type === THREE.HalfFloatType,
      contactShadows: {
        independentDepth: normalPass.renderTarget.depthTexture === contactDepth && composer.stableDepthTexture === null,
        width: contactDepth.image.width,
        height: contactDepth.image.height,
        projectionMatches: occlusionEffect.ssaoMaterial.uniforms.projectionMatrix.value.equals(camera.projectionMatrix),
      },
      toneMapping: toneMappingEffect.mode,
      programs: renderer.info.programs?.length,
      lowPower: quality.lowPower,
    }
  },
  // `pose` is the rendered orientation; `base` is the logical grid pose it settles
  // around (a product of whole 90° steps about world axes, so it can never drift off
  // the grid); `bearing` is how far the player has dialled the view off the face, in
  // screen space, and `bearingDeg` the same in degrees. The Euler triples are
  // readability helpers for the checks (a pure yaw/pitch/roll pose decomposes exactly
  // in ZYX order).
  rotation: () => {
    const poseEuler = new THREE.Euler().setFromQuaternion(cubeQuat, 'ZYX')
    const baseEuler = new THREE.Euler().setFromQuaternion(cubeBase, 'ZYX')
    const bearingEuler = new THREE.Euler().setFromQuaternion(bearingQuat(bearingYaw, bearingPitch), 'ZYX')
    return {
      yaw: poseEuler.y,
      pitch: poseEuler.x,
      roll: poseEuler.z,
      baseYaw: baseEuler.y,
      basePitch: baseEuler.x,
      baseRoll: baseEuler.z,
      tiltYaw: bearingEuler.y,
      tiltPitch: bearingEuler.x,
      bearing: { yaw: bearingYaw, pitch: bearingPitch },
      bearingDeg: {
        yaw: Number(THREE.MathUtils.radToDeg(bearingYaw).toFixed(2)),
        pitch: Number(THREE.MathUtils.radToDeg(bearingPitch).toFixed(2)),
      },
      pose: cubeQuat.toArray(),
      base: cubeBase.toArray(),
      front: findFrontFace(),
      settling: cubeSnapAnim.active,
      live: cubeLive ? { axis: cubeLive.axis, angle: cubeLive.angle, rendered: cubeLive.rendered } : null,
    }
  },
  // v0.8.6 framing read-out: how the cube's screen silhouette is divided between
  // the faces that are actually visible, plus how far each of them is off the
  // camera axis and how far the main face's own lattice axes are from screen
  // right/down. This is the measurement the "停稳后主面 82–88%" acceptance is
  // graded on, and `skew` is the same number for the rotation: a face whose u axis
  // is not level on screen is a face the player sees tilted. Areas are exact
  // projected polygons (the three visible faces of a convex body tile the
  // silhouette), not a cosα·cosβ approximation. Read-only.
  faces: () => {
    camera.updateMatrixWorld()
    cubeGroup.updateMatrixWorld(true)
    const rect = renderer.domElement.getBoundingClientRect()
    const project = (v) => {
      const p = v.clone().project(camera)
      return { x: (p.x * 0.5 + 0.5) * rect.width, y: (0.5 - p.y * 0.5) * rect.height }
    }
    const quadArea = (pts) => {
      let sum = 0
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        sum += a.x * b.y - b.x * a.y
      }
      return Math.abs(sum) / 2
    }
    const toCamera = camera.position.clone().sub(cubeGroup.position).normalize()
    const entries = FACES.map((face) => {
      const n = cubeVector(face, 'n').applyQuaternion(cubeGroup.quaternion).normalize()
      const u = cubeVector(face, 'u').applyQuaternion(cubeGroup.quaternion).normalize()
      const v = cubeVector(face, 'v').applyQuaternion(cubeGroup.quaternion).normalize()
      const corner = (su, sv) => cubeGroup.position.clone()
        .addScaledVector(n, half).addScaledVector(u, su * half).addScaledVector(v, sv * half)
      const quad = project(corner(-1, -1))
      const across = project(corner(1, -1))
      const opposite = project(corner(1, 1))
      const along = project(corner(-1, 1))
      // VISIBILITY IS NOT `n · viewDirection > 0`. That is the orthographic test,
      // and it is wrong whenever the projection is not weak: the face plane sits
      // `half` off the cube's centre, so what decides is whether the CAMERA is on
      // the outer side of that face's own plane. With a close camera the
      // orthographic test calls a hidden side face "visible" and counts a quad that
      // is really tucked behind the front face — which is how a 5°/4° tilt measured
      // as "87% main face" while the cube on screen was a flat square with no side
      // face showing at all.
      const cameraSide = camera.position.clone()
        .sub(cubeGroup.position.clone().addScaledVector(n, half))
        .dot(n)
      const facing = n.dot(toCamera)
      // In-plane skew: how far the face's own +u edge runs from screen-right.
      // This INCLUDES perspective convergence (a receding edge is not parallel to
      // itself on screen, and should not be), so it is informational only —
      // `twistDeg` below is the number that answers "did this face arrive crooked".
      const skewDeg = THREE.MathUtils.radToDeg(Math.atan2(across.y - quad.y, across.x - quad.x))
      // How far the face is rotated about its own normal, measured in DIRECTION
      // space so perspective cannot contaminate it: project the face's +u direction
      // into the screen plane, take its angle from screen-right, and fold a quarter
      // turn (a face is legitimately presented in any of four rotations). This has
      // to come out the same on all 24 orientations — it is the check that the
      // presentation tilt lives in SCREEN space, because a cube-space tilt twists
      // each face by a different amount depending on which way it happens to face.
      const viewAxis = camera.getWorldDirection(new THREE.Vector3())
      const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      const flat = u.clone().addScaledVector(viewAxis, -u.dot(viewAxis)).normalize()
      const twistRaw = THREE.MathUtils.radToDeg(Math.atan2(flat.dot(camUp), flat.dot(camRight)))
      return {
        face,
        facing: Number(facing.toFixed(4)),
        cameraSide: Number(cameraSide.toFixed(4)),
        offAxisDeg: Number(THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(facing, -1, 1))).toFixed(2)),
        areaPx: Number(quadArea([quad, across, opposite, along]).toFixed(1)),
        skewDeg: Number((((skewDeg + 180) % 180) - 90).toFixed(2)),
        twistDeg: Number((((twistRaw % 90) + 135) % 90 - 45).toFixed(3)),
        visible: cameraSide > 0,
      }
    })
    // How far the BEARING leans the world vertical. 0 = the bearing is a pure
    // screen-space yaw, which cannot tip the cube at all. This is the "视觉上还比较歪"
    // number, and it has to stay ~0 for every bearing the player can dial.
    //
    // It is measured on the BEARING and not on the rendered pose on purpose: every
    // grid pose maps world axes to world axes (they are signed permutations), so a
    // grid-aligned cube can only ever be as plumb as the projection of the world axes
    // themselves — measuring the pose would report 180° for a legitimately
    // upside-down face and 90° for one that arrived by a roll, neither of which is a
    // lean. The only thing that can make the board LOOK tilted is a bearing
    // component that moves world Y sideways, and a yaw-last composition cannot.
    const tiltUp = new THREE.Vector3(0, 1, 0).applyQuaternion(bearingQuat(bearingYaw, bearingPitch))
    const uprightDeg = Number(THREE.MathUtils.radToDeg(Math.atan2(-tiltUp.x, Math.abs(tiltUp.y))).toFixed(3))
    const visible = entries.filter((entry) => entry.visible).sort((a, b) => b.areaPx - a.areaPx)
    const total = visible.reduce((sum, entry) => sum + entry.areaPx, 0)
    const front = visible[0]
    return {
      front: findFrontFace(),
      mainFaceMatches: front ? front.face === findFrontFace() : false,
      totalPx: Number(total.toFixed(1)),
      mainShare: total > 0 ? Number((front.areaPx / total).toFixed(4)) : 0,
      others: visible.slice(1).map((entry) => ({ face: entry.face, share: Number((entry.areaPx / total).toFixed(4)) })),
      visible,
      faces: entries,
      uprightDeg,
      camera: {
        position: camera.position.toArray().map((value) => Number(value.toFixed(3))),
        target: [cameraTarget.x, cameraTarget.y, cameraTarget.z].map((value) => Number(value.toFixed(3))),
        distance: Number(camera.position.distanceTo(cubeGroup.position).toFixed(3)),
        fovDeg: camera.fov,
        aspect: Number(camera.aspect.toFixed(4)),
        facePlaneHalf: half,
      },
    }
  },
  // v0.8.6 rotation read-out: the world-space increment between two rendered
  // poses, expressed in the camera's own frame. `screenDeg` is where the rotation
  // axis points on screen, measured from screen-right and folded to (-90°, 90°]:
  // 0° means the axis lies horizontally (a pitch — the front face slides up/down),
  // ±90° means the axis is vertical (a yaw — the cube turns left/right). A roll's
  // axis points at the camera, so it has no screen direction at all and shows up
  // as `alongView ≈ ±1` instead. This is the number behind "旋转中段发歪": while a
  // gesture's increment is a clean turn about one screen axis, this angle is flat
  // at 0 or 90 for the whole gesture. Read-only; the probe calls it with two
  // quaternions it just read from rotation().
  poseAxisScreen: (from, to) => {
    const a = new THREE.Quaternion().fromArray(from).normalize()
    const b = new THREE.Quaternion().fromArray(to).normalize()
    const delta = b.multiply(a.invert()).normalize()
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w)
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(delta.w, -1, 1))
    const magnitude = Math.hypot(delta.x, delta.y, delta.z)
    const axis = magnitude > 1e-9
      ? new THREE.Vector3(delta.x / magnitude, delta.y / magnitude, delta.z / magnitude)
      : new THREE.Vector3()
    camera.updateMatrixWorld()
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    const view = camera.getWorldDirection(new THREE.Vector3())
    return {
      angleDeg: Number(THREE.MathUtils.radToDeg(angle).toFixed(3)),
      axis: axis.toArray().map((value) => Number(value.toFixed(4))),
      screenDeg: Number(THREE.MathUtils.radToDeg(Math.atan2(axis.dot(up), axis.dot(right))).toFixed(3)),
      alongView: Number(axis.dot(view).toFixed(4)),
    }
  },
  // Screen-space cube box + framing numbers, used to check the "inside vs
  // outside the cube" gesture split and how much of the canvas the cube fills.
  bounds: () => cubeScreenBounds(),
  // The landing marker, next to the piece in hand. `cells[].color` is the material the
  // marker is actually wearing, so a check can assert it matches `pieceColor` while the
  // drop is legal and only turns into `palette.invalid` when it is not (v0.8.11 fixed
  // this: the marker used to be a fixed green whatever the candidate's colour was).
  // Read-only; no gameplay path reads it.
  preview: () => {
    const piece = selectedPiece
    const hex = (color) => `#${new THREE.Color(color).getHexString()}`
    return {
      piece: piece ? piece.shape.name : null,
      pieceColor: piece ? hex(piece.shape.color) : null,
      valid: drag?.valid === true,
      cells: previewGroup.children.map((mesh) => ({
        color: hex(mesh.material.color),
        opacity: Number(mesh.material.opacity.toFixed(3)),
      })),
    }
  },
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
  // v0.4.4 drag ghost: where the piece in hand actually is on screen. `cells` are
  // the client-pixel centres of the ghost's voxels (so a check can assert that the
  // ghost tracks the pointer within the lift offset and that a 3-cell piece really
  // drew three voxels), `cellPx` is the on-screen cell edge, and `mode` is the
  // state the drop is in. Read-only; no gameplay path reads it.
  ghost: () => {
    if (!dragGhost.parent) return { visible: false, count: 0, cells: [] }
    camera.updateMatrixWorld()
    dragGhost.updateWorldMatrix(true, true)
    const rect = renderer.domElement.getBoundingClientRect()
    const toScreen = (v) => {
      const p = v.clone().project(camera)
      return {
        x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
      }
    }
    const cells = dragGhost.children.map((mesh) => toScreen(mesh.getWorldPosition(new THREE.Vector3())))
    const fill = dragGhost.children[0]?.material
    // MEASURED cell pitch, not the number the placement code intended: project the
    // ghost's own +X axis (its layout pitch is exactly 1.0 local unit) and read the
    // pixels back off the screen. This is what catches a projection that disagrees
    // with the canvas the renderer is drawing into.
    const pitchFrom = toScreen(dragGhost.localToWorld(new THREE.Vector3(0, 0, 0)))
    const pitchTo = toScreen(dragGhost.localToWorld(new THREE.Vector3(1, 0, 0)))
    return {
      visible: dragGhost.visible,
      count: dragGhost.children.length,
      cells,
      // The ghost's own origin: what the lift is measured against (the cells'
      // centroid is not the group centre — an L or T piece is lopsided).
      center: toScreen(dragGhost.getWorldPosition(new THREE.Vector3())),
      cellPx: pitchTo.x - pitchFrom.x,
      opacity: fill ? fill.opacity : 0,
      color: fill ? `#${fill.color.getHexString()}` : null,
      // 'carry' | 'snap' | 'invalid' | 'cancel' — the state the drag is in. 'snap'
      // is the handoff: the ghost is hidden because the board is drawing the piece.
      mode: dragGhost.userData.mode ?? null,
      attached: Boolean(drag),
      // How many landing cells the board is drawing right now. The whole point of
      // the v0.4.5 revision is that this and `visible` are never both non-zero.
      previewCells: previewGroup.children.length,
      // Where the snapped piece is anchored on the face, and the grab point the
      // relative movement is measured from (v0.4.6).
      previewOrigin: drag?.origin ?? null,
      anchor: drag?.anchor ?? null,
      // The face's own lattice basis in client pixels — the basis the relative
      // movement is solved in. Exposed so a check can reproduce the mapping
      // exactly instead of assuming it.
      stepScreen: drag?.face ? faceStepScreen(drag.face) : null,
    }
  },
  framing: () => {
    const rect = renderer.domElement.getBoundingClientRect()
    const solid = cubeScreenBounds()
    const fitBox = projectCubeBounds(cubeExtent())
    return {
      canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.left + rect.width, bottom: rect.top + rect.height },
      solid,
      fitBox,
      fillX: (solid.maxX - solid.minX) / Math.max(rect.width, 1),
      fillY: (solid.maxY - solid.minY) / Math.max(rect.height, 1),
      bandLeft: solid.minX - rect.left,
      bandRight: rect.left + rect.width - solid.maxX,
      clipped: solid.minX < rect.left || solid.maxX > rect.left + rect.width || solid.minY < rect.top || solid.maxY > rect.top + rect.height,
      orbitDistance: getOrbitDistance(),
      zoom: getCameraZoom(),
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
    // The v0.3 regression assertion reads this: after ANY settled placement it must
    // be empty on all six faces (04「玩法与规则」残留满线条款) — place() settles
    // every face, so nothing can be left standing full.
    fullLines: board.findAllFullLines().map((line) => `${line.face}:${line.axis}:${line.axis === 'row' ? line.v : line.u}`),
    faceOccupancy: Object.fromEntries(FACES.map((face) => [face, board.faceOccupancy(face)])),
  }),
  // The run in progress: chain, per-run bests, which faces have been cleared and
  // the honors earned — what the Game Over panel and the records layer are fed from.
  run: () => ({
    chain: run.chain,
    bestChain: run.bestChain,
    maxLinesOneMove: run.maxLinesOneMove,
    maxFacesOneMove: run.maxFacesOneMove,
    facesLit: [...run.facesLit],
    faceWipes: run.faceWipes,
    honors: [...run.honors],
    honorCounts: { ...run.honorCounts },
  }),
  // The persisted Layer-1 snapshot (read-only: it is the same object the store hands
  // the UI, so the checks can prove a run round-tripped through storage).
  records: () => recordStore.all(),
  // v0.4 home + resume slot, read-only: what the cover is showing and whether a run
  // is waiting behind it (the checks assert the slot survives a page load, which is
  // the whole point of storing it).
  home: () => ({
    open: homeUi.isOpen(),
    label: homePrimaryLabelEl.textContent,
    note: homeResumeNoteEl.textContent,
    hasSavedRun: Boolean(sessionStore.read()),
    persistent: sessionStore.persistent,
  }),
  // v0.8.21 opening wave, read-only. Two halves, because the wave has to be graded on
  // both of them: what it is doing mid-flight (progress + the per-block schedule, so a
  // check can prove the front really runs bottom-left → top-right) and what it left
  // behind (`integrity`, measured against the AUTHORED transform of every block and
  // the shared material it must be wearing — not against whatever the last frame
  // happened to compute).
  intro: () => {
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
      return { active: false, plays: introPlays, locked: isPaused, integrity, blocks: tiles.length, progress: [] }
    }
    camera.updateMatrixWorld()
    cubeGroup.updateMatrixWorld(true)
    const probe = new THREE.Vector3()
    const primerHex = INTRO_STYLE.primer.colors.map((color) => `#${new THREE.Color(color).getHexString()}`)
    const progress = intro.entries.map((entry) => {
      probe.copy(entry.home).applyMatrix4(cubeGroup.matrixWorld).project(camera)
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
      locked: isPaused,
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
  },
  candidateFrames: () => [...piecePreviews.values()].map(preview => {
    preview.root.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(preview.root)
    const points = []
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      points.push(new THREE.Vector3(x, y, z).project(preview.camera))
    }
    return {
      name: preview.piece.shape.name,
      blocks: preview.meshes.length,
      minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
      minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)),
    }
  }),
  session: () => sessionStore.read(),
  // v0.4.1: the keyboard bindings the game actually honours. The headless check reads
  // this and compares it against the keycaps printed in the controls card, so a legend
  // can never advertise a key that does nothing (and vice versa).
  keys: () => KEY_BINDINGS.map((binding) => ({ axis: binding.axis, keys: [...binding.keys] })),
  controls: () => ({
    open: settingsUi.isControlsOpen(),
    axes: [...controlRows.keys()],
    spin: settingsUi.getControlSpin(),
  }),
  // The candidate pool itself: name, color and cell count per type.
  shapes: () => SHAPES.map((shape) => ({ name: shape.name, color: shape.color, size: shape.cells.length })),
})

// DEV-ONLY handles for the headless verification run. The two modal panels cannot be
// reached by playing: the model says a shell "jam" takes more than 600 placements
// (09 §3), so a screenshot run would never get there. These live behind
// import.meta.env.DEV, which vite replaces with `false` in the production build, so
// the shipped bundle does not contain them — and unlike the read-only hook above,
// they are never used by any gameplay path.
if (import.meta.env.DEV) {
  globalThis.__voxalblastDev = Object.freeze({
    endGame: () => endGame(),
    openLeaderboard: () => openLeaderboard(),
    records: () => recordStore.all(),
    // v0.8.21: replay the opening wave on demand, so the probe can drive it without
    // depending on where a click landed. It calls armIntro() itself — the same
    // function every real entry point calls.
    replayIntro: () => armIntro(),
    settleIntro: () => { settleIntro(); return introPlaying() },
    // v0.8.16 rescue probe (07 §3.1 B1). A shell jam is common in real play but cannot
    // be produced on demand, so the three judgement branches could not be asserted
    // without a way to build one: `jam()` fills every free shell cell (nothing fits
    // anywhere), `setItems()` sets the charges, and `stuckCheck()` runs the very same
    // judgement the gameplay path runs — no mock of it.
    setItems: (counts) => {
      for (const [id, count] of Object.entries(counts || {})) {
        if (id in itemCounts) itemCounts[id] = Math.max(0, Math.trunc(Number(count) || 0))
      }
      renderItemBar()
      return { ...itemCounts }
    },
    items: () => ({ ...itemCounts }),
    jam: () => {
      const records = []
      for (let x = 0; x < SH; x += 1) for (let y = 0; y < SH; y += 1) for (let z = 0; z < SH; z += 1) {
        if (isShell(x, y, z) && !board.has(x, y, z)) records.push({ x, y, z, color: 0 })
      }
      board.addCells(records)
      renderBoard()
      return { filled: records.length, occupied: board.occupied().length }
    },
    stuckCheck: () => checkStuckAndPrompt(),
    // Visual triggers for the headless UI checks: they call the very same functions
    // the gameplay path calls, so a screenshot of them is a screenshot of the real
    // rendering, not a hand-built mock of it.
    showChain: (chain) => {
      run.chain = Math.max(0, Math.trunc(chain) || 0)
      updateChainHud()
    },
    showHonor: (lines, faces) => {
      const honors = resolveHonors({ lines, faces })
      showHonorBanner(honors, feedbackLevel({ lines, faces }))
      return honors
    },
    showScorePop: (points, options) => showScorePop(points, options),
  })
}

applyCubeRotation()
animate()

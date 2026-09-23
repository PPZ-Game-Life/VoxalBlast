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
import { SH, FACES, faceLattice, isShell } from './game/board.js'
import { SHAPES, pickShape, maxOrigin } from './game/shapes.js'
import { lineMultiplier } from './game/scoring.js'
import { resolveHonors, feedbackLevel, HONORS } from './game/honors.js'
import { recordStore } from './game/records.js'
import { sessionStore } from './game/session.js'
import { createCrazyGamesAdapter } from './platform/crazygames.js'
import { DRAG_GHOST, getRenderQuality, HUD_STYLE, OPENING_LAYOUT, BOARD_STYLE as style, ROTATE_STYLE as rotateStyle } from './rendering/config.js'
import { KEY_BINDINGS } from './rendering/keyboard.js'
import './styles.css'
import './toy.css'
import { addToyLights } from './rendering/toyLights.js'
import { installWoodSkin, woodGrainTextureRepeating, blockSurfaceArtStatus } from './rendering/woodTexture.js'
import { createBlockResources } from './rendering/blockResources.js'
import { createGameScene } from './rendering/gameScene.js'
import { createBoardView } from './rendering/boardView.js'
import { createGameInput } from './input/gameInput.js'
import { createGameSession } from './game/gameSession.js'
import { createPieceView } from './rendering/pieceView.js'
import { createEffects } from './rendering/effects.js'
import { installPastoralBackdrop } from './rendering/pastoralBackdrop.js'
import { installToyIcons } from './ui/icons.js'
import { collectDom } from './ui/dom.js'
import { createGameOver } from './ui/gameOver.js'
import { createHud } from './ui/hud.js'
import { createHome } from './ui/home.js'
import { createSettings } from './ui/settings.js'

installToyIcons()

// The game's own data model -- the board, the hand, the run counters and the placement rule --
// lives in game/gameSession.js (refactor P6a). The board and the run record are const objects
// mutated in place, so they bind straight back to the names this file has always used; the two
// that are reassigned (the hand, the run token) go through accessors.
const session = createGameSession()
const board = session.board
const run = session.run
const {
  resetRun,
  deal,
  makePiece,
  currentCells,
  settlePlacement,
  getPieces,
  setPieces,
  getRunId,
  getItemCounts,
  setItemCharge,
  itemTool,
  resetItemCounts,
  spendItem,
  toolScopeCells,
  applyItem,
  openUndo,
  clearUndo,
  hasUndo,
  undoLast,
} = session
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
let selectedPiece = null
let drag = null
let isPaused = false
// The settings / controls open flags, the sound+haptics preferences and the legend's
// per-axis spin counters now live in ui/settings.js (plan §3 state table). Read back
// through `settingsUi.isOpen()` / `isControlsOpen()` / `getSoundOn()` / `getHapticsOn()`.
// v0.4 home screen: the cover's open flag lives in ui/home.js, read back through
// `homeUi.isOpen()`. `gameEnded` and `runLive` are the session's since P6b-2 — read back
// through `session.isEnded()` / `session.isSaveable()`.
let suppressPieceClickUntil = 0

// ============================================================
// Run state (v0.3 honors / records)
// ============================================================
// The run record and the run token live in game/gameSession.js (refactor P6a); `run` is bound
// above and the token is read through getRunId().
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
  getItemCounts: () => getItemCounts(),
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

// The cube's coordinate system and its pose model both live in rendering/boardView.js
// (refactor P3a/P3b). Bound back to the names this file has always used, so every conversion
// and every pose call below is unchanged. The pitch and half-side stay main's own constants
// via `metrics()`: the plan forbids boardView holding a second copy of the lattice mapping.
// The group and the camera are read live — the cube rotates, so a cached matrix would freeze
// the front-face test to the pose it was first drawn at.
const boardView = createBoardView({
  metrics: () => ({ cs, half }),
  getCubeGroup: () => cubeGroup,
  // blockResources is built after this factory (it needs cubeBody), so it arrives as a getter
  // rather than being captured -- the same lazy-binding rule as gameScene's metrics.
  getBlocks: () => blocks,
  // P3d: the wave re-sorts itself once when the wrapper resizes (the trays fill a frame or two
  // after a boot-time arm), and it is the thing that raises the pause lock. The applied canvas
  // size comes from gameScene; the lock goes back through the one pause setter; isPaused is a
  // read-only getter for the wave's own report.
  getAppliedCanvasSize,
  onIntroLock: () => syncPause(),
  isPaused: () => isPaused,
  camera,
  // A reset can land in the middle of a pointer gesture. The gesture record now lives in
  // input/gameInput.js (refactor P7a), so boardView asks for the drop through this callback
  // rather than reaching into it.
  onRotationReset: () => input.resetRotation(),
})
const {
  FACE_PLANE,
  cubeVector,
  cellToWorld,
  cellLocal,
  cellWorld,
  facePlaneLocalCenter,
  // The 98 tiles and the material they wear (P3c). `gridGroup` is a const Group mutated in
  // place, so it binds back to the name this file has always used; the rest are commands.
  gridGroup,
  attachTiles,
  sync: syncBoard,
  applyTileMaterials,
  // Opening creation wave (P3d). The names are the ones this file has always used, so every
  // call site below is unchanged; the report is assembled by boardView.introReport().
  introPlaying,
  armIntro,
  settleIntro,
  updateIntro,
  // Pose model (P3b). The three const objects are owned by boardView and mutated in place,
  // so binding them back to these names leaves every call site in this file untouched. The
  // module's two `let`s (the bearing and the live gesture) are NOT handed out this way: a
  // destructured copy would go stale the moment they are reassigned, so they go through
  // boardView.getBearing() / setBearing() / getLive() / setLive() instead.
  ROT_STEP,
  cubeBase,
  cubeQuat,
  cubeSnapAnim,
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
} = boardView

// The input layer -- the pointer coordinates, the gestures and the interaction gates -- lives in
// input/gameInput.js (refactor P7a). It owns no game state: every gate below is a read-only query
// and every effect is a named callback, so nothing in the module can reach the board, the score or
// the records (plan §2.1). This slice takes the view rotation and the keyboard; the piece drag
// (P7b), the item targeting (P7c) and the listeners themselves (P7d) follow.
//
// It is created here, before the boot-time resetGame() at the bottom of this file, because
// boardView's onRotationReset callback above reaches it.
const input = createGameInput({
  canvas: renderer.domElement,
  isPaused: () => isPaused,
  hasDrag: () => Boolean(drag),
  hasItemActive: () => Boolean(itemActive),
  isHomeOpen: () => homeUi.isOpen(),
  isSettingsOpen: () => settingsUi.isOpen(),
  isControlsOpen: () => settingsUi.isControlsOpen(),
  cubeScreenBounds,
  gestureSpan,
  cubeSnapAnim,
  ROT_STEP,
  settleCubeSnap,
  beginAxisGesture,
  setLiveAngle,
  startCubeSnap,
  getLive: () => boardView.getLive(),
  onItemHover: (ndc, allowOrientation) => updateItemHover(ndc, allowOrientation),
  onControlsSpin: (axis, direction, key) => settingsUi.spinControlCube(axis, direction, key),
  onAxisHint: (key, axis) => settingsUi.showAxisHint(key, axis),
})

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
// arithmetic there is, and it is written once. The block metrics stay this file's
// (gameScene is handed `blockHalf`); the marked-up cells the piece view draws — the landing
// marker and the item overlay — are handed the resulting lift.
const BLOCK_HALF = style.blockSize / 2
const PREVIEW_LIFT = BLOCK_HALF + style.previewLift
// THE block. ONE geometry instance is shared by the board's 98 blocks, the three
// candidate slots and the drag ghost, so a piece in the hand and a piece on the
// board are literally the same object — same size, same six flat faces, same bevel.
const blocks = createBlockResources({ cubeBody })

// The 98 blocks live in rendering/boardView.js (refactor P3c). attachTiles() runs here, where
// the group used to be attached and built: cubeGroup's child order is load-bearing (cubeBody
// carries renderOrder -2 and the preview groups are added after it).
boardView.attachTiles()

// The board's own single source of truth hands the painted cells to the view, which repaints
// the tiles from them; the HUD follows, in the order it always did.
function renderBoard() {
  syncBoard(board.occupied())
  updateHud()
}

// The piece view (refactor P4a/P4b) owns the candidate renderers, the landing marker and the
// drag ghost; this file owns the slot DOM and still decides where a piece may go.
const pieceView = createPieceView({
  blocks,
  // The landing marker is cube-local (it must turn with the cube) and the ghost is camera-local
  // (it must not), so each group attaches to its own parent inside the module. The camera itself
  // joins the scene below, where it always did — main assembles the graph, once.
  cubeGroup,
  camera,
  // The lattice -> world conversion and the face normal stay boardView's (P3a): plan §6 P4.4
  // forbids a second copy of the face basis.
  cellToWorld,
  cubeVector,
  // BLOCK_HALF + style.previewLift — the metrics stay this file's; the view is handed the lift
  // for both the landing marker and the item overlay (P4b/P4c).
  previewLift: PREVIEW_LIFT,
  // The renderer's CSS box: the ghost measures itself against the canvas the renderer actually
  // draws into, and that canvas belongs to gameScene (P2b).
  getCanvasRect: () => renderer.domElement.getBoundingClientRect(),
  // A new deal replaces the piece objects and every click reassigns the selection, so both are
  // read through getters rather than captured.
  getCells: currentCells,
  getSelectedPiece: () => selectedPiece,
})
const {
  disposePiecePreviews,
  createPiecePreview,
  updatePieceSlotSelection,
  updatePiecePreviews,
  // Landing marker (P4b): main still solves for the origin and the legality and hands the result
  // over; the module owns the group, the meshes and the two read-only counts.
  clearLanding,
  showLanding,
  landingCount,
  landingCells,
  // Drag ghost (P4b): built at drag start, placed on every pointermove, tinted by the drop
  // state, dropped when the gesture ends.
  buildDragGhost,
  clearDragGhost,
  syncDragGhost,
  ghostReport,
  // Item target overlay (P4c): main still decides which cells a tool covers and which of them are
  // already taken; the module draws the markers for the list it is handed.
  clearItemOverlay,
  showItemOverlay,
} = pieceView

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

const candidateGroup = new THREE.Group()
scene.add(candidateGroup)

// Effects (refactor P5) own the batched particle renderer, the line beams and stars, the shake,
// the slow-motion dip and the audio. The factory is called here, where its scene attachments
// used to be made, and it is handed the things this file used to close over.
const effects = createEffects({
  scene,
  camera,
  cubeGroup,
  cubeSide,
  cellToWorld,
  cubeVector,
  findFrontFace,
  quality,
  // Live getters, never captured booleans: the switches are read at the moment of the sound.
  getSoundOn: () => settingsUi.getSoundOn(),
  getHapticsOn: () => settingsUi.getHapticsOn(),
})
const {
  playTone,
  playHaptic,
  playPlaceSound,
  playHonorSound,
  playChainSound,
  playChainBreakSound,
  emitItemBurst,
  spawnClearEffects,
  triggerSlowMo,
  clearTransientEffects,
  resetShake,
  clearSlowMo,
} = effects
// ---- Drag ghost (v0.4.4) ----------------------------------------------------
// The ghost itself now lives in rendering/pieceView.js (refactor P4b) and hangs off the CAMERA
// rather than the cube. The camera therefore has to be part of the graph, and that stays this
// file's call: main assembles the scene graph, and a second scene.add(camera) from the module
// would add the same camera twice.
scene.add(camera) // the ghost rides the camera, so the camera joins the graph

// ============================================================
// Materials / helpers
// ============================================================

// A piece in the hand is PAINTED WOOD: opaque colour over the same grain the shell
// uses, with a real varnish layer on top. The shared grain map is what ties the
// board to the signboards — the UI and the cube are visibly the same material
// (05「同源」), and a piece keeps this exact material from the tray, through the
// drag, onto the board.
// `makeMaterial`, the shared edge outline and the list of geometries a node may NOT
// dispose all live in rendering/blockResources.js (reached through `blocks`).
// The particle geometry, the line/star geometries and the batched particle renderer live in
// rendering/effects.js (refactor P5). `blocks` is still this file's, and it is NOT one of them.


// The opening creation wave lives in rendering/boardView.js (refactor P3d): the 98 tiles it
// builds, the per-block material clone it reuses, the schedule it sorts and the pause lock it
// raises all belong to the view. This file binds its commands back to the names used below
// (introPlaying / armIntro / settleIntro / updateIntro) and assembles its read-only report.


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


// The deal itself is the session's (P6a); clearing the selection and repainting the slots are
// this file's, and they happen in the order they always did.
function nextPieces() {
  deal()
  selectedPiece = null
  renderPieceSlots()
}

function colorHex(color) {
  return `#${new THREE.Color(color).getHexString()}`
}

// The three candidate previews (refactor P4a) live in rendering/pieceView.js: each slot owns
// its own renderer, scene and camera, and the module owns the map holding them. renderPieceSlots
// below still builds the slot DOM and its pointer wiring -- that half moves to ui/hud only after
// the input state it reads has moved too (P7).

function renderPieceSlots() {
  disposePiecePreviews()
  slotsEl.innerHTML = ''
  getPieces().forEach((piece, index) => {
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
  clearLanding()
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
  isPaused = homeUi.isOpen() || document.hidden || session.isEnded()
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
  clearLanding()
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
// The keyboard rotation (rotateCubeByKey / handleRotateKey) moved to input/gameInput.js
// (refactor P7a). main still owns the Escape chain and the rocket keys below, and it is the
// one that tells the legend what to spin (settingsUi.spinControlCube / showAxisHint).

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

// The tone synthesis, the event-to-chord ladders and the haptic buzz live in
// rendering/effects.js (refactor P5); the sound/haptics switches reach it as live getters.

// ============================================================
// Items (front-face based)
// ============================================================
// The tool definitions and the charges live in game/gameSession.js (refactor P6b-1): they are
// game data, read back through getItemCounts() and spent through spendItem().
let itemActive = null // { id, face, u, v, orientation }
let itemBusyUntil = 0
let lastItemHoverKey = null
// A press that has not moved far enough to become a cube turn (07 §3.1 A1/A2). An
// armed tool fires on RELEASE, not on press, so a mis-touch can still be turned into
// a rotation by moving the finger instead of spending the item; the undo window in
// gameSession is the second safety net for everything the slop cannot catch.
let itemTap = null
// Same 6px slop the candidate drag uses to tell a tap from a gesture.
const ITEM_TAP_SLOP = 6


function clampCellIndex(value) {
  return THREE.MathUtils.clamp(value, 0, SH - 1)
}

function canUseItemsNow() {
  return !session.isEnded() && !isPaused && !drag && !settingsUi.isOpen() && performance.now() >= itemBusyUntil
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
// The session owns the window (data + timer); this file owns the toast that shows it. Clearing
// always goes through here, so the UI can never look undoable while the session cannot undo.
function clearItemUndo() {
  clearUndo()
  toastEl.classList.remove('undoable')
}

// v0.6 (07 §3.1 A9): a clear is the one irreversible thing a mis-tap can do — the
// cubes come back with their original colours, the charge comes back, and the save
// slot is rewritten, so the undo is exact rather than cosmetic.
function undoItem() {
  const undone = undoLast()
  if (!undone) return
  clearItemUndo()
  toastEl.classList.remove('visible')
  itemBusyUntil = 0
  renderBoard()
  renderItemBar()
  saveSession()
  playHaptic(8)
  setStatus('Pick a shape')
  showToast(undone.restored ? `${undone.restored} restored` : 'Nothing to restore')
  // Undoing back into the stuck board the clear had rescued is a real state, and the
  // only honest answer is the same check a placement runs: the run is over unless
  // something can still be played (07 §1.3).
  checkStuckAndPrompt()
}

function cancelItemSelection(silent = false) {
  itemTap = null
  if (!itemActive) {
    axisPickEl.classList.add('hidden')
    clearItemOverlay()
    return
  }
  itemActive = null
  lastItemHoverKey = null
  clearItemOverlay()
  axisPickEl.classList.add('hidden')
  if (!silent) setStatus('Pick a shape')
  renderItemBar()
}

function resetItems() {
  resetItemCounts()
  itemActive = null
  itemTap = null
  itemBusyUntil = 0
  lastItemHoverKey = null
  clearItemOverlay()
  axisPickEl.classList.add('hidden')
  clearItemUndo()
  renderItemBar()
}

// Pointer coordinates are the input layer's now (refactor P7a). Bound to the module's own
// function so the call sites still in this file (the item targeting and the piece drag, until
// P7b/P7c move them) read exactly as they always did.
const eventNdc = input.eventNdc

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


function rebuildItemOverlay() {
  clearItemOverlay()
  if (!itemActive || itemActive.u === undefined || itemActive.v === undefined) return
  const scope = toolScopeCells(itemActive.id, itemActive.face, itemActive.u, itemActive.v, itemActive.orientation)
  // The overlay itself is pieceView's (P4c): which cells a tool covers is the tool's rule, and
  // whether a cell already holds a block is the board's — both are this file's to answer, so the
  // module is handed the finished list.
  showItemOverlay({
    face: itemActive.face,
    cells: scope.map((cell) => ({ cell, occupied: board.has(cell[0], cell[1], cell[2]) })),
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
  const { records, removed } = applyItem(id, face, u, v, itemActive.orientation)
  if (!removed.length) {
    // A silent miss read as "the button is broken" (07 §3.1 A6), so the failure now
    // says so on the toast and buzzes as well as setting the status line.
    setStatus('Nothing to clear there')
    showToast('Nothing to clear there')
    playHaptic(24)
    return
  }
  spendItem(id)
  itemBusyUntil = performance.now() + 420
  setTimeout(renderItemBar, 450)
  emitItemBurst(removed, id)
  renderBoard()
  cancelItemSelection(true)
  setStatus('Pick a shape')
  renderItemBar()
  saveSession()
  clearItemUndo()
  // The window arms a couple of statements earlier than it used to (before the toast, not
  // after): at a 3000ms window that is not observable, and it keeps the data and the timer
  // in one place (plan section 2).
  openUndo({ id, records }, 3000, () => {
    clearItemUndo()
    toastEl.classList.remove('visible')
  })
  showToast(`Cleared ${removed.length} - Undo`, 3000)
  toastEl.classList.add('undoable')
  playHaptic(12)
  checkStuckAndPrompt()
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
  if (getItemCounts()[id] <= 0) {
    // Silence here is what made an empty slot feel broken (07 §3.1 A4).
    showToast(`No ${itemTool(id)?.name ?? id} left`)
    playHaptic(20)
    renderItemBar()
    return
  }
  if (id === 'refresh') {
    spendItem('refresh')
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
  const before = getPieces().map((piece) => piece.shape.name).join('|')
  for (let attempt = 0; attempt < 24; attempt += 1) {
    setPieces(Array.from({ length: 3 }, () => makePiece(pickShape())))
    if (getPieces().map((piece) => piece.shape.name).join('|') !== before) break
  }
  selectedPiece = null
  renderPieceSlots()
  showToast('Refreshed')
  playHaptic(10)
  renderItemBar()
  saveSession()
  checkStuckAndPrompt()
}

// The judgement itself (hasPlaceablePiece / hasBlockingClearTool / the three branches) lives in
// game/gameSession.js (refactor P6b-2): it only reads the hand, the board and the charges. What
// stays here is what the player sees and the one action the answer can trigger.
function checkStuckAndPrompt() {
  // `isPaused` is main's own pause calculation, so it stays in front of the session's judgement —
  // exactly where the old guard had it (the run being over and an empty hand are `idle` now).
  if (isPaused) return
  const outcome = session.stuckOutcome()
  if (outcome === 'refresh') {
    setStatus('No spot - use Refresh')
    showToast('No spot - try Refresh')
    return
  }
  if (outcome === 'clear-path') {
    setStatus('No spot - clear a path')
    showToast('No spot - clear a path')
    return
  }
  if (outcome === 'end') endGame()
}

// emitItemBurst() lives in rendering/effects.js (refactor P5): it is a particle system, and the
// module is handed the cells and asks boardView for the front face itself.

for (const button of itemBarEl.querySelectorAll('.item-button')) {
  button.addEventListener('click', () => activateItem(button.dataset.item))
}
for (const button of axisPickEl.querySelectorAll('button[data-axis]')) {
  button.addEventListener('click', () => setRocketOrientation(button.dataset.axis))
}
axisCancelEl.addEventListener('click', () => cancelItemSelection())
toastEl.addEventListener('click', () => { if (hasUndo()) undoItem() })

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

// Hand the drag ghost its three rulers. All three are this file's to measure: the pointer's NDC,
// the canvas it is over (the renderer's CSS box) and one cell of the cube as it is drawn right
// now (gameScene's screen bounds, exactly the ruler the ghost has always used). What is left —
// the two corner rays, the world-per-pixel scale and the tint — is the view's own arithmetic and
// lives in pieceView.syncDragGhost() (plan §6 P4.3).
function syncGhostFor(event, ndc, mode) {
  const bounds = cubeScreenBounds()
  syncDragGhost({
    ndc,
    canvasHeight: Math.max(renderer.domElement.getBoundingClientRect().height, 1),
    cellPx: Math.max(bounds.maxX - bounds.minX, 1) / SH * DRAG_GHOST.cellRatio,
    pointerType: event.pointerType,
    mode,
  })
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
  clearLanding()
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
  // The marker itself is pieceView's (P4b): it draws the cells it is handed, in the piece's own
  // colour while this drop is legal and in terracotta when it is not.
  showLanding({ face, cells, origin, valid, color: selectedPiece.shape.color })
  return true
}

// ---- Drag ghost (v0.4.4) ----------------------------------------------------
// The ghost — its group (camera-local), its material rules, its placement and its tint — lives
// in rendering/pieceView.js (refactor P4b). What stays here is everything the gesture decides:
// when it exists (buildDragGhost at pointerdown), where it goes (syncGhostFor measures the three
// rulers) and which mode it is in ('carry' | 'snap' | 'invalid' | 'cancel').

// The clear feedback - AxisEmitter, the line particles, the beam, the stars, the transient
// list and the camera shake - lives in rendering/effects.js (refactor P5).

// Pointer capture is the input layer's bookkeeping (refactor P7a); the piece drag below is the
// last caller in this file and moves with it in P7b.
const releaseDragPointer = input.releasePointerCapture

// One settled placement, in the order the design fixes it: settle every face
// (board.js) → chain → honors → score (§4.5) → present (§6). Keeping the whole
// sequence here is what makes the HUD number auditable — it is the sum of the
// named parts, and the parts are the ones the docs name.

function finishDrag(event) {
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
  const currentDrag = drag
  drag = null
  releaseDragPointer(currentDrag.source, currentDrag.pointerId)
  clearLanding()
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
  // A placement changes the board the undo was recorded against, so the window closes before
  // anything else happens (07 §3.1 A9) -- it used to be settlePlacement()'s own first line, and
  // it now sits here, in the same order, because the window is the item flow's (P6b).
  clearItemUndo()
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
  if (getPieces().every((piece) => piece.used)) nextPieces()
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
// The board, the hand, the run record and the charges come from the session (refactor P6b-2);
// the pose is boardView's and is merged in here, because the quaternion belongs to the module
// that owns the cube and the store below is main's.
function sessionSnapshot() {
  return {
    ...session.snapshot(),
    pose: {
      // The LOGICAL pose plus the player's dialled bearing. The rendered quaternion
      // is a mid-animation value on the frames a save can land on, so it is never
      // saved; the bearing however IS player state now (v0.8.8) — a resumed run has
      // to come back at the angle the player dialled, not at the shipped default.
      // Old saves carrying `quat`/`yaw`/`pitch` still load: `base` was the only
      // load-bearing field they had.
      base: cubeBase.toArray(),
      bearingYaw: boardView.getBearing().yaw,
      bearingPitch: boardView.getBearing().pitch,
    },
  }
}

// Written after every mutation that changes the board or the candidates, so a
// browser closed mid-run resumes on the last placement rather than on the last
// visit home. Refuses once the run is over: endGame() clears the slot, and a save
// written after it would offer 继续游戏 on a finished game. `isSaveable()` is the
// session's answer to "is there a run worth writing" (refactor P6b-2).
function saveSession() {
  if (!session.isSaveable()) return false
  return sessionStore.save(sessionSnapshot())
}

function clearSession() {
  session.setRunLive(false)
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
  clearLanding()
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
  session.setRunLive(true)
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
    session.setRunLive(true)
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
  resetShake()
  clearSlowMo()
  drag = null
  clearDragGhost()
  selectedPiece = null
  session.setEnded(false)
  setCancelZone(false)
  // The board, the run record, the hand and the charges (refactor P6b-2). The order around it is
  // unchanged: the pose below still comes after the hand, and the item strip after that.
  session.applySnapshot(saved)
  itemActive = null
  itemBusyUntil = 0
  lastItemHoverKey = null
  clearItemOverlay()
  axisPickEl.classList.add('hidden')
  // Pose is restored from the LOGICAL base quaternion, so the cube comes back on
  // exactly the face it was left on (a face-aligned pose matters: the candidate's
  // drop orientation is derived from it), with the bearing the player had dialled —
  // clamped to the band, so a hand-edited or stale save cannot produce a bearing the
  // game would never have allowed. An unreadable pose starts face-aligned.
  if (saved.pose?.base) {
    cubeSnapAnim.active = false
    boardView.setLive(null)
    input.resetRotation()
    cubeBase.fromArray(saved.pose.base).normalize()
    const bandYaw = rotateStyle.bearingBand.yaw
    const bandPitch = rotateStyle.bearingBand.pitch
    // Resolve both bearing components first, then hand them to the module in one call. The
    // clamp, the defaults and the write-then-applyCubeRotation() order are exactly as before.
    const restoredYaw = Number.isFinite(saved.pose.bearingYaw)
      ? THREE.MathUtils.clamp(saved.pose.bearingYaw, bandYaw.min, bandYaw.max) : rotateStyle.bearingYaw
    const restoredPitch = Number.isFinite(saved.pose.bearingPitch)
      ? THREE.MathUtils.clamp(saved.pose.bearingPitch, bandPitch.min, bandPitch.max) : rotateStyle.bearingPitch
    boardView.setBearing(restoredYaw, restoredPitch)
    cubeQuat.copy(bearingQuat(restoredYaw, restoredPitch)).multiply(cubeBase).normalize()
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

// slowMo and triggerSlowMo() live in rendering/effects.js (refactor P5); the frame loop reads
// the scaled delta back through effects.timestep().

function endGame() {
  if (session.isEnded()) return
  session.setEnded(true)
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
  platform.submitScore(finalScore, getRunId())
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
  session.setEnded(false)
  settingsUi.setSettingsOpen(false)
  resetShake()
  clearSlowMo()
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

// The view gesture (beginViewDrag / finishViewDrag / cancelViewDrag) moved to
// input/gameInput.js (refactor P7a). main's listeners below delegate to it.

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
    // beginViewGesture() prevents the default itself, but it bails out early while paused
    // or mid-drag — the item branch used to prevent unconditionally, so keep that.
    event.preventDefault()
    input.beginViewGesture(event)
    return
  }
  input.beginViewGesture(event)
})
window.addEventListener('pointermove', (event) => {
  // The view gesture owns the pointer while it is live, and it says so -- the same early
  // return the inline branch used to do, including the one that waits for a decisive
  // direction before the pose may move at all (refactor P7a).
  if (input.updateViewGesture(event)) return
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
    clearLanding()
    syncGhostFor(event, eventNdc(event), 'cancel')
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
  syncGhostFor(event, ndc, attached ? 'snap' : isPointerOnCube(ndc) ? 'invalid' : 'carry')
  if (attached) setStatus(drag.valid ? 'Release to place' : 'No room here')
  else setStatus(isPointerOnCube(ndc) ? 'No room on this face' : 'Drag to a face')
}, { passive: false })
window.addEventListener('pointerup', (event) => {
  const tap = itemTap
  itemTap = null
  input.finishViewGesture(event)
  finishDrag(event)
  if (!tap || event.pointerId !== tap.pointerId || !itemActive) return
  // Beyond the slop the gesture was a cube turn, not a target: nothing is spent.
  if (Math.hypot(event.clientX - tap.startX, event.clientY - tap.startY) >= ITEM_TAP_SLOP) return
  selectItemAt(event)
})
window.addEventListener('pointercancel', (event) => {
  itemTap = null
  input.finishViewGesture(event)
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
  if (input.handleRotateKey(event)) { event.preventDefault(); return }
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
  if (session.isEnded()) openLeaderboard()
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
  // down, so the rotation gesture has to be ended here (see input.cancelViewGesture()).
  if (document.hidden) input.cancelViewGesture()
  // A run that is simply closed (tab, phone, browser) has to be resumable without
  // having visited the home screen first.
  if (document.hidden) saveSession()
  // A wave cannot play while the page is not painting, and a half-built cube waiting
  // behind a backgrounded tab is not what the player should come back to: it is
  // settled here rather than left for the browser to resume mid-air.
  if (document.hidden) settleIntro()
  syncPause()
  if (document.hidden) { platform.gameplayStop(); setStatus(homeUi.isOpen() ? 'Home' : 'Paused') }
  else if (session.isEnded() || settingsUi.isOpen() || homeUi.isOpen()) return
  else { platform.gameplayStart(); setStatus('Pick a shape') }
})
// Losing the window ends a mouse gesture the same way (button released outside).
window.addEventListener('blur', () => input.cancelViewGesture())

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
  // The L5 dip scales the animation clock only — never input, never the board state.
  const delta = effects.timestep(raw)
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
    effects.update(delta)
    updateCubeSnap(delta)
  }
  // Bare tiles wear the lighter timber on the face the player is working on
  // (05 §2). 98 material assignments is cheap, but the cached front face means it
  // only happens on the frames where the cube actually finished turning. While a wave
  // is playing the blocks wear their own wave material instead and must not be
  // repainted under it.
  if (!introPlaying() && findFrontFace() !== boardView.getTileFrontFace()) applyTileMaterials()
  updatePiecePreviews()
  // The camera's resting position, restored every frame by its owner (gameScene owns the orbit
  // distance, the zoom and the direction); effects returns only the shake offset added on top.
  camera.position.copy(getCameraDir()).multiplyScalar(getOrbitDistance() * getCameraZoom())
  camera.position.add(effects.updateShake(delta))
  camera.lookAt(cameraTarget)
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
    // Read the two module-owned `let`s once, through their accessors. getBearing() hands
    // back a copy, so the read-out can never alias the module's own state.
    const bearing = boardView.getBearing()
    const live = boardView.getLive()
    const bearingEuler = new THREE.Euler().setFromQuaternion(bearingQuat(bearing.yaw, bearing.pitch), 'ZYX')
    return {
      yaw: poseEuler.y,
      pitch: poseEuler.x,
      roll: poseEuler.z,
      baseYaw: baseEuler.y,
      basePitch: baseEuler.x,
      baseRoll: baseEuler.z,
      tiltYaw: bearingEuler.y,
      tiltPitch: bearingEuler.x,
      bearing: { yaw: bearing.yaw, pitch: bearing.pitch },
      bearingDeg: {
        yaw: Number(THREE.MathUtils.radToDeg(bearing.yaw).toFixed(2)),
        pitch: Number(THREE.MathUtils.radToDeg(bearing.pitch).toFixed(2)),
      },
      pose: cubeQuat.toArray(),
      base: cubeBase.toArray(),
      front: findFrontFace(),
      settling: cubeSnapAnim.active,
      live: live ? { axis: live.axis, angle: live.angle, rendered: live.rendered } : null,
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
    const tiltBearing = boardView.getBearing()
    const tiltUp = new THREE.Vector3(0, 1, 0).applyQuaternion(bearingQuat(tiltBearing.yaw, tiltBearing.pitch))
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
      cells: landingCells(),
    }
  },
  // Candidate orientation on the current front face. `raw` is the top-left
  // layout the slot draws, `oriented` is what would actually be dropped, and
  // `uAxis` / `vAxis` project the lattice step the piece's +u / +v take, in
  // client pixels with dx > 0 = rightward and dy > 0 = upward (NDC convention).
  // A matching placement therefore has +u rightward and +v downward.
  placement: () => {
    const face = findFrontFace()
    const candidatePieces = getPieces()
    const piece = candidatePieces.find((candidate) => !candidate.used) || candidatePieces[0]
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
  // state the drop is in. Read-only; no gameplay path reads it. The fields arrive in
  // two halves (refactor P4b): pieceView measures the view, this file adds the gesture.
  ghost: () => ({
    // The view half — where the ghost's voxels actually are on screen, the measured cell pitch
    // and the tint it is wearing — is pieceView's projection (refactor P4b).
    ...ghostReport(),
    attached: Boolean(drag),
    // How many landing cells the board is drawing right now. The whole point of
    // the v0.4.5 revision is that this and `visible` are never both non-zero.
    previewCells: landingCount(),
    // Where the snapped piece is anchored on the face, and the grab point the
    // relative movement is measured from (v0.4.6).
    previewOrigin: drag?.origin ?? null,
    anchor: drag?.anchor ?? null,
    // The face's own lattice basis in client pixels — the basis the relative
    // movement is solved in. Exposed so a check can reproduce the mapping
    // exactly instead of assuming it.
    stepScreen: drag?.face ? faceStepScreen(drag.face) : null,
  }),
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
  intro: () => boardView.introReport(),
  candidateFrames: () => pieceView.candidateFrames(),
  // v0.8.23 (P5): what the effects layer is holding right now. Particle systems are not board
  // meshes, so no other read-out can prove they were released on a restart; the shake and the
  // slow-motion dip are otherwise invisible too. Read-only; no gameplay path reads it.
  effects: () => effects.report(),
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
    // v0.8.23 (P5): the L5 dip normally needs a 4-line clear to happen, which cannot be arranged
    // on demand. This calls the very same triggerSlowMo() the clear path calls, so "does the dip
    // block input" can be asserted instead of assumed.
    triggerSlowMo: (level) => triggerSlowMo(level),
    // v0.8.16 rescue probe (07 §3.1 B1). A shell jam is common in real play but cannot
    // be produced on demand, so the three judgement branches could not be asserted
    // without a way to build one: `jam()` fills every free shell cell (nothing fits
    // anywhere), `setItems()` sets the charges, and `stuckCheck()` runs the very same
    // judgement the gameplay path runs — no mock of it.
    setItems: (counts) => {
      for (const [id, count] of Object.entries(counts || {})) {
        setItemCharge(id, count)
      }
      renderItemBar()
      return getItemCounts()
    },
    items: () => ({ ...getItemCounts() }),
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

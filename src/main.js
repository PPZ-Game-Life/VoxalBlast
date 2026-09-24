import packageInfo from '../package.json'
import * as THREE from 'three'
// MUST come before the three.quarks import below: it bridges the r159 `updateRange` removal
// that otherwise throws inside animate() and freezes the canvas. rendering/gameScene.js owns
// the composer and imports this bridge for `skipComposerDepthBlit`, but gameScene itself is
// imported further down (after quarks), so relying on that would be relying on accident.
// Modules evaluate once, so this side-effect import and gameScene's named import are the
// same instance — it only pins the ORDER.
import './rendering/threeCompat.js'
import { SH, FACES, isShell } from './game/board.js'
import { OPENING_SHAPES } from './game/shapes.js'
import { lineMultiplier } from './game/scoring.js'
import { resolveHonors, feedbackLevel } from './game/honors.js'
import { recordStore } from './game/records.js'
import { sessionStore } from './game/session.js'
import { createCrazyGamesAdapter } from './platform/crazygames.js'
import { getRenderQuality, HUD_STYLE, OPENING_LAYOUT, BOARD_STYLE as style, ROTATE_STYLE as rotateStyle } from './rendering/config.js'
import './styles.css'
import './toy.css'
import './reference.css'
import { addToyLights } from './rendering/toyLights.js'
import { installWoodSkin } from './rendering/woodTexture.js'
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
import { createDiagnostics } from './diagnostics.js'

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
  currentCells,
  settlePlacement,
  getPieces,
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
// always did — this is a change of owner, not a change of behaviour. The panel-scoped
// `#settings-close` / `#home-hero` / `#app` / `.topbar, .game-layout` queries this file used to
// scatter further down are collected by ui/dom.js too (P1b-2), next to the handles above.
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
let isPaused = false
// The settings / controls open flags, the sound+haptics preferences and the legend's
// per-axis spin counters now live in ui/settings.js (plan §3 state table). Read back
// through `settingsUi.isOpen()` / `isControlsOpen()` / `getSoundOn()` / `getHapticsOn()`.
// v0.4 home screen: the cover's open flag lives in ui/home.js, read back through
// `homeUi.isOpen()`. `gameEnded` and `runLive` are the session's since P6b-2 — read back
// through `session.isEnded()` / `session.isSaveable()`.

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
    sceneWrap, honorLayerEl, itemBarEl, axisPickEl, slotsEl,
  },
  getScore: () => board.score,
  getBest: () => bestScore,
  getChain: () => run.chain,
  getItemCounts: () => getItemCounts(),
  getItemActive: () => input.getItemActive(),
  canUseItems: () => input.canUseItemsNow(),
  // The candidate strip's DOM half (P9). `input` and `pieceView` are both built further down
  // (the input layer at its own block, pieceView below the block resources), so the four that
  // belong to them arrive as lazy callbacks rather than captured bindings.
  getPieces: () => getPieces(),
  getSelectedPiece: () => input.getSelectedPiece(),
  bindSlot: (slot, piece) => input.bindSlot(slot, piece),
  disposePiecePreviews: () => pieceView.disposePiecePreviews(),
  createPiecePreview: (piece, canvas, slot) => pieceView.createPiecePreview(piece, canvas, slot),
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
  renderPieceSlots,
} = hud


const quality = getRenderQuality()

// Wood grain is a canvas texture, and the signboards are DOM: paint them before
// the first frame so nothing pops in a frame late.
installWoodSkin()
installPastoralBackdrop(appEl)

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
  // blockResources is built after this factory, so it arrives as a getter
  // rather than being captured -- the same lazy-binding rule as gameScene's metrics.
  getBlocks: () => blocks,
  // The moved `faces` read-out reports the camera target next to the camera itself,
  // so boardView needs it too. It is a const Vector3 gameScene mutates in place.
  getCameraTarget: () => cameraTarget,
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
  cubeVector,
  cellToWorld,
  cellWorld,
  facePlaneLocalCenter,
  // The 98 tiles and the material they wear (P3c). `gridGroup` is a const Group mutated in
  // place, so it binds back to the name this file has always used; the rest are commands.
  gridGroup,
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
// the records (plan §2.1). P7a took the view rotation and the keyboard, P7b the piece drag; the
// item targeting (P7c) and the listeners themselves (P7d) follow.
//
// It is created here, before the boot-time resetGame() at the bottom of this file, because
// boardView's onRotationReset callback above reaches it. Everything it is handed is either a
// read-only query, a piece of geometry it must not own, or a named callback -- never a module.
const input = createGameInput({
  canvas: renderer.domElement,
  isPaused: () => isPaused,
  isEnded: () => session.isEnded(),
  isHomeOpen: () => homeUi.isOpen(),
  isSettingsOpen: () => settingsUi.isOpen(),
  isControlsOpen: () => settingsUi.isControlsOpen(),
  cubeScreenBounds,
  gestureSpan,
  zoomBy,
  fitCameraToPlaySpace,
  cubeSnapAnim,
  ROT_STEP,
  settleCubeSnap,
  beginAxisGesture,
  setLiveAngle,
  startCubeSnap,
  getLive: () => boardView.getLive(),
  findFrontFace,
  faceOrientedCells,
  cellWorld,
  cubeVector,
  facePlaneLocalCenter,
  camera,
  cubeGroup,
  cs,
  canPlace: (face, cells, origin) => board.canPlace(face, cells, origin),
  currentCells: (piece) => currentCells(piece),
  toolScope: (id, face, u, v, orientation) => toolScopeCells(id, face, u, v, orientation),
  isOccupied: (cell) => board.has(cell[0], cell[1], cell[2]),
  cancelZones: () => [piecesPanelEl, itemBarEl],
  onControlsSpin: (axis, direction, key) => settingsUi.spinControlCube(axis, direction, key),
  onAxisHint: (key, axis) => settingsUi.showAxisHint(key, axis),
  // The Escape chain, split where the gesture branches sit inside it: the two panels that
  // outrank a live gesture, then the one that does not. Both do their own preventDefault.
  onEscapeBeforeGestures: (event) => {
    if (!leaderboardEl.classList.contains('hidden')) { event.preventDefault(); closeLeaderboard(); return true }
    if (settingsUi.isControlsOpen()) { event.preventDefault(); closeControls(); return true }
    return false
  },
  onEscapeAfterGestures: () => {
    if (settingsUi.isOpen()) { closeSettings(); return true }
    return false
  },
  isModalOpen: () => settingsUi.isOpen() || settingsUi.isControlsOpen(),
  onItemBar: () => renderItemBar(),
  onAxisPick: () => renderAxisPick(),
  onAxisPickVisibility: (hidden) => axisPickEl.classList.toggle('hidden', hidden),
  onClearOverlay: () => clearItemOverlay(),
  onShowOverlay: (params) => showItemOverlay(params),
  onConfirmItem: () => confirmItem(),
  onStatus: (text) => setStatus(text),
  onToast: (text) => showToast(text),
  onHaptic: (pattern) => playHaptic(pattern),
  onCancelZone: (active, highlighted) => setCancelZone(active, highlighted),
  onSelectionChanged: () => updatePieceSlotSelection(),
  onBuildGhost: (piece) => buildDragGhost(piece),
  onSyncGhost: (params) => syncDragGhost(params),
  onClearGhost: () => clearDragGhost(),
  onClearLanding: () => clearLanding(),
  onShowLanding: (params) => showLanding(params),
  onDrop: (drop) => onDrop(drop),
})

// The opaque timber body of the cube — its material and its inset RoundedBoxGeometry — is
// created by rendering/blockResources.js since refactor P9: that module already owns the block
// geometry the shell is measured against, and main must not create geometry or materials
// (plan §8). What stays here is the scene graph: the shell is added to cubeGroup BEFORE the 98
// tiles, and that child order is load-bearing (the shell carries renderOrder -2).

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
// The shell's half-side is handed in lazily for the same reason gameScene gets `metrics`:
// the lattice arithmetic stays this file's, and the factory runs before nothing else needs it.
const blocks = createBlockResources({ metrics: () => ({ cubeSide }) })
cubeGroup.add(blocks.cubeBody)

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
  getSelectedPiece: () => input.getSelectedPiece(),
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
// this file's, and they happen in the order they always did. v0.9.0 P1: the deal can now REFUSE
// — when the cube has no legal placement left for any shape, the session leaves the used batch
// in place rather than emptying the hand, because an empty hand reads as `idle` and would skip
// the stuck flow that is supposed to handle exactly this position.
function nextPieces() {
  const result = deal()
  input.clearSelection()
  renderPieceSlots()
  return result
}

// The three candidate previews (refactor P4a) live in rendering/pieceView.js: each slot owns
// its own renderer, scene and camera, and the module owns the map holding them. The slot DOM
// itself -- the buttons, the chip colour, the thumbnail canvases and the pointer wiring --
// moved to ui/hud.js in P9; the previews themselves stay in pieceView.

function setCancelZone(active, highlighted = false) {
  piecesPanelEl.classList.toggle('cancel-mode', active)
  piecesPanelEl.classList.toggle('cancel-hot', active && highlighted)
  cancelZoneEl.setAttribute('aria-hidden', String(!active))
}

// isInsidePieceArea() and cancelActiveDrag() moved to input/gameInput.js (refactor P7b); the
// cancel ZONE it highlights stays here, because setCancelZone() above is DOM.

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
  if (input.hasDrag()) input.cancelActiveDrag(false)
  input.cancelItemSelection(true)
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
// The keyboard rotation (handleRotateKey) moved to input/gameInput.js (refactor P7a). main
// still owns the Escape chain and the rocket keys below, and it is the one that tells the
// legend what to spin (settingsUi.spinControlCube / showAxisHint).

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
// game data, read back through getItemCounts() and spent through spendItem(). The targeting
// mode, the tap slop, the hover, the rocket's Row/Col and the busy gate moved to
// input/gameInput.js (refactor P7c); what USING a tool does to the board stays here.

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
  input.releaseItems()
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

// A new run: the charges are the session's, the targeting state is the input layer's, and
// the undo window plus the strip are this file's. The order is the one it always ran in.
function resetItems() {
  resetItemCounts()
  input.resetItemTargeting()
  clearItemUndo()
  renderItemBar()
}

// The item targeting (the hover, the tap, the overlay it draws) moved to input/gameInput.js
// (refactor P7c), together with the pointer coordinates it measured. What stays here is the
// business of USING a tool: confirmItem() below and activateItem() after it.

function confirmItem() {
  const { id, face, u, v, orientation } = input.getItemActive()
  if (u === undefined || v === undefined) return
  const { records, removed } = applyItem(id, face, u, v, orientation)
  if (!removed.length) {
    // A silent miss read as "the button is broken" (07 §3.1 A6), so the failure now
    // says so on the toast and buzzes as well as setting the status line.
    setStatus('Nothing to clear there')
    showToast('Nothing to clear there')
    playHaptic(24)
    return
  }
  spendItem(id)
  input.holdItemsFor(420)
  setTimeout(renderItemBar, 450)
  emitItemBurst(removed, id)
  renderBoard()
  input.cancelItemSelection(true)
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
  if (input.getItemActive()?.id === id) {
    input.cancelItemSelection()
    return
  }
  if (input.hasItemActive()) input.cancelItemSelection(true)
  if (!input.canUseItemsNow()) {
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
    // v0.9.0 P1: deal first, spend only on success (§10.1). A refresh that cannot produce a
    // playable batch — the cube is full for every shape the dealer may use — must not cost the
    // player a charge, and must not be silent about it either.
    if (!rerollPieces()) {
      showToast('No room - clear a path')
      playHaptic(20)
      renderItemBar()
    }
    return
  }
  // The mode, its panel and the status line are the input layer's; the undo window closes
  // here because it is the toast's (07 §3.1 A9: a live undo toast must not stay clickable
  // underneath the targeting mode that is about to replace it).
  input.armItem(id)
  clearItemUndo()
  renderItemBar()
}

function rerollPieces() {
  // A refresh replaces the batch the undo was recorded against, so the window closes.
  clearItemUndo()
  // The batch comes from the same dealing service as a natural one (v0.9.0 P1, spec §10.1):
  // relief target, Block 9 excluded, and it does NOT advance the natural batch counter or
  // Block 9's cooldown. The old local "re-draw up to 24 times until it differs" loop is gone
  // because the dealer's proposal step already guarantees a different combination, and because
  // "different" was never the property that mattered — "playable" is.
  const result = session.refreshDeal()
  if (!result.ok) return false
  spendItem('refresh')
  input.clearSelection()
  renderPieceSlots()
  showToast('Refreshed')
  playHaptic(10)
  renderItemBar()
  saveSession()
  checkStuckAndPrompt()
  return true
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

toastEl.addEventListener('click', () => { if (hasUndo()) undoItem() })

// The piece placement drag (beginDrag / updatePreview / updateDrag / finishDrag /
// cancelActiveDrag) and the pointer-to-lattice helpers moved to input/gameInput.js
// (refactor P7b). main keeps the drop itself -- onDrop() below -- and the slot DOM.

// The clear feedback - AxisEmitter, the line particles, the beam, the stars, the transient
// list and the camera shake - lives in rendering/effects.js (refactor P5).

// One settled placement, in the order the design fixes it: settle every face
// (board.js) → chain → honors → score (§4.5) → present (§6). Keeping the whole
// sequence here is what makes the HUD number auditable — it is the sum of the
// named parts, and the parts are the ones the docs name.

function onDrop({ piece, face, cells, origin }) {
  // A placement changes the board the undo was recorded against, so the window closes before
  // anything else happens (07 §3.1 A9) -- it used to be settlePlacement()'s own first line, and
  // it now sits here, in the same order, because the window is the item flow's (P6b).
  clearItemUndo()
  const {
    result, lines, lineCount, honors, level, score, previousChain,
  } = settlePlacement(face, cells, origin, piece.shape.color)
  playPlaceSound(lineCount)
  playHaptic(lineCount > 1 ? [18, 35, 22] : lineCount ? [18, 28, 16] : 12)
  // The hand is the session's, so the flag that spends the candidate is set through it
  // (plan §6 P6a: 现存 currentDrag.piece.used = true 改由明确 session 动作执行，时机保持).
  session.usePiece(piece)
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
    input.holdItemsFor(650)
    setTimeout(renderItemBar, 720)
    setStatus('Clear! Keep building')
  } else {
    // §4.1: a building turn still pays, and still says so. A chain that was real
    // enough to be on screen must be seen breaking (§4.4).
    showScorePop(score.total, { quiet: true })
    if (previousChain >= HUD_STYLE.chainMinVisible) breakChainFeedback(previousChain)
    setStatus('Pick a shape')
  }
  if (getPieces().every((candidate) => candidate.used)) nextPieces()
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
  cloneSources: { cubeBody: blocks.cubeBody, gridGroup },
  // Whoever changes the open state recomputes the pause lock — one place decides.
  onOpen: () => syncPause(),
  onClose: () => syncPause(),
})

// Bound to the module's own names so the existing call sites below read as they always did.
const {
  refreshHome,
  openLeaderboard,
  closeLeaderboard,
} = homeUi

function openHome() {
  if (homeUi.isOpen()) return
  // The cover is about to be painted over the board, and the home's own hero is a
  // CLONE of the live tiles: settling first is what keeps a wave caught mid-flight
  // from being cloned into the hero as a half-built cube.
  settleIntro()
  if (input.hasDrag()) input.cancelActiveDrag(false)
  input.cancelItemSelection(true)
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
  input.resetDrag()
  clearDragGhost()
  input.clearSelection()
  session.setEnded(false)
  setCancelZone(false)
  // The board, the run record, the hand and the charges (refactor P6b-2). The order around it is
  // unchanged: the pose below still comes after the hand, and the item strip after that.
  session.applySnapshot(saved)
  input.resetItemTargeting()
  // Pose is restored from the LOGICAL base quaternion, so the cube comes back on
  // exactly the face it was left on (a face-aligned pose matters: the candidate's
  // drop orientation is derived from it), with the bearing the player had dialled —
  // clamped to the fine-tune zone, so a hand-edited or stale save cannot produce a
  // bearing the game would never have allowed. An unreadable pose starts face-aligned.
  if (saved.pose?.base) {
    cubeSnapAnim.active = false
    boardView.setLive(null)
    input.resetRotation()
    cubeBase.fromArray(saved.pose.base).normalize()
    // v0.8.24: the zone is SYMMETRIC about the dock (`bearingMargin`, ±10° of yaw and
    // ±3° of pitch), so the clamp is dock ± margin on each axis. Resolve both bearing
    // components first, then hand them to the module in one call. The defaults and the
    // write-then-applyCubeRotation() order are exactly as before.
    const restoredYaw = Number.isFinite(saved.pose.bearingYaw)
      ? THREE.MathUtils.clamp(saved.pose.bearingYaw,
        rotateStyle.bearingYaw - rotateStyle.bearingMargin.yaw,
        rotateStyle.bearingYaw + rotateStyle.bearingMargin.yaw)
      : rotateStyle.bearingYaw
    const restoredPitch = Number.isFinite(saved.pose.bearingPitch)
      ? THREE.MathUtils.clamp(saved.pose.bearingPitch,
        rotateStyle.bearingPitch - rotateStyle.bearingMargin.pitch,
        rotateStyle.bearingPitch + rotateStyle.bearingMargin.pitch)
      : rotateStyle.bearingPitch
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
  // v0.9.0 P1: the preset draws from OPENING_SHAPES, whose membership is frozen to the
  // pre-Line-4 pool — the new candidate shape must not move the opening density too, or
  // the A/B/C experiment could not separate the two (spec §3.3).
  board.seedOpening(OPENING_SHAPES, OPENING_LAYOUT)
  resetItems()
  resetRun()
  session.setEnded(false)
  settingsUi.setSettingsOpen(false)
  resetShake()
  clearSlowMo()
  settingsUi.hideSettingsSilently()
  gameOverEl.classList.add('hidden')
  input.clearSelection()
  input.resetDrag()
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

// Every listener the input layer owns -- the canvas pointerdown/wheel, the window
// pointermove/pointerup/pointercancel/contextmenu/blur, the document keydown and the item
// strip's buttons -- is registered by input/gameInput.js from its own bind() (refactor P7d),
// once, with a disposer. It is called here, where the listeners used to be, so the boot order
// of registrations is unchanged.
//
// `document.visibilitychange` deliberately does NOT move (plan §6 P7 item 6): it is a lifecycle
// orchestration -- cancel the item, the drag and the rotation gesture at their own granularity,
// clear the undo window, write the slot, settle the wave, then recompute the pause lock -- and
// it stays below, calling the module's separate methods rather than one blanket cancelAll().
input.bind({
  itemBar: itemBarEl,
  axisPick: axisPickEl,
  axisCancel: axisCancelEl,
  onActivateItem: (id) => activateItem(id),
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
  if (document.hidden && input.hasItemActive()) input.cancelItemSelection(true)
  if (document.hidden && input.hasDrag()) input.cancelActiveDrag(false)
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
// Diagnostics (refactor P9): the `__voxalblast` read-only hook and the DEV-only write
// handles moved to diagnostics.js, which only ASSEMBLES what each owner module reports
// (boardView's pose and framing, gameScene's post chain, pieceView's previews, the stores'
// snapshots). This file hands it the modules and the DEV callbacks; the module mounts the two
// globals under the names the headless checks have always used.
//
// The callbacks stay HERE on purpose: a `jam()` that writes 60 cells or a `showChain()` that
// moves the run record is a gameplay action, not a read-out, and the plan forbids diagnostics
// from becoming the entry point for one (plan §2.1). They are built only under
// import.meta.env.DEV, so the production bundle carries neither the bag nor the closures.
const devHandles = import.meta.env.DEV
  ? {
    endGame: () => endGame(),
    openLeaderboard: () => openLeaderboard(),
    // v0.8.21: replay the opening wave on demand, so the probe can drive it without depending
    // on where a click landed. It calls armIntro() itself — the same function every real entry
    // point calls.
    replayIntro: () => armIntro(),
    settleIntro: () => { settleIntro(); return introPlaying() },
    // v0.8.23 (P5): the L5 dip normally needs a 4-line clear to happen, which cannot be
    // arranged on demand. This calls the very same triggerSlowMo() the clear path calls.
    triggerSlowMo: (level) => triggerSlowMo(level),
    // v0.8.16 rescue probe (07 §3.1 B1). A shell jam is common in real play but cannot be
    // produced on demand, so the three judgement branches could not be asserted without a way
    // to build one: `jam()` fills every free shell cell (nothing fits anywhere), `setItems()`
    // sets the charges, and `stuckCheck()` runs the very same judgement the gameplay path runs
    // — no mock of it.
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
    // Visual triggers for the headless UI checks: they call the very same functions the
    // gameplay path calls, so a screenshot of them is a screenshot of the real rendering, not
    // a hand-built mock of it.
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
  }
  : null

createDiagnostics({
  version: packageInfo.version,
  canvas: renderer.domElement,
  scene3d,
  boardView,
  blocks,
  pieceView,
  effects,
  input,
  session,
  recordStore,
  sessionStore,
  homeUi,
  settingsUi,
  dev: devHandles,
}).install()

applyCubeRotation()
animate()

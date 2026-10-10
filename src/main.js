import packageInfo from '../package.json'
import * as THREE from 'three'
// MUST come before the three.quarks import below: it bridges the r159 `updateRange` removal
// that otherwise throws inside animate() and freezes the canvas. rendering/gameScene.js owns
// the composer and imports this bridge for `skipComposerDepthBlit`, but gameScene itself is
// imported further down (after quarks), so relying on that would be relying on accident.
// Modules evaluate once, so this side-effect import and gameScene's named import are the
// same instance — it only pins the ORDER.
import './rendering/threeCompat.js'
import { SH, FACES, isShell, faceLattice } from './game/board.js'
import { settleScore, rewardLevel, SCORE_RULES_VERSION } from './game/scoring.js'
import { recordStore } from './game/records.js'
import { sessionStore } from './game/session.js'
import { createCrazyGamesAdapter } from './platform/crazygames.js'
// v0.12.0: the global leaderboard tab's data source. It answers with a sample board today and
// with the platform's entries once the integration lands — the panel renders both the same way
// (docs/Technical/LEADERBOARD_GLOBAL_BOARD_HANDOFF.md).
import { createLeaderboardFeed } from './platform/leaderboardFeed.js'
import {
  getRenderQuality, rewardFeedback, BOARD_STYLE as style, ROTATE_STYLE as rotateStyle,
} from './rendering/config.js'
import './styles.css'
import './toy.css'
import './reference.css'
import { addToyLights } from './rendering/toyLights.js'
import { installWoodSkin } from './rendering/woodTexture.js'
import { createBlockResources } from './rendering/blockResources.js'
import { createGameScene } from './rendering/gameScene.js'
import { createBoardView } from './rendering/boardView.js'
import { createGameInput } from './input/gameInput.js'
import { createEdgeTurnHint } from './ui/edgeTurnHint.js'
import { createGameSession } from './game/gameSession.js'
import { createPieceView } from './rendering/pieceView.js'
import { createEffects } from './rendering/effects.js'
import { createGameAudio } from './audio/gameAudio.js'
import { createFloatingWorld } from './rendering/floatingWorldScene.js'
import { installToyIcons } from './ui/icons.js'
import { collectDom } from './ui/dom.js'
import { ITEM_COPY } from './ui/itemCopy.js'
import { createGameOver } from './ui/gameOver.js'
import { createHud } from './ui/hud.js'
import { createHome } from './ui/home.js'
import { createBootScreen } from './ui/bootScreen.js'
import { createSettings } from './ui/settings.js'
import { createDiagnostics } from './diagnostics.js'
// Localization (docs/Technical/LOCALIZATION.md). initI18n() runs before the first render
// below, and every user-facing string in this file goes through t() at CALL time — never
// into a module-level constant, because the player can switch language mid-run.
import { initI18n, onLocaleChange, t } from './i18n/index.js'

installToyIcons()

// Language first, before a single label is painted (docs/Technical/LOCALIZATION.md). It
// resolves the locale from ?lang= / the stored preference / the English default, stamps
// <html lang>, and rewrites the static markup's data-i18n nodes. Module scripts run after
// the document is parsed, so the DOM is already there.
initI18n()

// The game's own data model -- the board, the hand, the run counters and the placement rule --
// lives in game/gameSession.js (refactor P6a). The board and the run record are const objects
// mutated in place, so they bind straight back to the names this file has always used; the two
// that are reassigned (the hand, the run token) go through accessors.
const session = createGameSession()
const board = session.board
const run = session.run
const {
  resetRun,
  currentCells,
  settlePlacement,
  getPieces,
  getRunId,
  getItemCounts,
  setItemCharge,
  resetItemCounts,
  spendItem,
  toolScopeFaceCells,
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
// `#settings-close` / `#app` / `.topbar, .game-layout` queries this file used to
// scatter further down are collected by ui/dom.js too (P1b-2), next to the handles above.
// `#home-hero` used to be one of them; v0.9.26 deleted the node with the cover's live cube.
const {
  sceneWrap,
  scrollShield,
  app: appEl,
  versionEl,
  bootEl,
  scoreEl,
  bestEl,
  statusEl,
  toastEl,
  honorLayerEl,
  slotsEl,
  piecesPanelEl,
  cancelZoneEl,
  itemBarEl,
  axisPickEl,
  itemStatusEl,
  itemStatusIconEl,
  itemStatusNameEl,
  itemStatusHintEl,
  itemUseEl,
  undoBarEl,
  undoBarTextEl,
  undoButtonEl,
  refreshConfirmEl,
  refreshConfirmCopyEl,
  cancelZoneTitleEl,
  cancelZoneNoteEl,
  settingsEl,
  settingsButtonEl,
  languageSettingEl,
  languageSettingValueEl,
  soundSettingEl,
  hapticsSettingEl,
  hapticsNoteEl,
  dragTurnSettingEl,
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
  leaderboardGlobalEl,
  leaderboardTabsEl,
  lbTabGlobalEl,
  lbTabLocalEl,
  leaderboardCloseEl,
  leaderboardPlatformEl,
  homeEl,
  homePrimaryEl,
  homePrimaryLabelEl,
  homeBestEl,
  homeResumeNoteEl,
  homeNewEl,
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
// v0.10.3 (SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §5.3): BEST is a per-RULES-VERSION number.
// The pill and the home cover show the pool of the run on screen, so this is re-read whenever
// the run's rules change — a new run (version 2) and a resumed legacy run (version 1) each
// compare against their own pool, and neither is shown the other's record as its own.
function syncBestToRules() {
  bestScore = recordStore.best(run.scoreRulesVersion).score
  return bestScore
}
// The summary the Game Over card was last rendered from, so a language switch can re-render
// the card the player is standing on instead of leaving the old language behind the modal.
let lastSummary = null

// The Game Over card's presentation, wired to the run through a getter (see ui/gameOver.js).
const gameOverUi = createGameOver({
  els: { gameOverBestEl, gameOverFacesEl, gameOverHonorsEl, gameOverStatsEl },
  getRun: () => run,
})

// The audio bus (v0.10.1, handoff §5/§6) is built further down, once the effects factory has
// taken its own place in the boot order; the HUD's three callbacks below reach it through this
// binding, exactly like the other lazy callbacks in this file — a roll can only start on a
// settled placement, long after everything exists.
let audio

// HUD presentation (see ui/hud.js). The factory only stores closures, so it can be built
// here: every getter is lazy and the item state it reads is declared further down.
const hud = createHud({
  els: {
    statusEl, toastEl, scoreEl, bestEl,
    sceneWrap, honorLayerEl, itemBarEl, axisPickEl, slotsEl,
    itemStatusEl, itemStatusIconEl, itemStatusNameEl, itemStatusHintEl, itemUseEl,
    refreshConfirmEl, refreshConfirmCopyEl, undoBarEl, undoBarTextEl,
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
  disposePiecePreviews: (fromIndex) => pieceView.disposePiecePreviews(fromIndex),
  createPiecePreview: (piece, canvas, slot, index) => pieceView.createPiecePreview(piece, canvas, slot, index),
  onChainBreak: () => audio.playChainBreak(),
  // The score roll's two noises (v0.9.29; the arbitration moved to the audio bus in v0.10.1).
  // hud.js decides only WHEN a tick is owed and when the number is done; whether anything is
  // heard, how far down the click sits under the main cue, and whether the landing chord is
  // suppressed are gameAudio's (§6.1).
  onScoreTick: () => audio.playScoreTick(),
  onScoreSettle: () => audio.playScoreSettle(),
})

// Bound to the module's own names so every existing call site below reads exactly as it
// always did — the bodies moved, the call sites did not.
const {
  setStatus,
  showToast,
  updateHud,
  showScorePop,
  showRewardNote,
  clearHonorLayer,
  renderItemBar,
  renderAxisPick,
  renderItemStatus,
  renderRefreshConfirm,
  renderUndoBar,
  renderPieceSlots,
} = hud


const quality = getRenderQuality()

// Wood grain is a canvas texture, and the signboards are DOM: paint them before
// the first frame so nothing pops in a frame late.
installWoodSkin()
// v0.13.0 R4 (handoff §4.1): `installPastoralBackdrop(appEl)` used to sit here. It is GONE.
// The 「浮空积木世界」 background is a real lit scene graph now (rendering/floatingWorldScene.js),
// and leaving the DOM layer installed would keep the valley painting — plus every tree, corgi
// and cottage in it — visible behind the new world. The old module and its art are deliberately
// NOT deleted in the same round: other screens still reference them, and §4.1 asks for the new
// skin's references to be cut before anything is removed globally.

// The floating world is solved against the FULL frame, so it has to be laid out after
// gameScene's resize has put the embedded render projection in place. gameScene calls back
// through this holder; a plain `window.resize` listener would run at an unknown point relative
// to its own ResizeObserver and read a stale camera.
let onSceneResize = null

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
  onResize: () => onSceneResize?.(),
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

// ---- The 「浮空积木世界」 (v0.13.0 R4) ------------------------------------------------
//
// §4.2's three layers, built from the delivered recipe. It owns NO gameplay state, is never
// ray-cast against, and lives entirely on the scenery layer.
//
// It is CONSTRUCTED further down, after `boardView`, and that placement is not cosmetic: the
// board's art shadow is anchored from the board's own screen silhouette, so the module cannot be
// built before the board's lattice constants and group exist — doing it here threw
// `ReferenceError: Cannot access 'half' before initialization` on the very first layout.
//
// §4.3's UI keep-out bands are read LIVE from the DOM on every layout pass. The scenery module
// combines them with the board's projected silhouette and the recipe's breathing room, so a
// decoration may frame the play area but can never occupy its pixels.
//
// The TRAY is deliberately absent. §4.2 wants larger masses cropped by the frame at both bottom
// edges, and the tray is an opaque DOM panel drawn over the canvas — a block behind it cannot
// obscure a candidate. Keeping the tray in this list deleted exactly that layer when it was
// measured (3 of the 7 decorations), which is the opposite of what the correction asks for.
const KEEP_OUT_TARGETS = Object.freeze([
  ['.score-plaque', 'score'],
  ['.topbar .icon-button', 'top-control'],
  ['.item-button', 'tool-control'],
  ['.piece-slot', 'candidate'],
  ['#axis-hint', 'hint'],
  ['#item-status-hint', 'hint'],
])
function floatingWorldKeepOut() {
  const rects = []
  if (typeof document === 'undefined') return rects
  const padding = 8
  for (const [selector, role] of KEEP_OUT_TARGETS) {
    for (const element of document.querySelectorAll(selector)) {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && rect.width > 0 && rect.height > 0) {
        rects.push({
          left: rect.left - padding,
          top: rect.top - padding,
          right: rect.right + padding,
          bottom: rect.bottom + padding,
          width: rect.width + padding * 2,
          height: rect.height + padding * 2,
          role,
        })
      }
    }
  }
  return rects
}

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

// The 「浮空积木世界」 is built HERE, not next to the scene it decorates, for one concrete
// reason: its board shadow is anchored from the board's own screen silhouette, so the module
// cannot be constructed before the lattice constants and the cube group exist — built earlier it
// threw `ReferenceError: Cannot access 'half' before initialization` on its first layout pass.
const floatingWorld = createFloatingWorld({
  scene,
  quality,
  // The camera the frame is ACTUALLY drawn through: the render camera, not the canonical one.
  getCamera: () => scene3d.renderCamera,
  getCanvasRect: () => scene3d.getCanvasRect(),
  getKeepOutRects: floatingWorldKeepOut,
  // §6.4's art shadow is anchored from where the BOARD lands on screen — the board's own
  // silhouette, measured by its owner, not a second guess at the lattice arithmetic here.
  getBoardScreenBox: () => cubeScreenBounds(),
})
onSceneResize = () => floatingWorld.resize()

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
  // v0.13.0 R3 (handoff §9.3): the EVENT SOURCE is the gameplay surface, not the canvas. The
  // main canvas is the whole viewport now and `pointer-events:none`, so binding to it would
  // either catch nothing or catch everything; `#scene-wrap` is the box the board is measured
  // in and the only box a board gesture may start in. Every `canvas.getBoundingClientRect()`
  // inside gameInput therefore answers "where is the play area", which is what it always meant.
  canvas: sceneWrap,
  // v0.13.2: the view gesture's SECOND surface. `#scene-wrap` is the board's own hit box and
  // stops short of the tray, so the empty ground under the cube used to turn nothing; the
  // background layer catches it instead (see `onBackgroundDown` in input/gameInput.js).
  background: scrollShield,
  isPaused: () => isPaused,
  isEnded: () => session.isEnded(),
  isHomeOpen: () => homeUi.isOpen(),
  isSettingsOpen: () => settingsUi.isOpen(),
  isControlsOpen: () => settingsUi.isControlsOpen(),
  // v0.9.12: the 拖块翻面 switch gates the turn dwell (03 §3.1). Read live, never captured.
  isDragTurnOn: () => settingsUi.getDragTurnOn(),
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
  // Availability is diagnostic; all piece turns use the viewport-edge dwell.
  anyPlacementOn: (face, cells) => board.anyPlacementOn(face, cells),
  currentCells: (piece) => currentCells(piece),
  toolScopeFace: (id, face, u, v, orientation) => toolScopeFaceCells(id, face, u, v, orientation),
  isOccupied: (cell) => board.has(cell[0], cell[1], cell[2]),
  getItemCounts: () => getItemCounts(),
  cancelZones: () => [piecesPanelEl, itemBarEl],
  // v0.9.31: a hand that is still being computed in the deal worker. The input layer closes the
  // tray's and the item strip's gates on it, so the used-up hand on screen cannot be dragged (or
  // re-refreshed) out from under the batch that is on its way.
  isDealing: () => session.isDealing(),
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
  onShowOverlay: (scope) => showItemScope(scope),
  onConfirmItem: (snapshot) => confirmItem(snapshot),
  // 07 §8's own callbacks. The status bar's repaint, the batch question, the refusal of an empty
  // charge, the undo window a re-armed tool closes (§8.9) and the one hint the mode owes a player
  // who tries to turn the cube while holding a tool (§8.4).
  onItemStatus: () => renderItemStatus(input.itemReport()),
  onRefreshConfirm: (open) => renderRefreshConfirm(open),
  onConfirmRefresh: () => { rerollPieces() },
  onEmptyItem: (id) => {
    showToast(ITEM_COPY.empty)
    playHaptic(20)
    renderItemBar()
  },
  onRearm: () => clearItemUndo(),
  onItemLockedRotate: () => showLockedRotateHint(),
  onStatus: (text) => setStatus(text),
  onToast: (text) => showToast(text),
  onHaptic: (pattern) => playHaptic(pattern),
  onEdgeTurn: createEdgeTurnHint(),
  onCancelZone: (mode, active, highlighted) => setCancelZone(mode, active, highlighted),
  onSelectionChanged: () => updatePieceSlotSelection(),
  onBuildGhost: (piece) => buildDragGhost(piece),
  onSyncGhost: (params) => syncDragGhost(params),
  onClearGhost: (options) => clearDragGhost(options),
  onReturnPiece: (piece) => pieceView.returnPiece(piece),
  onClearLanding: () => clearLanding(),
  onShowLanding: (params) => {
    showLanding(params)
    const lines = params.valid ? board.previewLines(params.face, params.cells, params.origin) : []
    boardView.setClearPreview(lines.flatMap(line => line.cells), params.color)
  },
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
const blocks = createBlockResources({ metrics: () => ({ cubeSide, cs }) })
cubeGroup.add(blocks.cubeBody)
cubeGroup.add(blocks.boardOuterInk)

// The 98 blocks live in rendering/boardView.js (refactor P3c). attachTiles() runs here, where
// the group used to be attached and built: cubeGroup's child order is load-bearing (cubeBody
// -2, whole-board perimeter -1.5, per-cell ink -1; preview groups are added after them).
boardView.attachTiles()

// The board's own single source of truth hands the painted cells to the view, which repaints
// the tiles from them; the HUD follows, in the order it always did.
//
// `snap` is for the callers that are not a placement — a restored save has to come back on the
// number it was saved at (v0.9.29 score roll, ui/hud.js). Everything else lets the HUD roll.
function renderBoard(snap = false) {
  syncBoard(board.occupied())
  updateHud({ snap })
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
  // The gameplay box, not the canvas: v0.13.0 R3 made the canvas the whole viewport, so the
  // ghost and the tray must measure the box the board is actually framed and hit-tested in
  // (gameScene owns that definition; the candidate previews read their own canvases instead).
  getCanvasRect: () => scene3d.getGameplayRect(),
  // A new deal replaces the piece objects and every click reassigns the selection, so both are
  // read through getters rather than captured.
  getCells: currentCells,
  getSelectedPiece: () => input.getSelectedPiece(),
  onClearForecast: () => boardView.setClearPreview(),
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
  // Item scope overlay (P4c, redesigned for 07 §8.5/§8.6): main still decides which cells a tool
  // reaches and which of them are taken; the module draws the frame, the floors, the cleared
  // blocks and the anchor from the finished snapshot it is handed.
  clearItemOverlay,
  showItemScope,
  pulseItemScope,
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

// Effects (refactor P5) own the batched particle renderer, the paper celebration, the line
// bands and marks, the shake, the slow-motion dip and the haptics. The factory is called here,
// where its scene attachments used to be made, and it is handed the things this file used to
// close over. Sound is NOT one of them any more (v0.10.1): it moved to the audio bus below.
const effects = createEffects({
  scene,
  camera,
  cubeGroup,
  cubeSide,
  // v0.10.1: the paper sizes the design gives are in CELLS, so the lattice pitch crosses the
  // boundary explicitly rather than being assumed to be 1.
  cellPitch: cs,
  cellToWorld,
  cubeVector,
  findFrontFace,
  quality,
  // Live getters, never captured booleans: the switch is read at the moment of the buzz.
  getHapticsOn: () => settingsUi.getHapticsOn(),
  // §7.2: decoration gives way to a live drag preview or a tool scope, and both of those live
  // in the input layer — read per frame because either can appear between two frames.
  getInputBusy: () => input.hasDrag() || input.hasItemActive(),
  // v0.10.3: the FACE_CLEAR signature anchors on the emptied face's own plane centre, and the
  // reward shake is stated in CSS pixels — both are boardView's/gameScene's to answer.
  facePlaneLocalCenter,
  getWorldPerPixel: () => scene3d.worldPerPixel(),
})
const {
  playHaptic,
  emitItemBurst,
  spawnClearEffects,
  retreatDecorations,
  triggerRewardShake,
  triggerSlowMo,
  clearTransientEffects,
  resetShake,
  clearSlowMo,
} = effects

// The audio bus (v0.10.1, handoff §5/§6). One AudioContext, one master, one set of scenes: it
// replaces the bare `playTone()` oscillators that used to live in effects.js and used to fire
// place + honour + chain as three melodies over each other (§1/§6.1).
audio = createGameAudio({
  // The switch is read LIVE at the moment of every cue, exactly like the haptics one above.
  getSoundOn: () => settingsUi.getSoundOn(),
  lowPower: Boolean(quality.lowPower),
})
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
//
// v0.9.31: the hand is computed in the deal worker, so this returns a PROMISE and the caller
// decides what waits on it. The search used to run right here, inside the frame the player
// released a piece on (p50 40.6ms on this desktop, several times that on a phone — the producer's
// 「放置上去会卡顿一下」) — onDrop() therefore waits for this before saving and before the stuck
// check, both of which describe the hand that is about to exist rather than the used-up one.
function nextPieces(reason = 'natural') {
  input.clearSelection()
  return session.dealAsync(reason).then((result) => {
    // A batch that arrived for a run which has since been replaced (a new game, a resume) is
    // dropped: whatever replaced the run owns the tray now.
    if (result.stale) return result
    renderPieceSlots()
    return result
  })
}

// The three candidate previews (refactor P4a) live in rendering/pieceView.js: each slot owns
// its own renderer, scene and camera, and the module owns the map holding them. The slot DOM
// itself -- the buttons, the chip colour, the thumbnail canvases and the pointer wiring --
// moved to ui/hud.js in P9; the previews themselves stay in pieceView.

// 07 §8.3: the cancel affordance is TWO independent rectangles — the candidate tray and the item
// strip — because they are separated by the board on every layout the game ships. `mode` decides
// which copy they wear: 'piece' is the placement drag's own cancel ("Cancel / placement"), the
// item mode's is the doc's 「拖到这里取消 / 松手取消」. `highlighted` is the "the finger is in
// here right now" state, which is what turns 拖到这里取消 into 松手取消.
function setCancelZone(mode, active = false, highlighted = false) {
  const item = mode === 'item' || mode === 'item-hot'
  piecesPanelEl.classList.toggle('cancel-mode', active)
  piecesPanelEl.classList.toggle('cancel-hot', active && highlighted)
  itemBarEl.classList.toggle('cancel-mode', item && active)
  itemBarEl.classList.toggle('cancel-hot', item && active && highlighted)
  cancelZoneEl.setAttribute('aria-hidden', String(!active))
  cancelZoneTitleEl.textContent = item ? ITEM_COPY.dragCancelTitle : ITEM_COPY.pieceCancelTitle
  cancelZoneNoteEl.textContent = item ? ITEM_COPY.dragCancelNote : ITEM_COPY.pieceCancelNote
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
  // §6.3: the AUDIO scene is not the same boolean. Pausing the run, hiding the page, opening
  // the panel and being on the result card are five different answers to "what may be heard",
  // and the finished run is exactly the one that still owes a record sound. Deriving the scene
  // here — where every one of those transitions already arrives — is what keeps the two
  // channels from drifting apart.
  audio.setScene(audioScene())
  // The item strip's only "not yet" affordance is a class derived from isPaused
  // (canUseItemsNow), so whoever changes the pause state has to restore it: the opening
  // wave and the settings panel both grey the buttons on the way in, and without this the
  // greying would outlive its reason. Caught by the v0.8.22 board shot — the four item
  // buttons were still grey after the wave had settled.
  if (isPaused !== previous) renderItemBar()
  return isPaused
}

// The strip's readiness is `input.canUseItemsNow()` — and that is NOT `!isPaused`. It also
// closes on a drag, on the deal worker still thinking, on an open settings panel and on the
// short hold after a committed use, none of which move `isPaused`. `renderItemBar()` was
// repainted only from the event sites that happen to know about one of them, so any transition
// nobody called it from left the four buttons grey on a live run.
//
// v0.13.0: this is the frame loop's own answer to that. The gate is re-read once per frame
// (four booleans and a clock compare) and the strip is repainted only when the ANSWER changes,
// so the paint can no longer outlive its reason no matter which path armed or cleared it. The
// opening wave is the case that made it visible: `renderItemBar()` runs BEFORE `syncPause()`
// in the resume path, and a wave that ends without a pause transition repaints nothing.
let itemStripReady = null
function syncItemStrip() {
  const ready = input.canUseItemsNow()
  if (ready === itemStripReady) return
  itemStripReady = ready
  renderItemBar()
}

// The seven scenes the bus understands (handoff §6.3). Ordered by authority: a hidden page
// outranks everything, the cover cancels a run's tail, the finished run may still play its
// record sound, and the two panels stop in-run sound without silencing an explicit test tone.
function audioScene() {
  if (document.hidden) return 'hidden'
  if (homeUi.isOpen()) return 'home'
  if (session.isEnded()) return 'result'
  if (settingsUi.isOpen()) return 'settings'
  if (settingsUi.isControlsOpen()) return 'help'
  if (introPlaying()) return 'intro'
  return 'gameplay'
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
  setStatus(t('status.paused'))
  settingsUi.updateSettingsUi()
  settingsUi.focusSettingsClose()
}

function closeSettings() {
  if (!settingsUi.isOpen()) return
  settingsUi.setSettingsOpen(false)
  settingsUi.hideSettings()
  if (!isPaused) {
    platform.gameplayStart()
    setStatus(t('status.idle'))
  }
  // v0.9.24: focus goes back to whoever is actually on screen. The gear lives in `.topbar`,
  // which the cover makes inert — focusing it from the cover silently did nothing and left
  // focus on `<body>` (measured: the settings Home row over the cover ended on BODY).
  if (homeUi.isOpen()) homeUi.focusPrimary()
  else settingsUi.focusSettingsButton()
}

// ============================================================
// The keyboard rotation (handleRotateKey) moved to input/gameInput.js (refactor P7a). main
// still owns the Escape chain and the rocket keys below, and it is the one that tells the
// legend what to spin (settingsUi.spinControlCube / showAxisHint).

function openControls() {
  if (!settingsUi.openControls()) return
  platform.gameplayStop()
  setStatus(t('status.paused'))
  settingsUi.focusControlsClose()
}

function closeControls() {
  if (!settingsUi.closeControls()) return
  if (!isPaused) {
    platform.gameplayStart()
    setStatus(t('status.idle'))
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

// Closing the undo window also drops the undo BAR, so a stale window can never keep a clickable
// 撤销 on screen after a placement or a new clear.
// The session owns the window (data + timer); this file owns the bar that shows it. Clearing
// always goes through here, so the UI can never look undoable while the session cannot undo.
function clearItemUndo() {
  clearUndo()
  toastEl.classList.remove('undoable')
  renderUndoBar(null)
}

// §4.3 图像刷新: the refresh tool's picture is the TRAY being re-laid, not a burst on the cube.
// One short class on the strip and the CSS does the sweep; it is overlay-only, so it can never
// eat a gesture or take focus, and it is cleared on a re-entrant call so two refreshes in a row
// do not stack timers.
let pieceSweepTimer
function sweepPieceSlots() {
  slotsEl.classList.remove('sweeping')
  // Force a style flush so the animation restarts instead of being ignored mid-flight.
  void slotsEl.offsetWidth
  slotsEl.classList.add('sweeping')
  clearTimeout(pieceSweepTimer)
  pieceSweepTimer = setTimeout(() => slotsEl.classList.remove('sweeping'), 260)
}

// 07 §8.4: the mode takes the cube's rotation away on purpose, so this is the sentence that
// explains the refusal. Rate-limited on purpose: a player dragging the board around would
// otherwise toast on every frame.
let lockedRotateHintUntil = 0
function showLockedRotateHint() {
  const now = performance.now()
  if (now < lockedRotateHintUntil) return
  lockedRotateHintUntil = now + 1600
  showToast(ITEM_COPY.lockedRotate)
  playHaptic(12)
  audio.playCancel()
}

// v0.6 (07 §3.1 A9): a clear is the one irreversible thing a mis-tap can do — the
// cubes come back with their original colours, the charge comes back, and the save
// slot is rewritten, so the undo is exact rather than cosmetic.
function undoItem() {
  const undone = undoLast()
  if (!undone) return
  clearItemUndo()
  input.releaseItems()
  renderBoard()
  renderItemBar()
  saveSession()
  playHaptic(8)
  // §4.3: 撤销 is the light version of 「no」 — the same cue an illegal release uses, and never
  // the clear sound played backwards.
  audio.playCancel()
  setStatus(t('status.idle'))
  showToast(undone.restored ? ITEM_COPY.restoredN(undone.restored) : t('toast.nothingToRestore'))
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

// The item targeting moved to input/gameInput.js (refactor P7c, redesigned for 07 §8): the mode,
// the two paths, the cancel rectangles and the snapshot rule are the input layer's. What stays
// here is the business of USING a tool — confirmItem() below, driven by the snapshot the input
// layer hands over, and rerollPieces() behind the batch question.
//
// v1 passes the SNAPSHOT rather than letting this file re-read the live mode: §8.5.7 requires the
// commit to be the exact object the input layer drew, and the input layer has already cleared its
// mode by the time this runs (which is what makes a double-tapped 使用 harmless).
function confirmItem(snapshot) {
  const { id, face, u, v, orientation } = snapshot
  const { records, removed } = applyItem(id, face, u, v, orientation)
  if (!removed.length) {
    // A silent miss read as "the button is broken" (07 §3.1 A6), so the failure now
    // says so on the toast and buzzes as well as setting the status line. The input layer has
    // already refused an empty scope (§8.5.5), so reaching this is a genuine race, not a path.
    setStatus(t('status.nothingToClear'))
    showToast(t('toast.nothingToClear'))
    playHaptic(24)
    // §4.3: a miss makes no success sound. It gets the same clip as an illegal release, rate
    // limited so a player sweeping the board cannot machine-gun it.
    audio.playCancel()
    return
  }
  spendItem(id)
  input.holdItemsFor(420)
  setTimeout(renderItemBar, 450)
  // §4.3: the tool's `id` is consumed HERE, not just its particle count — hammer, rocket, bomb
  // and refresh are four different effects, and a refresh has no board burst at all.
  emitItemBurst(removed, id)
  audio.playItem(id)
  renderBoard()
  setStatus(t('status.idle'))
  renderItemBar()
  saveSession()
  clearItemUndo()
  // The window arms a couple of statements earlier than it used to: at a 3000ms window that is
  // not observable, and it keeps the data and the timer in one place (plan section 2).
  openUndo({ id, records }, 3000, () => {
    clearItemUndo()
  })
  // §8.9: 取消 ≠ 撤销. The window gets a real bar with a 44px button instead of a clickable
  // toast, because the toast can be painted over by the next ordinary message while the charge
  // is still refundable.
  renderUndoBar({ text: ITEM_COPY.clearedN(removed.length) })
  playHaptic(12)
  checkStuckAndPrompt()
}

function rerollPieces() {
  // A refresh replaces the batch the undo was recorded against, so the window closes — this is
  // also §8.9's 实际确认换批时才关闭撤销, which is why the confirm bar itself closes nothing.
  clearItemUndo()
  // The batch comes from the same dealing service as a natural one (v0.9.0 P1, spec §10.1):
  // relief target, Block 9 excluded, and it does NOT advance the natural batch counter or
  // Block 9's cooldown. The old local "re-draw up to 24 times until it differs" loop is gone
  // because the dealer's proposal step already guarantees a different combination, and because
  // "different" was never the property that mattered — "playable" is.
  //
  // v0.9.31: computed in the deal worker, so the charge is spent when the batch ARRIVES. That is
  // the same rule as before ("deal first, spend only on success"), one message later; until it
  // arrives the input layer refuses pickups (session.isDealing), so the hand on screen cannot be
  // dragged out from under the batch that is replacing it.
  return session.dealAsync('refresh').then((result) => {
    if (!result.ok) {
      // §8.8 / v0.9.0 P1: deal first, spend only on success. A refresh that cannot produce a
      // playable batch must not cost the player a charge, and must not be silent about it either.
      showToast(t('toast.noRoomClearPath'))
      playHaptic(20)
      // §4.3: an async refresh that FAILED is not a success — no paper flip for it.
      audio.playCancel()
      renderItemBar()
      return false
    }
    spendItem('refresh')
    input.clearSelection()
    renderPieceSlots()
    showToast(t('toast.refreshed'))
    playHaptic(10)
    // §4.3: refresh is a TRAY gesture, not a board explosion. The paper sweep is the strip's
    // own class; the cue is the two light flips, and it is only owed once the batch arrived.
    sweepPieceSlots()
    audio.playItem('refresh')
    renderItemBar()
    saveSession()
    checkStuckAndPrompt()
    return true
  })
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
    setStatus(t('status.noSpotRefresh'))
    showToast(t('toast.noSpotTryRefresh'))
    return
  }
  if (outcome === 'clear-path') {
    setStatus(t('status.noSpotClear'))
    showToast(t('toast.noSpotClear'))
    return
  }
  if (outcome === 'end') endGame()
}

// emitItemBurst() lives in rendering/effects.js (refactor P5): it is a particle system, and the
// module is handed the cells and asks boardView for the front face itself.

// §8.9: 撤销 is a BUTTON on its own bar, not a clickable toast. The toast is for ordinary
// messages; the undo window is a refundable transaction, and a message that can be painted over
// is not a safe place to put one. Both the bar and its 44px button route here.
undoButtonEl.addEventListener('click', () => { if (hasUndo()) undoItem() })

// The piece placement drag (beginDrag / updatePreview / updateDrag / finishDrag /
// cancelActiveDrag) and the pointer-to-lattice helpers moved to input/gameInput.js
// (refactor P7b). main keeps the drop itself -- onDrop() below -- and the slot DOM.

// The clear feedback - AxisEmitter, the line particles, the beam, the stars, the transient
// list and the camera shake - lives in rendering/effects.js (refactor P5).

// One settled placement, in the order the design fixes it: settle every face
// (board.js) → chain → score & rewards (§4.1) → present (§3). Keeping the whole
// sequence here is what makes the HUD number auditable — it is the sum of the
// named parts, and the parts are the ones the docs name.
//
// v0.10.3 (SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §3/§4): the presentation below consumes the
// ONE rewardEvent the session produced. Nothing here re-counts lines, re-decides whether a
// bonus is owed, or plays a second melody: 账可以叠，演出不能叠 (§3.3).

function onDrop({ piece, face, cells, origin }) {
  // A placement changes the board the undo was recorded against, so the window closes before
  // anything else happens (07 §3.1 A9) -- it used to be settlePlacement()'s own first line, and
  // it now sits here, in the same order, because the window is the item flow's (P6b).
  clearItemUndo()
  const settled = settlePlacement(face, cells, origin, piece.shape.color)
  const {
    lines, lineCount, level, score, rewardEvent,
  } = settled
  // §6.1 of the audio handoff, as narrowed by §3.3 here: ONE main cue per settled placement,
  // chosen by the reward event's headline category. `milestone` is only meaningful for a
  // legacy version-1 run (version 2 pays the streak reward instead).
  if (lineCount) audio.playClear(level, { reward: rewardEvent, milestone: score.chainMilestone || 0 })
  else audio.playPlace()
  // §3.3: 震动强度取本手各类建议值的最大值，不相加. The picture offset and the buzz come from the
  // same arbitration, so what is seen and what is felt agree; a placement with no reward keeps
  // the plain landing buzz it always had.
  const feedback = rewardFeedback(rewardEvent?.rewards)
  if (feedback.shakePx > 0) triggerRewardShake(feedback.shakePx, feedback.shakeMs)
  playHaptic(feedback.haptic || (lineCount > 1 ? [18, 35, 22] : lineCount ? [18, 28, 16] : 12))
  // The hand is the session's, so the flag that spends the candidate is set through it
  // (plan §6 P6a: 现存 currentDrag.piece.used = true 改由明确 session 动作执行，时机保持).
  session.usePiece(piece)
  renderBoard()
  updatePieceSlotSelection()
  if (lineCount) {
    // §3.3: 一个主标题、一条合并明细、一个总分跳字. The note is the ONLY place the categories are
    // named, and the pop carries the hand's TOTAL (基础分 + 三类奖励) — never a second total.
    showRewardNote(rewardEvent)
    showScorePop(score.total)
    spawnClearEffects(lines, level, { reward: rewardEvent })
    triggerSlowMo(level)
    input.holdItemsFor(650)
    setTimeout(renderItemBar, 720)
    setStatus(t('status.clearKeepBuilding'))
  } else {
    // §4.1 of 08: a building turn still pays, and still says so. Nothing else is owed: a dead
    // turn earns no reward, so it gets no note, no reward sound and no reward shake (§3.2
    // 「普通放置、单线且无额外奖励、断链…不触发这套奖励震屏」).
    showScorePop(score.total, { quiet: true })
    setStatus(t('status.idle'))
  }
  // The resume slot is written on the same beat as the board change, and BEFORE the
  // stuck check: checkStuckAndPrompt() may end the run, and a snapshot written after
  // that would be a save of a finished game (saveSession refuses those anyway).
  //
  // v0.9.31: when this placement spent the LAST candidate, the replacement hand is being computed
  // in the deal worker, and both of these beats describe the hand that is about to exist rather
  // than the used-up one on screen — a save written now would be refused by the store (its
  // migration drops a hand with nothing left to play) and the stuck check would read "no playable
  // candidate" on a hand that is one message away from being replaced. So they wait for it.
  if (getPieces().every((candidate) => candidate.used)) {
    nextPieces().then(() => {
      saveSession()
      checkStuckAndPrompt()
    })
  } else {
    saveSession()
    checkStuckAndPrompt()
  }
  // v0.13.3: the settled record goes back to the caller. Input has always ignored this return
  // value and still does; the DEV-only `dropAt()` hook reads it so a probe can name the raw face
  // lines a real drop produced instead of inferring them from a particle budget.
  return settled
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
    homePrimaryEl,
    homePrimaryLabelEl,
    homeBestEl,
    homeResumeNoteEl,
    homeNewEl,
    leaderboardEl,
    leaderboardBodyEl,
    leaderboardGlobalEl,
    leaderboardTabsEl,
    lbTabGlobalEl,
    lbTabLocalEl,
    leaderboardCloseEl,
    leaderboardPlatformEl,
    gameLayers,
  },
  getSavedRun: () => sessionStore.read(),
  getBest: () => bestScore,
  getRecords: () => recordStore.all(),
  // §5.3: the panel ranks against the rules of the run on screen, so it asks the run.
  getRulesVersion: () => run.scoreRulesVersion,
  platform,
  globalFeed: createLeaderboardFeed({ platform }),
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

// The boot curtain (v0.11.2, see ui/bootScreen.js). It is built here with the other UI modules,
// but it is only ever LIFTED at the very end of this file, once the run exists and the opening
// wave has been settled. `isReady` reads the candidate tray's own DOM: three painted slots is
// exactly the thing whose absence the producer saw.
const bootUi = createBootScreen({
  els: { bootEl },
  isReady: () => slotsEl.children.length >= 3,
})

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
  // v0.9.24 — the Game Over card has to go with it, or the cover opens UNDERNEATH it and
  // 「返回主页」 looks like a dead button. `.home-screen` is `z-index: 9` and `.modal` is
  // `z-index: 10`, so a run that ended left its result card painted over the cover: the
  // producer's report (「修复设置界面返回主页」) was exactly this case — going home from the
  // settings panel after a game over changed nothing on screen. The run is already in the
  // record book and its slot is cleared (endGame), so dismissing the card costs nothing;
  // PLAY AGAIN builds a fresh run through beginRun(), which hides it too.
  gameOverEl.classList.add('hidden')
  // Snapshot before the board stops being visible, so whatever was built is still
  // there behind the 继续游戏 button.
  saveSession()
  if (!homeUi.showCover()) return
  platform.gameplayStop()
  setStatus(t('status.home'))
  // Last, exactly where it was: focus lands on the cover's primary button only once the
  // cover is up and the run has announced itself to the platform.
  homeUi.focusPrimary()
}

function leaveHome() {
  homeUi.hideCover()
  renderItemBar()
  if (!isPaused) {
    platform.gameplayStart()
    setStatus(t('status.idle'))
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

// v0.9.24 — 新游戏 on the cover. It ignores the slot ON PURPOSE: this is the escape hatch from
// 继续游戏, so it must start a fresh run even though a snapshot is sitting there. `beginRun()`
// resets the board and immediately writes the new (empty) run into the slot, which is what
// discards the old one — the same trade the settings panel's RESTART row makes, and the reason
// this button is offered only next to 继续游戏 (ui/home.js hides it otherwise).
function startNewRunFromHome() {
  beginRun()
  leaveHome()
}

function applySession(saved) {
  clearTransientEffects()
  // Resuming a stored run is a new scene too: nothing from the tab that was hidden before the
  // reload may play into it (§6.3).
  audio.cancelAll()
  audio.setScene('gameplay')
  clearHonorLayer()
  resetShake()
  clearSlowMo()
  input.resetDrag()
  clearDragGhost()
  input.clearSelection()
  session.setEnded(false)
  setCancelZone('piece', false, false)
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
  // Restore, not a move: the pill comes back ON the saved number instead of counting up to it
  // (v0.9.29 score roll).
  renderBoard(true)
  // §5.3: BEST follows the rules the RESUMED run is playing under, and a version-1 run gets the
  // one-off notice §5.2 asks for — the player is about to keep scoring on the old formula, and
  // 「旧规则续局」 is the only honest way to say so without re-pricing a run in flight.
  syncBestToRules()
  updateHud({ snap: true })
  renderItemBar()
  syncPause()
  if (run.scoreRulesVersion !== SCORE_RULES_VERSION) showToast(t('toast.legacyRules'), 3200)
  setStatus(t('status.idle'))
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
    // §5.3: the score is filed under the rules that produced it, and the three category tallies
    // travel with a version-2 run only.
    scoreRulesVersion: run.scoreRulesVersion,
    rewards: run.rewardCounts,
    at: Date.now(),
  })
  bestScore = summary.bestScore
  updateHud()
  lastSummary = summary
  gameOverUi.renderGameOver(summary)
  // The run is in the record book now, so the save slot goes: a finished game must
  // never come back as 继续游戏. Cleared unconditionally, including when the player
  // reached it through the platform-less degraded path.
  clearSession()
  refreshHome()
  // Layer 2: exactly one submission per run, dropped silently when the game has no
  // leaderboard invitation (§7.4). §5.5: a score is only submitted to a board that is routed
  // to its own rules — the platform layer refuses an unrouted version outright rather than
  // mixing two scales in one ranking.
  platform.submitScore(finalScore, getRunId(), { rulesVersion: run.scoreRulesVersion })
  // §4.4: the record is read from the summary the RECORD BOOK just returned — never from the
  // live score crossing BEST mid-run, and never a second time on a re-render. The scene moves
  // first so no in-run tail and no in-run cue can survive into the card; the ordinary ending
  // keeps its quiet fade instead of a fanfare.
  audio.setScene('result')
  clearTransientEffects()
  if (summary.isNewBest) {
    audio.playNewBest()
    gameOverUi.celebrateNewBest(summary)
  } else {
    audio.playGameOver()
  }
  gameOverEl.classList.remove('hidden')
}

function resetGame() {
  clearTransientEffects()
  // §7.3: a new run cancels EVERYTHING that belonged to the last one — tails, scheduled cues
  // and the mute scene — by scope, not one effect at a time.
  audio.cancelAll()
  audio.setScene('gameplay')
  clearHonorLayer()
  closeLeaderboard()
  board.clear()
  // v0.9.10: a run starts on a BARE shell — all six faces at zero. v0.2.31 used to seed
  // config.js OPENING_LAYOUT here (≈13 cells on the three faces the camera can see) so the
  // first frame read as a board in play; the producer's call is the opposite: 重新开始 must
  // clear the cube, so the first move is always the player's own. `board.clear()` above is
  // now the whole opening. `Board.seedOpening()` and `OPENING_LAYOUT` deliberately stay in
  // the tree: the offline difficulty tools (tools/difficulty-*, tools/deal-*, and the
  // frozen baselines in docs/Technical/DIFFICULTY_*.md) still model PRESEEDED openings with
  // them, and deleting either would silently invalidate those measurements. The shipped
  // game no longer calls either.
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
  setCancelZone('piece', false, false)
  resetCubeRotation()
  nextPieces()
  renderBoard()
  // A new run plays the current rules, so BEST switches back to the current pool (§5.3).
  syncBestToRules()
  setStatus(t('status.idle'))
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
  itemStatus: itemStatusEl,
  refreshConfirm: refreshConfirmEl,
  axisPick: axisPickEl,
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
homeNewEl.addEventListener('click', startNewRunFromHome)
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
  if (document.hidden) { platform.gameplayStop(); setStatus(t(homeUi.isOpen() ? 'status.home' : 'status.paused')) }
  else if (session.isEnded() || settingsUi.isOpen() || homeUi.isOpen()) return
  else { platform.gameplayStart(); setStatus(t('status.idle')) }
})
// Settings panel, controls card and their entries (see ui/settings.js). Built and bound
// once, here, after every orchestration function it calls exists. `bind()` returns a
// disposer and refuses to bind twice, so a future re-entry cannot double-register.
const settingsUi = createSettings({
  settingsEl,
  settingsButtonEl,
  settingsCloseEl,
  languageSettingEl,
  languageSettingValueEl,
  soundSettingEl,
  hapticsSettingEl,
  hapticsNoteEl,
  dragTurnSettingEl,
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
  // v0.9.12: 拖块翻面 flipped OFF has to drop a dwell that is already armed (03 §3.1). It
  // routes to the input layer's own cancellation, the same one every other path calls.
  onDragTurnChanged: (on) => { if (!on) input.clearTurnDwell() },
})
settingsUi.bind({
  openSettings,
  closeSettings,
  openControls,
  closeControls,
  beginRun,
  // §6.3 显式试音: the switch's own confirmation is the audio bus's test cue, played through the
  // same master as everything else — and it is allowed to unlock a suspended context, without
  // ever letting a failed unlock block the game.
  playTone: () => audio.playTestTone(),
  playHaptic,
  // Switching the sound OFF has to do more than refuse the next note: the master ramps to zero
  // in ≤20ms and everything already scheduled or playing is cancelled.
  onSoundChanged: (on) => { if (on) audio.unlock(); else audio.refreshMute() },
})

// §6.3: the FIRST valid gesture is what creates and resumes the AudioContext. It is a capture
// listener on the window so it cannot be missed by a panel that stops propagation, and it is
// armed once: an unlock that fails does not re-arm and does not queue the sounds it dropped.
const unlockAudioOnce = () => { audio.unlock() }
window.addEventListener('pointerdown', unlockAudioOnce, { once: true, capture: true })
window.addEventListener('keydown', unlockAudioOnce, { once: true, capture: true })
window.addEventListener('touchstart', unlockAudioOnce, { once: true, capture: true, passive: true })
settingsUi.updateSettingsUi()

// ---- Locale switch (docs/Technical/LOCALIZATION.md) -------------------------
// src/i18n already rewrote the STATIC markup (data-i18n nodes) by the time this runs; what is
// left is the DYNAMIC text, which holds no key of its own and has to be repainted from the
// state the game is in. Every repaint below reads live getters, so this is the same render
// path an ordinary frame uses — no second implementation, and nothing here can invent a value.
//
// The status line is recomputed from the pause state rather than remembered: while the player
// is in the settings panel flipping the language, `isPaused` is the only true answer.
function refreshStatusLine() {
  if (homeUi.isOpen()) setStatus(t('status.home'))
  else if (isPaused || session.isEnded()) setStatus(t('status.paused'))
  else setStatus(t('status.idle'))
}

onLocaleChange(() => {
  updateHud()
  renderItemBar()
  renderAxisPick()
  // The candidate slots carry a translated aria-label, and rebuilding them is the path a
  // reroll already exercises every run. A language switch is a one-off user action, so the
  // three preview renderers it recreates are not a cost worth a second label-only code path.
  renderPieceSlots()
  refreshHome()
  homeUi.renderLeaderboard()
  // Only ever set by endGame(), which is also the only path that shows the card.
  if (session.isEnded() && lastSummary) gameOverUi.renderGameOver(lastSummary)
  refreshStatusLine()
})

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
// v0.11.2 — the page-load path does NOT play the opening wave.
//
// beginRun()/leaveHome() arm it (armIntroIfVisible), and that is right for every entry that
// follows a BUTTON: 新游戏 / 再来一局 / 重新开始 rebuild the run in place, with the player
// already looking at the board, and the construction is the reward for having pressed something.
// A player who just OPENED the page is in the opposite situation: they are waiting for their
// board back, and the wave's first second shows the cube's primer stage with its core visible
// through a half-built shell — which is precisely the 穿帮 the boot curtain hides. So it is
// settled here, immediately: the cube is standing in its real colours before the curtain lifts.
settleIntro()
// The trays were just filled, so the board's wrapper is shorter than it was when resize()
// measured it a moment ago; the ResizeObserver catches that, and the wave re-sorts itself
// once if it armed before the new size landed (see updateIntro()).
resize()
platform.initialize().catch(() => showToast(t('toast.offline')))

// The boot curtain (v0.11.2). `release()` is the only thing that can lift it, and it waits for
// the scene to be COMPLETE — see ui/bootScreen.js for why that is two ready frames and why there
// is a hard timeout. The predicate reads the tray's own DOM: the slots are the thing the player
// was staring at while it was empty.
bootUi.release()

// ---- The board's idle float (original handoff §8, correction handoff §7.2) ------------------
//
// The board drifts ±0.02 cell — 0.02 world units at pitch 1 — on a 5.5s cycle while nothing is
// happening, and is FROZEN AT ITS CURRENT OFFSET the moment anything is: a pointer going down
// (the face-turn gesture included, which starts before any threshold is crossed), a piece drag,
// an armed tool, the opening wave, a face-turn snap, every pause state (cover, settings, result
// card, hidden page), and reduced-motion.
//
// Two rules are what make this read as the board breathing rather than as the board jittering
// under the player's finger, and both are easy to get wrong by writing the obvious thing:
//
//   * FREEZE HOLDS THE VALUE, IT DOES NOT RESET IT. Zeroing on pointerdown would move the board
//     by up to ~2px at exactly the moment the player is deciding where to drop — the same
//     class of bug the turn-band lift was clamped for.
//   * RESUME BLENDS FROM WHERE IT STOPPED over 0.25s while the phase keeps running underneath,
//     so there is no restart-from-zero-phase jump either. `ambientTime` advances ONLY while the
//     board is free; that is what makes the held value and the resumed sine agree.
//
// The offset is RECOMPUTED from the fixed base every frame and written to `cubeGroup.position.y`.
// It is never accumulated (`position.y += sin(...)`) — that drifts, which is the one failure
// mode a float has that a still screenshot can never show.
const BOARD_FLOAT = Object.freeze({ amplitude: style.idleFloatAmplitude, period: 5.5, resume: 0.25 })
let ambientTime = 0
let floatHeldY = null
let floatBlend = 0
// DEV-only pin, per handoff §8.7: "截图/探针提供新增的 ambientTime 固定值、bob=0、seed=74123 控制".
// Without it the board is at a different height in every capture, and two screenshots of the same
// build stop being comparable — the same reason the block grain is deterministic.
let floatOverride = null
const reduceMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

function boardFloatFrozen() {
  if (reduceMotionQuery?.matches) return true
  if (isPaused) return true
  if (introPlaying()) return true
  if (input.hasDrag() || input.hasViewGesture() || input.hasItemActive()) return true
  // The snap is read live: mid-turn the cube is converging on a face and must not also be
  // sliding vertically underneath the convergence.
  if (cubeSnapAnim?.active) return true
  return false
}

function boardFloatOffset(dt) {
  const live = BOARD_FLOAT.amplitude * Math.sin(2 * Math.PI * ambientTime / BOARD_FLOAT.period)
  if (floatOverride) {
    // A pinned float is a still pose, not a paused one: `{ frozen: true, time: 0 }` is exactly
    // zero, which is what the screenshot driver asks for.
    if (!Number.isFinite(floatOverride.time)) return 0
    return BOARD_FLOAT.amplitude * Math.sin(2 * Math.PI * floatOverride.time / BOARD_FLOAT.period)
  }
  if (boardFloatFrozen()) {
    if (floatHeldY === null) floatHeldY = live
    floatBlend = 0
    return floatHeldY
  }
  ambientTime += dt
  const target = BOARD_FLOAT.amplitude * Math.sin(2 * Math.PI * ambientTime / BOARD_FLOAT.period)
  if (floatHeldY === null) return target
  floatBlend = Math.min(1, floatBlend + dt / BOARD_FLOAT.resume)
  const eased = floatBlend * floatBlend * (3 - 2 * floatBlend)
  const offset = floatHeldY + (target - floatHeldY) * eased
  if (floatBlend >= 1) { floatHeldY = null; floatBlend = 0 }
  return offset
}

const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  // G0 (MATERIAL_GROUNDING_REWORK_HANDOFF §4.5): draw calls and triangles are only meaningful
  // as a WHOLE-frame total, and three resets them on every render() call by default — the post
  // chain makes several. gameScene turns that auto-reset off; the frame's own boundary is here,
  // so this is where they are zeroed. Presentation-only: no gameplay path reads them.
  renderer.info.reset()
  const measure = clock.getDelta()
  const raw = Math.min(measure, 0.05)
  // The L5 dip scales the CUBE's animation clock (handoff §7.3): the celebration is scheduled on
  // the wall clock, so a 1.4s decoration tail can never be stretched to 2.3s by the 0.6× dip.
  const delta = effects.timestep(raw)
  // v0.13.0 R4 (handoff §7.2): the environment runs on the SAME clock as everything else and is
  // deliberately above the home branch below — 「主页继续环境而不继续玩法逻辑」. It moves clouds
  // and building bob only; no gameplay state and no board pose is touched here.
  floatingWorld.update(raw)
  // v0.13.0 R5 (handoff §9.4): the cover PAUSES the game, it does not stop the frame.
  //
  // `if (homeUi.isOpen()) return` used to leave the world unrendered behind the cover, so the
  // home screen could only ever be a flat panel — and §8 asks for 「延续对局的积木世界」 on it.
  // The frame now always runs; what the cover changes is WHAT IS UPDATED and WHAT IS DRAWN.
  // Gameplay updates are skipped, the ambient clock above is deliberately NOT (it is outside this
  // branch), and the scene keeps rendering.
  const onCover = homeUi.isOpen()
  if (!onCover) {
    // The opening wave runs on its own clock. It is deliberately NOT inside the
    // `!isPaused` branch below: it is the thing that raised isPaused (that is the input
    // lock), so gating it there would deadlock it on its own first frame. It also gets
    // the UNCLAMPED delta: the 0.05s clamp exists so a stalled frame cannot teleport a
    // snap or a particle system, but applying it to the wave would stretch a 1.05s
    // introduction into five seconds of half-built cube on a device that cannot hold
    // 60fps. If the frames are that slow, the wave should simply be over.
    updateIntro(measure)
    // Deliberately outside the `!isPaused` branch: the strip has to be able to go grey ON the
    // pause (the wave arming) as well as come back after it.
    syncItemStrip()
    if (!isPaused) {
      // The RAW delta: the paper celebration runs on the wall clock, and only the cube's own snap
      // reads the dipped `delta` above.
      effects.update(raw)
      updateCubeSnap(delta)
    }
    // v0.13.0 R5 (handoff §8.3, the frame order): decide and WRITE the float after the orientation
    // snap and before anything that reads the cube's world matrix — the ghost, the landing marker,
    // the item scope, the particle birth points and the pointer plane all take their anchors from
    // `cubeGroup.matrixWorld`, so a write after them would leave them solving against last frame's
    // pose. `updateMatrixWorld(true)` is forced rather than left to `renderer.render()`, which runs
    // after `updateRenderCamera()` and would therefore hand the render camera a stale matrix — the
    // exact one-frame lag the R4 side fixed inside `updateRenderCamera()`.
    // On the cover this is not called at all, so the board keeps the offset it had — the same
    // "freeze at the current value" rule the interaction freezes use.
    cubeGroup.position.y = boardFloatOffset(raw)
    cubeGroup.updateMatrixWorld(true)
    // Bare tiles wear the lighter timber on the face the player is working on
    // (05 §2). 98 material assignments is cheap, but the cached front face means it
    // only happens on the frames where the cube actually finished turning. While a wave
    // is playing the blocks wear their own wave material instead and must not be
    // repainted under it.
    if (!introPlaying() && findFrontFace() !== boardView.getTileFrontFace()) applyTileMaterials()
    updatePiecePreviews()
    // 07 §8.5.4: the quiet pulse on the cells that will actually disappear. It rides the same
    // frame loop as everything else (the plan's "只有一个时钟" rule) and is a no-op with no scope
    // on screen, so an ordinary frame pays nothing for it.
    if (input.hasItemActive()) pulseItemScope(clock.elapsedTime)
  }
  // Hide the BOARD, not the world — §9.4: 「隐藏游戏 FX 不等于清空游戏状态」. Nothing is torn
  // down and no system is reset: the board simply stops being drawn, and the effects stop being
  // drawn while their systems keep their particles for the frame the board comes back on.
  cubeGroup.visible = !onCover
  effects.setVisible(!onCover)
  // The camera's resting position, restored every frame by its owner (gameScene owns the orbit
  // distance, the zoom and the direction); effects returns only the shake offset added on top.
  camera.position.copy(getCameraDir()).multiplyScalar(getOrbitDistance() * getCameraZoom())
  camera.position.add(effects.updateShake(delta))
  camera.lookAt(cameraTarget)
  // v0.13.0 R3 (handoff §9.4): the render camera is derived from the canonical one EVERY frame,
  // after the canonical camera has been placed — the gestures, the zoom wheel and the turn-band
  // lift all move it, and the embedding is a function of its final matrix. This is the last
  // thing that happens before the frame is drawn, and nothing may call
  // `updateProjectionMatrix()` on the render camera after it.
  scene3d.updateRenderCamera()
  composer.render(delta)
}
// Diagnostics (refactor P9): the `__voxalblast` read-only hook and the DEV-only write
// handles moved to diagnostics.js, which only ASSEMBLES what each owner module reports
// (boardView's pose and framing, gameScene's post chain, pieceView's previews, the stores'
// snapshots). This file hands it the modules and the DEV callbacks; the module mounts the two
// globals under the names the headless checks have always used.
//
// The callbacks stay HERE on purpose: a `jam()` that writes 60 cells or a `demoReward()` that
// drives a reward signature is a gameplay action, not a read-out, and the plan forbids
// diagnostics from becoming the entry point for one (plan §2.1). They are built only under
// import.meta.env.DEV, so the production bundle carries neither the bag nor the closures.
const devHandles = import.meta.env.DEV
  ? {
    endGame: () => endGame(),
    openLeaderboard: () => openLeaderboard(),
    // v0.13.0 R5 (handoff §8.7): pin the board's idle float. `{ frozen: true, time: 0 }` is a
    // still board at exactly zero — what the screenshot driver asks for so two captures of the
    // same build remain comparable. `null` hands the float back to the live clock.
    setBoardFloat: (values) => {
      floatOverride = values && values.frozen
        ? { frozen: true, time: Number.isFinite(values.time) ? values.time : 0 }
        : null
      return floatOverride
    },
    // v0.13.0 R4 (KNOWN_GAPS §3 / handoff §8.7 / §C0.4): the SAME pin for the scenery half of
    // the world. The board's float and the ambient displacement are two clocks, so pinning only
    // one left the other running and two captures of the same build still differed pixel for
    // pixel. The semantics are deliberately identical to `setBoardFloat` above — `{ frozen: true,
    // time: 0 }` is the neutral still pose, `null` hands it back to the live clock — so a driver
    // pins both with one shape and cannot pin them to different poses by accident.
    setAmbient: (values) => floatingWorld.setAmbient(values),
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
    //
    // v0.10.3: `showChain` / `showHonor` are GONE with the components they drove (the resident
    // CHAIN pill and the honour banner). `demoReward` replaces them: it takes the three counts
    // a reward is made of and runs the REAL rule (scoring.js settleScore) through the REAL
    // presentation (the note, the main cue, the reward shake), which is what the five demos
    // §6.4 asks for need.
    showScorePop: (points, options) => showScorePop(points, options),
    demoReward: (lines = 0, chain = 0, wipedFaces = 0) => {
      const lineCount = Math.max(1, Number(lines) || 1)
      const chainCount = Number(chain) || 0
      // 净面只算落子面（制作人口径）：一手最多 1 个面，所以演示入口也**不能**造出 2 面以上的
      // 状态 —— 一个演示不出的状态不该能被截图。
      const faceCount = Math.max(0, Math.min(Number(wipedFaces) || 0, 1))
      const score = settleScore({
        cellCount: 4, lines: lineCount, chain: chainCount, wipedFaces: faceCount,
      })
      const face = findFrontFace()
      const descriptors = []
      for (let index = 0; index < Math.min(lineCount, SH); index += 1) {
        const axis = index % 2 === 0 ? 'row' : 'col'
        descriptors.push({
          face,
          axis,
          index,
          cells: Array.from({ length: SH }, (_, k) => (axis === 'row'
            ? faceLattice(face, index, k)
            : faceLattice(face, k, index))),
        })
      }
      // The demo drops on the front face, so that is the face a wipe would have to be about —
      // the same narrowing the real settlement does, not a parallel one.
      const rewardEvent = {
        eventId: -1, // a demo is not a settled placement and never enters the run's numbering
        scoreRulesVersion: SCORE_RULES_VERSION,
        lines: lineCount,
        chain: chainCount,
        wipedFaces: faceCount ? [face] : [],
        rewards: score.rewards,
        primaryType: score.primaryType,
        total: score.total,
      }
      const level = rewardLevel({ lines: lineCount, rewards: score.rewards })
      const feedback = rewardFeedback(score.rewards)
      if (feedback.shakePx > 0) triggerRewardShake(feedback.shakePx, feedback.shakeMs)
      showRewardNote(rewardEvent)
      showScorePop(score.total)
      spawnClearEffects(descriptors, level, { reward: rewardEvent })
      audio.playClear(level, { reward: rewardEvent })
      playHaptic(feedback.haptic || 12)
      return { level, score, rewardEvent, feedback, ...effects.report() }
    },
    // v0.10.1 clear-celebration probe (handoff §10 R2/R4). An L1–L5 clear cannot be arranged on
    // demand — the board would have to be filled to a specific pattern first — so this builds
    // REAL line descriptors off the front face's lattice and hands them to the very same
    // spawnClearEffects() and audio.playClear() the gameplay path calls. It competes for nothing:
    // the report it returns is the effects layer's own event record.
    //
    // The third argument (the old `milestone`) and the second (`faces`) are both gone: version 2
    // has no chain milestone, and facesHit stopped being a level input when the level moved to
    // the reward result (§4.2 清理 demoClear 旧参数).
    demoClear: (lineCount) => {
      const lines = Number(lineCount) || 1
      const face = findFrontFace()
      const descriptors = []
      for (let index = 0; index < Math.min(lines, SH); index += 1) {
        // Alternating row/column on ONE face is deliberate: they intersect, so a two-line demo
        // carries a genuinely SHARED cell and the probe can assert it is deduped once.
        const axis = index % 2 === 0 ? 'row' : 'col'
        descriptors.push({
          face,
          axis,
          index,
          cells: Array.from({ length: SH }, (_, k) => (axis === 'row'
            ? faceLattice(face, index, k)
            : faceLattice(face, k, index))),
        })
      }
      // A demo with no reward event: the level is the plain clear ladder (L1–L5 by line count),
      // which is what the celebration budget and the clear cue are indexed by.
      const level = rewardLevel({ lines, rewards: [] })
      spawnClearEffects(descriptors, level)
      audio.playClear(level)
      return { level, ...effects.report() }
    },
    // v0.13.3 (CARTOON_CLEAR_VFX_HANDOFF §9.1): the rule cases in the handoff's own table cannot
    // be built by `demoClear()` -- that entry makes line descriptors without a Board, so it can
    // prove a budget but never "raw 2 / physical 1 / 5 unique cells". This drives the REAL drop:
    // the candidate is a real hand piece, the cells come from the same
    // `currentCells` → `faceOrientedCells` pair the input layer uses, and the call lands in the
    // same `onDrop()` a finger release lands in. It refuses an illegal placement instead of
    // forcing one, so a fixture that is one cell away from a line can only produce that line.
    dropAt: ({ pieceIndex = 0, face = null, u = 0, v = 0, origin = null } = {}) => {
      const piece = getPieces()[pieceIndex]
      if (!piece) return { ok: false, reason: 'no such candidate' }
      if (piece.used) return { ok: false, reason: 'candidate already used' }
      const targetFace = face || findFrontFace()
      const cells = faceOrientedCells(targetFace, currentCells(piece))
      const target = origin && Number.isFinite(origin.u)
        ? { u: Math.round(origin.u), v: Math.round(origin.v) }
        : { u: Math.round(u), v: Math.round(v) }
      if (!board.canPlace(targetFace, cells, target)) {
        return { ok: false, reason: 'illegal placement', face: targetFace, piece: piece.shape.name, cells, origin: target }
      }
      const settled = onDrop({ piece, face: targetFace, cells, origin: target })
      return {
        ok: true,
        face: targetFace,
        piece: piece.shape.name,
        cells,
        origin: target,
        // The raw face lines the rules layer really produced. `face`/`axis`/`index`/`cells` are
        // board.js's own line record; the physical-line de-duplication is the VFX planner's job
        // and is read from its own report, never recomputed here.
        rules: {
          lines: (settled?.lines || []).map((line) => ({
            face: line.face, axis: line.axis, index: line.axis === 'row' ? line.v : line.u,
            cells: line.cells,
          })),
          lineCount: settled?.lineCount ?? null,
          level: settled?.level ?? null,
          score: settled?.score ?? null,
          rewardEvent: settled?.rewardEvent ?? null,
        },
        ...effects.report(),
      }
    },
    clearCelebration: () => { clearTransientEffects() },
    // The bus's measurement window (§9): "was anything heard SINCE here" is the only question
    // that can tell a silenced master from a master that was never driven. Zeroes the running
    // output peak; the cue count is monotonically increasing so the probe diffs it itself.
    audioReset: () => audio.resetOutputWindow(),
    audioUnlock: () => audio.unlock(),
    // G1 grounding diagnostics (docs/Technical/MATERIAL_GROUNDING_REWORK_HANDOFF.md §5).
    // Presentation-only switches: no board cell, no score, no hand, no camera position and no
    // framing number moves, and the only thing `hold` writes is the rendered pose (the logical
    // pose, the bearing and the run are untouched). DEV-only, so the shipped bundle carries
    // neither the bag nor these closures.
    grounding: {
      ssao: (on) => scene3d.setSSAOEnabled(on),
      route: (route) => scene3d.setGroundingRoute(route),
      contactDecal: (on) => scene3d.setContactDecalEnabled(on),
      projectedShadow: (on) => scene3d.setProjectedShadowEnabled(on),
      occlusion: (value) => scene3d.setOcclusionIntensity(value),
      hold: (axis, angle) => boardView.holdDiagnosticPose(axis, angle),
      release: () => boardView.clearDiagnosticPose(),
      report: () => scene3d.groundingReport(),
    },
  }
  : null

createDiagnostics({
  version: packageInfo.version,
  // v0.13.0 R3: no `canvas` here any more. The board's box is the gameplay rect, and
  // `scene3d` is the module that defines it — passing the renderer's element as well is how
  // the two got confused in the first place (see diagnostics.js's `boardRect`).
  scene3d,
  floatingWorld,
  boardView,
  blocks,
  pieceView,
  effects,
  audio,
  input,
  session,
  recordStore,
  sessionStore,
  homeUi,
  bootUi,
  settingsUi,
  dev: devHandles,
}).install()

applyCubeRotation()
animate()

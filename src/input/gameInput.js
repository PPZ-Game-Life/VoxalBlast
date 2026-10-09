// Game input -- the gestures, the pointer coordinates and the keyboard (refactor P7a/P7b).
//
// Plan section 2.1, `gameInput`: it owns the selection, the drag records, the pointer
// coordinates, the click suppression and the interaction gates. It must NOT touch the board, the
// score or the records, and it does not create a renderer: it decides WHAT the player did and
// asks the rest of the game for it through named callbacks (plan section 6 P7 item 2).
//
// The pose is boardView's (plan item 5). What is kept here is the gesture record and nothing
// else: where the finger went down, which band it started in, which axis it claimed and the
// ruler that axis is measured against.
//
// P7 lands in slices, because every listener this phase owns is shared by all three gesture
// groups (one pointerdown arbitrates between the item, the view and the piece; one pointermove
// feeds all three). P7a took the view rotation and the keyboard, P7b the piece placement drag,
// P7c takes the item targeting, and the listener block itself moves into bind() only once all
// three handlers live here -- until then main's listeners delegate to the methods below.
import * as THREE from 'three'
import { gestureAxisReady, pickGestureAxis, screenBand, swipeAngle } from '../rendering/swipe.js'
import { axisForKey } from '../rendering/keyboard.js'
import { DRAG_GHOST, dragGhostLiftPx, ITEM_STYLE, ROTATE_STYLE as rotateStyle } from '../rendering/config.js'
import { faceLattice, SH } from '../game/board.js'
import { t } from '../i18n/index.js'
import { ITEM_COPY } from '../ui/itemCopy.js'
import { createEdgeTurn } from './edgeTurn.js'

export function createGameInput({
  canvas,
  // v0.13.2: the second surface the view gesture may start from — the background layer itself.
  // `canvas` above is the board's own hit box AND the NDC ruler, and those two jobs cannot be
  // given to the same bigger element; this one only has to receive the press. See
  // `onBackgroundDown` in bind().
  background,
  // Read-only queries and the interaction gates (plan section 3: nothing here is copied, and
  // nothing here is written).
  isPaused,
  isEnded,
  // v0.9.31: the deal worker is computing a hand. The piece and item gates below read it while a
  // batch is in flight — the hand on screen is the used-up one it is replacing, so neither may be
  // acted on until it lands.
  isDealing,
  isHomeOpen,
  isSettingsOpen,
  isControlsOpen,
  // v0.9.12: the 拖块翻面 preference (settings panel). Read live on every frame the dwell could
  // arm — never captured — so flipping the switch applies to the gesture in progress rather than
  // to the next run.
  isDragTurnOn,
  // gameScene: the cube's screen box, the angle ruler a claimed axis is measured on, and the two
  // camera commands the wheel drives (P7d).
  cubeScreenBounds,
  gestureSpan,
  zoomBy,
  fitCameraToPlaySpace,
  // boardView: the pose commands and the live gesture record. `cubeSnapAnim` is a const object
  // mutated in place, so it can be handed over as-is.
  cubeSnapAnim,
  ROT_STEP,
  settleCubeSnap,
  beginAxisGesture,
  setLiveAngle,
  startCubeSnap,
  getLive,
  // boardView: the coordinate conversions and the front face a dropped piece lands on.
  findFrontFace,
  faceOrientedCells,
  cellWorld,
  cubeVector,
  facePlaneLocalCenter,
  // The camera and the cube the pointer is unprojected against, plus the lattice pitch. Read-only
  // references, handed over the same way boardView takes its metrics.
  camera,
  cubeGroup,
  cs,
  // The board answers legality and the session owns a candidate's cells; the input layer reads
  // both and mutates neither (plan section 2.1).
  canPlace,
  // Read-only room availability for drag diagnostics.
  anyPlacementOn,
  currentCells,
  // A tool's reach is the session's rule (P6b-1) and whether a cell is taken is the board's; the
  // overlay that draws the answer is pieceView's. Both are read through here. The FACE-cell form
  // is what the new scope needs (07 §8.5.4 draws the frame per cell, spaces included), and it is
  // the session's own single definition of the reach — `toolScopeCells` is now derived from it,
  // so the frame and the clear cannot disagree about where a tool reaches.
  toolScopeFace,
  isOccupied,
  // The charges are game data (P6b-1) and the strip is hud's, but the two questions "may this be
  // picked up at all" and "is it empty" are the mode's, so they are asked here.
  getItemCounts,
  // The two DOM strips a release over means "put it back". ui/dom owns the elements; the input
  // layer only measures them, which is why it gets them as a list rather than as selectors.
  cancelZones,
  // main's callbacks -- the legend the keyboard teaches, and everything a gesture makes the
  // player see. The two item ones (the strip's repaint and the Row/Col panel) are hud's; the
  // overlay and the axis panel's visibility are pieceView's and the DOM's.
  onControlsSpin,
  onAxisHint,
  // main's callbacks -- the Escape chain's two panel halves (see bind() below) and the modal
  // guard that follows the rotation keys.
  onEscapeBeforeGestures,
  onEscapeAfterGestures,
  isModalOpen,
  // main's callbacks -- everything a gesture makes the player see, and the one action a settled
  // drop performs (plan section 6 P7 item 2: the DOM updates, the placement, the save and the
  // restart are main's; the gesture only says what happened).
  onStatus,
  onToast,
  onHaptic,
  onEdgeTurn,
  onCancelZone,
  onSelectionChanged,
  onItemBar,
  onAxisPick,
  onAxisPickVisibility,
  onClearOverlay,
  onShowOverlay,
  onConfirmItem,
  // 07 §8's own callbacks: the status bar's repaint, the batch question's bar, the refusal of an
  // empty charge, the undo window that a re-armed tool has to close (§8.9), and the one hint the
  // mode owes a player who tries to turn the cube while holding a tool.
  onItemStatus,
  onRefreshConfirm,
  onConfirmRefresh,
  onEmptyItem,
  onRearm,
  onItemLockedRotate,
  onBuildGhost,
  onSyncGhost,
  onClearGhost,
  onReturnPiece,
  onClearLanding,
  onShowLanding,
  onDrop,
}) {
  // The rotation gesture. `let`, because every gesture replaces it, and never handed out: a
  // destructured copy would go stale the moment a gesture ends (the rule boardView's bearing
  // follows).
  let viewDrag = null

  // The piece drag (P7b). `selectedPiece` is the candidate the player has picked up or tapped,
  // `drag` the live gesture, and `suppressPieceClickUntil` the window in which the click that
  // follows a gesture must NOT be read as a fresh selection (v0.4.4: a drop used to re-select the
  // piece it had just placed).
  let selectedPiece = null
  let drag = null
  let suppressPieceClickUntil = 0
  const edgeTurn = createEdgeTurn({
    // v0.9.11: the ruler is the CUBE's own silhouette, not the viewport. The trigger point is
    // the carried piece's centre, which `ghostCentre` below measures from the same lift the
    // ghost is drawn with -- so "the block is more than half off the cube" is the exact
    // condition, and the screen edge no longer plays any part in it.
    bounds: cubeScreenBounds,
    // v0.9.12: the 拖块翻面 switch is a gate of the dwell, not of the gesture. With it OFF the
    // piece is carried exactly as before — `updateDrag()` simply never enters the turn branch,
    // so the whole "carried off the cube" path is unreachable and nothing else about the drag
    // changes (the cube is still turned by the keyboard and by dragging the background).
    blocked: () => !drag?.active || !isDragTurnOn() || isPaused() || isEnded() || isHomeOpen()
      || isSettingsOpen() || isControlsOpen() || document.hidden,
    turning: () => cubeSnapAnim.active,
    feedback: onEdgeTurn,
    haptic: onHaptic,
    turn: ({ axis, direction }) => {
      if (!rotateByKey(axis, direction)) return false
      drag.turned = true
      detachFace()
      drag.attached = false
      drag.origin = null
      drag.valid = false
      onClearLanding()
      onStatus(t('status.turning'))
      return true
    },
  })

  // The armed tool (07 §8, 交互 v1). ONE state object for the whole interaction, because the
  // doc's §8.9 table is one table: 普通态 / 已选中态 / 拖拽态 / 待确认态 / 换批确认态 are phases
  // of the same thing, and §8.4 is entirely about which transitions are legal. The shipped
  // version split it into three variables (itemActive / itemTap / a 6px tap test) and that is
  // exactly what let "aim at a cell" and "turn the cube" share one gesture with neither of them
  // owning it — the doc's first listed 痛点.
  //
  //   null                           普通态：没有拿起的道具，棋盘手势照旧
  //   { phase: 'selected' }          轻点选中，还没有目标
  //   { phase: 'locked' }            目标已固定，"使用 · −1" 可用（轻点备用路径的待确认态）
  //   { phase: 'dragging' }          从图标拖出，跟手瞄准（主路径）
  //   { phase: 'refresh-confirm' }   换批确认条已弹出，等待 换一批 / 保留当前
  let itemMode = null
  // The scope the player is LOOKING AT right now. §8.5.7 makes this load-bearing rather than a
  // convenience: the release may only commit this object, so "what the preview showed" and
  // "what actually lands" cannot be two different answers.
  let itemScope = null
  let itemScopeKey = null
  // The short hold after a committed use (§8.9: 约 420ms). It gates the NEXT pickup, which is
  // what stops a double tap from spending two charges on one clear.
  let itemBusyUntil = 0
  // The click the browser synthesises after a drag must never be read as a fresh tap (§8.4:
  // 「生成的后续 click 必须吞掉」). Same idea as the candidate strip's suppressPieceClickUntil.
  let suppressItemClickUntil = 0
  // The press on an icon that has not decided yet whether it is a tap or a drag (§8.4's slop).
  let itemPickup = null
  // §8.7: the rocket's direction is the player's last ACTIVE choice, remembered for the loaded
  // run only — cancelling, undoing, blurring or opening the settings panel must not reset it, but
  // a new run and a resume do (see resetItemTargeting).
  let rocketOrientation = 'row'

  function hasItemActive() {
    return Boolean(itemMode)
  }

  function getItemActive() {
    return itemMode
  }

  // A pointer event in NDC against the canvas box. The input layer's own ruler: the view
  // gesture, the item targeting and the piece drag all measure the pointer with it.
  function eventNdc(event) {
    const rect = canvas.getBoundingClientRect()
    return new THREE.Vector2(
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
    )
  }

  // ---- The view gesture (rotation) --------------------------------------------
  function beginViewGesture(event) {
    if (isPaused() || hasDrag() || event.pointerType === 'mouse' && event.button !== 0) return
    // A gesture whose pointerup never arrived must not block this one: if we held
    // the pointer capture for it and the capture is gone, that pointer is gone too.
    if (viewDrag && viewDrag.pointerId !== event.pointerId && viewDrag.captured
      && viewDrag.source?.hasPointerCapture?.(viewDrag.pointerId) === false) cancelViewGesture()
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

  // One pointermove for a live view gesture. Returns true when this gesture owns the pointer, so
  // the caller stops arbitrating -- the same `return` the inline branch used to do, including the
  // early one below: until a decisive direction claims the gesture the pose must not move at all.
  function updateViewGesture(event) {
    if (!viewDrag || event.pointerId !== viewDrag.pointerId) return false
    event.preventDefault()
    // 07 §8.4: an armed tool no longer shares this gesture at all. The shipped version kept the
    // target under the pointer while the cube turned ("瞄准态还能转面"); the redesign removes that
    // trade outright — 一次手势只有一种含义 — and `onPointerDown` never starts a view gesture
    // while a tool is armed. The old `onItemHover()` call that used to live here is gone with it.
    const dx = event.clientX - viewDrag.startX
    const dy = event.clientY - viewDrag.startY
    if (!viewDrag.axis) {
      // Until a decisive dominant direction claims the gesture the pose does not
      // move at all: a few px of sideways drift must never be able to swallow a
      // vertical swipe (rendering/swipe.js).
      if (!gestureAxisReady(dx, dy)) return true
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
    return true
  }

  function finishViewGesture(event) {
    if (!viewDrag || (event?.pointerId !== undefined && event.pointerId !== viewDrag.pointerId)) return
    const currentViewDrag = viewDrag
    viewDrag = null
    releasePointerCapture(currentViewDrag.source, currentViewDrag.pointerId)
    // No axis was claimed (a tap, or a drag that never committed): the pose never moved.
    const live = getLive()
    if (live) startCubeSnap(live)
  }

  // A view gesture can outlive its pointer: the page goes hidden, a native gesture
  // hijacks the touch, the window loses focus with the button still down. The
  // pointerup then never arrives, and because beginViewGesture() refuses to start a new
  // gesture while `viewDrag` is set, rotation would stay dead for the rest of the
  // session (placement keeps working, which is exactly how this shows up: "it won't
  // turn, it feels locked"). Every path that can lose a pointer ends the gesture
  // here and settles the halfway pose it left behind.
  function cancelViewGesture() {
    const live = getLive()
    if (!viewDrag && !live) return
    viewDrag = null
    if (live) startCubeSnap(live)
  }

  // A reset can land in the middle of a pointer gesture (boardView's resetCubeRotation asks for
  // the drop through its onRotationReset callback). The record is dropped WITHOUT settling: the
  // reset has already put the pose where it wants it.
  function resetRotation() {
    viewDrag = null
  }

  function releasePointerCapture(source, pointerId) {
    try {
      source?.releasePointerCapture?.(pointerId)
    } catch {
      // The browser may have already cancelled the pointer capture.
    }
  }

  // ---- Keyboard rotation ------------------------------------------------------
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
  function rotateByKey(axis, direction) {
    // A turn still in flight is settled instantly rather than queued: fast repeated
    // presses stay with the fingers instead of lagging behind a backlog.
    if (cubeSnapAnim.active) settleCubeSnap()
    if (getLive()) return false // a drag owns the pose right now
    beginAxisGesture(axis)
    const knob = axis === 'yaw' ? rotateStyle.yawDirection
      : axis === 'pitch' ? rotateStyle.pitchDirection : rotateStyle.rollDirection
    // The live gesture is handed back as the module's OWN record on purpose: this path writes
    // `angle` onto it WITHOUT rendering it, then passes that same object to startCubeSnap().
    const gesture = getLive()
    gesture.angle = direction * knob * ROT_STEP
    startCubeSnap(gesture)
    return true
  }

  // The legend's own feedback lives in ui/settings.js (`spinControlCube` / `showAxisHint`); this
  // module only routes the key and asks main for the two effects.
  //
  // Returns true when the event was a rotation binding and has been consumed.
  function handleRotateKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const binding = axisForKey(event.key)
    if (!binding) return false
    if (isControlsOpen()) {
      onControlsSpin(binding.axis, binding.direction, event.key)
      return true
    }
    // Hold-to-repeat is off: one press = one face, exactly like one gesture = one face
    // (§3). A held key that spun the cube would be the only input in the game that can
    // outrun what the player sees.
    if (event.repeat) return true
    // 07 §8.4: the item mode takes the cube's rotation away on purpose, so the key is refused
    // AND explained — 「需换面？取消后转动棋盘」. Returning true consumes the key either way.
    if (hasItemActive()) {
      if (!isPaused() && !isHomeOpen() && !isSettingsOpen()) onItemLockedRotate()
      return true
    }
    if (isPaused() || hasDrag() || isHomeOpen() || isSettingsOpen()) return false
    if (!rotateByKey(binding.axis, binding.direction)) return true
    onAxisHint(event.key, binding.axis)
    return true
  }

  // ---- Piece placement drag (P7b) ----------------------------------------------
  // Where the piece may go is still the board's answer and the front face is still boardView's
  // (plan item 5); what lives here is the gesture: where the finger grabbed the face, how far it
  // has travelled, and whether the drop is legal. Nothing below changes the board -- the settled
  // drop is handed to main as `onDrop`.
  //
  // v0.8.27 reworked the model behind this gesture (the producer's 「吸附后调不动 / 到边缘反向
  // 拖动没反应」), and the shape of `drag` is that rework:
  //   - `face` / `cells`: the target face and the piece's orientation ON it, latched at the
  //     attach and kept until the pointer leaves the cube. Neither may be re-derived per frame.
  //   - `ref`: the piece's origin as a CONTINUOUS face coordinate — the carried value. The
  //     finger's own face travel is added to it and the result is truncated to the face every
  //     frame, so hitting an edge discards the over-travel instead of banking it.
  //   - `point`: the pointer's own face coordinate last frame, i.e. the ruler that travel is
  //     measured against. Null = no valid reading, and the next one re-syncs rather than
  //     applying a delta across the gap.
  //   - `origin`: the quantised target cell the preview is drawn at. Legality never moves it.
  function beginDrag(event, piece) {
    // A hand on its way in (v0.9.31) refuses pickups for the same reason a used-up one does: the
    // piece under the finger belongs to the hand that is being replaced, and the drop would settle
    // against a board the arriving batch was never computed for.
    if (piece.used || isPaused() || isDealing() || drag || hasItemActive()) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    selectedPiece = piece
    // A turn still in flight is settled BEFORE the piece is picked up: the drag measures the
    // face in the RENDERED pose, so a cube still slerping would move the ruler under the piece
    // for the first ~0.2s and the piece would swim away from the finger that just grabbed it.
    // The view gesture takes the same precaution, for the same reason.
    settleCubeSnap()
    // v0.9.13: a new gesture starts OUTSIDE the cube — the piece is in the tray. Until it has
    // been inside the silhouette once, nothing outside can arm the dwell, which is what keeps
    // the tray→cube entry (always through the bottom edge) from turning the cube on the way in.
    endTurns()
    edgeTurn.resetEntry()
    drag = {
      piece,
      pointerId: event.pointerId,
      source: event.currentTarget,
      ndc: eventNdc(event),
      face: null,
      cells: null,
      origin: null,
      ref: null,
      point: null,
      roomless: false,
      turned: false,
      valid: false,
      attached: false,
      active: false,
      inCancelZone: false,
      // The carried piece's centre on screen, last frame — the point the turn trigger measures
      // against the cube's silhouette (v0.9.11). Published through dragReport() so a check can
      // see the same number the arming rule saw.
      centre: null,
      startX: event.clientX,
      startY: event.clientY,
      // The grab reference: the contact point in client px and the piece's continuous
      // origin at the moment of the attach. Reported through dragReport() for the checks;
      // it is NOT the movement basis (the piece follows frame-to-frame travel).
      anchor: null,
    }
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Some embedded browsers reject capture during an interrupted gesture.
    }
    // Built here (hidden) so the first pointermove that crosses the drag threshold
    // has the piece ready instead of popping it in a frame late.
    onBuildGhost(piece)
    // The gesture's OWN source element -- the same one the capture was just taken on. The
    // authoritative repaint of the strip stays main's (onSelectionChanged -> pieceView).
    event.currentTarget.classList.add('selected')
    onStatus(t('status.dragToFace'))
  }

  // Attachment uses the cube silhouette; turning uses the viewport edges independently.
  function isPointerOnCube(ndc, margin = DRAG_GHOST.snapMarginPx) {
    const rect = canvas.getBoundingClientRect()
    const clientX = rect.left + (ndc.x * 0.5 + 0.5) * rect.width
    const clientY = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height
    const bounds = cubeScreenBounds()
    return clientX >= bounds.minX - margin && clientX <= bounds.maxX + margin
      && clientY >= bounds.minY - margin && clientY <= bounds.maxY + margin
  }

  // Hand the drag ghost its three rulers. All three are the input layer's to measure: the
  // pointer's NDC, the canvas it is over (the renderer's CSS box) and one cell of the cube as it is
  // drawn right now (gameScene's screen bounds, exactly the ruler the ghost has always used). What
  // is left — the two corner rays, the world-per-pixel scale and the tint — is the view's own
  // arithmetic and lives in pieceView.syncDragGhost() (plan §6 P4.3).
  function syncGhostFor(event, ndc, mode, keepInView = false) {
    onSyncGhost({
      ndc,
      canvasHeight: Math.max(canvas.getBoundingClientRect().height, 1),
      cellPx: ghostCellPx(),
      pointerType: event.pointerType,
      mode,
      keepInView,
    })
  }

  // One carried cell edge in client pixels: DRAG_GHOST.cellRatio of the board's own on-screen
  // cell pitch. The ghost is sized with it and the attach mapping below measures the lift in it,
  // so the piece in hand and the piece on the face can never disagree about their own size.
  function ghostCellPx() {
    const bounds = cubeScreenBounds()
    return Math.max(bounds.maxX - bounds.minX, 1) / SH * DRAG_GHOST.cellRatio
  }

  // Where the piece in hand LOOKS like it is: its bounding-box centre, which the ghost draws on
  // its group origin, lifted clear of the contact point by DRAG_GHOST. The attach has to map THIS
  // point, not the raw pointer — mapping the pointer would slide the piece by its own half-height
  // (a 3×3 piece by ~1.5 cells) the instant it left the hand, which is exactly the 「大方块进棋盘
  // 突然跳位」 the producer reported. Same lift rule as pieceView's, from config (v0.8.27).
  function grabPointNdc(event, ndc, piece) {
    const rect = canvas.getBoundingClientRect()
    const rows = currentCells(piece).reduce((max, [, v]) => Math.max(max, v), 0) + 1
    const liftPx = dragGhostLiftPx(event.pointerType, rows, ghostCellPx())
    // NDC y is up-positive. pieceView turns the same pixel lift into the same NDC offset through
    // the ghost's own world-per-pixel scale, so the two agree by construction, not by tuning.
    return new THREE.Vector2(ndc.x, ndc.y + (2 * liftPx) / Math.max(rect.height, 1))
  }

  // One lattice step of a face, in client pixels. The piece no longer solves its travel on this
  // basis (v0.8.27 measures it in face coordinates instead), but the headless report still
  // publishes it: it is the face's own orientation in screen terms, which is what a check reads
  // to prove the drag runs along the face the player is looking at rather than the screen axes.
  function faceStepScreen(face) {
    const rect = canvas.getBoundingClientRect()
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

  // Where the piece in hand LOOKS like it is, in client pixels: the ghost's bounding-box centre.
  // This is the very same point pieceView places the ghost with -- the pointer's own NDC lifted
  // by `dragGhostLiftPx`, converted back with the canvas' own box -- which is why the turn
  // trigger and the picture on screen can never disagree about "how far off the cube" it is.
  // v0.9.11: this is the turn trigger's ruler (the pointer's client px used to be).
  function ghostCentre(event, ndc, piece) {
    const rect = canvas.getBoundingClientRect()
    const point = grabPointNdc(event, ndc, piece)
    return {
      x: rect.left + (point.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (0.5 - point.y * 0.5) * rect.height,
    }
  }

  // Keep at least one row/column over the face, allowing partial overflow to be
  // shown as invalid instead of silently pushing the whole piece back inside.
  // Bound the CONTINUOUS origin every frame. The clamp is
  // applied to the carried coordinate itself rather than to the answer of a running pixel offset,
  // and that difference IS the 「边缘反向拖动空行程」 fix (v0.8.27): once the piece is against an
  // edge, further over-travel is discarded here, so the first pixel back moves it again. The old
  // model kept accumulating a grab-relative offset and clamped only the result, so reversing had
  // to pay the whole over-travel back before anything moved.
  function clampOrigin(cells, u, v) {
    const spanU = Math.max(...cells.map(([cu]) => cu))
    const spanV = Math.max(...cells.map(([, cv]) => cv))
    return {
      u: THREE.MathUtils.clamp(u, -spanU, SH - 1),
      v: THREE.MathUtils.clamp(v, -spanV, SH - 1),
    }
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
    // pointer landed. The rocket reads them to pick its line (07 §3.1 A5) and the piece
    // drag measures its whole travel on them (v0.8.27).
    return { u: Math.round(uF), v: Math.round(vF), fu: uF, fv: vF }
  }

  // Drop the attached half of the drag record: the piece is going back to being carried. The
  // latched face and cells go with it, so the next arrival on the cube re-grabs wherever the
  // pointer is — including its lift — instead of resuming from a stale origin.
  function detachFace() {
    if (!drag) return
    drag.face = null
    drag.cells = null
    drag.ref = null
    drag.point = null
    drag.roomless = false
  }

  // One frame of the placement preview. Returns true when the piece is ON a face (a landing
  // preview was drawn) and false while it is still being carried.
  //
  // v0.8.27 — THE TARGET AND THE LEGALITY ARE SEPARATE THINGS. The preview sits on the cell the
  // finger is over, ALWAYS: it slides straight across an occupied region wearing the invalid
  // paint, and returns to the piece's own colour the moment it clears. Until v0.8.26 an illegal
  // target kept the LAST LEGAL origin instead ("sticky"), which is what the producer felt as
  // 「吸附后继续调整很困难」: the pointer kept moving, the preview did not, and the release could
  // still drop on the stale legal cell. Legality now decides only what the marker looks like and
  // whether the release may commit.
  //
  // The position is a continuous face coordinate (`drag.ref`) advanced by the pointer's own
  // travel ON THE FACE, read from `ndcToCell`'s unrounded fu/fv. That single raycast is what
  // makes all six faces, their perspectives and the shape's orientation work without a second
  // copy of the face basis anywhere (plan §6 P4.4); quantising to a cell is `Math.round`, the
  // normal half-cell step — there is no easing, no dead zone and no nearby-legal search.
  function updatePreview(event, ndc) {
    onClearLanding()
    drag.attached = false
    drag.origin = null
    drag.valid = false
    if (!selectedPiece || !ndc || !drag?.active) { detachFace(); return false }
    if (!isPointerOnCube(ndc)) { detachFace(); return false }

    if (!drag.face) {
      // ---- the attach: the ONE moment the piece leaves the hand -----------------
      // No search for a "nearest legal origin" (dropped in v0.8.27): attaching searches the
      // whole face for the closest LEGAL cell, so a large piece could be thrown several cells
      // away from the finger and then drag on with that offset baked in. Direct mapping is the
      // first version, deliberately: the piece lands where it is held, legal or not.
      const face = findFrontFace()
      const cells = faceOrientedCells(face, currentCells(selectedPiece))
      // Two readings of the same face: where the POINTER is (the ruler the travel is measured
      // on from here on) and where the piece in hand looks like it is (its centre, lifted).
      const pointerPoint = ndcToCell(face, ndc)
      const grabPoint = ndcToCell(face, grabPointNdc(event, ndc, selectedPiece))
      if (!pointerPoint || !grabPoint) return false
      drag.face = face
      drag.cells = cells
      drag.roomless = !anyPlacementOn(face, cells)
      // The origin that puts the shape's bounding-box CENTRE where the ghost's centre was —
      // the one grab reference the hand and the face have in common.
      const centreU = Math.max(...cells.map(([cu]) => cu)) / 2
      const centreV = Math.max(...cells.map(([, cv]) => cv)) / 2
      drag.ref = clampOrigin(cells, grabPoint.fu - centreU, grabPoint.fv - centreV)
      drag.point = { fu: pointerPoint.fu, fv: pointerPoint.fv }
      drag.anchor = { x: event.clientX, y: event.clientY, u: drag.ref.u, v: drag.ref.v }
    } else {
      // ---- the follow: add this frame's travel, then truncate -------------------
      const point = ndcToCell(drag.face, ndc)
      if (point) {
        // A missing previous reading (the first frame after the attach or a re-attach, or a
        // frame whose ray missed the face plane) re-syncs instead of applying a stale delta.
        if (drag.point) {
          const du = point.fu - drag.point.fu
          const dv = point.fv - drag.point.fv
          const moved = clampOrigin(drag.cells, drag.ref.u + du, drag.ref.v + dv)
          drag.ref = moved
        }
        drag.point = { fu: point.fu, fv: point.fv }
      } else {
        drag.point = null
      }
    }

    const origin = { u: Math.round(drag.ref.u), v: Math.round(drag.ref.v) }
    const valid = canPlace(drag.face, drag.cells, origin)
    drag.origin = origin
    drag.valid = valid
    drag.attached = true
    // The marker itself is pieceView's (P4b): it draws the cells it is handed, in the piece's own
    // colour while this drop is legal and in grey when it is not.
    onShowLanding({ face: drag.face, cells: drag.cells, origin, valid, color: selectedPiece.shape.color })
    return true
  }

  // All termination paths clear the same frame clock and its visible feedback.
  function endTurns() {
    edgeTurn.cancel()
  }

  // The cancel target is the UI strip the drag came from, not one element: since v0.4.3
  // the item bar is a sibling of the candidate panel (it moves to the top on phones), and
  // releasing a piece over either strip has always meant "put it back".
  function isInsidePieceArea(event) {
    return cancelZones().some((element) => {
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) return false
      return event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
    })
  }

  // One pointermove for a live piece drag. Returns true when this gesture owns the pointer, so the
  // caller stops arbitrating.
  function updateDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return false
    event.preventDefault()
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return true
    if (!drag.active) {
      drag.active = true
      onCancelZone('piece', true, false)
    }
    const ndc = eventNdc(event)
    drag.ndc = ndc
    // v0.9.11 — the turn branch is driven by the CARRIED PIECE's centre against the CUBE's
    // silhouette, not by the pointer against the viewport edge: the finger only has to carry
    // the block until more than half of it hangs off the cube. That makes the branch reachable
    // while the piece is still ATTACHED (its centre can sit past the silhouette with the piece's
    // own body still covering a face), so it is asked AFTER the cancel strip below: "drag it back
    // to the tray" is an explicit instruction and must win over a turn that the piece's own
    // geometry happens to arm on the way there.
    drag.inCancelZone = isInsidePieceArea(event)
    onCancelZone('piece', true, drag.inCancelZone)
    if (drag.inCancelZone) {
      drag.valid = false
      drag.origin = null
      endTurns()
      // Back in the strip the piece is being put down, not held over a face: the next
      // arrival on the cube re-grabs wherever the finger is.
      detachFace()
      onClearLanding()
      syncGhostFor(event, eventNdc(event), 'cancel')
      onStatus(t('status.releaseToCancel'))
      return true
    }
    const centre = selectedPiece ? ghostCentre(event, ndc, selectedPiece) : { x: event.clientX, y: event.clientY }
    drag.centre = centre
    if (edgeTurn.update(centre)) {
      drag.inCancelZone = false
      onCancelZone('piece', true, false)
      detachFace()
      drag.attached = false
      drag.origin = null
      drag.valid = false
      onClearLanding()
      // 'turn' rather than 'carry': off the cube with the dwell armed, so the piece keeps its
      // own colour (the grey tint means "you cannot drop it here", and here there is no drop).
      syncGhostFor(event, ndc, 'turn', true)
      onStatus(t(edgeTurn.report().phase === 'turning' ? 'status.turning' : 'status.holdToTurn'))
      return true
    }
    // Keep the carried piece visible while a committed turn finishes.
    if (cubeSnapAnim.active) {
      drag.valid = false
      onClearLanding()
      syncGhostFor(event, ndc, 'carry')
      return true
    }
    const attached = updatePreview(event, ndc)
    // One piece per turn (v0.4.4): the ghost exists exactly while the piece is being
    // carried. Once it is attached to a face the board draws it and the carried copy
    // disappears; if the pointer is on the cube but this face has no room, the piece
    // stays in hand and turns grey instead of silently vanishing.
    syncGhostFor(event, ndc, attached ? 'snap' : isPointerOnCube(ndc) ? 'invalid' : 'carry')
    if (attached) onStatus(t(drag.valid ? 'status.releaseToPlace' : 'status.carryOffToTurn'))
    else onStatus(t(isPointerOnCube(ndc) ? 'status.noRoomOnFace' : 'status.dragToFace'))
    return true
  }

  // Cancel: the gesture is dropped and the piece goes back to the strip. `showFeedback` is the
  // difference between the player asking for it (a release in the strip, Escape, right-click) and
  // the page taking the gesture away (hidden tab, a new run).
  function cancelActiveDrag(showFeedback = true) {
    if (!drag) return false
    const currentDrag = drag
    drag = null
    releasePointerCapture(currentDrag.source, currentDrag.pointerId)
    endTurns()
    const returning = showFeedback && currentDrag.active
    if (returning) onReturnPiece(currentDrag.piece)
    onClearLanding()
    onClearGhost({ keepReturn: returning })
    selectedPiece = null
    suppressPieceClickUntil = performance.now() + 260
    onCancelZone(null, false, false)
    onSelectionChanged()
    onStatus(t('status.idle'))
    if (showFeedback) {
      onToast(t('toast.placementCancelled'))
      onHaptic(10)
    }
    return true
  }

  // A replacement run must not inherit the previous drag's pending dwell.
  function resetDrag() {
    endTurns()
    onClearLanding()
    drag = null
  }

  // v0.9.12: the 拖块翻面 switch was just flipped OFF. `blocked()` already stops the dwell from
  // arming again, but a dwell that is armed RIGHT NOW (or a turn already in flight) has to go at
  // once, or the switch would only take effect on the next pointermove. The gesture itself is
  // untouched: the piece stays in hand, and the next move re-attaches it wherever it is.
  function clearTurnDwell() {
    endTurns()
    if (drag) drag.centre = null
  }

  // The release. The caller (onPointerUp) has already fed the FINAL pointer coordinates through
  // updateDrag(), i.e. through the same rule that drew the last frame — so what is committed here
  // is exactly the preview the player was looking at, and nothing is re-derived or searched for
  // on the way out (v0.8.27). An illegal (or detached) target spends nothing and does NOT fall
  // back to a position the piece used to be on: `origin` is the current target or null.
  function finishDrag(event) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
    const currentDrag = drag
    // A release at an edge returns the piece; it cannot place during a turn.
    const atEdge = Boolean(edgeTurn.report().edge)
    endTurns()
    if (cubeSnapAnim.active) {
      settleCubeSnap()
      if (event && currentDrag.ndc && !atEdge && !currentDrag.inCancelZone) updatePreview(event, currentDrag.ndc)
    }
    drag = null
    releasePointerCapture(currentDrag.source, currentDrag.pointerId)
    const returning = currentDrag.active && (currentDrag.inCancelZone || !currentDrag.valid || !currentDrag.origin || !currentDrag.face)
    if (returning) onReturnPiece(currentDrag.piece)
    onClearLanding()
    onClearGhost({ keepReturn: returning })
    onCancelZone(null, false, false)
    if (!currentDrag.active) {
      selectedPiece = currentDrag.piece
      onSelectionChanged()
      onStatus(t('status.dragToFace'))
      return
    }
    suppressPieceClickUntil = performance.now() + 260
    if (currentDrag.inCancelZone) {
      selectedPiece = null
      onSelectionChanged()
      onStatus(t('status.idle'))
      onToast(t('toast.placementCancelled'))
      onHaptic(10)
      return
    }
    if (!currentDrag.valid || !currentDrag.origin || !currentDrag.face) {
      selectedPiece = null
      onSelectionChanged()
      onStatus(t('status.idle'))
      onToast(t('toast.tryAnotherSpot'))
      return
    }
    // The drop itself is main's: it settles the placement and presents it. The gesture hands over
    // the cells the preview actually showed, never a fresh re-derivation, so the drop matches what
    // the player saw under their finger.
    selectedPiece = null
    onDrop({
      piece: currentDrag.piece,
      face: currentDrag.face,
      cells: currentDrag.cells,
      origin: currentDrag.origin,
    })
  }

  // The candidate slots are built by main (they are DOM); their two pointer handlers are the
  // input layer's, so main hands each slot over as it creates it.
  function bindSlot(slot, piece) {
    slot.addEventListener('pointerdown', (event) => beginDrag(event, piece))
    slot.addEventListener('click', () => {
      if (!piece.used && !drag && !hasItemActive() && performance.now() >= suppressPieceClickUntil) {
        selectedPiece = piece
        onSelectionChanged()
        onStatus(t('status.dragToFace'))
      }
    })
  }

  function getSelectedPiece() {
    return selectedPiece
  }

  function clearSelection() {
    selectedPiece = null
  }

  function hasDrag() {
    return Boolean(drag)
  }

  // v0.13.0 R5: a pointer is down on the board and the VIEW gesture owns it (the face-turn drag,
  // started on pointerdown — before any threshold has been crossed, which is exactly the window
  // `hasDrag()` misses). The board's idle float freezes on this: the float must not be moving the
  // cube underneath a finger that is deciding whether this press is a tap, a turn or a pickup.
  function hasViewGesture() {
    return Boolean(viewDrag)
  }

  // The read-only projection the headless checks read (`__voxalblast.preview()` / `.ghost()`).
  // It hands back copies of the two points, so no probe can mutate the live gesture. `ref` is the
  // continuous origin the movement accumulates into and `face` the latched target face (v0.8.27):
  // with `origin` + `valid` they are the whole target-vs-legality split, and a check can follow
  // the piece across an occupied cell without any of it being re-derived from the DOM.
  function dragReport() {
    return {
      attached: Boolean(drag),
      onFace: drag?.attached === true,
      valid: drag?.valid === true,
      face: drag?.face ?? null,
      origin: drag?.origin ? { u: drag.origin.u, v: drag.origin.v } : null,
      ref: drag?.ref ? { u: drag.ref.u, v: drag.ref.v } : null,
      // The pointer's OWN face coordinate on the last frame — the ruler the travel is measured
      // against, unrounded. A check compares it with `ref` + the shape's centre offset to prove
      // the piece landed where it was held (the attach maps the ghost's centre, not the finger).
      pointer: drag?.point ? { fu: drag.point.fu, fv: drag.point.fv } : null,
      anchor: drag?.anchor ? { x: drag.anchor.x, y: drag.anchor.y, u: drag.anchor.u, v: drag.anchor.v } : null,
      stepScreen: drag?.face ? faceStepScreen(drag.face) : null,
      roomless: drag?.roomless === true,
      // v0.9.11: the arming ruler. `centre` is the carried piece's bounding-box centre in
      // client px (the point the picture on screen shows) and `edge` the cube silhouette side
      // it has crossed. Together they are the whole trigger: the piece is more than half off
      // the cube. Read-only; no gameplay path reads them.
      centre: drag?.centre ? { x: drag.centre.x, y: drag.centre.y } : null,
      // v0.9.13: whether this gesture has ever had the piece inside the cube. Until it has, no
      // edge can arm — the tray→cube entry crosses the bottom edge by construction.
      entered: edgeTurn.report().entered,
      armed: edgeTurn.report().phase === 'hold',
      armedAxis: edgeTurn.report().axis,
      edge: edgeTurn.report().edge,
      turnPhase: edgeTurn.report().phase,
      turned: drag?.turned === true,
    }
  }

  // ---- The armed tool (07 §8, 交互 v1) -------------------------------------------
  // The charges and each tool's reach are the session's; the strip, the status bar and the scope
  // are hud's and pieceView's; what USING a tool does to the board is main's. What lives here is
  // the arbitration §8 spends most of its length on: which gesture owns the pointer, when, and
  // what a release is allowed to mean.
  //
  //   §8.4  the two paths, told apart by where the gesture STARTED (icon vs board)
  //   §8.3  the two cancel rectangles and the status bar
  //   §8.5  what a target is (front face only) and how it is committed (what was shown)
  //   §8.9  the phase table and what every interrupt does to it
  function itemSlopPx(pointerType) {
    return pointerType === 'mouse' ? ITEM_STYLE.dragSlopMousePx : ITEM_STYLE.dragSlopTouchPx
  }

  // The item strip's only "not yet" state: the board is live, no gesture owns the pointer, no
  // panel is up, and the short hold after a clear has expired.
  //
  // The cube being mid-turn is deliberately NOT part of this gate even though §8.4 refuses a
  // pickup while the snap is running. `renderItemBar()` derives `.disabled` from this function,
  // and a gate that depends on an animation would leave the strip grey after the animation had
  // ended — v0.8.21's 假灰 bug, which tools/screenshot.mjs asserts against. The settle is checked
  // at the PICKUP instead (see itemPickupRefused()).
  function canUseItemsNow() {
    return !isEnded() && !isPaused() && !isDealing() && !drag && !isSettingsOpen() && performance.now() >= itemBusyUntil
  }

  // §8.4: 转动/吸附动画未停稳时道具暂不可拿起 — refused, and said out loud, but never reflected in
  // the strip's styling.
  function itemPickupRefused() {
    if (!cubeSnapAnim.active) return false
    onStatus(ITEM_COPY.lockedRotate)
    return true
  }

  // The two writes main's business paths make to the busy gate. `performance.now()` stays here,
  // where the gate is read (plan section 3).
  function holdItemsFor(ms) {
    itemBusyUntil = performance.now() + ms
  }

  function releaseItems() {
    itemBusyUntil = 0
  }

  // 8.5.6: a cell with TWO boundary coordinates sits on an edge/corner and is shared with the
  // neighbouring face. Read-only — the doc forbids this growing the scope (「不高亮邻面的其他
  // 格，也不按可见面重复算 N」), so it is a read-out and one pip and nothing else.
  function isSharedCell(x, y, z) {
    let boundary = 0
    if (x === 0 || x === SH - 1) boundary += 1
    if (y === 0 || y === SH - 1) boundary += 1
    if (z === 0 || z === SH - 1) boundary += 1
    return boundary >= 2
  }

  // The front face's own (u, v) cell under a client point, or null when the point is not on that
  // face's grid (§8.5.1/§8.5.3). Two deliberate differences from the shipped ruler:
  //   * the ruler is the front FACE's quad, not the cube's screen silhouette. A point on a side
  //     face used to be clamped onto the nearest corner cell of the front one; now it is 移到正面
  //     棋格, which is what §8.5.1 asks for (「两侧可见面的内部不是合法靶区」). `round()` outside
  //     0..SH-1 means the ray landed off the quad, and that test is exact — no polygon needed.
  //   * nothing is snapped and nothing is clamped, so 「连续拖动只吸附格子，不吸附收益」 holds by
  //     construction: the scope is built for exactly the cell the pointer resolves to.
  const aimPoint = new THREE.Vector2()
  function aimAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    aimPoint.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const face = findFrontFace()
    const cellAt = ndcToCell(face, aimPoint)
    if (!cellAt) return null
    if (cellAt.u < 0 || cellAt.u > SH - 1 || cellAt.v < 0 || cellAt.v > SH - 1) return null
    return { face, u: cellAt.u, v: cellAt.v }
  }

  // Where the aiming point actually is. On a touch DRAG the thumb is lifted, so the target rides
  // `touchAimLiftPx` above the contact point (§8.5.2). Preview and commit both read this one
  // function, which is the whole reason it exists — 「不得预览抬升而落点仍按指腹」 is a bug about
  // two call sites disagreeing, not about the number. The tap path (a finger on the board, no
  // icon in hand) deliberately gets no lift: there the player is pointing AT what they mean.
  function itemAimClient(event) {
    const lift = itemMode?.phase === 'dragging' && event.pointerType !== 'mouse'
      ? ITEM_STYLE.touchAimLiftPx : 0
    return { x: event.clientX, y: event.clientY - lift }
  }

  function scopeKeyFor(target, orientation) {
    return `${itemMode?.id}:${target.face}:${target.u},${target.v}:${orientation}`
  }

  // The scope the player is looking at, built from the session's own reach (§8.5.4: the count N is
  // the number of OCCUPIED unique lattice cells; `area` is how many the tool reaches on this face,
  // which is what §8.6 prints when the edge clipped a 2×2).
  function buildItemScope(target, orientation) {
    const faceCells = toolScopeFace(itemMode.id, target.face, target.u, target.v, orientation)
    const cells = faceCells.map(({ u, v }) => {
      const cell = faceLattice(target.face, u, v)
      return { u, v, cell, occupied: isOccupied(cell), shared: isSharedCell(cell[0], cell[1], cell[2]) }
    })
    const us = faceCells.map((cell) => cell.u)
    const vs = faceCells.map((cell) => cell.v)
    // §8.6: only the bomb can be clipped, and only by the +u/+v growth running off the face. The
    // shipped clipping is kept exactly as-is (「始终完整 2×2」 is explicitly out of scope), so the
    // preview's job is to SHOW the cut rather than to hide it.
    const clippedU = itemMode.id === 'bomb' && target.u === SH - 1
    const clippedV = itemMode.id === 'bomb' && target.v === SH - 1
    return {
      id: itemMode.id,
      face: target.face,
      anchor: { u: target.u, v: target.v },
      orientation,
      single: itemMode.id === 'hammer',
      clipped: clippedU && clippedV ? 'uv' : clippedU ? 'u' : clippedV ? 'v' : 'none',
      span: {
        u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs),
      },
      cells,
      area: cells.length,
      clear: cells.filter((cell) => cell.occupied).length,
    }
  }

  function publishScope(scope) {
    itemScope = scope
    itemScopeKey = scope ? scopeKeyFor({ face: scope.face, u: scope.anchor.u, v: scope.anchor.v }, scope.orientation) : null
    if (scope) onShowOverlay(scope)
    else onClearOverlay()
    onItemStatus()
  }

  // Move the scope to a target (or to nothing). Returns true when the picture changed, which the
  // release path reads to decide whether the frame it is committing was ever on screen.
  function aimTo(target) {
    if (!itemMode || itemMode.id === 'refresh') return false
    if (!target) {
      // §8.5.2: leaving the front grid removes the committable scope AT ONCE (no stale hover, no
      // "nearest occupied cell"), but the mode stays on so the player can simply move back.
      if (!itemScope && itemMode.face === null) return false
      itemMode.face = null
      itemMode.u = undefined
      itemMode.v = undefined
      publishScope(null)
      return true
    }
    if (scopeKeyFor(target, itemMode.orientation) === itemScopeKey) return false
    itemMode.face = target.face
    itemMode.u = target.u
    itemMode.v = target.v
    publishScope(buildItemScope(target, itemMode.orientation))
    return true
  }

  // §8.9: every uncommitted state exits through here, and cancelling changes NOTHING — not the
  // board, not the candidates, not the charges. `silent` is for the callers that are replacing the
  // mode with something else (a modal, a new run) and would have their own status overwritten.
  function cancelItemSelection(silent = false) {
    const had = Boolean(itemMode)
    itemMode = null
    itemScope = null
    itemScopeKey = null
    itemPickup = null
    onCancelZone(null, false, false)
    onClearOverlay()
    onAxisPickVisibility(true)
    onRefreshConfirm(false)
    onItemStatus()
    onItemBar()
    if (had && !silent) onStatus(t('status.idle'))
  }

  // The state half of a new run. main keeps the charges (session) and the undo window's DOM.
  function resetItemTargeting() {
    itemMode = null
    itemScope = null
    itemScopeKey = null
    itemPickup = null
    itemBusyUntil = 0
    // §8.7: 新局、页面刷新或重新载入续玩快照均恢复横向. The rocket's remembered direction is
    // in-memory run state, so a reset is exactly the event that clears it.
    rocketOrientation = 'row'
    onCancelZone(null, false, false)
    onClearOverlay()
    onAxisPickVisibility(true)
    onRefreshConfirm(false)
    onItemStatus()
  }

  function enterItemMode(id, phase, event) {
    itemMode = {
      id,
      phase,
      pointerId: event ? event.pointerId : null,
      startX: event ? event.clientX : 0,
      startY: event ? event.clientY : 0,
      pointerType: event ? event.pointerType : 'mouse',
      aiming: false,
      inCancelZone: false,
      face: null,
      u: undefined,
      v: undefined,
      orientation: id === 'rocket' ? rocketOrientation : id === 'bomb' ? '2x2' : 'row',
    }
    itemScope = null
    itemScopeKey = null
    onClearOverlay()
    onAxisPickVisibility(id !== 'rocket')
    onAxisPick()
    onItemStatus()
    onItemBar()
    return itemMode
  }

  // §8.7: the direction is the player's, never the pointer's. The shipped version read the
  // pointer's own offset inside the cell and flipped Row/Col by itself, which is the 痛点 the doc
  // lists third. R/C and the ↔/↕ buttons land here; a change rebuilds the preview immediately so
  // 「改变方向须更新预览后才可提交」 is a property of this function, not of the caller.
  function setRocketOrientation(axis) {
    if (itemMode?.id !== 'rocket') return
    const next = axis === 'col' ? 'col' : 'row'
    rocketOrientation = next
    if (next === itemMode.orientation && itemScope) return
    itemMode.orientation = next
    if (itemMode.u !== undefined) {
      publishScope(buildItemScope({ face: itemMode.face, u: itemMode.u, v: itemMode.v }, next))
    } else {
      onItemStatus()
    }
    onAxisPick()
  }

  // ---- The two cancel rectangles (§8.3) ------------------------------------------
  // The tray and the strip are TWO INDEPENDENT rectangles, never the box between them: the doc is
  // explicit that the union must not swallow the board. The hit test is a rect test on the RAW
  // contact point, so 「原始指器命中取消区的优先级高于抬升后的瞄准点」 is structural — the aim lift
  // never enters this function.
  function pointInCancelZone(x, y) {
    return cancelZones().some((element) => {
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
        && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    })
  }

  function setCancelHighlight(hot) {
    onCancelZone(hot ? 'item-hot' : 'item', true, hot)
  }

  // ---- The icon path (§8.4 主流程 / §8.2 换批) ------------------------------------
  // `itemPickup` is the press on an icon that has not yet decided what it is. Below the slop it
  // stays a tap; past it the gesture is LOCKED as a drag and never falls back (「一旦锁定，即使返
  // 回起点也不再降回点击」).
  function beginItemPickup(event, id) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (performance.now() < suppressItemClickUntil) return
    if (!canUseItemsNow()) return
    if (itemPickupRefused()) return
    if ((getItemCounts()[id] ?? 0) <= 0) {
      // §8.3: a zero is not a dead button — it says 本局已用完 rather than doing nothing. main owns
      // the copy and the buzz.
      onEmptyItem(id)
      return
    }
    event.preventDefault()
    itemPickup = {
      id,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      source: event.currentTarget,
    }
  }

  function promoteItemPickup(event) {
    const pickup = itemPickup
    if (!pickup) return
    pickup.moved = true
    try { pickup.source?.setPointerCapture?.(pickup.pointerId) } catch { /* embedded browsers refuse */ }
    if (pickup.id === 'refresh') {
      // §8.2: 换批 is a batch question, not a board target, so its icon deliberately has no drag.
      // The gesture is still consumed (the tap must not also fire), which is the whole point of
      // marking it moved.
      return
    }
    enterItemMode(pickup.id, 'dragging', event)
    // §8.9: 重新武装 = 图标手势首次越阈值进入拖拽态, and THAT is the moment the previous clear's
    // undo window closes — not when a valid target appears, and not at the commit.
    onRearm()
    onCancelZone('item-hot', true, true)
    updateDragAim(event)
  }

  function updateDragAim(event) {
    if (!itemMode || itemMode.phase !== 'dragging') return
    if (event.pointerId !== itemMode.pointerId) return
    const inZone = pointInCancelZone(event.clientX, event.clientY)
    if (inZone !== itemMode.inCancelZone) {
      itemMode.inCancelZone = inZone
      setCancelHighlight(inZone)
    }
    if (inZone) { aimTo(null); return }
    const point = itemAimClient(event)
    aimTo(aimAt(point.x, point.y))
  }

  function finishItemDrag(event) {
    const inZone = pointInCancelZone(event.clientX, event.clientY)
    onCancelZone(null, false, false)
    if (inZone) {
      // §8.3: releasing inside a cancel rectangle IS the cancel. Passing through one on the way
      // here never locked the intent, so nothing about the mode is confused by the trip.
      cancelItemSelection()
      return
    }
    const point = itemAimClient(event)
    const target = aimAt(point.x, point.y)
    if (!target || !itemScope || itemScope.clear <= 0) {
      // §8.2/§8.5.5: an invalid or empty release exits and costs nothing. A scope with N = 0 is
      // previewable but never submittable.
      cancelItemSelection()
      return
    }
    // §8.5.7: commit the frame that was actually drawn. The release coordinate is only used to
    // CHECK the target is unchanged; if the finger moved to another cell whose preview never
    // reached the screen, the honest answer is to exit rather than to clear a range nobody saw.
    if (scopeKeyFor(target, itemMode.orientation) !== itemScopeKey) {
      cancelItemSelection(true)
      onToast(ITEM_COPY.stale)
      onStatus(t('status.idle'))
      return
    }
    commitItem()
  }

  // ---- The tap path (§8.4 轻点备用路径) -------------------------------------------
  // A tap on an icon selects it and NOTHING else: no target, no charge, no commit. From there the
  // board only ever aims, and the commit is the explicit 使用 button.
  function tapItemIcon(id) {
    if (itemMode?.id === id && itemMode.phase !== 'dragging') { cancelItemSelection(); return }
    if (!canUseItemsNow()) return
    if (itemPickupRefused()) return
    if ((getItemCounts()[id] ?? 0) <= 0) { onEmptyItem(id); return }
    if (id === 'refresh') {
      // §8.8: the confirm bar is the whole interaction — no reroll, no charge, not even a random
      // number is drawn until 换一批 is pressed.
      if (itemMode) cancelItemSelection(true)
      enterItemMode('refresh', 'refresh-confirm', null)
      onRefreshConfirm(true)
      onStatus(ITEM_COPY.refreshConfirm)
      return
    }
    // §8.3: 点另一有库存道具可无成本替换当前选择.
    if (itemMode) cancelItemSelection(true)
    enterItemMode(id, 'selected', null)
    onRearm()
    onStatus(ITEM_COPY.tapHint)
  }

  function beginItemAim(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (!itemMode || itemMode.id === 'refresh') return
    itemMode.pointerId = event.pointerId
    itemMode.pointerType = event.pointerType
    itemMode.aiming = true
    itemMode.startX = event.clientX
    itemMode.startY = event.clientY
    // §8.4: 已固定轻点预览，重新点/滑动棋盘 replaces the preview. The lock is released on the
    // PRESS, so the release that follows re-fixes whatever the finger ends on.
    if (itemMode.phase === 'locked') itemMode.phase = 'selected'
    updateAimFromEvent(event, true)
  }

  function updateAimFromEvent(event, fresh = false) {
    if (!itemMode || itemMode.id === 'refresh' || !itemMode.aiming) return
    if (event.pointerId !== itemMode.pointerId) return
    const target = aimAt(event.clientX, event.clientY)
    if (!target && !fresh) {
      // §8.4: 提示 需换面？取消后转动棋盘 — the mode has taken the cube's rotation away, so a
      // player dragging the board sideways to turn it has to be told why nothing is happening.
      const travel = Math.hypot(event.clientX - itemMode.startX, event.clientY - itemMode.startY)
      if (travel > 24) onItemLockedRotate()
    }
    aimTo(target)
  }

  function endItemAim(event) {
    if (!itemMode || itemMode.id === 'refresh' || !itemMode.aiming) return false
    if (event.pointerId !== itemMode.pointerId) return false
    itemMode.aiming = false
    itemMode.pointerId = null
    if (!itemScope || itemScope.clear <= 0) {
      // §8.4/§8.5.5: an invalid or empty target clears the preview and DISABLES 使用, but the mode
      // stays on — 「仍保持已选中态，可重新选」. Nothing here touches the charges.
      itemMode.face = null
      itemMode.u = undefined
      itemMode.v = undefined
      itemMode.phase = 'selected'
      publishScope(null)
      return true
    }
    // §8.4: 抬起只固定预览，显示"使用"，不自动扣次数，不转面.
    itemMode.phase = 'locked'
    onItemStatus()
    return true
  }

  // §8.5.7: the snapshot is only valid while the board and the pose it was built against still
  // hold. The lattice cells are the same by construction, so the question is whether the SAME
  // cells are still occupied — if the board moved under the preview, that preview is a lie.
  function verifyScope(scope) {
    if (!scope || scope.face !== findFrontFace()) return false
    const fresh = buildItemScope({ face: scope.face, u: scope.anchor.u, v: scope.anchor.v }, scope.orientation)
    return fresh.clear === scope.clear
      && fresh.cells.length === scope.cells.length
      && fresh.cells.every((cell, index) => cell.occupied === scope.cells[index].occupied)
  }

  function useLockedItem() {
    if (!itemMode || itemMode.phase !== 'locked' || !itemScope || itemScope.clear <= 0) return false
    // The button validates the LOCKED snapshot and never re-aims with its own screen position —
    // 「不按按钮所在屏幕坐标重新瞄准」. Moving the mouse to the button is not a target change.
    if (!verifyScope(itemScope)) {
      cancelItemSelection(true)
      onToast(ITEM_COPY.stale)
      onStatus(t('status.idle'))
      return false
    }
    return commitItem()
  }

  // §8.9: 一次成功结算 → 普通态. The mode is dropped BEFORE main is told, so a repeated pointerup,
  // a synthesised click or a double-tapped button all find nothing to spend — the commit is
  // idempotent by construction instead of by a flag.
  function commitItem() {
    if (!itemMode || itemMode.id === 'refresh' || !itemScope || itemScope.clear <= 0) return false
    const snapshot = {
      id: itemMode.id,
      face: itemScope.face,
      u: itemScope.anchor.u,
      v: itemScope.anchor.v,
      orientation: itemScope.orientation,
      clear: itemScope.clear,
    }
    itemMode = null
    itemScope = null
    itemScopeKey = null
    itemPickup = null
    onCancelZone(null, false, false)
    onClearOverlay()
    onAxisPickVisibility(true)
    onItemStatus()
    onItemBar()
    onConfirmItem(snapshot)
    return true
  }

  // §8.8: the two buttons of the batch question. 保留当前 and ✕/Esc both mean "nothing happened";
  // 换一批 spends the charge and only main may do that.
  function keepRefreshBatch() {
    if (itemMode?.id !== 'refresh') return
    cancelItemSelection()
  }

  function confirmRefreshBatch() {
    if (itemMode?.id !== 'refresh') return
    if (!canUseItemsNow()) return
    const id = 'refresh'
    itemMode = null
    itemScope = null
    itemScopeKey = null
    onRefreshConfirm(false)
    onItemStatus()
    onItemBar()
    onConfirmRefresh(id)
  }

  // The status bar's read-only input (§8.3). A COPY — nothing outside this module can mutate the
  // live mode, and the headless checks read exactly what the bar renders.
  function itemReport() {
    if (!itemMode) return null
    return {
      id: itemMode.id,
      phase: itemMode.phase,
      orientation: itemMode.orientation,
      face: itemMode.face,
      anchor: itemMode.u === undefined ? null : { u: itemMode.u, v: itemMode.v },
      area: itemScope?.area ?? 0,
      clear: itemScope?.clear ?? 0,
      clipped: itemScope?.clipped ?? 'none',
      // The scope's own rectangle in face cell indices. Published because the frame the player
      // sees IS this rectangle (07 §8.6), so a check can prove a 横向 rocket is five cells wide
      // and one tall without reading the 3D scene.
      span: itemScope?.span ?? null,
      shared: itemScope ? itemScope.cells.some((cell) => cell.occupied && cell.shared) : false,
      hasTarget: Boolean(itemScope),
      canUse: itemMode.phase === 'locked' && (itemScope?.clear ?? 0) > 0,
      inCancelZone: Boolean(itemMode.inCancelZone),
    }
  }

  // ---- Listener wiring (P7d) ------------------------------------------------------
  // Plan section 6 P7 item 4: the listeners are registered ONCE, from here, and the returned
  // disposer unbinds them. Nothing above this line registers anything, so a second bind() is
  // refused rather than doubling every handler -- a doubled pointerdown would start two gestures
  // on one press.
  //
  // The two Escape callbacks exist because main's panel chain and the gesture chain INTERLEAVE:
  // the leaderboard and the controls card outrank a live gesture (they are asked first), the
  // settings panel does not (it is asked after). Splitting the chain in two keeps the order the
  // single keydown listener always had, instead of inventing a priority scheme.
  let unbind = null

  function bind({ itemBar, itemStatus, refreshConfirm, axisPick }) {
    if (unbind) return unbind

    function onPointerDown(event) {
      if (itemMode) {
        // 07 §8.4: 道具模式期间一律锁定画布转面. This is the one line that removes the redesign's
        // first 痛点 — the shipped version handed the SAME press to the aiming code and to the
        // view drag, and then used a 6px slop to decide which of them the player had meant.
        event.preventDefault()
        beginItemAim(event)
        return
      }
      beginViewGesture(event)
    }

    // v0.13.2 — 「拖动背景转动六面体」, for the one element that IS the background.
    //
    // The gesture's first surface is `#scene-wrap`: v0.13.0 R3 (handoff §9.3) made it 「the box
    // the board is measured in and the only box a board gesture may start in」. That box is the
    // CAMERA's framing rect (`gameScene.getGameplayRect()`), which is why it cannot simply be
    // enlarged — its size sets the cube's size and the embedded projection. It also stops 8%
    // above `.board-section`'s bottom, so the empty ground under the cube, which reads as part
    // of the stage, belonged to `.scroll-shield` and turned nothing. Producer, 2026-10-09: 「下面
    // 圈出来的区域应该要能响应左右划和上下划六面体」 — measured on a 360x616 phone, of the 67px
    // of ground between the cube's bottom edge and the tray only the top 21px responded.
    //
    // `.board-section` is now transparent to pointers (reference.css), so that band falls
    // through to this layer. The armed tool is deliberately NOT extended here: `onPointerDown`
    // above routes it to `beginItemAim` because §8.5's target is the front face under the
    // finger, and widening where a tap may AIM is a different decision from widening where a
    // drag may TURN. This round only has the second one.
    function onBackgroundDown(event) {
      if (itemMode) return
      beginViewGesture(event)
    }

    function onPointerMove(event) {
      // The icon press that has not yet become a tap or a drag (its own slop, §8.4).
      if (itemPickup && !itemPickup.moved) {
        if (event.pointerId !== itemPickup.pointerId) return
        const travel = Math.hypot(event.clientX - itemPickup.startX, event.clientY - itemPickup.startY)
        if (travel < itemSlopPx(itemPickup.pointerType)) return
        promoteItemPickup(event)
      }
      if (itemMode) {
        if (itemMode.phase === 'dragging') { updateDragAim(event); return }
        updateAimFromEvent(event)
        return
      }
      // The view gesture owns the pointer while it is live, and it says so -- the same early
      // return the inline branch used to do, including the one that waits for a decisive
      // direction before the pose may move at all.
      if (updateViewGesture(event)) return
      updateDrag(event)
    }

    function onPointerUp(event) {
      if (itemPickup && event.pointerId === itemPickup.pointerId) { endItemPickup(event); return }
      if (itemMode) {
        if (itemMode.phase === 'dragging') {
          if (event.pointerId === itemMode.pointerId) finishItemDrag(event)
          return
        }
        if (itemMode.aiming) endItemAim(event)
        return
      }
      finishViewGesture(event)
      // The release is judged on the FINAL pointer coordinates, through the very same rule that
      // drew the last frame of the preview (v0.8.27): browsers do not always deliver a
      // pointermove at the release position, and "final judgement", "what the preview showed"
      // and "what actually lands" must not be three different answers. updateDrag() is a no-op
      // for a gesture that never left the slot, and it checks the pointer id itself.
      updateDrag(event)
      finishDrag(event)
    }

    function onPointerCancel(event) {
      // 07 §8.9: 未提交动作一律取消. A cancelled pointer is the least ambiguous interrupt there is.
      itemPickup = null
      if (itemMode) cancelItemSelection(true)
      finishViewGesture(event)
      if (!drag || event.pointerId !== drag.pointerId) return
      cancelActiveDrag(false)
    }

    function onWheel(event) {
      if (itemMode) {
        // §8.4: 锁定…滚轮缩放. Swallowing the event matters as much as ignoring it: an un-prevented
        // wheel scrolls the page under the fixed stage.
        event.preventDefault()
        onItemLockedRotate()
        return
      }
      event.preventDefault()
      zoomBy(event.deltaY > 0 ? 0.92 : 1.08)
      fitCameraToPlaySpace()
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && onEscapeBeforeGestures(event)) return
      if (event.key === 'Escape' && itemMode) { event.preventDefault(); cancelItemSelection(); return }
      if (event.key === 'Escape' && drag) { event.preventDefault(); cancelActiveDrag(); return }
      if (event.key === 'Escape' && onEscapeAfterGestures(event)) return
      // W/S = X, A/D = Y, Q/E = Z (03 §13). Handled before the modal guard so the legend
      // can be learned while it is open, and before the rocket keys so nothing steals them.
      if (handleRotateKey(event)) { event.preventDefault(); return }
      if (isModalOpen()) return
      // §8.7: R/C stay as the PC's explicit direction switch. They must UPDATE the preview, which
      // setRocketOrientation() does itself, so a release can only ever commit the line on screen.
      if (itemMode?.id === 'rocket' && ['r', 'c'].includes(event.key.toLowerCase())) {
        setRocketOrientation(event.key.toLowerCase() === 'c' ? 'col' : 'row')
      }
    }

    function onContextMenu(event) {
      if (itemMode) { event.preventDefault(); cancelItemSelection(); return }
      if (!drag) return
      event.preventDefault()
      cancelActiveDrag()
    }

    function onBlur() {
      // §8.9: 失焦/隐藏 cancels 已选中、拖拽、待确认、换批确认 — all four — and only the
      // UNCOMMITTED ones: a clear that already landed keeps its board, its charge and its undo.
      itemPickup = null
      if (itemMode) cancelItemSelection(true)
      cancelViewGesture()
      cancelActiveDrag(false)
    }

    function onVisibilityChange() {
      if (document.hidden) onBlur()
    }

    function onLostPointerCapture(event) {
      if (itemMode && itemMode.pointerId === event.pointerId && itemMode.phase === 'dragging') {
        // The capture can be lost without a pointerup (an embedded browser stealing the gesture).
        // Without this the mode would sit in 拖拽态 with a scope on screen and no finger.
        itemPickup = null
        cancelItemSelection(true)
        return
      }
      if (drag?.pointerId === event.pointerId) cancelActiveDrag(false)
    }

    // §8.9: 视口尺寸或设备方向变化 also cancels every uncommitted state — the aim was measured in
    // pixels that no longer mean the same cell.
    function onResize() {
      if (itemMode || itemPickup) { itemPickup = null; cancelItemSelection(true) }
    }

    function endItemPickup(event) {
      const pickup = itemPickup
      itemPickup = null
      if (!pickup || event.pointerId !== pickup.pointerId) return
      if (pickup.source) releasePointerCapture(pickup.source, pickup.pointerId)
      // Whatever this press turns out to be, the click the browser synthesises after it must not
      // be read a second time (§8.4). The click handler below stays only as the fallback for
      // environments that deliver `click` without pointer events at all.
      suppressItemClickUntil = performance.now() + 320
      if (pickup.moved) {
        if (itemMode?.phase === 'dragging') finishItemDrag(event)
        return
      }
      tapItemIcon(pickup.id)
    }

    // The strip's buttons are static (renderItemBar only toggles their classes), so they are
    // bound once here -- and kept in a list so dispose() can really unbind them.
    const itemButtons = []
    for (const button of itemBar.querySelectorAll('.item-button')) {
      const id = button.dataset.item
      const down = (event) => beginItemPickup(event, id)
      const click = () => {
        // Fallback only: everything normally arrives through pointerdown/pointerup above, and the
        // suppression window is what keeps a completed drag from being replayed as a tap.
        if (performance.now() < suppressItemClickUntil) return
        suppressItemClickUntil = performance.now() + 320
        tapItemIcon(id)
      }
      itemButtons.push([button, down, click])
      button.addEventListener('pointerdown', down)
      button.addEventListener('click', click)
    }
    const axisButtons = []
    for (const button of axisPick.querySelectorAll('button[data-axis]')) {
      const handler = () => setRocketOrientation(button.dataset.axis)
      axisButtons.push([button, handler])
      button.addEventListener('click', handler)
    }
    // §8.3: the status bar's two buttons and §8.8's two answers. All four are static markup.
    function onUseClick() { useLockedItem() }
    function onCancelClick() { cancelItemSelection() }
    function onKeepClick() { keepRefreshBatch() }
    function onRefreshGoClick() { confirmRefreshBatch() }

    canvas.addEventListener('pointerdown', onPointerDown)
    // The background layer. `beginViewGesture` is bound to whatever element the press landed on
    // (it takes the pointer capture on `event.currentTarget`), so the two surfaces never both
    // fire for one press: the band under the cube hits this layer, the cube hits `#scene-wrap`.
    background?.addEventListener('pointerdown', onBackgroundDown)
    window.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('blur', onBlur)
    window.addEventListener('lostpointercapture', onLostPointerCapture)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    if (itemStatus) {
      itemStatus.querySelector('#item-use')?.addEventListener('click', onUseClick)
      itemStatus.querySelector('#item-cancel')?.addEventListener('click', onCancelClick)
    }
    if (refreshConfirm) {
      refreshConfirm.querySelector('#refresh-keep')?.addEventListener('click', onKeepClick)
      refreshConfirm.querySelector('#refresh-go')?.addEventListener('click', onRefreshGoClick)
    }

    function dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown)
      background?.removeEventListener('pointerdown', onBackgroundDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('wheel', onWheel)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('lostpointercapture', onLostPointerCapture)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      cancelActiveDrag(false)
      itemStatus?.querySelector('#item-use')?.removeEventListener('click', onUseClick)
      itemStatus?.querySelector('#item-cancel')?.removeEventListener('click', onCancelClick)
      refreshConfirm?.querySelector('#refresh-keep')?.removeEventListener('click', onKeepClick)
      refreshConfirm?.querySelector('#refresh-go')?.removeEventListener('click', onRefreshGoClick)
      itemButtons.forEach(([button, down, click]) => {
        button.removeEventListener('pointerdown', down)
        button.removeEventListener('click', click)
      })
      axisButtons.forEach(([button, handler]) => button.removeEventListener('click', handler))
      // A stale disposer must not affect a later, explicitly rebound instance.
      if (unbind === dispose) unbind = null
    }
    unbind = dispose
    return unbind
  }

  return {
    // Wiring: once, from main's boot sequence, with the elements and the one handler it routes.
    bind,
    // Pointer coordinates and the pointer-level read-outs (plan section 2.1: this module owns
    // them).
    eventNdc,
    isPointerOnCube,
    ndcToCell,
    releasePointerCapture,
    // The view gesture.
    beginViewGesture,
    updateViewGesture,
    finishViewGesture,
    cancelViewGesture,
    resetRotation,
    // The keyboard.
    handleRotateKey,
    // The piece drag.
    beginDrag,
    updateDrag,
    finishDrag,
    cancelActiveDrag,
    resetDrag,
    clearTurnDwell,
    bindSlot,
    getSelectedPiece,
    clearSelection,
    hasDrag,
    hasViewGesture,
    dragReport,
    // The armed tool (07 §8). The mode, its report, the two gesture entries and the two explicit
    // buttons of the tap path.
    hasItemActive,
    getItemActive,
    itemReport,
    canUseItemsNow,
    holdItemsFor,
    releaseItems,
    setRocketOrientation,
    cancelItemSelection,
    resetItemTargeting,
    beginItemPickup,
    useLockedItem,
    keepRefreshBatch,
    confirmRefreshBatch,
  }
}

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
import { DRAG_GHOST, PIECE_SPIN, dragGhostLiftPx, ROTATE_STYLE as rotateStyle } from '../rendering/config.js'
import { SH } from '../game/board.js'

export function createGameInput({
  canvas,
  // Read-only queries and the interaction gates (plan section 3: nothing here is copied, and
  // nothing here is written).
  isPaused,
  isEnded,
  isHomeOpen,
  isSettingsOpen,
  isControlsOpen,
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
  // The per-face "is there room for this piece ANYWHERE on it" (board, v0.9.3). Together with the
  // latched face and cells it is the spin's trigger: a face with no room anywhere is the one case
  // where dragging the piece can only mean 「turn the cube」.
  anyPlacementOn,
  currentCells,
  // A tool's reach is the session's rule (P6b-1) and whether a cell is taken is the board's; the
  // overlay that draws the answer is pieceView's. Both are read through here.
  toolScope,
  isOccupied,
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
  onCancelZone,
  onSelectionChanged,
  onItemBar,
  onAxisPick,
  onAxisPickVisibility,
  onClearOverlay,
  onShowOverlay,
  onConfirmItem,
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

  // The armed tool (P7c). `itemActive` is the targeting mode, `itemTap` the press that may or may
  // not become a target, `itemBusyUntil` the short window after a clear in which the strip is not
  // accepting input, and `lastItemHoverKey` the cache that keeps the overlay from being rebuilt on
  // every pointermove.
  let itemActive = null // { id, face, u, v, orientation }
  let itemTap = null
  let itemBusyUntil = 0
  let lastItemHoverKey = null
  // Same 6px slop the candidate drag uses to tell a tap from a gesture.
  const ITEM_TAP_SLOP = 6

  function hasItemActive() {
    return Boolean(itemActive)
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
    // Keep the armed target under the pointer, including while the cube turns to
    // bring another face round (07 §3.1 A1). The rocket only re-reads its Row/Col
    // from the cell offset while the gesture is still a tap: during a committed turn
    // the offsets change for reasons that have nothing to do with what was aimed at.
    if (hasItemActive()) onItemHover(eventNdc(event), !viewDrag.axis)
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
    if (isPaused() || hasDrag() || hasItemActive() || isHomeOpen() || isSettingsOpen()) return false
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
  //   - `roomless`: the FACE's verdict, not the target's — no origin on this face takes this
  //     piece (board.anyPlacementOn). Latched with the face and cells, because neither the board
  //     nor the orientation can change while the finger is down. It is the spin's trigger below.
  //   - `spin`: the live cube turn the drag switched into because the face is roomless. Non-null
  //     means the gesture's travel belongs to the CUBE from here, not to the piece.
  function beginDrag(event, piece) {
    if (piece.used || isPaused() || drag || hasItemActive()) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    selectedPiece = piece
    // A turn still in flight is settled BEFORE the piece is picked up: the drag measures the
    // face in the RENDERED pose, so a cube still slerping would move the ruler under the piece
    // for the first ~0.2s and the piece would swim away from the finger that just grabbed it.
    // The view gesture takes the same precaution, for the same reason.
    settleCubeSnap()
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
      spin: null,
      // The pinned push (v0.9.4): face-lattice travel the clamp threw away, per axis. This is the
      // general arming condition's ruler; `armed` (v0.9.5) is the turn that push has armed and the
      // timer that will fire it if the push is held.
      push: { u: 0, v: 0 },
      armed: null,
      valid: false,
      attached: false,
      active: false,
      inCancelZone: false,
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
    onStatus('Drag to a face')
  }

  // Is the pointer on (or within snapMarginPx of) the cube's silhouette? The drag
  // has exactly two states and this is the line between them: off the cube the
  // piece is still IN HAND (only the ghost exists), on it the piece has ATTACHED to
  // a face (only the landing preview exists). See DRAG_GHOST in rendering/config.js.
  //
  // v0.9.4 kept this unchanged on purpose, even though the pinned push would be easier to trigger
  // with a wider margin: widening it here is what 「把块块拖离立方体就回到手上」 means, and a piece
  // pinned at an edge must still be carried off the cube by dragging it away. The push therefore
  // has to be made inside the silhouette (+18px), which probe:drag case K measures.
  function isPointerOnCube(ndc) {
    const rect = canvas.getBoundingClientRect()
    const clientX = rect.left + (ndc.x * 0.5 + 0.5) * rect.width
    const clientY = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height
    const bounds = cubeScreenBounds()
    const margin = DRAG_GHOST.snapMarginPx
    return clientX >= bounds.minX - margin && clientX <= bounds.maxX + margin
      && clientY >= bounds.minY - margin && clientY <= bounds.maxY + margin
  }

  // Hand the drag ghost its three rulers. All three are the input layer's to measure: the
  // pointer's NDC, the canvas it is over (the renderer's CSS box) and one cell of the cube as it is
  // drawn right now (gameScene's screen bounds, exactly the ruler the ghost has always used). What
  // is left — the two corner rays, the world-per-pixel scale and the tint — is the view's own
  // arithmetic and lives in pieceView.syncDragGhost() (plan §6 P4.3).
  function syncGhostFor(event, ndc, mode) {
    onSyncGhost({
      ndc,
      canvasHeight: Math.max(canvas.getBoundingClientRect().height, 1),
      cellPx: ghostCellPx(),
      pointerType: event.pointerType,
      mode,
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
    drag.push.u = 0
    drag.push.v = 0
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
    // Off the cube the piece goes back to being carried, and the next arrival on the cube
    // re-grabs it wherever it lands.
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
      // The face's own verdict, read once per attach (v0.9.3): the board cannot change while the
      // finger is down and the orientation is latched, so this is a constant of the attachment —
      // and it is what updateDrag() reads to decide whether the drag still means 「move the piece」.
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
          // What the finger travelled and the piece did NOT take is the clamp throwing it away:
          // the piece is against that edge and the finger is still pushing outward. That difference
          // is the spin's SECOND arming condition (v0.9.4), and the reason it needs no threshold on
          // the finger's own travel: while the piece still follows its finger the difference is
          // exactly zero, so no amount of ordinary dragging can arm it.
          trackPush(du - (moved.u - drag.ref.u), dv - (moved.v - drag.ref.v))
          drag.ref = moved
        }
        drag.point = { fu: point.fu, fv: point.fv }
      } else {
        drag.point = null
        trackPush(0, 0)
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

  // ---- Turning the cube out from under a piece (v0.9.3, generalised in v0.9.4) ----
  // 「推上去的小块块在这个面没有对应的空了，我想这个大正方体会随着我拖着的方向去动」 — and, once the
  // gesture was generalised: 「只要块块贴在立方体上，再往某个方向拖超过阈值就触发」.
  //
  // Two arming conditions, ONE turn:
  //   (1) v0.9.3 — `drag.roomless`: the face takes this piece NOWHERE, so no amount of careful
  //       dragging on it can ever be a placement. Armed on arrival; the cube follows the finger
  //       continuously from `PIECE_SPIN.startPx` on, and the ordinary 30° step decides the face.
  //   (2) v0.9.4 — `drag.push`: the piece is against a face edge and the finger keeps pushing
  //       outward (the clamp is discarding travel). Any face, any direction, no "no room" needed:
  //       the piece stops following the finger, and one more push turns the cube that way.
  //
  // (2) is deliberately NOT "any drag longer than N px". The placement drag spends its whole life
  // dragging pieces ACROSS faces — v0.8.27 made the preview slide straight over occupied cells on
  // purpose, and a piece crossing a four-cell face covers four cells of travel. A ruler made of the
  // finger's own travel would turn the cube in the middle of an ordinary placement, which is the
  // one thing this gesture must never do. What CANNOT be an accident is the piece refusing to move:
  // it only happens at a face edge, the clamp is already discarding that travel (v0.8.27), and the
  // difference between the finger's travel and the piece's is exactly zero for every other frame.
  // Both conditions turn the cube through the view gesture's own machinery (one axis per gesture,
  // boardView's settle, its 90° grid). Three things are deliberately NOT borrowed from it:
  //   - the band. The finger is on the cube by definition (the piece is attached), so a vertical
  //     drag is a pitch and a horizontal one a yaw; the side bands' in-plane roll is out of reach,
  //     which is right — rolling a face opens no spot on it and moves no piece.
  //   - the release. Under (1) the finger stays down: the turn commits as soon as the drag passes
  //     the step threshold, so the player is still holding the piece when the next face arrives.
  //   - where the piece is drawn. Under (1) the landing marker stays latched to the face the piece
  //     came from and rides it round (it is drawn in the cube's frame), so the piece never looks
  //     like it left the player's hand in the middle of a turn. Under (2) there is no animation at
  //     all — the push commits one face and the piece hops onto the arriving face afterwards.
  //
  // Neither path can place anything: (1) latches an illegal-or-unplaceable face and (2) drops the
  // latch before the pose moves, so a release either re-finds a face through the ordinary
  // updatePreview() or returns the piece to the strip like any other illegal release.
  const PUSH_EPS = 1e-4

  // The push, in face-lattice units, accumulated per axis. A frame that discarded nothing clears
  // that axis's counter — a frame where the piece took a step, or where the finger reversed. The
  // counter has to mean 「手指一直往这个方向推，块块一直不动」, never 「很久以前推过一下」.
  function trackPush(blockedU, blockedV) {
    drag.push.u = blockedU > PUSH_EPS ? drag.push.u + blockedU : 0
    drag.push.v = blockedV > PUSH_EPS ? drag.push.v + blockedV : 0
  }

  // The push measured the way the TURN's model wants it: the blocked face travel projected onto
  // the face's own lattice axes AS THEY ARE DRAWN RIGHT NOW (client px), plus the axis and the
  // direction that screen direction means, plus the same push in LATTICE CELLS (the producer's
  // 「超出半格」, and the unit that means the same thing on every screen). Nothing here reads the
  // pointer's position or its client travel: a face seen edge-on must not be easier to push off
  // than one seen head-on.
  function pinnedPush() {
    if (!(drag.push.u > PUSH_EPS) && !(drag.push.v > PUSH_EPS)) return null
    const step = faceStepScreen(drag.face)
    const sx = drag.push.u * step.u.x + drag.push.v * step.v.x
    const sy = drag.push.u * step.u.y + drag.push.v * step.v.y
    const axis = Math.abs(sx) >= Math.abs(sy) ? 'yaw' : 'pitch'
    const px = Math.hypot(sx, sy)
    return {
      px,
      // The push in LATTICE CELLS — the producer's 「超出半格」, and the only honest ruler here: a
      // face's own axes are foreshortened differently at its edge than at its centre (measured 34px
      // per cell near the right edge of +z against 54px at the centre on a 430×900 viewport), so a
      // px threshold would mean a different distance depending on where on the face it happened.
      // Lattice units are what the clamp counts in, and they are what the player's 「半格」 means.
      cells: Math.max(drag.push.u, drag.push.v),
      axis,
      // The screen direction the push is going in, normalised: the armed turn measures the finger's
      // retreat against it (see armTurn()).
      ux: px > 0 ? sx / px : 0,
      uy: px > 0 ? sy / px : 0,
      // The direction is the view gesture's own convention applied to the same screen direction:
      // swipeAngle() already carries the per-axis knob, and the sign of what it returns is the face
      // that gesture would have turned. Same ruler, same sign, no second opinion.
      sign: Math.sign(swipeAngle(axis, sx, sy, gestureSpan(), 'cube')) || 1,
    }
  }

  // ---- The armed turn (v0.9.5) -----------------------------------------------------
  // 「超出下方一半格子，超过一段时间以后就向下翻」. The push passing PIECE_SPIN.pinCells does NOT turn
  // anything by itself: it ARMS the turn, which then has to be held for PIECE_SPIN.pinHoldMs. The
  // two halves do different jobs —
  //   - the lean (`armLeanDeg`) is the feedback: the cube tilts the way the finger is pushing
  //     immediately, so 「立方体跟着我拖的方向」 is visible before anything is committed;
  //   - the dwell is the proof of intent: an edge placement that overshoots the edge is over in far
  //     less than this, a deliberate push is not.
  // Pulling back (the clamp stops discarding travel), releasing, or leaving the cube inside that
  // window springs the lean back to the exact grid and turns nothing.
  //
  // Both halves ride boardView's own live gesture, so the cancel is `angle = 0` plus the very same
  // settle a view gesture's release takes: no second pose model, and a cancelled turn leaves no
  // residue on the 90° grid (`planAxisRelease` with |angle| 0 keeps the bearing the gesture started
  // from and settles over zero distance).
  function armTurn(push, event) {
    beginAxisGesture(push.axis)
    setLiveAngle(push.sign * THREE.MathUtils.degToRad(PIECE_SPIN.armLeanDeg))
    drag.armed = {
      axis: push.axis,
      sign: push.sign,
      timer: setTimeout(fireArmedTurn, PIECE_SPIN.pinHoldMs),
      // The disarm ruler is the FINGER, in client px (`backPx` back toward the face cancels). It has
      // to be: the lean moves the cube, the ray onto the latched face moves with it, and the piece's
      // own advance can flicker under that — an accumulator fed by it would arm and disarm in a loop.
      // A client position cannot be affected by the pose.
      x: event.clientX,
      y: event.clientY,
      ux: push.ux,
      uy: push.uy,
    }
    onHaptic(6)
  }

  // The dwell elapsed with the push still held: one face, committed by the push alone. A pinned
  // piece does not follow the finger — that is what being pinned means — so there is no travel left
  // to animate: the push is worth exactly one face, the same 「一次手势一面」 the keyboard obeys.
  function fireArmedTurn() {
    const armed = drag?.armed
    if (!armed) return
    drag.armed = null
    const live = getLive()
    if (!live) return
    live.angle = armed.sign * ROT_STEP
    startCubeSnap(live)
    dropLatchForTurn()
  }

  function disarmTurn() {
    const armed = drag?.armed
    if (!armed) return
    drag.armed = null
    clearTimeout(armed.timer)
    const live = getLive()
    if (!live) return
    live.angle = 0
    startCubeSnap(live)
  }

  function beginSpin(event) {
    drag.spin = { axis: null, span: null, startX: event.clientX, startY: event.clientY }
    onStatus('No room — drag to turn')
  }

  function updateSpin(event) {
    const spin = drag.spin
    const dx = event.clientX - spin.startX
    const dy = event.clientY - spin.startY
    // The push (PIECE_SPIN.startPx). The ruler starts where the piece became stuck, so the very
    // motion that carried it onto a full face cannot claim the axis by itself: a turn has to be
    // asked for.
    if (Math.hypot(dx, dy) < PIECE_SPIN.startPx) return
    if (!spin.axis) {
      if (!gestureAxisReady(dx, dy)) return
      spin.axis = pickGestureAxis(dx, dy, 'cube')
      spin.span = gestureSpan()
      beginAxisGesture(spin.axis)
    }
    setLiveAngle(swipeAngle(spin.axis, dx, dy, spin.span, 'cube'))
    const live = getLive()
    // The commit reads the FINGER's angle, the same number the view gesture's release reads, so a
    // face costs the same drag here as it does there.
    if (live && Math.abs(live.angle) >= rotateStyle.stepThreshold) commitSpin()
  }

  // The turn is committed mid-gesture and boardView animates the pose from here. The latched face
  // goes with it: the face the piece was on is leaving the front and the next frame that sees the
  // settled pose re-attaches to whatever face is in front THEN — the piece hops onto the arriving
  // face under the finger, which is the point of the gesture.
  function commitSpin() {
    const live = getLive()
    drag.spin = null
    if (live) startCubeSnap(live)
    dropLatchForTurn()
  }

  // One face, committed by the PUSH alone. A pinned piece does not follow the finger — that is what
  // being pinned means — so there is no travel left to animate: the push is worth exactly one face,
  // the same "one gesture = one face" rule the keyboard obeys (03 §2.2). It is built from the same
  // beginAxisGesture()/startCubeSnap() pair the keyboard uses, so it lands on the 90° grid by
  // construction rather than by a second implementation.
  function dropLatchForTurn() {
    detachFace()
    drag.attached = false
    drag.origin = null
    drag.valid = false
  }

  // Hand a still-live spin pose over when the gesture ends some other way (the finger came up,
  // Escape, the piece dragged back into the strip). The finger's own angle decides the face,
  // exactly as a view gesture's does. Leaving the record live would be worse than untidy:
  // `getLive()` would stay non-null, and rotateByKey() refuses to turn the cube while a drag owns
  // the pose — the "it won't turn any more" failure this project has already paid for once.
  function endSpin(record) {
    if (!record?.spin) return
    record.spin = null
    const live = getLive()
    if (live) startCubeSnap(live)
  }

  // Every way a gesture can end has to clear the armed turn's timer as well as the spin's pose
  // (v0.9.5): a timer that outlives its drag would fire into the next one.
  function endTurns(record) {
    disarmTurn()
    endSpin(record)
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
      onCancelZone(true)
    }
    drag.inCancelZone = isInsidePieceArea(event)
    onCancelZone(true, drag.inCancelZone)
    if (drag.inCancelZone) {
      drag.valid = false
      drag.origin = null
      // A live spin is handed over before the piece goes home (v0.9.3): the pose it is holding is
      // the player's, and nobody else is going to write it.
      endTurns(drag)
      // Back in the strip the piece is being put down, not held over a face: the next
      // arrival on the cube re-grabs wherever the finger is.
      detachFace()
      onClearLanding()
      syncGhostFor(event, eventNdc(event), 'cancel')
      onStatus('Release to cancel')
      return true
    }
    const ndc = eventNdc(event)
    drag.ndc = ndc
    // A live spin owns the gesture (v0.9.3): its travel is the CUBE's, and the marker is latched
    // to the face the piece came from and rides it round, so the target must not be re-derived
    // until the turn has settled.
    if (drag.spin) {
      syncGhostFor(event, ndc, 'snap')
      updateSpin(event)
      return true
    }
    // A turn the spin committed is still in flight — the same ~0.22s settle a view gesture ends
    // with, except this finger has not let go. Waiting it out is what keeps the preview from
    // chasing the front face through the animation.
    //
    // The marker rides the face the piece came from while it turns — but only while the piece still
    // BELONGS to the cube. If the pointer has left the silhouette the piece is in hand again (that
    // gesture means 「put it back」, and the next arrival re-grabs it), so the latch is dropped here
    // too: leaving it would hide the piece for the whole animation and read as 「块块凭空消失」
    // (found by `npm run probe:interaction`, case C, when a drag to the empty canvas above the cube
    // turned it on the way past).
    if (cubeSnapAnim.active) {
      if (isPointerOnCube(ndc)) {
        syncGhostFor(event, ndc, 'snap')
      } else {
        drag.attached = false
        drag.origin = null
        drag.valid = false
        onClearLanding()
        syncGhostFor(event, ndc, 'carry')
      }
      return true
    }
    const attached = updatePreview(event, ndc)
    if (attached) {
      // (1) The face takes this piece nowhere at all: the drag may only turn from here (v0.9.3).
      if (drag.roomless) {
        beginSpin(event)
        syncGhostFor(event, ndc, 'snap')
        return true
      }
      // (2) The piece is pinned against a face edge and the finger is pushing outward (v0.9.4).
      // Pushing past PIECE_SPIN.pinCells arms the turn and leans the cube that way; HOLDING it for
      // PIECE_SPIN.pinHoldMs is what turns the face (v0.9.5). Pulling the finger back, or leaving
      // the cube, disarms and springs the lean back.
      if (drag.armed) {
        const back = (event.clientX - drag.armed.x) * drag.armed.ux
          + (event.clientY - drag.armed.y) * drag.armed.uy
        if (back <= -PIECE_SPIN.backPx) disarmTurn()
      } else {
        const push = pinnedPush()
        if (push && push.cells >= PIECE_SPIN.pinCells) armTurn(push, event)
      }
    } else if (drag.armed) {
      disarmTurn()
    }
    // One piece per turn (v0.4.4): the ghost exists exactly while the piece is being
    // carried. Once it is attached to a face the board draws it and the carried copy
    // disappears; if the pointer is on the cube but this face has no room, the piece
    // stays in hand and turns grey instead of silently vanishing.
    syncGhostFor(event, ndc, attached ? 'snap' : isPointerOnCube(ndc) ? 'invalid' : 'carry')
    if (attached) onStatus(drag.armed ? 'Hold to turn' : drag.valid ? 'Release to place' : 'No room here')
    else onStatus(isPointerOnCube(ndc) ? 'No room on this face' : 'Drag to a face')
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
    // A live spin hands its pose over for the same reason finishDrag() does — and this path is
    // also the page taking the gesture away (a hidden tab, a new run), where a pose left live
    // would block every later rotation.
    endTurns(currentDrag)
    const returning = showFeedback && currentDrag.active
    if (returning) onReturnPiece(currentDrag.piece)
    onClearLanding()
    onClearGhost({ keepReturn: returning })
    selectedPiece = null
    suppressPieceClickUntil = performance.now() + 260
    onCancelZone(false)
    onSelectionChanged()
    onStatus('Pick a shape')
    if (showFeedback) {
      onToast('Placement cancelled')
      onHaptic(10)
    }
    return true
  }

  // Replacing a run clears its preview without the toast/haptic of a user cancel. A live spin is
  // DROPPED rather than settled (v0.9.3) — both callers put the pose where they want it straight
  // afterwards (applySession's save or resetCubeRotation) and both clear boardView's live record on
  // the way — but an ARMED turn must still be disarmed (v0.9.5): its timer outlives the record
  // otherwise and would fire into whatever gesture comes next.
  function resetDrag() {
    if (drag) { disarmTurn(); drag.spin = null }
    onClearLanding()
    drag = null
  }

  // The release. The caller (onPointerUp) has already fed the FINAL pointer coordinates through
  // updateDrag(), i.e. through the same rule that drew the last frame — so what is committed here
  // is exactly the preview the player was looking at, and nothing is re-derived or searched for
  // on the way out (v0.8.27). An illegal (or detached) target spends nothing and does NOT fall
  // back to a position the piece used to be on: `origin` is the current target or null.
  function finishDrag(event) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
    const currentDrag = drag
    // Both things a spin can leave behind are settled BEFORE `drag` is dropped, because both need
    // the live record. A spin that never committed hands its pose over (its own angle decides the
    // face, exactly as a view gesture's release does); a turn that is still in flight is landed
    // now — instant, not animated — so that the release is judged on the pose the player is about
    // to see. Without that a player who released the instant the cube arrived would lose a piece
    // the face in front of them had room for, which is the one way this gesture could eat a turn.
    endTurns(currentDrag)
    if (cubeSnapAnim.active) {
      settleCubeSnap()
      if (event && currentDrag.ndc) updatePreview(event, currentDrag.ndc)
    }
    drag = null
    releasePointerCapture(currentDrag.source, currentDrag.pointerId)
    const returning = currentDrag.active && (currentDrag.inCancelZone || !currentDrag.valid || !currentDrag.origin || !currentDrag.face)
    if (returning) onReturnPiece(currentDrag.piece)
    onClearLanding()
    onClearGhost({ keepReturn: returning })
    onCancelZone(false)
    if (!currentDrag.active) {
      selectedPiece = currentDrag.piece
      onSelectionChanged()
      onStatus('Drag to a face')
      return
    }
    suppressPieceClickUntil = performance.now() + 260
    if (currentDrag.inCancelZone) {
      selectedPiece = null
      onSelectionChanged()
      onStatus('Pick a shape')
      onToast('Placement cancelled')
      onHaptic(10)
      return
    }
    if (!currentDrag.valid || !currentDrag.origin || !currentDrag.face) {
      selectedPiece = null
      onSelectionChanged()
      onStatus('Pick a shape')
      onToast('Try another spot')
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
        onStatus('Drag to a face')
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

  // The read-only projection the headless checks read (`__voxalblast.preview()` / `.ghost()`).
  // It hands back copies of the two points, so no probe can mutate the live gesture. `ref` is the
  // continuous origin the movement accumulates into and `face` the latched target face (v0.8.27):
  // with `origin` + `valid` they are the whole target-vs-legality split, and a check can follow
  // the piece across an occupied cell without any of it being re-derived from the DOM.
  function dragReport() {
    // One measurement of the pinned push, shared by the two fields below: a probe comparing the
    // number with the axis must not be reading two different frames of it.
    const push = drag?.face ? pinnedPush() : null
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
      // v0.9.3 spin: `roomless` is the face's own verdict (no origin on it takes this piece) and
      // `spin` / `spinAxis` are the turn the drag switched into because of it. v0.9.4 adds the
      // general arming condition: `pushPx` is how far the finger has been pushing a piece that
      // cannot follow it (against a face edge), in client px on the face's own axes.
      roomless: drag?.roomless === true,
      spin: Boolean(drag?.spin),
      spinAxis: drag?.spin?.axis ?? null,
      pushPx: push?.px ?? 0,
      pushCells: push?.cells ?? 0,
      pinAxis: push?.axis ?? null,
      // v0.9.5: the turn the push has ARMED and that PIECE_SPIN.pinHoldMs will fire. Non-null means
      // the cube is leaning and nothing has been committed yet.
      armed: Boolean(drag?.armed),
      armedAxis: drag?.armed?.axis ?? null,
    }
  }

  // ---- The armed tool (P7c) ------------------------------------------------------
  // Plan section 4.1 splits the item area three ways and this is the input third: the targeting
  // mode, the 6px tap-vs-turn decision, the hover, the rocket's Row/Col and the busy gate. The
  // charges and the reach of each tool are the session's; the strip, the panel and the overlay are
  // hud's and pieceView's; what USING a tool does to the board is main's.
  function clampCellIndex(value) {
    return THREE.MathUtils.clamp(value, 0, SH - 1)
  }

  // The item strip's only "not yet" state: the board is live, no gesture owns the pointer, no
  // panel is up, and the short hold after a clear has expired.
  function canUseItemsNow() {
    return !isEnded() && !isPaused() && !drag && !isSettingsOpen() && performance.now() >= itemBusyUntil
  }

  // The two writes main's business paths make to the busy gate. `performance.now()` stays here,
  // where the gate is read (plan section 3).
  function holdItemsFor(ms) {
    itemBusyUntil = performance.now() + ms
  }

  function releaseItems() {
    itemBusyUntil = 0
  }

  function getItemActive() {
    return itemActive
  }

  function setRocketOrientation(axis) {
    if (itemActive?.id !== 'rocket') return
    itemActive.orientation = axis === 'col' ? 'col' : 'row'
    lastItemHoverKey = null
    if (itemActive.u !== undefined) rebuildItemOverlay()
    onAxisPick()
    onStatus(`Rocket line: ${itemActive.orientation === 'col' ? 'Column' : 'Row'}`)
  }

  function cancelItemSelection(silent = false) {
    itemTap = null
    if (!itemActive) {
      onAxisPickVisibility(true)
      onClearOverlay()
      return
    }
    itemActive = null
    lastItemHoverKey = null
    onClearOverlay()
    onAxisPickVisibility(true)
    if (!silent) onStatus('Pick a shape')
    onItemBar()
  }

  // The state half of a new run: no armed tool, no pending press, no hold, no cached hover key.
  // main keeps the charges (session) and the undo window's DOM around this.
  function resetItemTargeting() {
    itemActive = null
    itemTap = null
    itemBusyUntil = 0
    lastItemHoverKey = null
    onClearOverlay()
    onAxisPickVisibility(true)
  }

  // Arm a tool that is not the refresh: the mode, its Row/Col panel and the status line. Spending
  // the charge and closing the undo window stay with the caller, which is what orders them.
  function armItem(id) {
    itemActive = { id, face: null, u: undefined, v: undefined, orientation: id === 'bomb' ? '2x2' : 'row' }
    itemTap = null
    lastItemHoverKey = null
    onAxisPickVisibility(id !== 'rocket')
    onAxisPick()
    onStatus(id === 'hammer' ? 'Tap a block to remove' : id === 'rocket' ? 'Tap a line to clear' : 'Tap a 2x2 area')
  }

  function rebuildItemOverlay() {
    onClearOverlay()
    if (!itemActive || itemActive.u === undefined || itemActive.v === undefined) return
    const scope = toolScope(itemActive.id, itemActive.face, itemActive.u, itemActive.v, itemActive.orientation)
    // The overlay itself is pieceView's (P4c): which cells a tool covers is the tool's rule, and
    // whether a cell already holds a block is the board's — both are read here, so the module is
    // handed the finished list.
    onShowOverlay({
      face: itemActive.face,
      cells: scope.map((cell) => ({ cell, occupied: isOccupied(cell) })),
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
        onAxisPick()
      }
    }
    const key = `${itemActive.id}:${frontFace}:${itemActive.u},${itemActive.v}:${itemActive.orientation || ''}`
    if (key !== lastItemHoverKey) {
      lastItemHoverKey = key
      rebuildItemOverlay()
    }
  }

  // The press that may become a target. An armed tool fires on RELEASE, not on press, so a
  // mis-touch can still be turned into a rotation by moving the finger instead of spending the
  // item; the undo window in gameSession is the second safety net for everything the slop cannot
  // catch (07 §3.1 A1/A2). The press aims at once, so a touch player — who has no hover — sees
  // the highlight under their finger before committing.
  function beginItemPress(event) {
    itemTap = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY }
    updateItemHover(eventNdc(event))
  }

  // The release, in the two halves the pointerup listener needs: the pending press is taken out of
  // the way first, the view gesture and the drag are ended, and only then is the tap judged. That
  // is the order the listener always ran in.
  let pendingItemTap = null

  function beginItemRelease() {
    pendingItemTap = itemTap
    itemTap = null
  }

  function endItemRelease(event) {
    const tap = pendingItemTap
    pendingItemTap = null
    if (!tap || event.pointerId !== tap.pointerId || !itemActive) return
    // Beyond the slop the gesture was a cube turn, not a target: nothing is spent.
    if (Math.hypot(event.clientX - tap.startX, event.clientY - tap.startY) >= ITEM_TAP_SLOP) return
    selectItemAt(event)
  }

  function clearItemPress() {
    itemTap = null
    pendingItemTap = null
  }

  function selectItemAt(event) {
    const ndc = eventNdc(event)
    const frontFace = findFrontFace()
    const cellAt = isPointerOnCube(ndc) ? ndcToCell(frontFace, ndc) : null
    if (!cellAt) {
      // Releasing off the cube is a miss, not a confirmation on some corner cell.
      onStatus('Tap a face cell')
      onToast('Tap a face cell')
      return
    }
    itemActive.face = frontFace
    itemActive.u = clampCellIndex(cellAt.u)
    itemActive.v = clampCellIndex(cellAt.v)
    // Using the tool is main's: it spends the charge, clears the cells, presents it and arms the
    // undo window.
    onConfirmItem()
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

  function bind({ itemBar, axisPick, axisCancel, onActivateItem }) {
    if (unbind) return unbind

    function onPointerDown(event) {
      if (itemActive) {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        // Armed tool (v0.6, 07 §3.1 A1/A2). The press now does two things at once: it
        // aims (so a touch player, who has no hover, sees the highlight under their
        // finger before committing) and it hands the gesture to the view drag, so the
        // cube can still be turned to reach the face they want. Nothing fires here — the
        // release decides, and only if the pointer stayed inside ITEM_TAP_SLOP.
        beginItemPress(event)
        // beginViewGesture() prevents the default itself, but it bails out early while paused
        // or mid-drag — the item branch used to prevent unconditionally, so keep that.
        event.preventDefault()
        beginViewGesture(event)
        return
      }
      beginViewGesture(event)
    }

    function onPointerMove(event) {
      // The view gesture owns the pointer while it is live, and it says so -- the same early
      // return the inline branch used to do, including the one that waits for a decisive
      // direction before the pose may move at all.
      if (updateViewGesture(event)) return
      if (itemActive) {
        updateItemHover(eventNdc(event))
        return
      }
      updateDrag(event)
    }

    function onPointerUp(event) {
      // The pending item press is taken out of the way first, then the two gestures are ended, and
      // only then is the tap judged -- the order this listener always ran in.
      beginItemRelease()
      finishViewGesture(event)
      // The release is judged on the FINAL pointer coordinates, through the very same rule that
      // drew the last frame of the preview (v0.8.27): browsers do not always deliver a
      // pointermove at the release position, and "final judgement", "what the preview showed"
      // and "what actually lands" must not be three different answers. updateDrag() is a no-op
      // for a gesture that never left the slot, and it checks the pointer id itself.
      updateDrag(event)
      finishDrag(event)
      endItemRelease(event)
    }

    function onPointerCancel(event) {
      clearItemPress()
      finishViewGesture(event)
      if (!drag) return
      cancelActiveDrag(false)
    }

    function onWheel(event) {
      event.preventDefault()
      zoomBy(event.deltaY > 0 ? 0.92 : 1.08)
      fitCameraToPlaySpace()
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && onEscapeBeforeGestures(event)) return
      if (event.key === 'Escape' && itemActive) { event.preventDefault(); cancelItemSelection(); return }
      if (event.key === 'Escape' && drag) { event.preventDefault(); cancelActiveDrag(); return }
      if (event.key === 'Escape' && onEscapeAfterGestures(event)) return
      // W/S = X, A/D = Y, Q/E = Z (03 §13). Handled before the modal guard so the legend
      // can be learned while it is open, and before the rocket keys so nothing steals them.
      if (handleRotateKey(event)) { event.preventDefault(); return }
      if (isModalOpen()) return
      if (itemActive?.id === 'rocket' && ['r', 'c'].includes(event.key.toLowerCase())) {
        setRocketOrientation(event.key.toLowerCase() === 'c' ? 'col' : 'row')
      }
    }

    function onContextMenu(event) {
      if (itemActive) { event.preventDefault(); cancelItemSelection(); return }
      if (!drag) return
      event.preventDefault()
      cancelActiveDrag()
    }

    function onBlur() {
      cancelViewGesture()
    }

    // The strip's buttons are static (renderItemBar only toggles their classes), so they are
    // bound once here -- and kept in a list so dispose() can really unbind them.
    const itemButtons = []
    for (const button of itemBar.querySelectorAll('.item-button')) {
      const handler = () => onActivateItem(button.dataset.item)
      itemButtons.push([button, handler])
      button.addEventListener('click', handler)
    }
    const axisButtons = []
    for (const button of axisPick.querySelectorAll('button[data-axis]')) {
      const handler = () => setRocketOrientation(button.dataset.axis)
      axisButtons.push([button, handler])
      button.addEventListener('click', handler)
    }
    function onAxisCancelClick() {
      cancelItemSelection()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('blur', onBlur)
    axisCancel.addEventListener('click', onAxisCancelClick)

    function dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('wheel', onWheel)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('blur', onBlur)
      axisCancel.removeEventListener('click', onAxisCancelClick)
      itemButtons.forEach(([button, handler]) => button.removeEventListener('click', handler))
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
    bindSlot,
    getSelectedPiece,
    clearSelection,
    hasDrag,
    dragReport,
    // The armed tool.
    hasItemActive,
    getItemActive,
    canUseItemsNow,
    holdItemsFor,
    releaseItems,
    armItem,
    setRocketOrientation,
    cancelItemSelection,
    resetItemTargeting,
    beginItemPress,
    beginItemRelease,
    endItemRelease,
    clearItemPress,
  }
}

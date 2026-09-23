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
import { DRAG_GHOST, ROTATE_STYLE as rotateStyle } from '../rendering/config.js'
import { SH } from '../game/board.js'
import { maxOrigin } from '../game/shapes.js'

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
  function beginDrag(event, piece) {
    if (piece.used || isPaused() || drag || hasItemActive()) return
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
    const bounds = cubeScreenBounds()
    onSyncGhost({
      ndc,
      canvasHeight: Math.max(canvas.getBoundingClientRect().height, 1),
      cellPx: Math.max(bounds.maxX - bounds.minX, 1) / SH * DRAG_GHOST.cellRatio,
      pointerType: event.pointerType,
      mode,
    })
  }

  // One lattice step of a face, in client pixels. A finger delta is converted into
  // (du, dv) on THIS basis, which is what makes the piece follow the finger's own
  // direction on the face — including when the cube has been rotated to another face.
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

  // Keep an origin inside the face's own bounds before asking the board about it.
  function clampOrigin(cells, u, v) {
    const { u: uMax, v: vMax } = maxOrigin(cells, SH)
    return {
      u: THREE.MathUtils.clamp(u, 0, Math.max(uMax - 1, 0)),
      v: THREE.MathUtils.clamp(v, 0, Math.max(vMax - 1, 0)),
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
      if (!canPlace(face, cells, { u, v })) continue
      projected.copy(cellWorld(face, u, v)).project(camera)
      const distance = Math.hypot(projected.x - ndc.x, projected.y - ndc.y)
      if (distance < bestDistance) { bestDistance = distance; bestOrigin = { u, v }; found = true }
    }
    if (found) return bestOrigin
    return null
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
    onClearLanding()
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
      origin = canPlace(face, cells, target) ? target : previous
    }
    if (!origin) origin = nearestOriginOnFace(face, ndc, cells)
    if (!origin) return false
    if (!drag.anchor) drag.anchor = { x: event.clientX, y: event.clientY, u: origin.u, v: origin.v }

    const valid = canPlace(face, cells, origin)
    drag.valid = valid
    drag.origin = origin
    // The marker itself is pieceView's (P4b): it draws the cells it is handed, in the piece's own
    // colour while this drop is legal and in terracotta when it is not.
    onShowLanding({ face, cells, origin, valid, color: selectedPiece.shape.color })
    return true
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
      drag.cells = null
      // Back in the strip the piece is being put down, not held over a face: the next
      // arrival on the cube re-grabs wherever the finger is (v0.4.6).
      drag.anchor = null
      onClearLanding()
      syncGhostFor(event, eventNdc(event), 'cancel')
      onStatus('Release to cancel')
      return true
    }
    const ndc = eventNdc(event)
    drag.ndc = ndc
    const attached = updatePreview(event, ndc)
    // One piece per turn (v0.4.4): the ghost exists exactly while the piece is being
    // carried. Once it is attached to a face the board draws it and the carried copy
    // disappears; if the pointer is on the cube but this face has no room, the piece
    // stays in hand and turns red instead of silently vanishing.
    syncGhostFor(event, ndc, attached ? 'snap' : isPointerOnCube(ndc) ? 'invalid' : 'carry')
    if (attached) onStatus(drag.valid ? 'Release to place' : 'No room here')
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
    onClearLanding()
    onClearGhost()
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

  // Drop the drag record WITHOUT the cancel choreography: a new run rebuilds the whole board and
  // repaints the strip itself, and it has always nulled the record directly rather than routing
  // through the cancel path (which would add a status line, a haptic and a landing clear).
  function resetDrag() {
    drag = null
  }

  function finishDrag(event) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
    const currentDrag = drag
    drag = null
    releasePointerCapture(currentDrag.source, currentDrag.pointerId)
    onClearLanding()
    onClearGhost()
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
  // It hands back copies of the two points, so no probe can mutate the live gesture.
  function dragReport() {
    return {
      attached: Boolean(drag),
      valid: drag?.valid === true,
      origin: drag?.origin ? { u: drag.origin.u, v: drag.origin.v } : null,
      anchor: drag?.anchor ? { x: drag.anchor.x, y: drag.anchor.y, u: drag.anchor.u, v: drag.anchor.v } : null,
      stepScreen: drag?.face ? faceStepScreen(drag.face) : null,
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

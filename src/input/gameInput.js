// Game input -- the view gesture and the keyboard rotation (refactor P7a).
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
// feeds all three). This slice takes the view rotation and the keyboard. P7b takes the piece
// placement drag, P7c the item targeting, and the listener block itself moves into bind() only
// once all three handlers live here -- until then main's listeners delegate to the methods below.
import * as THREE from 'three'
import { gestureAxisReady, pickGestureAxis, screenBand, swipeAngle } from '../rendering/swipe.js'
import { axisForKey } from '../rendering/keyboard.js'
import { ROTATE_STYLE as rotateStyle } from '../rendering/config.js'

export function createGameInput({
  canvas,
  // Read-only queries and the interaction gates (plan section 3: nothing here is copied, and
  // nothing here is written).
  isPaused,
  hasDrag,
  hasItemActive,
  isHomeOpen,
  isSettingsOpen,
  isControlsOpen,
  // gameScene: the cube's screen box and the angle ruler a claimed axis is measured on.
  cubeScreenBounds,
  gestureSpan,
  // boardView: the pose commands and the live gesture record. `cubeSnapAnim` is a const object
  // mutated in place, so it can be handed over as-is.
  cubeSnapAnim,
  ROT_STEP,
  settleCubeSnap,
  beginAxisGesture,
  setLiveAngle,
  startCubeSnap,
  getLive,
  // main's callbacks -- the two things a key press does outside the pose: teach the legend, and
  // aim the armed tool from the keyboard.
  onItemHover,
  onControlsSpin,
  onAxisHint,
}) {
  // The rotation gesture. `let`, because every gesture replaces it, and never handed out: a
  // destructured copy would go stale the moment a gesture ends (the rule boardView's bearing
  // follows).
  let viewDrag = null

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

  return {
    // Pointer coordinates (plan section 2.1: this module owns them).
    eventNdc,
    // Pointer capture is pointer bookkeeping, so it lives with the gestures. Exported because
    // main's piece drag still uses it until P7b moves that group in.
    releasePointerCapture,
    // The view gesture.
    beginViewGesture,
    updateViewGesture,
    finishViewGesture,
    cancelViewGesture,
    resetRotation,
    // The keyboard.
    handleRotateKey,
  }
}

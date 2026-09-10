export const RENDER_PALETTE = Object.freeze({
  background: 0x69a5ff,
  navy: 0x24345d,
  navyDeep: 0x17284f,
  grid: 0x2d3e69,
  gridGlow: 0x8fbaff,
  candidate: 0xffc928,
  valid: 0x63f08a,
  invalid: 0xff5364,
  line: Object.freeze({ x: 0xffed78, y: 0x63f08a, z: 0x6bd5ff }),
})

// v0.2.23 "floating space board": the cube reads as a light spatial skeleton
// (deep-navy tint + faint grids + space-boundary edges) and the saturated,
// rounded voxels — slightly pushed out of the shell — are the visual subject.
export const BOARD_STYLE = Object.freeze({
  // Near-invisible volume tint left in place of the old solid body, so empty
  // boards still hint at the 5×5×5 space without looking like a dark block.
  hullColor: 0x16295c,
  hullOpacity: 0.05,
  hullRoughness: 0.55,
  // Space-boundary cage (was a strong 12-edge frame).
  edgeColor: 0x2e5396,
  edgeOpacity: 0.11,
  // Per-face N×N grid hint (was a loud 0.3 engineering overlay).
  gridColor: 0xaac4ee,
  gridOpacity: 0.13,
  // Placed-voxel shell: outward float offset, rounded body and softer lit plastic.
  voxelRaise: 0.17,
  voxelRoughness: 0.46,
  voxelEdgeColor: 0x24427d,
  voxelEdgeOpacity: 0.1,
  // Camera framing: higher = the cube fills more of the central canvas. The
  // cube is the primary touch surface (rotate gestures + placement), so the
  // v0.2.25 fit pushes it much closer than v0.2.24's "~10%/14% bigger" step; the
  // remaining margin is what the "swipe outside the cube" roll band needs.
  // Measured across six viewports (PC 1280/1440/1920 wide, mobile 360/390/414
  // wide) after horizontal centring: the cube fills 0.82 of the PC canvas height
  // and 0.77~0.79 of the mobile canvas width, with equal roll bands on both sides
  // (302/220/376px on PC, 39~42px on mobile). `keepCubeInsideCanvas()`
  // additionally guarantees the cube cannot leave the canvas on any aspect.
  safeFactorDesktop: 1.04,
  safeFactorMobile: 1.0,
  // Vertical re-centring in world units (cube drawn on a large central canvas).
  targetYDesktop: 0.1,
  targetYMobile: -0.3,
})

// Swipe-to-rotate feel. One gesture drives exactly ONE axis (v0.2.25): the
// dominant screen direction decides it, so a diagonal swipe can never tilt two
// axes at once. Horizontal -> yaw (screen Y axis). Vertical -> pitch (screen X
// axis) when the finger lands inside the cube's horizontal span, and roll
// (screen Z axis, an in-plane spin) when it lands outside it. Whichever axis
// wins, the gesture still moves the cube by at most ONE face: the step only
// fires once the drag passes `stepThreshold`, otherwise the cube springs back
// to the face it started on. The rest pose keeps whatever overshoot the gesture
// had left, clamped to the per-axis offset budget, so the face that ends up in
// front still reads as a 3D cube (and never snaps to a mechanically flat
// square). Radian values; degrees in the comments.
export const ROTATE_STYLE = Object.freeze({
  // Gesture direction. Every axis is signed in ONE place so a direction is a
  // single knob, never a sign scattered through the arithmetic. The signs below
  // make the cube's surface travel WITH the finger: swipe right and the front
  // face slides right (the left face comes around), swipe down inside the cube
  // and the front face slides down (the top face tips in), swipe down in a side
  // band and the cube spins clockwise on screen.
  //
  // v0.2.26 flipped all three to the opposite side; v0.2.27 put them back, after
  // the "the direction feels reversed" report turned out to come from the axes
  // themselves following the cube (see main.js, fixed gesture axes). Do not flip
  // these again to chase a direction report — check the axes first.
  yawDirection: 1,
  pitchDirection: 1,
  rollDirection: -1,
  stepThreshold: 0.52, // ≈30° of drag before the gesture turns to the next face
  axisLockPx: 6, // travel before the gesture commits to yaw / pitch / roll
  // Resting offsets: how much of the gesture's leftover tilt survives the
  // settle. Yaw/pitch keep ≤8° so the cube still reads as a 3D body instead of a
  // flat square. Roll keeps NOTHING: it is the in-plane spin, so any residual is
  // seen as a skewed face — Z always lands dead on the 90° grid (offset 0). The
  // spring feel comes from snapOvershoot instead of from a resting tilt.
  restOffsetYaw: 0.14, // ≈8° max leftover tilt from a horizontal swipe (screen X)
  restOffsetPitch: 0.14, // ≈8° max leftover tilt from a vertical swipe (screen Y)
  restOffsetRoll: 0, // 0 = the Z spin always straightens up exactly
  snapDuration: 0.26, // s — settle animation onto the resting pose
  snapOvershoot: 1.05, // easeOutBack strength ≈4% spring past the pose, then back
})

export const VFX_CONFIG = Object.freeze({
  clear: Object.freeze({
    duration: 0.72,
    life: 0.62,
    speed: 1.45,
    particleSize: 0.09,
    spread: 0.3,
    beamDuration: 0.56,
    beamOpacity: 0.5,
    stagger: 0.035,
    starDuration: 0.62,
    starMaxScale: 1.3,
  }),
  cameraShake: Object.freeze({
    singleLine: 0.055,
    multiLine: 0.12,
    decay: 0.42,
  }),
  bloom: Object.freeze({
    intensity: 0.55,
    lowPowerIntensity: 0.34,
    luminanceThreshold: 0.9,
    luminanceSmoothing: 0.22,
    radius: 0.72,
    levels: 6,
    lowPowerLevels: 4,
  }),
  preview: Object.freeze({
    cameraHeight: 2.15,
    maxScale: 1.7,
  }),
})

export function getRenderQuality() {
  const lowPower = window.matchMedia?.('(max-width: 700px)').matches || (navigator.hardwareConcurrency || 8) <= 4
  return Object.freeze({
    lowPower,
    pixelRatioMax: lowPower ? 1.35 : 2,
    multisampling: lowPower ? 0 : 4,
    particlesPerLine: lowPower ? 7 : 14,
    bloomIntensity: lowPower ? VFX_CONFIG.bloom.lowPowerIntensity : VFX_CONFIG.bloom.intensity,
  })
}

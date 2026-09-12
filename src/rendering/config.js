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

// Opening layout (v0.2.31): the cube no longer starts as a bare shell. A few
// blocks are seeded onto the faces the 3/4 camera can already see, drawn from the
// SAME pool the candidate slots use — same shapes, same colors — so the first
// frame reads as a board in play instead of an empty cage. The hard rules live in
// Board.seedOpening(): blocks never overlap, and a seed NEVER completes a line on
// any face. `place()` only settles the face being played, so a line seeded on some
// other face would sit there full and unbreakable until the player happened to
// play that face.
//
// One entry per face; the value is a target CELL count for that face (not a shape
// count — shapes run from 1 to 4 cells, so "2 shapes" could be 2 cells or 8 and the
// opening would swing between bare and crowded game to game). The 3/4 camera puts
// the front face (+z) right in front of the player and the top face (+y) on the
// roofline, so the front face carries most of the layout: seeding the top instead
// reads as "blocks on the roof" above an empty play surface (first cut, v0.2.31).
// ~13 of the shell's 98 cells (~13%), about a third of the front face: reads as a
// board in play while keeping the airy v0.2.23 look. Tune with these numbers only —
// the invalidity rules live in Board.seedOpening().
export const OPENING_LAYOUT = Object.freeze({
  '+z': 7, // front face: the player's play surface, and what the camera faces
  '+y': 3, // top face: visible on the roofline without rotating
  '+x': 3, // right side face: the second visible side
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
//
// v0.2.30 made the DRAG agree with that release rule: main.js's setLiveAngle()
// clamps the live angle to the same single face, so the cube can never show the
// player a rotation the release is about to take back ("it turned while my finger
// was down, then bounced back"), and the pitch pole limit that used to veto a
// step after the fact is gone — every axis can be turned again and again.
//
// v0.2.29 fixed two ways a gesture could turn into NOTHING (reported as "sometimes
// it just won't turn, it feels locked"):
//  1. The drag -> angle ruler was the CANVAS (dx / canvasWidth * π), so the same
//     "one face" step cost ~65px of drag on a 390px phone but ~185px on a 1120px
//     desktop canvas — on desktop an ordinary swipe simply sprang back. The ruler
//     is now the CUBE's own on-screen silhouette (sampled where the gesture
//     commits), so one face costs the same swipe length on every viewport and on
//     both axes.
//  2. The axis was claimed by whichever screen direction happened to be larger at
//     the first 6px of travel. A finger that starts with a few px of sideways
//     drift and then goes straight down claimed YAW, and since a locked gesture
//     ignores the other axis the whole vertical drag was discarded: the cube did
//     not move at all. The claim now needs a decisive leader (see axisDominance).
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
  stepThreshold: 0.52, // ≈30° of drag (≈1/6 of the cube's silhouette) before the gesture turns to the next face
  // Axis claim (v0.2.29). `axisLockPx` is the travel a drag must reach before any
  // axis may claim it; `axisDominance` is how far the leading direction must lead
  // the other one to claim it; a drag that is still ambiguous after
  // `axisHardLockPx` is handed to the leader anyway, so a deliberate diagonal
  // gesture can never stall. swipe.js re-tests this on every move until it
  // commits, so a slow start costs nothing (the angle is measured from the
  // gesture's own start point, not from where the axis was claimed).
  axisLockPx: 16, // travel before the dominant direction may claim the gesture
  axisDominance: 1.2, // lead / trail ratio that makes the dominant direction decisive
  axisHardLockPx: 44, // still ambiguous this far in? the leader takes it
  // Resting offsets: how much of the gesture's leftover tilt survives the
  // settle. Yaw/pitch keep ≤8° so the cube still reads as a 3D body instead of a
  // flat square. Roll keeps NOTHING and also clears prior yaw/pitch offsets in
  // main.js: Z is the explicit straighten gesture, so the final pose is the bare
  // 90° grid pose. Spring feel comes from snapOvershoot, not a resting skew.
  restOffsetYaw: 0.14, // ≈8° max leftover tilt from a horizontal swipe (screen X)
  restOffsetPitch: 0.14, // ≈8° max leftover tilt from a vertical swipe (screen Y)
  restOffsetRoll: 0, // 0 = Z has no own residual; main.js clears all rest tilt
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

// v0.3 feedback ladder (08-荣誉与排行榜系统.md §6, aligned with 03 §7).
// honors.js decides the LEVEL of a placement (that is a rule: it decides whether a
// banner is owed); the seconds, shake and particle strength behind each level are
// visual numbers and live here. Index = level, 0 = a placement that cleared nothing.
// The gradient is the point: 一段日常有反馈、稀有才隆重 — L3 runs about twice a game,
// L4 about once every three games, L5 about once every fifty (08 §6), so the top of
// the ladder must never become the background hum.
export const FEEDBACK_STYLE = Object.freeze({
  levels: Object.freeze([
    /* 0 nothing cleared */ Object.freeze({ duration: 0, shake: 0, particleScale: 0, banner: 'none', badges: false }),
    /* 1 one line */ Object.freeze({ duration: 0.35, shake: 0.055, particleScale: 1, banner: 'none', badges: false }),
    /* 2 two lines */ Object.freeze({ duration: 0.6, shake: 0.09, particleScale: 1.6, banner: 'small', badges: true }),
    /* 3 TRIPLE */ Object.freeze({ duration: 0.9, shake: 0.14, particleScale: 2.4, banner: 'name', badges: true }),
    /* 4 QUAD / TRIFACE */ Object.freeze({ duration: 1.4, shake: 0.2, particleScale: 3.5, banner: 'large', badges: true }),
    // L5 gets the only "顿帧" in the game: a brief slowdown for the ceremony, which
    // must never block input and must leave the board readable (03 §7 hard rule).
    /* 5 PENTA+ */ Object.freeze({ duration: 2.2, shake: 0.26, particleScale: 5, banner: 'full', badges: true, slowMo: Object.freeze({ scale: 0.6, ms: 400 }) }),
  ]),
  shakeDecay: 0.42, // per-second falloff of the camera shake
  honorBannerMs: Object.freeze({ small: 700, name: 900, large: 1400, full: 2200 }),
})

// HUD rules that the design fixes rather than the art: the chain pill only exists
// once a chain is real (08 §7.5 — a "CHAIN ×1" that is always on screen would make
// breaking it cost nothing), and the Game Over copy calls a gap "就差一点" only
// inside this ratio of the record (08 §7.5 差值文案一等公民).
export const HUD_STYLE = Object.freeze({
  chainMinVisible: 2,
  chainBarCap: 20, // chain length that fills the indicator bar
  bestGapRatio: 0.1,
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

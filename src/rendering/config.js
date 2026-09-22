// v0.7 「田园木作」colour system. Two families, and the split is the whole
// direction: WARM WOOD is the object (the cube, the signboards, the frame), and
// CRAYON PAINT is the only saturated thing on screen. Nothing else in the game is
// allowed a high-chroma colour — that is what keeps the cube the first read at
// 240px wide even with a full landscape behind it.
export const RENDER_PALETTE = Object.freeze({
  background: 0xdcefff,
  navy: 0x4a3218, // bark ink: every label on a wooden sign is this brown, not blue
  navyDeep: 0x2f1f0e,
  grid: 0x3d2a14,
  gridGlow: 0xd9ae72,
  candidate: 0xf7c13c,
  valid: 0x7ed957, // fresh leaf green: "it fits here"
  // v0.8.17: terracotta is the INVALID marker's colour and no longer a paint in the
  // pool (it used to be `Dot`'s), so "no room here" can never be painted in the very
  // colour of the piece being dragged. See src/game/shapes.js for the wood-band rule.
  invalid: 0xe8543f, // terracotta, not a UI error red (05「不要警告色」)
  line: Object.freeze({ x: 0xffd24a, y: 0x8ede5c, z: 0x7fd4f5 }),
})

// v0.7: a WOODEN TOY built out of BLOCKS.
//
// The board is not a shell with patterns painted on it — it is 98 unique CUBES
// whose six faces are flat, sitting in the 5×5×5 shell lattice with a small gap
// between neighbours. Their outer faces are flush with the big cube's surface, so
// the board reads as one large cube assembled from equal blocks, and the narrow
// dark notches between them are the only thing that tells them apart.
//
// A placed piece is the SAME cube with a different material. Nothing about a block
// ever changes: not its size, not its position, not its height. Placing is paint.
//
// This replaces two earlier models, both of which missed:
//   - v0.5 / v0.7.0 — a separate raised "chip" standing proud of the face. Wrong on
//     every shared edge/corner cell, where it had to pick a side and ended up
//     hanging off the bottom of the cube.
//   - v0.7.1 / v0.7.2 — flat plates glued onto the shell. A thin plate has its
//     rounding clamped away by the geometry and reads as a flat sticker; thickening
//     and lifting it turned the whole cube into a quilted cushion.
export const BOARD_STYLE = Object.freeze({
  // The shell is the BACKING, not a surface the player is meant to look at: it sits
  // behind the blocks, and every place it shows through is a notch between blocks.
  // It is therefore deliberately darker than the blocks — the groove IS this colour.
  hullColor: 0x765033,
  hullOpacity: 1,
  hullRoughness: 0.7,
  hullClearcoat: 0.1,
  hullGrainRepeat: 2.2,
  hullInset: 0.68, // total width reduction; backing is recessed ~0.3 behind the blocks
  hullRadius: 0.08,
  // ONE block, shared by the board, the candidate slots and the drag ghost: a piece
  // in the hand and a piece on the board are the same object (05「同源」).
  blockSize: 0.94, // narrow joints, with readable rounded shoulders
  blockRadius: 0.085, // broad polished shoulder, with 82% of the face still flat
  blockSegments: 3,
  blockColor: 0xff9c66,
  blockActiveColor: 0xffa16c,
  // A cube whose 98 blocks are all one flat colour looks like ONE moulded crate;
  // the reference is visibly assembled from separate pieces of timber. Each block
  // takes one of these tone multipliers, picked deterministically from its lattice
  // cell (#N neighbours get #N±6%, never a colour that could be mistaken for paint).
  blockToneSteps: Object.freeze([0.94, 0.97, 1, 1.02, 1.04, 1.06]),
  blockGrainRepeat: 1,
  woodRoughness: 0.43,
  woodClearcoat: 0.65,
  woodClearcoatRoughness: 0.18,
  woodBumpScale: 0.009,
  paintBumpScale: 0.005,
  environmentIntensity: 0.7,
  // Paint on an occupied block — and on the piece in the hand, so a piece never
  // changes material as it moves from the tray, through the drag, onto the board.
  paintRoughness: 0.3,
  paintClearcoat: 1,
  paintClearcoatRoughness: 0.12,
  voxelEdgeOpacity: 0.12,
  // Landing marker: a ghost of the block itself, sitting in the cell and lifted
  // just clear of whatever is already there so it cannot z-fight with a neighbour.
  previewLift: 0.03,
  exposure: 1.0,
  // v0.8.10: a WEAK, NEARLY LEVEL three-quarter view. This is what finally removes
  // the "停下来的时候沿着屏幕方向 Z 轴有旋转角度" report, and the reason is geometric
  // rather than stylistic:
  //
  //   the front face's own u axis (a world-X edge) lands on screen at
  //       u·U = -sin φ · sin(ψ - y)
  //   where φ is the camera's PITCH, ψ its yaw and y the cube's yaw. Both terms have
  //   to go: a level camera (φ = 0) makes it zero for any relative yaw at all, and a
  //   weak projection removes the leftover from perspective convergence (the two ends
  //   of a receding edge sit at different depths, so the drawn chord tilts further
  //   than the direction does — measured +13.5° on screen against a 7.5° direction
  //   tilt at v0.8.9's [0.34, 0.33, 1.0] / FOV 30 / D ≈ 14).
  //
  //   Lowering the pitch ALONE does not work: at the near camera the tilt only falls
  //   to ~13–18° (the chord is still dominated by convergence) and the top face drops
  //   out of view entirely below ~10° of pitch, because a face is only visible while
  //   D·sin(tilt) > half. A weak projection has no such cliff, so a 5° pitch still
  //   shows the roof as a band.
  //
  // Result (model, then verified in the probe): grid chord tilt ≈ 1.4° instead of
  // 13.5°, vertical edges still exactly plumb, three faces, main face ≈ 73%.
  // The three-quarter READ is unchanged — only the lens and the pitch moved.
  cameraFov: 6,
  cameraFovMobile: 7,
  // yaw 16° / pitch 8°. NOTE for anyone retuning: the yaw stays here rather than on
  // the cube because only the RELATIVE angle matters, and keeping it on the camera
  // leaves ROTATE_STYLE.bearingYaw centred on 0 — which is what makes the ±stepThreshold
  // fine-tune band symmetric in both directions. The pitch is the one knob that trades
  // "roof visible" against "grid straight": the tilt above is ~2.2° here, ~1.4° at 5°,
  // ~6.9° back at v0.8.9's 17.35°.
  cameraDirection: Object.freeze([0.273, 0.139, 0.952]),
  feedbackSurfaceOffset: 0.62, // particles/lines start clear of the block face
  // Camera framing: higher = the cube fills more of the central canvas. The
  // cube is the primary touch surface (rotate gestures + placement), so the
  // v0.2.25 fit pushes it much closer than v0.2.24's "~10%/14% bigger" step; the
  // remaining margin is what the "swipe outside the cube" roll band needs.
  // Measured across six viewports (PC 1280/1440/1920 wide, mobile 360/390/414
  // wide) after horizontal centring: the cube fills 0.82 of the PC canvas height
  // and 0.77~0.79 of the mobile canvas width, with equal roll bands on both sides
  // (302/220/376px on PC, 39~42px on mobile). `keepCubeInsideCanvas()`
  // additionally guarantees the cube cannot leave the canvas on any aspect.
  safeFactorDesktop: 0.887,
  safeFactorMobile: 0.96,
  // Vertical re-centring in world units (cube drawn on a large central canvas).
  targetYDesktop: 0.1,
  targetYMobile: -0.3,
})

// The same sun / sky / reflection rig is used by the board, tray and home toy.
export const LIGHTING_STYLE = Object.freeze({
  sky: 0xfff4df,
  ground: 0xa49a7b,
  hemisphereIntensity: 0.65,
  keyColor: 0xffefd6,
  keyIntensity: 2.4,
  keyPosition: Object.freeze([-3.5, 7, 5]),
  fillColor: 0xc9e3ff,
  fillIntensity: 0.5,
  fillPosition: Object.freeze([5, 2, -4]),
  rimColor: 0xffe6c4,
  rimIntensity: 0.75,
  rimPosition: Object.freeze([-4, 4, -5]),
  shadowExtent: 4.8,
  shadowBias: -0.00015,
  shadowNormalBias: 0.012,
  environmentWidth: 256,
  environmentHeight: 128,
  reflectionKeyIntensity: 14,
  reflectionKeyWidth: 0.48,
  reflectionKeyHeight: 0.16,
  reflectionRimIntensity: 4,
  reflectionRimFocus: 32,
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
// to the face it started on. The rest pose is then the bare 90° grid pose plus a
// fixed presentation tilt (see below), so the face that ends up in front always
// reads as a 3D body and never snaps to a mechanically flat square. Radian
// values; degrees in the comments.
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
  // band and the cube spins so that band's edge travels with the finger —
  // clockwise in the right band, anticlockwise in the left one (v0.8.1: a roll is
  // an in-plane spin, so "with the finger" is per band; the band picks the sign,
  // see swipe.js bandRollSign. One sign for both bands made the left band fight
  // the finger).
  //
  // v0.2.26 flipped all three to the opposite side; v0.2.27 put them back, after
  // the "the direction feels reversed" report turned out to come from the axes
  // themselves following the cube (see main.js, fixed gesture axes). Do not flip
  // these again to chase a direction report — check the axes first, and if only
  // ONE band feels reversed, it is the band sign in swipe.js, not this knob.
  yawDirection: 1,
  pitchDirection: 1,
  rollDirection: -1,
  stepThreshold: 0.52, // ≈30° of drag (≈1/6 of the cube's silhouette) before the gesture turns to the next face
  // ...and the same knob is the band the bearing is dialled inside: once "the bearing
  // the player has dialled plus this drag" leaves ±stepThreshold, the gesture turns a
  // FACE instead of fine-tuning further. One number on purpose — "the cube is more
  // than about a third of a face off the face" has to mean the same thing whether the
  // player just dragged there or had already dialled it there. Note this is the OUTER
  // bound; `bearingBand` below is the tighter, per-direction one that keeps the cube
  // from flattening. Do not raise this without re-running `npm run probe:framing`.
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
  // ===== The bearing (v0.8.8): the angle the player leaves the cube resting at =====
  //
  // THE BEARING IS THE PLAYER'S, NOT A CONSTANT. v0.8.6/v0.8.7 kept a fixed tilt that
  // every gesture settled back onto, so every turn ended on exactly the same angle
  // however the player had dragged — "每次转完，都是到达同一个角度". A release that does
  // not commit a face now KEEPS the offset the drag left behind, and that offset is
  // remembered across face turns: the next face arrives at the bearing the player
  // dialled. See main.js planAxisRelease().
  //
  //   rendered = Rx(bearingPitch) ∘ Ry(bearingYaw) ∘ (liveRotation ∘ gridPose)
  //
  // Composited PITCH FIRST, YAW LAST, and that order is load-bearing: a rotation about
  // world Y cannot move the world-Y direction, and that direction IS the cube's
  // vertical edge, so this order keeps the board plumb for EVERY bearing the player
  // can dial. The reverse order leans it (v0.8.6 measured −4.8° on screen, "视觉上还
  // 比较歪"). Pitch is allowed here precisely BECAUSE the order makes it safe.
  //
  // The three-quarter read itself lives in the CAMERA (BOARD_STYLE.cameraDirection);
  // this pair is only the extra turn on top of it.
  //   - negative yaw turns the cube further toward the right-hand face (more side
  //     face in view, main face smaller);
  //   - positive yaw turns the front face back toward the screen (main face larger).
  bearingYaw: 0, // ≈0° — the whole three-quarter read lives in the camera
  bearingPitch: 0,
  // How far the bearing may be dialled, PER AXIS AND PER DIRECTION. The gate is "all
  // three faces stay visible and the front face stays the subject".
  //
  // v0.8.10 re-derived these for the weak-perspective camera (the old fence numbers
  // were measured against a near camera with a visibility cliff, where a face could
  // vanish outright; a weak projection has no cliff, so the limits are now gradual):
  //
  //   bearing yaw  -24° → main 51%, side 42%   the front face stops being the subject
  //                -14° → main 60%, side 30%
  //                  0° → main 75%, side 18%, top 8%   ← the shipped default
  //                 +5° → main ~80%
  //                +10° → main 86%, side 8%, top 5%   flat enough to read as a grid
  //   bearing pitch +8° → main 67%, top 16%
  //                  0° → the default
  //                 -4° → main 79%, top 3%   the roof is down to a line
  //
  // The band keeps the main face between roughly 60% and 80% and every face at ~5%
  // or more — i.e. inside the composition the producer has approved, at both ends.
  bearingBand: Object.freeze({
    yaw: Object.freeze({ min: -0.2443, max: 0.0873 }), // -14° (more three-quarter) .. +5° (more frontal)
    pitch: Object.freeze({ min: -0.0349, max: 0.1396 }), // -2° (more frontal) .. +8° (more three-quarter)
  }),
  // NOTE on the two directions: the band's ring-fenced side is the one with almost no
  // headroom left. Between the fence and the ≈30° step threshold a frontal drag docks
  // at the fence and does nothing more until it is long enough to turn a face instead.
  // That is deliberate — the alternative is letting the cube flatten — but it is a
  // feel decision, flagged in docs/Technical/KNOWN_GAPS.md.
  snapDuration: 0.22, // s — settle animation onto the resting pose
})

export const VFX_CONFIG = Object.freeze({
  occlusion: Object.freeze({
    samples: 16,
    rings: 3,
    radius: 0.075,
    intensity: 1.65,
    bias: 0.012,
    fade: 0.018,
    color: 0x60422e,
    worldProximityThreshold: 0.35,
    worldProximityFalloff: 0.45,
    luminanceInfluence: 0.15,
    resolutionScale: 0.75,
  }),
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
    intensity: 0.18,
    lowPowerIntensity: 0.1,
    luminanceThreshold: 1.35,
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

// v0.4.4 drag ghost (03 §4「方块跟随光标移动」，v0.2.24~v0.4.3 一直缺实现).
// Until now a drag only lit the landing cells on the board: the piece itself
// vanished the moment the finger left the slot, so on a phone — where the thumb
// covers the very slot it came from — there was nothing on screen that said
// WHICH shape was in hand. The ghost is that piece: the same rounded voxel
// geometry, roughness and lighting as the board and the slot preview
// (05「候选预览与棋盘同源」), drawn in the CAMERA's frame so it always faces the
// player and never inherits the cube's rotation.
//
// v0.4.4 修订（制作人实测反馈）：一个回合里画面上**只能有一个方块**。
//   ① 抬升改成固定的小常量。原先是"半个方块高度"，桌面 1440×900 上 4 格块被
//      顶到光标上方 107px，方块不再像"手里拿着的东西"，读起来就是"不跟手"。
//   ② 方块一旦吸附到六面体面上，手里的幽灵立刻消失——棋盘上的落点预览**就是**
//      那个方块。之前幽灵和预览同时在屏，玩家看到"两个方块"。
//   ③ 因为 ②，吸附（以及落点预览）只在指针真正到达六面体附近时才发生；指针还在
//      画布空白区时，方块仍然"在手上"，只画幽灵。
export const DRAG_GHOST = Object.freeze({
  // Cell edge as a fraction of the board's own cell pitch on screen (the cube
  // silhouette ÷ SH). 0.9 lands a carried cell at ≈53px on a 390px phone — a
  // touch larger than the slot preview it came from, the same read as the board.
  cellRatio: 0.9,
  // TOUCH: the piece rides half its own height plus a small clearance above the
  // contact point, so its BOTTOM EDGE stays just clear of the thumb — the "held
  // above the fingertip" read. A fixed offset cannot do this: a 2-row piece
  // centred 26px above the finger still had its whole bottom row under it.
  liftTouchPx: 12, // clearance between the piece's bottom edge and the contact point
  liftRatio: 0.5, // the "half its own height" term
  liftMaxPx: 120, // capped, so a 4-long piece never floats away from the gesture
  // MOUSE: a small FIXED lift, with no shape term. A cursor is a few px across and
  // is drawn on top of the canvas anyway; the offset that reads as "held in the
  // hand" on a touch screen reads as "the piece is not following the drag" when the
  // driver is a mouse (v0.4.4 pushed a 4-cell piece 107px above the cursor on
  // desktop — the producer's "不跟手").
  liftMousePx: 10,
  // How close the pointer has to get to the cube's screen silhouette before the
  // piece attaches to a face. Inside it the piece is on the board; outside it is
  // still in hand. Small on purpose: the handoff must happen where the finger
  // reaches the cube, not a noticeable distance before it.
  snapMarginPx: 18,
  // Camera-space depth of the ghost plane. Immaterial to how it looks (the scale
  // below compensates exactly) and only has to sit nearer than the cube.
  planeDistance: 8,
  opacity: 0.96, // over the canvas it must still read as the piece, not as a landing cell
  invalidOpacity: 0.82, // red tint: on the cube but no room here (05「非法预览」)
  cancelOpacity: 0.34, // dragged back into the cancel strip: the UI there is the answer
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

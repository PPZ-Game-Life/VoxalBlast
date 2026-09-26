// Garden reference skin: cream timber, saturated lacquer and generated UI art.
// Stored game colours are mapped separately by referencePalette.js.
export const RENDER_PALETTE = Object.freeze({
  background: 0xdcefff,
  navy: 0x4a3218, // bark ink: every label on a wooden sign is this brown, not blue
  navyDeep: 0x2f1f0e,
  grid: 0x3d2a14,
  gridGlow: 0xd9ae72,
  candidate: 0xf7c13c,
  valid: 0x7ed957, // fresh leaf green: "it fits here"
  invalid: 0x9299a2, // neutral grey: colour is reserved for a legal placement
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
  hullColor: 0xad754c,
  hullOpacity: 1,
  hullRoughness: 0.7,
  hullClearcoat: 0.1,
  hullGrainRepeat: 2.2,
  hullInset: 0.68, // total width reduction; backing is recessed ~0.3 behind the blocks
  hullRadius: 0.08,
  // ONE block, shared by the board, the candidate slots and the drag ghost: a piece
  // in the hand and a piece on the board are the same object (05「同源」).
  blockSize: 0.97, // tightly packed, individually rounded reference blocks
  blockRadius: 0.14,
  blockSegments: 5,
  blockColor: 0xffcfa3,
  blockActiveColor: 0xffd3ac,
  // A cube whose 98 blocks are all one flat colour looks like ONE moulded crate;
  // the reference is visibly assembled from separate pieces of timber. Each block
  // takes one of these tone multipliers, picked deterministically from its lattice
  // cell (#N neighbours get #N±6%, never a colour that could be mistaken for paint).
  blockToneSteps: Object.freeze([0.97, 0.985, 1, 1.01, 1.02, 1.03]),
  blockGrainRepeat: 1,
  woodRoughness: 0.34,
  woodClearcoat: 0.8,
  woodClearcoatRoughness: 0.16,
  woodBumpScale: 0.003,
  paintBumpScale: 0.001,
  environmentIntensity: 0.5,
  // Paint on an occupied block — and on the piece in the hand, so a piece never
  // changes material as it moves from the tray, through the drag, onto the board.
  paintRoughness: 0.16,
  paintClearcoat: 1,
  paintClearcoatRoughness: 0.09,
  voxelEdgeOpacity: 0,
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
  // Restrained presentation. v0.9.2: the camera's own AZIMUTH is no longer a presentation
  // knob — the dock follows it (see CAMERA_BEARING_YAW below), so the resting pose is
  // head-on at every camera angle and the only depth cue the rest pose has left is this
  // PITCH (12° → a roof band). What the camera's yaw still decides is which way the cube
  // faces in the WORLD (hence where the sun and the shadows fall on it); turning the
  // camera does NOT put a side face back into the resting pose. Gesture thresholds and the
  // bearing margin are unchanged.
  cameraDirection: Object.freeze([0.429, 0.208, 0.879]),
  feedbackSurfaceOffset: 0.62, // particles/lines start clear of the block face
  // Camera framing: higher = the cube fills more of the central canvas. The
  // cube is the primary touch surface (rotate gestures + placement), so the
  // Portrait framing prioritizes the play face while retaining a narrow band
  // on both sides for the outside-cube roll gesture. The CSS play area reserves
  // the tool row above and the candidate tray below; keepCubeInsideCanvas()
  // applies the final pixel inset for the current viewport.
  safeFactorDesktop: 1.18,
  safeFactorMobile: 1.24,
  // v0.9.1 (producer 2026-09-24): the cube is drawn 10% smaller in portrait — "竖屏现在六面体太大了，缩小 10%".
  // Applied to the SOLVED camera distance (distance / factor = smaller cube); portrait only.
  // Landscape and the desktop framing gate (88–92% in probe:framing) are deliberately untouched.
  // Orientation is the WINDOW's, not the canvas box: after the tool row above and the candidate
  // tray below are reserved, the central canvas on a 390×844 phone is 390×495 — wider than tall,
  // so a canvas test would never fire. Same query the backdrop uses for its portrait art.
  portraitCubeScale: 0.86,
  // Vertical re-centring in world units (cube drawn on a large central canvas).
  targetYDesktop: 0,
  targetYMobile: 0,
})

// v0.9.2: THE DOCK IS DERIVED FROM THE CAMERA, never typed in beside it.
//
// The fine-tune zone is centred on the dock, so "drag left and drag right and see the same
// amount of side face" is true for exactly ONE dock: the HEAD-ON pose, whose play face
// points at the camera. That pose is the one whose yaw equals the camera's own azimuth,
// i.e. atan2(cameraDirection.x, cameraDirection.z) — nothing else.
//
// v0.8.26 pinned it by hand (0.2793 rad = 16°, the camera's yaw THEN) and the invariant
// was invisible in the file, so when the 2026-09-24 art commits retuned the camera to a
// 26° three-quarter view the literal stayed behind: the dock silently became 10° off-axis
// and the asymmetry came straight back — measured at the dock, one side face 0.0% against
// the other's 10.0%, and at the two ends of the zone 0% against 21.1%, which
// `npm run probe:framing` reports as "the dock is off the camera axis" and "the two ends
// of the zone are not mirror images". Deriving the dock retires that whole class of
// regression: retune the camera and the dock follows it.
const CAMERA_BEARING_YAW = Math.atan2(BOARD_STYLE.cameraDirection[0], BOARD_STYLE.cameraDirection[2])

// The same sun / sky / reflection rig is used by the board, tray and home toy.
export const LIGHTING_STYLE = Object.freeze({
  sky: 0xffffff,
  ground: 0xefd3b7,
  hemisphereIntensity: 1.0,
  keyColor: 0xfff5e6,
  keyIntensity: 2.6,
  keyPosition: Object.freeze([-3.5, 7, 9]),
  fillColor: 0xc9e3ff,
  fillIntensity: 0.8,
  fillPosition: Object.freeze([5, 2, -4]),
  rimColor: 0xffe6c4,
  rimIntensity: 0.75,
  rimPosition: Object.freeze([-4, 4, -5]),
  shadowExtent: 4.8,
  shadowBias: -0.00015,
  shadowNormalBias: 0.012,
  environmentWidth: 256,
  environmentHeight: 128,
  reflectionKeyIntensity: 8,
  reflectionKeyWidth: 0.48,
  reflectionKeyHeight: 0.24,
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
  // ...and it is measured against THIS GESTURE'S OWN DRAG, never against the bearing
  // (v0.8.24, rule 3). Through v0.8.23 the test was `|dialled bearing + this drag|`,
  // which made the face-change cost depend on where the player had already left the
  // cube: parked at the +5° frontal fence, a further 24.8° of drag turned a face,
  // while from the −14° three-quarter fence the same face cost 44.8°. The threshold
  // and the fine-tune offset are now two separate things — the drag decides whether
  // a face turns, the offset decides only what angle the cube rests at — so the
  // gesture costs the same in every direction and from every bearing. That also
  // retires the old dead zone at the frontal fence ("docked at the fence and does
  // nothing more", KNOWN_GAPS v0.8.9): a frontal drag now always turns a face once
  // it is long enough, whatever the bearing was. Do not raise this without re-running
  // `npm run probe:framing`.
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
  // ===== The dock, the fine-tune zone and the resistance (v0.8.24) =====
  //
  // THE BEARING IS THE PLAYER'S, NOT A CONSTANT. v0.8.6/v0.8.7 kept a fixed tilt that
  // every gesture settled back onto, so every turn ended on exactly the same angle
  // however the player had dragged — "每次转完，都是到达同一个角度". A release that does
  // not commit a face KEEPS the offset the drag left behind, and that offset is
  // remembered across face turns: the next face arrives at the bearing the player
  // dialled. See boardView.js planAxisRelease().
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
  //
  // ---------------------------------------------------------------------------
  // THE DOCK IS THE CENTRE OF THE ZONE, AND THE DOCK IS THE HEAD-ON POSE
  // (v0.8.24 rebuilt the zone, v0.8.25/26 moved the dock onto the camera axis, v0.9.2 made
  //  that pose DERIVED — see CAMERA_BEARING_YAW above.)
  //
  // Through v0.8.23 the dock was 0° while the zone was ASYMMETRIC (yaw −14°..+5°,
  // pitch −2°..+8°), so the player's margin from the dock was 14° one way and 5° the
  // other. v0.8.24 made the zone symmetric about the dock; two rounds of producer
  // feedback then pinned down what "symmetric" has to mean here:
  //
  //   "停下来的时候，我可以看到右侧面一部分……我想在停止的时候，能够看到右侧面和左
  //    侧面的面积应该一致。"
  //
  // That is a statement about the COMPOSITION, not about margins, and it has exactly one
  // solution: the dock must be the pose whose front face points at the camera. At any
  // other dock the two side faces are not interchangeable — measured at the v0.8.25 dock
  // (bearing +8°), the zone could reach 20.4% of the right-hand face but only 0.3% of
  // the left, because on one side the cube turns away from the camera and on the other it
  // runs into the head-on pose and stops.
  // v0.8.26 satisfied that by hand (bearing 0.2793 = the camera's yaw of the day, 16°), and
  // v0.9.2 hit the exact failure a hand-typed dock invites: the 2026-09-24 art commits moved
  // the camera to a 26° azimuth and the literal did not move with it, so the dock sat 10°
  // off-axis again — the resting pose showed one side face and never its mirror (0.0% vs
  // 10.0% at the dock), and the two ends of the zone disagreed (side face invisible one way,
  // 21.1% the other), which is exactly the report "往左微调看到的侧面比往右大很多". The dock
  // is now atan2(cameraDirection.x, cameraDirection.z), so it cannot drift again.
  //
  // Compositions at the CURRENT camera (26° azimuth, 12° pitch), measured with
  // `npm run probe:framing` (bearing section):
  //
  //   bearing   relative yaw   composition                            side face
  //    +16°       -10°         main 77.0% roof 13.0% side 10.0%       none / 10.0% at x = +0.194
  //    +26°         0°         main 85.8%  —     roof 14.2%  ← DOCK     0          / 0
  //    +36°       +10°         main 77.0% roof 13.0% side 10.0%      10.0% at x = −0.186 / none
  //
  // The two ends of the zone are exact mirror images, so "drag either way and see the same
  // amount of the side face" is true rather than approximately true, and the resting view
  // has no left-right lean at all (the play face's centre lands on the frame centre).
  //
  // What this costs, stated plainly because it is the reason the 2026-09-24 art commits went
  // the other way: at the dock the side faces are edge-on, so the rest pose shows the play
  // face and the ROOF BAND only (14.2% — the depth cue that keeps it a body rather than a
  // flat grid, which is what v0.8.6 was rejected for, and that camera had no pitch at all).
  // The play face is also the largest it can be (85.8% of the silhouette, against 77.0%
  // while the dock sat 10° off-axis — "three-quarter at rest" is exactly what the off-axis
  // dock was buying), and the fine-tune reveals a side face by the same amount in either
  // direction, up to 10.0% at the zone ends.
  //
  // The margin stays ±10°. It is NOT slack: the drag only claims its axis after
  // `axisLockPx` (16px ≈ 6.4° of the cube's silhouette on PC, ≈9.4° on a 390px phone),
  // so a zone much tighter than this would be swallowed by the lock and the fine-tune
  // would arrive as a jump (measured 16.9° of finger travel for the ±10° zone — see
  // `bearingResistance` below).
  //
  // The pitch dock stays 0°, and the pitch margin stays ±3°: the roof is the only depth cue
  // the dock has, so ±3° keeps it a band at the frontal end instead of a line.
  bearingYaw: CAMERA_BEARING_YAW, // the dock = the camera's own azimuth (26.0° here); see CAMERA_BEARING_YAW
  bearingPitch: 0,
  bearingMargin: Object.freeze({
    yaw: 0.1745, // ±10°
    pitch: 0.0524, // ±3°
  }),
  // THE RESISTANCE (v0.8.24, rule 2). The zone above is where a release KEEPS the
  // angle; it is not a wall the drag slams into at the moment of release. Inside
  // `free` of the zone the cube tracks the finger 1:1; from there to the zone edge
  // the response eases off, so the player feels the boundary ARRIVING while the
  // finger is still down; past the edge the cube keeps following the finger at
  // `wall` of its speed.
  //
  //   raw offset (the finger)          rendered offset (the cube)
  //   0 .. 0.4·margin                  1:1
  //   0.4·margin .. 1.0·margin         eased, slope 1 → wall
  //   1.0·margin ..                    margin + (raw − edge)·wall
  //
  // The eased middle segment is the integral of a slope that falls from 1 to `wall`
  // as (1 − s)², and its length follows from having to land exactly on `margin`:
  //
  //   operation = free + (1 − free) / (wall + (1 − wall)/3) = 0.4 + 0.6/0.4667 = 1.686
  //
  // i.e. ±16.9° of yaw drag to dial the ±10° zone, and ±5.1° of pitch drag for ±3°.
  // That 1.69 is the number the player actually feels — the finger travel the margin
  // is worth — and it is the SAME in both directions, which is what makes the margin
  // symmetric in operation and not merely in degrees.
  //
  // PAST THE EDGE THE CUBE MUST KEEP MOVING, and that is why the wall is a slope and
  // not a saturation. A saturating curve (the first cut of this) froze the cube from
  // ~40° of yaw drag on — measured, `probe:framing`'s trajectory section read a zero
  // pose increment and could not name the rotation axis at all — and it turned every
  // flip gesture into "the cube stops, then jumps". With a slope the cube is never
  // frozen, and the flattening is bounded where it matters: the widest overshoot a
  // player can release with is the one at the ≈30° flip threshold, margin + (30° −
  // 16.9°)·wall ≈ margin + 26% (measured at the edge: 12.63° for a 10° margin, 3 faces
  // still visible), which the 0.16 s convergence takes back.
  //
  // (0.4 / 0.2 are a feel tuning set: raise `free` for a later, sharper edge, raise
  // `wall` to make the far side less sticky.)
  bearingResistance: Object.freeze({
    free: 0.4, // fraction of the zone that tracks the finger 1:1
    wall: 0.2, // slope past the zone edge, as a fraction of the finger's speed
  }),
  snapDuration: 0.22, // s — settle animation onto a turned face
  bearingSettleDuration: 0.16, // s — the short, overshoot-free convergence onto the zone edge
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

// How far ABOVE the contact point the carried piece's own bounding-box CENTRE sits, in
// client pixels. TWO modules need this exact number since v0.8.27 -- pieceView places the
// carried ghost with it, and gameInput uses it to land that same centre on the face when the
// piece attaches -- so it lives here instead of in either of them: if the two ever disagree,
// the piece visibly jumps at the moment it leaves the hand (the producer's 大方块跳位).
// `rows` is the shape's height in lattice cells and `cellPx` one carried cell edge on screen.
export function dragGhostLiftPx(pointerType, rows, cellPx) {
  return pointerType === 'mouse'
    ? DRAG_GHOST.liftMousePx
    : DRAG_GHOST.liftTouchPx + Math.min(rows * cellPx * DRAG_GHOST.liftRatio, DRAG_GHOST.liftMaxPx)
}

// Turning the cube out from under a piece (v0.9.3). When the face the piece is on has NO room for
// it anywhere, the same finger stops moving the piece and starts turning the cube, so another face
// can be reached without letting go (input/gameInput.js: the spin). 「推上去没空位，立方体就跟着我
// 拖的方向翻」.
//
// `startPx` is what makes that a PUSH rather than an accident. The piece can now attach to a full
// face while the finger is still travelling — it always could — and the residual motion of an
// ordinary drag would otherwise claim the axis and turn the cube under a player who never asked
// for it. So the spin's ruler starts where the piece became stuck and needs this much travel
// before an axis may claim it; ROTATE_STYLE.axisLockPx (16px) is then required ON TOP of it, and
// the face turn itself still waits for its own 30° of drag. One number, three guards, all of them
// in pixels the player can feel.
export const PIECE_SPIN = Object.freeze({
  startPx: 26,
  // The SECOND arming condition (v0.9.4, given its time rule by the producer in v0.9.5): the piece
  // is pinned against a face edge and the finger keeps pushing outward —
  // 「超出下方一半格子，超过一段时间以后就向下翻」. THREE numbers, and the producer's sentence names
  // all three:
  //   - `pinCells` 超出半格 — the push past the edge, in LATTICE CELLS (the clamp's own unit, and the
  //     only one that means the same thing everywhere on a face: the +z face measures 34px per cell
  //     near its right edge against 54px at its centre). Bounded from both sides: big enough that
  //     stopping a placement AT an edge never arms anything, small enough to be reached inside the
  //     cube's silhouette — probe:drag case K measures that room at ~0.8 of a cell (~45px) on a
  //     430×900 viewport, and the first push has to fit 「半格 + 一点点」 inside it.
  //   - `armLeanDeg` 立即的反馈 — the cube leans this far the way the finger is pushing the moment the
  //     threshold is crossed, so 「立方体跟着我拖的方向」 is visible BEFORE anything is committed.
  //   - `pinHoldMs` 超过一段时间 — how long the push has to be HELD before the face actually turns.
  //     This is what separates 「我是故意要翻」 from 「我推到边上顺手超了一点」: the accidental
  //     overshoot is over in well under this, a deliberate push is not.
  pinCells: 0.5,
  armLeanDeg: 8,
  pinHoldMs: 360,
  // How far OUTSIDE the cube's box a PINNED piece keeps following the gesture (v0.9.6). The attach
  // margin (DRAG_GHOST.snapMarginPx, 18px) is not enough on the TIGHT edges: past the bottom of a
  // face there is no other face to widen the silhouette, so the finger leaves the cube after
  // 18px + whatever sliver is left, the piece goes back to the hand, and the push never reaches
  // `pinCells`. Measured on a 430×900 viewport with a Dot pushed down: the piece still has to slide
  // to the bottom row before the push even starts counting, and by then the pointer was already
  // outside — the producer's 「我往下已经超出很多了，但是没有转，有时候又转了」. 90px is past the point
  // where a finger that keeps going has clearly left the cube, and far short of the drag that puts
  // the piece back in the strip.
  pinMarginPx: 90,
  // How far the finger has to come BACK (client px, along the push direction) before an armed turn is
  // called off. Small enough that a deliberate change of mind cancels, large enough that the tremor
  // of a held finger does not.
  backPx: 12,
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

// ============================================================
// Opening creation wave (v0.8.22, 03 §6)
// ============================================================
// A run does not open on a finished cube. It is BUILT, then PAINTED, in two passes:
//
//   stage 1「上底漆」 98 blocks fly in from inside their cells along the screen
//                    diagonal (bottom-left → top-right) and take a primer coat — a
//                    single family of cool stone tones, banded by the cube's own
//                    height, so the coat reads as designed and not as noise. No
//                    timber, no crayon paint: nothing on screen is a game colour yet.
//   hold             a short beat with the primed cube standing complete.
//   stage 2「上色」   the same diagonal sweeps again and each block repaints ITSELF
//                    into the colour the board actually has (timber for a bare cell,
//                    its own paint for an occupied one). A block only ever lerps
//                    between its primer colour and its real colour — the final frame
//                    lands exactly on the board's colour because it IS the board's
//                    colour.
//
// Presentation only: the wave reads the board the rules already made and never writes
// to it (see the intro block in main.js). `npm run probe:intro` grades both stages,
// including that all 98 blocks end on the authored transform wearing the shared
// material, and that the board is byte-identical before and after.
//
// Timing was lengthened and split in v0.8.22 on the producer's report that the v0.8.21
// single pass "太快，看不清": one block now takes 0.30s (was 0.19s) to build and 0.26s
// to repaint, with a 0.22s beat between the passes. Total ≈ 2.85s.
//
// The stagger is still quoted per WAVE BAND, not per block: 98 blocks 25–40ms apart
// would need 2.4–3.9s per stage on its own. The diagonal order is cut into `bandCount`
// bands, adjacent bands are `bandStagger` apart, and the ~4 blocks sharing a band start
// together. A band is ~27px wide along the screen diagonal while a block is ~55px, so
// the front reads as continuous rather than as a staircase of fours.
export const INTRO_STYLE = Object.freeze({
  enabled: true,
  // ---- Stage 1: build the cube and give it its primer coat ----------------------
  build: Object.freeze({
    duration: 0.3, // one block: fade + scale + travel. 160–220ms was v0.8.21; dilated here
    bandCount: 26, // wavefront bands across the screen diagonal, shared by both stages
    bandStagger: 0.042, // delay between adjacent bands in stage 1
    jitter: 0.014, // ≤14ms of per-block scatter inside a band, hashed from the cell
    // Scale: 0.72 → 1.04 → exactly 1. The 1.04 is ONE planned step, not a spring that
    // rings: `rise` reaches it at overshootAt, `settle` takes it back, and nothing
    // crosses 1 twice.
    scaleFrom: 0.72,
    scaleOvershoot: 1.04,
    overshootAt: 0.62,
    fadeAt: 0.55, // opacity reaches 1 here, i.e. before the block lands
    inset: 0.42, // how far inside its cell a block starts, along its own face normal
    // How far the far side of the cube trails the near side in the same wavefront.
    // 0 would interleave the back faces with the front ones and read as noise.
    depthBias: 0.16,
  }),
  // The primer coat. One family, three values, banded by the block's height on the
  // cube (bottom band first) — deliberately NOT any colour in the shape pool, and
  // deliberately not timber, so stage 1 can never be mistaken for the finished board.
  // A single-element array gives a flat one-colour coat instead of a banded one.
  primer: Object.freeze({
    colors: Object.freeze([0x7d8b9c, 0x93a1b2, 0xa9b6c5]),
    roughness: 0.62,
    clearcoat: 0.18,
    bumpScale: 0.003,
  }),
  hold: 0.22, // the primed cube stands still for this long before stage 2
  // ---- Stage 2: every block repaints itself into the board's own colour ---------
  paint: Object.freeze({
    duration: 0.26, // one block's repaint: colour + surface lerp and a small tap
    bandStagger: 0.038, // delay between adjacent bands in stage 2
    occupiedDelay: 0.05, // painted blocks repaint one beat after the bare timber (40–60ms)
    scalePulse: 1.05, // the "stamp" of the repaint; 1 disables it
    shine: 0.22, // emissive lift a painted block gets at its own peak
    shineColor: 0xffe6bd,
  }),
  reducedMotionDuration: 0.18, // prefers-reduced-motion: one whole-board fade, 150–200ms
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

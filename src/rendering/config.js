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
  // Item scope (07 §8.5.4). Three separate signals, because the doc forbids smuggling the
  // message through one of them: the SCOPE draws the complete reach (frame + the faint floor
  // of a cell that is already empty), CLEAR outlines the cells that will actually disappear,
  // and SHARED marks the cells an edge/corner hands to a neighbouring face. An empty cell is
  // never allowed to look like a doomed one.
  itemScope: 0x6fce4a, // fresh leaf green: "this is the tool's reach" (same family as valid)
  itemClear: 0xffd24a, // the line-clear gold already used by the x-axis: "this one goes"
  itemShared: 0xff8ac2, // blossom pink: "this cell also shows on the next face"
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
  blockSize: 0.95, // 0.05-unit gap at the unchanged unit lattice pitch
  blockRadius: 0.13,
  blockSegments: 3, // 588 triangles, shared by board / tray / ghost
  blockColor: 0xf3c99a,
  blockActiveColor: 0xf8d2a8,
  // A cube whose 98 blocks are all one flat colour looks like ONE moulded crate;
  // the reference is visibly assembled from separate pieces of timber. Each block
  // takes one of these tone multipliers, picked deterministically from its lattice
  // cell (#N neighbours get #N±6%, never a colour that could be mistaken for paint).
  blockToneSteps: Object.freeze([0.97, 0.985, 1, 1.01, 1.02, 1.03]),
  blockGrainRepeat: 1,
  woodRoughness: 0.48,
  woodClearcoat: 0.45,
  woodClearcoatRoughness: 0.18,
  woodNormalScale: 1,
  woodEnvMapIntensity: 0.65,
  woodCrownHeight: 0.012,
  paintNormalScale: 1,
  // v0.9.32 R1 round 2 (BLOCK_REFERENCE_REWORK_R0.md §9bis.4): 0.032 → 0.012.
  // The crown is an optical dome written into the cached normal map — geometry and pick
  // volume do not change. At 0.032 it distorted the reflections INSIDE a face hard enough
  // to split each face into a bright band and a darker band, which is the "两个内外层"
  // read the handoff §3 P1 objects to; the reference's faces are near-flat under one broad
  // gloss. Range to explore 0.008-0.016 — not all the way to 0, which would flatten the
  // face into unlit colour paper. Rebuilt on load: the cache must not be reused from an
  // older constant, or the edit will look like it did nothing.
  paintCrownHeight: 0.012,
  environmentIntensity: 0.55,
  // Polished agate-like colour on the board and in the hand, so a piece never
  // changes material as it moves from the tray, through the drag, onto the board.
  //
  // v0.9.32 R1 round 3 (BLOCK_REFERENCE_REWORK_R0.md §9bis.4): 0.12 -> 0.22, and the
  // clearcoat split widened. Round 2 flattened the FACE, but a face that is dead flat
  // still split into a bright left band and a darker right band while the surface was
  // this mirror-like: at roughness 0.12 with clearcoat 1 / 0.045 the environment's
  // reflection card and small glint land almost un-blurred, so one hard highlight owns
  // part of every face. The reference lights a face with ONE broad soft gloss.
  // "Polished agate" is the wrong words for an opaque toy, which is what this looks like.
  //
  // Note the effective roughness is this factor times the roughnessMap (the paint map
  // sits near 244/255), so the UI number is not the final roughness — do not read 0.22
  // as "matte". Metalness stays 0 and the toy environment binding must stay explicit
  // (Three r172 can override envMapIntensity when envMap is null).
  paintRoughness: 0.22,
  paintClearcoat: 0.85,
  paintClearcoatRoughness: 0.12,
  paintIor: 1.46,
  paintMetalness: 0,
  paintEnvMapIntensity: 0.85,
  paintSpecularIntensity: 1,
  surfaceAOIntensity: 0.35,
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
  // v0.9.14 (producer, 2026-09-28): 「感觉下方拖拽翻面的区域太小，经常和 Cancel 区域重合了，
  // 要不把备选区和 cancel 区域下挪一点，把方块上移一点。」
  //
  // The bottom turn dwell (v0.9.11/13) needs room BETWEEN the cube's bottom edge and the tray,
  // and the tray sits directly under the cube. Moving the tray down is CSS (reference.css);
  // moving the CUBE up cannot be, because the cube is centred in its canvas — growing
  // `.board-section` downward moves it DOWN instead and cancels the tray's gain exactly
  // (measured on 390×844: the band was 145px before a naive CSS-only attempt, 146px after).
  //
  // This is the lift, in CLIENT PIXELS, applied by gameScene's `liftCubeForTurnBand()`: pixels
  // because a pixel of lift is exactly a pixel of extra turn band, which is the thing being
  // bought. Portrait only, like `portraitCubeScale`. It is CLAMPED to the room actually
  // available above the cube (minus a clearance), so the framing guard never has to pull the
  // camera back to fit — a fixed world-unit offset did exactly that on a 360×640 phone and
  // shrank the cube by 24%, which is not a trade this game makes.
  cubeLiftPx: 96,
  cubeLiftClearancePx: 14,
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
  hemisphereIntensity: 0.85,
  keyColor: 0xfff5e6,
  keyIntensity: 2.25,
  keyPosition: Object.freeze([-3.5, 7, 9]),
  fillColor: 0xc9e3ff,
  fillIntensity: 0.65,
  fillPosition: Object.freeze([5, 2, -4]),
  rimColor: 0xffe6c4,
  rimIntensity: 0.6,
  rimPosition: Object.freeze([-4, 4, -5]),
  shadowExtent: 4.8,
  shadowBias: -0.00015,
  shadowNormalBias: 0.012,
  environmentWidth: 256,
  environmentHeight: 128,
  reflectionKeyIntensity: 8,
  reflectionKeyWidth: 0.48,
  reflectionKeyHeight: 0.24,
  // Fixed WORLD-space reflection cards. The tall card reaches below the horizon
  // so a front-facing block can reflect it; the sun alone only lights shoulders.
  reflectionCardPosition: Object.freeze([0.75, 0.12, 1]),
  reflectionCardWidth: 0.18,
  reflectionCardHeight: 0.85,
  reflectionCardIntensity: 2.6,
  reflectionGlintPosition: Object.freeze([-0.2, 0.65, 1]),
  reflectionGlintIntensity: 16,
  reflectionGlintFocus: 700,
  reflectionRimIntensity: 4,
  reflectionRimFocus: 32,
})

// Local URLs are relative to Vite's BASE_URL; null keeps the deterministic 256px
// procedural fallback. Normal maps are tangent-space OpenGL, AO uses red and
// roughness uses green. Only baseColor is sRGB. No assets are required to play.
export const BLOCK_TEXTURES = Object.freeze({
  wood: Object.freeze({ baseColor: null, roughness: null, normal: null, ao: null }),
  paint: Object.freeze({ baseColor: null, roughness: null, normal: null, ao: null }),
})

// Stylised volume response, all in the existing material pass. Set scatter /
// internalReflection / coreAbsorption to zero for the surface-only fallback.
//
// v0.9.32 R1 round 1 (docs/Technical/BLOCK_REFERENCE_REWORK_R0.md §9bis.4): the four
// volume terms are OFF, not merely smaller. The target reference is a fully OPAQUE toy
// block — one flat saturated face under a single broad soft gloss — so absorption,
// scattering, internal reflection and environment transmission describe something the
// reference does not have. The measured size of what they were contributing (R0 §5.2,
// tools/frame-diff.mjs) is why "turn them down" was rejected: switching them off moved
// 18% of the phone frame's pixels but 63% of those by only 2-8 levels — a low-amplitude
// wash over every face, which is haze, not form. `density` is kept because with all four
// coefficients at zero it has nothing to act on; the class, its clone/copy lifecycle and
// tools/gem-material-tests.mjs all stay, so this is reversible in one edit.
export const GEM_STYLE = Object.freeze({
  density: 2.1,
  scatter: 0,
  coreAbsorption: 0,
  internalReflection: 0,
  environmentTransmission: 0,
})

export const SHADOW_STYLE = Object.freeze({
  mapSize: 1024,
  lowPowerMapSize: 512,
  // The pedestal is DOM art: a transparent receiver overlays only its shadow.
  projectedOpacity: 0.18,
  contactOpacity: 0.3,
  // LEGACY radial decal (v0.9.x). Kept because route B is graded against it — same frame, same
  // pose, only the decal's shape differs — and because it is what a rollback restores.
  contactSize: 6.0,
  receiverSize: 6.3,
  floorOffset: 0.025,
  textureSize: 128,
  lowPowerSSAO: false, // baked surface AO + contact decal replace two scene passes

  // ---- Route B (v0.10.2): the contact decal is shaped like the board's own bottom footprint ----
  //
  // G1 measured the radial blob contributing nothing outside a thin ring at the cube's bottom
  // edge — its dark core sat behind the cube, so what reached the screen was a soft circular
  // smudge. Route B's exit condition (handoff §5) is 「接触影需更贴近底部轮廓，近处较实、外沿渐软，
  // 不能只放大一团圆形污影」, so the decal is now built from the footprint itself:
  //
  //   * shape   a rounded square of EXACTLY the blocks' half-extent (`footprintHalf`, passed in
  //             from the board's own lattice), rotated with the board's bearing so it stays under
  //             the blocks as the view is dialled.
  //   * near    the camera-near edge (the board's own +z face) falls off over `contactSkirtNear`
  //             — short and firm, which is the part a player actually sees below the front edge.
  //   * far     the far/outer side falls off over `contactSkirtFar` — long and soft, so the decal
  //             has a tail instead of an edge.
  //
  // This is still painted alpha on a plane, NOT surface occlusion: it is a visual approximation
  // and must not be described as a real table SSAO (route B's own wording).
  contactShape: 'footprint', // 'footprint' | 'radial' (diagnostic / rollback)
  footprintTextureSize: 256,
  contactColor: Object.freeze([70, 42, 23]),
  contactRoundness: 6, // superellipse exponent: 2 = ellipse, high = square. The blocks' own
  // rounded corners are what keep this from reading as a hard-edged plate.
  contactSkirtNear: 0.34, // world units of falloff on the camera-near edge
  contactSkirtFar: 1.05, // …and on the far/outer side
  contactNearWeight: 1,
  contactFarWeight: 0.6,
})

// G1 diagnostic prototype (docs/Technical/MATERIAL_GROUNDING_REWORK_HANDOFF.md §5 G1b).
//
// What this is: a DELIBERATELY PLAIN, low, round platform whose only job is to answer one
// question — does putting the support into the real geometry / normal / depth chain buy
// enough grounding to justify replacing the painted pedestal? It is not a final asset and
// it is not dressed: no foliage, no stone joints, no bevel profile, no texture. Route A is
// only allowed to be adopted if this prototype wins on real pixels, and the final surface
// (if any) is Luna's delivery (§8.2).
//
// Why a separate constant group instead of extending SHADOW_STYLE: those two quads are the
// PAINTED support (a radial contact decal and a ShadowMaterial receiver), which is exactly
// what the prototype is being compared against. They stay switchable and unchanged.
//
// Sizing is DERIVED, never typed in twice: the diameter comes from the swatch the DOM art
// already defines (gameScene's `fitPedestal()` decides how wide the pedestal is drawn — the
// prototype is fitted from that same projected silhouette), and the top surface sits on the
// resting cube's own bottom edge so nothing about the camera or the board has to move.
export const GROUNDING_STYLE = Object.freeze({
  // The shipped build keeps the painted pedestal until G1 rules; flipping this only changes
  // which support a page boots with (the probe sets it at runtime, per capture).
  platformEnabled: false,
  // Multiplier on the projected pedestal width the art fit already produces. 1 = the
  // prototype is exactly as wide on screen as `pedestal.webp` is drawn.
  platformWidthFactor: 1,
  // World-space height of the slab. Low on purpose: the art's stone is a shallow ledge, and
  // a tall drum would read as a new prop rather than a support.
  platformHeight: 0.55,
  // The top surface relative to the resting cube's own bottom edge (0 = flush under it).
  platformTopInset: 0,
  platformSegments: 72,
  // 浅奶油石材, the tone the painted ledge is painted in — so the comparison grades the
  // LIGHTING AND CONTACT, not a new colour.
  platformColor: 0xf1e3d0,
  platformRoughness: 0.9,
  platformClearcoat: 0.04,
})

// Opening layout (v0.2.31) — MEASUREMENT ONLY since v0.9.10. The shipped game no longer
// seeds it: resetGame() clears to a bare shell so a run starts with all six faces at zero,
// and the first move is always the player's. It stays because the offline difficulty tools
// (and the frozen baselines they produced) model a PRESEEDED opening with exactly these
// numbers; nothing in src/ reads it any more.
//
// What it described: the cube started with a few blocks on the faces the 3/4 camera can
// already see, drawn from the SAME pool the candidate slots use — same shapes, same colors —
// so the first frame read as a board in play instead of an empty cage. The hard rules live in
// Board.seedOpening(): blocks never overlap, and a seed NEVER completes a line on any face.
// `place()` only settles the face being played, so a line seeded on some other face would sit
// there full and unbreakable until the player happened to play that face.
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

// ============================================================
// Item interaction v1 (07-道具系统设计.md §8, 2026-09-29)
// ============================================================
// The redesign splits ONE rule across two gestures that must never fight: a gesture that
// starts on an item icon may become a DRAG (release on the board uses the tool) and a
// gesture that starts on the canvas while a tool is selected only ever AIMS (release fixes
// the preview; committing is the explicit 使用 button). Everything below is the arbitration
// between them, plus the aiming offset a thumb needs.
//
// The numbers are the doc's own starting values; §8.4 calls them "建议起始值、需真机调优",
// so they live here rather than being sprinkled through the input module.
export const ITEM_STYLE = Object.freeze({
  // 8.4: accumulated travel from the ICON that locks the gesture as a drag. Once locked it
  // never falls back to a tap, even if the pointer returns to where it started — otherwise a
  // wobbling thumb would turn a deliberate drag into a "select" and the visible ghost would
  // contradict the release rule.
  dragSlopMousePx: 6,
  dragSlopTouchPx: 10,
  // 8.5.2: the aiming point a thumb needs. On touch the carried target is lifted ABOVE the
  // contact point so the finger does not cover the cell it is about to clear; the preview and
  // the commit both read this same point (a preview that lifted while the commit did not is
  // the one bug the doc names outright: 「不得预览抬升而落点仍按指腹」).
  touchAimLiftPx: 48,
  // 8.9: the cooldown after a committed use, unchanged from the shipped 420ms — it exists so
  // a double-tap cannot spend two charges on one clear.
  busyMs: 420,
  // 8.3: the smallest hit target for every item-mode button (使用 / × 取消 / 横纵). 44 is the
  // doc's floor, 48 the recommendation; the CSS uses this as its `--item-hit` default.
  hitPx: 44,
  // 8.5.1: how far outside the front face's own grid (in cells) a pointer may still resolve to
  // an edge cell before the target is dropped entirely. 0 = 「棱线归当前正面边界」: a pointer
  // outside the grid is not a target, it is 移到正面棋格.
  faceSlackCells: 0,
})

// Launcher-style page turning while carrying a piece. A new full dwell starts
// after each animation, so holding at an edge can deliberately browse more faces.
//
// v0.9.11 — the ruler is the CUBE, not the screen. `armPx` is measured from the cube's screen
// silhouette (`cubeScreenBounds()`), and the point that is measured is the CARRIED PIECE's own
// bounding-box centre, so the condition reads "the block is more than half off the cube"
// (producer, 2026-09-28). `armPx: 0` is deliberate — the moment the centre is past the
// silhouette edge the dwell arms; the producer asked for no extra margin. Raise it to require a
// further `armPx` px of overhang before the dwell starts. There is no inward hysteresis to tune
// either: the side is re-chosen every frame, so carrying the piece back over the cube re-attaches
// it immediately (see `cubeEdge()` in input/edgeTurn.js).
export const PIECE_SPIN = Object.freeze({
  armPx: 0,
  holdMs: 650,
})

// v0.3 feedback ladder (08-荣誉与排行榜系统.md §6, aligned with 03 §7).
// honors.js decides the LEVEL of a placement (that is a rule: it decides whether a
// banner is owed); the seconds and the banner size behind each level are visual
// numbers and live here. Index = level, 0 = a placement that cleared nothing.
// The gradient is the point: 一段日常有反馈、稀有才隆重 — L3 runs about twice a game,
// L4 about once every three games, L5 about once every fifty (08 §6), so the top of
// the ladder must never become the background hum.
//
// v0.10.1 (CLEAR_CELEBRATION_AUDIO_HANDOFF.md §3): the ladder no longer carries a
// particle MULTIPLIER. The old `particleScale` multiplied every cleared line's own
// burst, so four lines bought four times the particles AND the top of the ladder
// bought five times that again — the budget is now allocated per EVENT (CELEBRATION
// below, one entry per level, shared cells deduped) and a line can never multiply it.
// `shake` is gone for the same reason the doc gives a target of 0: the celebration is
// paper in a garden, not a detonation.
export const FEEDBACK_STYLE = Object.freeze({
  levels: Object.freeze([
    /* 0 nothing cleared */ Object.freeze({ duration: 0, banner: 'none' }),
    /* 1 one line */ Object.freeze({ duration: 0.42, banner: 'none' }),
    /* 2 two lines */ Object.freeze({ duration: 0.55, banner: 'none' }),
    /* 3 TRIPLE */ Object.freeze({ duration: 0.8, banner: 'name' }),
    /* 4 QUAD / TRIFACE */ Object.freeze({ duration: 1.1, banner: 'large' }),
    // L5 gets the only "顿帧" in the game: a brief slowdown for the ceremony, which
    // must never block input and must leave the board readable (03 §7 hard rule).
    /* 5 PENTA+ */ Object.freeze({ duration: 1.4, banner: 'full', slowMo: Object.freeze({ scale: 0.6, ms: 400 }) }),
  ]),
  shakeDecay: 0.42, // per-second falloff of the camera shake
  honorBannerMs: Object.freeze({ small: 700, name: 900, large: 1400, full: 2200 }),
})

// ============================================================
// Clear celebration (docs/Technical/CLEAR_CELEBRATION_AUDIO_HANDOFF.md §2.2/§3/§8)
// ============================================================
// One placement is ONE event with ONE budget. The numbers below are the doc's own
// starting values: the standard column is its 「飞行纸彩上限」, the lowPower column its
// low-spec row, and reduced-motion is a THIRD, independent axis that is queried from the
// media query rather than stored here (closing motion must not close sound or haptics —
// §6.3 「不得把三项偏好绑成一个开关」).
//
// Paper is NOT additive light. The old clear sprayed additive-blended white sprites that
// read as sparks; these are opaque-ish rounded cards in the three paper tones the doc
// names, with cream and honey gold reserved for the few highlight marks. Strong
// saturation stays with the real playing blocks — the celebration must never out-shout
// the thing that was just cleared.
export const CELEBRATION = Object.freeze({
  colors: Object.freeze({
    cream: 0xfff1d4, // 奶油纸: short confirmation, sparkles, seal plate
    gold: 0xe7b75f, // 蜜蜡金: the seal and a few highlights — not metal, not a block colour
    rose: 0xc98699, // 玫瑰纸
    sky: 0x8dbdd3, // 晴空纸
    sage: 0xa5bba1, // 鼠尾草纸
    ink: 0x452e13, // 树皮墨
  }),
  // One event picks three paper tones at most (cream rides on top of them), so a clear
  // reads as a designed handful rather than as every colour at once.
  paperTones: Object.freeze([0xc98699, 0x8dbdd3, 0xa5bba1]),

  // Rounded card, two ratios, at most two light flips (§2.2). Short side in cells —
  // 0.06–0.12 lattice units, i.e. ~3–7 CSS px on a phone. Below that the chip is dropped
  // rather than rendered as a sub-pixel speck. The flip is BAKED into the chip geometry, one
  // static tilt per paper tone (rendering/effects.js explains why it cannot be a behavior).
  chip: Object.freeze({
    shortSide: 0.085,
    ratios: Object.freeze([2, 1.5]),
    radiusRatio: 0.22,
  }),
  // §2.2: a four-point sparkle closes a move (6–12 CSS px apparent, one flash), the
  // five-point seal is the honour mark at 18–28 CSS px in play and 32–48 on the record
  // card. The seal does NOT keep growing with the line count.
  sparkle: Object.freeze({ size: 0.16, duration: 0.42 }),
  seal: Object.freeze({ size: 0.42, duration: 0.72, recordSize: 0.72 }),
  // §2.2: L4/L5 only, at most two per event, ≤1 band wide, at most two bends.
  ribbon: Object.freeze({ max: 2, length: 0.78, width: 0.11, bends: 2, duration: 1.05 }),

  // §3 飞行纸彩上限 — the whole event, shared cells counted once and multi-line events
  // never multiplying again. `record` is the new-record card's own budget (§4.4).
  budgets: Object.freeze({
    standard: Object.freeze({ 0: 0, 1: 6, 2: 12, 3: 24, 4: 40, 5: 64, record: 72 }),
    lowPower: Object.freeze({ 0: 0, 1: 3, 2: 6, 3: 12, 4: 20, 5: 28, record: 28 }),
  }),
  // §8: other decoration objects (seals, sparkles, ribbons) and the whole-screen flying
  // ceiling, which is what the budget is checked against when events overlap.
  decorationCap: Object.freeze({ standard: 8, lowPower: 4 }),
  flyingCap: Object.freeze({ standard: 96, lowPower: 40 }),
  // §8: side emission (the L4/L5 two-sided fan) cools down instead of firing every clear.
  // It only ever drops DECORATION: the line band, the real score and the main sound of the
  // current event are never withheld.
  sideCooldownMs: 1200,

  // §3 最长装饰尾段（墙钟）, by level; index 6 is the new-record card. The tail is the
  // longest a decoration may stay on screen, and it is measured on the WALL clock — the
  // L5 slow-motion dip scales the animation clock, and a 1.4s tail stretched by 0.6×
  // would be exactly the bug §7.3 names.
  tailSeconds: Object.freeze([0, 0.42, 0.55, 0.8, 1.1, 1.4, 1.6]),

  // §4.1/§4.2 wall-clock beats. `confirmMs` is the landing's own short acknowledgement,
  // `bandStart`/`bandEnd` the line band, `paperStart`/`paperEnd` the chips, `celebrateAt`
  // the moment L3+ composition enters and `bannerAt` the honour plate.
  timing: Object.freeze({
    confirmMs: 50,
    bandStart: 0.05,
    bandEnd: 0.14,
    bandStagger: 0.035, // §4.1 「多线同期、最多错峰 35ms」
    paperStart: 0.1,
    paperEnd: 0.24,
    celebrateAt: 0.12,
    bannerAt: 0.16,
    tailFrom: 0.3,
  }),

  // §2.2: the line band is derived from the real cleared segment, sticks out by 0.03 cell
  // at each end, is 0.025–0.045 cell thick and peaks at 0.28–0.40 opacity in ONE pulse.
  band: Object.freeze({
    overshoot: 0.03,
    thickness: 0.035,
    opacity: 0.34,
    duration: 0.5,
    /** merged co-linear bands are limited to this, §7.2 「空间重叠亮带应合并／限亮」 */
    mergeDistance: 0.02,
  }),

  // §4.2 「手机没安全留白：自动降为 HUD 小星章＋短亮边，不缩小棋盘为礼花腾位置」. A short or narrow
  // viewport (landscape phone, small handset) has nowhere for the fan to go, so the flying budget
  // is halved and the side ribbons are dropped — the board is NEVER scaled down to make room, and
  // the line band, the real score and the main sound are never withheld either.
  cramped: Object.freeze({ maxHeight: 620, maxWidth: 360, budgetFactor: 0.5 }),
  // §3 相机震动 = 0. Kept as a named number instead of a hard-coded zero so the one
  // place that could ever raise it is greppable.
  shake: 0,
})

// ============================================================
// Audio bus (handoff §5/§6) — the numbers, not the cues
// ============================================================
// §5.3: the first version SYNTHESIZES the cues at runtime from the offline recipes
// (docs/Technical/assets/clear-celebration/build-audio-previews.mjs) and caches the
// rendered AudioBuffers; the WAVs in the handoff package are listening references and
// are deliberately not copied into `public/` (they would be first-packet weight for
// nothing). These are the mix and concurrency numbers §6.2 asks for.
export const AUDIO_STYLE = Object.freeze({
  master: 0.7,
  // §6.2: source → category → master → soft safety compressor → out. The compressor is
  // insurance against a pile-up, never a substitute for sane levels.
  categories: Object.freeze({ clear: 1, item: 0.95, ui: 0.72, result: 1, test: 0.8 }),
  duckDb: -12, // §6.1: the counting click is pushed this far down under a main cue
  duckAttack: 0.02,
  duckRelease: 0.35,
  voiceLimit: 12, // §6.2 音符／噪声声源总数 同时≤12
  voiceLimitLowPower: 8,
  mainCueFadeMs: 25, // §6.2 新事件替换旧尾句，15～30ms 淡出
  muteFadeMs: 20, // §6.3 master 在≤20ms 内淡到 0
  // §6.1: the roll's counting click. The NUMBER keeps its own rhythm (ui/hud.js SCORE_ROLL
  // reads these two), but the sound request is rate-limited and capped per roll — the visual
  // roll and the total are never affected by either.
  tickMinIntervalMs: 70,
  tickMaxPerRoll: 8,
  edgeHintMinIntervalMs: 150, // §6.2 边缘无效提示
  compressor: Object.freeze({ threshold: -18, knee: 12, ratio: 3, attack: 0.004, release: 0.18 }),
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
  // DEV-only tier override (MATERIAL_GROUNDING_REWORK_HANDOFF §9.2: 「至少同设备强制高/低档对照」).
  // The tier is otherwise decided by the viewport and the core count, which a screenshot run
  // cannot vary on one machine. `import.meta.env.DEV` is replaced by `false` in the production
  // bundle, so the whole branch — and the read of the global — is stripped from what ships.
  const forced = import.meta.env.DEV ? globalThis.__voxalblastQuality : null
  const lowPower = forced === 'low' || forced === 'high'
    ? forced === 'low'
    : window.matchMedia?.('(max-width: 700px)').matches || (navigator.hardwareConcurrency || 8) <= 4
  return Object.freeze({
    lowPower,
    pixelRatioMax: lowPower ? 1.35 : 2,
    multisampling: lowPower ? 0 : 4,
    particlesPerLine: lowPower ? 7 : 14,
    bloomIntensity: lowPower ? VFX_CONFIG.bloom.lowPowerIntensity : VFX_CONFIG.bloom.intensity,
  })
}

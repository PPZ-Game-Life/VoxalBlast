// The main scene: scene graph root, camera, renderer, the post-processing chain, the
// framing solver and the resize path.
//
// Refactor P2b (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §2 `gameScene.js`). What this
// module owns: the canvas, scene/camera/composer, the quality tier, how much of the canvas
// the cube fills, the camera zoom/zoom-by-wheel state, and the ResizeObserver that keeps all
// of it in step with the layout. What it does NOT own: any game rule, the hand, or a second
// copy of the 98 tiles — the board's group and its extents arrive from outside.
//
// Two deliberate interface choices:
//
//  * `getCubeGroup` / `metrics` are LAZY getters, not values. `cubeGroup` is built after the
//    camera but the framing solver needs it, and `half`/`cs`/`BLOCK_HALF` are derived from
//    the board's lattice size. Passing getters lets main construct this module at the point
//    that reads best while the values still come from ONE source — main's board constants.
//    The alternative (a copy of the lattice arithmetic here) is exactly what the plan's
//    module contract forbids.
//  * `cameraZoom` / `orbitDistance` are private, read through `getCameraZoom()` /
//    `getOrbitDistance()` and changed through `zoomBy()`. The plan's state table puts them
//    here so the wheel handler and the shake code cannot each keep their own copy.
import * as THREE from 'three'
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  NormalPass,
  SSAOEffect,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing'
import { skipComposerDepthBlit } from './threeCompat.js'
import { BOARD_STYLE as style, GROUNDING_STYLE, LIGHTING_STYLE, ROTATE_STYLE, SHADOW_STYLE, VFX_CONFIG } from './config.js'
import { createBoardShadows } from './boardShadows.js'

// `quality` arrives from the caller rather than being read here, so the tier is still
// resolved at exactly the point in main's evaluation it always was.
export function createGameScene({ sceneWrap, quality, getCubeGroup, metrics, onResize }) {
  const scene = new THREE.Scene()
  scene.background = null
  // The opaque wooden shell supplies depth; the landscape behind the canvas is DOM, not a
  // skybox, and is independent of the scene's reflection environment.
  // v0.8.10: `far` had to grow with the weak-perspective camera. The distance solver now
  // puts the eye ~65 world units out (FOV 6° instead of 30°), and the wheel can push
  // `cameraZoom` to 1.7 — 110 units, past the old 100 plane, which would have clipped the
  // cube away as the player zoomed out. `near` moves with it so the depth range stays sane
  // for the contact-shadow pass.
  const camera = new THREE.PerspectiveCamera(style.cameraFov, 1, 1, 500)
  camera.layers.enable(1)
  const cameraTarget = new THREE.Vector3(0, 0, 0)
  let cameraZoom = 1
  const minCameraZoom = 0.7
  const maxCameraZoom = 1.7

  // ---- Framing ------------------------------------------------------------------
  // The tuned framing sits close to the edge (the cube IS the operation area), and how much
  // of the canvas a given `safeFactor` buys depends on the viewport aspect.
  const CAMERA_DIR = new THREE.Vector3(...style.cameraDirection).normalize()
  const frameCorner = new THREE.Vector3()
  const frameRight = new THREE.Vector3()
  const frameUp = new THREE.Vector3()
  let orbitDistance = 12
  const pedestal = sceneWrap.parentElement.querySelector('.garden-pedestal')
  const stagePoint = new THREE.Vector3()
  const stageUp = new THREE.Vector3(0, 1, 0)
  let stageProjectionKey = ''
  // The last fitted stage footprint (canvas-local pixels). Kept so the G1 prototype can be
  // fitted from the same numbers the DOM art was fitted from, and re-fitted when the route
  // is switched on after a resize that predates it.
  let lastStage = null

  // Anchor scenery to the resting cube footprint, not its rotating/scaling intro
  // mesh. It follows resize and wheel zoom without wobbling during a face turn.
  function fitPedestal() {
    // v0.13.0: the shipped route has no support, so there is nothing to fit and no projection
    // to measure. Gating here (rather than leaving the fit running against a hidden element)
    // is what the handoff §5.2 means by "在新皮肤显式停用" — a hidden element that is still
    // being measured is a route that only LOOKS retired.
    if (!pedestal || groundingRoute === 'none') return
    const width = sceneWrap.clientWidth, height = sceneWrap.clientHeight
    const key = [width, height, sceneWrap.offsetLeft, sceneWrap.offsetTop,
      camera.position.x, camera.position.y, camera.position.z,
      cameraTarget.x, cameraTarget.y, camera.fov].join(':')
    if (key === stageProjectionKey) return
    stageProjectionKey = key
    camera.updateMatrixWorld(true)
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity
    const extent = cubeSolidExtent()
    for (const x of [-extent, extent]) for (const y of [-extent, extent]) for (const z of [-extent, extent]) {
      stagePoint.set(x, y, z).applyAxisAngle(stageUp, ROTATE_STYLE.bearingYaw).project(camera)
      const px = (stagePoint.x + 1) * width / 2
      minX = Math.min(minX, px)
      maxX = Math.max(maxX, px)
      maxY = Math.max(maxY, (1 - stagePoint.y) * height / 2)
    }
    const stageWidth = Math.min((maxX - minX) * 1.24, width * 1.03)
    pedestal.style.width = `${stageWidth}px`
    pedestal.style.left = `${sceneWrap.offsetLeft + (minX + maxX) / 2}px`
    pedestal.style.top = `${sceneWrap.offsetTop + maxY - stageWidth * 0.20}px`
    lastStage = { stageWidth, centreX: (minX + maxX) / 2, canvasWidth: width, bottomY: maxY }
    fitPlatform(lastStage)
  }

  // Fit bound covers the shell plus the one tile inset that stands proud of it.
  const cubeExtent = () => metrics().half + 0.55
  // CUBE_SOLID_EXTENT is the visible body: the outermost blocks' faces. Nothing can stick
  // out further, because nothing does.
  const cubeSolidExtent = () => {
    const { half, cs, blockHalf } = metrics()
    return half - cs / 2 + blockHalf + style.previewLift
  }

  function distanceForViewDirection(direction) {
    camera.position.copy(direction)
    camera.lookAt(cameraTarget)
    camera.updateMatrixWorld(true)
    const right = frameRight.setFromMatrixColumn(camera.matrixWorld, 0)
    const up = frameUp.setFromMatrixColumn(camera.matrixWorld, 1)
    const verticalTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    const horizontalTan = verticalTan * camera.aspect
    const isMobile = sceneWrap.clientWidth < 700
    const safeFactor = isMobile ? style.safeFactorMobile : style.safeFactorDesktop
    const extent = cubeExtent()
    const min = -extent
    const max = extent
    let distance = 0
    for (const x of [min, max]) for (const y of [min, max]) for (const z of [min, max]) {
      const corner = frameCorner.set(x, y, z)
      const depthOffset = corner.dot(direction)
      distance = Math.max(
        distance,
        depthOffset + Math.abs(corner.dot(right)) / (horizontalTan * safeFactor),
        depthOffset + Math.abs(corner.dot(up)) / (verticalTan * safeFactor),
      )
    }
    return distance
  }

  function refreshCameraProjection() {
    const isMobile = sceneWrap.clientWidth < 700
    camera.fov = isMobile ? style.cameraFovMobile : style.cameraFov
    camera.aspect = Math.max(sceneWrap.clientWidth / Math.max(sceneWrap.clientHeight, 1), 0.5)
    camera.updateProjectionMatrix()
    // Re-centre the cube inside the tall central canvas per platform.
    cameraTarget.y = isMobile ? style.targetYMobile : style.targetYDesktop
    cameraTarget.x = 0
    orbitDistance = distanceForViewDirection(CAMERA_DIR)
    // v0.9.1: the portrait shrink, applied where the resting size is decided.
    orbitDistance /= portraitScale()
    keepCubeInsideCanvas()
    liftCubeForTurnBand()
    centreCubeHorizontally()
  }

  // v0.9.14 — LIFT THE CUBE, IN PIXELS, TO WIDEN THE BOTTOM TURN BAND.
  //
  // The bottom turn dwell (v0.9.11/13) fires when the carried piece's centre leaves the cube's
  // silhouette, and the tray sits directly under the cube — so the room between them IS the
  // gesture's whole travel (producer, 2026-09-28: 「感觉下方拖拽翻面的区域太小，经常和 Cancel
  // 区域重合了……把方块上移一点」).
  //
  // Why pixels and not `targetYMobile`: a world-unit offset is a fixed fraction of the CUBE, so
  // it grows with the cube — and on a short phone it walks the cube into the tool row, at which
  // point `keepCubeInsideCanvas()` (which runs before this) has already pulled the camera back
  // and the cube comes out 24% smaller. A pixel lift is exactly the number of pixels of turn band
  // being bought, and it is CLAMPED to the room that actually exists above the cube, so the
  // framing guard never has to fight it.
  //
  // Portrait and desktop both take the lift; the CLAMP is what makes that safe. On a phone there
  // is room above the cube (96px of the 96 asked for on a 390×844), on a desktop the cube is
  // vertically saturated and the clamp hands back whatever is left (~42px on a 1440×900) rather
  // than shrinking the cube to buy more. The desktop band is 118px and a MOUSE carry only lifts
  // the measured centre 10px, so it does not need the phone's headroom.
  function liftCubeForTurnBand() {
    if (style.cubeLiftPx <= 0) return
    const rect = getGameplayRect()
    const bounds = cubeScreenBounds()
    const roomAbove = bounds.minY - rect.top - style.cubeLiftClearancePx
    const lift = Math.max(0, Math.min(style.cubeLiftPx, roomAbove))
    if (lift < 1) return
    // Client pixels -> world units on the plane the cube lives on, taken from the real projection
    // (never a hand-rolled tan(fov/2): that is the same disagreement v0.4.5 fixed for the ghost).
    camera.updateMatrixWorld(true)
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * orbitDistance) / Math.max(rect.height, 1)
    cameraTarget.y -= lift * worldPerPx
    fitCameraToPlaySpace()
  }

  // v0.9.1: the portrait shrink — the cube is drawn 10% smaller when the WINDOW is portrait
  // (producer's call, 2026-09-24). Landscape and desktop are untouched, so the desktop framing
  // gate in `npm run probe:framing` (main face 88–92%) is unaffected. `style.portraitCubeScale`
  // is the value; this is the only reader of the orientation query, and it uses the same one the
  // backdrop trusts for its portrait art.
  function portraitScale() {
    if (style.portraitCubeScale === 1) return 1
    return window.matchMedia('(orientation: portrait)').matches ? style.portraitCubeScale : 1
  }

  function fitCameraToPlaySpace() {
    camera.position.copy(CAMERA_DIR).multiplyScalar(orbitDistance * cameraZoom)
    camera.lookAt(cameraTarget)
    fitPedestal()
  }

  // The tuned framing sits close to the edge, and how much of the canvas a given
  // `safeFactor` buys depends on the viewport aspect. This guard keeps that promise
  // device-independent: if the visible cube would leave the canvas, the camera is nudged
  // back until `inset` px of slack remain on every side.
  function keepCubeInsideCanvas(inset = 6) {
    // `refreshCameraProjection()` runs before the camera is placed, so put it at the freshly
    // solved distance first — measuring from a stale/inside-the-cube camera would project
    // nonsense and run the correction away.
    fitCameraToPlaySpace()
    for (let i = 0; i < 6; i += 1) {
      const bounds = cubeScreenBounds()
      const rect = getGameplayRect()
      const overflow = Math.max(
        rect.left + inset - bounds.minX,
        bounds.maxX - (rect.right - inset),
        rect.top + inset - bounds.minY,
        bounds.maxY - (rect.bottom - inset),
      )
      if (overflow <= 0) return
      orbitDistance *= 1 + overflow / Math.max(rect.height, 1)
      fitCameraToPlaySpace()
    }
  }

  // The 3/4 view puts the cube's silhouette a few percent off the canvas centre (further off
  // on narrow canvases), which made the two "swipe outside the cube" roll bands lopsided
  // (28px vs 50px on mobile). Aim the camera so both bands end up equal: measure the
  // silhouette's horizontal offset and shift the look-at point by the equivalent world
  // distance, then re-measure.
  function centreCubeHorizontally() {
    const rect = getGameplayRect()
    const centreX = rect.left + rect.width * 0.5
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * orbitDistance) / Math.max(rect.height, 1)
    for (let i = 0; i < 3; i += 1) {
      const bounds = cubeScreenBounds()
      const offset = (bounds.minX + bounds.maxX) * 0.5 - centreX
      if (Math.abs(offset) < 1) return
      cameraTarget.x += offset * worldPerPx
      fitCameraToPlaySpace()
    }
  }

  // Screen-space box of the cube (client pixels). v0.2.25 uses it to split the vertical swipe
  // by region: a finger that lands inside the cube's horizontal span pitches it (screen X),
  // one that lands outside it rolls it (screen Z).
  const cubeBoundsProbe = new THREE.Vector3()
  function projectCubeBounds(extent) {
    camera.updateMatrixWorld()
    const cubeGroup = getCubeGroup()
    const rect = getGameplayRect()
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      cubeBoundsProbe.set(sx * extent, sy * extent, sz * extent)
        .applyMatrix4(cubeGroup.matrixWorld)
        .project(camera)
      const x = rect.left + (cubeBoundsProbe.x + 1) * 0.5 * rect.width
      const y = rect.top + (1 - cubeBoundsProbe.y) * 0.5 * rect.height
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    return { minX, maxX, minY, maxY }
  }
  function cubeScreenBounds() {
    return projectCubeBounds(cubeSolidExtent())
  }

  // Gesture partition: vertical swipes inside the cube's x-span turn it about the screen X
  // axis, vertical swipes outside that span spin it about the screen Z axis (an in-plane
  // roll). Which band the finger landed in is sampled once, where it goes down (screenBand,
  // rendering/swipe.js), and it decides the roll's sign as well as its axis (v0.8.1 — the two
  // bands shared one sign before, which left the left band turning against the finger).
  //
  // Drag -> angle ruler: the cube's own silhouette on screen, sampled once where the gesture
  // claims its axis (the axis rules themselves live in rendering/swipe.js). A canvas-relative
  // ruler made the same face step cost 185px of horizontal drag on a 1120px-wide desktop
  // canvas but 65px on a phone, which is why "sometimes it won't turn" showed up on PC and
  // not on mobile. The floor only guards a degenerate projection.
  function gestureSpan() {
    const bounds = cubeScreenBounds()
    return {
      x: Math.max(bounds.maxX - bounds.minX, 120),
      y: Math.max(bounds.maxY - bounds.minY, 120),
    }
  }

  // ---- Renderer / post ----------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioMax))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // Composer renders linear HDR offscreen; tone-map exactly once in the final pass.
  renderer.toneMapping = THREE.NoToneMapping
  renderer.toneMappingExposure = style.exposure
  renderer.setClearColor(0x000000, 0)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // Per-FRAME counters, not per-render()-call ones: the post chain issues several render calls
  // per frame, and the default auto-reset would leave `info.render` holding only the last pass's
  // numbers (measured: 1 call / 1 triangle, which is the composer's final quad). main's frame
  // loop zeroes them at the frame boundary instead.
  renderer.info.autoReset = false
  // v0.13.0 R5 (handoff §9.4): the canvas is mounted on `#app`, NOT inside `#scene-wrap`.
  //
  // The home cover hides the game by putting `visibility: hidden` on `.topbar` and
  // `.game-layout` — that is exactly the input isolation the gate checks, and `visibility`
  // INHERITS. While the canvas lived inside `.game-layout` it was hidden together with the board,
  // so the world could not be drawn behind the cover no matter what the frame loop did. Moving
  // the canvas out of that subtree is what makes 「主页继续环境而不继续玩法逻辑」 possible at all;
  // the board is hidden by its OWN switch (`cubeGroup.visible`), not by the ancestor.
  renderer.domElement.id = 'world-canvas'
  const canvasHost = document.getElementById('app') ?? sceneWrap.parentElement ?? document.body
  canvasHost.appendChild(renderer.domElement)

  // ---- The gameplay rect, the full-viewport canvas and the render camera (handoff §9.2) ----
  //
  // R3 splits one box into two, which is the whole point of the stage:
  //
  //   * the CANVAS is now the whole viewport, fixed behind the UI and `pointer-events:none`.
  //     That is what makes room for scenery that lives OUTSIDE the play area (R4/R5) without
  //     opening a fifth WebGL context — and it is why the canvas can no longer be the thing
  //     that is measured.
  //   * `#scene-wrap` keeps its box and stays the only thing that is HIT-TESTED. The camera
  //     that framing, projection measurement, gestures and picking all speak through is
  //     `camera` — the canonical one — and it is still solved against the wrap, unchanged:
  //     FOV 6/7, `cameraDirection`, `safeFactor*` and the flip distances are NOT touched.
  //
  // The two are reconciled by `renderCamera`: it copies the canonical camera wholesale and
  // then REPLACES its projection matrix with the canonical one embedded into the full frame.
  // Nothing may call `updateProjectionMatrix()` on it afterwards — that would overwrite the
  // embedding with a plain full-screen projection, which is the exact failure this round is
  // written to avoid.
  //
  // The embed is in CSS-pixel ratios, never device pixels: DPR belongs to the renderer's
  // drawing buffer and to the composer's render targets, not to a projection matrix.
  const canvasCss = { width: 1, height: 1 }
  const embedMatrix = new THREE.Matrix4()
  const renderCamera = new THREE.PerspectiveCamera(style.cameraFov, 1, 1, 500)

  // The ONE definition of "where the board lives on screen". Every measurement that used to
  // read `getGameplayRect()` reads this instead — the canvas is the
  // whole viewport now, so the old reading would silently answer a different question.
  function getGameplayRect() {
    const rect = sceneWrap.getBoundingClientRect()
    return {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      right: rect.right, bottom: rect.bottom,
    }
  }

  // Called once per frame, after the canonical camera has been placed and before anything is
  // drawn. It is cheap (two matrix multiplies) and it has to be re-run because the canonical
  // camera moves on nearly every frame — a gesture, the zoom wheel, the turn-band lift.
  function updateRenderCamera() {
    renderCamera.copy(camera)
    // `copy()` brings the canonical layer mask with it. The render pass needs 0 (the board and
    // the board's own effects), 1 (the shadow-only receivers, kept out of the normal prepass)
    // and 2 (scenery, the floating world). NormalPass narrows this mask for its own draw and
    // puts it back; a mask that is never re-asserted here would be permanently narrowed by
    // whichever pass ran last.
    renderCamera.layers.set(0)
    renderCamera.layers.enable(1)
    renderCamera.layers.enable(2)
    // v0.13.0 R4: the canonical camera's OWN world matrix is refreshed here, not assumed.
    // `camera.position` / `camera.lookAt()` only touch `position` and `quaternion`; `matrixWorld`
    // is recomputed inside `renderer.render()`, which runs AFTER this — so copying it without
    // this line hands the render camera the PREVIOUS frame's pose, one frame behind whatever the
    // canonical camera was just moved to. Nothing visible depended on it until R4 measured a
    // ground ray through the render camera and got a point behind the eye.
    camera.updateMatrixWorld()
    renderCamera.matrixWorld.copy(camera.matrixWorld)
    renderCamera.matrixWorldInverse.copy(camera.matrixWorldInverse)
    const gameplay = getGameplayRect()
    const sx = gameplay.width / Math.max(canvasCss.width, 1)
    const sy = gameplay.height / Math.max(canvasCss.height, 1)
    const tx = 2 * (gameplay.left + gameplay.width / 2) / Math.max(canvasCss.width, 1) - 1
    const ty = 1 - 2 * (gameplay.top + gameplay.height / 2) / Math.max(canvasCss.height, 1)
    // Row-major, as Matrix4.set reads it: scale the canonical projection down to the gameplay
    // rect's share of the frame, then shift its centre to where that rect is.
    embedMatrix.set(
      sx, 0, 0, tx,
      0, sy, 0, ty,
      0, 0, 1, 0,
      0, 0, 0, 1,
    )
    renderCamera.projectionMatrix.multiplyMatrices(embedMatrix, camera.projectionMatrix)
    renderCamera.projectionMatrixInverse.copy(renderCamera.projectionMatrix).invert()
    return renderCamera
  }

  const composer = new EffectComposer(renderer, { multisampling: quality.multisampling, frameBufferType: THREE.HalfFloatType })
  const renderPass = new RenderPass(scene, renderCamera)
  const bloomEffect = new BloomEffect({
    intensity: quality.bloomIntensity,
    luminanceThreshold: VFX_CONFIG.bloom.luminanceThreshold,
    luminanceSmoothing: VFX_CONFIG.bloom.luminanceSmoothing,
    mipmapBlur: true,
    radius: VFX_CONFIG.bloom.radius,
    levels: quality.lowPower ? VFX_CONFIG.bloom.lowPowerLevels : VFX_CONFIG.bloom.levels,
  })
  const smaaEffect = new SMAAEffect({ preset: quality.lowPower ? SMAAPreset.LOW : SMAAPreset.HIGH })
  const toneMappingEffect = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL })
  const effectPass = new EffectPass(renderCamera, bloomEffect, toneMappingEffect, smaaEffect)
  // SMAA carries EffectAttribute.DEPTH, so this pass would otherwise ask the composer for a
  // depth texture it never reads. Cancel that request before addPass() sees it — the reason,
  // and the removal condition, are in threeCompat.js.
  skipComposerDepthBlit(effectPass)
  composer.addPass(renderPass)
  // Contact shadows follow the geometry as the player rotates. A dedicated normal target
  // owns real depth, avoiding the composer's aliased depth-texture blit.
  const normalPass = new NormalPass(scene, renderCamera)
  // The prepass draws WITHOUT the two layers the beauty pass keeps:
  //   layer 1 — shadow-only receivers (a ground plane must not occlude the board in the
  //             normal/depth buffer, which is what this exclusion has always been for);
  //   layer 2 — scenery (R4). Scenery is behind the board and must not be able to write into
  //             the buffer SSAO reads, or the whole far field becomes an occluder.
  // The mask is saved and restored around the draw, and `updateRenderCamera()` re-asserts the
  // full mask every frame — a narrowed mask that outlives one pass would blank the beauty pass.
  const renderNormals = normalPass.render.bind(normalPass)
  normalPass.render = (...args) => {
    const mask = renderCamera.layers.mask
    renderCamera.layers.disable(1)
    renderCamera.layers.disable(2)
    try { renderNormals(...args) } finally { renderCamera.layers.mask = mask }
  }
  const contactDepth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
  normalPass.renderTarget.depthTexture = contactDepth
  const occlusionEffect = new SSAOEffect(renderCamera, normalPass.texture, {
    ...VFX_CONFIG.occlusion,
    color: new THREE.Color(VFX_CONFIG.occlusion.color),
    samples: quality.lowPower ? 11 : VFX_CONFIG.occlusion.samples,
    resolutionScale: quality.lowPower ? 0.5 : VFX_CONFIG.occlusion.resolutionScale,
  })
  const occlusionPass = new EffectPass(renderCamera, occlusionEffect)
  occlusionPass.setDepthTexture(contactDepth)
  composer.addPass(normalPass)
  composer.addPass(occlusionPass)
  composer.addPass(effectPass)
  // One call instead of four camera reassignments: every pass that needs a main camera (and
  // every effect inside the two EffectPasses, SSAO's own projection uniform included) takes
  // `renderCamera`. Doing it by hand is how one of them keeps the canonical camera and grades
  // the frame with a projection nothing else used.
  composer.setMainCamera(renderCamera)
  // The TIER decides the shipped default; the G1 diagnostic can flip the two scene passes
  // afterwards so one machine can be graded with and without them (§9.2 「强制高/低档对照」).
  let useSSAO = !quality.lowPower || SHADOW_STYLE.lowPowerSSAO
  normalPass.enabled = occlusionPass.enabled = useSSAO
  // metrics() is lazy until main has assembled the board constants.
  let boardShadows = null
  function ensureBoardShadows() {
    if (boardShadows) return
    boardShadows = createBoardShadows(scene, { extent: cubeSolidExtent() - style.previewLift, floorY: SHADOW_STYLE.floorY })
    applyGroundingRoute()
  }

  // ---- G1 grounding prototype (docs/Technical/MATERIAL_GROUNDING_REWORK_HANDOFF.md §5) --
  //
  // Two routes, one at a time, so the question "does the support need to be 3D?" is answered
  // by a controlled comparison rather than by a look at the new thing on its own:
  //
  //   'art'      the shipped painted pedestal (`pedestal.webp`) plus its two quads.
  //   'platform' a PLAIN 3D slab, in the real geometry / normal / depth chain, with the DOM
  //              art hidden. The projected receiver is switched OFF in this route (its quad
  //              sits below the slab and would be buried), while the contact decal stays an
  //              independent switch — §5 G1b asks for its off state to be compared first.
  //
  // Nothing here moves the cube, the camera or the framing: the slab is fitted from the
  // silhouette the art fit already produced. This is a DIAGNOSTIC and a candidate, not the
  // §8.2 delivery: no bevel profile, no texture, no foliage.
  let groundingRoute = GROUNDING_STYLE.shippedRoute === 'platform' ? 'platform'
    : GROUNDING_STYLE.shippedRoute === 'art' ? 'art' : 'none'
  let contactDecalEnabled = true
  let projectedShadowEnabled = true
  let platform = null
  const platformMetrics = {}
  // Slack around the board's own footprint when the receiving quad is sized for the union of
  // "where the board is" and "where its shadow lands". World units.
  const GROUND_SHADOW_MARGIN = 1.2
  // handoff §10: the top tier pays for a real 1024 PCFSoft map; the tiers below it keep ALL of
  // the board's real normal lighting and swap the map for a procedural soft ellipse. The
  // project's existing quality selector is binary (`lowPower` from width/hardwareConcurrency),
  // so "not low power" IS the high tier here — the three-way split the handoff tabulates is
  // R7 work, and inventing a second selector now is exactly what §10 forbids.
  const realBoardShadow = !quality.lowPower

  function ensurePlatform() {
    if (platform) return platform
    platform = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, GROUNDING_STYLE.platformHeight, GROUNDING_STYLE.platformSegments, 1, false),
      new THREE.MeshPhysicalMaterial({
        color: GROUNDING_STYLE.platformColor,
        roughness: GROUNDING_STYLE.platformRoughness,
        clearcoat: GROUNDING_STYLE.platformClearcoat,
        clearcoatRoughness: 0.5,
        metalness: 0,
      }),
    )
    // It RECEIVES the key light: that is half of what the prototype is being tested for.
    // It casts nothing, and it is not a pick target (layer 0 keeps it inside the
    // normal/depth prepass, so SSAO can see it — the other half of the test).
    platform.receiveShadow = true
    platform.castShadow = false
    platform.raycast = () => {}
    platform.visible = false
    scene.add(platform)
    return platform
  }

  // Fitted from the SAME projected silhouette `fitPedestal()` measures, so the prototype
  // inherits the art's own on-screen width instead of a second, hand-typed size (§5 G1b:
  // 「按现有底座屏幕轮廓标定承托宽度」). The screen→world map is the turn-band lift's; its
  // horizontal and vertical factors are identical because camera.aspect is width/height.
  // The resting cube's own bottom edge — the outermost block faces. One place, because both
  // the slab's top surface and the interpenetration read-out are measured against it.
  function cubeBottomY() {
    const { half, cs, blockHalf } = metrics()
    return -(half - cs / 2 + blockHalf)
  }

  function fitPlatform(stage) {
    if (!platform || !stage) return
    const rect = getGameplayRect()
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * orbitDistance) / Math.max(rect.height, 1)
    const diameterPx = Math.min(stage.stageWidth * GROUNDING_STYLE.platformWidthFactor, stage.canvasWidth * 1.05)
    const radius = Math.max(0.4, (diameterPx * worldPerPx) / 2)
    // The top surface is anchored to the RESTING cube's own bottom edge (the outermost
    // blocks' faces), so the slab is a support the cube stands on and not a prop placed by
    // eye. `platformTopInset` is the one deliberate offset.
    const topY = cubeBottomY() + GROUNDING_STYLE.platformTopInset
    platform.scale.set(radius, 1, radius)
    platform.position.set((stage.centreX - stage.canvasWidth / 2) * worldPerPx, topY - GROUNDING_STYLE.platformHeight / 2, 0)
    Object.assign(platformMetrics, { radius, topY, diameterPx, centrePx: stage.centreX, worldPerPx })
  }

  // ---- The floating board's ground (v0.13.0, handoff §5.2) ------------------------------
  //
  // The shipped route has NO support: the board is separated from a FIXED world plane. Two
  // things have to be true for that to read as "floating" instead of as a bug:
  //
  //   * the plane is low enough that no pose of the cube can reach it. `SHADOW_STYLE.floorY`
  //     is that bound (config.js derives it from the cube's own bounding sphere); typing the
  //     resting face's −2.475 would put the ground through the cube on every 45° mid-snap.
  //   * the projection lands ON the plane, which means the receiving quad is where the key
  //     light THROWS the board, not centred under it. The light is far from vertical, so by
  //     the time it reaches this plane the shadow is several world units sideways of the
  //     thing casting it; a quad centred under the board would catch the board and miss its
  //     whole shadow. Both the offset and the quad's size come from the light, never typed.
  //
  // Neither value reads the cube's transform, and neither is recomputed per frame: the ground
  // does not move when the board bobs (that is the point).
  function groundShadowFootprint() {
    const floorY = SHADOW_STYLE.floorY
    const light = new THREE.Vector3(...LIGHTING_STYLE.keyPosition).normalize()
    const travel = -floorY / Math.max(light.y, 0.001)
    const shadowX = -light.x * travel
    const shadowZ = -light.z * travel
    const body = cubeSolidExtent()
    const reach = Math.hypot(shadowX, shadowZ)
    return {
      floorY, travel, body, reach,
      shadowCentreX: shadowX * 0.5,
      shadowCentreZ: shadowZ * 0.5,
      shadowSize: reach + body * 2 + GROUND_SHADOW_MARGIN,
      boardSize: body * 2 + GROUND_SHADOW_MARGIN,
    }
  }

  function fitGroundProjection() {
    if (!boardShadows) return
    const footprint = groundShadowFootprint()
    boardShadows.fit({
      boardX: 0, boardZ: 0, boardSize: footprint.boardSize,
      shadowX: footprint.shadowCentreX, shadowZ: footprint.shadowCentreZ, shadowSize: footprint.shadowSize,
      y: footprint.floorY,
    })
  }

  // The two pre-v0.13 routes laid the quads over a support at the support's own plane. Kept
  // verbatim (same sizes, same −extent−floorOffset height, same horizontal fit) so the G1
  // comparison can still be replayed; nothing in the shipped route calls this.
  function fitLegacySupportQuads(stage) {
    if (!boardShadows || !stage || groundingRoute === 'none') return
    const rect = getGameplayRect()
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * orbitDistance) / Math.max(rect.height, 1)
    const extent = cubeSolidExtent() - style.previewLift
    boardShadows.fit({
      boardX: (stage.centreX - stage.canvasWidth / 2) * worldPerPx, boardZ: 0, boardSize: SHADOW_STYLE.contactSize,
      shadowX: (stage.centreX - stage.canvasWidth / 2) * worldPerPx, shadowZ: 0, shadowSize: SHADOW_STYLE.legacyReceiverSize,
      y: -extent - SHADOW_STYLE.floorOffset,
    })
  }

  function applyGroundingRoute() {
    const onPlatform = groundingRoute === 'platform'
    const onArt = groundingRoute === 'art'
    if (onPlatform) { ensurePlatform(); fitPlatform(lastStage) }
    if (platform) platform.visible = onPlatform
    if (pedestal) {
      // v0.13.0: the shipped route has no support at all, so the DOM art is hidden by RULE and
      // not by whatever a previous route switch happened to leave in its inline style.
      pedestal.style.display = onArt ? '' : 'none'
      pedestal.style.visibility = onPlatform ? 'hidden' : ''
    }
    if (!boardShadows) return
    if (onPlatform) {
      boardShadows.setEnabled({ blob: contactDecalEnabled, projected: false })
      boardShadows.setPlaneY((platformMetrics.topY ?? 0) + 0.006)
      return
    }
    if (onArt) {
      boardShadows.setEnabled({ blob: contactDecalEnabled, projected: projectedShadowEnabled })
      fitLegacySupportQuads(lastStage)
      return
    }
    // The shipped route: fixed world plane, projection placed where the light puts it, and
    // exactly one of the two shadow mechanisms on. High gets the real map; the tiers that
    // cannot afford it get the software blob. Both at once double up into a black hole
    // (handoff §5.2), which is why this is an either/or.
    boardShadows.setEnabled({ blob: !realBoardShadow, projected: realBoardShadow })
    fitGroundProjection()
  }

  // The lowest Y ANY pose of the board can reach: the body's bounding sphere (a corner of the
  // cube is sqrt(3) times the half-extent from the centre) plus the idle float's own amplitude.
  // Deliberately computed here from the geometry rather than read back from SHADOW_STYLE.floorY,
  // so "is the ground below every pose?" is a real comparison and not a tautology.
  function cubeWorstY() {
    const { half, cs, blockHalf } = metrics()
    return -Math.sqrt(3) * (half - cs / 2 + blockHalf) - style.idleFloatAmplitude
  }

  // Is the ground projection even on screen? The board floats high in a tall canvas, so the
  // quad can be entirely below the canvas bottom — which is a fact the producer has to be told,
  // not a fact to be discovered from a screenshot that simply has no shadow in it.
  //
  // v0.13.0 R3: this is the ONE measurement that must NOT use the gameplay rect. The ground
  // quad is scenery-level geometry drawn by `renderCamera` onto the FULL canvas, so the honest
  // question "is it in frame?" is asked of the render camera against the whole viewport.
  const groundProbe = new THREE.Vector3()
  function groundOnScreenShare() {
    const quads = boardShadows?.report()
    if (!quads) return null
    const canvas = renderer.domElement.getBoundingClientRect()
    if (canvas.width < 1 || canvas.height < 1) return null
    updateRenderCamera()
    const halfSize = quads.receiverSize / 2
    let inside = 0
    const ys = []
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      groundProbe.set(quads.shadowX + dx * halfSize, quads.floorY, quads.shadowZ + dz * halfSize).project(renderCamera)
      const px = canvas.left + (groundProbe.x + 1) * canvas.width / 2
      const py = canvas.top + (1 - groundProbe.y) * canvas.height / 2
      ys.push(py)
      if (px >= canvas.left && px <= canvas.right && py >= canvas.top && py <= canvas.bottom) inside += 1
    }
    return {
      samplesInside: inside, samples: 5,
      centreY: ys[4], canvasTop: canvas.top, canvasBottom: canvas.bottom,
      belowCanvasPx: ys[4] - canvas.bottom,
      fullyInside: inside === 5,
    }
  }

  // The lowest point of the board AS IT IS RIGHT NOW, measured from the live cube transform
  // rather than from the bounding sphere. `cubeWorstY` is the number `floorY` was CHOSEN with;
  // this is the number the current frame actually shows, so a probe sweeping 0°/45°/90° can
  // say "no attitude reaches the ground" from measurements instead of trusting the bound.
  const cornerProbe = new THREE.Vector3()
  function liveLowestCornerY() {
    const group = getCubeGroup?.()
    if (!group) return null
    const { half, cs, blockHalf } = metrics()
    const edge = half - cs / 2 + blockHalf
    group.updateMatrixWorld(true)
    let lowest = Infinity
    for (const x of [-edge, edge]) for (const y of [-edge, edge]) for (const z of [-edge, edge]) {
      cornerProbe.set(x, y, z).applyMatrix4(group.matrixWorld)
      lowest = Math.min(lowest, cornerProbe.y)
    }
    return lowest
  }

  function groundingReport() {
    const art = pedestal ? pedestal.getBoundingClientRect() : null
    const footprint = groundingRoute === 'none' ? groundShadowFootprint() : null
    const quads = boardShadows?.report() ?? null
    return {
      route: groundingRoute,
      ssaoEnabled: useSSAO,
      // Whether the TIER even offers the two scene passes: a low-power load cannot show
      // SSAO at all, which is why every G1 comparison is also captured at low tier.
      ssaoOfferedByTier: !quality.lowPower || SHADOW_STYLE.lowPowerSSAO,
      tier: quality.lowPower ? 'low' : 'high',
      // The resting cube's bottom edge, in world units, and the support's own top surface:
      // an interpenetration check can decide "does the turning cube go through the support"
      // from these two numbers instead of from a screenshot nobody can measure.
      cubeBottomY: cubeBottomY(),
      supportTopY: groundingRoute === 'platform' ? (platformMetrics.topY ?? null) : quads?.floorY ?? null,
      // ---- v0.13.0: what the SHIPPED route has to be able to prove ----------------------
      // There is no support, so the three numbers that matter are the ground's own height,
      // the lowest point ANY pose of the cube can reach, and whether the plane is therefore
      // unreachable. `cubeWorstY` is the bounding-sphere bound config.js derives floorY from
      // (plus the idle bob), reported back so a check compares two independently-computed
      // numbers rather than agreeing with the constant it is testing.
      groundY: quads?.groundY ?? null,
      groundClearance: quads && Number.isFinite(quads.groundY)
        ? cubeWorstY() - quads.floorY : null,
      cubeWorstY: cubeWorstY(),
      liveLowestCornerY: liveLowestCornerY(),
      shadowFootprint: footprint,
      // Where the ground quad ended up ON SCREEN, as a share of the canvas. The board floats
      // high in a tall canvas, so the honest question "is the ground projection even in
      // frame?" is answered here instead of by eye.
      groundOnScreen: groundOnScreenShare(),
      pedestalArt: art ? { hidden: pedestal.style.visibility === 'hidden' || pedestal.style.display === 'none', display: pedestal.style.display, widthPx: art.width, topPx: art.top, leftPx: art.left, heightPx: art.height } : null,
      platform: platform ? {
        visible: platform.visible,
        receiveShadow: platform.receiveShadow,
        castShadow: platform.castShadow,
        layerMask: platform.layers.mask,
        ...platformMetrics,
      } : null,
      artQuads: quads,
      ground: quads,
      // Exactly one shadow mechanism is on in the shipped route; the report says which, so a
      // check cannot pass by finding "a shadow" that the other tier drew.
      shadowMechanism: groundingRoute !== 'none' ? 'support' : (realBoardShadow ? 'real-map' : 'soft-blob'),
      // The occlusion blend's live value (VFX_CONFIG.occlusion.intensity unless a diagnostic
      // override is in force), so a measurement of "SSAO did nothing" can say at what strength.
      occlusionIntensity: occlusionIntensity(),
    }
  }

  function setSSAOEnabled(on) {
    useSSAO = Boolean(on)
    normalPass.enabled = occlusionPass.enabled = useSSAO
    return groundingReport()
  }
  function setGroundingRoute(route) {
    groundingRoute = route === 'platform' ? 'platform' : route === 'art' ? 'art' : 'none'
    applyGroundingRoute()
    return groundingReport()
  }
  function setContactDecalEnabled(on) {
    contactDecalEnabled = Boolean(on)
    boardShadows?.setEnabled({ contact: contactDecalEnabled })
    return groundingReport()
  }
  // How hard the two scene passes are actually biting, as an override on the effect's own blend
  // opacity. The G1a measurement found the shipped SSAO changing ZERO pixels of the frame, and a
  // zero can mean "configured too gently" as easily as "not running" — this is what separates the
  // two: cranked, the occlusion either darkens the seams or it does not exist. Diagnostic only;
  // the shipped value comes from VFX_CONFIG.occlusion and is restored by the probe.
  function setOcclusionIntensity(value) {
    if (!Number.isFinite(value)) return null
    occlusionEffect.blendMode.opacity.value = value
    return occlusionEffect.blendMode.opacity.value
  }
  function occlusionIntensity() {
    return occlusionEffect.blendMode.opacity.value
  }
  function setProjectedShadowEnabled(on) {
    projectedShadowEnabled = Boolean(on)
    boardShadows?.setEnabled({ projected: projectedShadowEnabled && groundingRoute !== 'platform' })
    return groundingReport()
  }

  // ---- Resize -------------------------------------------------------------------
  // TWO boxes, measured separately, and they are not interchangeable:
  //
  //   * the DRAWING surface is the whole viewport, because that is what the render camera
  //     embeds the gameplay projection into;
  //   * the FRAMING box is still `#scene-wrap`, because that is the box the player plays in
  //     and the box every measurement in this file (and in gameInput) is expressed against.
  //
  // `setSize` runs with `updateStyle=false` so re-running it cannot feed back into the
  // observer — the canvas' CSS size comes from the stylesheet, not from the drawing buffer.
  let appliedCanvasSize = { width: 0, height: 0 }
  let appliedViewportSize = { width: 0, height: 0 }
  function resize() {
    const width = sceneWrap.clientWidth
    const height = sceneWrap.clientHeight
    // A container that is momentarily 0 (display:none, a detaching layout) must not push a
    // degenerate projection into the camera; the next observation fixes it.
    if (width < 1 || height < 1) return
    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0, 1)
    const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0, 1)
    const viewportChanged = viewportWidth !== appliedViewportSize.width || viewportHeight !== appliedViewportSize.height
    if (width === appliedCanvasSize.width && height === appliedCanvasSize.height && !viewportChanged) return
    appliedCanvasSize = { width, height }
    appliedViewportSize = { width: viewportWidth, height: viewportHeight }
    canvasCss.width = viewportWidth
    canvasCss.height = viewportHeight
    ensureBoardShadows()
    renderer.setSize(viewportWidth, viewportHeight, false)
    refreshCameraProjection()
    fitCameraToPlaySpace()
    // The embed, the SSAO projection uniform and the render targets all key off the new pair.
    // Order matters: the composer's `setSize` calls `renderer.setSize()`, so the drawing buffer
    // must already be at its final size when it runs, and the embedded projection must be in
    // place BEFORE it, or SSAO caches a cameraNearFar/projection from the previous layout.
    updateRenderCamera()
    composer.setSize(viewportWidth, viewportHeight)
    // v0.13.0 R4: anything anchored to the FULL frame — the floating world's decorations — can
    // only be solved once the embedded projection is in place and the new gameplay rect is
    // known. Called last, so the callback reads a settled camera; a `window.resize` listener
    // would race this module's own ResizeObserver instead of following it.
    onResize?.()
  }

  // The observer reference is kept so a dispose can disconnect it; `window.resize` is the
  // fallback for browsers without ResizeObserver, exactly as before.
  let resizeObserver = null
  function observeResize() {
    window.addEventListener('resize', resize)
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(sceneWrap)
    }
  }
  function stopObservingResize() {
    window.removeEventListener('resize', resize)
    resizeObserver?.disconnect()
    resizeObserver = null
  }

  // ---- Read-outs ----------------------------------------------------------------
  // Moved here from main's read-only introspection hook (refactor P2b follow-up): the
  // post-chain and framing facts are assembled from THIS module's privates, so the module
  // reports them itself and `diagnostics.js` only collects. Read-only, no game state.
  function report() {
    return {
      environment: Boolean(scene.environment),
      hdr: composer.inputBuffer.texture.type === THREE.HalfFloatType,
      contactShadows: {
        ssaoEnabled: useSSAO,
        pedestal: boardShadows?.report(),
        independentDepth: normalPass.renderTarget.depthTexture === contactDepth && composer.stableDepthTexture === null,
        width: contactDepth.image.width,
        height: contactDepth.image.height,
        // v0.13.0 R3: the SSAO material's own copy of the projection is compared against the
        // RENDER camera now. Comparing it against the canonical one would fail on every frame
        // by design — they differ by the embedding — so the old assertion would have had to be
        // deleted rather than kept, and "the pass is using the matrix the frame was drawn with"
        // is exactly the fact this stage can break silently.
        projectionMatches: occlusionEffect.ssaoMaterial.uniforms.projectionMatrix.value.equals(renderCamera.projectionMatrix),
        // G1a found the occlusion changing zero pixels of the frame even when cranked. A zero has
        // two very different causes — the pass never ran, or its inputs never arrived — and these
        // four fields are what tell them apart without a debugger attached.
        ssaoInputs: {
          // Read through the uniforms, which are the values the shader actually samples: the
          // material's own `depthBuffer` / `normalBuffer` properties are set-only accessors.
          depthBound: occlusionEffect.ssaoMaterial.uniforms.depthBuffer.value === contactDepth,
          normalBound: occlusionEffect.ssaoMaterial.uniforms.normalBuffer.value === normalPass.texture,
          blendOpacity: occlusionEffect.blendMode.opacity.value,
          blendFunction: occlusionEffect.blendMode.blendFunction,
          radius: occlusionEffect.ssaoMaterial.uniforms.radius?.value ?? null,
        },
      },
      toneMapping: toneMappingEffect.mode,
      programs: renderer.info.programs?.length,
      // G0 (§4 item 5): the renderer's own per-frame counters, so a material/geometry round
      // can report what it did to the frame instead of only how it looked.
      rendererInfo: {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        points: renderer.info.render.points,
        lines: renderer.info.render.lines,
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
      },
      lowPower: quality.lowPower,
      grounding: groundingReport(),
      // v0.13.0 R3: the canvas/gameplay split, and the error between the two projections.
      projection: embeddingErrorPx(),
    }
  }

  // v0.10.3 (SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §3.2): the reward shake is stated in CSS
  // pixels, and the effects layer applies its offset in world units. This is the SAME
  // projection conversion the camera lift and the platform fit already use (never a hand-rolled
  // tan(fov/2)) — one definition of "how big is a pixel here", read by one more caller.
  function worldPerPixel() {
    const rect = getGameplayRect()
    return (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * orbitDistance)
      / Math.max(rect.height, 1)
  }

  // v0.13.0 R3 gate (handoff §9.3): "the same cell centre measured through the canonical
  // camera against the gameplay rect, and through the render camera against the full canvas,
  // must land on the SAME CSS pixel." That equality IS the embedding, and it is the one thing
  // this stage can break without breaking anything visible — a board drawn a few pixels off
  // its own hit box still looks like a board and still passes every screenshot.
  //
  // The two projections are used the way their owners use them: canonical ↔ gameplay rect
  // (gestures, picking, framing), render ↔ full canvas (what is drawn). 27 samples: the cube's
  // bounding-box corners, edge midpoints and centre.
  const embedCanonicalPx = new THREE.Vector3()
  const embedRenderedPx = new THREE.Vector3()
  function embeddingErrorPx() {
    const canvas = renderer.domElement.getBoundingClientRect()
    if (!(canvas.width > 1) || !(canvas.height > 1)) return null
    updateRenderCamera()
    const gameplay = getGameplayRect()
    const { half } = metrics()
    let worst = 0
    for (const x of [-half, 0, half]) for (const y of [-half, 0, half]) for (const z of [-half, 0, half]) {
      embedCanonicalPx.set(x, y, z).project(camera)
      const cx = gameplay.left + (embedCanonicalPx.x + 1) * 0.5 * gameplay.width
      const cy = gameplay.top + (1 - embedCanonicalPx.y) * 0.5 * gameplay.height
      embedRenderedPx.set(x, y, z).project(renderCamera)
      const rx = canvas.left + (embedRenderedPx.x + 1) * 0.5 * canvas.width
      const ry = canvas.top + (1 - embedRenderedPx.y) * 0.5 * canvas.height
      worst = Math.max(worst, Math.hypot(cx - rx, cy - ry))
    }
    return {
      worstPx: worst,
      samples: 27,
      gameplayRect: { left: gameplay.left, top: gameplay.top, width: gameplay.width, height: gameplay.height },
      canvas: { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height },
      canvasCss: { width: canvasCss.width, height: canvasCss.height },
    }
  }

  function framingReport() {
    const rect = getGameplayRect()
    const solid = cubeScreenBounds()
    const fitBox = projectCubeBounds(cubeExtent())
    return {
      canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.left + rect.width, bottom: rect.top + rect.height },
      solid,
      fitBox,
      fillX: (solid.maxX - solid.minX) / Math.max(rect.width, 1),
      fillY: (solid.maxY - solid.minY) / Math.max(rect.height, 1),
      bandLeft: solid.minX - rect.left,
      bandRight: rect.left + rect.width - solid.maxX,
      clipped: solid.minX < rect.left || solid.maxX > rect.left + rect.width || solid.minY < rect.top || solid.maxY > rect.top + rect.height,
      orbitDistance,
      zoom: cameraZoom,
      fov: camera.fov,
      aspect: camera.aspect,
    }
  }

  return {
    scene,
    camera,
    // v0.13.0 R3: what the frame is ACTUALLY drawn through, and where the board is inside it.
    renderCamera,
    updateRenderCamera,
    getGameplayRect,
    // v0.13.0 R4: the OTHER box — what the renderer actually draws into. Scenery is anchored to
    // the full frame, so the floating world measures against this one while the board keeps
    // measuring against the gameplay rect above. Two boxes, two names, no call site guessing.
    getCanvasRect: () => {
      const rect = renderer.domElement.getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
    },
    cameraTarget,
    quality,
    renderer,
    composer,
    normalPass,
    contactDepth,
    occlusionEffect,
    toneMappingEffect,

    distanceForViewDirection,
    refreshCameraProjection,
    fitCameraToPlaySpace,
    keepCubeInsideCanvas,
    centreCubeHorizontally,
    projectCubeBounds,
    cubeScreenBounds,
    gestureSpan,
    cubeExtent,

    resize,
    observeResize,
    stopObservingResize,
    report,
    framingReport,
    worldPerPixel,
    tuneShadows: (values) => boardShadows?.tune(values),
    // G1 grounding diagnostics. DEV-only by wiring (diagnostics.js mounts them under
    // `__voxalblastDev`), never called by a gameplay path.
    setSSAOEnabled,
    setGroundingRoute,
    setContactDecalEnabled,
    setProjectedShadowEnabled,
    setOcclusionIntensity,
    occlusionIntensity,
    groundingReport,
    getAppliedCanvasSize: () => ({ ...appliedCanvasSize }),
    getCameraZoom: () => cameraZoom,
    getOrbitDistance: () => orbitDistance,
    getCameraDir: () => CAMERA_DIR,
    // The wheel's only entry point: clamping stays here so the two zoom limits cannot drift
    // apart from the code that applies them.
    zoomBy(factor) {
      cameraZoom = THREE.MathUtils.clamp(cameraZoom * factor, minCameraZoom, maxCameraZoom)
    },
  }
}

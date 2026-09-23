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
import { BOARD_STYLE as style, ROTATE_STYLE, VFX_CONFIG } from './config.js'

// `quality` arrives from the caller rather than being read here, so the tier is still
// resolved at exactly the point in main's evaluation it always was.
export function createGameScene({ sceneWrap, quality, getCubeGroup, metrics }) {
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

  // Anchor scenery to the resting cube footprint, not its rotating/scaling intro
  // mesh. It follows resize and wheel zoom without wobbling during a face turn.
  function fitPedestal() {
    if (!pedestal) return
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
    const stageWidth = (maxX - minX) * 1.28
    pedestal.style.width = `${stageWidth}px`
    pedestal.style.left = `${sceneWrap.offsetLeft + (minX + maxX) / 2}px`
    pedestal.style.top = `${sceneWrap.offsetTop + maxY - stageWidth * 0.20}px`
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
    keepCubeInsideCanvas()
    centreCubeHorizontally()
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
      const rect = renderer.domElement.getBoundingClientRect()
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
    const rect = renderer.domElement.getBoundingClientRect()
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
    const rect = renderer.domElement.getBoundingClientRect()
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
  sceneWrap.appendChild(renderer.domElement)

  const composer = new EffectComposer(renderer, { multisampling: quality.multisampling, frameBufferType: THREE.HalfFloatType })
  const renderPass = new RenderPass(scene, camera)
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
  const effectPass = new EffectPass(camera, bloomEffect, toneMappingEffect, smaaEffect)
  // SMAA carries EffectAttribute.DEPTH, so this pass would otherwise ask the composer for a
  // depth texture it never reads. Cancel that request before addPass() sees it — the reason,
  // and the removal condition, are in threeCompat.js.
  skipComposerDepthBlit(effectPass)
  composer.addPass(renderPass)
  // Contact shadows follow the geometry as the player rotates. A dedicated normal target
  // owns real depth, avoiding the composer's aliased depth-texture blit.
  const normalPass = new NormalPass(scene, camera)
  const contactDepth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
  normalPass.renderTarget.depthTexture = contactDepth
  const occlusionEffect = new SSAOEffect(camera, normalPass.texture, {
    ...VFX_CONFIG.occlusion,
    color: new THREE.Color(VFX_CONFIG.occlusion.color),
    samples: quality.lowPower ? 11 : VFX_CONFIG.occlusion.samples,
    resolutionScale: quality.lowPower ? 0.5 : VFX_CONFIG.occlusion.resolutionScale,
  })
  const occlusionPass = new EffectPass(camera, occlusionEffect)
  occlusionPass.setDepthTexture(contactDepth)
  composer.addPass(normalPass)
  composer.addPass(occlusionPass)
  composer.addPass(effectPass)

  // ---- Resize -------------------------------------------------------------------
  // The canvas is sized from the wrap's client box. `setSize` runs with updateStyle=false,
  // so re-running it cannot feed back into the observer.
  let appliedCanvasSize = { width: 0, height: 0 }
  function resize() {
    const width = sceneWrap.clientWidth
    const height = sceneWrap.clientHeight
    // A container that is momentarily 0 (display:none, a detaching layout) must not push a
    // degenerate projection into the camera; the next observation fixes it.
    if (width < 1 || height < 1) return
    if (width === appliedCanvasSize.width && height === appliedCanvasSize.height) return
    appliedCanvasSize = { width, height }
    renderer.setSize(width, height, false)
    refreshCameraProjection()
    fitCameraToPlaySpace()
    // SSAO copies the projection on resize, so the new aspect/FOV must be ready.
    composer.setSize(width, height)
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
        independentDepth: normalPass.renderTarget.depthTexture === contactDepth && composer.stableDepthTexture === null,
        width: contactDepth.image.width,
        height: contactDepth.image.height,
        projectionMatches: occlusionEffect.ssaoMaterial.uniforms.projectionMatrix.value.equals(camera.projectionMatrix),
      },
      toneMapping: toneMappingEffect.mode,
      programs: renderer.info.programs?.length,
      lowPower: quality.lowPower,
    }
  }

  function framingReport() {
    const rect = renderer.domElement.getBoundingClientRect()
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
      orbitDistance: getOrbitDistance(),
      zoom: getCameraZoom(),
      fov: camera.fov,
      aspect: camera.aspect,
    }
  }

  return {
    scene,
    camera,
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

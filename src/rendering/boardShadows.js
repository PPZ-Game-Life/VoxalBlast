import * as THREE from 'three'
import { SHADOW_STYLE as style } from './config.js'

// The board's ground projection, and the ONLY thing that ties the floating board to the world
// under it (handoff §5.2).
//
// What changed in v0.13.0, and why this file is smaller in spirit than it was:
//
//   * There is no pedestal and no platform any more. The two quads used to be laid over the
//     painted support, at the support's own plane — they were the SHADOW of a thing that was
//     standing on the ground. The board now floats, so the plane they lie on is a property of
//     the WORLD (SHADOW_STYLE.floorY, a safety bound under every pose of the cube) and never
//     of the cube's transform.
//   * Neither quad is fitted to the DOM pedestal any more. There is nothing to fit to.
//   * High tier: the real 1024 PCFSoft map darkens the ground where the cube actually casts.
//     Medium/Low: one procedural soft ellipse, no dark ring under the board — the handoff
//     rules the "贴住底面的浓黑 AO 圈" out by name, and a floating board that wears one reads
//     as a board resting on a hole.
//
// The legacy `art` / `platform` grounding routes still place these quads on a raised support;
// `setPlaneY` is what they use for that, and `fit()` is what the shipped route uses.
export function createBoardShadows(scene, { floorY }) {
  const groundY = Number.isFinite(floorY) ? floorY : style.floorY

  // A soft ellipse, not a contact decal. The old texture was a three-stop radial with an 0.9
  // core — a dark blob with a defined middle, which is exactly what a support's contact patch
  // looks like. A shadow cast from a metre up has no core at all: it is a wide, even, low
  // alpha wash that is slightly denser in the middle.
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = style.textureSize
  const ctx = canvas.getContext('2d')
  const half = style.textureSize / 2
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half)
  gradient.addColorStop(0, 'rgba(60,80,105,0.62)')
  gradient.addColorStop(0.45, 'rgba(60,80,105,0.44)')
  gradient.addColorStop(0.75, 'rgba(60,80,105,0.16)')
  gradient.addColorStop(1, 'rgba(60,80,105,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const blobMaterial = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, opacity: style.blobOpacity,
    depthWrite: false, toneMapped: false,
  })
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(style.blobSize, style.blobSize), blobMaterial)
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(style.receiverSize, style.receiverSize),
    new THREE.ShadowMaterial({ color: 0x243a4a, opacity: style.projectedOpacity, depthWrite: false }))
  // ShadowMaterial has no alphaMap. Fade the receiver to a disk so the quad cannot reveal a
  // rectangular plane over the sky. v0.13.0: the disk had to grow with the plane — the fit now
  // centres the quad between the board and where its shadow lands, so a 0.55-radius solid core
  // would eat the far half of the very shadow the quad exists to catch.
  receiver.material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec2 groundUv;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ngroundUv = uv;')
    shader.fragmentShader = 'varying vec2 groundUv;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>',
      'gl_FragColor.a *= 1.0 - smoothstep(0.90, 1.0, length(groundUv * 2.0 - 1.0));\n#include <tonemapping_fragment>')
  }
  receiver.material.customProgramCacheKey = () => 'ground-shadow-disk-v2'
  for (const mesh of [blob, receiver]) {
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = groundY
    mesh.raycast = () => {}
    // Exclude scenery from the normal/depth prepass (camera layer 0). The
    // beauty camera also enables layer 1; NormalPass temporarily disables it.
    mesh.layers.set(1)
    scene.add(mesh)
  }
  receiver.position.y -= 0.002
  receiver.receiveShadow = true
  blob.renderOrder = 1
  receiver.renderOrder = 2

  // G1a (MATERIAL_GROUNDING_REWORK_HANDOFF §5): the two quads have to be separable on
  // demand, one at a time, so the contact diagnosis can say WHERE a difference came from
  // instead of showing "the frame changed". `tune()` only moves opacity, which leaves a
  // still-drawn (and still depth-tested) quad in the frame; `setEnabled` really takes one
  // out of it. Both default to on, which is what the shipped build shows.
  let blobEnabled = true
  let receiverEnabled = true
  function applyEnabled() {
    blob.visible = blobEnabled
    receiver.visible = receiverEnabled
  }

  // Where the quads sit. The shipped route calls `fit()` once per resize with the world-space
  // footprint the key light produces; the two legacy routes call `setPlaneY()` to lift them
  // onto a support's own top surface.
  function setPlaneY(y) {
    if (!Number.isFinite(y)) return
    blob.position.y = y
    receiver.position.y = y - 0.002
  }

  // Two DIFFERENT footprints, because the two quads answer two different questions:
  //
  //   `boardSize`  how wide the board itself is on the ground — the blob stands in for the
  //                shadow on the tiers that cannot afford the real map, so it stays under
  //                the board (`boardX/boardZ`).
  //   `shadowSize` the union of the board's own footprint and where the key light throws it.
  //                The receiving quad has to contain both or the far half of the shadow falls
  //                off the plane (`shadowX/shadowZ`).
  //
  // Geometry is rebuilt rather than scaled: a PlaneGeometry scaled by a node would also scale
  // anything parented to it, and this pair is added straight to the scene root.
  function fit({ boardX = 0, boardZ = 0, boardSize, shadowX = 0, shadowZ = 0, shadowSize, y = groundY } = {}) {
    if (Number.isFinite(shadowSize)) {
      receiver.geometry.dispose()
      receiver.geometry = new THREE.PlaneGeometry(shadowSize, shadowSize)
    }
    if (Number.isFinite(boardSize)) {
      blob.geometry.dispose()
      blob.geometry = new THREE.PlaneGeometry(boardSize, boardSize)
    }
    if (Number.isFinite(shadowX)) receiver.position.x = shadowX
    if (Number.isFinite(shadowZ)) receiver.position.z = shadowZ
    if (Number.isFinite(boardX)) blob.position.x = boardX
    if (Number.isFinite(boardZ)) blob.position.z = boardZ
    setPlaneY(y)
  }

  return {
    tune({ contactOpacity, blobOpacity, projectedOpacity } = {}) {
      if (Number.isFinite(blobOpacity)) blobMaterial.opacity = THREE.MathUtils.clamp(blobOpacity, 0, 0.6)
      if (Number.isFinite(contactOpacity)) blobMaterial.opacity = THREE.MathUtils.clamp(contactOpacity, 0, 0.6)
      if (Number.isFinite(projectedOpacity)) receiver.material.opacity = THREE.MathUtils.clamp(projectedOpacity, 0, 0.6)
    },
    setEnabled({ contact: blobOn, blob, projected: receiverOn } = {}) {
      if (typeof blobOn === 'boolean') blobEnabled = blobOn
      if (typeof blob === 'boolean') blobEnabled = blob
      if (typeof receiverOn === 'boolean') receiverEnabled = receiverOn
      applyEnabled()
      return report()
    },
    setPlaneY,
    fit,
    report,
  }

  function report() {
    const blobSize = blob.geometry.parameters?.width ?? 0
    const receiverSize = receiver.geometry.parameters?.width ?? 0
    return {
      // `groundY` is the WORLD plane; `floorY` is where the quads actually are. They differ
      // only on the legacy routes, which lift the pair onto a support's top surface.
      groundY,
      floorY: blob.position.y,
      planeY: receiver.position.y,
      blobOpacity: blobMaterial.opacity,
      projectedOpacity: receiver.material.opacity,
      blobEnabled,
      receiverEnabled,
      blobSize,
      receiverSize,
      boardX: blob.position.x,
      boardZ: blob.position.z,
      shadowX: receiver.position.x,
      shadowZ: receiver.position.z,
      // The renderer's own view, so an evidence run cannot claim a quad is "off" while the
      // scene still draws it.
      blobVisible: blob.visible,
      projectedVisible: receiver.visible,
    }
  }
}

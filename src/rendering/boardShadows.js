import * as THREE from 'three'
import { SHADOW_STYLE as style } from './config.js'

// Two transparent quads overlay the existing DOM pedestal: a sun projection and a
// contact decal. Neither is a pick target nor changes the cube transform.
// The decal still anchors the cube with shadow maps / SSAO disabled on slow H5.
//
// v0.10.2 — ROUTE B (docs/Technical/MATERIAL_GROUNDING_REWORK_HANDOFF.md §5, decided by the
// producer on 2026-09-30 after the G0/G1 receipt):
//
// G1 measured the old radial decal contributing nothing outside a thin ring at the cube's bottom
// edge: its dark core sat BEHIND the cube, so what reached the screen was a soft circular smudge.
// Route B keeps the painted pedestal and asks for the contact shadow to be redone —
// 「接触影需更贴近底部轮廓，近处较实、外沿渐软，不能只放大一团圆形污影」. So the decal is now
// built from the board's own bottom footprint:
//
//   * a rounded square of exactly the blocks' half-extent, so the shape follows the object
//     instead of being a generic blob;
//   * FULL strength up to that edge, with a SHORT falloff on the camera-near edge (a firm
//     contact line — the only part of the decal a player can actually see) and a LONG one away
//     from it (a soft tail, so the decal has no visible edge of its own);
//   * the quad is rotated with the board's bearing, so the footprint stays under the blocks
//     while the view is dialled.
//
// It is still painted alpha on a plane, not surface occlusion. Route B's own wording applies:
// this is a VISUAL APPROXIMATION and must not be described as a real table SSAO. The radial
// version stays available as a switchable shape, because that is what the round is graded
// against (same frame, same pose, only the shape differs) and what a rollback restores.
//
// `footprintHalf` is the board's own outermost-block half-extent (2.475 with SH=5), handed in by
// gameScene from the same `cubeBottomY()` the 3D prototype is fitted against — never retyped.
export function createBoardShadows(scene, { extent, footprintHalf = 2.475, groundYaw = 0 }) {
  // The legacy radial decal. Its alpha profile is the v0.9.x one, unchanged.
  function radialTexture() {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = style.textureSize
    const ctx = canvas.getContext('2d')
    const half = style.textureSize / 2
    const [r, g, b] = style.contactColor
    const gradient = ctx.createRadialGradient(half, half, half * 0.18, half, half, half)
    gradient.addColorStop(0, `rgba(${r},${g},${b},0.9)`)
    gradient.addColorStop(0.48, `rgba(${r},${g},${b},0.65)`)
    gradient.addColorStop(0.8, `rgba(${r},${g},${b},0.18)`)
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  // The route-B footprint decal. Written per pixel rather than with canvas gradients: the shape
  // and the two falloff lengths are analytic, so what the texture does is exactly what the
  // constants say, and there is no banding from stacked radial stops.
  //
  // ORIENTATION, which is the one thing here that is easy to get backwards: three maps a canvas
  // with v = 0 at the BOTTOM (flipY), so canvas row 0 is the plane's local +Y. The plane is laid
  // flat with rotation.x = -π/2 and then spun by the board's yaw; that puts the board's own +z
  // face — the one the camera is docked in front of, i.e. the NEAR edge — at the plane's local
  // -Y, which is the canvas BOTTOM. Hence `nearness = -v / radius` below.
  function footprintTexture() {
    const size = style.footprintTextureSize
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    const image = ctx.createImageData(size, size)
    const data = image.data
    const quadHalf = footprintHalf + style.contactSkirtFar
    const [r, g, b] = style.contactColor
    const { contactRoundness: n, contactSkirtNear, contactSkirtFar, contactNearWeight, contactFarWeight } = style
    for (let row = 0; row < size; row += 1) {
      const y = 1 - ((row + 0.5) / size) * 2
      const v = y * quadHalf
      for (let col = 0; col < size; col += 1) {
        const x = ((col + 0.5) / size) * 2 - 1
        const u = x * quadHalf
        // Superellipse distance: equals the half-extent along the axes and 2^(1/n) times it on
        // the diagonals, i.e. a rounded square. n = 2 would be a circle, which is the blob route
        // B rejects.
        const q = (Math.abs(u) ** n + Math.abs(v) ** n) ** (1 / n)
        const radius = Math.hypot(u, v)
        const nearness = radius > 1e-6 ? -v / radius : 0
        const mix = (nearness + 1) / 2
        const skirt = contactSkirtFar + (contactSkirtNear - contactSkirtFar) * mix
        const weight = contactFarWeight + (contactNearWeight - contactFarWeight) * mix
        let alpha = weight
        if (q > footprintHalf) {
          const t = Math.min(1, (q - footprintHalf) / skirt)
          alpha = weight * (1 - t) * (1 - t)
        }
        const offset = (row * size + col) * 4
        data[offset] = r
        data[offset + 1] = g
        data[offset + 2] = b
        data[offset + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
      }
    }
    ctx.putImageData(image, 0, 0)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  const footprintQuadHalf = footprintHalf + style.contactSkirtFar
  const footprintMap = footprintTexture()
  const radialMap = radialTexture()
  let contactShape = style.contactShape === 'radial' ? 'radial' : 'footprint'
  const footprintGeometry = new THREE.PlaneGeometry(footprintQuadHalf * 2, footprintQuadHalf * 2)
  const radialGeometry = new THREE.PlaneGeometry(style.contactSize, style.contactSize)

  const contactMaterial = new THREE.MeshBasicMaterial({
    map: contactShape === 'radial' ? radialMap : footprintMap,
    transparent: true, opacity: style.contactOpacity,
    depthWrite: false, toneMapped: false,
  })
  const contact = new THREE.Mesh(contactShape === 'radial' ? radialGeometry : footprintGeometry, contactMaterial)
  const projected = new THREE.Mesh(new THREE.PlaneGeometry(style.receiverSize, style.receiverSize),
    new THREE.ShadowMaterial({ color: 0x543721, opacity: style.projectedOpacity, depthWrite: false }))
  // ShadowMaterial has no alphaMap. Fade the receiver to a disk so the shadow
  // cannot reveal a rectangular plane over the landscape outside the DOM art.
  // The cast shadow is DIRECTIONAL (it falls away from the key light), so it is deliberately not
  // clipped to the footprint the way the contact decal is — but it is faded on the same scale, so
  // the two layers agree about where the support ends.
  projected.material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec2 pedestalUv;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\npedestalUv = uv;')
    shader.fragmentShader = 'varying vec2 pedestalUv;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>',
      'gl_FragColor.a *= 1.0 - smoothstep(0.55, 1.0, length(pedestalUv * 2.0 - 1.0));\n#include <tonemapping_fragment>')
  }
  projected.material.customProgramCacheKey = () => 'pedestal-shadow-disk-v1'
  for (const mesh of [contact, projected]) {
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = -extent - style.floorOffset
    mesh.raycast = () => {}
    // Exclude scenery from the normal/depth prepass (camera layer 0). The
    // beauty camera also enables layer 1; NormalPass temporarily disables it.
    mesh.layers.set(1)
    scene.add(mesh)
  }
  projected.position.y -= 0.002
  projected.receiveShadow = true
  contact.renderOrder = 1
  projected.renderOrder = 2

  // The footprint has to stay under the blocks while the player dials the view. Rotating the
  // MESH (not redrawing the texture) is what makes this free: the texture holds the shape in the
  // decal's own frame, and a rotation about the plane's local Z is a rotation in the ground
  // plane. The rotation is the board's bearing yaw — main hands it over once per frame and this
  // is a no-op unless it actually moved.
  //
  // Frame check: with rotation.x = -π/2 and Euler order XYZ, the plane's local +X maps to world
  // (cosθ, 0, −sinθ), which is exactly the board's own +x direction under a yaw of θ. So
  // `rotation.z = bearingYaw` aligns the footprint with the blocks.
  let supportYaw = groundYaw
  for (const mesh of [contact, projected]) mesh.rotation.z = supportYaw
  function setGroundYaw(yaw) {
    if (!Number.isFinite(yaw) || Math.abs(yaw - supportYaw) < 1e-5) return supportYaw
    supportYaw = yaw
    for (const mesh of [contact, projected]) mesh.rotation.z = supportYaw
    return supportYaw
  }

  // G1a (MATERIAL_GROUNDING_REWORK_HANDOFF §5): the two quads have to be separable on
  // demand, one at a time, so the contact diagnosis can say WHERE a difference came from
  // instead of showing "the frame changed". `tune()` only moves opacity, which leaves a
  // still-drawn (and still depth-tested) quad in the frame; `setEnabled` really takes one
  // out of it. Both default to on, which is what the shipped build shows.
  let contactEnabled = true
  let projectedEnabled = true
  function applyEnabled() {
    contact.visible = contactEnabled
    projected.visible = projectedEnabled
  }

  // Where the painted support's two planes sit. In the shipped (art) route this never
  // moves. The G1b prototype lifts it onto the prototype's own top surface, because a
  // contact decal buried 0.025 below a real platform shows nothing at all — and the whole
  // point of that round is to find out whether a decal on top of a REAL surface still buys
  // anything (the low-power fallback question, §5 G1b).
  function setPlaneY(y) {
    if (!Number.isFinite(y)) return
    contact.position.y = y
    projected.position.y = y - 0.002
  }

  // Route B's A/B: swap the decal's shape without touching anything else, so the round can be
  // graded on the shape alone.
  function setShape(shape) {
    contactShape = shape === 'radial' ? 'radial' : 'footprint'
    contactMaterial.map = contactShape === 'radial' ? radialMap : footprintMap
    contactMaterial.needsUpdate = true
    contact.geometry = contactShape === 'radial' ? radialGeometry : footprintGeometry
    return report()
  }

  return {
    tune({ contactOpacity, projectedOpacity } = {}) {
      if (Number.isFinite(contactOpacity)) contactMaterial.opacity = THREE.MathUtils.clamp(contactOpacity, 0, 0.6)
      if (Number.isFinite(projectedOpacity)) projected.material.opacity = THREE.MathUtils.clamp(projectedOpacity, 0, 0.6)
    },
    setEnabled({ contact: contactOn, projected: projectedOn } = {}) {
      if (typeof contactOn === 'boolean') contactEnabled = contactOn
      if (typeof projectedOn === 'boolean') projectedEnabled = projectedOn
      applyEnabled()
      return report()
    },
    setPlaneY,
    setGroundYaw,
    setShape,
    report,
  }

  function report() {
    return {
      contactOpacity: contactMaterial.opacity,
      projectedOpacity: projected.material.opacity,
      contactEnabled,
      projectedEnabled,
      floorY: contact.position.y,
      basePlaneY: -extent - style.floorOffset,
      // The renderer's own view, so an evidence run cannot claim a quad is "off" while the
      // scene still draws it.
      contactVisible: contact.visible,
      projectedVisible: projected.visible,
      // Route B: which shape is drawn, what it is fitted to, and how it is aligned.
      contactShape,
      footprintHalf,
      footprintQuadHalf,
      skirt: { near: style.contactSkirtNear, far: style.contactSkirtFar },
      supportYaw,
    }
  }
}

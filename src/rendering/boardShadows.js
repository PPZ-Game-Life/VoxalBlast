import * as THREE from 'three'
import { SHADOW_STYLE as style } from './config.js'

// Two transparent quads overlay the existing DOM pedestal: a sun projection and
// a soft contact decal. Neither is a pick target nor changes the cube transform.
// The decal still anchors the cube with shadow maps / SSAO disabled on slow H5.
export function createBoardShadows(scene, { extent }) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = style.textureSize
  const ctx = canvas.getContext('2d')
  const half = style.textureSize / 2
  const gradient = ctx.createRadialGradient(half, half, half * 0.18, half, half, half)
  gradient.addColorStop(0, 'rgba(70,42,23,0.9)')
  gradient.addColorStop(0.48, 'rgba(70,42,23,0.65)')
  gradient.addColorStop(0.8, 'rgba(70,42,23,0.18)')
  gradient.addColorStop(1, 'rgba(70,42,23,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const contactMaterial = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, opacity: style.contactOpacity,
    depthWrite: false, toneMapped: false,
  })
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(style.contactSize, style.contactSize), contactMaterial)
  const projected = new THREE.Mesh(new THREE.PlaneGeometry(style.receiverSize, style.receiverSize),
    new THREE.ShadowMaterial({ color: 0x543721, opacity: style.projectedOpacity, depthWrite: false }))
  // ShadowMaterial has no alphaMap. Fade the receiver to a disk so the shadow
  // cannot reveal a rectangular plane over the landscape outside the DOM art.
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

  return {
    tune({ contactOpacity, projectedOpacity } = {}) {
      if (Number.isFinite(contactOpacity)) contactMaterial.opacity = THREE.MathUtils.clamp(contactOpacity, 0, 0.6)
      if (Number.isFinite(projectedOpacity)) projected.material.opacity = THREE.MathUtils.clamp(projectedOpacity, 0, 0.6)
    },
    report: () => ({ contactOpacity: contactMaterial.opacity, projectedOpacity: projected.material.opacity, floorY: contact.position.y }),
  }
}

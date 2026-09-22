import * as THREE from 'three'
import { BOARD_STYLE, LIGHTING_STYLE as light } from './config.js'

// One light rig for board, hand previews and home. Sizes differ, materials do not.
//
// v0.7 「田园木作」: the rig now describes a wooden toy standing in a meadow —
// late-afternoon sun from the upper LEFT (the same direction the backdrop's sun
// glow sits, so the two never disagree), a cool sky bounce for the shadow side,
// and a green ground bounce off the grass. The key is warmer and softer than the
// v0.5 rig: varnish on timber wants a broad highlight, not a hard specular dot.
let environment

// Linear HDR source, filtered by Three's PMREM per renderer. Unlike a GPU render
// target, this texture also works in the independent tray / home WebGL contexts.
function toyEnvironment() {
  if (environment) return environment
  const width = light.environmentWidth
  const height = light.environmentHeight
  const data = new Uint16Array(width * height * 4)
  const direction = new THREE.Vector3()
  const key = new THREE.Vector3(...light.keyPosition).normalize()
  const keyRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), key).normalize()
  const keyUp = new THREE.Vector3().crossVectors(key, keyRight).normalize()
  const rim = new THREE.Vector3(...light.rimPosition).normalize()
  for (let y = 0; y < height; y += 1) {
    // DataTexture rows start at v=0: inverse of Three's equirectUv().
    const theta = (1 - (y + 0.5) / height) * Math.PI
    for (let x = 0; x < width; x += 1) {
      const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2
      direction.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi))
      const sky = Math.max(0, direction.y)
      // A soft rectangular sky opening gives varnish a broad ribbon reflection
      // across rounded shoulders, instead of the old point-like Gaussian spot.
      const facing = direction.dot(key)
      const softbox = facing > 0 ? light.reflectionKeyIntensity * Math.exp(
        -Math.pow(direction.dot(keyRight) / (facing * light.reflectionKeyWidth), 4)
        -Math.pow(direction.dot(keyUp) / (facing * light.reflectionKeyHeight), 4),
      ) : 0
      const rimbox = light.reflectionRimIntensity * Math.pow(Math.max(0, direction.dot(rim)), light.reflectionRimFocus)
      const offset = (y * width + x) * 4
      const rgb = [
        0.28 + sky * 0.38 + softbox + rimbox,
        0.3 + sky * 0.4 + softbox * 0.91 + rimbox * 0.9,
        0.32 + sky * 0.46 + softbox * 0.76 + rimbox * 0.78,
      ]
      for (let c = 0; c < 3; c += 1) data[offset + c] = THREE.DataUtils.toHalfFloat(rgb[c])
      data[offset + 3] = THREE.DataUtils.toHalfFloat(1)
    }
  }
  environment = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType)
  environment.mapping = THREE.EquirectangularReflectionMapping
  environment.colorSpace = THREE.LinearSRGBColorSpace
  environment.minFilter = environment.magFilter = THREE.LinearFilter
  environment.needsUpdate = true
  return environment
}

export function addToyLights(scene, { shadows = false, lowPower = false } = {}) {
  scene.environment = toyEnvironment()
  scene.environmentIntensity = BOARD_STYLE.environmentIntensity
  scene.add(new THREE.HemisphereLight(light.sky, light.ground, light.hemisphereIntensity))
  const key = new THREE.DirectionalLight(light.keyColor, light.keyIntensity)
  key.position.set(...light.keyPosition)
  key.castShadow = shadows
  key.shadow.mapSize.setScalar(lowPower ? 1024 : 2048)
  const extent = light.shadowExtent
  Object.assign(key.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 0.5, far: 24 })
  key.shadow.bias = light.shadowBias
  key.shadow.normalBias = light.shadowNormalBias
  scene.add(key)
  const fill = new THREE.DirectionalLight(light.fillColor, light.fillIntensity)
  fill.position.set(...light.fillPosition)
  scene.add(fill)
  const rim = new THREE.DirectionalLight(light.rimColor, light.rimIntensity)
  rim.position.set(...light.rimPosition)
  scene.add(rim)
}

import * as THREE from 'three'

// One light rig for board, hand previews and home. Sizes differ, materials do not.
export function addToyLights(scene, { shadows = false, lowPower = false } = {}) {
  scene.add(new THREE.HemisphereLight(0xf4f8ff, 0x7486ad, 2.1))
  const key = new THREE.DirectionalLight(0xfff4df, 3.5)
  key.position.set(-5, 9, 8)
  key.castShadow = shadows
  key.shadow.mapSize.setScalar(lowPower ? 1024 : 2048)
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 })
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.025
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xb5d5ff, 0.65)
  fill.position.set(6, 2, -4)
  scene.add(fill)
}

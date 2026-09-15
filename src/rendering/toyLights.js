import * as THREE from 'three'

// One light rig for board, hand previews and home. Sizes differ, materials do not.
//
// v0.7 「田园木作」: the rig now describes a wooden toy standing in a meadow —
// late-afternoon sun from the upper LEFT (the same direction the backdrop's sun
// glow sits, so the two never disagree), a cool sky bounce for the shadow side,
// and a green ground bounce off the grass. The key is warmer and softer than the
// v0.5 rig: varnish on timber wants a broad highlight, not a hard specular dot.
export function addToyLights(scene, { shadows = false, lowPower = false } = {}) {
  scene.add(new THREE.HemisphereLight(0xfff6e4, 0x6f8f4a, 1.35))
  const key = new THREE.DirectionalLight(0xfff0cf, 3.2)
  key.position.set(-6, 9, 7)
  key.castShadow = shadows
  key.shadow.mapSize.setScalar(lowPower ? 1024 : 2048)
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 })
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.025
  key.shadow.camera.near = 0.5
  key.shadow.camera.far = 30
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xcfe6ff, 0.85)
  fill.position.set(7, 2, -5)
  scene.add(fill)
  const softbox = new THREE.DirectionalLight(0xffe9c4, 0.55)
  softbox.position.set(2, 6, -6)
  scene.add(softbox)
}

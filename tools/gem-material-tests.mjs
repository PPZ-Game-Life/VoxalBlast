// Material lifecycle regression: intro and drag snapshots clone/copy materials.
// The custom volume shader and its independent uniforms must survive both paths.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { GemMaterial } from '../src/rendering/gemMaterial.js'

const texture = new THREE.Texture()
const source = new GemMaterial({ color: 0x009aff, map: texture, opacity: 0.86, transparent: true })
source.setVolume({ scatter: 0.83, density: 1.3 })
const clone = source.clone()
assert.ok(clone.isGemMaterial)
assert.equal(clone.customProgramCacheKey(), source.customProgramCacheKey())
assert.equal(clone.onBeforeCompile, source.onBeforeCompile)
assert.deepEqual(clone.volumeSettings(), source.volumeSettings())
assert.notEqual(clone.gemUniforms.gemScatter, source.gemUniforms.gemScatter)
assert.equal(clone.map, source.map)
assert.equal(clone.opacity, 0.86)
assert.equal(clone.transmission, 0)
clone.setVolume({ scatter: 0.1 })
assert.equal(source.volumeSettings().scatter, 0.83)
clone.copy(source)
assert.equal(clone.volumeSettings().scatter, 0.83)
assert.notEqual(clone.gemUniforms.gemScatter, source.gemUniforms.gemScatter)
clone.setVolume({ scatter: NaN, density: Infinity, coreAbsorption: 4, environmentTransmission: -3 })
assert.equal(clone.volumeSettings().scatter, 0.83)
assert.equal(clone.volumeSettings().density, 1.3)
assert.ok(clone.volumeSettings().coreAbsorption < 1)
assert.equal(clone.volumeSettings().environmentTransmission, 0)
assert.equal(source.volumeSettings().density, 1.3)
clone.dispose()
source.dispose()
texture.dispose()
console.log('gem-material-tests: clone/copy, independent uniforms, shared maps, opacity and safe tuning passed')

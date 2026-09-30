import * as THREE from 'three'
import { BOARD_STYLE, GEM_STYLE } from './config.js'

const VOLUME_LIMITS = { density: [0.05, 5], scatter: [0, 2], coreAbsorption: [0, 0.85], internalReflection: [0, 1], environmentTransmission: [0, 1] }
const uniformName = key => `gem${key[0].toUpperCase()}${key.slice(1)}`
export function clampGemSettings(values, current = GEM_STYLE) {
  const result = { ...current }
  for (const [key, [min, max]] of Object.entries(VOLUME_LIMITS)) {
    if (Number.isFinite(values[key])) result[key] = THREE.MathUtils.clamp(values[key], min, max)
  }
  return result
}

// Single-pass, opaque-depth approximation of a coloured glass/jelly volume.
// PhysicalMaterial still owns the glossy dielectric surface. The extra lobe
// models thickness absorption + wrapped/back scattering inside each block,
// without showing the timber backing or sorting 98 transparent shell cells.
// Keep this a subclass: clone/copy are used by intro, drag snapshots and effects.
export class GemMaterial extends THREE.MeshPhysicalMaterial {
  constructor(parameters = {}) {
    super(parameters)
    this.isGemMaterial = true
    this.gemUniforms = {
      gemHalfSize: { value: BOARD_STYLE.blockSize / 2 },
      gemDensity: { value: GEM_STYLE.density },
      gemScatter: { value: GEM_STYLE.scatter },
      gemCoreAbsorption: { value: GEM_STYLE.coreAbsorption },
      gemInternalReflection: { value: GEM_STYLE.internalReflection },
      gemEnvironmentTransmission: { value: GEM_STYLE.environmentTransmission },
    }
  }

  copy(source) {
    super.copy(source)
    for (const [name, uniform] of Object.entries(this.gemUniforms)) {
      if (source.gemUniforms?.[name]) uniform.value = source.gemUniforms[name].value
    }
    return this
  }

  setVolume(values) {
    const settings = clampGemSettings(values, this.volumeSettings())
    for (const [key, value] of Object.entries(settings)) this.gemUniforms[uniformName(key)].value = value
    return settings
  }

  volumeSettings() {
    return Object.fromEntries(Object.keys(VOLUME_LIMITS).map(key => [key, this.gemUniforms[uniformName(key)].value]))
  }

  customProgramCacheKey() { return 'voxal-gem-volume-v1' }

  onBeforeCompile(shader) {
    Object.assign(shader.uniforms, this.gemUniforms)
    shader.vertexShader = `
      varying vec3 vGemPosition;
      varying vec3 vGemNormal;
      varying vec3 vGemView;
      varying vec2 vGemFaceUv;
    ` + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      #include <project_vertex>
      vGemPosition = transformed;
      vGemNormal = objectNormal;
      vGemView = inverseTransformDirection(-mvPosition.xyz, modelViewMatrix);
      vGemFaceUv = uv;
    `)
    shader.fragmentShader = `
      varying vec3 vGemPosition;
      varying vec3 vGemNormal;
      varying vec3 vGemView;
      varying vec2 vGemFaceUv;
      uniform float gemHalfSize;
      uniform float gemDensity;
      uniform float gemScatter;
      uniform float gemCoreAbsorption;
      uniform float gemInternalReflection;
      uniform float gemEnvironmentTransmission;
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_fragment>', `
      #include <transmission_fragment>
      // Distance from the front surface to the exit slab along the refracted
      // local-space ray. Rounded shoulders have a shorter optical path.
      vec3 gemRay = refract(-normalize(vGemView), normalize(vGemNormal), 1.0 / ior);
      vec3 gemExit = (vec3(gemHalfSize) - sign(gemRay) * vGemPosition)
        / max(abs(gemRay), vec3(0.0001));
      float gemPath = clamp(min(min(gemExit.x, gemExit.y), gemExit.z)
        / (2.0 * gemHalfSize), 0.04, 1.6);
      // Rounded jelly core inside the slab: optically thinner near a face's
      // shoulders. UVs are the existing per-face coordinates, not screen space.
      vec2 gemFace = abs(vGemFaceUv * 2.0 - 1.0);
      float gemRadius = mix(max(gemFace.x, gemFace.y), length(gemFace) * 0.7071, 0.4);
      float gemCore = 1.0 - smoothstep(0.22, 1.0, gemRadius);
      gemPath *= mix(0.22, 1.0, gemCore);
      float gemThrough = exp(-gemDensity * gemPath);
      float gemEdge = pow(1.0 - saturate(dot(normal, geometryViewDir)), 2.0);
      // A bounded thickness approximation for rounded bevels; never a uniform
      // emissive rim. It is coloured by real lights and responds to rotation.
      float gemThin = max(gemThrough, gemEdge * 0.65);
      vec3 gemIrradiance = vec3(0.0);
      vec3 gemInnerGlint = vec3(0.0);
      vec3 gemRefractedView = refract(-geometryViewDir, normal, 1.0 / ior);
      #if NUM_DIR_LIGHTS > 0
        vec3 gemL;
        float gemWrap, gemBack, gemFocus;
        #pragma unroll_loop_start
        for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
          gemL = directionalLights[i].direction;
          gemWrap = pow(saturate((dot(normal, gemL) + 0.55) / 1.55), 2.0);
          gemBack = pow(saturate(dot(-geometryViewDir, normalize(gemL + normal * 0.28))), 3.0);
          gemIrradiance += directionalLights[i].color * (gemWrap * 0.25 + gemBack * 0.75);
          gemFocus = pow(saturate(dot(gemRefractedView, -gemL)), 8.0);
          gemInnerGlint += directionalLights[i].color * gemFocus;
        }
        #pragma unroll_loop_end
      #endif
      // Beer-Lambert-style absorption: preserve the saturated core, raise the
      // thin regions and soft internal lobe. This is not scene transmission.
      vec3 gemTint = mix(diffuseColor.rgb, sqrt(max(diffuseColor.rgb, vec3(0.0))), 0.28);
      totalDiffuse *= 1.0 - gemCoreAbsorption * (1.0 - gemThrough);
      totalDiffuse += gemTint * gemIrradiance * gemScatter * (0.22 + 1.8 * gemThin);
      totalDiffuse += gemTint * gemInnerGlint * gemInternalReflection * (0.18 + gemThin);
      #ifdef ENVMAP_TYPE_CUBE_UV
        // Refract the fixed environment through the coloured body. One cached
        // PMREM lookup, no screen colour buffer / scene transmission pass.
        vec3 gemWorldRay = inverseTransformDirection(gemRefractedView, viewMatrix);
        vec3 gemBehind = textureCubeUV(envMap, envMapRotation * gemWorldRay, 0.24).rgb;
        totalDiffuse += gemTint * gemBehind * envMapIntensity * gemEnvironmentTransmission * gemThin;
      #endif
    `)
  }
}

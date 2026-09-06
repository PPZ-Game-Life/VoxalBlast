export const RENDER_PALETTE = Object.freeze({
  background: 0x69a5ff,
  navy: 0x24345d,
  navyDeep: 0x17284f,
  grid: 0x2d3e69,
  gridGlow: 0x8fbaff,
  candidate: 0xffc928,
  valid: 0x63f08a,
  invalid: 0xff5364,
  line: Object.freeze({ x: 0xffed78, y: 0x63f08a, z: 0x6bd5ff }),
})

export const VFX_CONFIG = Object.freeze({
  clear: Object.freeze({
    duration: 0.72,
    life: 0.62,
    speed: 1.45,
    particleSize: 0.09,
    spread: 0.3,
    beamDuration: 0.56,
    beamOpacity: 0.72,
    stagger: 0.035,
  }),
  cameraShake: Object.freeze({
    singleLine: 0.055,
    multiLine: 0.12,
    decay: 0.42,
  }),
  bloom: Object.freeze({
    intensity: 0.72,
    lowPowerIntensity: 0.42,
    luminanceThreshold: 0.82,
    luminanceSmoothing: 0.22,
    radius: 0.72,
    levels: 6,
    lowPowerLevels: 4,
  }),
})

export function getRenderQuality() {
  const lowPower = window.matchMedia?.('(max-width: 700px)').matches || (navigator.hardwareConcurrency || 8) <= 4
  return Object.freeze({
    lowPower,
    pixelRatioMax: lowPower ? 1.35 : 2,
    multisampling: lowPower ? 0 : 4,
    particlesPerLine: lowPower ? 7 : 14,
    bloomIntensity: lowPower ? VFX_CONFIG.bloom.lowPowerIntensity : VFX_CONFIG.bloom.intensity,
  })
}

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

// v0.2.23 "floating space board": the cube reads as a light spatial skeleton
// (deep-navy tint + faint grids + space-boundary edges) and the saturated,
// rounded voxels — slightly pushed out of the shell — are the visual subject.
export const BOARD_STYLE = Object.freeze({
  // Near-invisible volume tint left in place of the old solid body, so empty
  // boards still hint at the 6×6×6 space without looking like a dark block.
  hullColor: 0x16295c,
  hullOpacity: 0.05,
  hullRoughness: 0.55,
  // Space-boundary cage (was a strong 12-edge frame).
  edgeColor: 0x2e5396,
  edgeOpacity: 0.11,
  // Per-face N×N grid hint (was a loud 0.3 engineering overlay).
  gridColor: 0xaac4ee,
  gridOpacity: 0.13,
  // Placed-voxel shell: outward float offset, rounded body and softer lit plastic.
  voxelRaise: 0.17,
  voxelRoughness: 0.46,
  voxelEdgeColor: 0x24427d,
  voxelEdgeOpacity: 0.1,
  // Camera framing: higher = the cube fills more of the central canvas
  // (desktop ~+10%, mobile ~+14% versus the v0.2.22 fit).
  safeFactorDesktop: 0.97,
  safeFactorMobile: 0.93,
  // Vertical re-centring in world units (cube drawn on a large central canvas).
  targetYDesktop: 0.1,
  targetYMobile: -0.3,
})

export const VFX_CONFIG = Object.freeze({
  clear: Object.freeze({
    duration: 0.72,
    life: 0.62,
    speed: 1.45,
    particleSize: 0.09,
    spread: 0.3,
    beamDuration: 0.56,
    beamOpacity: 0.5,
    stagger: 0.035,
    starDuration: 0.62,
    starMaxScale: 1.3,
  }),
  cameraShake: Object.freeze({
    singleLine: 0.055,
    multiLine: 0.12,
    decay: 0.42,
  }),
  bloom: Object.freeze({
    intensity: 0.55,
    lowPowerIntensity: 0.34,
    luminanceThreshold: 0.9,
    luminanceSmoothing: 0.22,
    radius: 0.72,
    levels: 6,
    lowPowerLevels: 4,
  }),
  preview: Object.freeze({
    cameraHeight: 2.15,
    maxScale: 1.7,
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

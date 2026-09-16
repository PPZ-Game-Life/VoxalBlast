// v0.7 「田园木作」背景 — a code-drawn pastoral landscape behind the cube.
//
// 05「资产边界」: the runtime picture never loads an image file. A hand-painted
// countryside would normally be one big PNG; here it is one inline SVG built out
// of parametric shapes at boot, so it stays a few kilobytes of source, scales to
// any viewport without a second asset, and can be retuned by editing numbers
// instead of re-exporting art.
//
// The scene is deliberately READ-ONLY decoration: it sits behind the canvas, it
// never takes a pointer event (05「背景不参与交互」), and the cube is always the
// brightest, most saturated thing on screen. Every value below is muted on
// purpose — a background that competes with the board is a bug, not a style.
//
// Layout note: the viewBox is 1440×1000 and the element uses
// `preserveAspectRatio="xMidYMid slice"`, so desktop crops the top and bottom
// and a phone keeps the middle ~35% of the width. Everything that has to survive
// that crop (hills, meadow, the river) spans the full width, and the village is
// centred rather than pushed into a corner.

function seeded(seed) {
  let a = seed >>> 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const W = 1440
const H = 1000

function cloud(x, y, scale, opacity) {
  const puffs = [
    [0, 0, 46], [42, -14, 54], [92, 2, 42], [-40, 8, 36], [140, 12, 30],
  ]
  const body = puffs
    .map(([dx, dy, r]) => `<ellipse cx="${(x + dx * scale).toFixed(1)}" cy="${(y + dy * scale).toFixed(1)}" rx="${(r * scale).toFixed(1)}" ry="${(r * 0.62 * scale).toFixed(1)}"/>`)
    .join('')
  return `<g fill="#ffffff" opacity="${opacity}">${body}</g>`
}

function rollingHill(baseY, amplitude, fill, seed, steps = 14) {
  const random = seeded(seed)
  let d = `M -40 ${H} L -40 ${baseY}`
  const span = W + 80
  for (let i = 0; i <= steps; i += 1) {
    const x = -40 + (span * i) / steps
    const y = baseY - Math.sin((i / steps) * Math.PI * 1.6 + seed * 0.01) * amplitude - random() * amplitude * 0.5
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`
  }
  d += ` L ${W + 40} ${H} Z`
  return `<path d="${d}" fill="${fill}"/>`
}

function tree(x, y, scale, canopy, trunk = '#7b5533') {
  return `<g transform="translate(${x} ${y}) scale(${scale})">`
    + `<rect x="-4" y="0" width="8" height="46" rx="3" fill="${trunk}"/>`
    + `<ellipse cx="-16" cy="-8" rx="26" ry="22" fill="${canopy}"/>`
    + `<ellipse cx="16" cy="-6" rx="24" ry="20" fill="${canopy}"/>`
    + `<ellipse cx="0" cy="-26" rx="30" ry="26" fill="${canopy}"/>`
    + `<ellipse cx="-2" cy="-12" rx="34" ry="24" fill="${canopy}" opacity="0.85"/>`
    + '</g>'
}

function pine(x, y, scale, fill) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">`
    + '<path d="M 0 -78 L 20 -30 L 12 -30 L 28 4 L -28 4 L -12 -30 L -20 -30 Z" fill="' + fill + '"/>'
    + '<rect x="-3" y="4" width="6" height="16" rx="2" fill="#6c4a2b"/>'
    + '</g>'
}

function cottage(x, y, scale, roof, wall) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">`
    + `<path d="M -26 -16 L 0 -40 L 26 -16 Z" fill="${roof}"/>`
    + `<rect x="-20" y="-16" width="40" height="28" rx="3" fill="${wall}"/>`
    + '<rect x="-6" y="-8" width="12" height="20" rx="5" fill="#b8804a"/>'
    + '<rect x="-17" y="-11" width="8" height="8" rx="2" fill="#8fc3de"/>'
    + '<rect x="9" y="-11" width="8" height="8" rx="2" fill="#8fc3de"/>'
    + '</g>'
}

function daisy(x, y, scale, rotate) {
  let petals = ''
  for (let i = 0; i < 8; i += 1) {
    petals += `<ellipse cx="0" cy="-9" rx="3.6" ry="6.4" transform="rotate(${i * 45})"/>`
  }
  return `<g transform="translate(${x} ${y}) scale(${scale}) rotate(${rotate})">`
    + `<g fill="#fffdf5">${petals}</g>`
    + '<circle cx="0" cy="0" r="4.2" fill="#ffce4d"/>'
    + '</g>'
}

function tuft(x, y, scale, fill) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="${fill}">`
    + '<path d="M 0 0 C -3 -12 -10 -18 -14 -22 C -6 -20 -2 -14 0 -8 Z"/>'
    + '<path d="M 0 0 C 0 -16 -2 -24 0 -32 C 3 -22 3 -14 3 -6 Z"/>'
    + '<path d="M 2 0 C 6 -12 12 -18 17 -21 C 10 -17 6 -10 4 -4 Z"/>'
    + '</g>'
}

// The scene itself. Module-private on purpose: `installPastoralBackdrop` is the only
// entry point the game needs, and a second way to mount the same SVG would be a
// second thing to keep in sync.
function pastoralBackdropSvg() {
  const random = seeded(31415)
  const parts = []

  // ---- Sky + sun ----------------------------------------------------------
  parts.push(`<rect width="${W}" height="${H}" fill="url(#pb-sky)"/>`)
  parts.push('<ellipse cx="470" cy="120" rx="430" ry="330" fill="url(#pb-sun)"/>')

  // ---- Clouds -------------------------------------------------------------
  const clouds = [[180, 210, 1.25, 0.92], [520, 130, 0.85, 0.8], [820, 250, 1.1, 0.88],
    [1160, 150, 0.95, 0.82], [1380, 300, 0.8, 0.7], [330, 330, 0.7, 0.62]]
  parts.push(`<g filter="url(#pb-soft)">${clouds.map(([x, y, s, o]) => cloud(x, y, s, o)).join('')}</g>`)

  // ---- Far mountains ------------------------------------------------------
  parts.push(`<path d="M -40 560 L 120 402 L 250 486 L 400 348 L 560 470 L 700 392 L 840 500 L 980 420 L 1140 520 L 1290 430 L 1480 560 L 1480 ${H} L -40 ${H} Z" fill="url(#pb-far)"/>`)
  parts.push(`<path d="M -40 560 L 120 402 L 250 486 L 400 348 L 560 470 L 700 392 L 840 500 L 980 420 L 1140 520 L 1290 430 L 1480 560 L 1480 ${H} L -40 ${H} Z" fill="url(#pb-haze)" opacity="0.55"/>`)

  // ---- Mid hills ----------------------------------------------------------
  parts.push(rollingHill(640, 34, 'url(#pb-mid)', 8123))
  parts.push(rollingHill(700, 28, 'url(#pb-mid2)', 5309))

  // ---- River (drawn over the hills, under the meadow) ---------------------
  parts.push(`<path d="M 1020 596 C 900 660 1120 700 980 760 C 850 816 1060 880 940 1000 L 1240 1000 C 1300 880 1120 820 1230 754 C 1330 694 1130 660 1220 596 Z" fill="url(#pb-river)"/>`)
  parts.push(`<path d="M 1046 604 C 940 664 1140 704 1010 762 C 888 816 1090 884 984 1000 L 1060 1000 C 1160 884 968 820 1090 760 C 1216 698 1020 662 1124 602 Z" fill="#ffffff" opacity="0.28"/>`)

  // ---- Village ------------------------------------------------------------
  const village = [
    cottage(760, 596, 1.15, 'url(#pb-roof)', 'url(#pb-wall)'),
    cottage(838, 578, 0.95, 'url(#pb-roof2)', 'url(#pb-wall)'),
    cottage(920, 600, 1.05, 'url(#pb-roof)', 'url(#pb-wall)'),
    cottage(1216, 590, 0.9, 'url(#pb-roof2)', 'url(#pb-wall)'),
    cottage(1300, 606, 1.0, 'url(#pb-roof)', 'url(#pb-wall)'),
  ].join('')
  parts.push(`<g>${village}</g>`)
  // Church: the one landmark the eye can name, so the scene reads as a place.
  parts.push('<g transform="translate(1092 596)">'
    + '<rect x="-26" y="-72" width="52" height="72" rx="4" fill="url(#pb-wall)"/>'
    + '<path d="M -32 -72 L 0 -116 L 32 -72 Z" fill="url(#pb-roof)"/>'
    + '<rect x="-3" y="-134" width="6" height="20" rx="2" fill="#8a6a45"/>'
    + '<rect x="-14" y="-108" width="4" height="12" rx="2" fill="#8a6a45"/>'
    + '<rect x="-8" y="-114" width="12" height="4" rx="2" fill="#8a6a45"/>'
    + '<path d="M -9 -60 a 9 11 0 0 1 18 0 v 60 h -18 Z" fill="#b8804a"/>'
    + '<circle cx="0" cy="-92" r="7" fill="#9ed3ea"/>'
    + '</g>')

  // ---- Stone bridge -------------------------------------------------------
  parts.push('<g transform="translate(1074 742)">'
    + '<path d="M -108 0 L 108 0 L 108 26 L -108 26 Z" fill="#c9c3b4"/>'
    + '<path d="M -70 26 a 70 62 0 0 1 140 0 Z" fill="#b7b0a0"/>'
    + '<path d="M -70 26 a 70 62 0 0 1 140 0 Z" fill="#ffffff" opacity="0.18"/>'
    + '<rect x="-108" y="-12" width="216" height="14" rx="5" fill="#d8d2c4"/>'
    + '</g>')

  // ---- Tree lines ---------------------------------------------------------
  const canopyFills = ['#4f8f43', '#5da34c', '#3f7d3a']
  const treeline = []
  for (let i = 0; i < 22; i += 1) {
    const x = -20 + (W + 40) * (i / 21) + random() * 26
    const y = 608 + random() * 44
    treeline.push(tree(x, y, 0.5 + random() * 0.4, canopyFills[i % canopyFills.length]))
  }
  parts.push(`<g filter="url(#pb-soft)">${treeline.join('')}</g>`)
  parts.push(pine(300, 662, 0.86, '#3d7c3d'))
  parts.push(pine(566, 652, 0.72, '#478a44'))
  parts.push(pine(1420, 668, 0.8, '#3d7c3d'))

  // ---- Meadow -------------------------------------------------------------
  parts.push(rollingHill(790, 22, 'url(#pb-meadow)', 2207))
  parts.push(rollingHill(886, 18, 'url(#pb-meadow2)', 6601))

  // ---- Fence (left third, the reference's wooden rail) --------------------
  parts.push('<g transform="translate(50 700)">'
    + '<rect x="-14" y="-92" width="28" height="132" rx="9" fill="#a9784a"/>'
    + '<rect x="-14" y="-92" width="12" height="132" rx="6" fill="#c08d59"/>'
    + '<rect x="168" y="-72" width="26" height="118" rx="8" fill="#9f7045"/>'
    + '<rect x="168" y="-72" width="11" height="118" rx="5" fill="#b7854f"/>'
    + '<path d="M -6 -56 L 190 -40 L 190 -20 L -6 -36 Z" fill="#b4834f"/>'
    + '<path d="M -6 -6 L 190 6 L 190 26 L -6 14 Z" fill="#a9784a"/>'
    + '</g>')

  // ---- Big tree in the top-left (framing, as in the reference) ------------
  parts.push('<g filter="url(#pb-soft)">'
    + '<path d="M 152 -30 C 140 120 90 250 12 400 L -50 400 C 40 250 76 120 78 -30 Z" fill="url(#pb-bark)"/>'
    + '<path d="M 118 60 C 176 96 214 150 246 208 L 200 232 C 168 176 132 132 84 108 Z" fill="url(#pb-bark)"/>'
    + '</g>')
  const canopy = ['#5aa04a', '#4d8f40', '#6cb457', '#3f7d38']
  for (let i = 0; i < 16; i += 1) {
    const cx = -20 + random() * 360
    const cy = -60 + random() * 250 - cx * 0.35
    const r = 46 + random() * 66
    parts.push(`<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${r.toFixed(0)}" ry="${(r * 0.86).toFixed(0)}" fill="${canopy[i % canopy.length]}" opacity="0.96"/>`)
  }
  for (let i = 0; i < 9; i += 1) {
    const x = 40 + random() * 300
    const y = 90 + random() * 300
    parts.push(`<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(9 + random() * 9).toFixed(0)}" ry="${(6 + random() * 6).toFixed(0)}" fill="${canopy[i % canopy.length]}" transform="rotate(${(random() * 90 - 45).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})" opacity="0.9"/>`)
  }

  // ---- Foreground grass + flowers ----------------------------------------
  const tufts = []
  for (let i = 0; i < 54; i += 1) {
    const x = random() * W
    const y = 856 + random() * 140
    tufts.push(tuft(x, y, 0.8 + random() * 0.7, random() > 0.5 ? '#5aa845' : '#4d9440'))
  }
  parts.push(`<g opacity="0.9">${tufts.join('')}</g>`)

  const flowers = []
  const flowerSpots = []
  for (let i = 0; i < 58; i += 1) {
    const x = random() * W
    const y = 848 + random() * 150
    // Keep the middle-bottom clear: the cube's contact shadow lives there.
    if (x > 560 && x < 900 && y < 940) continue
    flowerSpots.push([x, y])
  }
  flowerSpots.forEach(([x, y], i) => {
    const scale = 0.7 + random() * 0.9
    flowers.push(daisy(x, y, scale, random() * 90 - 45))
    if (i % 3 === 0) flowers.push(`<circle cx="${(x + 34).toFixed(0)}" cy="${(y + 22).toFixed(0)}" r="${(3 + random() * 3).toFixed(1)}" fill="#ffd76a" opacity="0.9"/>`)
  })
  parts.push(`<g>${flowers.join('')}</g>`)

  // ---- Atmosphere: horizon haze + vignette -------------------------------
  parts.push(`<rect y="440" width="${W}" height="260" fill="url(#pb-haze-band)"/>`)
  parts.push(`<rect width="${W}" height="${H}" fill="url(#pb-vignette)"/>`)

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">`
    + '<defs>'
    + '<linearGradient id="pb-sky" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#57b6ea"/><stop offset="0.42" stop-color="#93d3f4"/>'
    + '<stop offset="0.72" stop-color="#cceafb"/><stop offset="1" stop-color="#eaf7ff"/>'
    + '</linearGradient>'
    + '<radialGradient id="pb-sun"><stop offset="0" stop-color="#fff8d2" stop-opacity="0.95"/>'
    + '<stop offset="0.45" stop-color="#fff4c8" stop-opacity="0.35"/><stop offset="1" stop-color="#fff4c8" stop-opacity="0"/></radialGradient>'
    + '<linearGradient id="pb-far" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#7fa6c4"/><stop offset="1" stop-color="#9dc4bd"/></linearGradient>'
    + '<linearGradient id="pb-haze" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#dfeffb" stop-opacity="0.85"/><stop offset="1" stop-color="#dfeffb" stop-opacity="0"/></linearGradient>'
    + '<linearGradient id="pb-mid" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#a9d67f"/><stop offset="1" stop-color="#7cb85c"/></linearGradient>'
    + '<linearGradient id="pb-mid2" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#95cb69"/><stop offset="1" stop-color="#6fae4e"/></linearGradient>'
    + '<linearGradient id="pb-meadow" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#8fd062"/><stop offset="1" stop-color="#69b747"/></linearGradient>'
    + '<linearGradient id="pb-meadow2" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#7cc754"/><stop offset="1" stop-color="#57a63c"/></linearGradient>'
    + '<linearGradient id="pb-river" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#9fd8f2"/><stop offset="1" stop-color="#6fb9e4"/></linearGradient>'
    + '<linearGradient id="pb-wall" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#fdf4e2"/><stop offset="1" stop-color="#eedcbb"/></linearGradient>'
    + '<linearGradient id="pb-roof" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#e7795c"/><stop offset="1" stop-color="#c8503a"/></linearGradient>'
    + '<linearGradient id="pb-roof2" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#c96a52"/><stop offset="1" stop-color="#a4432f"/></linearGradient>'
    + '<linearGradient id="pb-bark" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#a67c50"/><stop offset="0.55" stop-color="#8a613a"/><stop offset="1" stop-color="#6d4a2b"/></linearGradient>'
    + '<linearGradient id="pb-haze-band" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.3"/>'
    + '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>'
    + '<radialGradient id="pb-vignette" cx="0.5" cy="0.44" r="0.78">'
    + '<stop offset="0.55" stop-color="#1d3b1a" stop-opacity="0"/><stop offset="1" stop-color="#1d3b1a" stop-opacity="0.22"/></radialGradient>'
    + '<filter id="pb-soft" x="-20%" y="-20%" width="140%" height="140%">'
    + '<feGaussianBlur stdDeviation="3.2"/></filter>'
    + '</defs>'
    + parts.join('')
    + '</svg>'
}

// Mounted once at boot as the first child of #app. `aria-hidden` + pointer-events
// none: decoration that can be tabbed into or clicked would be a bug (03 §12).
export function installPastoralBackdrop(container) {
  if (!container || container.querySelector('.pastoral-backdrop')) return null
  const layer = document.createElement('div')
  layer.className = 'pastoral-backdrop'
  layer.setAttribute('aria-hidden', 'true')
  layer.innerHTML = pastoralBackdropSvg()
  container.prepend(layer)
  return layer
}

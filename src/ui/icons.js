// Original vector drawings; no external assets or platform-dependent emoji.
//
// v0.9.26: the cover's three actions (排行榜 / 设置 / 新游戏) are no longer targets. They carry
// cut-out PNG art now (public/art/ui-redesign/icons), and injecting a carved SVG into them would
// paint the old wood glyph next to the new art. The in-game top bar's gear is deliberately NOT
// part of that swap (handoff §7): it keeps its own asset and its own carving, so only the home
// half of the shared selector is dropped here.
const paths = {
  refresh: '<path d="M19 9a7 7 0 1 0 0 6M19 4v5h-5"/>',
  hammer: '<path fill="#a26b39" d="m6 3 6 2 5 5-4 4-5-5-4-1z"/><path fill="#75451f" d="m12 13-7 8-3-3 7-8"/>',
  rocket: '<path fill="#a26b39" d="M9 15C8 9 13 3 21 3c0 8-6 13-12 12Z"/><circle cx="16" cy="8" r="2" fill="#ffefcf"/><path d="m9 8-5 1-2 5 6-1m8 1-1 6-5 2 1-6M6 17l-3 4"/>',
  bomb: '<circle cx="11" cy="14" r="7" fill="#75451f"/><path d="m14 7 2-3h3m0-3v3m2 1-2-1"/><path d="m7 12 2-2" stroke="#ffdc9b"/>',
  settings: '<path fill="currentColor" d="m10 2-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3z" transform="translate(1 0) scale(.9)"/><circle cx="12" cy="11.5" r="3" fill="#ffefcf"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h1m4 0h1m4 0h1M6 13h1m4 0h1m4 0h1M8 16h8"/>',
}

export function installToyIcons() {
  const targets = {
    '[data-item="refresh"] .item-icon': 'refresh',
    '[data-item="hammer"] .item-icon': 'hammer',
    '[data-item="rocket"] .item-icon': 'rocket',
    '[data-item="bomb"] .item-icon': 'bomb',
    '#settings-button span': 'settings',
    '#controls-button span': 'keyboard',
  }
  let iconIndex = 0
  for (const [selector, name] of Object.entries(targets)) {
    document.querySelectorAll(selector).forEach((el) => {
      const id = `toy-carving-${name}-${iconIndex++}`
      const drawing = paths[name]
        .replaceAll('fill="#a26b39"', `fill="url(#${id}-wood)"`)
        .replaceAll('fill="#75451f"', `fill="url(#${id}-ink)"`)
        .replaceAll('fill="currentColor"', `fill="url(#${id}-ink)"`)
      el.innerHTML = `<svg class="toy-icon" viewBox="0 0 24 24" fill="none" stroke="#52270f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <defs>
          <linearGradient id="${id}-wood" x2=".35" y2="1"><stop stop-color="#c08b53"/><stop offset=".45" stop-color="#925529"/><stop offset="1" stop-color="#60300f"/></linearGradient>
          <linearGradient id="${id}-ink" x2=".3" y2="1"><stop stop-color="#8c542c"/><stop offset=".5" stop-color="#5c2e14"/><stop offset="1" stop-color="#351a0b"/></linearGradient>
        </defs>${drawing}</svg>`
    })
  }
}

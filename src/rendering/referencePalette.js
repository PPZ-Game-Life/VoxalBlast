// Visual skin only. Stable game/save RGB identities continue to work for old runs.
// Every block consumer uses this mapping through blockResources.
const lacquer = new Map([
  [0xc22b58, 0xff1644], [0x3f8fe0, 0x009aff],
  [0x293894, 0xffc400], [0x8b57c9, 0x9200ff],
  [0x217d6e, 0x00bf78], [0x2f5fc4, 0x0085ff],
  [0xe0658f, 0xff2872], [0x4faa4a, 0x00ce80],
  [0xc03fa0, 0xc300f0], [0x35b6c9, 0x00c5e8],
  [0x3fa87a, 0x00b98c], [0x90c22d, 0x8bce08],
  [0x6a5fb0, 0x5042ef], [0xa94fc4, 0x9500f5],
])
export const referencePaintColor = color => lacquer.get(color) ?? color

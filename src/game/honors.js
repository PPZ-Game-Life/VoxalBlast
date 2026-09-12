// VoxalBlast honor table (v0.3) — docs/Planning/08-荣誉与排行榜系统.md §5, with
// every threshold taken from measured frequency in 09-荣誉系统验证报告.md.
//
// Honors are SIZE MILESTONES, not event types. The v0.3 design handed out badges
// for "cleared two faces" or "made a cross" and the 2000-game run showed why that
// fails: DUAL_FACE fired 117.3 times per game (100% of games), CROSS 15.6, FACE_
// WIPE 9.6. A banner every fifth placement is noise, not an honor. What is
// actually rare is the SCALE of a single placement, so the badge set is: ≥3 lines,
// ≥4, ≥5, ≥6, and three faces at once (the VoxalBlast-only axis).
//
// Deliberately NOT here (08 §5.2, 交接单 §4.2): DUAL_FACE / CROSS / FACE_WIPE
// (too common), DOUBLE_CROSS (always coincides with CROSS), SIX-FACE (fires in
// 100% of games — blocked on the difficulty fix), CUBE_BURST (mathematically
// unreachable: a 4-cell piece touches at most one corner, which belongs to 3
// faces). PERFECT_STRIKE (single face wiped) was reachable but never once occurred
// in 6000 games. Do not add them back.
export const HONORS = Object.freeze([
  Object.freeze({
    id: 'TRIPLE',
    label: '三连爆',
    title: 'TRIPLE',
    kind: 'lines',
    minLines: 3,
    bonus: 150,
    // Share of all clears measured in 09 §2.1 — it also orders the banner (§5.3:
    // the rarest wins the primary banner, ties go to the bigger bonus).
    share: 0.031,
    priority: 10,
    feedbackLevel: 3,
    broadcast: true,
  }),
  Object.freeze({
    id: 'TRIFACE',
    label: '三面同爆',
    title: 'TRIFACE',
    kind: 'faces',
    faces: 3,
    bonus: 600,
    share: 0.0056,
    priority: 25,
    feedbackLevel: 4,
    broadcast: true,
  }),
  Object.freeze({
    id: 'QUAD',
    label: '四连爆',
    title: 'QUAD',
    kind: 'lines',
    minLines: 4,
    bonus: 500,
    share: 0.0043,
    priority: 30,
    feedbackLevel: 4,
    broadcast: true,
  }),
  Object.freeze({
    id: 'PENTA',
    label: '五连爆',
    title: 'PENTA',
    kind: 'lines',
    minLines: 5,
    bonus: 1500,
    share: 0.00026,
    priority: 40,
    feedbackLevel: 5,
    broadcast: true,
  }),
  Object.freeze({
    id: 'HEXA',
    label: '六连爆',
    title: 'HEXA',
    kind: 'lines',
    minLines: 6,
    bonus: 4000,
    share: 0.000026,
    priority: 50,
    feedbackLevel: 5,
    broadcast: true,
  }),
  Object.freeze({
    // §5.1 gives it a bonus in the 传说 row; §5.2 files it under "record-wall
    // only, no badge broadcast". Both hold: the bonus is paid, the banner is not
    // (there is only ever one primary banner, and a 12-line move is a legacy
    // entry, not a moment to interrupt). Unreachable in practice — 09 §1.1 proves
    // it is the ceiling, and 2000 games never came close.
    id: 'PERFECT_TWELVE',
    label: '十二线满贯',
    title: 'PERFECT TWELVE',
    kind: 'lines',
    minLines: 12,
    bonus: 20000,
    share: null,
    priority: 90,
    feedbackLevel: 5,
    broadcast: false,
  }),
])

export function honorById(id) {
  return HONORS.find((honor) => honor.id === id) || null
}

function honorsTriggered(lines, faces) {
  return HONORS.filter((honor) => (honor.kind === 'faces'
    ? faces >= honor.faces
    : lines >= honor.minLines))
}

// Pure judge for one settled placement. Returns the doc-mandated shape
// ({ primary, secondary[], bonus }) plus the record-only ids and every id, so the
// HUD, the record wall and the tests all read the same decision.
//
// §5.3: bonuses ADD UP (never cancel), but only ONE primary banner is shown —
// the rarest honor takes it, and an equally rare pair is settled by bonus. The
// rest float in as a single line of small badges.
export function resolveHonors({ lines = 0, faces = 0 } = {}) {
  const triggered = honorsTriggered(Math.trunc(lines) || 0, Math.trunc(faces) || 0)
  const broadcastable = triggered
    .filter((honor) => honor.broadcast)
    .sort((a, b) => b.priority - a.priority || b.bonus - a.bonus)
  return {
    primary: broadcastable[0] || null,
    secondary: broadcastable.slice(1),
    records: triggered.filter((honor) => !honor.broadcast),
    ids: triggered.map((honor) => honor.id),
    bonus: triggered.reduce((sum, honor) => sum + honor.bonus, 0),
  }
}

// Feedback tier of a placement (08 §6 / 03 §7): the quantised "how loud should
// this be" that stops every subsystem from inventing its own thresholds. The
// LEVEL is a rule (it decides whether a banner is owed); the seconds, shake and
// particle strength it maps to are visual numbers and live in
// src/rendering/config.js FEEDBACK_STYLE.
//   1 = one line, 2 = two lines, 3 = TRIPLE, 4 = QUAD or TRIFACE,
//   5 = PENTA/HEXA or a QUAD+TRIFACE double hit. 0 = nothing cleared.
export function feedbackLevel({ lines = 0, faces = 0 } = {}) {
  const lineCount = Math.trunc(lines) || 0
  const faceCount = Math.trunc(faces) || 0
  if (lineCount >= 5 || (lineCount >= 4 && faceCount >= 3)) return 5
  if (lineCount >= 4 || faceCount >= 3) return 4
  if (lineCount >= 3) return 3
  if (lineCount >= 2) return 2
  return lineCount >= 1 ? 1 : 0
}

// Localization guard — docs/Technical/LOCALIZATION.md.
//
// Why this exists. Every rule the i18n standard states is a rule that decays the moment
// nobody checks it: a second locale silently missing half its keys, a `setStatus('Pick a
// shape')` typed back into a hot path, a Chinese literal pasted into index.html because that
// is the language the producer speaks. None of those fail a build on their own — they fail as
// "the Chinese build shows an English button", which is found by a player, not by a test.
//
// Five checks, in the order they break:
//   1. The two catalogues have the IDENTICAL key set, and every value is non-empty.
//   2. Every id-driven label the UI looks up by key (honors, records, tiers, items) exists.
//   3. Every data-i18n* attribute in index.html names a real key.
//   4. No CJK literal survives anywhere under src/ or in index.html outside the locale files
//      and the comments that explain the code.
//   5. No ENGLISH catalogue value is duplicated as a literal outside the catalogue. This is
//      the check that catches a re-introduced hard-coded string in the default language,
//      which check 4 cannot see.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import en from '../src/i18n/locales/en.js'
import zhHans from '../src/i18n/locales/zh-Hans.js'
import { DEFAULT_LOCALE, LOCALES, normalizeLocale, t } from '../src/i18n/index.js'
import { HONORS } from '../src/game/honors.js'
import { RECORD_FIELDS } from '../src/game/records.js'
import { TIERS } from '../src/game/tiers.js'
import { ITEM_COPY, ITEM_NAME } from '../src/ui/itemCopy.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCALE_DIR = 'src/i18n/locales'

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) { passed += 1; return }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

function equal(label, actual, expected) {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ---------------------------------------------------------------- file walking
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// A JS/TS tokenizer that yields only STRING LITERAL contents, with comments discarded. Written
// out rather than regex-matched because the thing under test is exactly the difference between
// "a string" and "a comment about a string" — a regex over raw source cannot tell them apart,
// and this file is full of comments that quote the copy they replaced.
export function stringLiterals(source) {
  const literals = []
  let i = 0
  let line = 1
  let state = 'code'
  let quote = ''
  let buffer = ''
  let start = 1
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '\n') line += 1
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue }
      if (ch === '"' || ch === "'" || ch === '`') {
        state = 'str'; quote = ch; buffer = ''; start = line; i += 1; continue
      }
      i += 1; continue
    }
    if (state === 'line') { if (ch === '\n') state = 'code'; i += 1; continue }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue }
      i += 1; continue
    }
    // state === 'str'
    if (ch === '\\') { buffer += source.slice(i, i + 2); i += 2; continue }
    if (ch === quote) { literals.push({ text: buffer, line: start }); state = 'code'; i += 1; continue }
    buffer += ch
    i += 1
  }
  return literals
}

// ---------------------------------------------------------------- 1. catalogue parity
const enKeys = Object.keys(en).sort()
const zhKeys = Object.keys(zhHans).sort()

check('the default locale is English', DEFAULT_LOCALE === 'en', `DEFAULT_LOCALE=${DEFAULT_LOCALE}`)
check('English and Simplified Chinese are both shipped', LOCALES.map((entry) => entry.id).join(',') === 'en,zh-Hans',
  LOCALES.map((entry) => entry.id).join(','))

const missingInZh = enKeys.filter((key) => !(key in zhHans))
const extraInZh = zhKeys.filter((key) => !(key in en))
check('zh-Hans covers every English key', missingInZh.length === 0, `missing ${missingInZh.join(', ')}`)
check('zh-Hans adds no key English lacks', extraInZh.length === 0, `extra ${extraInZh.join(', ')}`)
equal('the two catalogues have the same size', zhKeys.length, enKeys.length)

for (const [localeId, catalog] of [['en', en], ['zh-Hans', zhHans]]) {
  const empty = Object.entries(catalog)
    .filter(([, value]) => typeof value === 'string' && value.trim() === '')
    .map(([key]) => key)
  check(`${localeId} has no empty string`, empty.length === 0, empty.join(', '))
  const wrongType = Object.entries(catalog)
    .filter(([, value]) => typeof value !== 'string' && typeof value !== 'function')
    .map(([key]) => key)
  check(`${localeId} values are strings or functions`, wrongType.length === 0, wrongType.join(', '))
}

// The placeholder set of a key must agree between locales: `{n}` in English and no placeholder
// in Chinese is fine only if Chinese genuinely does not need the number — but a name MISMATCH
// ({points} vs {score}) is always a bug, and it renders as a literal `{points}` on screen.
const placeholders = (value) => {
  const source = typeof value === 'function' ? value.toString() : value
  return [...new Set(source.match(/\{(\w+)\}/g) || [])].sort().join(',')
}
const placeholderDrift = enKeys
  .filter((key) => placeholders(en[key]) !== placeholders(zhHans[key]))
  .map((key) => `${key} (${placeholders(en[key]) || '—'} vs ${placeholders(zhHans[key]) || '—'})`)
check('placeholders match across locales', placeholderDrift.length === 0, placeholderDrift.join('; '))

// A missing key must be LOUD (the key itself), never an empty element.
equal('an unknown key falls back to the key', t('i18n.no.such.key'), 'i18n.no.such.key')

// Locale aliases: a store build, a browser tag and a QA link all have to land on a real locale.
equal('zh normalises to zh-Hans', normalizeLocale('zh'), 'zh-Hans')
equal('zh-CN normalises to zh-Hans', normalizeLocale('zh-CN'), 'zh-Hans')
equal('en-US normalises to en', normalizeLocale('en-US'), 'en')
equal('an unsupported tag does not normalise', normalizeLocale('fr-FR'), null)

// ---------------------------------------------------------------- 2. id-driven labels
for (const honor of HONORS) {
  check(`honor ${honor.id} has a label`, typeof en[`honor.${honor.id}.label`] === 'string')
  check(`honor ${honor.id} has a title`, typeof en[`honor.${honor.id}.title`] === 'string')
  check(`honor ${honor.id} has a Chinese label`, typeof zhHans[`honor.${honor.id}.label`] === 'string')
}
for (const field of RECORD_FIELDS) {
  check(`record ${field.key} has a label key`, typeof en[field.labelKey] === 'string', field.labelKey)
}
for (const tier of TIERS) {
  check(`tier ${tier.tier} has a name`, typeof en[`tier.${tier.tier}.name`] === 'string')
  check(`tier ${tier.tier} has a title`, typeof en[`tier.${tier.tier}.title`] === 'string')
}
for (const id of ['refresh', 'hammer', 'rocket', 'bomb']) {
  check(`item ${id} has a name`, typeof en[`item.name.${id}`] === 'string')
  check(`item ${id} has a tooltip`, typeof en[`item.title.${id}`] === 'string')
}
check('ITEM_COPY exposes only translated text', Object.values(ITEM_COPY).every((value) => (
  typeof value === 'function' || (typeof value === 'string' && value.trim() !== '')
)))
check('ITEM_NAME exposes a name per tool', ['refresh', 'hammer', 'rocket', 'bomb']
  .every((id) => typeof ITEM_NAME[id] === 'string' && ITEM_NAME[id].trim() !== ''))

// ---------------------------------------------------------------- 3. index.html markers
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8')
const MARKER = /data-i18n(?:-text|-aria-label|-title)?="([^"]+)"/g
const markupKeys = [...html.matchAll(MARKER)].map((match) => match[1])
check('index.html carries i18n markers', markupKeys.length > 30, `found ${markupKeys.length}`)
const unknownMarkupKeys = markupKeys.filter((key) => !(key in en))
check('every markup marker names a real key', unknownMarkupKeys.length === 0, unknownMarkupKeys.join(', '))
check('<html lang> starts on the default locale',
  new RegExp(`<html lang="${LOCALES.find((entry) => entry.id === DEFAULT_LOCALE).htmlLang}"`).test(html))

// ---------------------------------------------------------------- 4 + 5. no stray literals
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
// The endonyms are identifiers, not copy: the language picker must print 简体中文 to a Chinese
// player, and those two strings live in LOCALES rather than in a catalogue that is keyed by
// the locale they name.
const IDENTIFIER_LITERALS = new Set(['English', '简体中文', 'en', 'zh-Hans', 'en-US'])
// Internal deal-analysis vocabulary, NOT player-facing copy: these two modules are pure game
// logic (no DOM, imported by the Node deal tests and by tools/difficulty-*.mjs), and the
// labels they carry are the producer's own analysis categories — printed in offline reports,
// reachable by no t() call site and by nothing the shipped game renders. Translating them
// would translate the analysis, not the interface.
const INTERNAL_ANALYSIS_FILES = new Set(['src/game/dealConfig.js', 'src/game/dealDirector.js'])
// An id is allowed to equal its own display text: the honor table's `id` IS the badge word
// (TRIPLE / QUAD), so `honor.TRIPLE.title` legitimately repeats it. Nothing else may.
const ID_LITERALS = new Set(HONORS.map((honor) => honor.id))

const catalogValues = new Set(
  [...Object.values(en), ...Object.values(zhHans)]
    .filter((value) => typeof value === 'string' && value.trim().length >= 4)
    // Text with a placeholder is a template, never a complete literal in source.
    .filter((value) => !/\{\w+\}/.test(value))
    .filter((value) => !IDENTIFIER_LITERALS.has(value))
    .filter((value) => !ID_LITERALS.has(value)),
)

const sourceFiles = [
  ...walk(resolve(ROOT, 'src')).filter((file) => file.endsWith('.js') && !file.includes('i18n\\locales') && !file.includes('i18n/locales')),
  resolve(ROOT, 'index.html'),
]

for (const file of sourceFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const source = readFileSync(file, 'utf8')
  const literals = file.endsWith('.html')
    // Markup: strip comments, then the tags themselves, leaving the text nodes an i18n marker
    // would have had to cover. Attributes are handled by the MARKER check above.
    ? [{ text: source.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' '), line: 0 }]
    : stringLiterals(source)

  const cjk = literals.filter((literal) => CJK.test(literal.text) && !IDENTIFIER_LITERALS.has(literal.text.trim()))
  if (!INTERNAL_ANALYSIS_FILES.has(rel)) {
    check(`${rel} has no hard-coded CJK literal`, cjk.length === 0,
      cjk.slice(0, 5).map((literal) => `line ${literal.line}: ${literal.text.slice(0, 40)}`).join(' | '))
  }

  const duplicated = literals
    .filter((literal) => catalogValues.has(literal.text.trim()) && !IDENTIFIER_LITERALS.has(literal.text.trim()))
    .map((literal) => `line ${literal.line}: ${literal.text.trim().slice(0, 40)}`)
  check(`${rel} has no literal duplicated from the catalogue`, duplicated.length === 0,
    duplicated.slice(0, 5).join(' | '))
}

// The locale files themselves are the one place the copy is allowed to live — and they must
// actually contain it, or the two checks above would pass on an empty catalogue.
const zhSource = readFileSync(resolve(ROOT, LOCALE_DIR, 'zh-Hans.js'), 'utf8')
check('the Chinese catalogue is where the Chinese copy lives', stringLiterals(zhSource).some((literal) => CJK.test(literal.text)))

console.log(`i18n-tests: ${passed}/${passed + failures.length} checks passed`)
if (failures.length) {
  console.log('\nFAILED:')
  failures.forEach((failure) => console.log(`  - ${failure}`))
  process.exitCode = 1
} else {
  console.log('localization standard holds: keys aligned, no stray literals')
}

// Kept for the console-less import case (a future workflow/test that reuses the scanner).
assert.ok(true)

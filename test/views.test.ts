/**
 * View-layer tests.
 *
 * The presentation layer had no coverage at all, so a rendering regression was
 * invisible to CI. These cover the one piece of view logic that reorders
 * report data — the AX meter — because getting it wrong either scrambles the
 * gauge or, worse, mutates the report that gets signed.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { meterSegments } from '../src/views.js'
import { FAVICON_GROUND, FAVICON_MARK } from '../src/worker.js'
import type { AxScore, Verdict } from '../src/types.js'

type Item = AxScore['items'][number]

/** Ten AX items in checklist order, with the supplied verdicts. */
function items(verdicts: Verdict[]): Item[] {
  return verdicts.map((verdict, idx) => ({
    item: idx + 1,
    id: `check-${idx + 1}`,
    title: `check ${idx + 1}`,
    verdict,
  }))
}

const P: Verdict = 'pass'
const F: Verdict = 'fail'
const S: Verdict = 'skip'

describe('meterSegments', () => {
  it('groups passes left and fails right when verdicts are interleaved', () => {
    // checklist order puts red at slots 3, 5 and 8 — mid-strip, which is the
    // "random looking" bar this exists to fix
    const ordered = meterSegments(items([P, P, F, P, F, P, P, F, P, P]))
    expect(ordered.map((i) => i.verdict)).toEqual([P, P, P, P, P, P, P, F, F, F])
  })

  it('places skips between passes and fails, so red is always the far right', () => {
    const ordered = meterSegments(items([F, S, P, F, S, P, P, S, F, P]))
    expect(ordered.map((i) => i.verdict)).toEqual([P, P, P, P, S, S, S, F, F, F])
    expect(ordered[ordered.length - 1]?.verdict).toBe(F)
    expect(ordered[0]?.verdict).toBe(P)
  })

  it('is stable: checklist order is preserved inside each verdict group', () => {
    const ordered = meterSegments(items([F, P, F, P, F, P, F, P, F, P]))
    expect(ordered.filter((i) => i.verdict === P).map((i) => i.item)).toEqual([2, 4, 6, 8, 10])
    expect(ordered.filter((i) => i.verdict === F).map((i) => i.item)).toEqual([1, 3, 5, 7, 9])
  })

  it('does NOT mutate the source array — it is serialized into the signed report', () => {
    const source = items([F, P, F, P, P, P, P, P, P, P])
    const before = source.map((i) => `${i.item}:${i.verdict}`)
    const ordered = meterSegments(source)

    expect(source.map((i) => `${i.item}:${i.verdict}`)).toEqual(before)
    expect(source[0]?.verdict).toBe(F) // still checklist order
    expect(ordered).not.toBe(source)
  })

  it('leaves an all-pass report untouched and keeps segment count', () => {
    const source = items(Array<Verdict>(10).fill(P))
    const ordered = meterSegments(source)
    expect(ordered).toHaveLength(10)
    expect(ordered.map((i) => i.item)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('handles an all-fail report', () => {
    const ordered = meterSegments(items(Array<Verdict>(10).fill(F)))
    expect(ordered.every((i) => i.verdict === F)).toBe(true)
    expect(ordered.map((i) => i.item)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('handles an empty item list without throwing', () => {
    expect(meterSegments([])).toEqual([])
  })
})

/**
 * Token-drift guards. Both of these defects actually shipped: --term-bg
 * color-mixed a hardcoded copy of --plate and kept the old value when --plate
 * moved, and the SVG favicon painted on the pre-56206a6 plate while its PNG
 * siblings moved — the same site served two favicons on two different grounds.
 * A value copied instead of referenced is correct exactly until the source
 * moves, and nothing else in the toolchain notices.
 */
describe('token drift', () => {
  const views = readFileSync(new URL('../src/views.ts', import.meta.url), 'utf8')

  /** Declared values from a :root block, keyed by token name. */
  function tokens(block: string): Map<string, string> {
    const out = new Map<string, string>()
    for (const m of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim())
    return out
  }
  const darkBlock = views.slice(views.indexOf('@media (prefers-color-scheme: dark)'))
  const dark = tokens(darkBlock.slice(0, darkBlock.indexOf('}`')))

  /**
   * Coincidences that are NOT copies. Each must be justified, because the whole
   * point of the check is that a human declares intent rather than the equality
   * passing silently. --teal-ink is "ink on a teal fill"; in dark it happens to
   * equal --paper, but in LIGHT the two differ, so referencing would be
   * correct-by-accident and would break if --paper moved.
   */
  const ALLOWED_COINCIDENCES = [['paper', 'teal-ink']]

  it('no token value is duplicated verbatim — a duplicate IS a copy waiting to drift', () => {
    const seen = new Map<string, string[]>()
    for (const [name, value] of dark) {
      if (value.startsWith('var(') || value.startsWith('color-mix')) continue
      seen.set(value, [...(seen.get(value) ?? []), name])
    }
    for (const pair of ALLOWED_COINCIDENCES) {
      for (const [value, names] of seen) {
        if (pair.every((n) => names.includes(n))) seen.set(value, names.filter((n) => !pair.includes(n)))
      }
    }
    const dupes = [...seen.entries()].filter(([, names]) => names.length > 1)
    expect(dupes, `duplicated dark token values: ${JSON.stringify(dupes)}`).toEqual([])
  })

  it('composed tokens reference other tokens rather than inlining their values', () => {
    for (const [name, value] of dark) {
      if (!value.startsWith('color-mix')) continue
      expect(value, `--${name} inlines a literal instead of referencing a token`).toMatch(/var\(--/)
    }
  })

  it('the SVG favicon uses the same ground and mark as the generated PNG icons', () => {
    expect(FAVICON_GROUND).toBe(dark.get('paper'))
    expect(FAVICON_MARK).toBe(dark.get('teal'))
  })
})

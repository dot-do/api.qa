/**
 * View-layer tests.
 *
 * The presentation layer had no coverage at all, so a rendering regression was
 * invisible to CI. These cover the one piece of view logic that reorders
 * report data — the AX meter — because getting it wrong either scrambles the
 * gauge or, worse, mutates the report that gets signed.
 */

import { describe, it, expect } from 'vitest'
import { meterSegments } from '../src/views.js'
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

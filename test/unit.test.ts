import { describe, it, expect } from 'vitest'
import { validateSchema, readPath } from '../src/schema.js'
import { canonicalJson, sha256Hex, sampleSeeded } from '../src/digest.js'
import { normalizeTarget } from '../src/http.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import type { CheckResult } from '../src/types.js'

describe('mini schema validator', () => {
  it('validates types, required, items, enum, const', () => {
    expect(validateSchema({ ok: true, n: 3 }, {
      type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, n: { type: 'integer' } },
    })).toEqual([])
    expect(validateSchema({ n: 3.5 }, { type: 'object', properties: { n: { type: 'integer' } } }))
      .toHaveLength(1)
    expect(validateSchema([{ id: 'a' }, {}], { type: 'array', items: { type: 'object', required: ['id'] } }))
      .toHaveLength(1)
    expect(validateSchema('red', { enum: ['red', 'blue'] })).toEqual([])
    expect(validateSchema('green', { enum: ['red', 'blue'] })).toHaveLength(1)
    expect(validateSchema('api.qa', { const: 'api.qa' })).toEqual([])
  })

  it('readPath walks objects and arrays', () => {
    expect(readPath({ a: { b: [{ c: 42 }] } }, 'a.b.0.c')).toEqual({ found: true, value: 42 })
    expect(readPath({ a: 1 }, 'a.b')).toEqual({ found: false })
  })
})

describe('canonical json + digests', () => {
  it('sorts keys and drops undefined', async () => {
    expect(canonicalJson({ b: 1, a: 2, z: undefined })).toBe('{"a":2,"b":1}')
    expect(await sha256Hex('x')).toHaveLength(64)
  })

  it('seeded sampling is deterministic per seed', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    expect(sampleSeeded(items, 3, 7)).toEqual(sampleSeeded(items, 3, 7))
  })
})

describe('target normalization (SSRF guards)', () => {
  it('accepts public hosts, defaults https', () => {
    expect(normalizeTarget('example.com')).toEqual({ origin: 'https://example.com' })
    expect(normalizeTarget('http://api.example.com/path')).toEqual({ origin: 'http://api.example.com' })
  })
  it('refuses private/IP/single-label targets unless allowed', () => {
    for (const bad of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', 'internal', 'foo.local', '[::1]']) {
      expect('error' in normalizeTarget(bad)).toBe(true)
    }
    expect(normalizeTarget('localhost:8787', true)).toEqual({ origin: 'https://localhost:8787' })
  })
})

describe('grading', () => {
  const mk = (passes: number, honesty: 'pass' | 'fail' = 'pass'): CheckResult[] => [
    ...Array.from({ length: 10 }, (_, i): CheckResult => ({
      id: `ax-${i + 1}`, title: `item ${i + 1}`, axItem: i + 1,
      verdict: i < passes ? 'pass' : 'fail', detail: '', evidence: [],
    })),
    { id: 'claims-honesty', title: 'honesty', verdict: honesty, detail: '', evidence: [] },
  ]

  it('maps points to letters', () => {
    expect(gradeOf(axScoreOf(mk(10)), mk(10)).grade).toBe('A+')
    expect(gradeOf(axScoreOf(mk(9)), mk(9)).grade).toBe('A')
    expect(gradeOf(axScoreOf(mk(7)), mk(7)).grade).toBe('B')
    expect(gradeOf(axScoreOf(mk(5)), mk(5)).grade).toBe('C')
    expect(gradeOf(axScoreOf(mk(3)), mk(3)).grade).toBe('D')
    expect(gradeOf(axScoreOf(mk(1)), mk(1)).grade).toBe('F')
  })

  it('honesty failure caps an otherwise perfect target at C', () => {
    const checks = mk(10, 'fail')
    const { grade, notes } = gradeOf(axScoreOf(checks), checks)
    expect(grade).toBe('C')
    expect(notes[0]).toMatch(/lying surface/)
  })

  it('honesty failure does not lift a bad grade', () => {
    const checks = mk(1, 'fail')
    expect(gradeOf(axScoreOf(checks), checks).grade).toBe('F')
  })
})

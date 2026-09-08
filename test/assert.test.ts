/**
 * autonomous-qa/assert — the runtime-agnostic gate. Same verdicts as the
 * vitest matchers, no vitest import (so it links inside workerd, where the
 * Cloudflare test pool externalizes node_modules).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertConforms, assertGradeAtLeast, conformance } from '../src/assert.js'
import { goodTargetRoutes, makeWorker, withoutRoutes } from './helpers.js'

const BASE = 'https://local.test'
const goldenSpec = readFileSync(fileURLToPath(new URL('../examples/golden-scenario.spec.json', import.meta.url)), 'utf8')

describe('autonomous-qa/assert', () => {
  it('the module never links vitest at load time', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/assert.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/^import .* from 'vitest'/m)
    const vt = readFileSync(fileURLToPath(new URL('../src/vitest.ts', import.meta.url)), 'utf8')
    // vitest.ts may import TYPES only; a value import would break the Workers pool.
    expect(vt).not.toMatch(/^import (?!type )[^;]* from 'vitest'/m)
  })

  it('assertConforms resolves for a clean surface and throws with detail for a broken one', async () => {
    await expect(assertConforms(makeWorker(goodTargetRoutes(BASE), BASE))).resolves.toBeUndefined()
    const broken = makeWorker(withoutRoutes(goodTargetRoutes(BASE), 'GET /openapi.json'), BASE)
    await expect(assertConforms(broken)).rejects.toThrow(/expected target to conform/)
  })

  it('conformance() exposes the report behind the verdict (pinned mode)', async () => {
    const worker = makeWorker(goodTargetRoutes(BASE), BASE)
    const out = await conformance(worker, goldenSpec)
    expect(out.report).toMatchObject({ $type: 'PinnedVerificationReport', spec: { name: 'primitives-golden-scenario' } })
    expect(typeof out.message()).toBe('string')
  })

  it('assertGradeAtLeast honours the threshold', async () => {
    const worker = makeWorker(goodTargetRoutes(BASE), BASE)
    await expect(assertGradeAtLeast(worker, 'F')).resolves.toBeUndefined()
  })
})

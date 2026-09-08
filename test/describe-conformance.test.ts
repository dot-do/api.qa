/**
 * describeConformance — one vitest case per pinned requirement, with the
 * vitest API supplied explicitly (the Workers-pool shape) and via globals.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describeConformance, registerConformanceMatchers, matchersReady } from '../src/vitest.js'
import { goodTargetRoutes, makeWorker, withOverrides, type Routes } from './helpers.js'

const BASE = 'https://local.test'
const goldenSpec = readFileSync(fileURLToPath(new URL('../examples/golden-scenario.spec.json', import.meta.url)), 'utf8')
function json200(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

function goldenRoutes(origin: string, overrides: Routes = {}): Routes {
  return withOverrides(goodTargetRoutes(origin), {
    'POST /golden/run': (req) => {
      const body = JSON.parse(req.body ?? '{}') as { scenario?: string }
      if (body.scenario === 'dealer-slice') {
        return json200({ settled: true, ledgerBalanced: true, path: ['lead', 'prequal', 'deal', 'approve', 'deliver', 'settle'] })
      }
      if (body.scenario === 'dealer-slice-escalation') {
        return json200({ settled: true, ledgerBalanced: true, escalatedToHumanDesk: true, path: ['lead', 'prequal', 'deal', 'escalate', 'approve', 'deliver', 'settle'] })
      }
      return { status: 422, contentType: 'application/json', body: '{"error":"unknown scenario"}' }
    },
    ...overrides,
  })
}

const worker = makeWorker(goldenRoutes(BASE), BASE)

// Explicit API — what a test inside @cloudflare/vitest-pool-workers passes.
describeConformance({ target: worker, spec: goldenSpec, name: 'golden (explicit api)' }, { describe, it, beforeAll, expect })

describe('describeConformance plumbing', () => {
  it('throws a pointed error when no vitest API is reachable', () => {
    const saved = { describe: (globalThis as any).describe, it: (globalThis as any).it }
    delete (globalThis as any).describe
    delete (globalThis as any).it
    try {
      expect(() => describeConformance({ target: worker, spec: goldenSpec })).toThrow(/pass \{ describe, it, beforeAll, expect \}/)
    } finally {
      Object.assign(globalThis, saved)
    }
  })

  it('registers the matchers on an explicit expect, once', async () => {
    const calls: unknown[] = []
    const fake = { extend: (m: unknown) => calls.push(m) }
    expect(registerConformanceMatchers(fake)).toBe(true)
    expect(registerConformanceMatchers(fake)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0] as object)).toEqual(['toConform', 'toGradeAtLeast'])
    await expect(matchersReady).resolves.toBe(true) // Node: the lazy import('vitest') landed
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { verifyPinnedSpec } from '../src/pinned.js'
import { sha256Hex } from '../src/digest.js'
import { goodTargetRoutes, makeFetcher, withOverrides, GOOD, type Routes } from './helpers.js'

const SPEC_PATH = fileURLToPath(new URL('../examples/golden-scenario.spec.json', import.meta.url))
const specText = readFileSync(SPEC_PATH, 'utf8')

/** The weekend build's dev surface, implementing the golden scenario. */
function goldenTargetRoutes(overrides: Routes = {}): Routes {
  return withOverrides(goodTargetRoutes(), {
    'POST /golden/run': (req) => {
      const body = JSON.parse(req.body ?? '{}') as { scenario?: string }
      if (body.scenario === 'dealer-slice') {
        return json200({
          settled: true, ledgerBalanced: true,
          path: ['lead', 'prequal', 'deal', 'approve', 'deliver', 'settle'],
        })
      }
      if (body.scenario === 'dealer-slice-escalation') {
        return json200({
          settled: true, ledgerBalanced: true, escalatedToHumanDesk: true,
          path: ['lead', 'prequal', 'deal', 'escalate', 'approve', 'deliver', 'settle'],
        })
      }
      return { status: 422, contentType: 'application/json', body: '{"error":"unknown scenario"}' }
    },
    ...overrides,
  })
}

function json200(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

describe('pinned-spec mode (the X1 harness)', () => {
  it('passes a target that implements the pinned golden scenario', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(goldenTargetRoutes()), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    expect(report.spec.digest).toBe(await sha256Hex(specText))
    expect(report.attested).toBe(false) // local runs never sign
  })

  it('fails when the ledger does not balance (and says why)', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(goldenTargetRoutes({
        'POST /golden/run': (req) => {
          const body = JSON.parse(req.body ?? '{}') as { scenario?: string }
          if (body.scenario === 'not-a-scenario') return { status: 422, contentType: 'application/json', body: '{}' }
          return json200({ settled: true, ledgerBalanced: false, path: ['lead'], escalatedToHumanDesk: true })
        },
      })),
      delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    const failing = report.requirements.find((r) => r.id === 'golden-run-settles')
    expect(failing?.verdict).toBe('fail')
    expect(failing?.detail).toMatch(/ledgerBalanced/)
  })

  it('REFUSES to run when the spec text does not hash to the pin (anti-Goodhart gate)', async () => {
    const editedByTheFleet = specText.replace('"equals": true', '"equals": false')
    const honestPin = await sha256Hex(specText)
    await expect(
      verifyPinnedSpec(GOOD, editedByTheFleet, {
        fetcher: makeFetcher(goldenTargetRoutes()), delayMs: 0, mode: 'local',
        expectedDigest: honestPin,
      }),
    ).rejects.toThrow(/digest mismatch/)
  })

  it('runs when the supplied text matches the pin exactly', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(goldenTargetRoutes()), delayMs: 0, seed: 1, mode: 'local',
      expectedDigest: await sha256Hex(specText),
    })
    expect(report.passed).toBe(true)
  })

  it('numeric comparators express a pinned floor (gte/gt/lte/lt) held in the spec, not the target', async () => {
    // A ratchet-style spec: the target reports `passed`, the PINNED contract owns
    // the floor. 7 >= 5 passes; the same run fails a floor of 9.
    const ratchetSpec = JSON.stringify({
      $type: 'PinnedSpec',
      name: 'ratchet',
      version: '1',
      requirements: [
        {
          id: 'subset-floor',
          kind: 'endpoint',
          method: 'POST',
          path: '/subset/run',
          body: { seed: 1 },
          expect: {
            status: 200,
            paths: [
              { path: 'passed', gte: 5 },
              { path: 'failed', lte: 3 },
              { path: 'passed', gt: 0 },
            ],
          },
        },
      ],
    })
    const routes = withOverrides(goodTargetRoutes(), {
      'POST /subset/run': () => json200({ passed: 7, failed: 2, total: 9 }),
    })
    const pass = await verifyPinnedSpec(GOOD, ratchetSpec, {
      fetcher: makeFetcher(routes), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(pass.passed, JSON.stringify(pass.requirements, null, 2)).toBe(true)

    // Raise the floor above what the target reports: the same target now fails.
    const higherFloor = ratchetSpec.replace('"gte":5', '"gte":9')
    const fail = await verifyPinnedSpec(GOOD, higherFloor, {
      fetcher: makeFetcher(routes), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(fail.passed).toBe(false)
    expect(fail.requirements.find((r) => r.id === 'subset-floor')?.detail).toMatch(/wanted >= 9/)
  })

  it('a numeric comparator on a missing or non-numeric path fails', async () => {
    const spec = JSON.stringify({
      $type: 'PinnedSpec',
      name: 'numeric-guard',
      version: '1',
      requirements: [
        {
          id: 'needs-number',
          kind: 'endpoint',
          method: 'POST',
          path: '/subset/run',
          body: {},
          expect: { status: 200, paths: [{ path: 'passed', gte: 1 }] },
        },
      ],
    })
    const routes = withOverrides(goodTargetRoutes(), {
      'POST /subset/run': () => json200({ passed: 'seven' }),
    })
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(routes), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'needs-number')?.detail).toMatch(/wanted a number >= 1/)
  })

  it('surface requirements reuse the AX judges', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(withOverrides(goldenTargetRoutes(), {
        'GET /openapi.json': () => ({ status: 200, contentType: 'application/json', body: '{"not":"openapi"}' }),
      })),
      delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.requirements.find((r) => r.id === 'openapi-published')?.verdict).toBe('fail')
  })
})

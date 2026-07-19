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

/**
 * The ESTATE GATE (ax-laf) — run api.qa's pinned gate across a SET of surfaces
 * and turn the whole set into ONE pass/fail + a scoreboard. The property under
 * test is the one that matters for a CI gate: the runner exits NON-ZERO iff a
 * REQUIRED surface fails its pinned spec (or errors), and ZERO when all pass.
 *
 * Every surface here is an in-process handler dispatched in memory (no socket,
 * no DNS, no network) — a conforming mini-worker (passes the golden pinned
 * spec) and a non-conforming one (missing the golden endpoint → passed:false).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runEstateGate, formatScoreboard, type GateEntry } from '../src/gate.js'
import { goodTargetRoutes, makeWorker, withOverrides, withoutRoutes, type Routes } from './helpers.js'

const BASE = 'https://local.test'
const SPEC_PATH = fileURLToPath(new URL('../examples/golden-scenario.spec.json', import.meta.url))
const goldenSpec = readFileSync(SPEC_PATH, 'utf8')

/** A surface that CONFORMS to the golden pinned spec. */
function conformingRoutes(origin: string): Routes {
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
  })
}

function json200(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

const conformingWorker = (): GateEntry['target'] => makeWorker(conformingRoutes(BASE), BASE)
// A worker with no /golden/run endpoint → fails the pinned spec.
const brokenWorker = (): GateEntry['target'] => makeWorker(goodTargetRoutes(BASE), BASE)

describe('runEstateGate() — the estate-wide CI gate', () => {
  it('exits ZERO when every required surface passes its pinned spec', async () => {
    const result = await runEstateGate([
      { surface: 'alpha', target: conformingWorker(), specText: goldenSpec, seed: 1 },
      { surface: 'beta', target: conformingWorker(), specText: goldenSpec, seed: 1 },
    ])
    expect(result.exitCode, JSON.stringify(result.rows, null, 2)).toBe(0)
    expect(result.failed).toEqual([])
    expect(result.rows.every((r) => r.passesPinnedSpec === true)).toBe(true)
    // Scoreboard renders a grade + score for each passing surface.
    for (const r of result.rows) expect(r.grade).not.toBeNull()
  })

  it('exits NON-ZERO when a REQUIRED surface fails its pinned spec', async () => {
    const result = await runEstateGate([
      { surface: 'alpha', target: conformingWorker(), specText: goldenSpec, seed: 1 },
      { surface: 'beta', target: brokenWorker(), specText: goldenSpec, seed: 1 },
    ])
    expect(result.exitCode).toBe(1)
    expect(result.failed).toEqual(['beta'])
    const beta = result.rows.find((r) => r.surface === 'beta')!
    expect(beta.passesPinnedSpec).toBe(false)
    expect(beta.failedRequirements.length).toBeGreaterThan(0)
  })

  it('a NON-required failing surface does NOT fail the gate (advisory only)', async () => {
    const result = await runEstateGate([
      { surface: 'alpha', target: conformingWorker(), specText: goldenSpec, seed: 1 },
      { surface: 'beta', target: brokenWorker(), specText: goldenSpec, required: false, seed: 1 },
    ])
    expect(result.exitCode).toBe(0)
    expect(result.failed).toEqual([])
    const beta = result.rows.find((r) => r.surface === 'beta')!
    expect(beta.passesPinnedSpec).toBe(false) // reported honestly, just non-gating
  })

  it('an entry with NO spec is advisory-only: grade reported, never a pinned failure', async () => {
    const result = await runEstateGate([
      { surface: 'advisory', target: conformingWorker(), seed: 1 },
    ])
    expect(result.exitCode).toBe(0)
    const row = result.rows[0]!
    expect(row.hasSpec).toBe(false)
    expect(row.passesPinnedSpec).toBeNull()
    expect(row.grade).not.toBeNull()
  })

  it('a required entry that ERRORS (digest-pin mismatch) fails the gate with the error surfaced', async () => {
    const result = await runEstateGate([
      // A wrong expected digest makes gradePinned throw before any probe runs.
      { surface: 'pinned', target: conformingWorker(), specText: goldenSpec, expectedDigest: 'deadbeef', seed: 1 },
    ])
    expect(result.exitCode).toBe(1)
    expect(result.failed).toEqual(['pinned'])
    expect(result.rows[0]!.error).not.toBeNull()
  })

  it('formatScoreboard renders a table + a verdict line', async () => {
    const passing = await runEstateGate([{ surface: 'alpha', target: conformingWorker(), specText: goldenSpec, seed: 1 }])
    const board = formatScoreboard(passing)
    expect(board).toContain('| surface | target | grade | score | pinned spec | required |')
    expect(board).toContain('GATE PASSED')

    const failing = await runEstateGate([{ surface: 'beta', target: brokenWorker(), specText: goldenSpec, seed: 1 }])
    expect(formatScoreboard(failing)).toContain('GATE FAILED')
  })

  // Anti-Goodhart: an empty-requirements spec must never vacuously pass a gate.
  it('refuses to gate on an empty-requirements spec (surfaces the error, fails required)', async () => {
    const emptySpec = JSON.stringify({ $type: 'PinnedSpec', name: 'empty', version: '1', requirements: [] })
    const result = await runEstateGate([{ surface: 'empty', target: conformingWorker(), specText: emptySpec, seed: 1 }])
    expect(result.exitCode).toBe(1)
    expect(result.rows[0]!.error).toMatch(/no requirements|vacuous/i)
  })
})

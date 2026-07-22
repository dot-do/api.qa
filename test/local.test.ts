/**
 * The LOCAL runner — grade a surface IN-PROCESS (pre-deploy), for the dev
 * inner-loop, the vitest gate, and CI. Every test here is hermetic: no socket,
 * no DNS, no network. The in-process fetcher dispatches each probe Request to
 * the handler in memory.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { grade, gradePinned } from '../src/local.js'
import { verifyTarget } from '../src/verify.js'
import '../src/vitest.js' // registers toConform / toGradeAtLeast
import {
  goodTargetRoutes,
  makeFetcher,
  makeWorker,
  withOverrides,
  withoutRoutes,
  type Routes,
} from './helpers.js'

const BASE = 'https://local.test'
const SPEC_PATH = fileURLToPath(new URL('../examples/golden-scenario.spec.json', import.meta.url))
const goldenSpec = readFileSync(SPEC_PATH, 'utf8')

/** The golden-scenario dev surface at an arbitrary origin (mirrors pinned.test). */
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

function json200(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

// ---------------------------------------------------------------------------
// (a) grade an in-process handler — conforming passes high, non-conforming fails
// ---------------------------------------------------------------------------

describe('grade() an in-process handler (no network)', () => {
  it('a CONFORMING worker grades A+ (10/10)', async () => {
    const worker = makeWorker(goodTargetRoutes(BASE), BASE)
    const report = await grade(worker, { seed: 42 })
    expect(report.mode).toBe('local')
    expect(report.attested).toBe(false)
    expect(report.axScore.points).toBe(10)
    expect(report.grade).toBe('A+')
    for (const c of report.checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
  })

  it('a bare (request) => Response handler is accepted too', async () => {
    const f = makeFetcher(goodTargetRoutes(BASE), BASE)
    const bare = async (request: Request) => {
      const body = request.method !== 'GET' && request.method !== 'HEAD' ? await request.text() : undefined
      return f(request.url, { method: request.method, headers: request.headers, body })
    }
    const report = await grade(bare, { seed: 42 })
    expect(report.grade).toBe('A+')
    expect(report.axScore.points).toBe(10)
  })

  it('a NON-conforming worker (404s everything) grades F', async () => {
    const empty = { fetch: () => new Response('not found', { status: 404 }) }
    const report = await grade(empty, { seed: 42 })
    expect(report.grade).toBe('F')
    expect(report.axScore.points).toBeLessThan(3)
  })

  it('a worker that LIES (claims an endpoint that 404s) is capped, not A+', async () => {
    const worker = makeWorker(withoutRoutes(goodTargetRoutes(BASE), 'GET /api/widgets'), BASE)
    const report = await grade(worker, { seed: 42 })
    expect(['C', 'D', 'F']).toContain(report.grade)
  })
})

// ---------------------------------------------------------------------------
// (b) in-process verdict is IDENTICAL to URL mode for an equivalent surface
// ---------------------------------------------------------------------------

describe('in-process verdict matches URL mode', () => {
  it('same routes, same seed → identical checks and grade', async () => {
    const routes = goodTargetRoutes(BASE)
    const urlReport = await verifyTarget(BASE, {
      fetcher: makeFetcher(routes, BASE),
      mode: 'local',
      delayMs: 0,
      seed: 7,
    })
    const handlerReport = await grade(makeWorker(routes, BASE), { seed: 7, delayMs: 0 })

    expect(handlerReport.target).toBe(urlReport.target)
    expect(handlerReport.grade).toBe(urlReport.grade)
    expect(handlerReport.axScore.points).toBe(urlReport.axScore.points)
    expect(handlerReport.checks.map((c) => [c.id, c.verdict])).toEqual(
      urlReport.checks.map((c) => [c.id, c.verdict]),
    )
  })
})

// ---------------------------------------------------------------------------
// pinned-spec mode, in-process
// ---------------------------------------------------------------------------

describe('gradePinned() an in-process handler', () => {
  it('a worker implementing the pinned golden scenario PASSES', async () => {
    const worker = makeWorker(goldenRoutes(BASE), BASE)
    const report = await gradePinned(worker, goldenSpec, { seed: 1 })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    expect(report.attested).toBe(false)
  })

  it('a worker missing the golden endpoint FAILS (passed:false → gate red)', async () => {
    const worker = makeWorker(goodTargetRoutes(BASE), BASE) // no /golden/run
    const report = await gradePinned(worker, goldenSpec, { seed: 1 })
    expect(report.passed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (c) the vitest matcher
// ---------------------------------------------------------------------------

describe('vitest matcher: toConform / toGradeAtLeast', () => {
  it('expect(conformingWorker).toConform(spec) passes', async () => {
    const worker = makeWorker(goldenRoutes(BASE), BASE)
    await expect(worker).toConform(goldenSpec)
  })

  it('expect(nonConforming).toConform(spec) throws', async () => {
    const worker = makeWorker(goodTargetRoutes(BASE), BASE) // no /golden/run
    let threw = false
    try {
      await expect(worker).toConform(goldenSpec)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('toConform() with no spec passes a clean surface and throws on a broken one', async () => {
    await expect(makeWorker(goodTargetRoutes(BASE), BASE)).toConform()
    let threw = false
    try {
      await expect({ fetch: () => new Response('nope', { status: 404 }) }).toConform()
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('toGradeAtLeast honors the threshold', async () => {
    await expect(makeWorker(goodTargetRoutes(BASE), BASE)).toGradeAtLeast('B')
    let threw = false
    try {
      await expect({ fetch: () => new Response('nope', { status: 404 }) }).toGradeAtLeast('B')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (e) SSRF invariant — the private-host allowance is OPT-IN and local-only
// ---------------------------------------------------------------------------

describe('SSRF invariant preserved', () => {
  it('a REMOTE private target is refused by verifyTarget (deployed grader path)', async () => {
    await expect(verifyTarget('http://127.0.0.1:8787/')).rejects.toThrow(/private|IP-literal/i)
    await expect(verifyTarget('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private|IP-literal/i)
    await expect(verifyTarget('http://10.0.0.1/')).rejects.toThrow(/private|IP-literal/i)
    // decimal-encoded 169.254.169.254 — the numeric SSRF bypass, still refused
    await expect(verifyTarget('http://2852039166/')).rejects.toThrow(/private|IP-literal/i)
  })

  it('grade() of a private URL WITHOUT opt-in is refused (target can never flip allowPrivate)', async () => {
    await expect(grade('http://127.0.0.1:9/')).rejects.toThrow(/private|IP-literal/i)
    await expect(grade('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private|IP-literal/i)
  })

  it('grade() of a private URL WITH explicit opt-in gets PAST the SSRF gate (local dev server)', async () => {
    // Opt-in flips the gate: it no longer refuses at normalize time; the probe
    // is attempted against loopback:9 (connection refused, deterministic) and a
    // grade-F report is produced — NOT an SSRF refusal thrown.
    const report = await grade('http://127.0.0.1:9/', { allowPrivate: true })
    expect(report.mode).toBe('local')
    expect(report.grade).toBe('F') // unreachable dev server, but the gate let it through
  })

  it('a handler target never needs (or gets) the private allowance', async () => {
    // Public-looking synthetic origin, dispatched in-memory — grades fine with
    // allowPrivate defaulting false.
    const report = await grade(makeWorker(goodTargetRoutes(BASE), BASE))
    expect(report.grade).toBe('A+')
  })
})

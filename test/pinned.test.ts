import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { verifyPinnedSpec } from '../src/pinned.js'
import { sha256Hex } from '../src/digest.js'
import { Observer, type Fetcher } from '../src/http.js'
import { observeTarget } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
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

  it('kind:check binds a MUST to a SPECIFIC check, not the coarse AX floor', async () => {
    const spec = JSON.stringify({
      $type: 'PinnedSpec',
      name: 'per-check',
      version: '1',
      requirements: [
        { id: 'must-content-negotiate', kind: 'check', check: 'content-negotiation', must: 'pass' },
        { id: 'must-offer-402', kind: 'check', check: 'offers-402', must: 'pass' },
      ],
    })
    // Conformant target passes both discriminating checks.
    const good = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(good.passed, JSON.stringify(good.requirements, null, 2)).toBe(true)

    // Serve HTML to the agent Accept: the SPECIFIC content-negotiation check
    // fails even though the AX floor would still be cleared.
    const htmlToAgent = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(withOverrides(goodTargetRoutes(), {
        'GET /': () => ({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>hi</body></html>' }),
      })),
      delayMs: 0, seed: 1, mode: 'local',
    })
    expect(htmlToAgent.passed).toBe(false)
    expect(htmlToAgent.requirements.find((r) => r.id === 'must-content-negotiate')?.verdict).toBe('fail')
  })

  it('kind:check with an unknown check id cannot pass', async () => {
    const spec = JSON.stringify({
      $type: 'PinnedSpec',
      name: 'bogus-check',
      version: '1',
      requirements: [{ id: 'nope', kind: 'check', check: 'not-a-real-check', must: 'pass' }],
    })
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'nope')?.detail).toMatch(/unknown check/)
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

// ---------------------------------------------------------------------------
// kind:'probe' — requirements resolved from the TARGET's own probe manifest
// ---------------------------------------------------------------------------

/** Re-serve the good target's agents.json with a `probes` manifest added. */
function withProbes(routes: Routes, probes: Record<string, unknown>): Routes {
  const baseCard = JSON.parse(
    routes['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
  ) as Record<string, unknown>
  return withOverrides(routes, {
    'GET /.well-known/agents.json': () => ({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ...baseCard, probes }),
    }),
  })
}

/**
 * URL-aware layer over the route-table fetcher: helpers.makeFetcher routes on
 * pathname only, but probe semantics live in query params, so probe routes are
 * handled here with the full URL.
 */
function urlAware(base: Fetcher, handler: (u: URL) => { status: number; body: unknown } | undefined): Fetcher {
  return async (url, init) => {
    const hit = handler(new URL(url))
    if (hit) {
      return new Response(JSON.stringify(hit.body), {
        status: hit.status, headers: { 'content-type': 'application/json' },
      })
    }
    return base(url, init)
  }
}

function probeSpec(requirements: unknown[]): string {
  return JSON.stringify({ $type: 'PinnedSpec', name: 'probe-spec', version: '1', requirements })
}

const EMPTY_PROBE_REQ = {
  id: 'typed-empty', kind: 'probe', probe: 'knownEmpty', minDeclared: 2,
  expect: { status: 200, paths: [{ path: 'type', equals: 'EMPTY' }] },
}

describe('kind:probe — card-declared probe requirements', () => {
  it('passes when every declared probe conforms, with per-probe evidence roles', async () => {
    const routes = withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: '/api/widgets?zone=none' }, { url: '/api/widgets?zone=void' }],
    })
    const fetcher = urlAware(makeFetcher(routes), (u) =>
      u.pathname === '/api/widgets' && u.searchParams.has('zone')
        ? { status: 200, body: { type: 'EMPTY', items: [] } }
        : undefined)
    const report = await verifyPinnedSpec(GOOD, probeSpec([EMPTY_PROBE_REQ]), {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    const req = report.requirements.find((r) => r.id === 'typed-empty')!
    expect(req.evidence).toEqual(['pinned:typed-empty:0', 'pinned:typed-empty:1'])
    for (const role of req.evidence) {
      expect(report.evidence.items.some((e) => e.role === role), role).toBe(true)
    }
  })

  it('FAILS (never skips) when the target declares no probe manifest', async () => {
    const report = await verifyPinnedSpec(GOOD, probeSpec([EMPTY_PROBE_REQ]), {
      fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    const req = report.requirements.find((r) => r.id === 'typed-empty')!
    expect(req.verdict).toBe('fail')
    expect(req.detail).toMatch(/failing closed/)
    expect(req.detail).toMatch(/0 distinct/)
  })

  it('minDeclared counts DISTINCT urls: one entry, or two duplicates, both fail', async () => {
    for (const knownEmpty of [
      [{ url: '/api/widgets?zone=none' }],
      [{ url: '/api/widgets?zone=none' }, { url: '/api/widgets?zone=none' }],
    ]) {
      const routes = withProbes(goodTargetRoutes(), { knownEmpty })
      const fetcher = urlAware(makeFetcher(routes), (u) =>
        u.pathname === '/api/widgets' && u.searchParams.has('zone')
          ? { status: 200, body: { type: 'EMPTY', items: [] } }
          : undefined)
      const report = await verifyPinnedSpec(GOOD, probeSpec([EMPTY_PROBE_REQ]), {
        fetcher, delayMs: 0, seed: 1, mode: 'local',
      })
      expect(report.passed).toBe(false)
      expect(report.requirements.find((r) => r.id === 'typed-empty')?.detail).toMatch(/declares 1 distinct/)
    }
  })

  it('a declared probe that LIES (200 {} where typed EMPTY is pinned) fails with a path detail', async () => {
    const routes = withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: '/api/widgets?zone=none' }, { url: '/api/widgets?zone=void' }],
    })
    const fetcher = urlAware(makeFetcher(routes), (u) =>
      u.pathname === '/api/widgets' && u.searchParams.has('zone')
        ? { status: 200, body: {} }
        : undefined)
    const report = await verifyPinnedSpec(GOOD, probeSpec([EMPTY_PROBE_REQ]), {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'typed-empty')?.detail).toMatch(/path type/)
  })

  it('a probe requirement interpolates {{var}} in its expect (env-seeded), resolving instead of comparing the literal token', async () => {
    const routes = withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: '/api/widgets?zone=none' }, { url: '/api/widgets?zone=void' }],
    })
    const fetcher = urlAware(makeFetcher(routes), (u) =>
      u.pathname === '/api/widgets' && u.searchParams.has('zone')
        ? { status: 200, body: { type: 'EMPTY', items: [] } }
        : undefined)
    const spec = probeSpec([
      { id: 'typed-empty-interp', kind: 'probe', probe: 'knownEmpty', minDeclared: 2,
        expect: { status: 200, paths: [{ path: 'type', equals: '{{envType}}' }] } },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
      initialBindings: { envType: 'EMPTY' },
    })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
  })

  it('a probe requirement whose expect references an UNDEFINED {{var}} FAILS CLOSED with the undefined-var detail (never a silent literal-string mismatch)', async () => {
    const routes = withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: '/api/widgets?zone=none' }, { url: '/api/widgets?zone=void' }],
    })
    const fetcher = urlAware(makeFetcher(routes), (u) =>
      u.pathname === '/api/widgets' && u.searchParams.has('zone')
        ? { status: 200, body: { type: 'EMPTY', items: [] } }
        : undefined)
    const spec = probeSpec([
      { id: 'typed-empty-undef', kind: 'probe', probe: 'knownEmpty', minDeclared: 2,
        expect: { status: 200, paths: [{ path: 'type', equals: '{{missing}}' }] } },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    const req = report.requirements.find((r) => r.id === 'typed-empty-undef')!
    expect(req.verdict).toBe('fail')
    expect(req.detail).toMatch(/undefined capture var \{\{missing\}\}/)
    // Never a silent literal-string compare against the raw unresolved token —
    // no per-path "does not equal" mismatch detail should appear here.
    expect(req.detail).not.toMatch(/path type/)
  })

  it('a third-party probe URL is refused WITHOUT being fetched', async () => {
    const fetched: string[] = []
    const routes = withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: 'https://evil.example/exfil' }, { url: '/api/widgets?zone=none' }],
    })
    const inner = urlAware(makeFetcher(routes), (u) =>
      u.pathname === '/api/widgets' && u.searchParams.has('zone')
        ? { status: 200, body: { type: 'EMPTY', items: [] } }
        : undefined)
    const fetcher: Fetcher = (url, init) => {
      fetched.push(url)
      return inner(url, init)
    }
    const report = await verifyPinnedSpec(GOOD, probeSpec([EMPTY_PROBE_REQ]), {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'typed-empty')?.detail).toMatch(/not a same-origin GET/)
    expect(fetched.some((u) => u.includes('evil.example'))).toBe(false)
  })

  it('paramValue.fromProbe derives the over-ceiling amount from the OBSERVED pricing body', async () => {
    const spec = probeSpec([
      { id: 'pricing', kind: 'probe', probe: 'pricing',
        expect: { status: 200, paths: [{ path: 'hardCeiling', gt: 0 }] } },
      { id: 'ceiling', kind: 'probe', probe: 'overCeiling',
        paramValue: { fromProbe: 'pricing', path: 'hardCeiling', multiply: 1000 },
        expect: { status: [402], paths: [{ path: 'type', equals: 'BLOCKED' }] } },
    ])
    const routes = withProbes(goodTargetRoutes(), {
      pricing: [{ url: '/api/pricing' }],
      overCeiling: [{ url: '/api/widgets', param: 'spend' }],
    })
    const withCeiling = (realCeiling: number) => urlAware(makeFetcher(routes), (u) => {
      if (u.pathname === '/api/pricing') return { status: 200, body: { model: 'metered', hardCeiling: 5 } }
      if (u.pathname === '/api/widgets' && u.searchParams.has('spend')) {
        return Number(u.searchParams.get('spend')) > realCeiling
          ? { status: 402, body: { type: 'BLOCKED', reauth: '/checkout' } }
          : { status: 200, body: { type: 'OK', items: [] } }
      }
      return undefined
    })
    // Honest ceiling: declared 5, enforced at 5 → the derived 5000 is refused.
    const honest = await verifyPinnedSpec(GOOD, spec, {
      fetcher: withCeiling(5), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(honest.passed, JSON.stringify(honest.requirements, null, 2)).toBe(true)
    // Theater ceiling: declared 5, actually enforced only above 10_000_000 —
    // the verifier-derived 5000 sails through as 200 → fail.
    const theater = await verifyPinnedSpec(GOOD, spec, {
      fetcher: withCeiling(10_000_000), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(theater.passed).toBe(false)
    expect(theater.requirements.find((r) => r.id === 'ceiling')?.verdict).toBe('fail')
  })

  it('paramValue: 0 is the control probe — an always-402 wall fails it', async () => {
    const spec = probeSpec([
      { id: 'ceiling-not-premature', kind: 'probe', probe: 'overCeiling',
        paramValue: 0, expect: { status: 200 } },
    ])
    const routes = withProbes(goodTargetRoutes(), {
      overCeiling: [{ url: '/api/widgets', param: 'spend' }],
    })
    const fetcher = urlAware(makeFetcher(routes), (u) =>
      u.pathname === '/api/widgets' && u.searchParams.has('spend')
        ? { status: 402, body: { type: 'BLOCKED' } } // 402 theater: EVERY amount refused
        : undefined)
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'ceiling-not-premature')?.detail).toMatch(/status 402/)
  })

  it('pathMustServeOk: a decoy path never observed serving OK fails; a branching path passes', async () => {
    const req = { ...EMPTY_PROBE_REQ, pathMustServeOk: true }
    // Branching path: /api/widgets answers OK bare and EMPTY with a zone param —
    // the generic keyless sampling observes the bare OK, proving the branch.
    const branching = urlAware(makeFetcher(withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: '/api/widgets?zone=none' }, { url: '/api/widgets?zone=void' }],
    })), (u) => u.pathname === '/api/widgets'
      ? (u.searchParams.has('zone')
          ? { status: 200, body: { type: 'EMPTY', items: [] } }
          : { status: 200, body: { type: 'OK', items: [{ id: 'w1' }] } })
      : undefined)
    const pass = await verifyPinnedSpec(GOOD, probeSpec([req]), {
      fetcher: branching, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(pass.passed, JSON.stringify(pass.requirements, null, 2)).toBe(true)

    // Decoy: a dedicated /decoy that can ONLY ever say EMPTY — every declared
    // probe answers exactly as pinned, but the pathname never serves OK.
    const decoy = urlAware(makeFetcher(withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: '/decoy?a=1' }, { url: '/decoy?a=2' }],
    })), (u) => u.pathname === '/decoy' ? { status: 200, body: { type: 'EMPTY', items: [] } } : undefined)
    const fail = await verifyPinnedSpec(GOOD, probeSpec([req]), {
      fetcher: decoy, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(fail.passed).toBe(false)
    expect(fail.requirements.find((r) => r.id === 'typed-empty')?.detail)
      .toMatch(/never observed answering 200 with an "OK" envelope/)
  })

  it('fragment-only duplicates count as ONE distinct probe (fetch strips fragments)', async () => {
    const routes = withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: '/api/widgets?zone=none' }, { url: '/api/widgets?zone=none#dup' }],
    })
    const fetcher = urlAware(makeFetcher(routes), (u) =>
      u.pathname === '/api/widgets' && u.searchParams.has('zone')
        ? { status: 200, body: { type: 'EMPTY', items: [] } }
        : undefined)
    const report = await verifyPinnedSpec(GOOD, probeSpec([EMPTY_PROBE_REQ]), {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'typed-empty')?.detail).toMatch(/declares 1 distinct/)
  })

  it('surface openapi with versionPrefix/minOperations rejects Swagger 2.0 and zero-operation contracts', async () => {
    const spec = probeSpec([{
      id: 'openapi-31', kind: 'surface', surface: 'openapi', must: 'valid',
      versionPrefix: '3.1', minOperations: 1,
    }])
    const good = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(good.passed, JSON.stringify(good.requirements, null, 2)).toBe(true)

    const swagger = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(withOverrides(goodTargetRoutes(), {
        'GET /openapi.json': () => ({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ swagger: '2.0', info: {}, paths: { '/api/status': { get: { responses: { '200': { description: 'ok' } } } } } }),
        }),
      })), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(swagger.passed).toBe(false)
    expect(swagger.requirements.find((r) => r.id === 'openapi-31')?.detail)
      .toMatch(/"2\.0" does not begin with "3\.1"/)

    const zeroOps = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(withOverrides(goodTargetRoutes(), {
        'GET /openapi.json': () => ({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ openapi: '3.1.0', info: {}, paths: {} }),
        }),
      })), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(zeroOps.passed).toBe(false)
    expect(zeroOps.requirements.find((r) => r.id === 'openapi-31')?.detail)
      .toMatch(/declares 0 operation\(s\)/)
  })

  it('an unknown requirement kind fails LOUDLY, naming the kind', async () => {
    const spec = probeSpec([{ id: 'future', kind: 'quantum-probe', expect: {} }])
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'future')?.detail)
      .toMatch(/unknown requirement kind "quantum-probe"/)
  })
})

// ---------------------------------------------------------------------------
// endpoint capture + chaining — a created id feeds a later read/list
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A `/things` collection over the good target's surfaces whose minted id is a
 * NUMBER (not a string) — POST /things returns `{ id: <n>, ... }`, GET
 * /things/{id} reads it back. Backs the numeric-CRUD chain: the captured id
 * stays a number in the binding scope yet interpolates into the URL path.
 */
function thingsFetcher(): Fetcher {
  const base = makeFetcher(goodTargetRoutes())
  const store = new Map<number, Record<string, unknown>>()
  let counter = 0
  return async (url, init) => {
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (u.pathname === '/things' && method === 'POST') {
      counter += 1
      const data = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      store.set(counter, data)
      return jsonResponse(200, { id: counter, ...data }) // id is a NUMBER
    }
    const m = u.pathname.match(/^\/things\/(.+)$/)
    if (m && method === 'GET') {
      const id = Number(m[1])
      const rec = store.get(id)
      return rec ? jsonResponse(200, { id, ...rec }) : jsonResponse(404, { error: 'not found' })
    }
    return base(url, init)
  }
}

/**
 * A stateful `/listings` collection layered over the good target's surfaces, so
 * discovery still works. POST creates (returns a server-minted id), GET
 * /listings/{id} reads it back, GET /listings lists the ids. A fetch-spy records
 * every URL the observer actually put on the wire.
 */
function crudFetcher(opts: {
  postResponse?: (body: Record<string, unknown>, id: string) => { status: number; body: unknown }
  readResponse?: (id: string, data: Record<string, unknown>) => { status: number; body: unknown } | undefined
  collection?: (ids: string[]) => { status: number; body: unknown }
} = {}): { fetcher: Fetcher; fetched: string[] } {
  const base = makeFetcher(goodTargetRoutes())
  const store: Array<{ id: string; data: Record<string, unknown> }> = []
  const fetched: string[] = []
  let counter = 0
  const fetcher: Fetcher = async (url, init) => {
    fetched.push(url)
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (u.pathname === '/listings' && method === 'POST') {
      counter += 1
      const id = `l${counter}`
      const data = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      store.push({ id, data })
      const out = opts.postResponse ? opts.postResponse(data, id) : { status: 200, body: { id, ...data } }
      return jsonResponse(out.status, out.body)
    }
    if (u.pathname === '/listings' && method === 'GET') {
      const ids = store.map((s) => s.id)
      const out = opts.collection ? opts.collection(ids) : { status: 200, body: { ids } }
      return jsonResponse(out.status, out.body)
    }
    const m = u.pathname.match(/^\/listings\/(.+)$/)
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]!)
      const rec = store.find((s) => s.id === id)
      const out = opts.readResponse
        ? opts.readResponse(id, rec?.data ?? {})
        : rec
          ? { status: 200, body: { id: rec.id, ...rec.data } }
          : { status: 404, body: { error: 'not found' } }
      if (!out) return jsonResponse(404, { error: 'not found' })
      return jsonResponse(out.status, out.body)
    }
    return base(url, init)
  }
  return { fetcher, fetched }
}

/** POST /listings capturing id → GET /listings/{{id}} → GET /listings has it. */
const CRUD_CHAIN = [
  {
    id: 'create', kind: 'endpoint', method: 'POST', path: '/listings',
    body: { title: 'Blue widget' },
    capture: { create_id: 'id' },
    expect: { status: 200, paths: [{ path: 'id', exists: true }] },
  },
  {
    id: 'read', kind: 'endpoint', method: 'GET', path: '/listings/{{create_id}}',
    expect: {
      status: 200,
      schema: { type: 'object', required: ['id', 'title'] },
      paths: [{ path: 'id', equals: '{{create_id}}' }],
    },
  },
  {
    id: 'list-has', kind: 'endpoint', method: 'GET', path: '/listings',
    expect: { status: 200, paths: [{ path: 'ids.0', equals: '{{create_id}}' }] },
  },
]

describe('endpoint capture + chaining', () => {
  it('runs the full CRUD chain GREEN: create captures id, read + list chain on {{create_id}}', async () => {
    const { fetcher } = crudFetcher()
    const report = await verifyPinnedSpec(GOOD, probeSpec(CRUD_CHAIN), {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    // The capture is recorded as bundle DATA…
    expect(report.evidence.bindings).toEqual({ create_id: 'l1' })
    // …and the read fetched the RESOLVED, interpolated URL (never the token).
    const read = report.evidence.items.find((e) => e.role === 'pinned:read')!
    expect(read.url).toBe(`${GOOD}/listings/l1`)
    expect(read.url).not.toContain('{{')
  })

  it('fails with a MISMATCH detail against a target that does not implement the read', async () => {
    const { fetcher, fetched } = crudFetcher({
      readResponse: () => ({ status: 404, body: { error: 'not found' } }),
    })
    const report = await verifyPinnedSpec(GOOD, probeSpec(CRUD_CHAIN), {
      fetcher, delayMs: 0, seed: 1, mode: 'local',
    })
    expect(report.passed).toBe(false)
    const read = report.requirements.find((r) => r.id === 'read')!
    expect(read.verdict).toBe('fail')
    expect(read.detail).toMatch(/status 404, wanted 200/)
    // It still resolved + fetched the real interpolated URL (fail is a mismatch,
    // not an unresolved-var).
    expect(fetched.some((u) => u === `${GOOD}/listings/l1`)).toBe(true)
  })

  it('a reference to an undefined capture var FAILS closed with a naming detail — token never fetched', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { id: 'bad', kind: 'endpoint', method: 'GET', path: '/listings/{{never_produced}}', expect: { status: 200 } },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed).toBe(false)
    const bad = report.requirements.find((r) => r.id === 'bad')!
    expect(bad.verdict).toBe('fail')
    expect(bad.detail).toMatch(/requirement bad references undefined capture var \{\{never_produced\}\}/)
    // The literal token was never put on the wire, nor was any /listings/ read.
    expect(fetched.some((u) => u.includes('{{') || u.includes('never_produced'))).toBe(false)
    expect(fetched.some((u) => u.startsWith(`${GOOD}/listings/`))).toBe(false)
  })

  it('captures a dot-path into a NESTED array body and interpolates it into a path + expected value', async () => {
    const base = makeFetcher(goodTargetRoutes())
    const fetched: string[] = []
    const fetcher: Fetcher = async (url, init) => {
      fetched.push(url)
      const u = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (u.pathname === '/thing' && method === 'POST') {
        return jsonResponse(200, { data: [{ id: 'abc-123' }, { id: 'zzz-999' }] })
      }
      const m = u.pathname.match(/^\/thing\/(.+)$/)
      if (m && method === 'GET') return jsonResponse(200, { id: decodeURIComponent(m[1]!), ok: true })
      return base(url, init)
    }
    const spec = probeSpec([
      {
        id: 'make', kind: 'endpoint', method: 'POST', path: '/thing', body: {},
        capture: { nid: 'data.0.id' },
        expect: { status: 200 },
      },
      {
        id: 'fetch-nested', kind: 'endpoint', method: 'GET', path: '/thing/{{nid}}',
        expect: { status: 200, paths: [{ path: 'id', equals: '{{nid}}' }] },
      },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    expect(report.evidence.bindings).toEqual({ nid: 'abc-123' })
    expect(fetched.some((u) => u === `${GOOD}/thing/abc-123`)).toBe(true)
  })

  it('is DETERMINISTIC: two runs record identical bindings, resolved URLs, and verdicts (replay-safe)', async () => {
    const run = () =>
      verifyPinnedSpec(GOOD, probeSpec(CRUD_CHAIN), {
        fetcher: crudFetcher().fetcher, delayMs: 0, seed: 1, mode: 'local',
      })
    const a = await run()
    const b = await run()
    expect(a.evidence.bindings).toEqual(b.evidence.bindings)
    const pinnedUrls = (r: typeof a) =>
      r.evidence.items.filter((e) => e.role.startsWith('pinned:')).map((e) => [e.role, e.url])
    expect(pinnedUrls(a)).toEqual(pinnedUrls(b))
    const verdicts = (r: typeof a) => r.requirements.map((x) => [x.id, x.verdict, x.detail])
    expect(verdicts(a)).toEqual(verdicts(b))
  })

  // The FULL SSRF vector matrix for a TARGET-CONTROLLED captured value that is
  // interpolated as the whole request path (`path: '{{next}}'`) — the classic
  // smuggle vector. Every vector must be REFUSED by the resolveEndpoint
  // same-origin gate before any fetch, in BOTH local and remote mode. The gate
  // is the SOLE/PRIMARY defense (off-origin public hosts the private-host
  // backstop never bites); in remote mode the Observer initial-host backstop is
  // additionally armed for the private/metadata vectors as redundant depth.
  const SSRF_VECTORS: Array<{ label: string; url: string; marker: string }> = [
    { label: 'off-origin https', url: 'https://evil.example/exfil', marker: 'evil.example' },
    { label: 'metadata 169.254.169.254', url: 'http://169.254.169.254/latest/meta-data/', marker: '169.254.169.254' },
    { label: 'decimal-encoded IPv4', url: 'http://2852039166/', marker: '2852039166' },
    { label: 'hex-encoded IPv4', url: 'http://0xA9FEA9FE/', marker: '0xa9fea9fe' },
    { label: 'protocol-relative //evil', url: '//evil.example/x', marker: 'evil.example' },
    { label: 'ipv6 loopback [::1]', url: 'http://[::1]/', marker: '[::1]' },
    { label: 'userinfo good@evil', url: 'https://good.example@evil.example/x', marker: 'evil.example' },
    { label: 'reverse-userinfo evil@169.254', url: 'https://evil.example@169.254.169.254/x', marker: '169.254.169.254' },
    { label: 'port-smuggle good.example:22', url: 'https://good.example:22/x', marker: 'good.example:22' },
    { label: 'http downgrade', url: 'http://good.example/x', marker: 'http://good.example' },
    { label: 'file scheme', url: 'file:///etc/passwd', marker: 'file:' },
  ]

  for (const mode of ['local', 'remote'] as const) {
    for (const { label, url, marker } of SSRF_VECTORS) {
      it(`SSRF (${mode}): captured "${label}" is REFUSED with NO off-origin fetch`, async () => {
        const { fetcher, fetched } = crudFetcher({
          // The target smuggles the hostile URL back in its response body.
          postResponse: (_body, id) => ({ status: 200, body: { id, next: url } }),
        })
        const spec = probeSpec([
          {
            id: 'create', kind: 'endpoint', method: 'POST', path: '/listings', body: {},
            capture: { next: 'next' }, expect: { status: 200 },
          },
          { id: 'follow', kind: 'endpoint', method: 'GET', path: '{{next}}', expect: { status: 200 } },
        ])
        const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode })
        expect(report.passed).toBe(false)
        const follow = report.requirements.find((r) => r.id === 'follow')!
        expect(follow.verdict).toBe('fail')
        expect(follow.detail).toMatch(/off-origin\/private|fail closed/)
        // NOTHING was ever fetched off the consented origin (the strong invariant).
        for (const u of fetched) {
          expect(new URL(u).origin, `${mode}/${label} leaked ${u}`).toBe(GOOD)
        }
        // …and the dangerous marker was never put on the wire.
        expect(fetched.some((u) => u.toLowerCase().includes(marker.toLowerCase())), `${mode}/${label}`).toBe(false)
      })
    }
  }

  it('SSRF: a CRLF/backslash captured value is WHATWG-same-origin-only (fetched to the consented target, never off-origin)', async () => {
    // WHATWG URL parsing STRIPS \r and \n, so a CRLF-injected value collapses to
    // a same-origin PATH — it is fetched to the consented target, never a
    // smuggled Host. A backslash is treated as '/', so a leading '\\evil'
    // becomes '//evil' (protocol-relative → off-origin) and the gate REFUSES it
    // unfetched. Either way: NO off-origin fetch.
    const cases: Array<{ label: string; captured: string; fetchedSameOrigin: boolean }> = [
      { label: 'crlf-host-injection', captured: '/things/1\r\nHost: evil.example', fetchedSameOrigin: true },
      { label: 'backslash-breakout', captured: '\\\\evil.example\\x', fetchedSameOrigin: false },
    ]
    for (const { label, captured, fetchedSameOrigin } of cases) {
      const { fetcher, fetched } = crudFetcher({
        postResponse: (_body, id) => ({ status: 200, body: { id, next: captured } }),
      })
      const spec = probeSpec([
        {
          id: 'create', kind: 'endpoint', method: 'POST', path: '/listings', body: {},
          capture: { next: 'next' }, expect: { status: 200 },
        },
        { id: 'follow', kind: 'endpoint', method: 'GET', path: '{{next}}', expect: { status: 200 } },
      ])
      const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
      // The invariant that holds for BOTH outcomes: no fetch ever left the
      // origin (a CRLF path may legitimately carry the text 'evil.example' as a
      // PATH substring on a good.example fetch — what matters is the HOST).
      for (const u of fetched) {
        expect(new URL(u).origin, `${label} leaked ${u}`).toBe(GOOD)
      }
      expect(fetched.some((u) => new URL(u).hostname === 'evil.example'), label).toBe(false)
      if (fetchedSameOrigin) {
        // CRLF collapsed to a same-origin path and WAS fetched to good.example.
        expect(fetched.some((u) => u.startsWith(`${GOOD}/things/1`)), label).toBe(true)
      } else {
        // Backslash resolved off-origin and was refused before any fetch.
        const follow = report.requirements.find((r) => r.id === 'follow')!
        expect(follow.verdict).toBe('fail')
        expect(follow.detail).toMatch(/off-origin\/private|fail closed/)
      }
    }
  })

  it('preserves TYPE for a whole-value token: numeric-id CRUD chain passes (equals compares as NUMBER, url path stays string)', async () => {
    const base = makeFetcher(goodTargetRoutes())
    const fetched: string[] = []
    const store = new Map<number, Record<string, unknown>>()
    let counter = 0
    const fetcher: Fetcher = async (url, init) => {
      fetched.push(url)
      const u = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (u.pathname === '/things' && method === 'POST') {
        counter += 1
        const data = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
        store.set(counter, data)
        return jsonResponse(200, { id: counter, ...data }) // id is a NUMBER, not "1"
      }
      const m = u.pathname.match(/^\/things\/(.+)$/)
      if (m && method === 'GET') {
        const id = Number(m[1])
        const rec = store.get(id)
        return rec ? jsonResponse(200, { id, ...rec }) : jsonResponse(404, { error: 'not found' })
      }
      return base(url, init)
    }
    const spec = probeSpec([
      {
        id: 'create', kind: 'endpoint', method: 'POST', path: '/things', body: { title: 'X' },
        capture: { tid: 'id' },
        expect: { status: 200, paths: [{ path: 'id', exists: true }] },
      },
      {
        id: 'read', kind: 'endpoint', method: 'GET', path: '/things/{{tid}}',
        // equals: '{{tid}}' is a whole-value token in a TYPED context → compares
        // against the NUMBER 1. Pre-fix this stringified to "1" and false-failed.
        expect: { status: 200, paths: [{ path: 'id', equals: '{{tid}}' }] },
      },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    // The captured id is the NUMBER 1, preserved through the binding scope.
    expect(report.evidence.bindings).toEqual({ tid: 1 })
    // …yet the numeric id still interpolated correctly into the URL PATH (a string).
    const read = report.evidence.items.find((e) => e.role === 'pinned:read')!
    expect(read.url).toBe(`${GOOD}/things/1`)
    expect(read.url).not.toContain('{{')
  })

  it('a whole-value token preserves BOOLEAN and OBJECT types (body value + equals), never stringified', async () => {
    const base = makeFetcher(goodTargetRoutes())
    const fetcher: Fetcher = async (url, init) => {
      const u = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (u.pathname === '/mk' && method === 'POST') return jsonResponse(200, { active: true, meta: { k: 1 } })
      if (u.pathname === '/echo' && method === 'POST') {
        // Echo the received body verbatim so `equals` can compare typed values.
        return jsonResponse(200, JSON.parse(typeof init?.body === 'string' ? init.body : '{}'))
      }
      return base(url, init)
    }
    const spec = probeSpec([
      {
        id: 'mk', kind: 'endpoint', method: 'POST', path: '/mk', body: {},
        capture: { flag: 'active', obj: 'meta' },
        expect: { status: 200 },
      },
      {
        id: 'echo', kind: 'endpoint', method: 'POST', path: '/echo',
        body: { flag: '{{flag}}', obj: '{{obj}}' }, // whole-value tokens → true / {k:1}
        expect: {
          status: 200,
          paths: [
            { path: 'flag', equals: '{{flag}}' }, // boolean true, not "true"
            { path: 'obj', equals: '{{obj}}' },   // object {k:1}, not '{"k":1}'
          ],
        },
      },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    expect(report.evidence.bindings).toEqual({ flag: true, obj: { k: 1 } })
  })

  it('a whole-value numeric body field stays a NUMBER while an EMBEDDED token stringifies', async () => {
    const base = makeFetcher(goodTargetRoutes())
    const fetcher: Fetcher = async (url, init) => {
      const u = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (u.pathname === '/mk2' && method === 'POST') return jsonResponse(200, { n: 5 })
      if (u.pathname === '/echo2' && method === 'POST') {
        return jsonResponse(200, JSON.parse(typeof init?.body === 'string' ? init.body : '{}'))
      }
      return base(url, init)
    }
    const spec = probeSpec([
      {
        id: 'mk2', kind: 'endpoint', method: 'POST', path: '/mk2', body: {},
        capture: { n: 'n' },
        expect: { status: 200 },
      },
      {
        id: 'echo2', kind: 'endpoint', method: 'POST', path: '/echo2',
        body: { count: '{{n}}', label: 'item-{{n}}' }, // whole-value NUMBER vs embedded STRING
        expect: {
          status: 200,
          paths: [
            { path: 'count', equals: 5 },        // preserved number
            { path: 'label', equals: 'item-5' }, // stringified embed
          ],
        },
      },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
  })

  it('a spec with DUPLICATE requirement ids is rejected up front with a naming error', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { id: 'dup', kind: 'endpoint', method: 'GET', path: '/listings', expect: { status: 200 } },
      { id: 'dup', kind: 'endpoint', method: 'GET', path: '/listings', expect: { status: 200 } },
    ])
    await expect(
      verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' }),
    ).rejects.toThrow(/duplicate requirement id "dup"/)
    // Rejected BEFORE any probe fires.
    expect(fetched.length).toBe(0)
  })

  // A PinnedSpec is EXTERNAL JSON: the `id: string` TS type is compile-time
  // only, so the dup-id guard must reject non-string / missing / empty / cross-
  // type-duplicate ids at RUNTIME — never skip them past the guard where two
  // requirements would share one role (`pinned:<id>`) and re-open the
  // observe/judge divergence.
  it('rejects a spec whose ids are numeric (would collapse two requirements onto role pinned:1)', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { id: 1, kind: 'endpoint', method: 'GET', path: '/a', expect: { status: 200 } },
      { id: 1, kind: 'endpoint', method: 'GET', path: '/b', expect: { status: 200 } },
    ])
    await expect(
      verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' }),
    ).rejects.toThrow(/invalid requirement id 1 .*non-empty string/i)
    expect(fetched.length).toBe(0)
  })

  it('rejects a spec with a MISSING requirement id (would collapse onto role pinned:undefined)', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { kind: 'endpoint', method: 'GET', path: '/a', expect: { status: 200 } },
      { kind: 'endpoint', method: 'GET', path: '/b', expect: { status: 200 } },
    ])
    await expect(
      verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' }),
    ).rejects.toThrow(/invalid requirement id undefined .*non-empty string/i)
    expect(fetched.length).toBe(0)
  })

  it('rejects a spec with an EMPTY-STRING requirement id', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { id: '', kind: 'endpoint', method: 'GET', path: '/a', expect: { status: 200 } },
    ])
    await expect(
      verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' }),
    ).rejects.toThrow(/invalid requirement id "" .*non-empty string/i)
    expect(fetched.length).toBe(0)
  })

  it('rejects a CROSS-TYPE duplicate: numeric 1 and string "1" both key role pinned:1', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { id: '1', kind: 'endpoint', method: 'GET', path: '/a', expect: { status: 200 } },
      { id: 1, kind: 'endpoint', method: 'GET', path: '/b', expect: { status: 200 } },
    ])
    // The numeric id is rejected as a non-string before it can collide as a
    // duplicate — either way the collision on role pinned:1 never reaches judge.
    await expect(
      verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' }),
    ).rejects.toThrow(/invalid requirement id 1 .*non-empty string/i)
    expect(fetched.length).toBe(0)
  })

  // The role key is DERIVED (endpoint → pinned:<id>, probe → pinned:<id>:<i>)
  // and non-injective ACROSS KINDS, so raw-id uniqueness is not enough: two
  // requirements of DIFFERENT kinds with distinct raw ids can still collapse
  // onto one derived role key. parsePinnedSpec must reject the whole class.
  it('rejects an endpoint "x:0" + probe "x" that both derive role pinned:x:0', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { id: 'x:0', kind: 'endpoint', method: 'GET', path: '/a', expect: { status: 200 } },
      { id: 'x', kind: 'probe', probe: 'knownEmpty', expect: { status: 200 } },
    ])
    await expect(
      verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' }),
    ).rejects.toThrow(/role-key collision.*"x:0".*"x".*pinned:x:0/s)
    expect(fetched.length).toBe(0)
  })

  it('rejects an id containing the ":" role separator (even when it collides with nothing)', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { id: 'a:b', kind: 'endpoint', method: 'GET', path: '/a', expect: { status: 200 } },
    ])
    await expect(
      verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' }),
    ).rejects.toThrow(/"a:b".*contains the ':' role-key separator/s)
    expect(fetched.length).toBe(0)
  })

  it('rejects two probes whose <id>:<i> namespaces nest (probe "a" vs probe "a:0")', async () => {
    const { fetcher, fetched } = crudFetcher()
    const spec = probeSpec([
      { id: 'a', kind: 'probe', probe: 'knownEmpty', expect: { status: 200 } },
      { id: 'a:0', kind: 'probe', probe: 'knownForbidden', expect: { status: 200 } },
    ])
    await expect(
      verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' }),
    ).rejects.toThrow(/role-key collision.*"a".*"a:0"|role-key collision.*"a:0".*"a"/s)
    expect(fetched.length).toBe(0)
  })

  it('a valid MIXED endpoint+probe spec with non-colliding derived roles still parses + runs green', async () => {
    const routes = withProbes(goodTargetRoutes(), {
      knownEmpty: [{ url: '/api/widgets?zone=none' }, { url: '/api/widgets?zone=void' }],
    })
    const base = urlAware(makeFetcher(routes), (u) =>
      u.pathname === '/api/widgets' && u.searchParams.has('zone')
        ? { status: 200, body: { type: 'EMPTY', items: [] } }
        : undefined)
    // Layer a /listings collection on top so the endpoint requirement runs too.
    const store: Array<{ id: string }> = []
    let counter = 0
    const fetcher: Fetcher = async (url, init) => {
      const u = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (u.pathname === '/listings' && method === 'POST') {
        counter += 1
        const id = `l${counter}`
        store.push({ id })
        return jsonResponse(200, { id })
      }
      return base(url, init)
    }
    const spec = probeSpec([
      {
        id: 'create', kind: 'endpoint', method: 'POST', path: '/listings', body: {},
        expect: { status: 200, paths: [{ path: 'id', exists: true }] },
      },
      { ...EMPTY_PROBE_REQ },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    // Both requirements' derived roles are present and DISTINCT.
    expect(report.evidence.items.some((e) => e.role === 'pinned:create')).toBe(true)
    expect(report.evidence.items.some((e) => e.role === 'pinned:typed-empty:0')).toBe(true)
  })

  it('a valid spec with UNIQUE STRING ids still parses and the numeric CRUD chain runs green', async () => {
    const report = await verifyPinnedSpec(GOOD, probeSpec([
      {
        id: 'create', kind: 'endpoint', method: 'POST', path: '/things', body: { title: 'X' },
        capture: { tid: 'id' },
        expect: { status: 200, paths: [{ path: 'id', exists: true }] },
      },
      {
        id: 'read', kind: 'endpoint', method: 'GET', path: '/things/{{tid}}',
        expect: { status: 200, paths: [{ path: 'id', equals: '{{tid}}' }] },
      },
    ]), { fetcher: thingsFetcher(), delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    expect(report.evidence.bindings).toEqual({ tid: 1 })
  })

  it('a lone whole-value token with incidental surrounding whitespace preserves TYPE (trailing and both-side spaces PASS a numeric target)', async () => {
    const report = await verifyPinnedSpec(GOOD, probeSpec([
      {
        id: 'create', kind: 'endpoint', method: 'POST', path: '/things', body: { title: 'X' },
        capture: { tid: 'id' },
        expect: { status: 200, paths: [{ path: 'id', exists: true }] },
      },
      {
        id: 'read', kind: 'endpoint', method: 'GET', path: '/things/{{tid}}',
        // '{{tid}} ' (trailing) and ' {{tid}} ' (both sides) are lone tokens with
        // only incidental whitespace → trimmed, substituted as the RAW NUMBER 1.
        // Pre-fix each fell onto the string path and false-failed ("1 " vs 1).
        expect: { status: 200, paths: [
          { path: 'id', equals: '{{tid}} ' },
          { path: 'id', equals: ' {{tid}} ' },
        ] },
      },
    ]), { fetcher: thingsFetcher(), delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
  })

  it('a lone STRING token with surrounding whitespace PRESERVES the whitespace (not trimmed like a non-string)', async () => {
    const base = makeFetcher(goodTargetRoutes())
    const fetcher: Fetcher = async (url, init) => {
      const u = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      // sid is a STRING ('hello'); /padded echoes it with the intended spaces,
      // /tight echoes it without.
      if (u.pathname === '/mk' && method === 'POST') return jsonResponse(200, { sid: 'hello' })
      if (u.pathname === '/padded' && method === 'GET') return jsonResponse(200, { v: ' hello ' })
      if (u.pathname === '/tight' && method === 'GET') return jsonResponse(200, { v: 'hello' })
      return base(url, init)
    }
    const mk = {
      id: 'mk', kind: 'endpoint', method: 'POST', path: '/mk', body: {},
      capture: { sid: 'sid' }, expect: { status: 200 },
    }
    // ' {{sid}} ' is a lone token but the binding is a STRING, so the surrounding
    // whitespace is a literal: it resolves to ' hello ' and PASSES a ' hello '
    // target — proving the whitespace was preserved, not trimmed to 'hello'.
    const preserved = await verifyPinnedSpec(GOOD, probeSpec([
      mk,
      { id: 'read', kind: 'endpoint', method: 'GET', path: '/padded',
        expect: { status: 200, paths: [{ path: 'v', equals: ' {{sid}} ' }] } },
    ]), { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(preserved.passed, JSON.stringify(preserved.requirements, null, 2)).toBe(true)

    // Same ' {{sid}} ' against a 'hello' target FAILS — the preserved ' hello '
    // does not equal 'hello' (a trimming regression would have wrongly PASSED).
    const failsTrimmed = await verifyPinnedSpec(GOOD, probeSpec([
      mk,
      { id: 'read', kind: 'endpoint', method: 'GET', path: '/tight',
        expect: { status: 200, paths: [{ path: 'v', equals: ' {{sid}} ' }] } },
    ]), { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(failsTrimmed.passed).toBe(false)
    expect(failsTrimmed.requirements.find((r) => r.id === 'read')?.detail).toMatch(/wanted " hello "/)

    // Edge-to-edge '{{sid}}' is UNCHANGED — coerces to the raw string 'hello'.
    const edge = await verifyPinnedSpec(GOOD, probeSpec([
      mk,
      { id: 'read', kind: 'endpoint', method: 'GET', path: '/tight',
        expect: { status: 200, paths: [{ path: 'v', equals: '{{sid}}' }] } },
    ]), { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(edge.passed, JSON.stringify(edge.requirements, null, 2)).toBe(true)
  })

  it('a token adjacent to NON-whitespace text still stringifies (genuine embedding is untouched)', async () => {
    const base = makeFetcher(goodTargetRoutes())
    const fetcher: Fetcher = async (url, init) => {
      const u = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (u.pathname === '/src' && method === 'POST') return jsonResponse(200, { n: 5, a: 'x', b: 'y' })
      if (u.pathname === '/echo3' && method === 'POST') {
        return jsonResponse(200, JSON.parse(typeof init?.body === 'string' ? init.body : '{}'))
      }
      return base(url, init)
    }
    const spec = probeSpec([
      {
        id: 'src', kind: 'endpoint', method: 'POST', path: '/src', body: {},
        capture: { n: 'n', a: 'a', b: 'b' },
        expect: { status: 200 },
      },
      {
        id: 'echo3', kind: 'endpoint', method: 'POST', path: '/echo3',
        body: { label: 'v{{n}}', combo: '{{a}}-{{b}}' }, // embedded → both stringify
        expect: { status: 200, paths: [
          { path: 'label', equals: 'v5' },
          { path: 'combo', equals: 'x-y' },
        ] },
      },
    ])
    const report = await verifyPinnedSpec(GOOD, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// probe-manifest check (checks.ts) — the manifest validity judge
// ---------------------------------------------------------------------------

describe('probe-manifest check', () => {
  async function probeManifestCheck(routes: Routes) {
    const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 1)
    return runChecks(bundle).find((c) => c.id === 'probe-manifest')!
  }

  it('SKIPS when no manifest is declared (generic grading unaffected)', async () => {
    const c = await probeManifestCheck(goodTargetRoutes())
    expect(c.verdict).toBe('skip')
  })

  it('passes a manifest whose entries are same-origin GETs on contract-declared paths', async () => {
    const c = await probeManifestCheck(withProbes(goodTargetRoutes(), {
      keyless: { url: '/api/status' },
      pricing: { url: '/api/status' },
      overCeiling: { url: '/api/widgets', param: 'spend' },
      knownEmpty: [{ url: '/api/widgets?a=1' }, { url: '/api/widgets?a=2' }],
      knownForbidden: [{ url: '/api/widgets?b=1' }, { url: '/api/widgets?b=2' }],
    }))
    expect(c.verdict, c.detail).toBe('pass')
  })

  it('fails on undeclared path, non-GET, empty/forbidden overlap, and missing overCeiling param', async () => {
    const c = await probeManifestCheck(withProbes(goodTargetRoutes(), {
      keyless: { url: '/side-door' }, // not in OpenAPI paths or interfaces.http
      pricing: { url: '/api/status' },
      overCeiling: { url: '/api/widgets' }, // no param
      knownEmpty: [{ url: '/api/widgets?a=1' }, { url: '/api/widgets?a=2' }],
      knownForbidden: [{ url: '/api/widgets?a=1' }, { method: 'POST', url: '/api/widgets?b=2' }],
    }))
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/\/side-door is not an operation declared/)
    expect(c.detail).toMatch(/method POST/)
    expect(c.detail).toMatch(/share URL/)
    expect(c.detail).toMatch(/no non-empty "param"/)
  })

  it('fails a card that declares a probe manifest but no monetization.probe (the 402 boundary would go unverified)', async () => {
    const routes = withProbes(goodTargetRoutes(), {
      keyless: { url: '/api/status' },
      pricing: { url: '/api/status' },
      overCeiling: { url: '/api/widgets', param: 'spend' },
      knownEmpty: [{ url: '/api/widgets?a=1' }, { url: '/api/widgets?a=2' }],
      knownForbidden: [{ url: '/api/widgets?b=1' }, { url: '/api/widgets?b=2' }],
    })
    const card = JSON.parse(
      routes['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
    ) as Record<string, unknown>
    delete card.monetization
    const c = await probeManifestCheck(withOverrides(routes, {
      'GET /.well-known/agents.json': () => ({
        status: 200, contentType: 'application/json', body: JSON.stringify(card),
      }),
    }))
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/monetization\.probe/)
  })

  it('fragment-only duplicates do not inflate channel cardinality, and fragment overlap is still overlap', async () => {
    const c = await probeManifestCheck(withProbes(goodTargetRoutes(), {
      keyless: { url: '/api/status' },
      pricing: { url: '/api/status' },
      overCeiling: { url: '/api/widgets', param: 'spend' },
      knownEmpty: [{ url: '/api/widgets?a=1' }, { url: '/api/widgets?a=1#two' }], // 1 distinct
      knownForbidden: [{ url: '/api/widgets?a=1#three' }, { url: '/api/widgets?b=2' }], // overlaps knownEmpty
    }))
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/probes\.knownEmpty declares 1 distinct/)
    expect(c.detail).toMatch(/share URL/)
  })

  it('fails on required channels missing or below their distinct minimum', async () => {
    const c = await probeManifestCheck(withProbes(goodTargetRoutes(), {
      keyless: { url: '/api/status' },
      knownEmpty: [{ url: '/api/widgets?a=1' }, { url: '/api/widgets?a=1' }], // duplicates → 1 distinct
    }))
    expect(c.verdict).toBe('fail')
    expect(c.detail).toMatch(/probes\.knownEmpty declares 1 distinct/)
    expect(c.detail).toMatch(/probes\.pricing declares 0 distinct/)
    expect(c.detail).toMatch(/probes\.overCeiling declares 0 distinct/)
    expect(c.detail).toMatch(/probes\.knownForbidden declares 0 distinct/)
  })
})

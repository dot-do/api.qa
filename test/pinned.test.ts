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

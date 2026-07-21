import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { verifySuite, parseSuite } from '../src/pinned.js'
import { sha256Hex } from '../src/digest.js'
import { createApp } from '../src/worker.js'
import { ReportCache, MemoryKV } from '../src/cache.js'
import { type Fetcher } from '../src/http.js'
import { goodTargetRoutes, makeFetcher, GOOD } from './helpers.js'

const SUITE_PATH = fileURLToPath(new URL('../examples/golden-scenario.suite.json', import.meta.url))
const suiteText = readFileSync(SUITE_PATH, 'utf8')

const APIS = 'https://apis.directory'

/**
 * A mock apis.directory target: the standard discovery surfaces (from
 * goodTargetRoutes, path-keyed) PLUS the golden completion-ladder endpoints.
 *
 * POST /golden/run REQUIRES `seed` to be a NUMBER — that is the assertion that
 * TYPED whole-value env-var interpolation preserved the type (a stringified
 * "1" would 422). It echoes a `runId` derived from the (numeric) seed and the
 * (string) scenario, which the receipt probe then chains on with {{runId}}.
 */
function apisDirectoryFetcher(): Fetcher {
  const surfaces = makeFetcher(goodTargetRoutes(), APIS)
  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  return async (url, init) => {
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = u.pathname
    if (method === 'POST' && path === '/golden/run') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        scenario?: unknown
        seed?: unknown
      }
      if (typeof body.scenario !== 'string' || body.scenario.length === 0) {
        return jsonRes({ error: 'unknown scenario' }, 422)
      }
      if (typeof body.seed !== 'number') {
        return jsonRes({ error: `seed must be a number, got ${typeof body.seed}` }, 422)
      }
      const runId = `run-${body.seed}-${body.scenario}`
      return jsonRes({ settled: true, ledgerBalanced: true, runId })
    }
    const m = /^\/golden\/run\/(.+)$/.exec(path)
    if (method === 'GET' && m) {
      return jsonRes({ runId: decodeURIComponent(m[1]!), settled: true })
    }
    // Serve the standard discovery surfaces, rewriting the fixture's baked-in
    // good.example self-references to this origin so the declared openapi URL is
    // same-origin (and therefore fetchable + valid).
    const res = await surfaces(url, init)
    const body = (await res.text()).split(GOOD).join(APIS)
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' },
    })
  }
}

describe('reusable suite / collection mode', () => {
  it('runs the golden scenario as a REUSABLE suite against a selected environment, per-probe pass/fail, with a probe-N capture chained into probe N+1', async () => {
    const report = await verifySuite(suiteText, 'staging', {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
    expect(report.target).toBe(APIS)
    expect(report.suite.name).toBe('primitives-golden-scenario-suite')
    expect(report.suite.environment).toBe('staging')
    expect(report.suite.digest).toBe(await sha256Hex(suiteText))

    // Per-probe pass/fail is reported for every ordered requirement.
    const byId = Object.fromEntries(report.requirements.map((r) => [r.id, r.verdict]))
    expect(byId).toEqual({
      'openapi-published': 'pass',
      'golden-run-settles': 'pass',
      'run-receipt-fetchable': 'pass',
    })

    // The capture from probe 2 (runId) was used in probe 3's path + expect.
    // staging seed=1 (a NUMBER, proving typed interpolation) + scenario string.
    expect(report.evidence.bindings?.runId).toBe('run-1-dealer-slice')
    const receipt = report.requirements.find((r) => r.id === 'run-receipt-fetchable')!
    expect(receipt.verdict).toBe('pass')
  })

  it('interpolates env vars typed (whole-value preserves type) AND embedded (stringifies)', async () => {
    const suite = {
      $type: 'Suite',
      name: 'interp',
      version: '1',
      environments: {
        e: { vars: { baseUrl: GOOD, wantWidgets: 3, statusPath: 'api/status' } },
      },
      requirements: [
        {
          // embedded string token → coerced into the path
          id: 'status',
          kind: 'endpoint',
          method: 'GET',
          path: '/{{statusPath}}',
          expect: {
            status: 200,
            // whole-value token, wantWidgets is a NUMBER → typed compare 3 === 3
            paths: [{ path: 'widgets', equals: '{{wantWidgets}}' }],
          },
        },
      ],
    }
    const pass = await verifySuite(JSON.stringify(suite), 'e', {
      fetcher: makeFetcher(goodTargetRoutes()),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(pass.passed, JSON.stringify(pass.requirements, null, 2)).toBe(true)

    // If the number were stringified to "3", equals would mismatch the numeric 3.
    const wrong = { ...suite, environments: { e: { vars: { baseUrl: GOOD, wantWidgets: 2, statusPath: 'api/status' } } } }
    const fail = await verifySuite(JSON.stringify(wrong), 'e', {
      fetcher: makeFetcher(goodTargetRoutes()),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(fail.passed).toBe(false)
    expect(fail.requirements[0]!.detail).toMatch(/widgets/)
  })

  it('a referenced-but-undefined env var FAILS closed with a clear detail (never fetched)', async () => {
    const suite = {
      $type: 'Suite',
      name: 'undef',
      version: '1',
      environments: { e: { vars: { baseUrl: GOOD } } },
      requirements: [
        {
          id: 'needs-missing',
          kind: 'endpoint',
          method: 'GET',
          path: '/golden/run/{{missing}}',
          expect: { status: 200 },
        },
      ],
    }
    let fetched = 0
    const counting: Fetcher = (url, init) => {
      fetched++
      return makeFetcher(goodTargetRoutes())(url, init)
    }
    const report = await verifySuite(JSON.stringify(suite), 'e', {
      fetcher: counting,
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed).toBe(false)
    const req = report.requirements.find((r) => r.id === 'needs-missing')!
    expect(req.verdict).toBe('fail')
    expect(req.detail).toMatch(/undefined capture var \{\{missing\}\}/)
    // The suite path /golden/run/{{missing}} was never resolved, so it was
    // never fetched (only the standard discovery surfaces were).
    expect(fetched).toBeGreaterThan(0)
    expect(report.evidence.items.some((e) => /golden\/run/.test(e.url))).toBe(false)
  })

  it('the SUITE digest pin gates BEFORE any probe (wrong digest → refuse, nothing fetched)', async () => {
    let fetched = 0
    const counting: Fetcher = () => {
      fetched++
      return Promise.reject(new Error('should never fetch when the pin mismatches'))
    }
    await expect(
      verifySuite(suiteText, 'staging', {
        fetcher: counting,
        delayMs: 0,
        mode: 'local',
        expectedDigest: 'deadbeef',
      }),
    ).rejects.toThrow(/suite digest mismatch/)
    expect(fetched).toBe(0)

    // The honest pin runs.
    const ok = await verifySuite(suiteText, 'staging', {
      fetcher: apisDirectoryFetcher(),
      delayMs: 0,
      seed: 1,
      mode: 'local',
      expectedDigest: await sha256Hex(suiteText),
    })
    expect(ok.passed).toBe(true)
  })

  it('the SAME suite runs against two environments as two distinct runs (different seed → different captured id)', async () => {
    const staging = await verifySuite(suiteText, 'staging', {
      fetcher: apisDirectoryFetcher(), delayMs: 0, seed: 1, mode: 'local',
    })
    const prod = await verifySuite(suiteText, 'prod', {
      fetcher: apisDirectoryFetcher(), delayMs: 0, seed: 1, mode: 'local',
    })
    expect(staging.passed).toBe(true)
    expect(prod.passed).toBe(true)
    expect(staging.suite.environment).toBe('staging')
    expect(prod.suite.environment).toBe('prod')
    // Same suite text, same digest — the pin is invariant across environments.
    expect(staging.suite.digest).toBe(prod.suite.digest)
    // Different environments → different behavior (seed 1 vs 7 → different id).
    expect(staging.evidence.bindings?.runId).toBe('run-1-dealer-slice')
    expect(prod.evidence.bindings?.runId).toBe('run-7-dealer-slice')
  })

  it('unknown environment name fails closed before anything runs', async () => {
    let fetched = 0
    const counting: Fetcher = () => {
      fetched++
      return Promise.reject(new Error('should never fetch'))
    }
    await expect(
      verifySuite(suiteText, 'does-not-exist', { fetcher: counting, delayMs: 0, mode: 'local' }),
    ).rejects.toThrow(/unknown environment "does-not-exist"/)
    expect(fetched).toBe(0)
  })

  describe('SSRF gates are REUSED, not weakened', () => {
    it('an environment baseUrl at a private/metadata address is refused (normalizeTarget, remote mode)', async () => {
      const suite = {
        $type: 'Suite',
        name: 'ssrf-base',
        version: '1',
        environments: { e: { vars: { baseUrl: 'http://169.254.169.254' } } },
        requirements: [
          { id: 'probe', kind: 'endpoint', method: 'GET', path: '/latest/meta-data', expect: { status: 200 } },
        ],
      }
      let fetched = 0
      const counting: Fetcher = () => {
        fetched++
        return Promise.reject(new Error('should never fetch a private target'))
      }
      await expect(
        verifySuite(JSON.stringify(suite), 'e', { fetcher: counting, delayMs: 0, mode: 'remote' }),
      ).rejects.toThrow(/refusing private\/IP-literal target/)
      expect(fetched).toBe(0)
    })

    it('an interpolated probe URL that resolves off-origin is refused (resolveEndpoint same-origin re-gate)', async () => {
      const suite = {
        $type: 'Suite',
        name: 'ssrf-interp',
        version: '1',
        environments: { e: { vars: { baseUrl: GOOD, evil: 'https://evil.example/pwn' } } },
        requirements: [
          { id: 'exfil', kind: 'endpoint', method: 'GET', path: '{{evil}}', expect: { status: 200 } },
        ],
      }
      const report = await verifySuite(JSON.stringify(suite), 'e', {
        fetcher: makeFetcher(goodTargetRoutes()),
        delayMs: 0,
        seed: 1,
        mode: 'local',
      })
      expect(report.passed).toBe(false)
      const req = report.requirements.find((r) => r.id === 'exfil')!
      expect(req.verdict).toBe('fail')
      expect(req.detail).toMatch(/off-origin\/private/)
      // evil.example was never fetched.
      expect(report.evidence.items.some((e) => /evil\.example/.test(e.url))).toBe(false)
    })
  })

  it('parseSuite rejects a malformed environments map', () => {
    expect(() => parseSuite(JSON.stringify({ $type: 'Suite', name: 'x', version: '1', environments: [], requirements: [] }))).toThrow(/environments/)
    expect(() => parseSuite(JSON.stringify({ $type: 'Suite', name: 'x', version: '1', environments: { e: { vars: [] } }, requirements: [] }))).toThrow(/environment "e"/)
    // reuses the PinnedSpec requirement guards (duplicate id)
    expect(() =>
      parseSuite(
        JSON.stringify({
          $type: 'Suite', name: 'x', version: '1', environments: { e: { vars: {} } },
          requirements: [
            { id: 'dup', kind: 'endpoint', method: 'GET', path: '/a', expect: {} },
            { id: 'dup', kind: 'endpoint', method: 'GET', path: '/b', expect: {} },
          ],
        }),
      ),
    ).toThrow(/duplicate requirement id/)
  })
})

describe('worker runs a STORED suite by digest', () => {
  function suiteApp() {
    const kv = new MemoryKV()
    const env = { REPORTS: kv }
    const app = createApp(env, { externalFetcher: apisDirectoryFetcher(), externalDelayMs: 0 })
    return { app, kv }
  }
  const req = (path: string, body: unknown) =>
    new Request(`https://api.qa${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('stores an inline suite by digest, then runs it by digest alone against a selected environment', async () => {
    const { app } = suiteApp()
    const suiteObj = JSON.parse(suiteText) as unknown

    // 1. Inline submit → registers the suite text by digest and runs staging.
    const inline = await app.fetch(req('/suite', { environment: 'staging', suite: suiteObj }))
    expect(inline.status).toBe(200)
    const inlineReport = (await inline.json()) as { passed: boolean; suite: { digest: string } }
    expect(inlineReport.passed).toBe(true)

    const suiteDigest = await sha256Hex(JSON.stringify(suiteObj))
    expect(inlineReport.suite.digest).toBe(suiteDigest)

    // 2. Run the STORED suite by digest alone, this time against prod (a
    //    different environment → not served from the staging verdict cache, so
    //    the stored suite TEXT is actually retrieved and re-run).
    const byDigest = await app.fetch(req('/suite', { environment: 'prod', suiteDigest }))
    expect(byDigest.status).toBe(200)
    const prodReport = (await byDigest.json()) as {
      passed: boolean
      suite: { environment: string }
      evidence: { bindings?: { runId?: string } }
    }
    expect(prodReport.passed).toBe(true)
    expect(prodReport.suite.environment).toBe('prod')
    expect(prodReport.evidence.bindings?.runId).toBe('run-7-dealer-slice')
  })

  it('run-by-digest 404s when no suite is stored for that digest', async () => {
    const { app } = suiteApp()
    const res = await app.fetch(req('/suite', { environment: 'staging', suiteDigest: 'cafef00d' }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toMatch(/no stored suite/)
  })

  it('enforces the suite digest pin (wrong expectedDigest → 400, never a cached pass)', async () => {
    const { app } = suiteApp()
    const suiteObj = JSON.parse(suiteText) as unknown
    const res = await app.fetch(req('/suite', { environment: 'staging', suite: suiteObj, expectedDigest: 'deadbeef' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/digest mismatch/)
  })
})

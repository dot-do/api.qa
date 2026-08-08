/**
 * The `api.qa/vitest@1` SUBSET HARNESS + DIALECT LAYER (AXP A.8.6.2/A.8.6.3).
 *
 * What is pinned here, in dependency order:
 *
 *   1. **One implementation, byte-pinned.** The generated string constant the
 *      hosted isolate's module map carries is byte-identical to the canonical
 *      `src/exec/vitest-subset.mjs` — the A.8.6.2 "one module, never a
 *      reimplementation" law, enforced as a drift test exactly like the
 *      shipped-skill copy.
 *   2. **The guaranteed subset behaves** — describe/it/expect, async,
 *      rejects/resolves, `.not`, registration order — and everything OUTSIDE
 *      the subset fails BY NAME (snapshots, the `vi` surface, unknown
 *      matchers), never by silently diverging.
 *   3. **The closed import surface** — `"vitest"`, `"suite:env"`,
 *      `"suite:module"` (document-with-module only); `node:` builtins, bare
 *      specifiers, dynamic `import()`, `eval`, `new Function` are refused
 *      with the construct named.
 *   4. **The execution invariants of the LOCAL runner** (the parity reference
 *      for the hosted isolate): digest-independent here — the observe side
 *      gates digests — but the floor, the sandbox verb gate, the metered
 *      breaker, the combined/output caps, non-vacuity, and seeded
 *      determinism all fail closed with named reasons.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { VITEST_SUBSET_SOURCE } from '../src/exec/vitest-subset-source.js'
import {
  EXEC_CPU_MS,
  EXEC_WALL_MS,
  createGatedFetch,
  isFloorBlockedHost,
  loadHarnessModule,
  localExecRunner,
  validateDialectSource,
  type ExecRunRequest,
  type GateViolation,
} from '../src/exec/dialect.js'
import {
  RUNNER_UNAVAILABLE_NO_BINDING,
  RUNNER_UNAVAILABLE_NO_OUTBOUND,
  buildWorkerCode,
  gatewayFetch,
  unavailableExecRunner,
  workerLoaderExecRunner,
  type WorkerCodeLike,
} from '../src/exec/runner.js'

const ORIGIN = 'https://target.example'

/** A run request with sane defaults; override what the case needs. */
function req(overrides: Partial<ExecRunRequest> & Pick<ExecRunRequest, 'testsSource'>): ExecRunRequest {
  return {
    artifactKind: 'document',
    origin: ORIGIN,
    vars: {},
    environment: 'public',
    sandbox: false,
    seed: 7,
    declarativeRows: 0,
    ...overrides,
  }
}

/** A mock external fetch: any publicly-routable host answers 200 JSON. */
const okFetch = async (url: string): Promise<Response> =>
  new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'content-type': 'application/json' } })

// ---------------------------------------------------------------------------
// 1. One implementation, byte-pinned
// ---------------------------------------------------------------------------

describe('the shared harness is ONE module (A.8.6.2, normative)', () => {
  it('the generated source constant byte-matches the canonical vitest-subset.mjs', () => {
    const canonical = readFileSync(new URL('../src/exec/vitest-subset.mjs', import.meta.url), 'utf8')
    // Drifted? Regenerate: node scripts/gen-vitest-subset.mjs — the hosted
    // isolate executes the CONSTANT, the repo reviews the FILE; they must be
    // the same bytes or "one implementation" is a lie.
    expect(VITEST_SUBSET_SOURCE).toBe(canonical)
  })

  it('the canonical harness is self-contained: zero import statements', () => {
    // The bytes go verbatim into an isolate module map where nothing else
    // resolves; a single import would break the hosted runner.
    expect(/^\s*import\s/m.test(VITEST_SUBSET_SOURCE)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. The guaranteed subset — and named failure outside it
// ---------------------------------------------------------------------------

describe('the subset harness', () => {
  it('runs registered tests SEQUENTIALLY in registration order with nested describe names', async () => {
    const { createHarness } = await loadHarnessModule()
    const h = createHarness()
    const api = h.api as {
      describe: (n: string, f: () => void) => void
      it: (n: string, f: () => unknown) => void
      expect: (v: unknown) => Record<string, (...a: unknown[]) => void>
    }
    const order: string[] = []
    api.describe('outer', () => {
      api.it('first', async () => {
        order.push('first')
      })
      api.describe('inner', () => {
        api.it('second', () => {
          order.push('second')
        })
      })
    })
    api.it('third', () => {
      order.push('third')
    })
    const { registered, results } = await h.run()
    expect(registered).toBe(3)
    expect(order).toEqual(['first', 'second', 'third'])
    expect(results.map((r) => r.name)).toEqual(['outer > first', 'outer > inner > second', 'third'])
    expect(results.every((r) => r.status === 'pass' && typeof r.durationMs === 'number')).toBe(true)
  })

  it('core matchers judge, .not negates, a failure carries the matcher and values', async () => {
    const { createHarness } = await loadHarnessModule()
    const h = createHarness()
    const api = h.api as { it: (n: string, f: () => unknown) => void; expect: (v: unknown) => any }
    api.it('passes', () => {
      api.expect(2).toBe(2)
      api.expect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] })
      api.expect([1, 2]).toContain(2)
      api.expect({ a: 1, b: 2 }).toMatchObject({ a: 1 })
      api.expect(3).not.toBe(4)
      api.expect('abc').toMatch(/b/)
      api.expect(3.14159).toBeCloseTo(3.14, 2)
    })
    api.it('fails', () => {
      api.expect(2).toBe(3)
    })
    const { results } = await h.run()
    expect(results[0]!.status).toBe('pass')
    expect(results[1]!.status).toBe('fail')
    expect(results[1]!.reason).toContain('toBe')
    expect(results[1]!.reason).toContain('2')
    expect(results[1]!.reason).toContain('3')
  })

  it('rejects/resolves are awaited async assertion chains', async () => {
    const { createHarness } = await loadHarnessModule()
    const h = createHarness()
    const api = h.api as { it: (n: string, f: () => unknown) => void; expect: (v: unknown) => any }
    api.it('async assertions', async () => {
      await api.expect(Promise.resolve(41 + 1)).resolves.toBe(42)
      await api.expect(Promise.reject(new Error('boom goes the door'))).rejects.toThrow('boom')
    })
    api.it('a resolved promise fails rejects', async () => {
      await api.expect(Promise.resolve(1)).rejects.toThrow()
    })
    const { results } = await h.run()
    expect(results[0]!.status).toBe('pass')
    expect(results[1]!.status).toBe('fail')
    expect(results[1]!.reason).toContain('expected promise to reject')
  })

  it('snapshot matchers fail BY NAME — snapshot state cannot live in a pinned document', async () => {
    const { createHarness } = await loadHarnessModule()
    const h = createHarness()
    const api = h.api as { it: (n: string, f: () => unknown) => void; expect: (v: unknown) => any }
    api.it('snap', () => {
      api.expect({ a: 1 }).toMatchSnapshot()
    })
    const { results } = await h.run()
    expect(results[0]!.status).toBe('fail')
    expect(results[0]!.reason).toContain('toMatchSnapshot')
    expect(results[0]!.reason).toContain('outside the api.qa/vitest@1 subset')
  })

  it('the whole vi surface is poisoned: any property access fails naming vi.<symbol>', async () => {
    const { createHarness } = await loadHarnessModule()
    const h = createHarness()
    const api = h.api as { it: (n: string, f: () => unknown) => void; vi: Record<string, unknown> }
    api.it('mocks', () => {
      void (api.vi as { useFakeTimers: () => void }).useFakeTimers
    })
    const { results } = await h.run()
    expect(results[0]!.status).toBe('fail')
    expect(results[0]!.reason).toContain('vi.useFakeTimers')
  })
})

// ---------------------------------------------------------------------------
// 3. The closed import surface
// ---------------------------------------------------------------------------

describe('validateDialectSource — imports closed to exactly three specifiers', () => {
  const what = { allowSuiteModule: false, what: 'the suite document `tests` member' }

  it('accepts "vitest" and "suite:env"', () => {
    const v = validateDialectSource(`import { describe } from 'vitest'\nimport { origin } from 'suite:env'\n`, what)
    expect(v.ok).toBe(true)
  })

  it.each([
    ["import fs from 'node:fs'", 'node:fs', 'node: built-ins'],
    ["import axios from 'axios'", 'axios', 'bare package specifiers'],
    ["import x from './sibling.js'", './sibling.js', 'relative/path imports'],
  ])('refuses %s naming the specifier', (src, spec, why) => {
    const v = validateDialectSource(src, what)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.problem).toContain(spec)
      expect(v.problem).toContain(why)
    }
  })

  it('refuses "suite:module" unless the document carries a `module` member', () => {
    const src = "import { helper } from 'suite:module'"
    const closed = validateDialectSource(src, what)
    expect(closed.ok).toBe(false)
    const open = validateDialectSource(src, { allowSuiteModule: true, what: 'x' })
    expect(open.ok).toBe(true)
  })

  it.each([
    ['await import("vitest")', 'dynamic import()'],
    ['eval("1+1")', 'eval'],
    ['new Function("return 1")', 'new Function'],
  ])('refuses runtime code paths: %s', (src, name) => {
    const v = validateDialectSource(`it('x', () => { ${src} })`, what)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.problem).toContain(name)
  })
})

// ---------------------------------------------------------------------------
// The network floor — and NOTHING above it
// ---------------------------------------------------------------------------

describe('isFloorBlockedHost — the A.8.6.3 refusal set, and no more', () => {
  it.each([
    '169.254.169.254', // cloud metadata
    '2852039166', // the same address, decimal-encoded
    '169.254.0.7', // link-local
    '127.0.0.1',
    'localhost',
    '10.1.2.3',
    '172.16.9.9',
    '192.168.1.1', // RFC 1918
    '100.64.0.1',
    '100.127.255.254', // CGNAT 100.64/10
    'metadata.google.internal',
    'cooldown.internal', // estate-internal hostnames
    'suite-gateway', // single-label service names
    '[fe80::1]',
    '[fd00::1]', // link-local / ULA v6
    // Raw IP-literal hosts are barred CATEGORICALLY (inherited from the
    // verifier's own SSRF gate): a public service is reached by name, and a
    // literal is exactly the shape every encoding bypass arrives in. This is
    // over-broad ONLY in the closed direction — public DNS names are what the
    // floor leaves open.
    '100.1.2.3',
    '8.8.8.8',
  ])('bars %s', (host) => {
    expect(isFloorBlockedHost(host)).toBe(true)
  })

  it.each([
    'api.example', // ordinary public host
    'other-estate.example', // cross-estate composition is a FEATURE
    'pkg.do', // the module CDN
  ])('permits %s — full external egress above the floor', (host) => {
    expect(isFloorBlockedHost(host)).toBe(false)
  })
})

describe('createGatedFetch', () => {
  it('re-floors every redirect hop — a public host cannot 302 the run into metadata', async () => {
    const violations: GateViolation[] = []
    const gated = createGatedFetch({
      realFetch: async (url) =>
        url.startsWith('https://public.example')
          ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
          : okFetch(url),
      sandbox: false,
      violations,
    })
    await expect(gated('https://public.example/hop')).rejects.toThrow(/network floor/)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.reason).toContain('169.254.169.254')
  })

  it('follows a public→public redirect and returns the final response', async () => {
    const violations: GateViolation[] = []
    const gated = createGatedFetch({
      realFetch: async (url) =>
        url === 'https://a.example/'
          ? new Response(null, { status: 301, headers: { location: 'https://b.example/final' } })
          : okFetch(url),
      sandbox: false,
      violations,
    })
    const res = await gated('https://a.example/')
    expect(((await res.json()) as { url: string }).url).toBe('https://b.example/final')
    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. The local runner — the parity reference
// ---------------------------------------------------------------------------

describe('localExecRunner — document form', () => {
  it('runs an import-form suite end-to-end: suite:env + external egress + assertions', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({
        testsSource: `
import { describe, it, expect } from 'vitest'
import { origin, vars, seed, sandbox } from 'suite:env'

describe('the wired world', () => {
  it('sees the selected environment', () => {
    expect(origin).toBe('${ORIGIN}')
    expect(vars.token).toBe('t-123')
    expect(seed).toBe(7)
    expect(sandbox).toBe(false)
  })
  it('calls its own origin', async () => {
    const r = await fetch(origin + '/api/status')
    expect(r.status).toBe(200)
  })
  it('calls ANOTHER estate — cross-origin egress is a feature, not a leak', async () => {
    const r = await fetch('https://other-estate.example/compose')
    await expect(r.json()).resolves.toMatchObject({ ok: true })
  })
})
`,
        vars: { token: 't-123' },
      }),
    )
    expect(outcome.status).toBe('ran')
    if (outcome.status === 'ran') {
      expect(outcome.registered).toBe(3)
      expect(outcome.results.every((r) => r.status === 'pass')).toBe(true)
      expect(outcome.appliedLimits).toEqual({ wallMs: EXEC_WALL_MS, cpuMs: EXEC_CPU_MS })
    }
  })

  it('the GLOBALS form runs with no import line at all (document form, A.8.6.2)', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({
        testsSource: `
describe('globals', () => {
  it('describe/it/expect are ambient', () => {
    expect(1 + 1).toBe(2)
  })
})
`,
      }),
    )
    expect(outcome.status).toBe('ran')
    if (outcome.status === 'ran') expect(outcome.results[0]!.status).toBe('pass')
  })

  it('a `module` member instantiates first and is importable as "suite:module"', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({
        moduleSource: `export const checkDigit = (n) => (n * 3) % 10\nexport const label = 'gs1'\n`,
        testsSource: `
import { it, expect } from 'vitest'
import { checkDigit, label } from 'suite:module'

it('uses the suite module', () => {
  expect(checkDigit(4)).toBe(2)
  expect(label).toBe('gs1')
})
`,
      }),
    )
    expect(outcome.status).toBe('ran')
    if (outcome.status === 'ran') expect(outcome.results[0]!.status).toBe('pass')
  })

  it('a failing expectation yields status ran with the test failed and the reason named', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({ testsSource: `it('wrong', () => { expect(2).toBe(3) })` }),
    )
    expect(outcome.status).toBe('ran')
    if (outcome.status === 'ran') {
      expect(outcome.results[0]!.status).toBe('fail')
      expect(outcome.results[0]!.reason).toContain('toBe')
    }
  })

  it('Math.random is SEEDED: same seed same draws, different seed different draws (A.8.6.4)', async () => {
    const src = `it('draw', () => { globalThis.__vitest1_draw = Math.random() })`
    const g = globalThis as Record<string, unknown>
    await localExecRunner({ fetch: okFetch }).run(req({ testsSource: src, seed: 42 }))
    const first = g.__vitest1_draw
    await localExecRunner({ fetch: okFetch }).run(req({ testsSource: src, seed: 42 }))
    const second = g.__vitest1_draw
    await localExecRunner({ fetch: okFetch }).run(req({ testsSource: src, seed: 43 }))
    const third = g.__vitest1_draw
    delete g.__vitest1_draw
    expect(typeof first).toBe('number')
    expect(second).toBe(first)
    expect(third).not.toBe(first)
  })

  it('re-running the SAME bytes re-registers (module caching cannot spend a suite)', async () => {
    const src = `it('x', () => { expect(true).toBeTruthy() })`
    const a = await localExecRunner({ fetch: okFetch }).run(req({ testsSource: src }))
    const b = await localExecRunner({ fetch: okFetch }).run(req({ testsSource: src }))
    expect(a.status).toBe('ran')
    expect(b.status).toBe('ran')
    if (b.status === 'ran') expect(b.registered).toBe(1)
  })
})

describe('localExecRunner — fail-closed totality (A.8.6.3)', () => {
  it('a fetch toward cloud metadata FAILS THE RUN by a named reason', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({ testsSource: `it('steal', async () => { await fetch('http://169.254.169.254/latest/meta-data/') })` }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('network floor')
      expect(outcome.reason).toContain('169.254.169.254')
    }
  })

  it('an RFC1918 fetch fails the run even when the suite CATCHES the throw — no swallowing a refusal into a pass', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({
        testsSource: `it('swallow', async () => { try { await fetch('http://10.0.0.8/internal') } catch {} expect(1).toBe(1) })`,
      }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('10.0.0.8')
  })

  it('a mutating verb outside a sandbox environment fails the run by a named reason (A.8.6.4)', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({ testsSource: `it('write', async () => { await fetch('${ORIGIN}/things', { method: 'POST', body: '{}' }) })` }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('sandbox')
  })

  it('the SAME mutating verb is permitted when the environment declares sandbox: true', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({
        sandbox: true,
        testsSource: `it('write', async () => { const r = await fetch('${ORIGIN}/things', { method: 'POST', body: '{}' }); expect(r.status).toBe(200) })`,
      }),
    )
    expect(outcome.status).toBe('ran')
    if (outcome.status === 'ran') expect(outcome.results[0]!.status).toBe('pass')
  })

  it('the metered circuit-breaker trips the WHOLE run — never a partial verdict', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({
        limits: { wallMs: 50 },
        testsSource: `
it('quick', () => { expect(1).toBe(1) })
it('hangs', async () => { await new Promise((r) => setTimeout(r, 60_000)) })
`,
      }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('circuit breaker')
      expect(outcome.reason).toContain('50 ms')
    }
  }, 10_000)

  it('an all-of-nothing is refused: zero tests + zero rows fails (non-vacuity over the union)', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({ testsSource: `export const nothing = true\n` }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('non-vacuity')
  })

  it('a subset violation refuses BEFORE anything executes', async () => {
    const g = globalThis as Record<string, unknown>
    delete g.__vitest1_ran
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({ testsSource: `globalThis.__vitest1_ran = true\nimport fs from 'node:fs'\nit('x', () => {})` }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('node:fs')
    expect(g.__vitest1_ran).toBeUndefined()
  })
})

describe('localExecRunner — module artifact form', () => {
  it('a module artifact with a named `export` registers through that nullary export', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({
        artifactKind: 'module',
        exportName: 'suite',
        testsSource: `
import { it, expect } from 'vitest'
export function suite() {
  it('registered via the export seam', () => { expect('sdk').toHaveLength(3) })
}
export const unrelatedSdkSurface = 42
`,
      }),
    )
    expect(outcome.status).toBe('ran')
    if (outcome.status === 'ran') {
      expect(outcome.registered).toBe(1)
      expect(outcome.results[0]!.status).toBe('pass')
    }
  })

  it('a missing named export fails by name', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({ artifactKind: 'module', exportName: 'suite', testsSource: `export const notASuite = 1\n` }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('"suite"')
  })

  it('a module artifact is ALWAYS non-sandbox: a mutating verb fails there (implicit "public")', async () => {
    const outcome = await localExecRunner({ fetch: okFetch }).run(
      req({
        artifactKind: 'module',
        testsSource: `
import { it } from 'vitest'
it('write', async () => { await fetch('${ORIGIN}/x', { method: 'DELETE' }) })
`,
      }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('sandbox')
  })
})

// ---------------------------------------------------------------------------
// The hosted runner surface — WorkerCode assembly + feature detection
// ---------------------------------------------------------------------------

describe('the hosted Worker Loader runner (assembly + posture; the platform binding is flag-held)', () => {
  const request = req({ testsSource: `it('x', () => { expect(1).toBe(1) })`, digest: 'sha256:' + 'ab'.repeat(32) })

  it('buildWorkerCode: ZERO ambient authority — env is the empty object, always', () => {
    const code = buildWorkerCode(request, { stub: true })
    expect(code.env).toEqual({})
  })

  it('buildWorkerCode: globalOutbound is SET (never inherit the verifier network) and limits carry the CPU breaker', () => {
    const code = buildWorkerCode(request, { stub: true })
    expect(code.globalOutbound).toEqual({ stub: true })
    expect(code.limits).toEqual({ cpuMs: EXEC_CPU_MS })
  })

  it('buildWorkerCode: the module map carries the SHARED harness bytes verbatim and the pinned suite bytes verbatim', () => {
    const code = buildWorkerCode(request, { stub: true })
    expect(code.modules['./harness.mjs']!.js).toBe(VITEST_SUBSET_SOURCE)
    expect(code.modules['./suite-tests.mjs']!.js).toBe(request.testsSource)
    expect(Object.keys(code.modules)).toContain('vitest')
    expect(Object.keys(code.modules)).toContain('suite:env')
  })

  it('a runner without a loader binding reports the TYPED runner-unavailable outcome — never a crash', async () => {
    const outcome = await unavailableExecRunner().run(request)
    expect(outcome).toEqual({ status: 'runner-unavailable', reason: RUNNER_UNAVAILABLE_NO_BINDING })
  })

  it('a loader WITHOUT an outbound gateway refuses to run open (would inherit the verifier network)', async () => {
    const loader = {
      get: () => ({ getEntrypoint: () => ({ fetch: async () => new Response('{}') }) }),
    }
    const outcome = await workerLoaderExecRunner(loader, {}).run(request)
    expect(outcome).toEqual({ status: 'runner-unavailable', reason: RUNNER_UNAVAILABLE_NO_OUTBOUND })
  })

  it('with a (fake) loader + outbound, the parent folds the isolate response through the SAME totality fold', async () => {
    let builtCode: WorkerCodeLike | undefined
    const loader = {
      get: (_id: string, getCode: () => WorkerCodeLike | Promise<WorkerCodeLike>) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            builtCode = await getCode()
            return new Response(
              JSON.stringify({
                registered: 1,
                results: [{ name: 'x', status: 'pass', durationMs: 1 }],
                violations: [],
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          },
        }),
      }),
    }
    const outcome = await workerLoaderExecRunner(loader, { outbound: { stub: true } }).run(request)
    expect(outcome.status).toBe('ran')
    if (outcome.status === 'ran') expect(outcome.results[0]!.name).toBe('x')
    expect(builtCode?.env).toEqual({})
    expect(builtCode?.globalOutbound).toEqual({ stub: true })
  })

  it('an in-isolate violation reported by the entry FAILS the run with the reason named', async () => {
    const loader = {
      get: () => ({
        getEntrypoint: () => ({
          fetch: async () =>
            new Response(
              JSON.stringify({
                registered: 1,
                results: [{ name: 'x', status: 'pass', durationMs: 1 }],
                violations: [{ url: 'http://10.0.0.8/', reason: 'floor: refused 10.0.0.8' }],
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
        }),
      }),
    }
    const outcome = await workerLoaderExecRunner(loader, { outbound: {} }).run(request)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('10.0.0.8')
  })
})

describe('gatewayFetch — the parent-owned egress gateway', () => {
  it('bars a metadata request with a BLOCKED response (the isolate sees an ordinary failed fetch)', async () => {
    const res = await gatewayFetch(new Request('http://169.254.169.254/latest/meta-data/'), okFetch)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { type: string; reason: string }
    expect(body.type).toBe('BLOCKED')
    expect(body.reason).toContain('network floor')
  })

  it('passes an external public destination through untouched', async () => {
    const res = await gatewayFetch(new Request('https://other-estate.example/compose'), okFetch)
    expect(res.status).toBe(200)
  })
})

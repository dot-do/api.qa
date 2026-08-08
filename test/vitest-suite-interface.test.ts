/**
 * The card-declared `api.qa/vitest@1` EXECUTABLE suite, end-to-end through the
 * grading path (observe → judge), and the widened `interfaces.testSuite` seam.
 *
 * The observe side runs the isolate seam (here the LOCAL shared-harness
 * runner — local==hosted by construction, A.8.6.2) and records the typed
 * outcome as synthetic evidence; the judge (`runChecks`, pure) folds the
 * declarative rows and the executed tests into one verdict from the bundle
 * alone. Every property the ruling set fixes is asserted from the OUTSIDE:
 *
 *   - undeclared ⇒ skip (omission is conformance);
 *   - a passing executable suite ⇒ pass, with the A.8.6.5 attestation surface
 *     in the detail (digest, kind, environment, seed, breaker limits, counts);
 *   - digest fail-closed: a tampered byte ⇒ fail, NOTHING instantiated;
 *   - a failing registered test ⇒ fail naming the test;
 *   - the network floor blocks metadata/RFC1918 but permits external egress;
 *   - runner-unavailable ⇒ fail with the typed reason, never a crash/skip;
 *   - the seam: defective declarations fail (package w/o version, package
 *     under the declarative runner, export on a document, unknown runner).
 */

import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget, ROLE, parseAgentsJson } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { sha256HexSync } from '../src/sha256-sync.js'
import { localExecRunner } from '../src/exec/dialect.js'
import { unavailableExecRunner } from '../src/exec/runner.js'
import { VITEST_RUNNER, gateVitestSuiteCard } from '../src/test-suite.js'
import type { CheckResult } from '../src/types.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, type Routes } from './helpers.js'

const SUITE_PATH = '/.well-known/axp/suite.mjs.json' // a suite DOCUMENT (not .mjs)

const json = (value: unknown) => () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) })

/** An executable suite document the reference target genuinely passes. */
function execDoc(extra: Record<string, unknown> = {}) {
  return {
    $type: 'Suite',
    name: 'good.example workflows',
    version: '1.0.0',
    environments: { public: { vars: { token: 't-1' } } },
    tests: `
import { describe, it, expect } from 'vitest'
import { origin, vars } from 'suite:env'

describe('status → widgets workflow', () => {
  it('status is ok', async () => {
    const r = await fetch(origin + '/api/status')
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.ok).toBe(true)
    expect(b.widgets).toBeGreaterThan(0)
  })
  it('widgets lists, and the environment var is wired', async () => {
    expect(vars.token).toBe('t-1')
    const r = await fetch(origin + '/api/widgets')
    const list = await r.json()
    expect(list).toHaveLength(3)
    expect(list[0].id).toBe('w1')
  })
})
`,
    ...extra,
  }
}

function routesFor(opts: {
  suite?: unknown
  declaration?: unknown
  digest?: string
  suitePath?: string
  serveSuite?: boolean
  suiteBody?: { status: number; contentType: string; body: string }
} = {}): { routes: Routes; suiteText: string } {
  const base = goodTargetRoutes()
  const path = opts.suitePath ?? SUITE_PATH
  const suite = opts.suite ?? execDoc()
  const suiteText = typeof suite === 'string' ? suite : JSON.stringify(suite)
  const card = JSON.parse(
    base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
  ) as Record<string, any>
  card.interfaces.testSuite =
    opts.declaration ?? {
      url: path,
      digest: opts.digest ?? `sha256:${sha256HexSync(suiteText)}`,
      runner: VITEST_RUNNER,
    }
  const suiteRoute: Routes = {}
  if (opts.serveSuite !== false) {
    suiteRoute[`GET ${path}`] = opts.suiteBody ? () => opts.suiteBody! : () => ({ status: 200, contentType: 'application/json', body: suiteText })
  }
  return {
    routes: withOverrides(base, { 'GET /.well-known/agents.json': json(card), ...suiteRoute }),
    suiteText,
  }
}

async function judge(routes: Routes, execRunner = localExecRunner()) {
  const calls: string[] = []
  const inner = makeFetcher(routes)
  const observer = new Observer({
    fetcher: async (url, init) => {
      calls.push(url)
      return inner(url, init)
    },
    delayMs: 0,
  })
  const bundle = await observeTarget(GOOD, observer, 7, { execRunner })
  const checks = runChecks(bundle)
  return { bundle, checks, calls }
}

const ts = (checks: CheckResult[]) => checks.find((c) => c.id === 'published-test-suite')!

// ---------------------------------------------------------------------------
// The passing path + the attestation surface
// ---------------------------------------------------------------------------

describe('a declared api.qa/vitest@1 suite the surface passes', () => {
  it('PASSes, and the detail carries the A.8.6.5 attestation surface', async () => {
    const { routes } = routesFor()
    const { checks } = await judge(routes)
    const c = ts(checks)
    expect(c.verdict).toBe('pass')
    expect(c.detail).toContain(VITEST_RUNNER)
    expect(c.detail).toContain('document artifact')
    expect(c.detail).toContain('matches the card pin')
    expect(c.detail).toContain('2 registered test(s), all passed')
    expect(c.detail).toContain('seed 7')
    expect(c.detail).toContain('zero ambient authority')
  })

  it('records the executable run as synthetic evidence the judge reads (replay needs no re-exec)', async () => {
    const { routes } = routesFor()
    const { bundle, checks } = await judge(routes)
    const runEv = bundle.items.find((e) => e.role === ROLE.vitestRun)
    expect(runEv).toBeDefined()
    const record = JSON.parse(runEv!.body!) as { outcome: { status: string }; executedDigest: string }
    expect(record.outcome.status).toBe('ran')
    // Re-judging the STORED bundle (no observe, no isolate) reaches the same verdict.
    const replay = runChecks(bundle)
    expect(ts(replay).verdict).toBe(ts(checks).verdict)
  })

  it('runs declarative rows AND executable tests folded into one verdict', async () => {
    const withRows = execDoc({
      requirements: [
        { id: 'status-row', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200, paths: [{ path: 'ok', equals: true }] } },
      ],
    })
    const { routes } = routesFor({ suite: withRows })
    const { checks } = await judge(routes)
    const c = ts(checks)
    expect(c.verdict).toBe('pass')
    expect(c.detail).toContain('1 declarative row(s)')
  })
})

// ---------------------------------------------------------------------------
// Digest fail-closed
// ---------------------------------------------------------------------------

describe('digest fail-closed (A.8.6.3)', () => {
  it('a tampered byte fails and NOTHING is instantiated', async () => {
    const suite = execDoc()
    const suiteText = JSON.stringify(suite)
    const pin = `sha256:${sha256HexSync(suiteText)}`
    // Serve a document that does NOT hash to the pinned digest.
    const tampered = suiteText.replace('status → widgets workflow', 'status → widgets workflow (edited)')
    const { routes } = routesFor({ suite, digest: pin, suiteBody: { status: 200, contentType: 'application/json', body: tampered } })
    const { checks, bundle } = await judge(routes)
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('digest mismatch')
    // No run outcome was recorded — the gate refused before the runner.
    expect(bundle.items.find((e) => e.role === ROLE.vitestRun)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// A failing registered test
// ---------------------------------------------------------------------------

describe('a suite the surface VIOLATES', () => {
  it('fails, naming the failing test', async () => {
    const bad = execDoc({
      tests: `
import { it, expect } from 'vitest'
import { origin } from 'suite:env'
it('expects the wrong widget count', async () => {
  const r = await fetch(origin + '/api/widgets')
  const list = await r.json()
  expect(list).toHaveLength(99)
})
`,
    })
    const { routes } = routesFor({ suite: bad })
    const { checks } = await judge(routes)
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('violated its OWN published executable suite')
    expect(c.detail).toContain('expects the wrong widget count')
  })
})

// ---------------------------------------------------------------------------
// The network floor, end-to-end through the check
// ---------------------------------------------------------------------------

describe('the network floor through the grading path (A.8.6.3)', () => {
  it('a test that fetches cloud metadata FAILS the suite by a named reason', async () => {
    const evil = execDoc({
      tests: `
import { it } from 'vitest'
it('reaches for metadata', async () => { await fetch('http://169.254.169.254/latest/meta-data/') })
`,
    })
    const { routes } = routesFor({ suite: evil })
    const { checks } = await judge(routes)
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('network floor')
  })

  it('a test that composes with ANOTHER estate passes — external egress is a feature', async () => {
    const composed = execDoc({
      tests: `
import { it, expect } from 'vitest'
it('calls a sibling estate', async () => {
  const r = await fetch('https://other-estate.example/compose')
  expect(r.status).toBe(200)
})
`,
    })
    const { routes } = routesFor({ suite: composed })
    // The fixture fetcher only knows GOOD; wrap it so the cross-estate call
    // resolves (proving the FLOOR permits it — the refusal would be the floor,
    // not the fixture 404).
    const inner = makeFetcher(routes)
    const observer = new Observer({
      fetcher: async (url, init) =>
        url.startsWith('https://other-estate.example')
          ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
          : inner(url, init),
      delayMs: 0,
    })
    const bundle = await observeTarget(GOOD, observer, 7, { execRunner: localExecRunner() })
    expect(ts(runChecks(bundle)).verdict).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// runner-unavailable — the flag-held capability
// ---------------------------------------------------------------------------

describe('runner-unavailable (the Worker Loader binding not provisioned)', () => {
  it('a declared vitest@1 suite FAILS with the typed reason — never a crash, never a skip', async () => {
    const { routes } = routesFor()
    const { checks } = await judge(routes, unavailableExecRunner())
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.verdict).not.toBe('skip')
    expect(c.detail).toContain('runner-unavailable')
  })

  it('the DEFAULT (no execRunner passed) is runner-unavailable — a deploy without the binding fails closed', async () => {
    const { routes } = routesFor()
    const inner = makeFetcher(routes)
    const observer = new Observer({ fetcher: inner, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 7) // no opts
    expect(ts(runChecks(bundle)).verdict).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// The widened seam — defective declarations fail (A.8.5.2)
// ---------------------------------------------------------------------------

describe('the widened interfaces.testSuite seam', () => {
  it('parseAgentsJson reads url/package/version/export/digest/environment/runner', () => {
    const card = {
      interfaces: {
        testSuite: {
          url: 'https://pkg.do/apis.vin@1.2.0/index.mjs',
          package: 'apis.vin',
          version: '1.2.0',
          export: 'suite',
          digest: `sha256:${'ab'.repeat(32)}`,
          runner: VITEST_RUNNER,
        },
      },
    }
    const claims = parseAgentsJson(card, GOOD)
    expect(claims.testSuite?.packageName).toBe('apis.vin')
    expect(claims.testSuite?.version).toBe('1.2.0')
    expect(claims.testSuite?.exportName).toBe('suite')
    expect(claims.testSuite?.runner).toBe(VITEST_RUNNER)
  })

  it('a package WITHOUT a version fails at the card gate', () => {
    const claim = parseAgentsJson(
      { interfaces: { testSuite: { package: 'apis.vin', digest: `sha256:${'a'.repeat(64)}`, runner: VITEST_RUNNER } } },
      GOOD,
    ).testSuite!
    const g = gateVitestSuiteCard(claim, GOOD)
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.problem).toContain('no `version`')
  })

  it('an OFF-ORIGIN module CDN url is ACCEPTED — the digest, never the host, is the authority (A.8.6.6)', () => {
    const claim = parseAgentsJson(
      {
        interfaces: {
          testSuite: { url: 'https://pkg.do/apis.vin@1.2.0/index.mjs', digest: `sha256:${'a'.repeat(64)}`, runner: VITEST_RUNNER },
        },
      },
      GOOD,
    ).testSuite!
    const g = gateVitestSuiteCard(claim, GOOD)
    expect(g.ok).toBe(true)
    if (g.ok) {
      expect(g.kind).toBe('module') // .mjs pathname ⇒ module, by the card
      expect(g.url).toBe('https://pkg.do/apis.vin@1.2.0/index.mjs')
    }
  })

  it('a url-less package@version DERIVES the native-serving address (A.8.6.6)', () => {
    const claim = parseAgentsJson(
      { interfaces: { testSuite: { package: 'apis.vin', version: '2.0.0', digest: `sha256:${'a'.repeat(64)}`, runner: VITEST_RUNNER } } },
      GOOD,
    ).testSuite!
    const g = gateVitestSuiteCard(claim, GOOD)
    expect(g.ok).toBe(true)
    if (g.ok) {
      expect(g.url).toBe('https://pkg.do/apis.vin@2.0.0/index.mjs')
      expect(g.npm).toEqual({ package: 'apis.vin', version: '2.0.0' })
    }
  })

  it('an export on a DOCUMENT artifact fails (export is module-kind-only)', () => {
    const claim = parseAgentsJson(
      { interfaces: { testSuite: { url: '/suite.json', export: 'suite', digest: `sha256:${'a'.repeat(64)}`, runner: VITEST_RUNNER } } },
      GOOD,
    ).testSuite!
    const g = gateVitestSuiteCard(claim, GOOD)
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.problem).toContain('module export')
  })

  it('a metadata artifact address is refused WITHOUT fetching', () => {
    const claim = parseAgentsJson(
      { interfaces: { testSuite: { url: 'http://169.254.169.254/suite.json', digest: `sha256:${'a'.repeat(64)}`, runner: VITEST_RUNNER } } },
      GOOD,
    ).testSuite!
    const g = gateVitestSuiteCard(claim, GOOD)
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.problem).toContain('network floor')
  })
})

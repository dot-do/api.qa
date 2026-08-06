/**
 * The OPTIONAL, card-DECLARED published test suite (`interfaces.testSuite`)
 * and its check, `published-test-suite`.
 *
 * The owner's case for the interface: *"the service COULD publish tests for
 * more complex workflows/functionality, but it isn't required because simple
 * crud apis and/or lookups don't need that much complexity."* So the first
 * property below is the one that matters most, and everything else exists to
 * make sure buying it did not cost anything.
 *
 *   1. **Undeclared is not a failure.** A card that omits the key SKIPs, is
 *      never fetched for, spends no budget, and its grade is untouched. A CRUD
 *      API that publishes no suite stays fully conformant.
 *   2. **Declared is judged strictly**, because a machine-readable claim is one
 *      a verifier will believe — and because an optionality mechanism is an
 *      EVASION mechanism if a defective declaration can buy a skip. Every
 *      failing case is here: digest mismatch, off-origin url, missing/malformed
 *      pin, unknown runner, absent environment, refused kinds, the requirement
 *      cap, and a target that violates its own published assertions.
 *   3. **The execution boundary is real and tested**, not asserted in a
 *      comment: writes refused, target pinned to the card origin against a
 *      hostile `baseUrl`, sub-run evidence namespaced so it cannot shadow the
 *      parent's.
 */

import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget, ROLE, SUITE_ROLE_PREFIX, parseAgentsJson } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import { sha256HexSync } from '../src/sha256-sync.js'
import { MAX_SUITE_REQUIREMENTS, SUITE_RUNNER } from '../src/test-suite.js'
import { OPTIONAL_DECLARED_INTERFACES, OPTIONAL_INTERFACE_PATH_RE } from '../src/optional-interfaces.js'
import type { CheckResult } from '../src/types.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, type Routes } from './helpers.js'

const SUITE_PATH = '/.well-known/axp/suite.json'
const OMIT = Symbol('omit')

const json = (value: unknown, contentType = 'application/json') => () => ({
  status: 200,
  contentType,
  body: JSON.stringify(value),
})

/** A suite the reference target genuinely passes: a two-step read workflow. */
function validSuite(extra: Record<string, unknown> = {}) {
  return {
    $type: 'Suite',
    name: 'good.example public contracts',
    version: '1.0.0',
    environments: { public: { vars: {} } },
    requirements: [
      {
        id: 'status-ok',
        kind: 'endpoint',
        method: 'GET',
        path: '/api/status',
        expect: { status: 200, paths: [{ path: 'ok', equals: true }] },
      },
      {
        id: 'widgets-list',
        kind: 'endpoint',
        method: 'GET',
        path: '/api/widgets',
        expect: { status: 200, paths: [{ path: '0.id', exists: true }] },
        capture: { first: '0.id' },
      },
    ],
    ...extra,
  }
}

/**
 * Build routes whose card declares `interfaces.testSuite`, with the digest
 * computed over the EXACT bytes served — so a test that wants a mismatch has to
 * ask for one explicitly rather than getting one by accident.
 */
function routesFor(
  opts: {
    suite?: unknown
    declaration?: unknown | typeof OMIT
    /** Override the card's digest (e.g. to force a mismatch). */
    digest?: string
    /** Omit the suite route entirely (404). */
    serveSuite?: boolean
    /** Serve something other than the JSON suite text. */
    suiteBody?: { status: number; contentType: string; body: string }
    extraRoutes?: Routes
  } = {},
): Routes {
  const base = goodTargetRoutes()
  const suite = opts.suite ?? validSuite()
  const suiteText = typeof suite === 'string' ? suite : JSON.stringify(suite)
  const card = JSON.parse(
    base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
  ) as Record<string, any>

  const declaration =
    opts.declaration !== undefined
      ? opts.declaration
      : { url: SUITE_PATH, digest: opts.digest ?? `sha256:${sha256HexSync(suiteText)}` }
  if (declaration !== OMIT) card.interfaces.testSuite = declaration

  const suiteRoute: Routes = {}
  if (opts.serveSuite !== false) {
    suiteRoute[`GET ${SUITE_PATH}`] = opts.suiteBody
      ? () => opts.suiteBody!
      : () => ({ status: 200, contentType: 'application/json', body: suiteText })
  }

  return withOverrides(base, {
    'GET /.well-known/agents.json': json(card),
    ...suiteRoute,
    ...(opts.extraRoutes ?? {}),
  })
}

async function judge(routes: Routes, origin = GOOD) {
  const calls: string[] = []
  const inner = makeFetcher(routes, origin)
  const observer = new Observer({
    fetcher: async (url, init) => {
      calls.push(url)
      return inner(url, init)
    },
    delayMs: 0,
  })
  const bundle = await observeTarget(origin, observer, 7)
  const checks = runChecks(bundle)
  const { grade } = gradeOf(axScoreOf(checks), checks)
  return { bundle, checks, grade, calls }
}

const ts = (checks: CheckResult[]) => checks.find((c) => c.id === 'published-test-suite')!

// ---------------------------------------------------------------------------
// 1. Undeclared is fully conforming — the property the interface exists for
// ---------------------------------------------------------------------------

describe('a card that declares no test suite is fully conforming', () => {
  it('SKIPs, with the wording that says a skip is not a free pass (§8.24)', async () => {
    const { checks } = await judge(routesFor({ declaration: OMIT }))
    const c = ts(checks)
    expect(c.verdict).toBe('skip')
    expect(c.detail).toBe(
      'no published test suite interface declared (agents.json `interfaces.testSuite` absent) — the interface is OPTIONAL and this card does not claim it, so nothing was fetched and nothing is judged; under a pinned must:pass this fails closed',
    )
  })

  it('costs no fetch and no budget — nothing under the suite path is ever requested', async () => {
    const { calls } = await judge(routesFor({ declaration: OMIT }))
    expect(calls.some((u) => u.includes('suite'))).toBe(false)
  })

  it('leaves the grade and every other check identical to a card with no such key', async () => {
    const withKey = await judge(routesFor({ declaration: OMIT }))
    const plain = await judge(goodTargetRoutes())
    expect(withKey.grade).toBe(plain.grade)
    // Every check except the new one behaves identically.
    const strip = (cs: CheckResult[]) =>
      cs.filter((c) => c.id !== 'published-test-suite').map((c) => `${c.id}:${c.verdict}`)
    expect(strip(withKey.checks)).toEqual(strip(plain.checks))
  })

  it('the check moves no AX point — it is an additive readiness dimension', async () => {
    const declared = await judge(routesFor())
    const undeclared = await judge(routesFor({ declaration: OMIT }))
    expect(ts(declared.checks).axItem).toBeUndefined()
    expect(axScoreOf(declared.checks).points).toBe(axScoreOf(undeclared.checks).points)
  })
})

// ---------------------------------------------------------------------------
// 2. The happy path — declared, pinned, and actually passed
// ---------------------------------------------------------------------------

describe('a declared suite the surface genuinely passes', () => {
  it('PASSes, and the detail is legible about what was and was not judged', async () => {
    const { checks } = await judge(routesFor())
    const c = ts(checks)
    expect(c.verdict).toBe('pass')
    expect(c.detail).toContain('interfaces.testSuite declared')
    expect(c.detail).toContain('matches the card pin')
    expect(c.detail).toContain('2 requirement(s) over 2 distinct pathname(s), all passed')
    expect(c.detail).toContain('GET/HEAD-only with writes disabled')
    // §6.5 — triviality is made LEGIBLE, never silently judged.
    expect(c.detail).toContain('NOT judged: whether the suite is ambitious')
  })

  it('records each exchange under a `suite:`-namespaced role and cites them as evidence', async () => {
    const { bundle, checks } = await judge(routesFor())
    const roles = bundle.items.map((e) => e.role)
    expect(roles).toContain(ROLE.testSuite)
    expect(roles).toContain(`${SUITE_ROLE_PREFIX}pinned:status-ok`)
    expect(roles).toContain(`${SUITE_ROLE_PREFIX}pinned:widgets-list`)
    expect(ts(checks).evidence).toContain(`${SUITE_ROLE_PREFIX}pinned:status-ok`)
  })

  it('re-judges identically from the stored bundle — replay needs no refetch', async () => {
    const { bundle, checks } = await judge(routesFor())
    // runChecks is pure over the bundle; the digest is RE-COMPUTED from the
    // stored suite text, so the pin still binds after serialization.
    const replayed = runChecks(JSON.parse(JSON.stringify(bundle)))
    expect(ts(replayed).verdict).toBe('pass')
    expect(ts(replayed).detail).toBe(ts(checks).detail)
  })

  it('runs a CAPTURE-CHAINED workflow — the multi-step case the interface exists for', async () => {
    const suite = {
      $type: 'Suite',
      name: 'chained', version: '1.0.0',
      environments: { public: { vars: {} } },
      requirements: [
        {
          id: 'list', kind: 'endpoint', method: 'GET', path: '/api/widgets',
          expect: { status: 200 }, capture: { first: '0.id' },
        },
        {
          id: 'fetch-one', kind: 'endpoint', method: 'GET', path: '/api/widgets/{{first}}',
          expect: { status: 200, paths: [{ path: 'id', equals: 'w1' }] },
        },
      ],
    }
    const { bundle, checks } = await judge(
      routesFor({ suite, extraRoutes: { 'GET /api/widgets/w1': json({ id: 'w1', name: 'widget one' }) } }),
    )
    expect(ts(checks).verdict).toBe('pass')
    // The chained URL really was resolved from the captured value.
    const ev = bundle.items.find((e) => e.role === `${SUITE_ROLE_PREFIX}pinned:fetch-one`)
    expect(ev?.url).toBe(`${GOOD}/api/widgets/w1`)
  })
})

// ---------------------------------------------------------------------------
// 3. THE FAILING CASES (§8.15-§8.25)
// ---------------------------------------------------------------------------

describe('a declared suite is judged strictly — the failing cases', () => {
  it('§8.15 digest MISMATCH fails, and the detail names both digests', async () => {
    const bogus = `sha256:${'0'.repeat(64)}`
    const { checks } = await judge(routesFor({ digest: bogus }))
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('suite digest mismatch')
    expect(c.detail).toContain(bogus.slice('sha256:'.length))
    expect(c.detail).toContain(sha256HexSync(JSON.stringify(validSuite())))
  })

  it('§8.16 an OFF-ORIGIN url fails WITHOUT fetching it', async () => {
    const { checks, calls } = await judge(
      routesFor({ declaration: { url: 'https://evil.example/suite.json', digest: `sha256:${'a'.repeat(64)}` } }),
    )
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('NOT the target origin')
    expect(calls.some((u) => u.includes('evil.example'))).toBe(false)
  })

  it('§8.17 a POST requirement fails — writes are refused, never issued', async () => {
    const suite = validSuite()
    ;(suite.requirements as any[]).push({
      id: 'create', kind: 'endpoint', method: 'POST', path: '/api/widgets',
      body: { name: 'x' }, expect: { status: 201 },
    })
    const { checks, bundle } = await judge(routesFor({ suite }))
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('GET/HEAD ONLY')
    expect(c.detail).toContain('"create"')
    // And nothing ran at all — an ineligible suite is refused whole, not partly
    // run up to the offending requirement.
    expect(bundle.items.some((e) => e.role.startsWith(SUITE_ROLE_PREFIX))).toBe(false)
    // No POST was ever issued against the target.
    expect(bundle.items.some((e) => e.method === 'POST')).toBe(false)
  })

  it("§8.18 a kind:'check' requirement fails — no self-grading, no recursion", async () => {
    const suite = validSuite()
    ;(suite.requirements as any[]).push({
      id: 'self', kind: 'check', check: 'published-test-suite', must: 'pass',
    })
    const { checks } = await judge(routesFor({ suite }))
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain("kind:'check'")
    expect(c.detail).toContain('recurse')
  })

  it("§8.18b kind:'ax-floor' and kind:'surface' are refused too", async () => {
    for (const [req, needle] of [
      [{ id: 'floor', kind: 'ax-floor', minScore: 1 }, "kind:'ax-floor'"],
      [{ id: 'surf', kind: 'surface', surface: 'llms.txt', must: 'present' }, "kind:'surface'"],
    ] as const) {
      const suite = validSuite()
      ;(suite.requirements as any[]).push(req)
      const c = ts((await judge(routesFor({ suite }))).checks)
      expect(c.verdict, needle).toBe('fail')
      expect(c.detail).toContain(needle)
    }
  })

  it('§8.19 a suite over the requirement cap FAILS — it is never truncated', async () => {
    const suite = validSuite()
    suite.requirements = Array.from({ length: MAX_SUITE_REQUIREMENTS + 1 }, (_, i) => ({
      id: `r${i}`, kind: 'endpoint', method: 'GET', path: '/api/status',
      expect: { status: 200 },
    })) as any
    const { checks, bundle } = await judge(routesFor({ suite }))
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain(`${MAX_SUITE_REQUIREMENTS + 1} requirements`)
    expect(c.detail).toContain('hide a failing requirement past the cutoff')
    // Proof it truncated nothing: no suite requirement ran at all.
    expect(bundle.items.some((e) => e.role.startsWith(SUITE_ROLE_PREFIX))).toBe(false)
  })

  it('§8.20 an environment the suite does not define fails', async () => {
    const { checks } = await judge(
      routesFor({
        declaration: {
          url: SUITE_PATH,
          digest: `sha256:${sha256HexSync(JSON.stringify(validSuite()))}`,
          environment: 'staging',
        },
      }),
    )
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('"staging"')
    expect(c.detail).toContain('does not define')
  })

  it('§8.21 an unknown runner FAILS — it does not skip', async () => {
    const { checks, calls } = await judge(
      routesFor({
        declaration: {
          url: SUITE_PATH,
          digest: `sha256:${sha256HexSync(JSON.stringify(validSuite()))}`,
          runner: 'vitest@3',
        },
      }),
    )
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.verdict).not.toBe('skip')
    expect(c.detail).toContain('vitest@3')
    expect(c.detail).toContain('This is a FAILURE, not a skip')
    expect(calls.some((u) => u.includes('suite.json'))).toBe(false)
  })

  it('§8.22 a target that VIOLATES its own published suite fails, naming the requirement', async () => {
    // The suite asserts /api/status returns ok:true; the target says ok:false.
    const { checks } = await judge(
      routesFor({ extraRoutes: { 'GET /api/status': json({ ok: false, widgets: 3 }) } }),
    )
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('violated its OWN published suite')
    expect(c.detail).toContain('"status-ok"')
    expect(c.detail).toContain('path ok = false, wanted true')
  })

  it('§8.23 a hostile `baseUrl` env var cannot steer the run off the card origin', async () => {
    const suite = {
      $type: 'Suite', name: 'steered', version: '1.0.0',
      environments: { public: { vars: { baseUrl: 'https://evil.example' } } },
      requirements: [
        // An ABSOLUTE off-origin interpolation: resolveEndpoint must refuse it.
        { id: 'steer', kind: 'endpoint', method: 'GET', path: '{{baseUrl}}/api/status', expect: { status: 200 } },
      ],
    }
    const { checks, calls } = await judge(routesFor({ suite }))
    expect(calls.some((u) => u.includes('evil.example'))).toBe(false)
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('off-origin/private url')
  })

  it('MISSING suite evidence fails closed — the property the wall-clock deadline relies on', async () => {
    // The sub-run stops at SUITE_DEADLINE_MS, leaving later requirements
    // unobserved. Waiting 20s in CI would be absurd, so the load-bearing half
    // is tested directly: an unobserved requirement must FAIL, never pass. That
    // is what makes a deadline breach fail-closed rather than "pass what we
    // got" — the same reason an over-long suite is refused instead of truncated.
    const { bundle } = await judge(routesFor())
    const starved = {
      ...bundle,
      items: bundle.items.filter((e) => e.role !== `${SUITE_ROLE_PREFIX}pinned:widgets-list`),
    }
    const c = ts(runChecks(starved))
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('"widgets-list"')
    expect(c.detail).toContain('not observed')
  })

  it('§8.25 suite evidence cannot shadow the parent run — roles are namespaced', async () => {
    // A suite requirement id chosen to collide with a plausible admission-spec
    // requirement id. Unprefixed, `find(role === 'pinned:status-ok')` would
    // resolve suite evidence for an admission requirement (or vice versa).
    const suite = {
      $type: 'Suite', name: 'collide', version: '1.0.0',
      environments: { public: { vars: {} } },
      requirements: [
        { id: 'status-ok', kind: 'endpoint', method: 'GET', path: '/api/status', expect: { status: 200 } },
      ],
    }
    const { bundle, checks } = await judge(routesFor({ suite }))
    expect(ts(checks).verdict).toBe('pass')
    const roles = bundle.items.map((e) => e.role)
    // The suite's evidence exists ONLY under the namespace…
    expect(roles).toContain(`${SUITE_ROLE_PREFIX}pinned:status-ok`)
    // …and never leaks a bare `pinned:` role into the parent bundle.
    expect(roles.filter((r) => r.startsWith('pinned:'))).toEqual([])
    expect(roles.filter((r) => r === 'pinned:status-ok')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Defective declarations FAIL — a bad claim never buys a skip
// ---------------------------------------------------------------------------

describe('a defective declaration fails rather than skipping (the evasion guard)', () => {
  it('a present-but-non-object value is MALFORMED, never treated as absent', async () => {
    for (const [value, name] of [
      [null, 'null'], [false, 'boolean'], [0, 'number'], ['', 'string'],
      ['yes', 'string'], [[], 'array'],
    ] as const) {
      const c = ts((await judge(routesFor({ declaration: value }))).checks)
      expect(c.verdict, JSON.stringify(value)).toBe('fail')
      expect(c.verdict).not.toBe('skip')
      expect(c.detail).toContain(`got ${name}`)
      expect(c.detail).toContain('omitting it is fully conforming')
    }
  })

  it('an EMPTY object declaration fails for having no url — presence is a claim', async () => {
    const c = ts((await judge(routesFor({ declaration: {} }))).checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('declares no `url`')
  })

  it('a MISSING digest fails without fetching — the pin is required', async () => {
    const { checks, calls } = await judge(routesFor({ declaration: { url: SUITE_PATH } }))
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('MUST be digest-pinned')
    expect(c.detail).toContain('rewrite its assertions')
    expect(calls.some((u) => u.includes('suite.json'))).toBe(false)
  })

  it('a malformed digest STRING fails without fetching', async () => {
    for (const digest of ['deadbeef', 'sha256:xyz', `sha256:${'A'.repeat(64)}`, `md5:${'a'.repeat(32)}`]) {
      const { checks, calls } = await judge(routesFor({ declaration: { url: SUITE_PATH, digest } }))
      expect(ts(checks).verdict, digest).toBe('fail')
      expect(ts(checks).detail).toContain('sha256:<64 lowercase hex>')
      expect(calls.some((u) => u.includes('suite.json'))).toBe(false)
    }
  })

  it('a declared suite that 404s fails', async () => {
    const { checks } = await judge(routesFor({ serveSuite: false }))
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('did not answer 2xx')
  })

  it('a declared suite whose body is not JSON fails on the digest or the parse, never passes', async () => {
    const body = 'not json at all'
    const { checks } = await judge(
      routesFor({
        digest: `sha256:${sha256HexSync(body)}`,
        suiteBody: { status: 200, contentType: 'application/json', body },
      }),
    )
    const c = ts(checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('did not parse as an api.qa Suite')
  })

  it('a JSON document that is not a Suite fails', async () => {
    const body = JSON.stringify({ $type: 'PinnedSpec', requirements: [] })
    const { checks } = await judge(
      routesFor({ digest: `sha256:${sha256HexSync(body)}`, suiteBody: { status: 200, contentType: 'application/json', body } }),
    )
    expect(ts(checks).verdict).toBe('fail')
    expect(ts(checks).detail).toContain('not a Suite')
  })

  it('an EMPTY requirement list is refused — a vacuous suite must not pass', async () => {
    const suite = { ...validSuite(), requirements: [] }
    const { checks } = await judge(routesFor({ suite }))
    expect(ts(checks).verdict).toBe('fail')
    expect(ts(checks).detail).toContain('verifies nothing')
  })

  it("§8.24' a suite whose requirement is kind:'probe' is refused with its own named reason", async () => {
    const suite = validSuite()
    ;(suite.requirements as any[]).push({
      id: 'probe-it', kind: 'probe', probe: 'pricing', expect: { status: 200 },
    })
    const c = ts((await judge(routesFor({ suite }))).checks)
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain("kind:'probe'")
    expect(c.detail).toContain(SUITE_RUNNER)
  })
})

// ---------------------------------------------------------------------------
// 5. The card parse — presence, not truthiness
// ---------------------------------------------------------------------------

describe('parseAgentsJson reads the declaration by PRESENCE', () => {
  it('absent key ⇒ undefined; present key ⇒ declared, whatever the value', () => {
    expect(parseAgentsJson({ interfaces: {} }, GOOD).testSuite).toBeUndefined()
    expect(parseAgentsJson({ interfaces: { testSuite: {} } }, GOOD).testSuite?.declared).toBe(true)
    expect(parseAgentsJson({ interfaces: { testSuite: null } }, GOOD).testSuite?.malformed).toBe(true)
  })

  it('defaults environment and runner, and absolutizes a relative url same-origin', () => {
    const c = parseAgentsJson({ interfaces: { testSuite: { url: '/s.json' } } }, GOOD).testSuite!
    expect(c.environment).toBe('public')
    expect(c.runner).toBe(SUITE_RUNNER)
    expect(c.url).toBe(`${GOOD}/s.json`)
  })

  it('PRESERVES an absolute off-origin url verbatim so the gate can drop it', () => {
    const c = parseAgentsJson(
      { interfaces: { testSuite: { url: 'https://evil.example/s.json' } } }, GOOD,
    ).testSuite!
    expect(c.url).toBe('https://evil.example/s.json')
  })

  it('does NOT satisfy the non-empty interfaces obligation — a suite is not a way to call the API', () => {
    // Clause 6's `check-card-interfaces-linked` reads endpoints/mcp only. A
    // sibling key must be structurally incapable of satisfying it.
    const c = parseAgentsJson({ interfaces: { testSuite: { url: '/s.json' } } }, GOOD)
    expect(c.endpoints).toEqual([])
    expect(c.mcp).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. The registry — eligibility, and its grammar
// ---------------------------------------------------------------------------

describe('the optional-interface registry', () => {
  it('binds published-test-suite to interfaces.testSuite, and only that', () => {
    expect(OPTIONAL_DECLARED_INTERFACES['published-test-suite']).toBe('interfaces.testSuite')
  })

  it('every registered path matches the two-segment grammar', () => {
    for (const [check, path] of Object.entries(OPTIONAL_DECLARED_INTERFACES)) {
      expect(OPTIONAL_INTERFACE_PATH_RE.test(path), `${check} -> ${path}`).toBe(true)
    }
  })

  it('is frozen — eligibility is not editable at runtime', () => {
    expect(Object.isFrozen(OPTIONAL_DECLARED_INTERFACES)).toBe(true)
  })

  it('registers only ADDITIVE capabilities — no check any AXP clause binds', () => {
    // The evasion guard, from api.qa's side: these are the checks the ratified
    // AXP spec pins as unconditional MUSTs. None may ever become
    // declaration-armed, or the MUST stops being a MUST.
    const axpMustChecks = [
      'agents-json', 'machine-legible-home', 'conneg-accept', 'conneg-client-class',
      'conneg-alternates', 'conneg-forced-face', 'card-interfaces-linked',
      'probe-manifest', 'keyless-flow', 'offers-402',
    ]
    for (const id of axpMustChecks) {
      expect(OPTIONAL_DECLARED_INTERFACES, id).not.toHaveProperty(id)
    }
  })
})

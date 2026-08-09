/**
 * Declarative suite-row BODY CAP + honest truncation (the apis.vin false-fail).
 *
 * The bug: declarative suite rows (card-declared suite@1 AND pinned/`verifySuite`
 * endpoint requirements) were fetched under the Observer's 256 KiB discovery-
 * surface default. A real API endpoint that legitimately returns hundreds of KB
 * of VALID JSON (apis.vin `/listings`, ~308 KB) had its body severed mid-token,
 * the truncation was never recorded on the Evidence, and `judgeExpect` reported
 * the lie "body is not JSON" although the target answered 200 with a perfectly
 * valid document.
 *
 * The fix, proven in BOTH directions here:
 *   (a) a ~308 KB valid-JSON row response PASSES its JSON expectations under
 *       the raised SUITE_ROW_MAX_BODY_BYTES (4 MiB) cap;
 *   (b) a genuinely non-JSON body still FAILS with "body is not JSON" — the
 *       grader got no more lenient;
 *   (c) a body beyond even the raised cap still FAILS — but with the HONEST
 *       "body too large: truncated at N bytes" reason carried by the new
 *       `Evidence.truncated` flag, never the misleading "not JSON".
 */

import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { judgeExpect } from '../src/expect.js'
import { verifySuite } from '../src/pinned.js'
import { sha256HexSync } from '../src/sha256-sync.js'
import { SUITE_ROW_MAX_BODY_BYTES } from '../src/test-suite.js'
import type { Evidence, CheckResult } from '../src/types.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, type Routes } from './helpers.js'

const SUITE_PATH = '/.well-known/axp/suite.json'

/** Valid JSON of AT LEAST `minBytes` bytes: {"items":[{"id":"listing-0","vin":"…"},…]}. */
function bigListingsJson(minBytes: number): string {
  const items: Array<Record<string, string>> = []
  // ~78 bytes per serialized item; overshoot a little, then verify.
  const count = Math.ceil(minBytes / 70)
  for (let i = 0; i < count; i++) {
    items.push({ id: `listing-${i}`, vin: `1HGCM82633A${String(100000 + i)}`, trim: 'EX-L', status: 'live' })
  }
  const text = JSON.stringify({ items })
  if (text.length < minBytes) throw new Error(`fixture bug: built ${text.length} bytes, wanted >= ${minBytes}`)
  return text
}

/** Card-declared suite whose single row hits /listings with JSON expectations. */
function listingsSuite() {
  return {
    $type: 'Suite',
    name: 'listings-contract',
    version: '1.0.0',
    environments: { public: { vars: {} } },
    requirements: [
      {
        id: 'listings-live',
        kind: 'endpoint',
        method: 'GET',
        path: '/listings',
        expect: { status: 200, paths: [{ path: 'items.0.id', exists: true }] },
      },
    ],
  }
}

/** goodTargetRoutes + a card declaring the suite + the /listings route. */
function routesWithDeclaredSuite(listingsBody: string, listingsContentType = 'application/json'): Routes {
  const base = goodTargetRoutes()
  const suiteText = JSON.stringify(listingsSuite())
  const card = JSON.parse(
    base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
  ) as Record<string, any>
  card.interfaces.testSuite = { url: SUITE_PATH, digest: `sha256:${sha256HexSync(suiteText)}` }
  return withOverrides(base, {
    'GET /.well-known/agents.json': () => ({
      status: 200, contentType: 'application/json', body: JSON.stringify(card),
    }),
    [`GET ${SUITE_PATH}`]: () => ({ status: 200, contentType: 'application/json', body: suiteText }),
    'GET /listings': () => ({ status: 200, contentType: listingsContentType, body: listingsBody }),
  })
}

async function judgeDeclaredSuite(routes: Routes): Promise<CheckResult> {
  const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
  const bundle = await observeTarget(GOOD, observer, 7)
  const checks = runChecks(bundle)
  return checks.find((c) => c.id === 'published-test-suite')!
}

// ---------------------------------------------------------------------------
// (a) The diagnosed false-fail: large VALID JSON passes
// ---------------------------------------------------------------------------

describe('(a) a large valid-JSON row response is judged on its FULL body', () => {
  it('card-declared suite: a ~308 KB valid JSON /listings body PASSES its JSON expectation', async () => {
    const body = bigListingsJson(308_000) // the apis.vin/listings shape and size
    expect(body.length).toBeGreaterThan(262_144) // provably over the old probe cap
    const c = await judgeDeclaredSuite(routesWithDeclaredSuite(body))
    expect(c.verdict, c.detail).toBe('pass')
    expect(c.detail).not.toContain('not JSON')
  })

  it('verifySuite (pinned path): the same ~308 KB body passes and the suite report is green', async () => {
    const suite = {
      $type: 'Suite',
      name: 'listings-pinned',
      version: '1',
      environments: { e: { vars: { baseUrl: GOOD } } },
      requirements: [
        {
          id: 'listings-live',
          kind: 'endpoint',
          method: 'GET',
          path: '/listings',
          expect: { status: 200, paths: [{ path: 'items.0.id', exists: true }] },
        },
      ],
    }
    const routes = withOverrides(goodTargetRoutes(), {
      'GET /listings': () => ({ status: 200, contentType: 'application/json', body: bigListingsJson(308_000) }),
    })
    const report = await verifySuite(JSON.stringify(suite), 'e', {
      fetcher: makeFetcher(routes),
      delayMs: 0,
      seed: 1,
      mode: 'local',
    })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
  })

  it('the raised cap admits a valid JSON body right up to SUITE_ROW_MAX_BODY_BYTES', async () => {
    // 1 MiB — far over the old 256 KiB probe cap, comfortably under the row cap.
    const c = await judgeDeclaredSuite(routesWithDeclaredSuite(bigListingsJson(1_048_576)))
    expect(c.verdict, c.detail).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// (b) No new leniency: genuinely non-JSON still fails as non-JSON
// ---------------------------------------------------------------------------

describe('(b) a genuinely non-JSON body still fails "body is not JSON"', () => {
  it('an HTML error page against a JSON expectation fails with the not-JSON reason', async () => {
    const c = await judgeDeclaredSuite(
      routesWithDeclaredSuite('<html><body>maintenance</body></html>', 'text/html'),
    )
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('body is not JSON')
    expect(c.detail).not.toContain('truncated')
  })
})

// ---------------------------------------------------------------------------
// (c) Beyond even the raised cap: fail HONESTLY, never "not JSON"
// ---------------------------------------------------------------------------

describe('(c) a body beyond SUITE_ROW_MAX_BODY_BYTES fails with the honest truncation reason', () => {
  it('a ~4.5 MB valid JSON body FAILS, and the reason is the truncation — not "not JSON"', async () => {
    const c = await judgeDeclaredSuite(routesWithDeclaredSuite(bigListingsJson(SUITE_ROW_MAX_BODY_BYTES + 500_000)))
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('body too large: truncated at')
    expect(c.detail).toContain('verifier read cap')
    expect(c.detail).not.toContain('not JSON')
  })
})

// ---------------------------------------------------------------------------
// The mechanism, unit by unit
// ---------------------------------------------------------------------------

describe('Evidence.truncated — the observer records what it cut', () => {
  it('a body cut at the streaming cap carries truncated: true; a full read does not', async () => {
    const routes: Routes = {
      'GET /big': () => ({ status: 200, contentType: 'application/json', body: 'x'.repeat(1000) }),
      'GET /small': () => ({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    }
    const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0, maxBodyBytes: 100 })
    const big = await observer.observe('probe:big', `${GOOD}/big`)
    expect(big.truncated).toBe(true)
    expect(big.body).toHaveLength(100)
    const small = await observer.observe('probe:small', `${GOOD}/small`)
    expect(small.truncated).toBeUndefined() // absent, not false — stored bundles replay unchanged
    expect(small.body).toBe('{"ok":true}')
  })

  it('a declared Content-Length over the cap is refused before reading AND recorded as truncated', async () => {
    const fetcher = async () =>
      new Response('irrelevant', {
        status: 200,
        headers: { 'content-length': String(10_000_000), 'content-type': 'application/json' },
      })
    const observer = new Observer({ fetcher, delayMs: 0, maxBodyBytes: 100 })
    const ev = await observer.observe('probe:huge', 'https://example.test/huge')
    expect(ev.body).toBe('')
    expect(ev.truncated).toBe(true)
  })
})

describe('judgeExpect — honest about a body the VERIFIER cut', () => {
  const evOf = (over: Partial<Evidence>): Evidence => ({
    role: 'pinned:x', url: `${GOOD}/x`, method: 'GET', status: 200,
    contentType: 'application/json', headers: {}, body: '{"items":[{"id":"a"}]}', elapsedMs: 1,
    ...over,
  })

  it('truncated + JSON expectation → "body too large: truncated at N bytes", not "not JSON"', () => {
    const partial = '{"items":[{"id":"a"},{"id":' // valid JSON severed mid-token
    const ps = judgeExpect(evOf({ body: partial, truncated: true }), {
      status: 200, paths: [{ path: 'items.0.id', exists: true }],
    })
    expect(ps).toHaveLength(1)
    expect(ps[0]).toContain(`body too large: truncated at ${partial.length} bytes`)
    expect(ps[0]).not.toContain('not JSON')
  })

  it('a truncated body that HAPPENS to parse is still refused — partial data is never judged', () => {
    // "12" is the front half of "123456": parseable, and wrong.
    const ps = judgeExpect(evOf({ body: '12', truncated: true }), {
      status: 200, paths: [{ path: '', exists: true }],
    })
    expect(ps.some((p) => p.includes('body too large: truncated at'))).toBe(true)
  })

  it('the same severed body WITHOUT the truncated flag still fails "body is not JSON" (no leniency)', () => {
    const ps = judgeExpect(evOf({ body: '{"items":[{"id":"a"},{"id":' }), {
      status: 200, paths: [{ path: 'items.0.id', exists: true }],
    })
    expect(ps).toEqual(['body is not JSON'])
  })

  it('an untruncated valid JSON body keeps passing untouched', () => {
    const ps = judgeExpect(evOf({}), { status: 200, paths: [{ path: 'items.0.id', exists: true }] })
    expect(ps).toEqual([])
  })
})

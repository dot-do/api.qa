/**
 * AXP Clause 3 deterministic content negotiation (PROTOCOL.md 0.4.0 /
 * pinned spec apis-ax-axp@2.2.0) + the 2.1.0 verifier-drift closures:
 *
 *   - the six AXP structural checks: machine-legible-home, conneg-accept,
 *     conneg-client-class, conneg-alternates, conneg-forced-face,
 *     card-interfaces-linked — strict for a target that claims AXP (declares
 *     a probe manifest), informational SKIP for one that doesn't;
 *   - `appliesWhen` gating on kind:'check' AND kind:'probe' (a free-model
 *     target passes the metering requirements as not applicable, fail-closed
 *     when the source probe is unobservable);
 *   - `paramValue.multiplyRange` (seed-randomized, replayable over-ceiling
 *     amounts) and `expect.paths[].oneOf` (closed vocabularies);
 *   - the END-TO-END pin: the vendored apis-ax-axp@2.2.0 spec text passes,
 *     digest-gated, against a fully conformant in-memory reference target.
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { Observer } from '../src/http.js'
import { observeTarget, ROLE, AGENT_UA, parseLinkHeader } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import { verifyPinnedSpec } from '../src/pinned.js'
import { sha256Hex } from '../src/digest.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, type Routes } from './helpers.js'
import {
  LINKS, FACE_HTML, FACE_JSON, FACE_MD, connegRoot, axpReferenceRoutes, urlAwareFetcher,
} from './axp-fixture.js'

const AXP_SPEC_PATH = new URL('../examples/ax/apis-ax-standard.spec.json', import.meta.url)

// ---------------------------------------------------------------------------
// Fixture: good.example upgraded to the full AXP bar — conneg law (three
// faces, deterministic selection, Link alternates), typed envelopes on one
// branching collection, a free Pricing Document, and the probe manifest.
//
// Moved to ./axp-fixture.ts so the optional-declared-interface suite verifies
// against the SAME reference target instead of forking it. Unchanged here.
// ---------------------------------------------------------------------------

async function judge(routes: Routes, seed = 7) {
  const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
  const bundle = await observeTarget(GOOD, observer, seed)
  const checks = runChecks(bundle)
  const score = axScoreOf(checks)
  const { grade, notes } = gradeOf(score, checks)
  return { bundle, checks, score, grade, notes }
}

const verdictOf = (checks: Awaited<ReturnType<typeof judge>>['checks'], id: string) =>
  checks.find((c) => c.id === id)?.verdict
const detailOf = (checks: Awaited<ReturnType<typeof judge>>['checks'], id: string) =>
  checks.find((c) => c.id === id)?.detail ?? ''

const AXP_CHECK_IDS = [
  'machine-legible-home',
  'conneg-accept',
  'conneg-client-class',
  'conneg-alternates',
  'conneg-forced-face',
  'card-interfaces-linked',
] as const

// (recordsRoute defaults to the plain-OK branch when no url is threaded; the
// query-branching is exercised through the pinned probes below, which fetch
// concrete query URLs — see urlAwareFetcher in ./axp-fixture.ts.)

// ===========================================================================
// The six AXP structural checks
// ===========================================================================

describe('AXP conneg checks against the upgraded reference target', () => {
  it('all six AXP checks pass, nothing fails, grade stays A+', async () => {
    const { checks, score, grade } = await judge(axpReferenceRoutes())
    for (const id of AXP_CHECK_IDS) {
      expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('pass')
    }
    for (const c of checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })

  it('the JSON face JSON-LD signal is reported informationally on conneg-accept', async () => {
    const { checks } = await judge(axpReferenceRoutes())
    expect(detailOf(checks, 'conneg-accept')).toMatch(/JSON-LD/)
  })

  it('a target that does NOT claim AXP (no probe manifest) SKIPs all six — advisory grade unaffected', async () => {
    const { checks, grade } = await judge(goodTargetRoutes())
    for (const id of AXP_CHECK_IDS) {
      expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('skip')
    }
    expect(grade).toBe('A+')
  })
})

describe('each conneg violation fails its own check', () => {
  it('HTML to bare */* → conneg-client-class + machine-legible-home fail', async () => {
    const routes = withOverrides(axpReferenceRoutes(), {
      'GET /': (req: { accept: string; headers?: Record<string, string> }) =>
        req.accept.includes('application/json') || req.accept.includes('text/markdown')
          ? connegRoot(req)
          : FACE_HTML(), // */* (and text/html) get HTML — the curl wall of markup
    })
    const { checks } = await judge(routes)
    expect(verdictOf(checks, 'conneg-client-class')).toBe('fail')
    expect(detailOf(checks, 'conneg-client-class')).toMatch(/bare Accept: \*\/\* did not default to the JSON face/)
    expect(verdictOf(checks, 'machine-legible-home')).toBe('fail')
  })

  it('markdown to a Sec-Fetch browser navigation → conneg-client-class fails (step 3a)', async () => {
    const routes = withOverrides(axpReferenceRoutes(), {
      'GET /': (req: { accept: string; headers?: Record<string, string> }) => {
        const h = req.headers ?? {}
        if (h['sec-fetch-mode'] === 'navigate' || h['sec-fetch-dest'] === 'document') return FACE_MD()
        return connegRoot({ ...req, headers: { ...h, 'sec-fetch-mode': '', 'sec-fetch-dest': '' } })
      },
    })
    const { checks } = await judge(routes)
    expect(verdictOf(checks, 'conneg-client-class')).toBe('fail')
    expect(detailOf(checks, 'conneg-client-class')).toMatch(/Sec-Fetch browser navigation/)
  })

  it('JSON to a known agent User-Agent → conneg-client-class fails (step 3b: agents get markdown)', async () => {
    const routes = withOverrides(axpReferenceRoutes(), {
      'GET /': (req: { accept: string; headers?: Record<string, string> }) => {
        const h = req.headers ?? {}
        if (/claude-user/i.test(h['user-agent'] ?? '')) return FACE_JSON()
        return connegRoot(req)
      },
    })
    const { checks } = await judge(routes)
    expect(verdictOf(checks, 'conneg-client-class')).toBe('fail')
    expect(detailOf(checks, 'conneg-client-class')).toMatch(/agent User-Agent .* markdown/i)
  })

  it('explicit Accept ignored (markdown for application/json) → conneg-accept fails', async () => {
    const routes = withOverrides(axpReferenceRoutes(), {
      'GET /': (req: { accept: string; headers?: Record<string, string> }) =>
        req.accept.includes('application/json') ? FACE_MD() : connegRoot(req),
    })
    const { checks } = await judge(routes)
    expect(verdictOf(checks, 'conneg-accept')).toBe('fail')
    expect(detailOf(checks, 'conneg-accept')).toMatch(/application\/json did not receive the JSON face/)
  })

  it('no Link alternates → conneg-alternates fails AND conneg-forced-face fails closed', async () => {
    const strip = (out: ReturnType<typeof FACE_HTML>) => ({ ...out, headers: {} })
    const routes = withOverrides(axpReferenceRoutes(), {
      'GET /': (req: { accept: string; headers?: Record<string, string> }) => strip(connegRoot(req) as ReturnType<typeof FACE_HTML>),
    })
    const { checks } = await judge(routes)
    expect(verdictOf(checks, 'conneg-alternates')).toBe('fail')
    expect(detailOf(checks, 'conneg-alternates')).toMatch(/advertises no Link rel="alternate"/)
    expect(verdictOf(checks, 'conneg-forced-face')).toBe('fail')
    expect(detailOf(checks, 'conneg-forced-face')).toMatch(/undemonstrable, failing closed/)
  })

  it('a face address that obeys Accept instead of the address → conneg-forced-face fails (rule 1: the address wins)', async () => {
    const routes = withOverrides(axpReferenceRoutes(), {
      // /index.json is fetched with a contradictory Accept: text/html; a
      // NON-conforming server negotiates instead of pinning the face.
      'GET /index.json': (req: { accept: string }) =>
        req.accept.includes('text/html') ? FACE_HTML() : FACE_JSON(),
    })
    const { checks } = await judge(routes)
    expect(verdictOf(checks, 'conneg-forced-face')).toBe('fail')
    expect(detailOf(checks, 'conneg-forced-face')).toMatch(/json face address .* did not serve the json face/i)
  })

  it('card without an llms reference → card-interfaces-linked fails; intact card passes with cross-link detail', async () => {
    const routes = axpReferenceRoutes()
    const card = JSON.parse(
      routes['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
    ) as Record<string, unknown>
    delete card.llms
    const broken = withOverrides(routes, {
      'GET /.well-known/agents.json': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(card) }),
    })
    const { checks: bad } = await judge(broken)
    expect(verdictOf(bad, 'card-interfaces-linked')).toBe('fail')
    expect(detailOf(bad, 'card-interfaces-linked')).toMatch(/does not reference its llms\.txt/)

    const { checks: good } = await judge(routes)
    expect(verdictOf(good, 'card-interfaces-linked')).toBe('pass')
    expect(detailOf(good, 'card-interfaces-linked')).toMatch(/mutually cross-linked/)
  })

  it('llms.txt that references no siblings → card-interfaces-linked fails on the llms side', async () => {
    const routes = withOverrides(axpReferenceRoutes(), {
      'GET /llms.txt': () => ({
        status: 200, contentType: 'text/markdown',
        body: '# good.example\n\nAn island llms.txt: substantive but referencing no sibling machine surfaces at all.',
      }),
    })
    const { checks } = await judge(routes)
    expect(verdictOf(checks, 'card-interfaces-linked')).toBe('fail')
    expect(detailOf(checks, 'card-interfaces-linked')).toMatch(/llms\.txt does not reference/)
  })
})

describe('Link header parsing (A.7.5 plumbing)', () => {
  it('parses multi-entry Link headers with rel/type params, resolving faces', () => {
    const alts = parseLinkHeader(LINKS)
    expect(alts).toHaveLength(3)
    expect(alts[0]).toEqual({ url: '/index.html', rel: 'alternate', type: 'text/html' })
    expect(alts[2]!.type).toBe('text/markdown')
  })

  it('is total on malformed headers (no throw, parseable entries survive)', () => {
    expect(parseLinkHeader('garbage')).toEqual([])
    expect(parseLinkHeader('</a>; rel=alternate; type="text/html", garbage')).toHaveLength(1)
  })
})

// ===========================================================================
// The pinned apis-ax-axp@2.2.0 spec, end to end (digest-gated)
// ===========================================================================

describe('apis-ax-axp@2.2.0 pinned spec (the vendored AXP conformance gate)', () => {
  const specText = readFileSync(AXP_SPEC_PATH, 'utf8')

  it('PASSES, digest-gated, against the fully conformant free-model reference target', async () => {
    const digest = await sha256Hex(specText)
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: urlAwareFetcher(axpReferenceRoutes()),
      delayMs: 0, seed: 11, mode: 'local', expectedDigest: digest,
    })
    const failed = report.requirements.filter((r) => r.verdict !== 'pass')
    expect(failed.map((r) => `${r.id}: ${r.detail}`)).toEqual([])
    expect(report.passed).toBe(true)
    expect(report.spec.version).toBe('2.2.0')

    // The metering requirements passed AS NOT APPLICABLE on the free model.
    for (const id of ['check-offers-402', 'hard-ceiling-positive', 'hard-ceiling-enforced', 'hard-ceiling-below', 'hard-ceiling-not-premature']) {
      expect(report.requirements.find((r) => r.id === id)?.detail, id).toMatch(/not applicable/)
    }
    // The conneg requirements were judged strictly (not skipped).
    for (const id of ['check-conneg-accept', 'check-conneg-client-class', 'check-conneg-alternates', 'check-conneg-forced-face', 'check-machine-legible-home', 'check-card-interfaces-linked']) {
      expect(report.requirements.find((r) => r.id === id)?.detail, id).toMatch(/passed/)
    }
  })

  it('FAILS a target that never claimed AXP (skips become fail-closed under must:pass)', async () => {
    const report = await verifyPinnedSpec(GOOD, specText, {
      fetcher: makeFetcher(goodTargetRoutes()), delayMs: 0, seed: 11, mode: 'local',
    })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'check-conneg-accept')?.verdict).toBe('fail')
  })
})

// ===========================================================================
// appliesWhen / multiplyRange / oneOf (the 2.1.0 drift closures)
// ===========================================================================

describe('appliesWhen gating', () => {
  const gatedSpec = (extra: object = {}) => JSON.stringify({
    $type: 'PinnedSpec', name: 'gated', version: '1',
    requirements: [
      { id: 'pricing-declared', kind: 'probe', probe: 'pricing',
        expect: { status: 200, paths: [{ path: 'model', oneOf: ['free', 'metered'] }] } },
      { id: 'gated-offers', kind: 'check', check: 'offers-402', must: 'pass',
        appliesWhen: { fromProbe: 'pricing', path: 'model', equals: 'metered' }, ...extra },
    ],
  })

  it('a free-model target passes an appliesWhen-gated kind:check as not applicable', async () => {
    const report = await verifyPinnedSpec(GOOD, gatedSpec(), {
      fetcher: urlAwareFetcher(axpReferenceRoutes()), delayMs: 0, seed: 3, mode: 'local',
    })
    const gated = report.requirements.find((r) => r.id === 'gated-offers')!
    expect(gated.verdict).toBe('pass')
    expect(gated.detail).toMatch(/not applicable/)
    expect(report.passed).toBe(true)
  })

  it('a metered target still has the gated check ENFORCED (no free skip)', async () => {
    // Metered pricing + a broken offer boundary (200 instead of 402).
    const routes = withOverrides(axpReferenceRoutes({ model: 'metered', hardCeiling: 5 }), {
      'GET /offers/upgrade': () => ({ status: 200, contentType: 'text/html', body: '<html>call sales</html>' }),
    })
    const report = await verifyPinnedSpec(GOOD, gatedSpec(), {
      fetcher: urlAwareFetcher(routes), delayMs: 0, seed: 3, mode: 'local',
    })
    const gated = report.requirements.find((r) => r.id === 'gated-offers')!
    expect(gated.verdict).toBe('fail')
    expect(report.passed).toBe(false)
  })

  it('FAILS CLOSED: an unobservable appliesWhen source means the requirement applies', async () => {
    const spec = JSON.stringify({
      $type: 'PinnedSpec', name: 'no-source', version: '1',
      requirements: [
        // No probe requirement observes the 'pricing' channel → the source is
        // unobserved → the gated check APPLIES (and fails on this fixture,
        // which declares no monetization offers at all).
        { id: 'gated-only', kind: 'check', check: 'offers-402', must: 'pass',
          appliesWhen: { fromProbe: 'pricing', path: 'model', equals: 'metered' } },
      ],
    })
    const card = JSON.parse(
      goodTargetRoutes()['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
    ) as Record<string, unknown>
    delete card.monetization
    const routes = withOverrides(goodTargetRoutes(), {
      'GET /.well-known/agents.json': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(card) }),
    })
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: makeFetcher(routes), delayMs: 0, seed: 3, mode: 'local',
    })
    const gated = report.requirements.find((r) => r.id === 'gated-only')!
    expect(gated.verdict).toBe('fail')
  })

  it('an appliesWhen-gated kind:probe is never fetched when not applicable', async () => {
    const spec = JSON.stringify({
      $type: 'PinnedSpec', name: 'gated-probe', version: '1',
      requirements: [
        { id: 'pricing-declared', kind: 'probe', probe: 'pricing',
          expect: { status: 200, paths: [{ path: 'model', oneOf: ['free', 'metered'] }] } },
        { id: 'ceiling', kind: 'probe', probe: 'overCeiling',
          appliesWhen: { fromProbe: 'pricing', path: 'model', equals: 'metered' },
          paramValue: { fromProbe: 'pricing', path: 'hardCeiling', multiplyRange: [500, 1500] },
          expect: { status: [402], paths: [{ path: 'type', equals: 'OFFER' }] } },
      ],
    })
    const report = await verifyPinnedSpec(GOOD, spec, {
      fetcher: urlAwareFetcher(axpReferenceRoutes()), delayMs: 0, seed: 5, mode: 'local',
    })
    const ceiling = report.requirements.find((r) => r.id === 'ceiling')!
    expect(ceiling.verdict).toBe('pass')
    expect(ceiling.detail).toMatch(/not applicable/)
    // Nothing was fetched for the gated probe.
    expect(report.evidence.items.some((e) => e.role.startsWith('pinned:ceiling:'))).toBe(false)
    expect(report.passed).toBe(true)
  })
})

describe('paramValue.multiplyRange — seed-randomized, replayable over-ceiling amounts', () => {
  const spec = JSON.stringify({
    $type: 'PinnedSpec', name: 'range', version: '1',
    requirements: [
      { id: 'pricing-declared', kind: 'probe', probe: 'pricing',
        expect: { status: 200, paths: [{ path: 'model', equals: 'metered' }] } },
      { id: 'enforced', kind: 'probe', probe: 'overCeiling',
        paramValue: { fromProbe: 'pricing', path: 'hardCeiling', multiplyRange: [500, 1500] },
        expect: { status: [402], paths: [{ path: 'type', equals: 'OFFER' }] } },
    ],
  })

  /** Metered fixture whose over-ceiling operation really enforces the ceiling. */
  function meteredRoutes(): Routes {
    return withOverrides(axpReferenceRoutes({ model: 'metered', hardCeiling: 5 }), {})
  }

  function meteredFetcher() {
    const inner = makeFetcher(meteredRoutes())
    return async (url: string, init?: RequestInit) => {
      const u = new URL(url)
      if (u.pathname === '/api/records') {
        const spend = Number(u.searchParams.get('spend') ?? '0')
        if (spend > 5) {
          return new Response(JSON.stringify({ type: 'OFFER', id: 'reauth', title: 'Re-authorize', checkoutUrl: '/checkout' }), {
            status: 402, headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ type: 'OK', results: [{ id: 'r1' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return inner(url, init)
    }
  }

  it('derives an amount inside [lo·ceiling, hi·ceiling], passes, and is deterministic in the seed', async () => {
    const run = (seed: number) => verifyPinnedSpec(GOOD, spec, {
      fetcher: meteredFetcher(), delayMs: 0, seed, mode: 'local',
    })
    const a = await run(21)
    expect(a.requirements.find((r) => r.id === 'enforced')?.verdict, JSON.stringify(a.requirements, null, 2)).toBe('pass')
    const amountOf = (rep: Awaited<ReturnType<typeof run>>) => {
      const ev = rep.evidence.items.find((e) => e.role === 'pinned:enforced:0')!
      return Number(new URL(ev.url).searchParams.get('spend'))
    }
    const amountA = amountOf(a)
    expect(amountA).toBeGreaterThanOrEqual(500 * 5)
    expect(amountA).toBeLessThanOrEqual(1500 * 5)
    // Replayable: the same seed derives the same amount; a different seed (in
    // general) another one — the amount is not precomputable from the ceiling.
    const b = await run(21)
    expect(amountOf(b)).toBe(amountA)
  })

  it('a malformed multiplyRange fails closed (never a silent ×1)', async () => {
    const bad = spec.replace('[500, 1500]', '"wide"').replace('[500,1500]', '"wide"')
    const report = await verifyPinnedSpec(GOOD, bad, {
      fetcher: meteredFetcher(), delayMs: 0, seed: 21, mode: 'local',
    })
    const enforced = report.requirements.find((r) => r.id === 'enforced')!
    expect(enforced.verdict).toBe('fail')
    expect(enforced.detail).toMatch(/malformed paramValue\.multiplyRange/)
  })
})

describe('expect.paths[].oneOf — closed vocabularies', () => {
  const spec = JSON.stringify({
    $type: 'PinnedSpec', name: 'vocab', version: '1',
    requirements: [
      { id: 'pricing-declared', kind: 'probe', probe: 'pricing',
        expect: { status: 200, paths: [{ path: 'model', oneOf: ['free', 'metered'] }] } },
    ],
  })

  it('passes a value inside the set, fails one outside it', async () => {
    const ok = await verifyPinnedSpec(GOOD, spec, {
      fetcher: urlAwareFetcher(axpReferenceRoutes()), delayMs: 0, seed: 2, mode: 'local',
    })
    expect(ok.requirements.find((r) => r.id === 'pricing-declared')?.verdict).toBe('pass')

    const outside = await verifyPinnedSpec(GOOD, spec, {
      fetcher: urlAwareFetcher(axpReferenceRoutes({ model: 'donation-ware' })), delayMs: 0, seed: 2, mode: 'local',
    })
    const r = outside.requirements.find((rq) => rq.id === 'pricing-declared')!
    expect(r.verdict).toBe('fail')
    expect(r.detail).toMatch(/wanted one of/)
  })
})

// ===========================================================================
// Client-class probes really carry their simulation headers
// ===========================================================================

describe('client-class simulation headers reach the wire', () => {
  it('rootBrowserNav sends Sec-Fetch-*, rootAgentUa sends the A.7.4 agent UA, and roles record the profiles', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const inner = makeFetcher(axpReferenceRoutes())
    const spy = async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {}
      const h = init?.headers
      if (h && !(h instanceof Headers) && !Array.isArray(h)) {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v as string
      }
      seen.push({ url, headers })
      return inner(url, init)
    }
    const observer = new Observer({ fetcher: spy, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 1)

    const nav = seen.find((s) => s.headers['sec-fetch-mode'] === 'navigate')
    expect(nav, 'no Sec-Fetch navigation probe was sent').toBeDefined()
    expect(nav!.headers['sec-fetch-dest']).toBe('document')
    expect(nav!.headers['accept']).toBe('*/*')
    const ua = seen.find((s) => s.headers['user-agent'] === AGENT_UA)
    expect(ua, 'no agent-UA probe was sent').toBeDefined()

    expect(bundle.items.some((e) => e.role === ROLE.rootBrowserNav)).toBe(true)
    expect(bundle.items.some((e) => e.role === ROLE.rootAgentUa)).toBe(true)
    expect(bundle.items.some((e) => e.role === ROLE.face('json'))).toBe(true)
    expect(bundle.items.some((e) => e.role === ROLE.pricing)).toBe(true)
  })
})

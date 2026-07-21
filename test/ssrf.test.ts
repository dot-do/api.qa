/**
 * SSRF regression (ax-6ql): a hostile capability card must never steer the
 * verifier off-origin, at a non-GET method, or at a private/metadata address
 * via `monetization.probe`. AXP Appendix A.5 requires monetization.probe to be
 * a same-origin GET — the same rule the `probes.*` manifest already enforces.
 *
 * The critical assertion in every hostile case: NO request is ever made to the
 * hostile URL. We spy on the fetcher and assert it is never called with it.
 */

import { describe, it, expect } from 'vitest'
import { Observer, type Fetcher } from '../src/http.js'
import { observeTarget, deriveDiscovery, parseAgentsJson } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides } from './helpers.js'

/** A goodTargetRoutes card with its monetization.probe replaced. */
function cardWithProbe(probe: { method: string; url: string }): Record<string, unknown> {
  return {
    name: 'good.example',
    description: 'Reference agent-first widget API.',
    interfaces: {
      http: {
        status: { method: 'GET', url: `${GOOD}/api/status`, auth: 'none' },
        widgets: { method: 'GET', url: `${GOOD}/api/widgets`, auth: 'none' },
      },
      mcp: { transport: 'stdio', command: 'npx good.example mcp', tools: ['list_widgets'] },
    },
    openapi: `${GOOD}/openapi.json`,
    attestationLadder: [{ rung: 'anonymous' }],
    monetization: {
      model: '402 offers at boundaries',
      offers: [{ id: 'pro', title: 'Pro tier', price: { amount: 10, currency: 'USD', interval: 'month' } }],
      probe,
    },
  }
}

function hostileRoutes(probe: { method: string; url: string }) {
  return withOverrides(goodTargetRoutes(), {
    'GET /.well-known/agents.json': () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cardWithProbe(probe)),
    }),
  })
}

/** A fetcher that records every URL it is asked to fetch, then delegates. */
function spyFetcher(routes = goodTargetRoutes()): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const base = makeFetcher(routes)
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url)
    return base(url, init)
  }
  return { fetcher, calls }
}

const HOSTILE_PROBES: Array<{ label: string; probe: { method: string; url: string }; hostileUrl: string }> = [
  { label: 'off-origin', probe: { method: 'GET', url: 'https://evil.example/x' }, hostileUrl: 'https://evil.example/x' },
  { label: 'non-GET (POST)', probe: { method: 'POST', url: `${GOOD}/offers/upgrade` }, hostileUrl: `${GOOD}/offers/upgrade` },
  { label: 'private/metadata IP', probe: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data' }, hostileUrl: 'http://169.254.169.254/latest/meta-data' },
]

describe('SSRF: hostile monetization.probe (ax-6ql)', () => {
  for (const { label, probe, hostileUrl } of HOSTILE_PROBES) {
    describe(label, () => {
      it('is DROPPED from discovery claims (never stored as offerProbe)', () => {
        const doc = cardWithProbe(probe)
        const claims = parseAgentsJson(doc, GOOD)
        expect(claims.offerProbe).toBeUndefined()
      })

      it('the hostile URL is NEVER fetched during a verify run', async () => {
        const { fetcher, calls } = spyFetcher(hostileRoutes(probe))
        const observer = new Observer({ fetcher, delayMs: 0 })
        await observeTarget(GOOD, observer, 42)
        expect(calls).not.toContain(hostileUrl)
        // For the POST case the target /offers/upgrade path exists; assert no
        // request used a non-GET method (the offer probe never fires at all).
        expect(observer.items.some((e) => e.role === 'probe:402-offer')).toBe(false)
      })

      it('FAILS the offers-402 check with a clear detail (without fetching)', async () => {
        const { fetcher } = spyFetcher(hostileRoutes(probe))
        const observer = new Observer({ fetcher, delayMs: 0 })
        const bundle = await observeTarget(GOOD, observer, 42)
        const checks = runChecks(bundle)
        const offers = checks.find((c) => c.id === 'offers-402')
        expect(offers?.verdict).toBe('fail')
        expect(offers?.detail).toMatch(/monetization\.probe/i)
      })
    })
  }

  it('a same-origin GET monetization.probe still PASSES (no regression)', async () => {
    const { fetcher, calls } = spyFetcher(goodTargetRoutes())
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)
    const discovery = await deriveDiscovery(bundle)
    expect(discovery.claims.offerProbe?.url).toBe(`${GOOD}/offers/upgrade`)
    // The legitimate offer probe WAS fetched and offers-402 passes.
    expect(calls).toContain(`${GOOD}/offers/upgrade`)
    const offers = runChecks(bundle).find((c) => c.id === 'offers-402')
    expect(offers?.verdict).toBe('pass')
  })
})

/**
 * Redirect-follow SSRF (ax-6ql, second fix): a probe URL can be perfectly
 * legal — same-origin, GET, public host — pass parseAgentsJson AND the
 * same-origin gate, then the target's own server answers `302 Location:
 * http://169.254.169.254/…`. The FIRST fix validated only the DECLARED URL
 * string; native `fetch(redirect: 'follow')` would silently hop to the
 * metadata IP and store the credential body. The observer must follow
 * redirects MANUALLY and re-validate every hop, failing closed on any
 * off-origin / private / metadata Location. This shares the single fetch
 * site, so it protects EVERY observe() role (root, openapi, keyless, offer).
 */
const METADATA = 'http://169.254.169.254/latest/meta-data'
const METADATA_BODY = 'AWS-CREDS-role-ABCDEF-secret-do-not-exfiltrate'

/** Routes whose offer probe 302-redirects to an attacker-chosen Location. */
function redirectingOfferRoutes(location: string): ReturnType<typeof goodTargetRoutes> {
  return withOverrides(goodTargetRoutes(), {
    'GET /offers/upgrade': () => ({
      status: 302,
      contentType: 'text/plain',
      body: '',
      headers: { location },
    }),
  })
}

describe('SSRF: redirect-follow off the declared probe (ax-6ql, second fix)', () => {
  it('a 302 to the metadata IP is NOT followed; probe fails closed, no body stored', async () => {
    // The metadata host is reachable in the harness (so a naive follow WOULD
    // succeed) — proving the guard, not the mock, is what stops it.
    const routes = withOverrides(redirectingOfferRoutes(METADATA), {})
    const calls: string[] = []
    const base = makeFetcher(routes)
    const fetcher: Fetcher = async (url, init) => {
      calls.push(url)
      if (new URL(url).hostname === '169.254.169.254') {
        return new Response(METADATA_BODY, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return base(url, init)
    }
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)

    // The declared same-origin probe WAS requested (it is legal)...
    expect(calls).toContain(`${GOOD}/offers/upgrade`)
    // ...but the metadata Location is NEVER fetched.
    expect(calls).not.toContain(METADATA)
    expect(calls.some((u) => u.includes('169.254.169.254'))).toBe(false)

    // The offer probe recorded a blocked failure — no status, no body.
    const offerEv = observer.items.find((e) => e.role === 'probe:402-offer')
    expect(offerEv).toBeDefined()
    expect(offerEv?.error).toMatch(/redirect|ssrf|off-origin|private/i)
    expect(offerEv?.status).toBeNull()
    expect(offerEv?.body).toBeNull()

    // The metadata/credential body appears NOWHERE in the Evidence bundle.
    for (const ev of bundle.items) {
      expect(ev.body ?? '').not.toContain(METADATA_BODY)
    }
    // The offers-402 check fails closed (the boundary never answered 402).
    const offers = runChecks(bundle).find((c) => c.id === 'offers-402')
    expect(offers?.verdict).toBe('fail')
  })

  it('a 302 to an off-origin https host is NOT followed (fails closed)', async () => {
    const offOrigin = 'https://evil.example/steal'
    const { fetcher, calls } = spyFetcher(redirectingOfferRoutes(offOrigin))
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)

    expect(calls).toContain(`${GOOD}/offers/upgrade`)
    expect(calls).not.toContain(offOrigin)
    expect(calls.some((u) => u.startsWith('https://evil.example'))).toBe(false)

    const offerEv = observer.items.find((e) => e.role === 'probe:402-offer')
    expect(offerEv?.error).toMatch(/redirect|ssrf|off-origin|private/i)
    expect(offerEv?.body).toBeNull()
  })

  it('a benign SAME-ORIGIN 302 (to another GET path) IS still followed (no over-block)', async () => {
    // /offers/upgrade 302 → /offers/v2 (same origin, GET) → 402 offer body.
    const routes = withOverrides(goodTargetRoutes(), {
      'GET /offers/upgrade': () => ({
        status: 302,
        contentType: 'text/plain',
        body: '',
        headers: { location: `${GOOD}/offers/v2` },
      }),
      'GET /offers/v2': () => ({
        status: 402,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'pro',
          title: 'Pro tier',
          price: { amount: 10, currency: 'USD', interval: 'month' },
          checkoutUrl: `${GOOD}/checkout/pro`,
          alternatives: [{ id: 'free', how: 'stay on the free tier' }],
        }),
      }),
    })
    const { fetcher, calls } = spyFetcher(routes)
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)

    // Both hops were fetched (the same-origin redirect was followed).
    expect(calls).toContain(`${GOOD}/offers/upgrade`)
    expect(calls).toContain(`${GOOD}/offers/v2`)

    // The offer probe recorded the followed 402 with its body.
    const offerEv = observer.items.find((e) => e.role === 'probe:402-offer')
    expect(offerEv?.status).toBe(402)
    expect(offerEv?.error).toBeUndefined()

    const offers = runChecks(bundle).find((c) => c.id === 'offers-402')
    expect(offers?.verdict).toBe('pass')
  })
})

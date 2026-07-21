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

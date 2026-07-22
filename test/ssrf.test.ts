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
import { Observer, isPrivateHost, type Fetcher } from '../src/http.js'
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

/**
 * First-hop SSRF via the card-derived `openapi` url (ax-6ql, third fix).
 *
 * `agents.openapiUrl` (from `openapi` / `openapiUrl` / `surfaces.openapi`) is
 * card-controlled and absolutize() preserves an ABSOLUTE attacker url. Before
 * this fix it was passed straight to observer.observe(ROLE.openapi, …) with NO
 * same-origin gate. The fetch is DIRECT (no redirect), so the redirect-hop
 * guard never sees it: `openapi:"http://169.254.169.254/…"` was fetched, the
 * metadata answered 200, and readCapped stored the credential body into the
 * Evidence bundle under ROLE.openapi. Two layers now stop it: (1) the call
 * site gates the declared url through isPubliclyRoutableSameOrigin, and (2) the
 * observer re-validates its OWN initial url and refuses any private/metadata
 * address for EVERY role — the whack-a-mole-proof backstop.
 */
const OPENAPI_METADATA = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/role'
const OPENAPI_CREDS = 'AWS-CREDS-openapi-role-XYZ-secret-do-not-exfiltrate'

/** The good card with its `openapi` field replaced by `openapiUrl`. */
function cardWithOpenapi(openapiUrl: string): Record<string, unknown> {
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
    openapi: openapiUrl,
    attestationLadder: [{ rung: 'anonymous' }],
    monetization: {
      model: '402 offers at boundaries',
      offers: [{ id: 'pro', title: 'Pro tier', price: { amount: 10, currency: 'USD', interval: 'month' } }],
      probe: { method: 'GET', url: `${GOOD}/offers/upgrade` },
    },
  }
}

function hostileOpenapiRoutes(openapiUrl: string) {
  return withOverrides(goodTargetRoutes(), {
    'GET /.well-known/agents.json': () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cardWithOpenapi(openapiUrl)),
    }),
  })
}

describe('SSRF: first-hop via card-derived openapi url (ax-6ql, third fix)', () => {
  it('(a) openapi = metadata IP is NEVER fetched; no creds in Evidence; openapi fails closed', async () => {
    // The metadata host is reachable in the harness (a naive fetch WOULD get
    // the credential body) — proving the guard, not the mock, is what stops it.
    const calls: string[] = []
    const base = makeFetcher(hostileOpenapiRoutes(OPENAPI_METADATA))
    const fetcher: Fetcher = async (url, init) => {
      calls.push(url)
      if (new URL(url).hostname === '169.254.169.254') {
        return new Response(OPENAPI_CREDS, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return base(url, init)
    }
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)

    // The hostile metadata url is NEVER requested.
    expect(calls).not.toContain(OPENAPI_METADATA)
    expect(calls.some((u) => u.includes('169.254.169.254'))).toBe(false)
    // The credential body appears NOWHERE in the Evidence bundle.
    for (const ev of bundle.items) {
      expect(ev.body ?? '').not.toContain(OPENAPI_CREDS)
    }
    // The openapi surface fails closed (the hostile url was dropped, not fetched).
    const openapi = runChecks(bundle).find((c) => c.id === 'openapi')
    expect(openapi?.verdict).toBe('fail')
  })

  it('(b) openapi = off-origin https host is NEVER fetched; openapi fails closed', async () => {
    const offOrigin = 'https://evil.example/openapi.json'
    const { fetcher, calls } = spyFetcher(hostileOpenapiRoutes(offOrigin))
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)

    expect(calls).not.toContain(offOrigin)
    expect(calls.some((u) => u.startsWith('https://evil.example'))).toBe(false)
    const openapi = runChecks(bundle).find((c) => c.id === 'openapi')
    expect(openapi?.verdict).toBe('fail')
  })

  it('(c) a SAME-ORIGIN card-declared openapi url still works (no over-block)', async () => {
    // A non-default same-origin path proves the gate admits legitimate cards.
    const routes = withOverrides(hostileOpenapiRoutes(`${GOOD}/spec/openapi.json`), {
      'GET /spec/openapi.json': () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'good.example', version: '1.0.0' },
          paths: { '/api/status': { get: { responses: { '200': { description: 'ok' } } } } },
        }),
      }),
    })
    const { fetcher, calls } = spyFetcher(routes)
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)

    expect(calls).toContain(`${GOOD}/spec/openapi.json`)
    const openapi = runChecks(bundle).find((c) => c.id === 'openapi')
    expect(openapi?.verdict).toBe('pass')
  })

  it('(d) an openapi PATH KEY that breaks off-origin ("@evil…") is NEVER fetched (keyless gate)', async () => {
    // A raw openapi path key that does not begin with "/" makes the keyless
    // probe `${origin}${path}` resolve OFF-ORIGIN: "@evil.example/x" →
    // https://good.example@evil.example/x (host evil.example). The keyless
    // call site now gates every candidate through the same-origin helper.
    const hostileKey = '@evil.example/pwn'
    const routes = withOverrides(goodTargetRoutes(), {
      'GET /openapi.json': () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'good.example', version: '1.0.0' },
          paths: {
            [hostileKey]: { get: { responses: { '200': { description: 'ok' } } } },
            '/api/status': { get: { responses: { '200': { description: 'ok' } } } },
          },
        }),
      }),
    })
    const { fetcher, calls } = spyFetcher(routes)
    const observer = new Observer({ fetcher, delayMs: 0 })
    await observeTarget(GOOD, observer, 42)

    // The breakout url is never constructed into a real off-origin fetch.
    expect(calls.some((u) => new URL(u).hostname === 'evil.example')).toBe(false)
    expect(calls.every((u) => new URL(u).hostname === 'good.example')).toBe(true)
    // No keyless evidence was recorded for the hostile key.
    expect(observer.items.some((e) => e.role.includes('@evil.example'))).toBe(false)
  })
})

/**
 * isPrivateHost self-defense (ax-2ck): the guard must decode numeric IPv4
 * encodings ITSELF, so it is correct on a RAW host string a caller did not run
 * through WHATWG-URL canonicalization. Every form below decodes to a private /
 * link-local / loopback address and MUST be refused; a real public DNS host must
 * still be admitted. The dotted octal/hex forms are the ones the flat IP_LITERAL
 * regex could NOT catch before this hardening.
 */
describe('isPrivateHost self-defends against numeric IPv4 encodings (ax-2ck)', () => {
  const PRIVATE_NUMERIC: Array<[string, string]> = [
    ['2852039166', 'bare decimal → 169.254.169.254'],
    ['0xA9FEA9FE', 'bare 0x-hex → 169.254.169.254'],
    ['0251.0376.0251.0376', 'dotted octal → 169.254.169.254'],
    ['0xA9.0xFE.0xA9.0xFE', 'dotted hex → 169.254.169.254'],
    ['0177.0.0.1', 'dotted octal → 127.0.0.1 (loopback)'],
    ['2130706433', 'bare decimal → 127.0.0.1 (loopback)'],
    ['127.1', 'short-form → 127.0.0.1 (loopback)'],
  ]
  for (const [host, label] of PRIVATE_NUMERIC) {
    it(`refuses ${host} (${label})`, () => {
      expect(isPrivateHost(host)).toBe(true)
    })
  }
  it('still ADMITS a legitimate public DNS host (no over-block)', () => {
    expect(isPrivateHost('good.example')).toBe(false)
    expect(isPrivateHost('api.example.com')).toBe(false)
  })
})

/**
 * The structural backstop in isolation (ax-6ql, third fix): Observer.observe()
 * refuses a private/metadata INITIAL url for ANY role, independent of the call
 * site that passed it — no future caller can reintroduce a first-hop SSRF.
 */
describe('SSRF: observe() re-validates its own initial url (structural backstop)', () => {
  it('refuses a private/metadata initial target for any role, without fetching', async () => {
    const calls: string[] = []
    const fetcher: Fetcher = async (url) => {
      calls.push(url)
      return new Response(OPENAPI_CREDS, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    const observer = new Observer({ fetcher, delayMs: 0 })
    const ev = await observer.observe('probe:arbitrary', OPENAPI_METADATA, { accept: '*/*' })

    // Nothing was fetched; the evidence is a blocked failure with no body.
    expect(calls).toHaveLength(0)
    expect(ev.status).toBeNull()
    expect(ev.body).toBeNull()
    expect(ev.error).toMatch(/private|metadata|ssrf/i)
  })

  it('still fetches a private initial target when private mode is consented', async () => {
    // Dev/CLI `--allow-private`: a consented localhost target IS reachable.
    const local = 'http://127.0.0.1:8787/openapi.json'
    const calls: string[] = []
    const fetcher: Fetcher = async (url) => {
      calls.push(url)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const observer = new Observer({ fetcher, delayMs: 0, allowPrivate: true })
    const ev = await observer.observe('probe:arbitrary', local, { accept: '*/*' })
    expect(calls).toContain(local)
    expect(ev.status).toBe(200)
  })
})

/**
 * The reference AXP target, shared.
 *
 * Extracted verbatim from conneg.test.ts (which still imports it) so a second
 * suite can verify against the SAME fixture instead of forking it. A forked
 * conformance fixture is how two suites end up disagreeing about what
 * "conformant" means.
 *
 * good.example upgraded to the full AXP bar: the conneg law (three faces,
 * deterministic selection, Link alternates), typed envelopes on one branching
 * collection, a free Pricing Document, and the probe manifest.
 */

import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, type Routes } from './helpers.js'

export const LINKS =
  '</index.html>; rel="alternate"; type="text/html", ' +
  '</index.json>; rel="alternate"; type="application/ld+json", ' +
  '</index.md>; rel="alternate"; type="text/markdown"'

export const FACE_HTML = () => ({
  status: 200, contentType: 'text/html', headers: { link: LINKS },
  body: '<!doctype html><html><body><h1>good.example</h1><p>the page face</p></body></html>',
})
export const FACE_JSON = () => ({
  status: 200, contentType: 'application/ld+json', headers: { link: LINKS },
  body: JSON.stringify({ $context: 'https://schema.org.ai', $type: 'Service', name: 'good.example' }),
})
export const FACE_MD = () => ({
  status: 200, contentType: 'text/markdown', headers: { link: LINKS },
  body: '# good.example\n\n> the token-cheap agent face, substantive enough to be real content.',
})

/** The AXP A.7.3 selection algorithm, as a route handler for `GET /`. */
export function connegRoot(req: { accept: string; headers?: Record<string, string> }) {
  const h = req.headers ?? {}
  if (req.accept.includes('text/html')) return FACE_HTML()
  if (req.accept.includes('application/json') || req.accept.includes('application/ld+json')) return FACE_JSON()
  if (req.accept.includes('text/markdown')) return FACE_MD()
  if (h['sec-fetch-mode'] === 'navigate' || h['sec-fetch-dest'] === 'document') return FACE_HTML()
  if (/claude-user|gptbot|claudebot|agent/i.test(h['user-agent'] ?? '')) return FACE_MD()
  return FACE_JSON()
}

/** One branching collection (the api.lawyer /matters pattern): OK / EMPTY / BLOCKED. */
export function recordsRoute(url: string) {
  const u = new URL(url, GOOD)
  const scope = u.searchParams.get('scope')
  if (scope === 'admin' || scope === 'internal') {
    return { status: 403, contentType: 'application/json', body: JSON.stringify({ type: 'BLOCKED', reason: 'not permitted for your agent class' }) }
  }
  if (u.searchParams.get('filter') === 'none' || u.searchParams.get('tag') === 'none') {
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'EMPTY', results: [], message: 'no records match' }) }
  }
  return { status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'OK', results: [{ id: 'r1' }] }) }
}

/**
 * The reference AXP target: goodTargetRoutes + the conneg law + the probe
 * manifest + the branching collection + a free Pricing Document.
 *
 * `mutateCard` is an OPTIONAL hook for a suite that needs to add a card member
 * (e.g. an optional-interface declaration) without forking the fixture. It runs
 * after every other card edit and before the card is serialized; existing
 * callers pass nothing and get byte-identical routes.
 */
export function axpReferenceRoutes(
  pricing: Record<string, unknown> = { model: 'free' },
  mutateCard?: (card: Record<string, any>) => void,
): Routes {
  const base = goodTargetRoutes()
  const card = JSON.parse(
    base['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' }).body!,
  ) as Record<string, any>
  card.llms = `${GOOD}/llms.txt`
  card.interfaces.http.records = { method: 'GET', url: `${GOOD}/api/records`, auth: 'none' }
  card.probes = {
    keyless: { url: '/api/records' },
    pricing: { url: '/pricing' },
    knownEmpty: [{ url: '/api/records?filter=none' }, { url: '/api/records?tag=none' }],
    knownForbidden: [{ url: '/api/records?scope=admin' }, { url: '/api/records?scope=internal' }],
    ...(pricing.model === 'metered' ? { overCeiling: { url: '/api/records', param: 'spend' } } : {}),
  }
  mutateCard?.(card)
  const openapi = JSON.parse(base['GET /openapi.json']!({ method: 'GET', accept: 'application/json' }).body!) as Record<string, any>
  openapi.paths['/api/records'] = { get: { responses: { '200': { description: 'records' } } } }
  openapi.paths['/pricing'] = { get: { responses: { '200': { description: 'pricing document' } } } }

  return withOverrides(base, {
    'GET /': connegRoot,
    'GET /index.html': () => FACE_HTML(),
    'GET /index.json': () => FACE_JSON(),
    'GET /index.md': () => FACE_MD(),
    'GET /.well-known/agents.json': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(card) }),
    'GET /openapi.json': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(openapi) }),
    'GET /pricing': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(pricing) }),
    // Plain-table route (no URL threading): the query-branching variants are
    // exercised through urlAwareFetcher below.
    'GET /api/records': () => recordsRoute('/api/records'),
  })
}

/**
 * Route-handler plumbing: recordsRoute needs the request URL. makeFetcher hands
 * handlers only method/accept/headers, so thread the url through this tiny
 * wrapper instead of widening the shared helper for one test.
 */
export function urlAwareFetcher(routes: Routes) {
  const inner = makeFetcher(routes)
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    if (u.pathname === '/api/records') {
      const out = recordsRoute(url)
      return new Response(out.body ?? '', { status: out.status, headers: { 'content-type': out.contentType ?? 'text/plain' } })
    }
    return inner(url, init)
  }
}

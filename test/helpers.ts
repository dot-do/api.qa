/**
 * Test fixture: an in-memory agent-first target (`https://good.example`)
 * modeled on the builder.domains AX conventions — plus `overrides` to break
 * any surface and watch the specific check fail. No network anywhere.
 */

import type { Fetcher } from '../src/http.js'

export const GOOD = 'https://good.example'

type Handler = (req: { method: string; accept: string; body?: string }) => {
  status: number
  contentType?: string
  body?: string
  headers?: Record<string, string>
}

export type Routes = Record<string, Handler>

export function goodTargetRoutes(): Routes {
  const llms = `# good.example

> The reference agent-first widget API. Everything one command deep.

## Try it (no key, no account)

\`\`\`sh
curl ${GOOD}/api/status
\`\`\`

## Surfaces

- \`GET /llms.txt\` — this document
- \`GET /.well-known/agents.json\` — capability card
- \`GET /icp.json\` — self-classify
- \`GET /openapi.json\` — the API contract (openapi)

## 402s are offers

Boundaries answer 402 with a structured offer. See \`GET /offers/upgrade\`.
`
  const agents = {
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
    attestationLadder: [
      { rung: 'anonymous', durability: 'ephemeral' },
      { rung: 'attested-agent', durability: 'durable' },
    ],
    monetization: {
      model: '402 offers at boundaries',
      offers: [{ id: 'pro', title: 'Pro tier', price: { amount: 10, currency: 'USD', interval: 'month' } }],
      probe: { method: 'GET', url: `${GOOD}/offers/upgrade` },
    },
  }
  const icp = {
    contract: 'good-example/icp',
    version: 1,
    agent_classes: [
      { id: 'builder', fit: 'You need widgets.', flow: 'GET /api/widgets' },
    ],
    ladder: [{ rung: 'anonymous' }],
  }
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'good.example', version: '1.0.0' },
    paths: {
      '/api/status': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok', 'widgets'],
                    properties: { ok: { type: 'boolean' }, widgets: { type: 'integer' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/widgets': {
        get: {
          responses: {
            '200': {
              description: 'widgets',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object', required: ['id'] } },
                },
              },
            },
          },
        },
      },
      '/api/widgets/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', required: true }],
          responses: { '200': { description: 'one widget' } },
        },
      },
    },
  }

  return {
    'GET /': (req) =>
      req.accept.includes('text/html')
        ? { status: 200, contentType: 'text/html', body: '<!doctype html><html><body><h1>good.example</h1></body></html>' }
        : { status: 200, contentType: 'text/markdown', body: llms },
    'GET /llms.txt': () => ({ status: 200, contentType: 'text/markdown', body: llms }),
    'GET /.well-known/agents.json': () => jsonRes(agents),
    'GET /icp.json': () => jsonRes(icp),
    'GET /openapi.json': () => jsonRes(openapi),
    'GET /api/status': () => jsonRes({ ok: true, widgets: 3 }),
    'GET /api/widgets': () => jsonRes([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]),
    'GET /offers/upgrade': () => ({
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
  }
}

function jsonRes(body: unknown): ReturnType<Handler> {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

/** Build a Fetcher over a route table. Unknown paths 404 with JSON. */
export function makeFetcher(routes: Routes, origin = GOOD): Fetcher {
  return async (url, init) => {
    const u = new URL(url)
    if (u.origin !== origin) {
      throw new TypeError(`fetch failed: ${u.origin} unreachable in tests`)
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    const accept = headerOf(init, 'accept') ?? '*/*'
    const path = u.pathname === '' ? '/' : u.pathname
    const handler = routes[`${method} ${path}`]
    if (!handler) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    const out = handler({ method, accept, body: typeof init?.body === 'string' ? init.body : undefined })
    return new Response(out.body ?? '', {
      status: out.status,
      headers: { 'content-type': out.contentType ?? 'text/plain', ...(out.headers ?? {}) },
    })
  }
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers
  if (!h) return undefined
  if (h instanceof Headers) return h.get(name) ?? undefined
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1]
  const rec = h as Record<string, string>
  return rec[name] ?? rec[name.toLowerCase()]
}

export function withOverrides(base: Routes, overrides: Routes): Routes {
  return { ...base, ...overrides }
}

/** Remove a route entirely (surface goes 404). */
export function withoutRoutes(base: Routes, ...keys: string[]): Routes {
  const out = { ...base }
  for (const k of keys) delete out[k]
  return out
}

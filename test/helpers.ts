/**
 * Test fixture: an in-memory agent-first target (`https://good.example`)
 * modeled on the builder.domains AX conventions — plus `overrides` to break
 * any surface and watch the specific check fail. No network anywhere.
 */

import { spawnSync } from 'node:child_process'
import type { Fetcher } from '../src/http.js'

export const GOOD = 'https://good.example'

// ---------------------------------------------------------------------------
// assertWellFormedXml — a REAL well-formedness check, shared by
// reporters.test.ts and cli-ci.test.ts. The property under test is exactly
// what a CI XML consumer (GitHub/GitLab test-report parsers, xmllint,
// ElementTree) enforces: no raw '<' or bare '&', balanced tags, AND no
// XML-1.0-illegal control byte anywhere in the document. A single illegal
// byte (e.g. a raw NUL leaking in from untrusted target output) corrupts the
// WHOLE `testsuites` document for those parsers, which means the entire CI
// report — not just one testcase — gets silently dropped on a real failure.
// ---------------------------------------------------------------------------

let xmllintAvailable: boolean | undefined

function hasXmllint(): boolean {
  if (xmllintAvailable === undefined) {
    const r = spawnSync('xmllint', ['--version'], { stdio: 'ignore' })
    xmllintAvailable = !r.error && r.status === 0
  }
  return xmllintAvailable
}

/** Every C0 control byte XML 1.0 forbids in content, EXCLUDING the three
 * legal whitespace controls (\t \n \r). */
const XML_ILLEGAL_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

/**
 * Assert `xml` is a well-formed XML 1.0 document. Prefers `xmllint --noout`
 * (a REAL, spec-conformant parser) when it's on PATH — this is the strongest
 * check and is what actually runs in local dev / most CI images. When
 * `xmllint` is unavailable (no XML-parser dependency in this repo, and some
 * minimal CI images lack it), falls back to a hand-rolled check that still
 * enforces the property that matters: balanced tags, no raw '<'/bare '&' in
 * text or attributes, and — critically — NO XML-1.0-illegal control byte
 * anywhere in the document (the fallback would otherwise silently accept the
 * exact corruption this suite exists to catch).
 */
export function assertWellFormedXml(xml: string): void {
  if (XML_ILLEGAL_CONTROL_CHARS.test(xml)) {
    throw new Error('document contains an XML-1.0-illegal control character')
  }
  if (hasXmllint()) {
    const r = spawnSync('xmllint', ['--noout', '-'], { input: xml, encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`xmllint rejected document as not well-formed:\n${r.stderr}`)
    }
    return
  }
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '')
  const stack: string[] = []
  const tagRe = /<(\/?)([a-zA-Z][\w.:-]*)((?:\s+[\w.:-]+="[^"<]*")*)\s*(\/?)>/g
  let last = 0
  let m: RegExpExecArray | null
  const cleanText = (t: string) => {
    if (/</.test(t)) throw new Error(`raw '<' in text: ${JSON.stringify(t)}`)
    if (/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/.test(t)) throw new Error(`bare '&' in text: ${JSON.stringify(t)}`)
  }
  while ((m = tagRe.exec(body))) {
    cleanText(body.slice(last, m.index))
    last = tagRe.lastIndex
    const closing = m[1] === '/'
    const selfClose = m[4] === '/'
    const nameTag = m[2]!
    if (closing) {
      const top = stack.pop()
      if (top !== nameTag) throw new Error(`mismatched close </${nameTag}> vs <${top ?? 'nothing'}>`)
    } else if (!selfClose) {
      stack.push(nameTag)
    }
  }
  cleanText(body.slice(last))
  if (stack.length) throw new Error(`unclosed tags: ${stack.join(', ')}`)
}

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

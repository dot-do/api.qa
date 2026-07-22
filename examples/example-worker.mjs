/**
 * A minimal CONFORMING agent-first worker — the kind of surface `api.qa dev`
 * grades in-process, pre-deploy:
 *
 *   npx autonomous-qa dev examples/example-worker.mjs
 *
 * It is a standard Cloudflare-Worker-shaped module (`export default { fetch }`),
 * so the SAME entry deploys to the edge and grades locally. Every published
 * URL is derived from the incoming request's own origin, so it grades
 * identically no matter what base origin the runner synthesizes.
 */

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export default {
  /** @param {Request} request */
  fetch(request) {
    const url = new URL(request.url)
    const origin = url.origin
    const accept = request.headers.get('accept') ?? '*/*'
    const path = url.pathname === '' ? '/' : url.pathname

    const llms = `# example.worker

> A minimal agent-first widget API. Everything one command deep.

## Try it (no key, no account)

\`\`\`sh
curl ${origin}/api/status
\`\`\`

## Surfaces

- \`GET /llms.txt\` — this document
- \`GET /.well-known/agents.json\` — capability card
- \`GET /icp.json\` — self-classify
- \`GET /openapi.json\` — the API contract (openapi)

## 402s are offers

Boundaries answer 402 with a structured offer. See \`GET /offers/upgrade\`.
`

    if (path === '/') {
      return accept.includes('text/html')
        ? new Response('<!doctype html><html><body><h1>example.worker</h1></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : new Response(llms, { status: 200, headers: { 'content-type': 'text/markdown' } })
    }
    if (path === '/llms.txt') {
      return new Response(llms, { status: 200, headers: { 'content-type': 'text/markdown' } })
    }
    if (path === '/.well-known/agents.json') {
      return json({
        name: 'example.worker',
        description: 'Reference agent-first widget API.',
        interfaces: {
          http: {
            status: { method: 'GET', url: `${origin}/api/status`, auth: 'none' },
            widgets: { method: 'GET', url: `${origin}/api/widgets`, auth: 'none' },
          },
          mcp: { transport: 'stdio', command: 'npx example.worker mcp', tools: ['list_widgets'] },
        },
        openapi: `${origin}/openapi.json`,
        attestationLadder: [
          { rung: 'anonymous', durability: 'ephemeral' },
          { rung: 'attested-agent', durability: 'durable' },
        ],
        monetization: {
          model: '402 offers at boundaries',
          offers: [{ id: 'pro', title: 'Pro tier', price: { amount: 10, currency: 'USD', interval: 'month' } }],
          probe: { method: 'GET', url: `${origin}/offers/upgrade` },
        },
      })
    }
    if (path === '/icp.json') {
      return json({
        contract: 'example-worker/icp',
        version: 1,
        agent_classes: [{ id: 'builder', fit: 'You need widgets.', flow: 'GET /api/widgets' }],
        ladder: [{ rung: 'anonymous' }],
      })
    }
    if (path === '/openapi.json') {
      return json({
        openapi: '3.1.0',
        info: { title: 'example.worker', version: '1.0.0' },
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
                    'application/json': { schema: { type: 'array', items: { type: 'object', required: ['id'] } } },
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
      })
    }
    if (path === '/api/status') return json({ ok: true, widgets: 3 })
    if (path === '/api/widgets') return json([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }])
    if (path === '/offers/upgrade') {
      return json(
        {
          id: 'pro',
          title: 'Pro tier',
          price: { amount: 10, currency: 'USD', interval: 'month' },
          checkoutUrl: `${origin}/checkout/pro`,
          alternatives: [{ id: 'free', how: 'stay on the free tier' }],
        },
        402,
      )
    }
    return json({ error: 'not found' }, 404)
  },
}

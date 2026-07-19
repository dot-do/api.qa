/**
 * The api.qa Cloudflare Worker — the deployed mount of the verifier core.
 *
 * Routes:
 *   GET  /                      content-negotiated (curl → llms.txt, browser → HTML)
 *   GET  /llms.txt              agent-actionable usage doc
 *   GET  /.well-known/agents.json
 *   GET  /icp.json
 *   GET  /openapi.json
 *   GET  /health                keyless liveness
 *   GET  /offers/attested-run   the 402 boundary (a structured offer, not an error)
 *   GET  /self                  api.qa's live verdict on api.qa (loopback, no network)
 *   GET  /{domain}              the public grade page (markdown | HTML+JSON-LD | JSON)
 *   POST /verify                {target, specText?|spec?, expectedDigest?, seed?}
 *
 * `createApp` takes an injectable fetcher so tests and the self-route run the
 * verifier against this very handler without touching the network.
 */

import { verifyTarget, rejudge } from './verify.js'
import { verifyPinnedSpec } from './pinned.js'
import { reportMarkdown, reportHtml, pinnedMarkdown } from './render.js'
import { generateSigningKey, importSigningKeyPair } from './attest.js'
import type { Fetcher } from './http.js'
import {
  SELF_ORIGIN,
  selfAgentsJson,
  selfIcpJson,
  selfLandingHtml,
  selfLlmsTxt,
  selfOffer,
  selfOpenapi,
} from './self.js'
import { VERIFIER_VERSION } from './verify.js'

export interface Env {
  /** base64 pkcs8 Ed25519 key — the held-out attestation key (Worker secret). */
  SIGNING_KEY?: string
  ALLOW_PRIVATE_TARGETS?: string
}

const LINKSET =
  '</llms.txt>; rel="service-doc", </.well-known/agents.json>; rel="service-desc", </openapi.json>; rel="describedby"'

const DOMAIN_ROUTE = /^\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i

export interface App {
  fetch(request: Request): Promise<Response>
}

export function createApp(
  env: Env = {},
  opts: { externalFetcher?: Fetcher; externalDelayMs?: number } = {},
): App {
  const externalDelayMs = opts.externalDelayMs ?? 150
  let keysPromise: Promise<CryptoKeyPair> | undefined
  const keys = () =>
    (keysPromise ??= env.SIGNING_KEY ? importSigningKeyPair(env.SIGNING_KEY) : generateSigningKey())

  const app: App = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const accept = request.headers.get('accept') ?? ''
      const path = url.pathname

      // Loopback: any verification of api.qa itself dispatches back into this
      // handler — the verifier discovers itself over its own protocols.
      const loopback: Fetcher = (u, init) => app.fetch(new Request(u, init))
      const routed: Fetcher = (u, init) =>
        u.startsWith(SELF_ORIGIN) ? loopback(u, init) : (opts.externalFetcher ?? fetch)(u, init)

      try {
        if (request.method === 'GET' || request.method === 'HEAD') {
          if (path === '/') {
            return accept.includes('text/html')
              ? html(selfLandingHtml())
              : text(selfLlmsTxt())
          }
          if (path === '/llms.txt') return text(selfLlmsTxt())
          if (path === '/.well-known/agents.json') return json(selfAgentsJson())
          if (path === '/icp.json') return json(selfIcpJson())
          if (path === '/openapi.json') return json(selfOpenapi())
          if (path === '/health') return json({ ok: true, verifier: 'api.qa', version: VERIFIER_VERSION })
          if (path === '/offers/attested-run') return json(selfOffer(), 402)

          const domain = path === '/self' ? 'api.qa' : DOMAIN_ROUTE.exec(path)?.[1]
          if (domain) {
            const isSelf = domain === 'api.qa'
            const report = await verifyTarget(`https://${domain}`, {
              mode: 'remote',
              fetcher: routed,
              delayMs: isSelf ? 0 : externalDelayMs,
              signingKeys: await keys(),
              allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
            })
            if (accept.includes('application/json')) return json(report)
            if (accept.includes('text/html')) return html(reportHtml(report))
            return text(reportMarkdown(report))
          }
        }

        if (request.method === 'POST' && path === '/verify') {
          const body = (await request.json().catch(() => undefined)) as
            | {
                target?: string
                spec?: unknown
                specText?: string
                expectedDigest?: string
                seed?: number
              }
            | undefined
          if (!body?.target) return json({ error: 'body must include "target"' }, 400)

          const specText =
            body.specText ?? (body.spec !== undefined ? JSON.stringify(body.spec) : undefined)
          if (specText !== undefined) {
            const report = await verifyPinnedSpec(body.target, specText, {
              mode: 'remote',
              fetcher: routed,
              seed: body.seed,
              expectedDigest: body.expectedDigest,
              delayMs: body.target.includes('api.qa') ? 0 : externalDelayMs,
              allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
            })
            return accept.includes('text/markdown') ? text(pinnedMarkdown(report)) : json(report)
          }
          const report = await verifyTarget(body.target, {
            mode: 'remote',
            fetcher: routed,
            seed: body.seed,
            signingKeys: await keys(),
            allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
          })
          return json(report)
        }

        if (request.method === 'POST' && path === '/rejudge') {
          const report = (await request.json().catch(() => undefined)) as
            | Parameters<typeof rejudge>[0]
            | undefined
          if (!report?.evidence) return json({ error: 'body must be a VerificationReport' }, 400)
          return json(await rejudge(report))
        }

        return json({ error: 'not found', see: `${SELF_ORIGIN}/llms.txt` }, 404)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = /refusing|not a valid target|digest mismatch|not a PinnedSpec/.test(message) ? 400 : 500
        return json({ error: message }, status)
      }
    },
  }
  return app
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/markdown; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*' },
  })
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*' },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*' },
  })
}

// Cloudflare Workers module entry.
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createApp(env).fetch(request)
  },
}

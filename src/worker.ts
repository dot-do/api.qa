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
 *   POST /suite                 {environment, suite?|suiteText?|suiteDigest, target?, expectedDigest?, seed?}
 *                               — run a reusable suite (inline or a STORED suite by digest)
 *                                 against a selected environment
 *
 * `createApp` takes an injectable fetcher so tests and the self-route run the
 * verifier against this very handler without touching the network.
 */

import { verifyTarget, rejudge } from './verify.js'
import { verifyPinnedSpec, verifySuite, parseSuite, type PinnedReport, type SuiteReport } from './pinned.js'
import { reportMarkdown, pinnedMarkdown, suiteMarkdown } from './render.js'
import { landingHtml, reportPageHtml } from './views.js'
import { generateSigningKey, importSigningKeyPair } from './attest.js'
import { sha256Hex } from './digest.js'
import type { Fetcher } from './http.js'
import {
  ReportCache,
  hostKey,
  DEFAULT_TTL_SECONDS,
  type KVLike,
  type CacheHit,
} from './cache.js'
import {
  DurableObjectCooldown,
  DEFAULT_MIN_INTERVAL_MS,
  type Cooldown,
  type CooldownDecision,
  type DONamespaceLike,
} from './cooldown.js'
import type { VerificationReport } from './types.js'
import {
  SELF_ORIGIN,
  selfAgentsJson,
  selfIcpJson,
  selfLlmsTxt,
  selfOffer,
  selfOpenapi,
} from './self.js'
import { VERIFIER_VERSION } from './verify.js'

// Re-exported so wrangler discovers the DO class as a named export of `main`.
export { DomainCooldown } from './cooldown.js'

export interface Env {
  /** base64 pkcs8 Ed25519 key — the held-out attestation key (Worker secret). */
  SIGNING_KEY?: string
  ALLOW_PRIVATE_TARGETS?: string
  /** KV report cache (per-target cooldown + replay store). */
  REPORTS?: KVLike
  /** Per-domain politeness Durable Object namespace (class DomainCooldown). */
  COOLDOWN?: DONamespaceLike
  /** Cache freshness / per-target cooldown horizon, seconds. */
  CACHE_TTL_SECONDS?: string
  /** Minimum inter-probe interval per domain across isolates, ms. */
  COOLDOWN_MIN_INTERVAL_MS?: string
}

const LINKSET =
  '</llms.txt>; rel="service-doc", </.well-known/agents.json>; rel="service-desc", </openapi.json>; rel="describedby"'

const DOMAIN_ROUTE = /^\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i

export interface App {
  fetch(request: Request): Promise<Response>
}

export function createApp(
  env: Env = {},
  opts: {
    externalFetcher?: Fetcher
    externalDelayMs?: number
    /** Injected for tests; falls back to env.REPORTS when present. */
    cache?: ReportCache
    /** Injected for tests; falls back to env.COOLDOWN when present. */
    cooldown?: Cooldown
    /** Injectable clock so cache TTL / age is deterministic in tests. */
    now?: () => number
  } = {},
): App {
  const externalDelayMs = opts.externalDelayMs ?? 150
  const now = opts.now ?? (() => Date.now())
  let keysPromise: Promise<CryptoKeyPair> | undefined
  const keys = () =>
    (keysPromise ??= env.SIGNING_KEY ? importSigningKeyPair(env.SIGNING_KEY) : generateSigningKey())

  const ttlSeconds = env.CACHE_TTL_SECONDS ? Number(env.CACHE_TTL_SECONDS) : DEFAULT_TTL_SECONDS
  const minIntervalMs = env.COOLDOWN_MIN_INTERVAL_MS
    ? Number(env.COOLDOWN_MIN_INTERVAL_MS)
    : DEFAULT_MIN_INTERVAL_MS
  const cache = opts.cache ?? (env.REPORTS ? new ReportCache(env.REPORTS, ttlSeconds) : undefined)
  const cooldown =
    opts.cooldown ?? (env.COOLDOWN ? new DurableObjectCooldown(env.COOLDOWN, minIntervalMs) : undefined)

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
              ? html(landingHtml())
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
            const bypass = isSelf // loopback self-verification is never cached / gated

            // 1. Serve a fresh cached verdict without re-probing the target.
            let staleHit: CacheHit<VerificationReport> | null = null
            if (!bypass && cache) {
              const hit = await cache.getDomain(domain, now())
              if (hit?.fresh) return respondReport(hit.report, accept, { cache: 'HIT', ageMs: hit.ageMs })
              staleHit = hit
            }

            // 2. Cross-isolate cooldown before probing a third party.
            if (!bypass && cooldown) {
              const decision = await cooldown.reserve(hostKey(domain))
              if (!decision.allowed) {
                if (staleHit)
                  return respondReport(staleHit.report, accept, {
                    cache: 'STALE',
                    ageMs: staleHit.ageMs,
                    retryAfterMs: decision.retryAfterMs,
                  })
                return cooldownResponse(decision, domain)
              }
            }

            // 3. Probe fresh, judge, attest, and cache.
            const report = await verifyTarget(`https://${domain}`, {
              mode: 'remote',
              fetcher: routed,
              delayMs: isSelf ? 0 : externalDelayMs,
              signingKeys: await keys(),
              allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
            })
            if (!bypass && cache) await cache.putDomain(domain, report, now())
            return respondReport(report, accept, { cache: bypass ? undefined : 'MISS' })
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

          const bypass = hostKey(body.target) === 'api.qa'

          const specText =
            body.specText ?? (body.spec !== undefined ? JSON.stringify(body.spec) : undefined)
          if (specText !== undefined) {
            const specDigest = await sha256Hex(specText)
            // The anti-Goodhart gate must fire on a bad pin BEFORE any cache
            // hit: a mismatched expectedDigest has to 400, never serve a
            // cached pass. Only consult the cache when the pin is consistent.
            const pinOk = !body.expectedDigest || body.expectedDigest === specDigest
            if (!bypass && cache && pinOk) {
              const hit = await cache.getPinned(body.target, specDigest, now())
              if (hit?.fresh)
                return respondPinned(hit.report, accept, { cache: 'HIT', ageMs: hit.ageMs })
            }
            const report = await verifyPinnedSpec(body.target, specText, {
              mode: 'remote',
              fetcher: routed,
              seed: body.seed,
              expectedDigest: body.expectedDigest,
              delayMs: bypass ? 0 : externalDelayMs,
              allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
            })
            if (!bypass && cache) await cache.putPinned(body.target, specDigest, report, now())
            return respondPinned(report, accept, { cache: bypass ? undefined : 'MISS' })
          }

          // Domain-mode POST — same politeness as GET /{domain}.
          let staleHit: CacheHit<VerificationReport> | null = null
          if (!bypass && cache) {
            const hit = await cache.getDomain(body.target, now())
            if (hit?.fresh) return respondReport(hit.report, accept, { cache: 'HIT', ageMs: hit.ageMs })
            staleHit = hit
          }
          if (!bypass && cooldown) {
            const decision = await cooldown.reserve(hostKey(body.target))
            if (!decision.allowed) {
              if (staleHit)
                return respondReport(staleHit.report, accept, {
                  cache: 'STALE',
                  ageMs: staleHit.ageMs,
                  retryAfterMs: decision.retryAfterMs,
                })
              return cooldownResponse(decision, body.target)
            }
          }
          const report = await verifyTarget(body.target, {
            mode: 'remote',
            fetcher: routed,
            seed: body.seed,
            signingKeys: await keys(),
            allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
          })
          if (!bypass && cache) await cache.putDomain(body.target, report, now())
          return respondReport(report, accept, { cache: bypass ? undefined : 'MISS' })
        }

        if (request.method === 'POST' && path === '/suite') {
          const body = (await request.json().catch(() => undefined)) as
            | {
                target?: string
                suite?: unknown
                suiteText?: string
                suiteDigest?: string
                environment?: string
                expectedDigest?: string
                seed?: number
              }
            | undefined
          if (!body?.environment) return json({ error: 'body must include "environment"' }, 400)

          // Resolve the suite text: supplied inline, OR a STORED suite fetched
          // by digest from the registry (the hosted "run a stored suite" path).
          let suiteText =
            body.suiteText ?? (body.suite !== undefined ? JSON.stringify(body.suite) : undefined)
          if (suiteText !== undefined && cache) {
            // Register the inline suite by its digest so it can later be run by
            // digest alone (content-addressed registry).
            await cache.putSuiteText(await sha256Hex(suiteText), suiteText)
          }
          if (suiteText === undefined && body.suiteDigest) {
            if (!cache) return json({ error: 'no suite registry configured for run-by-digest' }, 400)
            const stored = await cache.getSuiteText(body.suiteDigest)
            if (stored === null) return json({ error: `no stored suite for digest ${body.suiteDigest}` }, 404)
            suiteText = stored
          }
          if (suiteText === undefined) {
            return json({ error: 'body must include "suite"/"suiteText" or a stored "suiteDigest"' }, 400)
          }

          const suiteDigest = await sha256Hex(suiteText)
          // Resolve the target the SAME way verifySuite will (explicit override,
          // else the selected environment's baseUrl var) — needed to key the
          // per-(target, suite, env) verdict cache. parseSuite validates shape.
          let targetForKey = body.target
          if (targetForKey === undefined) {
            const suite = parseSuite(suiteText)
            const vars = suite.environments[body.environment]?.vars
            if (vars && typeof vars.baseUrl === 'string') targetForKey = vars.baseUrl
          }
          const bypass = targetForKey !== undefined && hostKey(targetForKey) === 'api.qa'

          // Anti-Goodhart gate must fire on a bad pin BEFORE any cache hit.
          const pinOk = !body.expectedDigest || body.expectedDigest === suiteDigest
          if (targetForKey !== undefined && !bypass && cache && pinOk) {
            const hit = await cache.getSuite(targetForKey, suiteDigest, body.environment, now())
            if (hit?.fresh) return respondSuite(hit.report, accept, { cache: 'HIT', ageMs: hit.ageMs })
          }

          const report = await verifySuite(suiteText, body.environment, {
            mode: 'remote',
            fetcher: routed,
            seed: body.seed,
            expectedDigest: body.expectedDigest,
            target: body.target,
            delayMs: bypass ? 0 : externalDelayMs,
            allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
          })
          if (!bypass && cache) await cache.putSuite(report.target, suiteDigest, body.environment, report, now())
          return respondSuite(report, accept, { cache: bypass ? undefined : 'MISS' })
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
        const status = /refusing|not a valid target|digest mismatch|not a PinnedSpec|not a Suite|unknown environment|Suite\.environments|Suite environment|supplies no string|cannot resolve a target/.test(message)
          ? 400
          : 500
        return json({ error: message }, status)
      }
    },
  }
  return app
}

function text(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/markdown; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*', ...extra },
  })
}

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*', ...extra },
  })
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', link: LINKSET, 'access-control-allow-origin': '*', ...extra },
  })
}

/** Cache/politeness observability headers (x-cache, age, retry-after). */
interface CacheMeta {
  cache?: 'HIT' | 'MISS' | 'STALE'
  ageMs?: number
  retryAfterMs?: number
}
function cacheHeaders(meta?: CacheMeta): Record<string, string> {
  const h: Record<string, string> = {}
  if (meta?.cache) h['x-cache'] = meta.cache
  if (meta?.ageMs !== undefined) h['age'] = String(Math.floor(meta.ageMs / 1000))
  if (meta?.retryAfterMs !== undefined) h['retry-after'] = String(Math.ceil(meta.retryAfterMs / 1000))
  return h
}

function respondReport(report: VerificationReport, accept: string, meta?: CacheMeta): Response {
  const headers = cacheHeaders(meta)
  if (accept.includes('application/json')) return json(report, 200, headers)
  if (accept.includes('text/html')) return html(reportPageHtml(report), 200, headers)
  return text(reportMarkdown(report), 200, headers)
}

function respondPinned(report: PinnedReport, accept: string, meta?: CacheMeta): Response {
  const headers = cacheHeaders(meta)
  return accept.includes('text/markdown')
    ? text(pinnedMarkdown(report), 200, headers)
    : json(report, 200, headers)
}

function respondSuite(report: SuiteReport, accept: string, meta?: CacheMeta): Response {
  const headers = cacheHeaders(meta)
  return accept.includes('text/markdown')
    ? text(suiteMarkdown(report), 200, headers)
    : json(report, 200, headers)
}

function cooldownResponse(decision: CooldownDecision, domain: string): Response {
  return json(
    {
      error: 'per-domain cooldown active',
      domain,
      retryAfterMs: decision.retryAfterMs,
      see: `${SELF_ORIGIN}/llms.txt`,
    },
    429,
    cacheHeaders({ retryAfterMs: decision.retryAfterMs }),
  )
}

// Cloudflare Workers module entry.
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createApp(env).fetch(request)
  },
}

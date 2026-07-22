/**
 * MCP authorization conformance (ax-e6b.20.1). When a target's agents.json
 * declares an HTTP/SSE MCP interface (interfaces.mcp.url), api.qa observes and
 * judges the MCP OAuth model:
 *   (a) RFC 9728 protected-resource metadata (resource + authorization_servers)
 *   (b) authorization_servers[0] → RFC 8414 AS metadata (OIDC fallback)
 *   (c) PKCE S256 (RFC 7636) + registration_endpoint (DCR, RFC 7591) + an
 *       RFC 8707 audience bound to the MCP origin
 *   (d) unauthenticated 401 carrying WWW-Authenticate → protected-resource
 *
 * Every judge is PURE over recorded evidence. SSRF: the mcpUrl is same-origin
 * gated (card-derived, adversarial); the ONE declared AS may be off-origin but
 * public-https-only (private/metadata IPs refused WITHOUT fetching). A real
 * fetch-spy proves the hostile URLs are never requested.
 */

import { describe, it, expect } from 'vitest'
import { Observer, type Fetcher } from '../src/http.js'
import { observeTarget } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { verifyPinnedSpec } from '../src/pinned.js'
import type { CheckResult } from '../src/types.js'

const TARGET = 'https://mcp.example'
const AS = 'https://as.example' // a dedicated, OFF-ORIGIN authorization server

// The six MCP-OAuth check ids this suite exercises.
const MCP_CHECK_IDS = [
  'mcp-oauth-protected-resource',
  'mcp-oauth-as-metadata',
  'mcp-pkce',
  'mcp-oauth-dcr',
  'mcp-oauth-resource-indicators',
  'mcp-www-authenticate',
] as const

// ---------------------------------------------------------------------------
// Fixture builders — a route table keyed by `METHOD absolute-url`.
// ---------------------------------------------------------------------------

type RouteOut = { status: number; contentType?: string; body?: string; headers?: Record<string, string> }
type RouteTable = Record<string, () => RouteOut>

interface McpFixtureOpts {
  mcpUrl?: string // interfaces.mcp.url (default `${TARGET}/mcp`); undefined => stdio-only
  stdioOnly?: boolean // declare stdio MCP with no url
  authServer?: string // authorization_servers[0] (default AS)
  protectedResource?: RouteOut | null // null => drop the well-known (404)
  asMetadata?: RouteOut | null // null => drop oauth-authorization-server (404)
  oidcMetadata?: RouteOut | null // openid-configuration fallback
  asWithS256?: boolean // include code_challenge_methods_supported: ['S256']
  asWithRegistration?: boolean // include registration_endpoint
  unauth?: RouteOut // response to GET {mcpUrl}
}

function jsonOut(body: unknown, status = 200): RouteOut {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function agentsCard(opts: McpFixtureOpts): unknown {
  const mcp = opts.stdioOnly
    ? { transport: 'stdio', command: 'npx mcp.example serve', tools: ['list_things'] }
    : { transport: 'streamable-http', url: opts.mcpUrl ?? `${TARGET}/mcp`, tools: ['list_things'] }
  return {
    name: 'mcp.example',
    description: 'An MCP-exposing agent-first API.',
    interfaces: {
      http: { status: { method: 'GET', url: `${TARGET}/api/status`, auth: 'none' } },
      mcp,
    },
    openapi: `${TARGET}/openapi.json`,
    attestationLadder: [{ rung: 'anonymous' }],
  }
}

function asMetadataBody(opts: McpFixtureOpts): RouteOut {
  const body: Record<string, unknown> = {
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
  }
  if (opts.asWithS256 !== false) body.code_challenge_methods_supported = ['S256']
  if (opts.asWithRegistration !== false) body.registration_endpoint = `${AS}/register`
  return jsonOut(body)
}

/** Build the multi-origin route table for a fixture. */
function mcpRoutes(opts: McpFixtureOpts = {}): RouteTable {
  const mcpUrl = opts.mcpUrl ?? `${TARGET}/mcp`
  const authServer = opts.authServer ?? AS
  const routes: RouteTable = {}

  // Target surfaces (minimal — the MCP checks are what this suite asserts).
  routes[`GET ${TARGET}/`] = () => ({ status: 200, contentType: 'text/markdown', body: '# mcp.example\n\nAgent-first.' })
  routes[`GET ${TARGET}/.well-known/agents.json`] = () => jsonOut(agentsCard(opts))

  if (!opts.stdioOnly) {
    // (d) unauthenticated probe of the MCP endpoint.
    routes[`GET ${mcpUrl}`] = () =>
      opts.unauth ?? {
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unauthorized' }),
        headers: {
          'www-authenticate': `Bearer resource_metadata="${new URL(mcpUrl).origin}/.well-known/oauth-protected-resource"`,
        },
      }

    // (a) protected-resource metadata at the MCP origin.
    const prKey = `GET ${new URL(mcpUrl).origin}/.well-known/oauth-protected-resource`
    if (opts.protectedResource !== null) {
      routes[prKey] = () =>
        opts.protectedResource ?? jsonOut({ resource: mcpUrl, authorization_servers: [authServer] })
    }

    // (b) AS metadata at the (possibly off-origin) authorization server.
    const asKey = `GET ${originSafe(authServer)}/.well-known/oauth-authorization-server`
    const oidcKey = `GET ${originSafe(authServer)}/.well-known/openid-configuration`
    if (opts.asMetadata !== null) {
      routes[asKey] = () => opts.asMetadata ?? asMetadataBody(opts)
    }
    if (opts.oidcMetadata != null) {
      routes[oidcKey] = () => opts.oidcMetadata!
    }
  }
  return routes
}

function originSafe(url: string): string {
  try { return new URL(url).origin } catch { return url }
}

/** A fetcher over an absolute-url route table that records every call. */
function multiFetcher(routes: RouteTable): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const handler = routes[`${method} ${url}`]
    if (!handler) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    const out = handler()
    return new Response(out.body ?? '', {
      status: out.status,
      headers: { 'content-type': out.contentType ?? 'text/plain', ...(out.headers ?? {}) },
    })
  }
  return { fetcher, calls }
}

async function judge(opts: McpFixtureOpts = {}) {
  const { fetcher, calls } = multiFetcher(mcpRoutes(opts))
  const observer = new Observer({ fetcher, delayMs: 0 })
  const bundle = await observeTarget(TARGET, observer, 42)
  return { bundle, checks: runChecks(bundle), calls, observer }
}

function verdictOf(checks: CheckResult[], id: string) {
  return checks.find((c) => c.id === id)?.verdict
}
function detailOf(checks: CheckResult[], id: string) {
  return checks.find((c) => c.id === id)?.detail ?? ''
}

// ---------------------------------------------------------------------------
// Conformant target — all six new checks PASS
// ---------------------------------------------------------------------------

describe('conformant MCP target passes every MCP-OAuth check', () => {
  it('all six checks pass with an off-origin dedicated authorization server', async () => {
    const { checks } = await judge()
    for (const id of MCP_CHECK_IDS) {
      expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('pass')
    }
  })

  it('is deterministic: judging the same bundle twice is byte-identical', async () => {
    const { fetcher } = multiFetcher(mcpRoutes())
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(TARGET, observer, 42)
    expect(JSON.stringify(runChecks(bundle))).toBe(JSON.stringify(runChecks(bundle)))
  })

  it('accepts the openid-configuration fallback when oauth-authorization-server 404s', async () => {
    const { checks } = await judge({
      asMetadata: null, // primary well-known missing
      oidcMetadata: asMetadataBody({}), // OIDC discovery carries the same metadata
    })
    expect(verdictOf(checks, 'mcp-oauth-as-metadata'), detailOf(checks, 'mcp-oauth-as-metadata')).toBe('pass')
    expect(detailOf(checks, 'mcp-oauth-as-metadata')).toMatch(/openid-configuration fallback/)
    expect(verdictOf(checks, 'mcp-pkce')).toBe('pass')
    expect(verdictOf(checks, 'mcp-oauth-dcr')).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// AS-metadata off-origin body scrub (ax-2ck)
// ---------------------------------------------------------------------------

describe('the off-origin AS-metadata body is scrubbed to only the judged fields (ax-2ck)', () => {
  const REFLECT = 'REFLECTED-OFF-ORIGIN-PAYLOAD-do-not-store-verbatim'

  it('drops every non-judged field from the retained evidence while preserving verdicts', async () => {
    const { bundle, checks } = await judge({
      asMetadata: jsonOut({
        // Judged RFC 8414 fields (must survive → verdicts unchanged):
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        code_challenge_methods_supported: ['S256'],
        registration_endpoint: `${AS}/register`,
        // Non-judged fields an attacker-controlled public AS host could return —
        // a bounded reflection primitive if stored verbatim in the public bundle:
        service_documentation: REFLECT,
        op_policy_uri: REFLECT,
        reflect_me: REFLECT,
        agent_auth: { identity_endpoint: `${AS}/agent/identity`, junk: REFLECT },
      }),
    })

    // The verbatim off-origin payload appears NOWHERE in the retained evidence.
    for (const ev of bundle.items) expect(ev.body ?? '').not.toContain(REFLECT)

    // The AS-metadata evidence retains ONLY the judged fields.
    const asEv = bundle.items.find((e) => e.role === 'surface:mcp:oauth-authorization-server')
    expect(asEv, 'AS-metadata evidence must exist').toBeDefined()
    const kept = JSON.parse(asEv!.body!) as Record<string, unknown>
    expect(kept.issuer).toBe(AS)
    expect(kept.authorization_endpoint).toBe(`${AS}/authorize`)
    expect(kept.token_endpoint).toBe(`${AS}/token`)
    expect(kept.code_challenge_methods_supported).toEqual(['S256'])
    expect(kept.registration_endpoint).toBe(`${AS}/register`)
    expect(kept.reflect_me).toBeUndefined()
    expect(kept.service_documentation).toBeUndefined()
    expect((kept.agent_auth as Record<string, unknown>).identity_endpoint).toBe(`${AS}/agent/identity`)
    expect((kept.agent_auth as Record<string, unknown>).junk).toBeUndefined()

    // Because every judged field survived, the verdicts are exactly as before.
    expect(verdictOf(checks, 'mcp-oauth-as-metadata'), detailOf(checks, 'mcp-oauth-as-metadata')).toBe('pass')
    expect(verdictOf(checks, 'mcp-pkce')).toBe('pass')
    expect(verdictOf(checks, 'mcp-oauth-dcr')).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Non-conformant targets — each defect fails its OWN specific check
// ---------------------------------------------------------------------------

describe('non-conformant MCP targets fail the specific check', () => {
  it('no protected-resource well-known → mcp-oauth-protected-resource fails', async () => {
    const { checks } = await judge({ protectedResource: null })
    expect(verdictOf(checks, 'mcp-oauth-protected-resource')).toBe('fail')
    // The AS chain cannot resolve either (nothing to follow).
    expect(verdictOf(checks, 'mcp-oauth-as-metadata')).toBe('fail')
  })

  it('AS metadata without S256 → mcp-pkce fails (others still pass)', async () => {
    const { checks } = await judge({ asWithS256: false })
    expect(verdictOf(checks, 'mcp-pkce')).toBe('fail')
    expect(detailOf(checks, 'mcp-pkce')).toMatch(/S256/)
    expect(verdictOf(checks, 'mcp-oauth-protected-resource')).toBe('pass')
    expect(verdictOf(checks, 'mcp-oauth-as-metadata')).toBe('pass')
    expect(verdictOf(checks, 'mcp-oauth-dcr')).toBe('pass')
  })

  it('AS metadata without registration_endpoint → mcp-oauth-dcr fails', async () => {
    const { checks } = await judge({ asWithRegistration: false })
    expect(verdictOf(checks, 'mcp-oauth-dcr')).toBe('fail')
    expect(detailOf(checks, 'mcp-oauth-dcr')).toMatch(/registration_endpoint/)
    expect(verdictOf(checks, 'mcp-pkce')).toBe('pass')
  })

  it('unauthenticated MCP without WWW-Authenticate → mcp-www-authenticate fails', async () => {
    const { checks } = await judge({
      unauth: { status: 200, contentType: 'application/json', body: '{"ok":true}' },
    })
    expect(verdictOf(checks, 'mcp-www-authenticate')).toBe('fail')
  })

  it('401 without a WWW-Authenticate header → mcp-www-authenticate fails', async () => {
    const { checks } = await judge({
      unauth: { status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' },
    })
    expect(verdictOf(checks, 'mcp-www-authenticate')).toBe('fail')
    expect(detailOf(checks, 'mcp-www-authenticate')).toMatch(/WWW-Authenticate/i)
  })

  it('WWW-Authenticate that omits resource_metadata → mcp-www-authenticate fails', async () => {
    const { checks } = await judge({
      unauth: {
        status: 401,
        contentType: 'application/json',
        body: '{"error":"unauthorized"}',
        headers: { 'www-authenticate': 'Bearer realm="mcp"' },
      },
    })
    expect(verdictOf(checks, 'mcp-www-authenticate')).toBe('fail')
    expect(detailOf(checks, 'mcp-www-authenticate')).toMatch(/resource_metadata/)
  })
})

// ---------------------------------------------------------------------------
// stdio-only MCP — every MCP-OAuth check SKIPS (not fail)
// ---------------------------------------------------------------------------

describe('stdio-only MCP skips the OAuth checks', () => {
  it('all six checks skip and none fail', async () => {
    const { checks } = await judge({ stdioOnly: true })
    for (const id of MCP_CHECK_IDS) {
      expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('skip')
    }
    // The presence-grade AX-6 check still passes for a stdio transport + tools.
    expect(verdictOf(checks, 'mcp-declared')).toBe('pass')
  })

  it('no MCP interface at all → checks skip', async () => {
    // A card with no interfaces.mcp block whatsoever.
    const routes: RouteTable = {
      [`GET ${TARGET}/`]: () => ({ status: 200, contentType: 'text/markdown', body: '# t' }),
      [`GET ${TARGET}/.well-known/agents.json`]: () =>
        jsonOut({ name: 'mcp.example', interfaces: { http: {} }, openapi: `${TARGET}/openapi.json` }),
    }
    const { fetcher } = multiFetcher(routes)
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(TARGET, observer, 42)
    const checks = runChecks(bundle)
    for (const id of MCP_CHECK_IDS) expect(verdictOf(checks, id)).toBe('skip')
  })
})

// ---------------------------------------------------------------------------
// Remote transport with NO url — must FAIL (not skip); the AX-6 point is not
// silently pocketed while every OAuth sibling escapes unpenalized.
// ---------------------------------------------------------------------------

describe('remote MCP transport that declares no url fails (grade escape closed)', () => {
  it('streamable-http with no url → all six MCP-OAuth checks FAIL (not skip)', async () => {
    const routes: RouteTable = {
      [`GET ${TARGET}/`]: () => ({ status: 200, contentType: 'text/markdown', body: '# t' }),
      [`GET ${TARGET}/.well-known/agents.json`]: () =>
        jsonOut({
          name: 'mcp.example',
          // A REMOTE transport (streamable-http) but with the url OMITTED — the
          // old code classified this as stdio-only (mcpUrl === undefined) and
          // skipped every OAuth check while AX-6 still awarded its point.
          interfaces: { http: {}, mcp: { transport: 'streamable-http', tools: ['list_things'] } },
          openapi: `${TARGET}/openapi.json`,
        }),
    }
    const { fetcher, calls } = multiFetcher(routes)
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(TARGET, observer, 42)
    const checks = runChecks(bundle)

    for (const id of MCP_CHECK_IDS) {
      expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('fail')
    }
    // The failure names the missing url — it is not a silent skip.
    expect(detailOf(checks, 'mcp-oauth-protected-resource')).toMatch(/no reachable url|declares no/i)
    // AX-6 presence still passes (transport + tools declared) — so the penalty
    // now routes through the FAILING OAuth siblings rather than being pocketed.
    expect(verdictOf(checks, 'mcp-declared')).toBe('pass')
    // Nothing was fetched for the (absent) MCP endpoint or its OAuth well-knowns.
    expect(calls.some((u) => u.includes('.well-known/oauth') || u.includes('openid-configuration'))).toBe(false)
  })

  it('command-only stdio card (no transport, no url) still SKIPS', async () => {
    const routes: RouteTable = {
      [`GET ${TARGET}/`]: () => ({ status: 200, contentType: 'text/markdown', body: '# t' }),
      [`GET ${TARGET}/.well-known/agents.json`]: () =>
        jsonOut({
          name: 'mcp.example',
          interfaces: { http: {}, mcp: { command: 'npx serve', tools: ['list_things'] } },
          openapi: `${TARGET}/openapi.json`,
        }),
    }
    const { fetcher } = multiFetcher(routes)
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(TARGET, observer, 42)
    const checks = runChecks(bundle)
    for (const id of MCP_CHECK_IDS) expect(verdictOf(checks, id)).toBe('skip')
  })
})

// ---------------------------------------------------------------------------
// AS-metadata / DCR members must be NON-EMPTY ABSOLUTE URLs — '' and junk fail.
// ---------------------------------------------------------------------------

describe('AS metadata members must be non-empty absolute URLs (grade inflation closed)', () => {
  it('empty-string issuer/authorization_endpoint/token_endpoint → mcp-oauth-as-metadata fails', async () => {
    const { checks } = await judge({
      asMetadata: jsonOut({
        issuer: '',
        authorization_endpoint: '',
        token_endpoint: '',
        code_challenge_methods_supported: ['S256'],
        registration_endpoint: `${AS}/register`,
      }),
    })
    expect(verdictOf(checks, 'mcp-oauth-as-metadata')).toBe('fail')
    expect(detailOf(checks, 'mcp-oauth-as-metadata')).toMatch(/issuer|authorization_endpoint|token_endpoint/)
  })

  it('empty-string registration_endpoint → mcp-oauth-dcr fails (not a presence pass)', async () => {
    const { checks } = await judge({
      asMetadata: jsonOut({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        code_challenge_methods_supported: ['S256'],
        registration_endpoint: '',
      }),
    })
    expect(verdictOf(checks, 'mcp-oauth-dcr')).toBe('fail')
    expect(detailOf(checks, 'mcp-oauth-dcr')).toMatch(/registration_endpoint/)
    // issuer/endpoints are valid, so as-metadata itself still passes.
    expect(verdictOf(checks, 'mcp-oauth-as-metadata')).toBe('pass')
  })

  it('non-URL junk registration_endpoint → mcp-oauth-dcr fails', async () => {
    const { checks } = await judge({
      asMetadata: jsonOut({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        code_challenge_methods_supported: ['S256'],
        registration_endpoint: 'not-a-url',
      }),
    })
    expect(verdictOf(checks, 'mcp-oauth-dcr')).toBe('fail')
    expect(detailOf(checks, 'mcp-oauth-dcr')).toMatch(/registration_endpoint/)
  })

  it('non-URL junk token_endpoint → mcp-oauth-as-metadata fails', async () => {
    const { checks } = await judge({
      asMetadata: jsonOut({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: 'nonsense',
        code_challenge_methods_supported: ['S256'],
        registration_endpoint: `${AS}/register`,
      }),
    })
    expect(verdictOf(checks, 'mcp-oauth-as-metadata')).toBe('fail')
    expect(detailOf(checks, 'mcp-oauth-as-metadata')).toMatch(/token_endpoint/)
  })
})

// ---------------------------------------------------------------------------
// SSRF safety — hostile mcpUrl / authorization_servers[0] are NEVER fetched
// ---------------------------------------------------------------------------

const METADATA_IP = 'http://169.254.169.254/mcp'
const METADATA_BODY = 'AWS-CREDS-mcp-role-secret-do-not-exfiltrate'

describe('SSRF: hostile mcpUrl is refused without fetching', () => {
  for (const { label, mcpUrl } of [
    { label: 'off-origin', mcpUrl: 'https://evil.example/mcp' },
    { label: 'private/metadata IP', mcpUrl: METADATA_IP },
  ]) {
    it(`${label} mcpUrl: never fetched, protected-resource check fails closed`, async () => {
      // Make the hostile host "reachable" in the harness so a naive fetch WOULD
      // succeed — proving the guard, not the mock, is what stops it.
      const routes = mcpRoutes({ mcpUrl })
      const calls: string[] = []
      const base = multiFetcher(routes).fetcher
      const fetcher: Fetcher = async (url, init) => {
        calls.push(url)
        const host = safeHost(url)
        if (host === 'evil.example' || host === '169.254.169.254') {
          return new Response(METADATA_BODY, { status: 200, headers: { 'content-type': 'text/plain' } })
        }
        return base(url, init)
      }
      const observer = new Observer({ fetcher, delayMs: 0 })
      const bundle = await observeTarget(TARGET, observer, 42)
      const checks = runChecks(bundle)

      // The hostile mcpUrl (and its well-known) are NEVER requested.
      expect(calls).not.toContain(mcpUrl)
      expect(calls.some((u) => ['evil.example', '169.254.169.254'].includes(safeHost(u)))).toBe(false)
      // No hostile body anywhere in the evidence bundle.
      for (const ev of bundle.items) expect(ev.body ?? '').not.toContain(METADATA_BODY)
      // The protected-resource check fails closed with an SSRF-refusal detail.
      expect(verdictOf(checks, 'mcp-oauth-protected-resource')).toBe('fail')
      expect(detailOf(checks, 'mcp-oauth-protected-resource')).toMatch(/same-origin|refused without fetching|SSRF/i)
    })
  }
})

describe('SSRF: authorization_servers[0] at a private/metadata IP is refused without fetching', () => {
  it('the private AS metadata URL is never requested; as-metadata check fails closed', async () => {
    const privateAs = 'http://169.254.169.254' // dedicated-AS field pointing at metadata
    const routes = mcpRoutes({ authServer: privateAs })
    const calls: string[] = []
    const base = multiFetcher(routes).fetcher
    const fetcher: Fetcher = async (url, init) => {
      calls.push(url)
      if (safeHost(url) === '169.254.169.254') {
        return new Response(METADATA_BODY, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return base(url, init)
    }
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(TARGET, observer, 42)
    const checks = runChecks(bundle)

    // The protected-resource well-known WAS fetched (same-origin, legitimate)…
    expect(calls).toContain(`${TARGET}/.well-known/oauth-protected-resource`)
    // …but the private AS metadata URL is NEVER requested.
    expect(calls.some((u) => safeHost(u) === '169.254.169.254')).toBe(false)
    for (const ev of bundle.items) expect(ev.body ?? '').not.toContain(METADATA_BODY)
    // The AS-metadata check fails closed with a refusal detail; RFC 9728 still passed.
    expect(verdictOf(checks, 'mcp-oauth-protected-resource')).toBe('pass')
    expect(verdictOf(checks, 'mcp-oauth-as-metadata')).toBe('fail')
    expect(detailOf(checks, 'mcp-oauth-as-metadata')).toMatch(/refused without fetching|SSRF|public https/i)
  })

  it('an off-origin PUBLIC authorization server IS fetched (the narrow off-origin allowance works)', async () => {
    // AS = https://as.example (off-origin, public) — this ONE hop is allowed.
    const { calls, checks } = await judge()
    expect(calls).toContain(`${AS}/.well-known/oauth-authorization-server`)
    expect(verdictOf(checks, 'mcp-oauth-as-metadata')).toBe('pass')
  })
})

// Force the isPublicHttpsOffOriginAllowed PRIVATE-HOST branch specifically: the
// AS is HTTPS (so it passes the protocol!=='https:' short-circuit) but resolves
// to a private/metadata address in three encodings. Removing the
// `if (isPrivateHost(u.hostname)) return false` line makes each of these break
// (the refusal detail changes to "neither … resolved 200 JSON").
describe('SSRF: an HTTPS private-host authorization_servers[0] is refused via the private-host branch', () => {
  for (const { label, privateAs } of [
    { label: 'https link-local metadata IP', privateAs: 'https://169.254.169.254/as' },
    { label: 'https decimal-encoded metadata IP', privateAs: 'https://2852039166/as' },
    { label: 'https IPv4-mapped IPv6 metadata IP', privateAs: 'https://[::ffff:169.254.169.254]/as' },
  ]) {
    it(`${label}: AS metadata never fetched; mcp-oauth-as-metadata fails closed`, async () => {
      const routes = mcpRoutes({ authServer: privateAs })
      const calls: string[] = []
      const base = multiFetcher(routes).fetcher
      // Make every private-IP encoding "reachable" so ONLY the guard — not a
      // 404 — can be what stops the fetch.
      const fetcher: Fetcher = async (url, init) => {
        calls.push(url)
        if (/169\.254\.169\.254|2852039166|a9fe/i.test(url)) {
          return new Response(METADATA_BODY, { status: 200, headers: { 'content-type': 'text/plain' } })
        }
        return base(url, init)
      }
      const observer = new Observer({ fetcher, delayMs: 0 })
      const bundle = await observeTarget(TARGET, observer, 42)
      const checks = runChecks(bundle)

      // The same-origin protected-resource well-known resolved fine…
      expect(verdictOf(checks, 'mcp-oauth-protected-resource')).toBe('pass')
      // …but the private AS metadata URL was NEVER requested (in ANY encoding).
      expect(calls.some((u) => /169\.254\.169\.254|2852039166|a9fe/i.test(u))).toBe(false)
      for (const ev of bundle.items) expect(ev.body ?? '').not.toContain(METADATA_BODY)
      // Fails closed with the refusal detail — the DETAIL (not just the verdict)
      // is what proves the isPublicHttpsOffOriginAllowed private-host branch ran.
      expect(verdictOf(checks, 'mcp-oauth-as-metadata')).toBe('fail')
      expect(detailOf(checks, 'mcp-oauth-as-metadata')).toMatch(/refused without fetching|SSRF|public https/i)
    })
  }
})

function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

// ---------------------------------------------------------------------------
// Pinnable via kind:'check' — a pinned contract can bind an MCP-OAuth MUST
// ---------------------------------------------------------------------------

describe('pinnable: an AXP contract binds MCP-OAuth MUSTs via kind:check', () => {
  const spec = JSON.stringify({
    $type: 'PinnedSpec',
    name: 'mcp-oauth-2.1',
    version: '1',
    requirements: MCP_CHECK_IDS.map((id) => ({ id: `must-${id}`, kind: 'check', check: id, must: 'pass' })),
  })

  it('a conformant MCP target passes every pinned MCP-OAuth requirement', async () => {
    const { fetcher } = multiFetcher(mcpRoutes())
    const report = await verifyPinnedSpec(TARGET, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
  })

  it('a missing-S256 target fails exactly the pinned mcp-pkce requirement', async () => {
    const { fetcher } = multiFetcher(mcpRoutes({ asWithS256: false }))
    const report = await verifyPinnedSpec(TARGET, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'must-mcp-pkce')?.verdict).toBe('fail')
    expect(report.requirements.find((r) => r.id === 'must-mcp-oauth-protected-resource')?.verdict).toBe('pass')
  })
})

/**
 * AAP-discovery + auth.md agent-identity conformance (ax-e6b.21.1). Two PURE
 * checks over the EvidenceBundle:
 *
 *   aap-discovery         — GET /.well-known/agent-configuration (new same-
 *                           origin surface) must advertise version/issuer/
 *                           provider_name + Ed25519 + non-empty approval_methods
 *                           + register/status/revoke endpoints + jwks_uri.
 *   authmd-agent-identity — REUSES the RFC 8414 oauth-authorization-server
 *                           metadata the MCP-OAuth check already fetched (no
 *                           duplicate fetch); the AS's `agent_auth` block must
 *                           declare identity/claim/events endpoints, the
 *                           identity_endpoint must RESOLVE, and ID-JAG + SET-
 *                           based revocation must be advertised.
 *
 * Both are advertisement/shape-grade (no live ID-JAG mint). SSRF: the agent-
 * configuration fetch is same-origin-gated; the metadata-derived
 * identity_endpoint probe is gated same-origin-with-the-delegating-AS and never
 * fetches a private/metadata address — a real fetch-spy proves the hostile URLs
 * are never requested. Mirrors test/mcp-oauth.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { Observer, type Fetcher } from '../src/http.js'
import { observeTarget } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { verifyPinnedSpec } from '../src/pinned.js'
import type { CheckResult } from '../src/types.js'

const TARGET = 'https://aap.example'
const AS = 'https://as.example' // off-origin dedicated authorization server (delegation)
const IDJAG = 'urn:ietf:params:oauth:token-type:id-jag'

// ---------------------------------------------------------------------------
// Fixture builders — a route table keyed by `METHOD absolute-url`.
// ---------------------------------------------------------------------------

type RouteOut = { status: number; contentType?: string; body?: string; headers?: Record<string, string> }
type RouteTable = Record<string, () => RouteOut>

interface Opts {
  // AAP discovery document.
  agentConfig?: RouteOut | null // null => omit (404 absent); undefined => conformant
  aap?: Record<string, unknown> // top-level overrides on the conformant AAP doc
  // auth.md agent-identity.
  declareMcp?: boolean // default true; false => no MCP interface => no AS metadata fetched
  agentAuth?: Record<string, unknown> | null // null => omit block; object => replace block; undefined => conformant
  identityEndpoint?: string // override agent_auth.identity_endpoint (SSRF / non-https tests)
  identity?: RouteOut | null // response at the identity_endpoint; null => 404 (does not resolve)
  idJag?: boolean // default true; false => drop subject_token_types_supported (no ID-JAG advertised)
  asMetadata?: RouteOut // full override of the AS metadata response
}

function jsonOut(body: unknown, status = 200): RouteOut {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function aapDoc(over: Record<string, unknown> = {}): unknown {
  return {
    version: '1.0-draft',
    provider_name: 'aap.example',
    issuer: TARGET,
    algorithms: ['Ed25519'],
    approval_methods: ['device_authorization'],
    endpoints: { register: `${TARGET}/agent/register`, status: `${TARGET}/agent/status`, revoke: `${TARGET}/agent/revoke` },
    jwks_uri: `${TARGET}/.well-known/jwks.json`,
    ...over,
  }
}

function agentsCard(opts: Opts): unknown {
  const interfaces: Record<string, unknown> = {
    http: { status: { method: 'GET', url: `${TARGET}/api/status`, auth: 'none' } },
  }
  if (opts.declareMcp !== false) {
    interfaces.mcp = { transport: 'streamable-http', url: `${TARGET}/mcp`, tools: ['list_things'] }
  }
  return { name: 'aap.example', interfaces, openapi: `${TARGET}/openapi.json` }
}

function asMetadataDoc(opts: Opts): unknown {
  const body: Record<string, unknown> = {
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    code_challenge_methods_supported: ['S256'],
    registration_endpoint: `${AS}/register`,
  }
  if (opts.idJag !== false) body.subject_token_types_supported = [IDJAG]
  const block =
    opts.agentAuth === null
      ? undefined
      : opts.agentAuth !== undefined
        ? opts.agentAuth
        : {
            identity_endpoint: opts.identityEndpoint ?? `${AS}/agent/identity`,
            claim_endpoint: `${AS}/agent/claim`,
            events_endpoint: `${AS}/agent/events`,
          }
  if (block) body.agent_auth = block
  return body
}

function routes(opts: Opts = {}): RouteTable {
  const t: RouteTable = {}
  t[`GET ${TARGET}/`] = () => ({ status: 200, contentType: 'text/markdown', body: '# aap.example\n\nAgent-first.' })
  t[`GET ${TARGET}/.well-known/agents.json`] = () => jsonOut(agentsCard(opts))

  // AAP discovery document.
  if (opts.agentConfig !== null) {
    t[`GET ${TARGET}/.well-known/agent-configuration`] = () => opts.agentConfig ?? jsonOut(aapDoc(opts.aap))
  }

  // MCP → protected-resource → AS metadata chain (auth.md rides the AS metadata).
  if (opts.declareMcp !== false) {
    t[`GET ${TARGET}/mcp`] = () => ({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
      headers: { 'www-authenticate': `Bearer resource_metadata="${TARGET}/.well-known/oauth-protected-resource"` },
    })
    t[`GET ${TARGET}/.well-known/oauth-protected-resource`] = () =>
      jsonOut({ resource: `${TARGET}/mcp`, authorization_servers: [AS] })
    t[`GET ${AS}/.well-known/oauth-authorization-server`] = () => opts.asMetadata ?? jsonOut(asMetadataDoc(opts))
    const idUrl = opts.identityEndpoint ?? `${AS}/agent/identity`
    if (opts.identity !== null) {
      t[`GET ${idUrl}`] = () =>
        opts.identity ?? { status: 200, contentType: 'application/json', body: '{"agent_identity":"advertised"}' }
    }
  }
  return t
}

function multiFetcher(table: RouteTable): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const handler = table[`${method} ${url}`]
    if (!handler) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    const out = handler()
    return new Response(out.body ?? '', {
      status: out.status,
      headers: { 'content-type': out.contentType ?? 'text/plain', ...(out.headers ?? {}) },
    })
  }
  return { fetcher, calls }
}

async function judge(opts: Opts = {}) {
  const { fetcher, calls } = multiFetcher(routes(opts))
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
function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

// ---------------------------------------------------------------------------
// Conformant target — both checks PASS
// ---------------------------------------------------------------------------

describe('conformant AAP target passes both agent-identity checks', () => {
  it('aap-discovery and authmd-agent-identity both pass', async () => {
    const { checks } = await judge()
    expect(verdictOf(checks, 'aap-discovery'), detailOf(checks, 'aap-discovery')).toBe('pass')
    expect(verdictOf(checks, 'authmd-agent-identity'), detailOf(checks, 'authmd-agent-identity')).toBe('pass')
  })

  it('is deterministic: judging the same bundle twice is byte-identical', async () => {
    const { fetcher } = multiFetcher(routes())
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(TARGET, observer, 42)
    expect(JSON.stringify(runChecks(bundle))).toBe(JSON.stringify(runChecks(bundle)))
  })

  it('the identity_endpoint at the delegating AS origin IS probed (delegation allowance works)', async () => {
    const { calls } = await judge()
    expect(calls).toContain(`${AS}/agent/identity`)
  })
})

// ---------------------------------------------------------------------------
// aap-discovery — per-defect FAIL; absent document SKIP
// ---------------------------------------------------------------------------

describe('aap-discovery fails the specific malformed field', () => {
  it('algorithms without Ed25519 → fail', async () => {
    const { checks } = await judge({ aap: { algorithms: ['RS256'] } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/Ed25519/)
  })

  it('empty approval_methods → fail', async () => {
    const { checks } = await judge({ aap: { approval_methods: [] } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/approval_methods/)
  })

  it('null revoke endpoint → fail', async () => {
    const { checks } = await judge({ aap: { endpoints: { register: `${TARGET}/agent/register`, status: `${TARGET}/agent/status`, revoke: null } } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/revoke/)
  })

  it('approval_methods:[null] → fail (element is not a usable method)', async () => {
    const { checks } = await judge({ aap: { approval_methods: [null] } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/approval_methods/)
  })

  it('approval_methods:["   "] (whitespace) → fail', async () => {
    const { checks } = await judge({ aap: { approval_methods: ['   '] } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/approval_methods/)
  })

  it('approval_methods:[123] (non-string) → fail', async () => {
    const { checks } = await judge({ aap: { approval_methods: [123] } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/approval_methods/)
  })

  it('whitespace-only required strings (version/issuer/provider_name) → fail', async () => {
    const { checks } = await judge({ aap: { version: '   ', issuer: '   ', provider_name: '   ' } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/version|issuer|provider_name/)
  })

  it('whitespace-only jwks_uri → fail', async () => {
    const { checks } = await judge({ aap: { jwks_uri: '   ' } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/jwks_uri/)
  })

  it('non-https jwks_uri → fail (key host must be https)', async () => {
    const { checks } = await judge({ aap: { jwks_uri: `http://aap.example/.well-known/jwks.json` } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/jwks_uri/)
  })

  it('whitespace-only endpoints.register → fail', async () => {
    const { checks } = await judge({ aap: { endpoints: { register: '   ', status: `${TARGET}/agent/status`, revoke: `${TARGET}/agent/revoke` } } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/register/)
  })

  it('non-https endpoints (register/status/revoke) → fail', async () => {
    const { checks } = await judge({ aap: { endpoints: { register: 'http://aap.example/agent/register', status: 'http://aap.example/agent/status', revoke: 'http://aap.example/agent/revoke' } } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/register|status|revoke/)
  })

  it('relative (non-absolute) endpoints → fail', async () => {
    const { checks } = await judge({ aap: { endpoints: { register: '/agent/register', status: '/agent/status', revoke: '/agent/revoke' } } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/register|status|revoke/)
  })

  it('missing jwks_uri → fail', async () => {
    const { checks } = await judge({ aap: { jwks_uri: undefined } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
    expect(detailOf(checks, 'aap-discovery')).toMatch(/jwks_uri/)
  })

  it('a custom approval_methods value is tolerated (still passes)', async () => {
    const { checks } = await judge({ aap: { approval_methods: ['claim_by_commit'] } })
    expect(verdictOf(checks, 'aap-discovery'), detailOf(checks, 'aap-discovery')).toBe('pass')
  })

  it('200 that is not a JSON object → fail (present but malformed)', async () => {
    const { checks } = await judge({ agentConfig: { status: 200, contentType: 'application/json', body: '"not-an-object"' } })
    expect(verdictOf(checks, 'aap-discovery')).toBe('fail')
  })

  it('absent /.well-known/agent-configuration → skip (not a claim of AAP)', async () => {
    const { checks } = await judge({ agentConfig: null })
    expect(verdictOf(checks, 'aap-discovery')).toBe('skip')
  })
})

// ---------------------------------------------------------------------------
// authmd-agent-identity — per-defect FAIL; absent agent_auth / AS metadata SKIP
// ---------------------------------------------------------------------------

describe('authmd-agent-identity fails the specific advertisement defect', () => {
  it('non-https identity_endpoint → fail', async () => {
    const { checks } = await judge({ identityEndpoint: 'http://as.example/agent/identity' })
    expect(verdictOf(checks, 'authmd-agent-identity')).toBe('fail')
    expect(detailOf(checks, 'authmd-agent-identity')).toMatch(/identity_endpoint/)
  })

  it('no ID-JAG advertised → fail', async () => {
    const { checks } = await judge({ idJag: false })
    expect(verdictOf(checks, 'authmd-agent-identity')).toBe('fail')
    expect(detailOf(checks, 'authmd-agent-identity')).toMatch(/ID-JAG/)
  })

  it('ID-JAG urn in an UNRELATED field (issuer/provider_name) does NOT satisfy the requirement → fail', async () => {
    // The urn appears in issuer and in agent_auth.provider_name, but in NO
    // accepted-subject-token / assertion-type field, so it must not count.
    const { checks } = await judge({
      asMetadata: jsonOut({
        issuer: IDJAG,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        code_challenge_methods_supported: ['S256'],
        registration_endpoint: `${AS}/register`,
        agent_auth: {
          identity_endpoint: `${AS}/agent/identity`,
          claim_endpoint: `${AS}/agent/claim`,
          events_endpoint: `${AS}/agent/events`,
          provider_name: IDJAG,
        },
      }),
    })
    expect(verdictOf(checks, 'authmd-agent-identity')).toBe('fail')
    expect(detailOf(checks, 'authmd-agent-identity')).toMatch(/ID-JAG/)
  })

  it('ID-JAG urn in the designated agent_auth subject_token_types field DOES satisfy → pass', async () => {
    // No top-level subject_token_types_supported (idJag:false drops it); the urn
    // is declared only in the designated agent_auth key, which correctly counts.
    const { checks } = await judge({
      idJag: false,
      agentAuth: {
        identity_endpoint: `${AS}/agent/identity`,
        claim_endpoint: `${AS}/agent/claim`,
        events_endpoint: `${AS}/agent/events`,
        subject_token_types: [IDJAG],
      },
    })
    expect(verdictOf(checks, 'authmd-agent-identity'), detailOf(checks, 'authmd-agent-identity')).toBe('pass')
  })

  it('no events_endpoint (SET revocation) → fail', async () => {
    const { checks } = await judge({
      agentAuth: { identity_endpoint: `${AS}/agent/identity`, claim_endpoint: `${AS}/agent/claim` },
    })
    expect(verdictOf(checks, 'authmd-agent-identity')).toBe('fail')
    expect(detailOf(checks, 'authmd-agent-identity')).toMatch(/events_endpoint|SET/)
  })

  it('identity_endpoint that does not resolve (404) → fail', async () => {
    const { checks } = await judge({ identity: null })
    expect(verdictOf(checks, 'authmd-agent-identity')).toBe('fail')
    expect(detailOf(checks, 'authmd-agent-identity')).toMatch(/resolve/)
  })

  it('AS metadata carries no agent_auth block → skip (not an agent-identity provider)', async () => {
    const { checks } = await judge({ agentAuth: null })
    expect(verdictOf(checks, 'authmd-agent-identity')).toBe('skip')
  })

  it('no AS metadata at all (no MCP declared) → skip', async () => {
    const { checks } = await judge({ declareMcp: false })
    expect(verdictOf(checks, 'authmd-agent-identity')).toBe('skip')
  })
})

// ---------------------------------------------------------------------------
// SSRF safety — hostile identity_endpoint is NEVER fetched
// ---------------------------------------------------------------------------

const METADATA_BODY = 'AWS-CREDS-agent-identity-secret-do-not-exfiltrate'

describe('SSRF: a hostile identity_endpoint is refused without fetching', () => {
  // 169.254.169.254 (the cloud metadata address) in each encoded form a naive
  // parser might resolve to it: literal off-origin host, dotted-quad, decimal
  // integer, hex integer, and IPv4-mapped IPv6. Each hostile URL must be refused
  // from the URL string alone — never requested.
  for (const { label, endpoint } of [
    { label: 'off (AS-)origin', endpoint: 'https://evil.example/agent/identity' },
    { label: 'private/metadata dotted-quad', endpoint: 'https://169.254.169.254/agent/identity' },
    { label: 'metadata as decimal integer', endpoint: 'https://2852039166/agent/identity' },
    { label: 'metadata as hex integer', endpoint: 'https://0xA9FEA9FE/agent/identity' },
    { label: 'metadata as IPv4-mapped IPv6', endpoint: 'https://[::ffff:169.254.169.254]/agent/identity' },
  ]) {
    it(`${label} identity_endpoint: never fetched, authmd fails closed`, async () => {
      // Make the hostile host reachable so a naive fetch WOULD succeed — proving
      // the guard, not the mock 404, is what stops it. The hostile host is the
      // hostname of the endpoint under test (whatever encoded form it took).
      const hostileHost = safeHost(endpoint)
      const base = multiFetcher(routes({ identityEndpoint: endpoint })).fetcher
      const calls: string[] = []
      const fetcher: Fetcher = async (url, init) => {
        calls.push(url)
        if (safeHost(url) === hostileHost) {
          return new Response(METADATA_BODY, { status: 200, headers: { 'content-type': 'text/plain' } })
        }
        return base(url, init)
      }
      const observer = new Observer({ fetcher, delayMs: 0 })
      const bundle = await observeTarget(TARGET, observer, 42)
      const checks = runChecks(bundle)

      // The hostile identity_endpoint is NEVER requested.
      expect(calls).not.toContain(endpoint)
      expect(calls.some((u) => safeHost(u) === hostileHost)).toBe(false)
      for (const ev of bundle.items) expect(ev.body ?? '').not.toContain(METADATA_BODY)
      // authmd fails closed with an SSRF-refusal detail.
      expect(verdictOf(checks, 'authmd-agent-identity')).toBe('fail')
      expect(detailOf(checks, 'authmd-agent-identity')).toMatch(/same-origin|refused without fetching|SSRF/i)
    })
  }
})

describe('SSRF: agent-configuration at a private/metadata target is refused by the structural backstop', () => {
  it('nothing is fetched; the agent-configuration evidence is a blocked failure', async () => {
    const priv = 'http://169.254.169.254'
    const calls: string[] = []
    const fetcher: Fetcher = async (url) => {
      calls.push(url)
      return new Response(METADATA_BODY, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    // allowPrivate is NOT set — the deployed-Worker posture.
    const observer = new Observer({ fetcher, delayMs: 0 })
    const bundle = await observeTarget(priv, observer, 42)

    expect(calls).toHaveLength(0)
    const ac = bundle.items.find((e) => e.role === 'surface:agent-configuration')
    expect(ac?.status).toBeNull()
    expect(ac?.error).toMatch(/private|metadata|ssrf/i)
    for (const ev of bundle.items) expect(ev.body ?? '').not.toContain(METADATA_BODY)
  })
})

// ---------------------------------------------------------------------------
// Pinnable via kind:'check' — an AXP contract can bind both MUSTs
// ---------------------------------------------------------------------------

describe('pinnable: an AXP contract binds the agent-identity MUSTs via kind:check', () => {
  const spec = JSON.stringify({
    $type: 'PinnedSpec',
    name: 'aap-authmd',
    version: '1',
    requirements: [
      { id: 'must-aap-discovery', kind: 'check', check: 'aap-discovery', must: 'pass' },
      { id: 'must-authmd-agent-identity', kind: 'check', check: 'authmd-agent-identity', must: 'pass' },
    ],
  })

  it('a conformant target passes every pinned agent-identity requirement', async () => {
    const { fetcher } = multiFetcher(routes())
    const report = await verifyPinnedSpec(TARGET, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed, JSON.stringify(report.requirements, null, 2)).toBe(true)
  })

  it('a missing-jwks_uri target fails exactly the pinned aap-discovery requirement', async () => {
    const { fetcher } = multiFetcher(routes({ aap: { jwks_uri: undefined } }))
    const report = await verifyPinnedSpec(TARGET, spec, { fetcher, delayMs: 0, seed: 1, mode: 'local' })
    expect(report.passed).toBe(false)
    expect(report.requirements.find((r) => r.id === 'must-aap-discovery')?.verdict).toBe('fail')
    expect(report.requirements.find((r) => r.id === 'must-authmd-agent-identity')?.verdict).toBe('pass')
  })
})

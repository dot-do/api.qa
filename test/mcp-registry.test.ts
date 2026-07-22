/**
 * MCP-registry publishability (ax-e6b.38). A listing can pass AX-6 'mcp-declared'
 * (presence-grade) yet NOT be publishable to / discoverable via the official MCP
 * Registry (registry.modelcontextprotocol.io) the agent-native hubs ingest from.
 * This dimension grades the missing piece, DERIVED from the target's published
 * surfaces + DNS (verifier-independent):
 *   (a) server.json validity — required registry fields + reverse-DNS name shape
 *   (b) LIVE MCP remote resolution — initialize → tools/list (upgrade from
 *       presence-only): reachable+tools => pass, 401/403 => reachable+protected,
 *       dead/unreachable => fail
 *   (c) domain-ownership provability — DNS-TXT (v=MCPv1) via DoH OR the
 *       /.well-known/mcp-registry-auth (v=MCPv1) HTTPS proof, or the
 *       io.github.<owner> ↔ github.com/<owner> self-consistent proof
 *   (d) OPTIONAL registry presence (informational — never caps)
 *
 * The dimension ACTIVATES only when the target serves a server.json (an
 * affirmative registry claim); otherwise every sub-check SKIPs (AX-6 still
 * records the presence-only MCP declaration). Active sub-checks are HONESTY caps:
 * an invalid manifest / dead remote / unprovable ownership FAILs and caps the
 * grade. Every fetch (server.json, the MCP remote, DoH, well-known, registry) is
 * SSRF-gated; a fetch-spy proves hostile URLs are never requested.
 */

import { describe, it, expect } from 'vitest'
import { Observer, type Fetcher } from '../src/http.js'
import { observeTarget } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import { goodTargetRoutes, GOOD, type Routes } from './helpers.js'
import type { CheckResult } from '../src/types.js'

// The namespace for a com.-style target hosted at good.example: reverse the
// domain labels — good.example ⇒ example.good.
const NAME = 'example.good/widget'
const REMOTE = 'https://good-remote.example/mcp' // off-origin, PUBLIC — the narrow off-origin allowance
const DOH = 'https://dns.google/resolve?name=good.example&type=TXT'
const REGISTRY = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(NAME)}`
const SERVER_JSON_URL = `${GOOD}/.well-known/mcp/server.json`
const AUTH_WK_URL = `${GOOD}/.well-known/mcp-registry-auth`

type RouteOut = { status: number; contentType?: string; body?: string; headers?: Record<string, string> }
type RouteHandler = (init?: RequestInit) => RouteOut
type RouteTable = Record<string, RouteHandler>

function jsonOut(body: unknown, status = 200): RouteOut {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function validServerJson(over: Record<string, unknown> = {}): unknown {
  return {
    name: NAME,
    version: '1.2.3',
    title: 'Good Widget MCP',
    description: 'The reference agent-first widget MCP server.',
    websiteUrl: `${GOOD}/`,
    repository: { url: 'https://github.com/good/widget', source: 'github' },
    remotes: [{ type: 'streamable-http', url: REMOTE }],
    ...over,
  }
}

function initializeOut(sessionId = 'sess-1'): RouteOut {
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'mcp-session-id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: NAME, version: '1.2.3' } },
    }),
  }
}

function toolsListOut(tools: string[] = ['list_widgets', 'create_widget']): RouteOut {
  return jsonOut({ jsonrpc: '2.0', id: 2, result: { tools: tools.map((name) => ({ name, description: name })) } })
}

/** The DoH TXT proof (v=MCPv1) or, when `proof` is false, an unrelated record. */
function dohTxtOut(proof = true): RouteOut {
  return jsonOut({
    Status: 0,
    Answer: [
      { name: 'good.example.', type: 16, TTL: 300, data: proof ? 'v=MCPv1; k=ed25519; p=AAAA' : 'v=spf1 -all' },
    ],
  })
}

function registryPresentOut(present = true): RouteOut {
  return jsonOut({ servers: present ? [{ name: NAME, version: '1.2.3' }] : [] })
}

interface FixtureOpts {
  serverJson?: unknown | null // null => 404 the well-known (dimension inactive)
  serverJsonPointer?: string // agents.json serverJson pointer (declared location)
  initialize?: RouteOut | null // null => 404 the remote (dead)
  toolsList?: RouteOut
  authWellKnown?: RouteOut | null // null => 404
  doh?: RouteOut | null
  registry?: RouteOut | null
  remoteUrlOverride?: string // used only to build the correct POST route key
}

/** A goodTargetRoutes-based, multi-origin absolute route table. */
function buildRoutes(opts: FixtureOpts = {}): RouteTable {
  const table: RouteTable = {}
  // 1. good target same-origin surfaces (kept A+): convert relative→absolute.
  const rel: Routes = goodTargetRoutes()
  // Inject a server.json pointer into agents.json if requested.
  if (opts.serverJsonPointer !== undefined) {
    const card = JSON.parse(rel['GET /.well-known/agents.json']!({ method: 'GET', accept: '*/*' }).body!)
    card.serverJson = opts.serverJsonPointer
    rel['GET /.well-known/agents.json'] = () => jsonOut(card)
  }
  for (const [key, handler] of Object.entries(rel)) {
    const sp = key.indexOf(' ')
    const method = key.slice(0, sp)
    const path = key.slice(sp + 1)
    table[`${method} ${GOOD}${path}`] = (init) =>
      handler({ method, accept: acceptOf(init), body: bodyOf(init) })
  }

  // 2. server.json manifest at the default well-known (unless a pointer moved it).
  const sjUrl = opts.serverJsonPointer ?? SERVER_JSON_URL
  if (opts.serverJson !== null) {
    table[`GET ${sjUrl}`] = () => jsonOut(opts.serverJson ?? validServerJson())
  }

  // 3. the off-origin remote handshake.
  const remoteUrl = opts.remoteUrlOverride ?? REMOTE
  if (opts.initialize !== null) {
    table[`POST ${remoteUrl}`] = (init) => {
      const body = bodyOf(init) ?? ''
      if (body.includes('"tools/list"')) return opts.toolsList ?? toolsListOut()
      return opts.initialize ?? initializeOut()
    }
  }

  // 4. ownership proofs.
  if (opts.authWellKnown !== null) {
    table[`GET ${AUTH_WK_URL}`] = () =>
      opts.authWellKnown ?? { status: 200, contentType: 'text/plain', body: 'v=MCPv1; k=ed25519; p=AAAA' }
  }
  if (opts.doh !== null) table[`GET ${DOH}`] = () => opts.doh ?? dohTxtOut()

  // 5. registry presence.
  if (opts.registry !== null) table[`GET ${REGISTRY}`] = () => opts.registry ?? registryPresentOut()

  return table
}

function acceptOf(init?: RequestInit): string {
  const h = init?.headers as Record<string, string> | undefined
  return h?.accept ?? '*/*'
}
function bodyOf(init?: RequestInit): string | undefined {
  return typeof init?.body === 'string' ? init.body : undefined
}

/** A fetcher over an absolute-url route table that records every call. */
function multiFetcher(table: RouteTable, extra?: Fetcher): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url)
    if (extra) {
      const injected = await extra(url, init)
      if (injected) return injected
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    const handler = table[`${method} ${url}`]
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    const out = handler(init)
    return new Response(out.body ?? '', {
      status: out.status,
      headers: { 'content-type': out.contentType ?? 'text/plain', ...(out.headers ?? {}) },
    })
  }
  return { fetcher, calls }
}

async function judge(opts: FixtureOpts = {}, extra?: Fetcher) {
  const { fetcher, calls } = multiFetcher(buildRoutes(opts), extra)
  const observer = new Observer({ fetcher, delayMs: 0 })
  const bundle = await observeTarget(GOOD, observer, 42)
  const checks = runChecks(bundle)
  const score = axScoreOf(checks)
  const { grade, notes } = gradeOf(score, checks)
  return { bundle, checks, calls, observer, score, grade, notes }
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

const REGISTRY_IDS = ['mcp-server-json', 'mcp-remote-live', 'mcp-registry-ownership', 'mcp-registry-presence'] as const

// ---------------------------------------------------------------------------
// Fully publishable target — every sub-check passes, grade stays A+ (no cap)
// ---------------------------------------------------------------------------

describe('a fully registry-publishable target passes every publishability check', () => {
  it('valid server.json + live tools-listing remote + provable ownership → all pass', async () => {
    const { checks } = await judge()
    expect(verdictOf(checks, 'mcp-server-json'), detailOf(checks, 'mcp-server-json')).toBe('pass')
    expect(verdictOf(checks, 'mcp-remote-live'), detailOf(checks, 'mcp-remote-live')).toBe('pass')
    expect(verdictOf(checks, 'mcp-registry-ownership'), detailOf(checks, 'mcp-registry-ownership')).toBe('pass')
    expect(verdictOf(checks, 'mcp-registry-presence'), detailOf(checks, 'mcp-registry-presence')).toBe('pass')
    expect(detailOf(checks, 'mcp-remote-live')).toMatch(/tools\/list advertises 2 tool/)
  })

  it('does NOT inflate or cap: the good target still scores 10/10 and grades A+', async () => {
    const { score, grade, checks } = await judge()
    for (const c of checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })

  it('is deterministic: judging the same bundle twice is byte-identical', async () => {
    const observer = new Observer({ fetcher: multiFetcher(buildRoutes()).fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)
    expect(JSON.stringify(runChecks(bundle))).toBe(JSON.stringify(runChecks(bundle)))
  })

  it('an SSE-framed tools/list response is parsed too', async () => {
    const sse: RouteOut = {
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"only_tool"}]}}\n\n',
    }
    const { checks } = await judge({ toolsList: sse })
    expect(verdictOf(checks, 'mcp-remote-live'), detailOf(checks, 'mcp-remote-live')).toBe('pass')
    expect(detailOf(checks, 'mcp-remote-live')).toMatch(/only_tool/)
  })
})

// ---------------------------------------------------------------------------
// No server.json — the dimension is inactive (every sub-check SKIPs)
// ---------------------------------------------------------------------------

describe('a target with no server.json skips the whole dimension (no over-block)', () => {
  it('every publishability sub-check SKIPs and none fails', async () => {
    const { checks } = await judge({ serverJson: null })
    for (const id of REGISTRY_IDS) expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('skip')
    // AX-6 presence still passes (good target declares stdio MCP + tools).
    expect(verdictOf(checks, 'mcp-declared')).toBe('pass')
  })

  it('grade is unaffected — still A+', async () => {
    const { grade, score } = await judge({ serverJson: null })
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })
})

// ---------------------------------------------------------------------------
// server.json validity — each defect FAILs mcp-server-json and caps the grade
// ---------------------------------------------------------------------------

describe('server.json validity is graded honestly (present-but-invalid caps)', () => {
  it('missing required registry fields → mcp-server-json fails', async () => {
    const { checks } = await judge({ serverJson: { name: NAME, version: '1.0.0' } }) // no title/description/repo/website/remotes
    expect(verdictOf(checks, 'mcp-server-json')).toBe('fail')
    expect(detailOf(checks, 'mcp-server-json')).toMatch(/title|description|repository|websiteUrl|remotes/)
  })

  it('an invalid reverse-DNS name → mcp-server-json fails', async () => {
    const { checks } = await judge({ serverJson: validServerJson({ name: 'not-a-namespace' }) })
    expect(verdictOf(checks, 'mcp-server-json')).toBe('fail')
    expect(detailOf(checks, 'mcp-server-json')).toMatch(/reverse-DNS namespace/)
  })

  it('an empty title (present-but-empty) → mcp-server-json fails (no inflation)', async () => {
    const { checks } = await judge({ serverJson: validServerJson({ title: '' }) })
    expect(verdictOf(checks, 'mcp-server-json')).toBe('fail')
  })

  it('an empty remotes array → mcp-server-json fails', async () => {
    const { checks } = await judge({ serverJson: validServerJson({ remotes: [] }) })
    expect(verdictOf(checks, 'mcp-server-json')).toBe('fail')
  })

  it('an unknown remote transport → mcp-server-json fails', async () => {
    const { checks } = await judge({ serverJson: validServerJson({ remotes: [{ type: 'carrier-pigeon', url: REMOTE }] }) })
    expect(verdictOf(checks, 'mcp-server-json')).toBe('fail')
    expect(detailOf(checks, 'mcp-server-json')).toMatch(/streamable-http \| sse/)
  })

  it('a served-but-non-JSON server.json → mcp-server-json fails', async () => {
    // Serve a non-JSON body at the well-known (2xx but unparseable).
    const table = buildRoutes({ serverJson: null })
    table[`GET ${SERVER_JSON_URL}`] = () => ({ status: 200, contentType: 'application/json', body: 'not json{' })
    const observer = new Observer({ fetcher: multiFetcher(table).fetcher, delayMs: 0 })
    const bundle = await observeTarget(GOOD, observer, 42)
    const cs = runChecks(bundle)
    expect(verdictOf(cs, 'mcp-server-json')).toBe('fail')
    expect(detailOf(cs, 'mcp-server-json')).toMatch(/not a valid JSON object/)
  })

  it('an invalid server.json CAPS the grade at C (honest AX integration)', async () => {
    const { grade, notes } = await judge({ serverJson: validServerJson({ name: 'not-a-namespace' }) })
    expect(['C', 'D', 'F']).toContain(grade)
    expect(notes.join(' ')).toMatch(/capped at C/)
    expect(notes.join(' ')).toMatch(/mcp-server-json/)
  })
})

// ---------------------------------------------------------------------------
// LIVE MCP remote resolution — upgrade from presence-only
// ---------------------------------------------------------------------------

describe('the declared MCP remote is resolved LIVE (not presence-only)', () => {
  it('a dead remote (initialize 404) → mcp-remote-live fails (and caps)', async () => {
    const { checks, grade } = await judge({ initialize: null })
    expect(verdictOf(checks, 'mcp-remote-live')).toBe('fail')
    expect(detailOf(checks, 'mcp-remote-live')).toMatch(/did not resolve|unreachable/)
    expect(['C', 'D', 'F']).toContain(grade)
  })

  it('an auth-gated remote (initialize 401) → mcp-remote-live PASSES (reachable+protected)', async () => {
    const { checks } = await judge({ initialize: { status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' } })
    expect(verdictOf(checks, 'mcp-remote-live'), detailOf(checks, 'mcp-remote-live')).toBe('pass')
    expect(detailOf(checks, 'mcp-remote-live')).toMatch(/reachable\+protected|reachable and auth-protected/)
  })

  it('a remote that resolves but advertises NO tools → mcp-remote-live fails', async () => {
    const { checks } = await judge({ toolsList: jsonOut({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) })
    expect(verdictOf(checks, 'mcp-remote-live')).toBe('fail')
    expect(detailOf(checks, 'mcp-remote-live')).toMatch(/advertised no tools/)
  })

  it('a remote that errors on initialize → mcp-remote-live fails', async () => {
    const { checks } = await judge({ initialize: jsonOut({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }) })
    expect(verdictOf(checks, 'mcp-remote-live')).toBe('fail')
  })

  it('a server.json with no http remote → mcp-remote-live SKIPs (nothing live to resolve)', async () => {
    // An empty remotes array fails mcp-server-json (a publishable listing needs a
    // remote), but the live-resolution check has nothing to connect to, so it
    // SKIPs rather than double-jeopardying the same defect.
    const { checks } = await judge({ serverJson: validServerJson({ remotes: [] }) })
    expect(verdictOf(checks, 'mcp-server-json')).toBe('fail')
    expect(verdictOf(checks, 'mcp-remote-live')).toBe('skip')
    expect(detailOf(checks, 'mcp-remote-live')).toMatch(/no http remote/)
  })
})

// ---------------------------------------------------------------------------
// Ownership provability
// ---------------------------------------------------------------------------

describe('domain-ownership provability gates namespace publish', () => {
  it('neither DNS-TXT nor well-known proof → mcp-registry-ownership fails (and caps)', async () => {
    const { checks, grade } = await judge({ authWellKnown: null, doh: dohTxtOut(false) })
    expect(verdictOf(checks, 'mcp-registry-ownership')).toBe('fail')
    expect(detailOf(checks, 'mcp-registry-ownership')).toMatch(/cannot prove ownership/)
    expect(['C', 'D', 'F']).toContain(grade)
  })

  it('DNS-TXT (v=MCPv1) proof alone → mcp-registry-ownership passes', async () => {
    const { checks } = await judge({ authWellKnown: null, doh: dohTxtOut(true) })
    expect(verdictOf(checks, 'mcp-registry-ownership'), detailOf(checks, 'mcp-registry-ownership')).toBe('pass')
    expect(detailOf(checks, 'mcp-registry-ownership')).toMatch(/DNS-TXT/)
  })

  it('/.well-known/mcp-registry-auth (v=MCPv1) proof alone → passes', async () => {
    const { checks } = await judge({ doh: dohTxtOut(false) })
    expect(verdictOf(checks, 'mcp-registry-ownership'), detailOf(checks, 'mcp-registry-ownership')).toBe('pass')
    expect(detailOf(checks, 'mcp-registry-ownership')).toMatch(/well-known/)
  })

  it('a github namespace proven by a matching github.com repository → passes (no DNS needed)', async () => {
    const gh = validServerJson({ name: 'io.github.acme/widget', repository: { url: 'https://github.com/acme/widget', source: 'github' } })
    const { checks } = await judge({ serverJson: gh, authWellKnown: null, doh: null })
    expect(verdictOf(checks, 'mcp-registry-ownership'), detailOf(checks, 'mcp-registry-ownership')).toBe('pass')
    expect(detailOf(checks, 'mcp-registry-ownership')).toMatch(/GitHub-account-backed/)
  })

  it('a github namespace whose repository owner does NOT match → fails', async () => {
    const gh = validServerJson({ name: 'io.github.acme/widget', repository: { url: 'https://github.com/someone-else/widget', source: 'github' } })
    const { checks } = await judge({ serverJson: gh, authWellKnown: null, doh: null })
    expect(verdictOf(checks, 'mcp-registry-ownership')).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// Registry presence — informational, NEVER caps
// ---------------------------------------------------------------------------

describe('registry presence is informational (never caps)', () => {
  it('present in the registry → mcp-registry-presence passes', async () => {
    const { checks } = await judge()
    expect(verdictOf(checks, 'mcp-registry-presence')).toBe('pass')
  })

  it('NOT present → mcp-registry-presence SKIPs (does not fail, does not cap)', async () => {
    const { checks, grade } = await judge({ registry: registryPresentOut(false) })
    expect(verdictOf(checks, 'mcp-registry-presence')).toBe('skip')
    // Everything else publishable → no cap from the informational check.
    expect(grade).toBe('A+')
  })

  it('registry unreachable → mcp-registry-presence SKIPs (never fails)', async () => {
    const { checks, grade } = await judge({ registry: null })
    expect(verdictOf(checks, 'mcp-registry-presence')).toBe('skip')
    expect(grade).toBe('A+')
  })
})

// ---------------------------------------------------------------------------
// SSRF — server.json / remote / DoH must be gated; hostile URLs never fetched
// ---------------------------------------------------------------------------

const METADATA_BODY = 'AWS-CREDS-mcp-registry-secret-do-not-exfiltrate'

/** An injected fetcher that serves creds for any hostile host (proves the guard). */
function credsFetcher(): Fetcher {
  return async (url) => {
    const host = safeHost(url)
    if (host === 'evil.example' || host === '169.254.169.254') {
      return new Response(METADATA_BODY, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    return undefined as unknown as Response
  }
}

describe('SSRF: a card-declared off-origin/private server.json url is refused without fetching', () => {
  for (const { label, pointer } of [
    { label: 'off-origin', pointer: 'https://evil.example/server.json' },
    { label: 'private/metadata IP', pointer: 'http://169.254.169.254/server.json' },
  ]) {
    it(`${label} server.json pointer is never fetched; the dimension fails closed to SKIP`, async () => {
      const { calls, checks, bundle } = await judge({ serverJsonPointer: pointer }, credsFetcher())
      expect(calls.some((u) => ['evil.example', '169.254.169.254'].includes(safeHost(u)))).toBe(false)
      // The default well-known is NOT used as a fallback for a hostile declaration.
      expect(calls).not.toContain(SERVER_JSON_URL)
      for (const ev of bundle.items) expect(ev.body ?? '').not.toContain(METADATA_BODY)
      // No server.json evidence ⇒ the dimension SKIPs (no false publishable pass).
      expect(verdictOf(checks, 'mcp-server-json')).toBe('skip')
    })
  }
})

describe('SSRF: a server.json remote at a private/metadata address is refused without fetching', () => {
  for (const { label, remote } of [
    { label: 'cleartext private IP', remote: 'http://169.254.169.254/mcp' },
    { label: 'https private IP', remote: 'https://169.254.169.254/mcp' },
    { label: 'off-origin cleartext (no https)', remote: 'http://evil.example/mcp' },
  ]) {
    it(`${label}: remote never POSTed; mcp-remote-live fails closed`, async () => {
      const sj = validServerJson({ remotes: [{ type: 'streamable-http', url: remote }] })
      const { calls, checks, bundle } = await judge({ serverJson: sj, remoteUrlOverride: remote }, credsFetcher())
      // The hostile remote is NEVER requested (in any method).
      expect(calls.some((u) => ['evil.example', '169.254.169.254'].includes(safeHost(u)))).toBe(false)
      for (const ev of bundle.items) expect(ev.body ?? '').not.toContain(METADATA_BODY)
      expect(verdictOf(checks, 'mcp-remote-live')).toBe('fail')
      expect(detailOf(checks, 'mcp-remote-live')).toMatch(/refused without fetching|SSRF|public https/i)
    })
  }

  it('a genuinely publishable OFF-ORIGIN PUBLIC remote IS resolved (the narrow allowance works)', async () => {
    const { calls, checks } = await judge()
    expect(calls).toContain(REMOTE) // the off-origin public remote WAS POSTed
    expect(verdictOf(checks, 'mcp-remote-live')).toBe('pass')
  })
})

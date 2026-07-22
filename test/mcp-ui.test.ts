/**
 * MCP-UI / streaming-component readiness (ax-odg, ADR-0022). api.qa grades
 * whether a target correctly emits MCP Apps (SEP-1865) `ui://` UIResources so
 * the widget renders TRUSTWORTHILY inside an agent host (ChatGPT/Claude/Goose/
 * VS Code). This is the GRADER side: the check inspects whatever a target's
 * published MCP surface CLAIMS. Five sub-signals, each graded HONESTLY:
 *   (1) resource linkage + MIME     — _meta.ui.resourceUri → ui:// with an
 *                                     MCP-Apps/MCP-UI content type
 *   (2) srcDoc self-containment     — no remote <script>/<link>/@import/fetch;
 *       + closed CSP                  _meta.ui.csp admits no wildcard/remote
 *   (3) envelope hygiene (HIGH)     — no secret in a model-visible channel
 *   (4) three-register parity       — widget structuredContent is consistent
 *                                     with the agent/API register
 *   (5) host-render readiness       — first-render-without-input + a
 *                                     description/widgetDescription/annotations
 *
 * ACTIVATION: only when a tool advertises a `ui://` template. A target with NO
 * MCP-UI informationally SKIPs every sub-check (NOT a fail — it must not tank
 * the grade). A target that DECLARES MCP-UI but violates a sub-signal FAILs and
 * is graded DOWN honestly. SSRF: every fetch is gated — a private/non-https
 * externalUrl is REFUSED without a byte leaving.
 */

import { describe, it, expect } from 'vitest'
import { Observer, type Fetcher } from '../src/http.js'
import { observeTarget } from '../src/discovery.js'
import { runChecks } from '../src/checks.js'
import { axScoreOf, gradeOf } from '../src/grade.js'
import { goodTargetRoutes, GOOD, type Routes } from './helpers.js'
import type { CheckResult } from '../src/types.js'

const NAME = 'example.good/widget'
const REMOTE = 'https://good-remote.example/mcp' // off-origin PUBLIC (the narrow allowance)
const DOH = 'https://dns.google/resolve?name=good.example&type=TXT'
const REGISTRY = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(NAME)}`
const SERVER_JSON_URL = `${GOOD}/.well-known/mcp/server.json`
const AUTH_WK_URL = `${GOOD}/.well-known/mcp-registry-auth`
const TEMPLATE_URI = 'ui://widget/list_widgets'
const EXTERNAL_PUBLIC = 'https://widgets.good.example/embed'
const EXTERNAL_PRIVATE = 'http://169.254.169.254/embed'

// A self-contained, CSP-safe widget srcDoc: inline styles + inline script, no
// external http(s) references anywhere.
const SRCDOC_CLEAN = `<!doctype html><html><head><style>body{font:14px system-ui}</style></head>
<body><ul id="w"></ul><script>const s=window.__data||{};document.getElementById('w').textContent='ok'</script></body></html>`

// A widget that pulls REMOTE code — a host-sandbox + supply-chain risk.
const SRCDOC_REMOTE = `<!doctype html><html><head>
<script src="https://cdn.evil.example/widget.js"></script></head><body>hi</body></html>`

type RouteOut = { status: number; contentType?: string; body?: string; headers?: Record<string, string> }
type RouteHandler = (init?: RequestInit) => RouteOut
type RouteTable = Record<string, RouteHandler>

function jsonOut(body: unknown, status = 200): RouteOut {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function validServerJson(): unknown {
  return {
    name: NAME,
    version: '1.2.3',
    title: 'Good Widget MCP',
    description: 'The reference agent-first widget MCP server.',
    websiteUrl: `${GOOD}/`,
    repository: { url: 'https://github.com/good/widget', source: 'github' },
    remotes: [{ type: 'streamable-http', url: REMOTE }],
  }
}

function initializeOut(): RouteOut {
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'mcp-session-id': 'sess-1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: NAME, version: '1.2.3' } } }),
  }
}

/** A UI-bearing tool definition (advertises a ui:// template) + a plain tool. */
function defaultToolDefs(over: Record<string, unknown> = {}): unknown[] {
  const uiTool: Record<string, unknown> = {
    name: 'list_widgets',
    description: 'List all widgets for the account.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _meta: { ui: { resourceUri: TEMPLATE_URI, widgetDescription: 'A live list of your widgets.' } },
    annotations: { readOnlyHint: true, title: 'Widgets' },
    ...over,
  }
  return [uiTool, { name: 'create_widget', description: 'Create a widget.', inputSchema: { type: 'object', required: ['name'] } }]
}

function toolsListOut(tools: unknown[] = defaultToolDefs()): RouteOut {
  return jsonOut({ jsonrpc: '2.0', id: 2, result: { tools } })
}

interface ResultOpts {
  structuredContent?: unknown
  content?: unknown
  meta?: unknown
  omitResourceUri?: boolean
}

function defaultResult(o: ResultOpts = {}): unknown {
  const meta = o.meta !== undefined
    ? o.meta
    : { ui: { resourceUri: o.omitResourceUri ? undefined : TEMPLATE_URI, csp: { 'script-src': "'self' 'unsafe-inline'", 'connect-src': "'self'" } } }
  return {
    jsonrpc: '2.0',
    id: 3,
    result: {
      content: o.content !== undefined ? o.content : [{ type: 'text', text: 'Here are your 3 widgets.' }],
      structuredContent: o.structuredContent !== undefined ? o.structuredContent : { count: 3, widgets: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] },
      _meta: meta,
    },
  }
}

interface ResourceOpts {
  mimeType?: string
  text?: string
  uri?: string
  empty?: boolean
}

function defaultResourceRead(o: ResourceOpts = {}): unknown {
  if (o.empty) return { jsonrpc: '2.0', id: 4, result: { contents: [] } }
  return {
    jsonrpc: '2.0',
    id: 4,
    result: { contents: [{ uri: o.uri ?? TEMPLATE_URI, mimeType: o.mimeType ?? 'text/html;profile=mcp-app', text: o.text ?? SRCDOC_CLEAN }] },
  }
}

interface FixtureOpts {
  tools?: unknown[]
  toolCallResult?: unknown
  resourceRead?: unknown
  externalPublicBody?: string // body served at EXTERNAL_PUBLIC when the widget is externalUrl
  noUiTool?: boolean // tools/list has only plain tools (no ui:// template)
}

function buildRoutes(opts: FixtureOpts = {}): RouteTable {
  const table: RouteTable = {}
  const rel: Routes = goodTargetRoutes()
  for (const [key, handler] of Object.entries(rel)) {
    const sp = key.indexOf(' ')
    const method = key.slice(0, sp)
    const path = key.slice(sp + 1)
    table[`${method} ${GOOD}${path}`] = (init) => handler({ method, accept: acceptOf(init), body: bodyOf(init) })
  }

  // server.json at the default well-known.
  table[`GET ${SERVER_JSON_URL}`] = () => jsonOut(validServerJson())

  // The off-origin remote — dispatch by JSON-RPC method.
  const tools = opts.noUiTool ? [{ name: 'plain', description: 'plain', inputSchema: { type: 'object' } }] : (opts.tools ?? defaultToolDefs())
  table[`POST ${REMOTE}`] = (init) => {
    const body = bodyOf(init) ?? ''
    let method = ''
    try { method = JSON.parse(body).method } catch { /* */ }
    if (method === 'tools/list') return toolsListOut(tools)
    if (method === 'tools/call') return jsonOut(opts.toolCallResult ?? defaultResult())
    if (method === 'resources/read') return jsonOut(opts.resourceRead ?? defaultResourceRead())
    return initializeOut()
  }

  // ownership proofs (keep the target fully registry-publishable → clean baseline).
  table[`GET ${AUTH_WK_URL}`] = () => ({ status: 200, contentType: 'text/plain', body: 'v=MCPv1; k=ed25519; p=AAAA' })
  table[`GET ${DOH}`] = () => jsonOut({ Status: 0, Answer: [{ name: 'good.example.', type: 16, TTL: 300, data: 'v=MCPv1; k=ed25519; p=AAAA' }] })
  table[`GET ${REGISTRY}`] = () => jsonOut({ servers: [{ name: NAME, version: '1.2.3' }] })

  // an external widget page (only fetched when the resource is a public uri-list).
  table[`GET ${EXTERNAL_PUBLIC}`] = () => ({ status: 200, contentType: 'text/html', body: opts.externalPublicBody ?? SRCDOC_CLEAN })

  return table
}

function acceptOf(init?: RequestInit): string {
  const h = init?.headers as Record<string, string> | undefined
  return h?.accept ?? '*/*'
}
function bodyOf(init?: RequestInit): string | undefined {
  return typeof init?.body === 'string' ? init.body : undefined
}

function multiFetcher(table: RouteTable): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const handler = table[`${method} ${url}`]
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    const out = handler(init)
    return new Response(out.body ?? '', { status: out.status, headers: { 'content-type': out.contentType ?? 'text/plain', ...(out.headers ?? {}) } })
  }
  return { fetcher, calls }
}

async function judge(opts: FixtureOpts = {}) {
  const { fetcher, calls } = multiFetcher(buildRoutes(opts))
  const observer = new Observer({ fetcher, delayMs: 0 })
  const bundle = await observeTarget(GOOD, observer, 42)
  const checks = runChecks(bundle)
  const score = axScoreOf(checks)
  const { grade, notes } = gradeOf(score, checks)
  return { bundle, checks, calls, score, grade, notes }
}

function verdictOf(checks: CheckResult[], id: string) {
  return checks.find((c) => c.id === id)?.verdict
}
function detailOf(checks: CheckResult[], id: string) {
  return checks.find((c) => c.id === id)?.detail ?? ''
}

const UI_IDS = [
  'mcp-ui-resource-linkage',
  'mcp-ui-self-contained',
  'mcp-ui-envelope-hygiene',
  'mcp-ui-register-parity',
  'mcp-ui-host-render',
] as const

// ---------------------------------------------------------------------------
// (a) A CONFORMANT MCP-UI target passes every readiness sub-signal.
// ---------------------------------------------------------------------------

describe('a conformant MCP-UI target passes the readiness signal', () => {
  it('proper ui:// resource + self-contained srcDoc + clean envelope + parity + host-render → all pass', async () => {
    const { checks } = await judge()
    for (const id of UI_IDS) expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('pass')
  })

  it('the readiness dimension is ADDITIVE — a clean widget does not cap the grade (stays A+)', async () => {
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

  it('an externalUrl widget on a PUBLIC https host is fetched and passes self-containment', async () => {
    const { checks, calls } = await judge({
      resourceRead: defaultResourceRead({ mimeType: 'text/uri-list', text: EXTERNAL_PUBLIC }),
    })
    expect(calls).toContain(EXTERNAL_PUBLIC)
    expect(verdictOf(checks, 'mcp-ui-resource-linkage'), detailOf(checks, 'mcp-ui-resource-linkage')).toBe('pass')
    expect(verdictOf(checks, 'mcp-ui-self-contained'), detailOf(checks, 'mcp-ui-self-contained')).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// (b) A target with NO MCP-UI is informational not-ready (does NOT tank grade).
// ---------------------------------------------------------------------------

describe('a target with no MCP-UI is informational not-ready (no over-block)', () => {
  it('every readiness sub-check SKIPs and none fails', async () => {
    const { checks } = await judge({ noUiTool: true })
    for (const id of UI_IDS) {
      expect(verdictOf(checks, id), `${id}: ${detailOf(checks, id)}`).toBe('skip')
    }
    expect(detailOf(checks, 'mcp-ui-resource-linkage')).toMatch(/no MCP-UI declared/i)
  })

  it('does not cap the grade — a non-MCP-UI target still scores 10/10 and grades A+', async () => {
    const { score, grade, checks } = await judge({ noUiTool: true })
    for (const c of checks) expect(c.verdict, `${c.id}: ${c.detail}`).not.toBe('fail')
    expect(score.points).toBe(10)
    expect(grade).toBe('A+')
  })

  it('makes NO extra MCP-UI probe calls when no tool advertises a template', async () => {
    const { calls } = await judge({ noUiTool: true })
    const bodies = calls.filter((u) => u === REMOTE)
    // only the registry pass's initialize + tools/list hit the remote — no
    // tools/call or resources/read (those only fire on an advertised template).
    expect(bodies.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// (c) Each violation grades DOWN (declares MCP-UI, breaks a sub-signal → fail).
// ---------------------------------------------------------------------------

describe('a declared-but-broken widget grades DOWN honestly', () => {
  it('remote <script> in the srcDoc → self-containment FAILs and caps the grade', async () => {
    const { checks, grade } = await judge({ resourceRead: defaultResourceRead({ text: SRCDOC_REMOTE }) })
    expect(verdictOf(checks, 'mcp-ui-self-contained')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-self-contained')).toMatch(/remote code|self-contained/i)
    expect(['C', 'D', 'F']).toContain(grade)
  })

  it('a secret in structuredContent → envelope-hygiene FAILs (HIGH) and caps the grade', async () => {
    const leaky = { apiKey: 'sk-abcdef0123456789ABCDEF', count: 3, widgets: [{ id: 'w1' }] }
    const { checks, grade } = await judge({ toolCallResult: defaultResult({ structuredContent: leaky }) })
    expect(verdictOf(checks, 'mcp-ui-envelope-hygiene')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-envelope-hygiene')).toMatch(/secret|model-visible/i)
    expect(['C', 'D', 'F']).toContain(grade)
  })

  it('a broken/missing resource it CLAIMS → resource-linkage FAILs and caps the grade', async () => {
    const { checks, grade } = await judge({ resourceRead: defaultResourceRead({ empty: true }) })
    expect(verdictOf(checks, 'mcp-ui-resource-linkage')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-resource-linkage')).toMatch(/does not resolve|no matching/i)
    expect(['C', 'D', 'F']).toContain(grade)
  })

  it('a wrong-MIME resource → resource-linkage FAILs', async () => {
    const { checks } = await judge({ resourceRead: defaultResourceRead({ mimeType: 'application/json' }) })
    expect(verdictOf(checks, 'mcp-ui-resource-linkage')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-resource-linkage')).toMatch(/not an MCP-Apps/i)
  })

  it('register divergence (_meta.ui.data contradicts structuredContent) → parity FAILs', async () => {
    const result = defaultResult({
      structuredContent: { count: 3, widgets: [{ id: 'w1' }] },
      meta: { ui: { resourceUri: TEMPLATE_URI, data: { count: 99 } } },
    })
    const { checks, grade } = await judge({ toolCallResult: result })
    expect(verdictOf(checks, 'mcp-ui-register-parity')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-register-parity')).toMatch(/diverges|divergence/i)
    expect(['C', 'D', 'F']).toContain(grade)
  })

  it('a UI tool that requires input to first-render → host-render FAILs', async () => {
    const tools = defaultToolDefs({ inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } })
    const { checks } = await judge({ tools })
    expect(verdictOf(checks, 'mcp-ui-host-render')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-host-render')).toMatch(/first-render|requires input/i)
  })

  it('a UI tool with no description/widgetDescription/annotations → host-render FAILs', async () => {
    const tools = defaultToolDefs({ description: '', _meta: { ui: { resourceUri: TEMPLATE_URI } }, annotations: {} })
    const { checks } = await judge({ tools })
    expect(verdictOf(checks, 'mcp-ui-host-render')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-host-render')).toMatch(/affordance|annotations/i)
  })

  it('a result that links NO resourceUri despite a template → linkage FAILs', async () => {
    const { checks } = await judge({ toolCallResult: defaultResult({ meta: { ui: { csp: {} } } }) })
    expect(verdictOf(checks, 'mcp-ui-resource-linkage')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-resource-linkage')).toMatch(/no _meta.ui.resourceUri|cannot be located/i)
  })

  it('a missing structuredContent → parity FAILs (widget has no agent/API twin)', async () => {
    const result = { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'hi' }], _meta: { ui: { resourceUri: TEMPLATE_URI } } } }
    const { checks } = await judge({ toolCallResult: result })
    expect(verdictOf(checks, 'mcp-ui-register-parity')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-register-parity')).toMatch(/no structuredContent|byte-consistent/i)
  })
})

// ---------------------------------------------------------------------------
// (d) SSRF — a ui:// externalUrl resolving to a private IP is REFUSED.
// ---------------------------------------------------------------------------

describe('SSRF: a private/non-https externalUrl UIResource is refused without fetching', () => {
  it('externalUrl → 169.254.169.254 is NEVER fetched and the claim is graded DOWN', async () => {
    const { checks, calls, bundle } = await judge({
      resourceRead: defaultResourceRead({ mimeType: 'text/uri-list', text: EXTERNAL_PRIVATE }),
    })
    // The private URL never left the process.
    expect(calls).not.toContain(EXTERNAL_PRIVATE)
    expect(calls.some((u) => u.includes('169.254.169.254'))).toBe(false)
    // No hostile body captured in any evidence.
    for (const ev of bundle.items) expect(ev.body ?? '').not.toContain('169.254.169.254/embed-secret')
    // The claim is graded DOWN (refused resource is not render-ready).
    expect(verdictOf(checks, 'mcp-ui-resource-linkage')).toBe('fail')
    expect(detailOf(checks, 'mcp-ui-resource-linkage')).toMatch(/SSRF|refused without fetching/i)
  })

  it('a cleartext-http public externalUrl is also refused (no cleartext)', async () => {
    const { checks, calls } = await judge({
      resourceRead: defaultResourceRead({ mimeType: 'text/uri-list', text: 'http://widgets.good.example/embed' }),
    })
    expect(calls).not.toContain('http://widgets.good.example/embed')
    expect(verdictOf(checks, 'mcp-ui-resource-linkage')).toBe('fail')
  })
})

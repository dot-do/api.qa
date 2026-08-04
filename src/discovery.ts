/**
 * Discovery — the observe phase, then a pure derivation.
 *
 * `observeTarget` performs the (polite, read-only) fetch plan and returns an
 * EvidenceBundle. `deriveDiscovery` is a PURE function bundle → DiscoveryReport:
 * everything api.qa says a target claims is re-derivable by anyone from the
 * evidence in the published report. Checks (checks.ts) are pure over the same
 * bundle — the verifier never judges anything it didn't record.
 */

import { Observer, isPubliclyRoutableSameOrigin, isPublicHttpsOffOriginAllowed } from './http.js'
import { canonicalJson, sha256Hex, sampleSeeded } from './digest.js'
import type {
  ClaimedEndpoint,
  DiscoveryReport,
  Evidence,
  EvidenceBundle,
  MiniSchema,
  SurfaceStatus,
} from './types.js'

// ---------------------------------------------------------------------------
// Roles — the evidence vocabulary shared by observe + judge
// ---------------------------------------------------------------------------

export const ROLE = {
  rootAgent: 'probe:root-as-agent',
  rootBrowser: 'probe:root-as-browser',
  /**
   * Root probed with `Accept: application/json` (ax-c7m). Closes a grader
   * BLIND-SPOT: a surface can silently ignore `Accept: application/json` and
   * hand an agent a wall of HTML. The content-negotiation check grades DOWN a
   * root that answers JSON-requesting agents with text/html; a root that has no
   * JSON representation but still returns agent-actionable non-HTML text
   * (markdown) is handled as partial credit, not a false-fail.
   */
  rootJson: 'probe:root-as-json',
  /**
   * Root probed with `Accept: text/markdown` (AXP Clause 3 / A.7 step 2): an
   * explicit markdown request must receive the markdown face.
   */
  rootMarkdown: 'probe:root-as-markdown',
  // Root probed with the wildcard Accept (*/*) PLUS browser-navigation
  // `Sec-Fetch-*` headers (Sec-Fetch-Mode: navigate, Sec-Fetch-Dest: document)
  // — the AXP A.7 step-3a client-class probe: a detected browser navigation
  // defaults to the HTML face. Detection is by Sec-Fetch, never User-Agent
  // sniffing.
  rootBrowserNav: 'probe:root-as-browser-navigate',
  // Root probed with the wildcard Accept (*/*) PLUS a known agent User-Agent
  // (AGENT_UA, from the AXP A.7.4 token list) — the A.7 step-3b client-class
  // probe: a known agent defaults to the token-cheap markdown face.
  rootAgentUa: 'probe:root-as-agent-ua',
  /**
   * A Link-rel=alternate-advertised face address of the home, fetched with a
   * CONTRADICTORY Accept header (AXP A.7 rule 1: the address wins over the
   * header). One role per face: probe:face:html | probe:face:json | probe:face:md.
   */
  face: (face: 'html' | 'json' | 'md') => `probe:face:${face}`,
  /**
   * The card-declared `probes.pricing` entry 0 (AXP A.2 Pricing Document),
   * observed in EVERY mode (not only pinned) so pure judges — notably the
   * probe-manifest check's metered-only gating of `probes.overCeiling` +
   * `monetization.probe` — can read the OBSERVED pricing `model`.
   */
  pricing: 'probe:pricing',
  llmsTxt: 'surface:llms.txt',
  agentsJson: 'surface:agents.json',
  icpJson: 'surface:icp.json',
  openapi: 'surface:openapi',
  keyless: (method: string, path: string) => `probe:endpoint:${method} ${path}`,
  /**
   * Contract-diff probe (ax-e6b.28.4): a declared GET-safe path fetched for the
   * FULL OpenAPI<->live diff (every GET-safe path, not just the seeded keyless
   * sample). A path the keyless sample already fetched is reused from its
   * `probe:endpoint:` role instead of being probed again.
   */
  contract: (method: string, path: string) => `contract:${method} ${path}`,
  /**
   * Clause-3 typed-body legibility (ax-fsg): a seeded sample of declared
   * typed-body endpoints fetched under BOTH the agent Accept (star/star) and
   * the browser Accept (text/html), so machine-legibility is verified beyond
   * the root — an API path must stay JSON, never vary into HTML by Accept.
   */
  typedBodyAgent: (path: string) => `probe:typed-body-agent ${path}`,
  typedBodyBrowser: (path: string) => `probe:typed-body-browser ${path}`,
  offer: 'probe:402-offer',
  // MCP OAuth conformance (RFC 9728 / 8414 / 7591 / 7636 / 8707). Recorded only
  // when agents.json declares an HTTP/SSE MCP interface (interfaces.mcp.url).
  mcpUnauth: 'probe:mcp:unauthenticated',
  /**
   * Unauthenticated POST `initialize` handshake (ax-q4t): a spec-legal POST-only
   * streamable-HTTP MCP server answers the unauthenticated GET with a non-2xx/
   * non-401 (e.g. 405 Method Not Allowed) yet still answers a real JSON-RPC
   * initialize over unauthenticated POST. Recorded ONLY when the GET probe gives
   * neither a clear keyless (2xx) nor a clear protected (401/403 / WWW-Authenticate)
   * signal — so the keyless-vs-protected decision (checks.ts) can see whether the
   * endpoint is a usable keyless MCP that just doesn't serve GET. SSRF-gated (the
   * mcpUrl already passed the same-origin + public-routable gate; observeMcp adds
   * its own private-host backstop).
   */
  mcpUnauthInit: 'probe:mcp:unauthenticated-initialize',
  mcpProtectedResource: 'surface:mcp:oauth-protected-resource',
  mcpAsMetadata: 'surface:mcp:oauth-authorization-server',
  /** RFC 8414 fallback well-known: /.well-known/openid-configuration. */
  mcpAsMetadataOidc: 'surface:mcp:openid-configuration',
  // Agent Auth Protocol (AAP) discovery — same-origin /.well-known/agent-
  // configuration (ax-e6b.21.1). Fixed origin-relative path, fetched always.
  agentConfiguration: 'surface:agent-configuration',
  /**
   * auth.md agent-identity probe: the identity_endpoint declared in the AS
   * metadata's `agent_auth` block, probed (metadata-derived, AS-origin gated)
   * only to confirm it RESOLVES. Advertisement/shape-grade — no ID-JAG mint.
   */
  agentIdentity: 'surface:agent-identity',
  // ── MCP-registry publishability (ax-e6b.38) ──────────────────────────────
  /** The MCP registry manifest (server.json) at the well-known / declared path. */
  mcpServerJson: 'surface:mcp:server-json',
  /** LIVE MCP remote handshake: initialize (POST) to server.json remotes[0].url. */
  mcpRemoteInit: 'probe:mcp:remote-initialize',
  /** LIVE MCP remote handshake: tools/list (POST), echoing the mcp-session-id. */
  mcpRemoteToolsList: 'probe:mcp:remote-tools-list',
  /** Domain-ownership well-known: /.well-known/mcp-registry-auth (v=MCPv1). */
  mcpRegistryAuthWellKnown: 'surface:mcp:registry-auth-well-known',
  /** DNS-over-HTTPS TXT lookup of the reverse-DNS namespace domain (ownership). */
  mcpRegistryDnsTxt: 'probe:mcp:registry-dns-txt',
  /** OPTIONAL/informational: presence in the official MCP registry, by name. */
  mcpRegistryPresence: 'probe:mcp:registry-presence',
  // ── MCP-UI / streaming-component readiness (ax-odg, ADR-0022) ─────────────
  /** tools/call (POST) on a UI-bearing tool — the result carries the ui:// link. */
  mcpUiToolsCall: 'probe:mcp:ui-tools-call',
  /** resources/read (POST) of the declared ui:// UIResource (srcDoc + MIME). */
  mcpUiResourceRead: 'probe:mcp:ui-resource-read',
  /** GET of an externalUrl UIResource target (SSRF-gated; only when public-https). */
  mcpUiExternalUrl: 'probe:mcp:ui-external-url',
  // ── AI SDK 5 UI-message-stream readiness (ax-rx1) ─────────────────────────
  /**
   * GET of the target-DECLARED AI SDK 5 UI-message-stream face
   * (interfaces.uiMessageStream.url). Same-origin SSRF-gated; read capped as
   * SSE text. Recorded ONLY when a target declares the face — a target with no
   * uiMessageStream interface records nothing, so the ui-stream-* checks SKIP.
   */
  uiMessageStream: 'probe:ui-message-stream',
  /**
   * GET of the declared JSON/MCP twin (interfaces.uiMessageStream.twin) — the
   * canonical projection the stream's tool-output MUST be consistent with.
   * Same-origin SSRF-gated. Absent ⇒ the parity check SKIPs (no twin to diff).
   */
  uiStreamTwin: 'probe:ui-message-stream-twin',
} as const

export function findEvidence(bundle: EvidenceBundle, role: string): Evidence | undefined {
  return bundle.items.find((e) => e.role === role)
}

// ---------------------------------------------------------------------------
// Content-negotiation vocabulary (AXP Clause 3 / Appendix A.7)
// ---------------------------------------------------------------------------

/**
 * The User-Agent api.qa presents for the agent-class conneg probe. Drawn from
 * the AXP Appendix A.7.4 MUST-minimum token list (`claude-user`), which is what
 * makes the markdown-for-agents default decidable from outside.
 */
export const AGENT_UA = 'Claude-User/1.0 (+https://api.qa)'

/** The three AXP faces and their media types (Appendix A.7.1). */
export type FaceName = 'html' | 'json' | 'md'

/** Face named by a media type string (a Link `type` param or a Content-Type). */
export function faceOfMediaType(mediaType: string | null | undefined): FaceName | undefined {
  if (!mediaType) return undefined
  const t = mediaType.split(';')[0]!.trim().toLowerCase()
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'html'
  if (t === 'application/json' || t === 'application/ld+json' || t.endsWith('+json')) return 'json'
  if (t === 'text/markdown') return 'md'
  return undefined
}

export interface LinkAlternate {
  url: string
  rel?: string
  type?: string
}

/**
 * Parse an HTTP `Link` header into its entries (RFC 8288, the subset the
 * conneg checks read: uri-reference + rel + type params). Pure, total: a
 * malformed header yields the entries that do parse, never a throw. Entry
 * split is on commas that precede a `<` (URLs and quoted params may not
 * contain a bare `<`, so this is unambiguous for well-formed headers).
 */
export function parseLinkHeader(header: string | null | undefined): LinkAlternate[] {
  if (!header) return []
  const out: LinkAlternate[] = []
  for (const part of header.split(/,(?=[^>]*<)/)) {
    const m = /^\s*<([^>]*)>\s*((?:;[^;]*)*)$/.exec(part)
    if (!m) continue
    const entry: LinkAlternate = { url: m[1]! }
    for (const param of m[2]!.split(';')) {
      const pm = /^\s*([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|([^\s";]+))\s*$/.exec(param)
      if (!pm) continue
      const name = pm[1]!.toLowerCase()
      const value = (pm[2] ?? pm[3] ?? '').toLowerCase()
      if (name === 'rel') entry.rel = value
      else if (name === 'type') entry.type = value
    }
    out.push(entry)
  }
  return out
}

/**
 * The `rel="alternate"` face siblings advertised by an evidence item's Link
 * header, keyed by face. First advertisement per face wins. URLs are resolved
 * against the evidence's own URL (relative Link targets are the common case).
 */
export function faceAlternatesOf(ev: Evidence | undefined): Partial<Record<FaceName, string>> {
  const out: Partial<Record<FaceName, string>> = {}
  if (!ev) return out
  for (const alt of parseLinkHeader(ev.headers['link'])) {
    if (alt.rel !== undefined && !alt.rel.split(/\s+/).includes('alternate')) continue
    if (alt.rel === undefined) continue
    const face = faceOfMediaType(alt.type)
    if (!face || out[face] !== undefined) continue
    try { out[face] = new URL(alt.url, ev.url).toString() } catch { /* unresolvable target contributes nothing */ }
  }
  return out
}

export function parseJsonBody(ev: Evidence | undefined): unknown | undefined {
  if (!ev || ev.status === null || ev.body === null) return undefined
  try {
    return JSON.parse(ev.body)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Claim parsers (pure)
// ---------------------------------------------------------------------------

export interface AgentsClaims {
  name?: string
  description?: string
  endpoints: ClaimedEndpoint[]
  mcp?: { transport?: string; command?: string; url?: string; tools?: string[] }
  offers?: Array<{ id?: string; title?: string; price?: unknown }>
  offerProbe?: { method: string; url: string }
  /**
   * Self-declared probe manifest (top-level `probes`): named channels of probe
   * refs the target invites a pinned verifier to fire. Single objects
   * normalize to one-element arrays; entries without a string `url` drop.
   */
  probes?: Record<string, Array<{ method: string; url: string; param?: string }>>
  attestation?: unknown
  openapiUrl?: string
  /**
   * Declared location of the card's llms.txt sibling (top-level `llms` /
   * `llmsUrl`, or `links.llms`) — read by the card-interfaces-linked check
   * (AXP Clause 6 mutual cross-linking). Absolutized.
   */
  llmsUrl?: string
  /**
   * Declared location of the MCP registry manifest (server.json), if the card
   * advertises one (top-level `serverJson`/`server_json`, or
   * interfaces.mcp.serverJson). Absolutized; SSRF-gated same-origin at fetch.
   * Absent => api.qa probes the default well-known `/.well-known/mcp/server.json`.
   */
  serverJsonUrl?: string
  /**
   * The target-declared AI SDK 5 UI-message-stream face
   * (interfaces.uiMessageStream). `url` is the SSE endpoint api.qa observes;
   * `twin` is an optional JSON projection the stream's tool-output is diffed
   * against. Both absolutized and SSRF-gated same-origin at fetch. Absent ⇒
   * the target exposes no UI-message-stream face and the ui-stream-* checks SKIP.
   */
  uiStream?: { url?: string; twin?: string }
}

export function parseAgentsJson(doc: unknown, origin: string): AgentsClaims {
  const out: AgentsClaims = { endpoints: [] }
  if (!doc || typeof doc !== 'object') return out
  const d = doc as Record<string, unknown>
  if (typeof d.name === 'string') out.name = d.name
  if (typeof d.description === 'string') out.description = d.description

  const interfaces = (d.interfaces ?? {}) as Record<string, unknown>
  const http = (interfaces.http ?? {}) as Record<string, unknown>
  for (const entry of Object.values(http)) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>
      if (typeof e.url === 'string') {
        out.endpoints.push({
          method: typeof e.method === 'string' ? e.method.toUpperCase() : 'GET',
          url: absolutize(e.url, origin),
          auth: typeof e.auth === 'string' ? e.auth : undefined,
          source: 'agents.json',
        })
      }
    }
  }
  const mcp = interfaces.mcp as Record<string, unknown> | undefined
  if (mcp && typeof mcp === 'object') {
    // interfaces.mcp.url is CARD-DERIVED and steers OAuth well-known fetches, so
    // absolutize it (like every other card url) — a relative "/mcp" resolves
    // same-origin; an absolute attacker url is preserved so the same-origin gate
    // downstream can DROP it. stdio-only MCP has no url and stays undefined.
    const mcpRawUrl = str(mcp.url)
    out.mcp = {
      transport: str(mcp.transport),
      command: str(mcp.command),
      url: mcpRawUrl !== undefined ? absolutize(mcpRawUrl, origin) : undefined,
      tools: Array.isArray(mcp.tools) ? mcp.tools.filter((t): t is string => typeof t === 'string') : undefined,
    }
    const mcpServerJson = str(mcp.serverJson) ?? str(mcp.server_json)
    if (mcpServerJson !== undefined) out.serverJsonUrl = absolutize(mcpServerJson, origin)
  }
  // UI-message-stream face (ax-rx1): interfaces.uiMessageStream.{url,twin}.
  // Card-derived — absolutize both (a relative "/api/chat" resolves same-origin;
  // an absolute attacker url is preserved so the same-origin gate downstream can
  // DROP it, exactly like interfaces.mcp.url). Present ⇒ the target DECLARES an
  // AI SDK 5 UI-message-stream face and the ui-stream-* checks are ARMED.
  const uiStream = interfaces.uiMessageStream as Record<string, unknown> | undefined
  if (uiStream && typeof uiStream === 'object' && !Array.isArray(uiStream)) {
    const url = str(uiStream.url)
    const twin = str(uiStream.twin)
    if (url !== undefined || twin !== undefined) {
      out.uiStream = {
        url: url !== undefined ? absolutize(url, origin) : undefined,
        twin: twin !== undefined ? absolutize(twin, origin) : undefined,
      }
    }
  }

  // Top-level server.json pointer (card-derived; absolutized, SSRF-gated at fetch).
  const declaredServerJson = str(d.serverJson) ?? str(d.server_json)
  if (out.serverJsonUrl === undefined && declaredServerJson !== undefined) {
    out.serverJsonUrl = absolutize(declaredServerJson, origin)
  }

  const monetization = d.monetization as Record<string, unknown> | undefined
  if (monetization && Array.isArray(monetization.offers)) {
    out.offers = monetization.offers as AgentsClaims['offers']
  }
  const probe = monetization?.probe as Record<string, unknown> | undefined
  if (probe && typeof probe.url === 'string') {
    // AXP Appendix A.5: monetization.probe MUST be a same-origin GET. The card
    // is adversarial input — an off-origin URL, a non-GET method, or a
    // private/metadata address (169.254.169.254, 10.x, 127.x, ::1, …) would
    // steer the verifier into an SSRF. Mirror the probes.* rule EXACTLY and
    // DROP any violating probe: it is never stored as offerProbe, so it is
    // never fetched. checks.ts still FAILS the card for the dropped probe.
    const method = (str(probe.method) ?? 'GET').toUpperCase()
    const url = absolutize(probe.url, origin)
    if (method === 'GET' && isPubliclyRoutableSameOrigin(url, origin)) {
      out.offerProbe = { method, url }
    }
  }

  // Probe manifest — the card-declared channel a pinned verifier resolves
  // `kind:'probe'` requirements against (mirrors the monetization.probe shape).
  const probes = d.probes as Record<string, unknown> | undefined
  if (probes && typeof probes === 'object' && !Array.isArray(probes)) {
    const out2: NonNullable<AgentsClaims['probes']> = {}
    for (const [key, value] of Object.entries(probes)) {
      const refs = (Array.isArray(value) ? value : [value])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).url === 'string')
        .map((r) => ({
          method: (str(r.method) ?? 'GET').toUpperCase(),
          url: absolutize(r.url as string, origin),
          param: str(r.param),
        }))
      if (refs.length) out2[key] = refs
    }
    if (Object.keys(out2).length) out.probes = out2
  }

  if (d.attestationLadder !== undefined) out.attestation = d.attestationLadder
  else if (d.attestation !== undefined) out.attestation = d.attestation

  for (const key of ['openapi', 'openapiUrl'] as const) {
    if (typeof d[key] === 'string') out.openapiUrl = absolutize(d[key] as string, origin)
  }
  const surfaces = d.surfaces as Record<string, unknown> | undefined
  if (!out.openapiUrl && surfaces && typeof surfaces.openapi === 'string') {
    out.openapiUrl = absolutize(surfaces.openapi, origin)
  }
  // `links` block (the AXP normative card shape carries links.openapi /
  // links.llms alongside the top-level members) — a fallback source for both.
  const links = d.links as Record<string, unknown> | undefined
  if (!out.openapiUrl && links && typeof links.openapi === 'string') {
    out.openapiUrl = absolutize(links.openapi, origin)
  }
  for (const cand of [d.llms, d.llmsUrl, links?.llms, surfaces?.llms]) {
    if (out.llmsUrl === undefined && typeof cand === 'string') out.llmsUrl = absolutize(cand, origin)
  }
  return out
}

// ---------------------------------------------------------------------------
// auth.md agent-identity claims (pure) — the `agent_auth` block an RFC 8414
// authorization server carries to advertise itself as an agent-identity
// provider. Shared by observe (to know which identity_endpoint to probe) and
// judge (to grade the advertisement). Endpoints stay as raw declared strings —
// the check applies the non-empty-absolute-https validation, mirroring the
// MCP-OAuth members.
// ---------------------------------------------------------------------------

export interface AgentAuthClaims {
  identity_endpoint?: string
  claim_endpoint?: string
  events_endpoint?: string
  /** The raw agent_auth object, so a judge can scan for ID-JAG advertisement. */
  raw: Record<string, unknown>
  /**
   * True when the `agent_auth` key is PRESENT but not a plain object (a JSON
   * array / string / number / null). The key exists, so the provider claims to
   * be an agent-identity provider — the block is defective, not absent — and the
   * judge must FAIL it, never collapse to the "absent => SKIP" path. Absence of
   * the key (or of the AS metadata) still returns `undefined` => SKIP.
   */
  defective?: boolean
}

/**
 * The `agent_auth` block off parsed RFC 8414 AS metadata, or undefined when the
 * metadata carries no such block (=> not an agent-identity provider => the
 * check SKIPs). A present-but-defective block returns a value (the check then
 * FAILS the specific defect), so "absent" and "malformed" never collapse.
 */
export function parseAgentAuth(asMeta: unknown): AgentAuthClaims | undefined {
  if (!asMeta || typeof asMeta !== 'object') return undefined
  const block = (asMeta as Record<string, unknown>).agent_auth
  // Key ABSENT (metadata carries no agent_auth at all) => not an agent-identity
  // provider => SKIP.
  if (!('agent_auth' in (asMeta as Record<string, unknown>)) || block === undefined) return undefined
  // Key PRESENT but not a plain object — a JSON array / string / number / null.
  // The provider claims the block yet its shape is defective: return a sentinel
  // so the judge FAILs it (present-but-defective) rather than leaking to SKIP.
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return { raw: {}, defective: true }
  }
  const b = block as Record<string, unknown>
  return {
    identity_endpoint: str(b.identity_endpoint),
    claim_endpoint: str(b.claim_endpoint),
    events_endpoint: str(b.events_endpoint),
    raw: b,
  }
}

// ---------------------------------------------------------------------------
// MCP registry manifest (server.json) claims (pure) — ax-e6b.38
// ---------------------------------------------------------------------------

export interface ServerJsonRemote {
  /** 'streamable-http' | 'sse' (registry transport vocabulary). */
  type?: string
  url?: string
}

export interface ServerJsonClaims {
  name?: string
  version?: string
  title?: string
  description?: string
  websiteUrl?: string
  repository?: { url?: string; source?: string }
  remotes: ServerJsonRemote[]
  /** The raw parsed doc, so a judge can validateSchema over it. */
  raw: Record<string, unknown>
}

/**
 * Parse a fetched server.json (the MCP registry manifest) into the fields the
 * publishability judge reads. Pure. A non-object doc yields undefined (=> the
 * dimension SKIPs — the target is not claiming registry publishability).
 */
export function parseServerJson(doc: unknown): ServerJsonClaims | undefined {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined
  const d = doc as Record<string, unknown>
  const repoRaw = d.repository && typeof d.repository === 'object' && !Array.isArray(d.repository)
    ? (d.repository as Record<string, unknown>)
    : undefined
  const remotes: ServerJsonRemote[] = Array.isArray(d.remotes)
    ? (d.remotes as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
        .map((r) => ({ type: str(r.type), url: str(r.url) }))
    : []
  return {
    name: str(d.name),
    version: str(d.version),
    title: str(d.title),
    description: str(d.description),
    websiteUrl: str(d.websiteUrl),
    repository: repoRaw ? { url: str(repoRaw.url), source: str(repoRaw.source) } : undefined,
    remotes,
    raw: d,
  }
}

/**
 * The reverse-DNS namespace shape of a server.json `name`: two-or-more
 * reverse-DNS labels, a single `/`, then the server segment — e.g.
 * `io.github.owner/server` or `com.example/server`. Returns the split parts, or
 * undefined when the name is not a valid reverse-DNS namespace.
 */
export function parseReverseDnsName(name: string | undefined):
  | { namespace: string; server: string; labels: string[] }
  | undefined {
  if (typeof name !== 'string') return undefined
  const slash = name.indexOf('/')
  if (slash <= 0 || slash === name.length - 1) return undefined
  const namespace = name.slice(0, slash)
  const server = name.slice(slash + 1)
  const labels = namespace.split('.')
  if (labels.length < 2) return undefined
  const labelRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
  if (!labels.every((l) => labelRe.test(l))) return undefined
  if (!/^[A-Za-z0-9._-]+$/.test(server)) return undefined
  return { namespace, server, labels }
}

/**
 * The DNS domain a reverse-DNS namespace must prove ownership of, by reversing
 * the namespace labels: `com.example` => `example.com`, `com.example.api` =>
 * `api.example.com`. Undefined for a malformed name. The special GitHub
 * namespace (`io.github.<owner>`) has no DNS-provable domain the target owns —
 * ownership there is GitHub-account-backed — so callers must special-case it.
 */
export function namespaceDomain(name: string | undefined): string | undefined {
  const parsed = parseReverseDnsName(name)
  if (!parsed) return undefined
  return [...parsed.labels].reverse().join('.').toLowerCase()
}

/** True when the namespace is the GitHub-account-backed `io.github.<owner>` form. */
export function isGithubNamespace(name: string | undefined): boolean {
  const p = parseReverseDnsName(name)
  return !!p && p.labels.length >= 3 && p.labels[0]!.toLowerCase() === 'io' && p.labels[1]!.toLowerCase() === 'github'
}

/** The `<owner>` segment of an `io.github.<owner>` namespace, lowercased. */
export function githubNamespaceOwner(name: string | undefined): string | undefined {
  const p = parseReverseDnsName(name)
  if (!p || !isGithubNamespace(name)) return undefined
  return p.labels[2]?.toLowerCase()
}

export interface OpenapiSummary {
  valid: boolean
  /** GET operations with no required parameters — keyless-probe candidates. */
  probeCandidates: Array<{ path: string; responseSchema?: MiniSchema }>
  pathCount: number
  /** The declared spec version (`openapi:` or `swagger:` member), verbatim. */
  version?: string
  /** Count of HTTP operations (method keys) declared across all paths. */
  operationCount: number
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

export function parseOpenapi(doc: unknown): OpenapiSummary {
  if (!doc || typeof doc !== 'object') return { valid: false, probeCandidates: [], pathCount: 0, operationCount: 0 }
  const d = doc as Record<string, unknown>
  const version = str(d.openapi) ?? str(d.swagger)
  const paths = d.paths as Record<string, unknown> | undefined
  if (!version || !paths || typeof paths !== 'object') {
    const out: OpenapiSummary = { valid: false, probeCandidates: [], pathCount: 0, operationCount: 0 }
    if (version) out.version = version
    return out
  }
  const candidates: OpenapiSummary['probeCandidates'] = []
  let operationCount = 0
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    for (const m of HTTP_METHODS) {
      if (it[m] && typeof it[m] === 'object') operationCount++
    }
    const get = it.get as Record<string, unknown> | undefined
    if (!get) continue
    if (path.includes('{')) continue // path params → not probeable without values
    const params = Array.isArray(get.parameters) ? (get.parameters as Array<Record<string, unknown>>) : []
    if (params.some((p) => p.required === true)) continue
    if (get.security !== undefined && Array.isArray(get.security) && get.security.length > 0) continue
    candidates.push({ path, responseSchema: extractResponseSchema(get, d) })
  }
  return {
    valid: true,
    version,
    probeCandidates: candidates.sort((a, b) => a.path.localeCompare(b.path)),
    pathCount: Object.keys(paths).length,
    operationCount,
  }
}

function extractResponseSchema(op: Record<string, unknown>, root: Record<string, unknown>): MiniSchema | undefined {
  const responses = op.responses as Record<string, unknown> | undefined
  const ok = responses?.['200'] as Record<string, unknown> | undefined
  const content = ok?.content as Record<string, unknown> | undefined
  const json = content?.['application/json'] as Record<string, unknown> | undefined
  let schema = json?.schema as Record<string, unknown> | undefined
  if (!schema) return undefined
  // one-level $ref resolution into components.schemas
  const ref = schema.$ref
  if (typeof ref === 'string') {
    const m = ref.match(/^#\/components\/schemas\/(.+)$/)
    const components = root.components as Record<string, unknown> | undefined
    const schemas = components?.schemas as Record<string, unknown> | undefined
    if (m && schemas && m[1] && schemas[m[1]]) schema = schemas[m[1]] as Record<string, unknown>
    else return undefined
  }
  return schema as MiniSchema
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// ---------------------------------------------------------------------------
// MCP OAuth well-known helpers (pure) — shared by observe + judge
// ---------------------------------------------------------------------------

/**
 * The well-known URL at a base's ORIGIN, e.g. wellKnownAt('https://h/mcp',
 * 'oauth-protected-resource') => 'https://h/.well-known/oauth-protected-resource'.
 * RFC 9728 / 8414 anchor discovery documents at the origin root. Returns
 * undefined for an unparseable base (the caller then fetches nothing).
 */
export function wellKnownAt(base: string, name: string): string | undefined {
  try {
    return `${new URL(base).origin}/.well-known/${name}`
  } catch {
    return undefined
  }
}

/**
 * The first entry of RFC 9728 `authorization_servers[]` from parsed
 * protected-resource metadata, or undefined. The chase is DELIBERATELY bounded
 * to ONE declared AS — never an arbitrary walk of the whole array (SSRF: each
 * extra hop is another attacker-chosen fetch).
 */
export function firstAuthorizationServer(protectedResource: unknown): string | undefined {
  if (!protectedResource || typeof protectedResource !== 'object') return undefined
  const arr = (protectedResource as Record<string, unknown>).authorization_servers
  if (!Array.isArray(arr) || arr.length === 0) return undefined
  return typeof arr[0] === 'string' ? arr[0] : undefined
}

function absolutize(url: string, origin: string): string {
  try {
    return new URL(url, origin).toString()
  } catch {
    return url
  }
}

// The RFC 8414 AS-metadata top-level members the judge (checks.ts) actually
// reads: issuer/authorization_endpoint/token_endpoint (mcp-oauth-as-metadata),
// code_challenge_methods_supported (mcp-pkce), registration_endpoint
// (mcp-oauth-dcr), subject_token_types_supported (ID-JAG AS scan). Everything
// else in the off-origin body is unjudged and must not be retained.
const AS_METADATA_KEEP = [
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'code_challenge_methods_supported',
  'registration_endpoint',
  'subject_token_types_supported',
] as const

// The agent_auth sub-keys the judge reads: identity/claim/events endpoints
// (parseAgentAuth) plus the accepted-subject-token / assertion-type fields the
// ID-JAG scan (advertisesIdJag) inspects. Everything else in the block is
// unjudged reflection.
const AGENT_AUTH_KEEP = [
  'identity_endpoint',
  'claim_endpoint',
  'events_endpoint',
  'subject_token_types',
  'subject_token_types_supported',
  'accepted_assertion_types',
  'assertion_types',
] as const

/**
 * Scrub the `agent_auth` block down to the judged sub-keys. A present-but-not-an-
 * object block (JSON array/string/number/null) is the DEFECTIVE case the judge
 * FAILs; collapse it to `null` so that "present and not an object" signal is
 * preserved WITHOUT retaining the verbatim (possibly large/attacker-chosen)
 * value. A plain object keeps only the judged sub-keys.
 */
function scrubAgentAuth(block: unknown): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null
  const src = block as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const k of AGENT_AUTH_KEEP) if (k in src) kept[k] = src[k]
  return kept
}

/**
 * AS-metadata evidence scrub (ax-2ck): the `authorization_servers[0]` AS-metadata
 * fetch is the ONE off-origin GET api.qa performs (a delegated authorization
 * server MAY live off the target's origin — the `isPublicHttpsOffOriginAllowed`
 * hole). Its raw response BODY would otherwise be retained VERBATIM in the
 * publicly-served evidence bundle — a bounded reflection primitive against an
 * arbitrary public host. Replace the stored body with ONLY the RFC 8414 /
 * agent_auth fields the judge parses, so the bundle carries the parsed contract,
 * never the attacker-chosen off-origin body.
 *
 * VERDICT-PRESERVING: every field checks.ts judges is kept, and every
 * presence/absence/defective distinction parseAgentAuth relies on is preserved.
 * A body that is not a JSON object carries nothing the judge reads (parseJsonBody
 * would return undefined either way), so it becomes `null` — killing the
 * reflection without changing any verdict. Mutates the Evidence in place (the
 * same object held in `observer.items`), before the bundle digest is taken.
 */
function scrubAsMetadataEvidence(ev: Evidence | undefined): void {
  if (!ev || ev.body === null) return
  let parsed: unknown
  try { parsed = JSON.parse(ev.body) } catch { ev.body = null; return }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { ev.body = null; return }
  const src = parsed as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const k of AS_METADATA_KEEP) if (k in src) kept[k] = src[k]
  // Preserve agent_auth's presence + shape (scrubbed) so parseAgentAuth keeps its
  // absent→SKIP / defective→FAIL / object→judge distinction and the ID-JAG scan.
  if ('agent_auth' in src) kept.agent_auth = scrubAgentAuth(src.agent_auth)
  ev.body = JSON.stringify(kept)
}

// ---------------------------------------------------------------------------
// Observe phase
// ---------------------------------------------------------------------------

export const MAX_KEYLESS_PROBES = 3

/**
 * Upper bound on requests the contract-diff pass (step 5, below) will itself
 * fire, independent of however much of the shared politeness budget happens
 * to remain. This is the explicit reserve for the fixed high-value probes
 * (402-offer, MCP-OAuth chain, AAP agent-configuration) that all run BEFORE
 * this pass: even in the worst case where every one of them fires (up to ~17
 * requests across steps 1–4 of a default 24-request budget), this cap still
 * leaves the contract pass real headroom, and guarantees it can never by
 * itself account for the whole budget. An endpoint-rich target beyond this
 * cap has its remaining declared GET-safe paths reported as UNPROBED by the
 * contract judge (contract.ts) — never as a violation.
 */
export const MAX_CONTRACT_PROBES = 8

// ---------------------------------------------------------------------------
// MCP-registry publishability observe (ax-e6b.38)
// ---------------------------------------------------------------------------

/** Default well-known location api.qa probes for the MCP registry manifest. */
export const DEFAULT_SERVER_JSON_PATH = '/.well-known/mcp/server.json'
/** The domain-ownership HTTPS proof the registry checks (v=MCPv1; k=…; p=…). */
export const REGISTRY_AUTH_WELL_KNOWN_PATH = '/.well-known/mcp-registry-auth'
/** A fixed, trusted public DNS-over-HTTPS resolver (not target-controlled). */
export const DOH_RESOLVER = 'https://dns.google/resolve'
/** The official MCP registry base (informational presence lookup). */
export const MCP_REGISTRY_BASE = 'https://registry.modelcontextprotocol.io'

/** The MCP `initialize` JSON-RPC request the live-remote handshake sends. */
function mcpInitializeRequest(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'api.qa', version: '0.1.0' },
    },
  }
}

/** The MCP `tools/list` JSON-RPC request (echoing the initialize session id). */
function mcpToolsListRequest(): unknown {
  return { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
}

/**
 * Observe the MCP-registry publishability surfaces (ax-e6b.38). Runs BEFORE the
 * unbounded contract-diff pass so its fixed, high-value probes reserve their
 * share of the shared politeness budget (same ordering rationale as the
 * 402-offer + MCP-OAuth probes).
 *
 * SSRF: every fetch is gated. server.json is same-origin (default well-known
 * path, or a card-declared server.json url re-gated same-origin). The
 * domain-ownership well-known and the DNS-TXT proof are DELIBERATELY fetched/
 * resolved at the reversed NAMESPACE DOMAIN, not the scanned origin (see the
 * comment at call site 3, below) — that domain is frequently off-origin from
 * the target, so both use the same NARROW public-https off-origin allowance
 * (https, public host, no private/metadata IP) as the RFC 9728 authorization
 * server. The MCP remote url (from server.json remotes[0]) may also
 * legitimately be hosted off-origin, using the same allowance — and
 * observeMcp never follows a redirect. The DoH resolver + registry base are
 * FIXED trusted public hosts, still gated public-https. Nothing here
 * introduces an un-gated fetch.
 */
async function observeMcpRegistry(origin: string, observer: Observer): Promise<void> {
  // Re-parse the card from the already-recorded agents.json evidence (no refetch).
  const agentsEv = findEvidence({ target: origin, fetchedAt: '', seed: 0, items: observer.items }, ROLE.agentsJson)
  const agents = parseAgentsJson(parseJsonBody(agentsEv), origin)

  // 1. server.json — the registry manifest. Declared url (re-gated same-origin)
  //    or the default same-origin well-known. A card-declared off-origin/private
  //    server.json url is DROPPED (never fetched); the default well-known is then
  //    NOT used as a fallback, so a hostile declaration fails closed (mirrors the
  //    openapi url posture) rather than silently succeeding at the default path.
  let serverJsonUrl: string | undefined
  if (agents.serverJsonUrl !== undefined) {
    serverJsonUrl = isPubliclyRoutableSameOrigin(agents.serverJsonUrl, origin) ? agents.serverJsonUrl : undefined
    if (serverJsonUrl === undefined) return // hostile declared url — fail closed, do not probe further
  } else {
    serverJsonUrl = `${origin}${DEFAULT_SERVER_JSON_PATH}`
  }
  if (!isPubliclyRoutableSameOrigin(serverJsonUrl, origin)) return
  const sjEv = await observer.observe(ROLE.mcpServerJson, serverJsonUrl, { accept: 'application/json' })
  const server = parseServerJson(parseJsonBody(sjEv))
  // No parseable server.json => the target is not claiming registry
  // publishability => the whole dimension SKIPs (no further probes).
  if (!server) return

  // 2. LIVE MCP remote resolution — connect to remotes[0] over http and perform
  //    the initialize -> tools/list handshake. Remote url uses the narrow
  //    public-https off-origin allowance; observeMcp adds the private-host
  //    backstop and never follows a redirect.
  const remote = server.remotes.find((r) => typeof r.url === 'string' && r.url.length > 0)
  if (remote?.url && isPublicHttpsOffOriginAllowed(remote.url)) {
    const initEv = await observer.observeMcp(ROLE.mcpRemoteInit, remote.url, mcpInitializeRequest())
    // Only follow up with tools/list when initialize genuinely resolved (2xx).
    // A 401/403 is 'reachable + protected' — the judge treats it as PASS and we
    // do not (cannot) list tools. A dead/redirect/5xx remote => no tools/list.
    if (initEv.status !== null && initEv.status >= 200 && initEv.status < 300) {
      const sid = initEv.headers['mcp-session-id']
      const extra: Record<string, string> = sid ? { 'mcp-session-id': sid } : {}
      await observer.observeMcp(ROLE.mcpRemoteToolsList, remote.url, mcpToolsListRequest(), extra)
    }
  }

  // 3. Domain-ownership provability — for a CUSTOM-DOMAIN namespace
  //    (com.example/server ⇒ domain example.com), both proofs MUST be bound to
  //    the reversed NAMESPACE DOMAIN, never to the scanned target's own origin.
  //    Fetching (or resolving) at the target's own origin would let ANY target
  //    forge ownership of ANY namespace it can merely spell in server.json —
  //    the origin is exactly what's under adversarial control. So:
  //      - DNS-TXT is resolved for the namespace domain (already correct: DoH
  //        `name=` is the domain, not the origin's host);
  //      - the HTTPS well-known is now fetched at
  //        `https://<namespaceDomain>/.well-known/mcp-registry-auth` — via the
  //        narrow public-https OFF-ORIGIN allowance (the same one the RFC 9728
  //        authorization server and the DoH/registry lookups use) — NOT at
  //        `${origin}/.well-known/...`. When the namespace domain happens to
  //        equal the scanned origin's own host (the common self-hosting case),
  //        this resolves to the identical URL the origin fetch used to hit, so
  //        the honest case is unaffected; a target whose origin is NOT the
  //        namespace domain can no longer self-serve a proof for a domain it
  //        does not control (the judge additionally re-checks the fetched URL's
  //        hostname against the namespace domain — belt and suspenders).
  //
  //    The GitHub-account-backed `io.github.<owner>` namespace has no DNS-
  //    provable domain — a third party cannot mint a domain proof for it, and
  //    manifest-internal consistency (name vs. repository.url) is NOT an
  //    ownership proof (both are target-authored). Its ownership is graded
  //    ONLY from out-of-band registry presence (step 4, below) — nothing is
  //    fetched here for it.
  if (!isGithubNamespace(server.name)) {
    const domain = namespaceDomain(server.name)
    if (domain && /^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain)) {
      const dohUrl = `${DOH_RESOLVER}?name=${encodeURIComponent(domain)}&type=TXT`
      if (isPublicHttpsOffOriginAllowed(dohUrl)) {
        await observer.observe(ROLE.mcpRegistryDnsTxt, dohUrl, { accept: 'application/dns-json' })
      }
      const authWellKnownUrl = `https://${domain}${REGISTRY_AUTH_WELL_KNOWN_PATH}`
      if (isPublicHttpsOffOriginAllowed(authWellKnownUrl)) {
        await observer.observe(ROLE.mcpRegistryAuthWellKnown, authWellKnownUrl, { accept: 'text/plain' })
      }
    }
  }

  // 4. OPTIONAL/informational — is the server actually present in the official
  //    registry, by name? Never gates the grade (a pass or a skip, never a fail).
  if (typeof server.name === 'string' && server.name.length > 0 && parseReverseDnsName(server.name)) {
    const presenceUrl = `${MCP_REGISTRY_BASE}/v0/servers?search=${encodeURIComponent(server.name)}`
    if (isPublicHttpsOffOriginAllowed(presenceUrl)) {
      await observer.observe(ROLE.mcpRegistryPresence, presenceUrl, { accept: 'application/json' })
    }
  }
}

// ---------------------------------------------------------------------------
// MCP-UI / streaming-component readiness (ax-odg, ADR-0022)
// ---------------------------------------------------------------------------

/**
 * The MCP Apps (SEP-1865) UIResource MIME profile. A `resources/read` of a
 * `ui://` template returns HTML under this profile so the host renders it in a
 * sandboxed iframe. We ALSO accept the three MCP-UI content types that predate
 * (and fold into) the profile, so a target on either spelling is recognized.
 */
export const MCP_APP_MIME = 'text/html;profile=mcp-app'

/**
 * True when `mime` is a recognized MCP-UI / MCP-Apps UIResource content type.
 *
 * Requires the MCP-Apps PROFILE (`text/html;profile=mcp-app`) or an EXPLICIT
 * MCP-UI content type (`text/uri-list` for externalUrl, `application/vnd.mcp-ui.*`
 * for rawHtml/remote-dom). It deliberately does NOT accept a BARE `text/html`
 * (or `text/html;charset=…`): a plain HTML body is what every ordinary web page
 * serves, so accepting it would let a non-UIResource pose as a rendered widget.
 * The host only sandboxes what it recognizes as a UIResource, so the profile is
 * the actual boundary.
 */
export function isMcpUiMime(mime: string | undefined | null): boolean {
  if (typeof mime !== 'string') return false
  const m = mime.toLowerCase().replace(/\s+/g, '').replace(/"/g, '')
  return (
    m.startsWith('text/html;profile=mcp-app') ||
    m.startsWith('text/uri-list') ||
    m.startsWith('application/vnd.mcp-ui.')
  )
}

/**
 * Parse a JSON-RPC message out of an MCP POST body, tolerating BOTH plain
 * `application/json` and SSE (`text/event-stream`) framing where the JSON rides
 * on `data:` lines. Pure. Shared by the MCP-UI observe (here) and the judges
 * (checks.ts). Mirrors the SSE tolerance the registry-live judge already has.
 */
export function parseJsonRpcMessage(ev: Evidence | undefined): Record<string, unknown> | undefined {
  if (!ev || ev.body === null) return undefined
  const body = ev.body
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* fall through to SSE */ }
  let found: Record<string, unknown> | undefined
  for (const line of body.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line)
    if (!m || !m[1]) continue
    try {
      const parsed = JSON.parse(m[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) found = parsed as Record<string, unknown>
    } catch { /* ignore */ }
  }
  return found
}

/** The `result.tools[]` (full objects, not just names) from a tools/list message. */
export function toolObjectsFrom(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const result = message?.result
  if (!result || typeof result !== 'object') return []
  const tools = (result as Record<string, unknown>).tools
  if (!Array.isArray(tools)) return []
  return tools.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && !Array.isArray(t))
}

/** A `ui://` string, or undefined. */
function asUiUri(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith('ui://') ? v : undefined
}

/**
 * The `ui://` template a tool DEFINITION declares, under either the MCP Apps
 * `_meta.ui.resourceUri` key or the OpenAI Apps SDK `_meta['openai/outputTemplate']`
 * dialect. This is the affirmative "this target CLAIMS MCP-UI" signal — a tool
 * with no template means the whole dimension informationally SKIPs, so a plain
 * (non-MCP-UI) MCP server is NEVER probed further and never over-blocked.
 */
export function uiTemplateOfTool(tool: Record<string, unknown> | undefined): string | undefined {
  const meta = tool?._meta
  if (!meta || typeof meta !== 'object') return undefined
  const m = meta as Record<string, unknown>
  const ui = m.ui && typeof m.ui === 'object' ? (m.ui as Record<string, unknown>) : undefined
  return asUiUri(ui?.resourceUri) ?? asUiUri(m['openai/outputTemplate'])
}

/** The `ui://` resourceUri a tool RESULT links to (same two dialect keys). */
export function resourceUriOfResult(result: Record<string, unknown> | undefined): string | undefined {
  const meta = result?._meta
  if (!meta || typeof meta !== 'object') return undefined
  const m = meta as Record<string, unknown>
  const ui = m.ui && typeof m.ui === 'object' ? (m.ui as Record<string, unknown>) : undefined
  return asUiUri(ui?.resourceUri) ?? asUiUri(m['openai/outputTemplate'])
}

/**
 * The UIResource content entry from a `resources/read` result whose uri EXACTLY
 * matches `wantUri`. When `wantUri` is set (the normal case) a match is REQUIRED
 * — a server that returns a resource under a DIFFERENT uri than the one the tool
 * linked does not satisfy linkage (it could substitute an unrelated / attacker
 * resource), so there is NO `entries[0]` fallback. Only when `wantUri` is empty
 * (nothing to match against) do we fall back to the first content. Returns the
 * `{ mimeType, text }` the judge inspects for MIME + srcDoc + externalUrl.
 */
export function resourceContentOf(
  message: Record<string, unknown> | undefined,
  wantUri: string,
): { mimeType?: string; text?: string; uri?: string } | undefined {
  const result = message?.result
  if (!result || typeof result !== 'object') return undefined
  const contents = (result as Record<string, unknown>).contents
  if (!Array.isArray(contents)) return undefined
  const entries = contents.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
  const matched = wantUri ? entries.find((c) => c.uri === wantUri) : entries[0]
  if (!matched) return undefined
  return {
    mimeType: typeof matched.mimeType === 'string' ? matched.mimeType : undefined,
    text: typeof matched.text === 'string' ? matched.text : undefined,
    uri: typeof matched.uri === 'string' ? matched.uri : undefined,
  }
}

/** The externalUrl a UIResource points at, when its content is `text/uri-list`. */
export function externalUrlOf(content: { mimeType?: string; text?: string } | undefined): string | undefined {
  if (!content || typeof content.text !== 'string') return undefined
  const isUriList = typeof content.mimeType === 'string' && content.mimeType.toLowerCase().replace(/\s+/g, '').startsWith('text/uri-list')
  if (!isUriList) return undefined
  // A uri-list is newline-delimited; comment lines start with '#'. Take the first URL.
  const first = content.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'))
  return first
}

/** The MCP `tools/call` JSON-RPC request for a named UI-bearing tool. */
function mcpToolsCallRequest(name: string): unknown {
  return { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } }
}

/** The MCP `resources/read` JSON-RPC request for a `ui://` template uri. */
function mcpResourcesReadRequest(uri: string): unknown {
  return { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri } }
}

/**
 * Observe the MCP-UI / streaming-component readiness surfaces (ax-odg, ADR-0022).
 * Runs AFTER observeMcpRegistry so it can REUSE that pass's already-recorded
 * initialize (session id) + tools/list evidence for the same server.json remote
 * — no re-handshake, no extra budget for the common case.
 *
 * ACTIVATION is zero-overhead and honest: it fires the tool-call + resource-read
 * probes ONLY when a tool DEFINITION advertises a `ui://` template (MCP Apps
 * `_meta.ui.resourceUri` or the Apps-SDK `openai/outputTemplate` dialect). A
 * plain MCP server (no UI template) is never probed further, so a legit
 * non-MCP-UI API adds no calls and the whole dimension informationally SKIPs.
 *
 * SSRF: this touches TARGET-CONTROLLED URLs and gates every one. The tools/call
 * and resources/read POSTs go to the SAME remote the registry pass already
 * gated (public-https off-origin allowance + observeMcp's private-host backstop
 * + never-follow-redirect). A `ui://` uri is resolved over that gated MCP
 * transport (never fetched as a scheme). An `externalUrl` UIResource is the one
 * attacker-influenced http(s) target: it is fetched ONLY when it passes the
 * SAME narrow public-https gate (https, public host, no private/metadata IP);
 * a private/non-https externalUrl is REFUSED WITHOUT a byte leaving, and the
 * judge re-derives that refusal from the recorded uri-list. No new un-gated
 * fetch is introduced.
 */
async function observeMcpUi(origin: string, observer: Observer): Promise<void> {
  // Resolve the MCP remote: server.json remotes[0] (already gated by the
  // registry pass), falling back to a card-declared interfaces.mcp.url. Both are
  // re-gated through the narrow public-https off-origin allowance here.
  const items = observer.items
  const bundleView: EvidenceBundle = { target: origin, fetchedAt: '', seed: 0, items }
  const sjEv = findEvidence(bundleView, ROLE.mcpServerJson)
  const server = parseServerJson(parseJsonBody(sjEv))
  const agentsEv = findEvidence(bundleView, ROLE.agentsJson)
  const agents = parseAgentsJson(parseJsonBody(agentsEv), origin)

  // The server.json remote MAY legitimately be off-origin (the registry pattern),
  // so it uses the narrow public-https off-origin allowance. A card-declared
  // interfaces.mcp.url is the OAuth resource server and MUST be SAME-ORIGIN
  // (mirroring the MCP-OAuth posture) — an off-origin mcp.url is refused, exactly
  // as the OAuth chain refuses it, so this adds no new off-origin fetch surface.
  let remoteUrl: string | undefined
  const sjRemote = server?.remotes.find((r) => typeof r.url === 'string' && r.url.length > 0)?.url
  if (sjRemote && isPublicHttpsOffOriginAllowed(sjRemote)) remoteUrl = sjRemote
  else if (agents.mcp?.url && isPubliclyRoutableSameOrigin(agents.mcp.url, origin)) remoteUrl = agents.mcp.url
  if (!remoteUrl) return

  // Reuse the registry pass's initialize (session) + tools/list when they hit
  // this remote; otherwise perform a minimal handshake of our own (gated).
  const recordedInit = findEvidence(bundleView, ROLE.mcpRemoteInit)
  const initEv =
    recordedInit && recordedInit.url === remoteUrl
      ? recordedInit
      : await observer.observeMcp(ROLE.mcpRemoteInit, remoteUrl, mcpInitializeRequest())
  if (!initEv || initEv.status === null || initEv.status < 200 || initEv.status >= 300) return
  const sid = initEv.headers['mcp-session-id']
  const sessionHeaders: Record<string, string> = sid ? { 'mcp-session-id': sid } : {}

  const recordedTools = findEvidence(bundleView, ROLE.mcpRemoteToolsList)
  const toolsEv =
    recordedTools && recordedTools.url === remoteUrl
      ? recordedTools
      : await observer.observeMcp(ROLE.mcpRemoteToolsList, remoteUrl, mcpToolsListRequest(), sessionHeaders)

  const tools = toolObjectsFrom(parseJsonRpcMessage(toolsEv))
  const uiTool = tools.find((t) => uiTemplateOfTool(t) !== undefined)
  if (!uiTool) return // no tool advertises a ui:// template — informational SKIP

  // CLAIMS MCP-UI — call the tool and read its declared UIResource.
  const toolName = typeof uiTool.name === 'string' ? uiTool.name : ''
  if (!toolName) return
  const callEv = await observer.observeMcp(ROLE.mcpUiToolsCall, remoteUrl, mcpToolsCallRequest(toolName), sessionHeaders)

  const callResult = (parseJsonRpcMessage(callEv)?.result ?? undefined) as Record<string, unknown> | undefined
  const resourceUri = resourceUriOfResult(callResult) ?? uiTemplateOfTool(uiTool)
  if (!resourceUri) return // claimed a template but the result linked none — judge FAILs from evidence

  const readEv = await observer.observeMcp(ROLE.mcpUiResourceRead, remoteUrl, mcpResourcesReadRequest(resourceUri), sessionHeaders)
  const content = resourceContentOf(parseJsonRpcMessage(readEv), resourceUri)
  const ext = externalUrlOf(content)
  if (ext) {
    // The externalUrl is the ONE attacker-CHOSEN http(s) target. We do NOT make
    // api.qa a one-shot GET proxy to an arbitrary public URL (egress / reflection
    // abuse): an OFF-origin externalUrl is NEVER fetched — its DECLARED shape
    // (https, public, uri-list MIME) is validated by the linkage judge WITHOUT a
    // byte leaving. We fetch ONLY when the externalUrl is SAME-ORIGIN as the
    // verification target or the MCP remote we already handshook (a first-party
    // widget page, already within the surface we are gated for). Same-origin +
    // publicly-routable + https is enforced; a private/loopback/metadata host is
    // refused even same-origin.
    const sameAsTarget = isPubliclyRoutableSameOrigin(ext, origin)
    const sameAsRemote = isPubliclyRoutableSameOrigin(ext, remoteUrl)
    if (sameAsTarget || sameAsRemote) {
      await observer.observe(ROLE.mcpUiExternalUrl, ext, { accept: 'text/html,application/xhtml+xml' })
    }
  }
}

/**
 * Observe the AI SDK 5 UI-message-stream face (ax-rx1). Target-declared: only
 * when agents.json carries `interfaces.uiMessageStream.url` do we fetch — a
 * target with no such interface records NOTHING, so every ui-stream-* check
 * SKIPs (a non-streaming API is never over-blocked). The declared url is
 * CARD-DERIVED adversarial input, so it is gated through the SAME shared
 * same-origin helper as the openapi / offer / mcp.url probes: only a
 * same-origin, publicly-routable url is fetched (an off-origin / private /
 * metadata url is DROPPED, never fetched — the SSE face then simply isn't
 * observed, exactly the fail-closed posture the other card-derived probes
 * take). The body is read capped as SSE text via the read-only Observer.observe
 * (the structural private-host backstop applies underneath regardless). An
 * optional same-origin `twin` JSON projection is fetched for the parity check;
 * absent ⇒ parity SKIPs (no twin to diff against — never fabricated).
 */
async function observeUiStream(origin: string, observer: Observer): Promise<void> {
  const items = observer.items
  const bundleView: EvidenceBundle = { target: origin, fetchedAt: '', seed: 0, items }
  const agentsEv = findEvidence(bundleView, ROLE.agentsJson)
  const agents = parseAgentsJson(parseJsonBody(agentsEv), origin)
  const face = agents.uiStream
  if (!face?.url) return // no UI-message-stream face declared — informational SKIP
  if (!isPubliclyRoutableSameOrigin(face.url, origin)) return // hostile/off-origin declared url — never fetched
  await observer.observe(ROLE.uiMessageStream, face.url, { accept: 'text/event-stream' })
  if (face.twin && isPubliclyRoutableSameOrigin(face.twin, origin)) {
    await observer.observe(ROLE.uiStreamTwin, face.twin, { accept: 'application/json' })
  }
}

export async function observeTarget(origin: string, observer: Observer, seed: number): Promise<EvidenceBundle> {
  // 1. The fixed surface plan — identical for every target (no fingerprint).
  const rootAgentEv = await observer.observe(ROLE.rootAgent, `${origin}/`, { accept: '*/*' })
  const rootBrowserEv = await observer.observe(ROLE.rootBrowser, `${origin}/`, {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  })
  // Root probed with a strict `Accept: application/json` (ax-c7m). A fixed,
  // high-value negotiation probe (like the two root probes above): it lets the
  // content-negotiation check catch a root that IGNORES application/json and
  // returns a wall of HTML to an agent that explicitly asked for JSON — a
  // grader blind-spot surfaced by the ICP trial. Same-origin by construction.
  await observer.observe(ROLE.rootJson, `${origin}/`, { accept: 'application/json' })
  // AXP Clause 3 / Appendix A.7 conneg probes — fixed, identical for every
  // target. Three more root profiles: an explicit markdown request (A.7 step
  // 2), a Sec-Fetch-detected browser NAVIGATION on `*/*` (step 3a — HTML by
  // client class, not by Accept), and a known agent User-Agent on `*/*`
  // (step 3b — markdown by client class). The judge tells them apart by ROLE.
  const rootMarkdownEv = await observer.observe(ROLE.rootMarkdown, `${origin}/`, { accept: 'text/markdown' })
  await observer.observe(ROLE.rootBrowserNav, `${origin}/`, {
    accept: '*/*',
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' },
  })
  await observer.observe(ROLE.rootAgentUa, `${origin}/`, { accept: '*/*', headers: { 'user-agent': AGENT_UA } })
  // Face addresses (A.7 rule 1 — the address wins): resolved from the home's
  // OWN Link rel="alternate" advertisements (never a guessed extension
  // convention), each fetched ONCE with a CONTRADICTORY Accept header so the
  // conneg-forced-face check can confirm the address pins the face. Card-free
  // but still adversarial input (a Link header is target-controlled), so each
  // advertised URL passes the SHARED same-origin + publicly-routable gate and
  // an off-origin/private advertisement is DROPPED, never fetched — the check
  // then fails closed on the missing face evidence.
  {
    const advertised: Partial<Record<FaceName, string>> = {}
    for (const ev of [rootAgentEv, rootBrowserEv, rootMarkdownEv]) {
      for (const [face, url] of Object.entries(faceAlternatesOf(ev)) as Array<[FaceName, string]>) {
        advertised[face] ??= url
      }
    }
    const contradictoryAccept: Record<FaceName, string> = {
      html: 'application/json',
      json: 'text/html',
      md: 'text/html',
    }
    for (const face of ['html', 'json', 'md'] as const) {
      const url = advertised[face]
      if (!url || !isPubliclyRoutableSameOrigin(url, origin)) continue
      await observer.observe(ROLE.face(face), url, { accept: contradictoryAccept[face] })
    }
  }
  await observer.observe(ROLE.llmsTxt, `${origin}/llms.txt`, { accept: '*/*' })
  const agentsEv = await observer.observe(ROLE.agentsJson, `${origin}/.well-known/agents.json`, {
    accept: 'application/json',
  })
  await observer.observe(ROLE.icpJson, `${origin}/icp.json`, { accept: 'application/json' })

  // AAP discovery — GET {origin}/.well-known/agent-configuration. A FIXED,
  // origin-relative well-known (like agents.json/icp.json), so it is same-origin
  // by construction. It is still routed through the SHARED same-origin gate as
  // defense in depth: a consented private/local target fetches its own document
  // (the gate's consented-private-same-origin branch), while the deployed
  // Worker's structural backstop under Observer.observe refuses a private/
  // metadata origin regardless of this call site. Absent doc => the check SKIPs.
  const agentConfigUrl = `${origin}/.well-known/agent-configuration`
  if (isPubliclyRoutableSameOrigin(agentConfigUrl, origin)) {
    await observer.observe(ROLE.agentConfiguration, agentConfigUrl, { accept: 'application/json' })
  }

  const agents = parseAgentsJson(parseJsonBody(agentsEv), origin)
  // openapiUrl is CARD-DERIVED (openapi / openapiUrl / surfaces.openapi), and
  // absolutize() preserves an ABSOLUTE attacker-chosen url. It is fetched
  // DIRECTLY (no redirect), so the redirect-hop guard never sees it — an
  // un-gated `openapi:"http://169.254.169.254/…"` is a first-hop SSRF that
  // exfiltrates the metadata/credential body into the Evidence bundle. Gate it
  // through the SAME shared same-origin helper as the offer probe: only fetch
  // when the declared url is same-origin AND publicly-routable. A hostile
  // declared url is DROPPED (never fetched, no fallback) — the openapi surface
  // then fails closed, exactly as a hostile monetization.probe fails the
  // offers-402 check. The default `${origin}/openapi.json` is same-origin by
  // construction and always passes, so absence of a card url is unaffected.
  const openapiUrl = agents.openapiUrl ?? `${origin}/openapi.json`
  const openapiEv = isPubliclyRoutableSameOrigin(openapiUrl, origin)
    ? await observer.observe(ROLE.openapi, openapiUrl, { accept: 'application/json' })
    : undefined
  const openapi = parseOpenapi(parseJsonBody(openapiEv))

  // 2a. The card-declared Pricing Document (AXP A.2): probes.pricing entry 0,
  //     fetched in EVERY mode so pure judges can read the OBSERVED `model` —
  //     the probe-manifest check gates its metered-only demands
  //     (probes.overCeiling, monetization.probe) on it. Card-derived and
  //     therefore adversarial: same-origin GET only, or DROPPED unfetched.
  const pricingEntry = agents.probes?.pricing?.[0]
  if (
    pricingEntry &&
    pricingEntry.method === 'GET' &&
    isPubliclyRoutableSameOrigin(pricingEntry.url, origin)
  ) {
    await observer.observe(ROLE.pricing, pricingEntry.url, { accept: 'application/json' })
  }

  // 2. Seeded endpoint sampling — which endpoints get probed is not
  //    predictable before the run (the seed is fresh), but fully replayable
  //    after it (the seed is in the report).
  const candidatePaths = dedupe([
    ...openapi.probeCandidates.map((c) => c.path),
    ...agents.endpoints
      .filter((e) => e.method === 'GET' && (!e.auth || /none|keyless|public/i.test(e.auth)))
      .map((e) => pathOf(e.url, origin))
      .filter((p): p is string => p !== undefined),
  ])
    .filter((p) => !p.includes('{') && !p.includes('%7B')) // URL templates aren't probeable
    .sort()
  for (const path of sampleSeeded(candidatePaths, MAX_KEYLESS_PROBES, seed)) {
    // Candidate paths are CARD-DERIVED: openapi path keys are raw attacker
    // input, and a key that does NOT begin with "/" (e.g. "@evil.example/x" or
    // ".evil.example/x") makes `${origin}${path}` resolve OFF-ORIGIN. The
    // private-host backstop only bites private hosts, so gate through the
    // shared same-origin helper — a hostile key can never steer a keyless probe
    // off the target origin. Legitimate absolute paths ("/api/x") stay same
    // origin and pass unchanged.
    const url = `${origin}${path}`
    if (!isPubliclyRoutableSameOrigin(url, origin)) continue
    await observer.observe(ROLE.keyless('GET', path), url, { accept: 'application/json' })
  }

  // 2c. Clause-3 typed-body legibility beyond the root (ax-fsg): a target that
  //     claims the agent-first API contract (declares a probe manifest) must
  //     answer machine-legible non-HTML on its TYPED BODIES too, not just the
  //     home. Fetch a bounded, seed-replayable sample of declared typed-body
  //     paths under BOTH Accept: */* (agent) and Accept: text/html (browser);
  //     the machine-legible-home judge (checks.ts) then requires every sampled
  //     typed body to be non-HTML under both. Gated on the probe manifest so
  //     page surfaces (no manifest) are exempt, mirroring the check's skip
  //     semantics. Same SSRF posture as every card-derived probe. A card with a
  //     manifest but zero non-templated declared paths samples nothing (neutral,
  //     home-only) — it does not regress minimal cards.
  if (agents.probes) {
    for (const path of sampleSeeded(candidatePaths, 2, seed)) {
      const u = `${origin}${path}`
      if (!isPubliclyRoutableSameOrigin(u, origin)) continue
      await observer.observe(ROLE.typedBodyAgent(path), u, { accept: '*/*' })
      await observer.observe(ROLE.typedBodyBrowser(path), u, {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      })
    }
  }

  // 3. The 402 boundary probe, if the target declares one. Defense in depth:
  //    the fetch site itself re-checks same-origin GET, so even a probe that
  //    reached this point unfiltered can never send a request off-origin or
  //    at a private/metadata address (SSRF).
  //
  //    ORDERED BEFORE the contract-diff pass (below, 2b→5): this is a FIXED,
  //    high-value conformance probe — declared once, at most one request —
  //    and must never be starved of budget by the UNBOUNDED contract-diff
  //    enumeration of an endpoint-rich target's declared surface (ax-e6b.28.4
  //    budget-starvation fix). Running it here, ahead of the contract pass,
  //    RESERVES its share of the shared politeness budget by construction.
  if (
    agents.offerProbe &&
    agents.offerProbe.method === 'GET' &&
    isPubliclyRoutableSameOrigin(agents.offerProbe.url, origin)
  ) {
    await observer.observe(ROLE.offer, agents.offerProbe.url, {
      method: agents.offerProbe.method,
      accept: 'application/json',
    })
  }

  // 4. MCP authorization model (RFC 9728 → 8414 → PKCE/DCR/Resource Indicators).
  //    Only when the card declares an HTTP/SSE MCP interface (interfaces.mcp.url).
  //    stdio-only MCP has no url and is not an OAuth resource server — nothing
  //    is observed and the checks skip.
  //
  //    SSRF: the mcpUrl is CARD-DERIVED (adversarial). It is the target's OWN
  //    MCP endpoint, so it MUST be SAME-ORIGIN with the verification target —
  //    the identical gate every other card-derived probe passes. A mcpUrl that
  //    is off-origin or private is DROPPED here (never fetched); checks.ts still
  //    FAILS the card for it (decided from the URL string alone).
  const mcpUrl = agents.mcp?.url
  if (mcpUrl && isPubliclyRoutableSameOrigin(mcpUrl, origin)) {
    // (d) Probe the MCP endpoint UNAUTHENTICATED — expect 401 + WWW-Authenticate.
    const unauthEv = await observer.observe(ROLE.mcpUnauth, mcpUrl, { accept: 'application/json' })
    // (d-ii) ax-q4t: a spec-legal POST-only streamable-HTTP MCP server (no server-
    //     initiated SSE) answers the unauthenticated GET with a non-2xx/non-401
    //     (e.g. 405 Method Not Allowed) even though it answers a real JSON-RPC
    //     initialize over unauthenticated POST. When the GET gives NEITHER a clear
    //     keyless (2xx) NOR a clear protected (401/403 / WWW-Authenticate) signal,
    //     probe the MCP handshake directly with an unauthenticated POST initialize —
    //     REUSING the SSRF-gated observeMcp path (same private-host backstop the
    //     live-remote handshake uses). mcpUrl already passed the same-origin +
    //     publicly-routable gate above, so an off-origin/hostile url is never
    //     reached here. checks.ts reads this probe to tell keyless-POST-only
    //     (2xx JSON-RPC result => SKIP) from protected (401/403 => still OAuth-
    //     graded) from broken (5xx/garbage => no free SKIP).
    {
      const gs = unauthEv.status
      const getWww = unauthEv.headers['www-authenticate']
      const getKeyless = gs !== null && gs >= 200 && gs < 300
      const getChallengesAuth = gs === 401 || gs === 403 || (typeof getWww === 'string' && getWww.length > 0)
      if (!getKeyless && !getChallengesAuth) {
        await observer.observeMcp(ROLE.mcpUnauthInit, mcpUrl, mcpInitializeRequest())
      }
    }
    // (a) RFC 9728 protected-resource metadata at the MCP origin (same-origin).
    const prUrl = wellKnownAt(mcpUrl, 'oauth-protected-resource')
    const prEv = prUrl ? await observer.observe(ROLE.mcpProtectedResource, prUrl, { accept: 'application/json' }) : undefined
    // (b) Follow authorization_servers[0] to AS metadata. This ONE declared AS
    //     MAY be a DIFFERENT origin (a dedicated authorization server), so the
    //     same-origin gate is INTENTIONALLY not applied here — but the narrow
    //     off-origin gate still refuses cleartext and any private/loopback/
    //     link-local/metadata address, and the observer's own initial-url
    //     backstop refuses private hosts underneath it. The chase is bounded to
    //     this single AS and https-only; no arbitrary redirect walk.
    const asBase = firstAuthorizationServer(parseJsonBody(prEv))
    if (asBase && isPublicHttpsOffOriginAllowed(asBase)) {
      const asUrl = wellKnownAt(asBase, 'oauth-authorization-server')
      const asEv = asUrl ? await observer.observe(ROLE.mcpAsMetadata, asUrl, { accept: 'application/json' }) : undefined
      // Scrub the OFF-ORIGIN AS-metadata body to only the judged fields BEFORE it
      // is retained in the evidence bundle (ax-2ck) — no verbatim off-origin body.
      scrubAsMetadataEvidence(asEv)
      // RFC 8414 fallback: OpenID Connect discovery document.
      let asMetaEv = asEv
      if (!asEv || asEv.status === null || asEv.status < 200 || asEv.status >= 300) {
        const oidcUrl = wellKnownAt(asBase, 'openid-configuration')
        if (oidcUrl) {
          const oidcEv = await observer.observe(ROLE.mcpAsMetadataOidc, oidcUrl, { accept: 'application/json' })
          // The OIDC fallback is fetched from the SAME off-origin AS — scrub it too.
          scrubAsMetadataEvidence(oidcEv)
          if (oidcEv.status !== null && oidcEv.status >= 200 && oidcEv.status < 300) asMetaEv = oidcEv
        }
      }

      // auth.md agent-identity (ax-e6b.21.1): if the AS metadata carries an
      // `agent_auth` block, probe its declared identity_endpoint ONCE to confirm
      // it RESOLVES (advertisement/shape-grade — no ID-JAG mint). The endpoint is
      // METADATA-DERIVED (adversarial), so it is gated to be SAME-ORIGIN with the
      // delegating authorization server (`asBase`) — the AS delegation model —
      // and NEVER a private/loopback/link-local/metadata address. A hostile
      // identity_endpoint is DROPPED here (never fetched, no fallback); the
      // authmd-agent-identity check still FAILS it from the URL string alone.
      const agentAuth = parseAgentAuth(parseJsonBody(asMetaEv))
      const idEndpoint = agentAuth?.identity_endpoint
      const asOrigin = (() => { try { return new URL(asBase).origin } catch { return undefined } })()
      if (idEndpoint && asOrigin && isPubliclyRoutableSameOrigin(idEndpoint, asOrigin)) {
        await observer.observe(ROLE.agentIdentity, idEndpoint, { accept: 'application/json' })
      }
    }
  }

  // 4b. MCP-registry publishability (ax-e6b.38): fetch the server.json manifest,
  //     LIVE-resolve its remote (initialize -> tools/list), and derive domain-
  //     ownership provability (well-known + DNS-TXT). ORDERED BEFORE contract-
  //     diff so these fixed, high-value probes reserve their budget share and are
  //     never starved by an endpoint-rich target's unbounded contract enumeration.
  //     Every fetch is SSRF-gated (see observeMcpRegistry). A target that serves
  //     no server.json performs only the one well-known probe (404 => the whole
  //     dimension SKIPs).
  await observeMcpRegistry(origin, observer)

  // 4c. MCP-UI / streaming-component readiness (ax-odg, ADR-0022): when a tool
  //     advertises a `ui://` template, call it and read the declared UIResource
  //     so the judge can grade whether it renders trustworthily inside an agent
  //     host. Zero-overhead for non-MCP-UI targets (no template ⇒ no probe).
  //     Every fetch is SSRF-gated (see observeMcpUi); reuses the registry pass's
  //     initialize session, so it adds no handshake for the common case.
  await observeMcpUi(origin, observer)

  // 4d. AI SDK 5 UI-message-stream readiness (ax-rx1): when the card declares an
  //     `interfaces.uiMessageStream` face, GET its SSE endpoint (and any JSON
  //     twin) so the ui-stream-* judges can grade header/framing/part-shape/
  //     secret-hygiene/projection-parity. Zero-overhead for non-streaming
  //     targets (no interface ⇒ no probe). Same SSRF posture as every other
  //     card-derived probe (see observeUiStream).
  await observeUiStream(origin, observer)

  // 5. Contract-diff probing (ax-e6b.28.4): for a FULL OpenAPI<->live diff,
  //    fetch EVERY GET-safe candidate path once — not just the seeded keyless
  //    sample above — so the diff enumerates every declared operation, not a
  //    random three. A path the keyless sample ALREADY fetched is reused (the
  //    contract judge falls back to its `probe:endpoint:` evidence), so the
  //    observer never double-fetches it. Same SSRF posture as every other
  //    card-derived probe: same-origin + publicly-routable, via the gated
  //    Observer.observe (which also structurally refuses private/metadata
  //    hosts and off-origin redirects). No new un-gated fetch surface.
  //
  //    PRIORITY / BUDGET-STARVATION FIX: this pass runs LAST and is capped at
  //    MAX_CONTRACT_PROBES, deliberately AFTER every fixed high-value probe
  //    above (402-offer, MCP-OAuth unauth + discovery chain, and — earlier
  //    still — the always-fixed AAP agent-configuration well-known). An
  //    endpoint-rich declared surface (more GET-safe paths than budget/cap
  //    allow) must never drain the shared politeness budget out from under
  //    those fixed probes and starve them to a null status — that produced
  //    false FAILs on a perfectly compliant target. The remainder beyond the
  //    cap (or beyond whatever budget is actually left) is simply never
  //    fetched; the contract judge (contract.ts) reports those declared
  //    operations as UNPROBED, not as a violation. Determinism holds — the
  //    candidate set is sorted and seed-independent, so the same prefix is
  //    always the one probed for a given declaration.
  const alreadyProbed = new Set(
    observer.items
      .filter((e) => e.role.startsWith('probe:endpoint:GET '))
      .map((e) => e.role.slice('probe:endpoint:GET '.length)),
  )
  let contractProbesUsed = 0
  for (const path of candidatePaths) {
    if (alreadyProbed.has(path)) continue
    if (contractProbesUsed >= MAX_CONTRACT_PROBES) break
    const url = `${origin}${path}`
    if (!isPubliclyRoutableSameOrigin(url, origin)) continue
    await observer.observe(ROLE.contract('GET', path), url, { accept: 'application/json' })
    contractProbesUsed++
  }

  return { target: origin, fetchedAt: new Date().toISOString(), seed, items: observer.items }
}

function pathOf(url: string, origin: string): string | undefined {
  try {
    const u = new URL(url)
    return u.origin === origin ? u.pathname : undefined
  } catch {
    return undefined
  }
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)]
}

// ---------------------------------------------------------------------------
// Derive phase (pure)
// ---------------------------------------------------------------------------

export async function deriveDiscovery(bundle: EvidenceBundle): Promise<DiscoveryReport> {
  const llms = findEvidence(bundle, ROLE.llmsTxt)
  const agentsEv = findEvidence(bundle, ROLE.agentsJson)
  const icpEv = findEvidence(bundle, ROLE.icpJson)
  const openapiEv = findEvidence(bundle, ROLE.openapi)
  const root = findEvidence(bundle, ROLE.rootAgent)

  const agentsDoc = parseJsonBody(agentsEv)
  const agents = parseAgentsJson(agentsDoc, bundle.target)
  const icpDoc = parseJsonBody(icpEv)
  const openapi = parseOpenapi(parseJsonBody(openapiEv))

  const endpoints: ClaimedEndpoint[] = [
    ...agents.endpoints,
    ...openapi.probeCandidates.map((c) => ({
      method: 'GET',
      url: `${bundle.target}${c.path}`,
      source: 'openapi' as const,
    })),
  ]

  const claims: DiscoveryReport['claims'] = { endpoints }
  if (agents.name) claims.name = agents.name
  if (agents.description) claims.description = agents.description
  if (agents.mcp) claims.mcp = agents.mcp
  if (agents.offers) claims.offers = agents.offers
  if (agents.offerProbe) claims.offerProbe = agents.offerProbe
  if (agents.probes) claims.probes = agents.probes
  if (agents.attestation !== undefined) claims.attestation = agents.attestation
  if (agents.openapiUrl) claims.openapiUrl = agents.openapiUrl

  const icpAttestation = extractIcpAttestation(icpDoc)
  if (claims.attestation === undefined && icpAttestation !== undefined) claims.attestation = icpAttestation

  return {
    $type: 'DiscoveryReport',
    target: bundle.target,
    fetchedAt: bundle.fetchedAt,
    surfaces: {
      root: surfaceStatus(root, () => root?.body != null && root.body.length > 0),
      llmsTxt: surfaceStatus(llms, () => looksLikeLlmsTxt(llms?.body)),
      agentsJson: surfaceStatus(agentsEv, () => agentsDoc !== undefined && agents.name !== undefined),
      icpJson: surfaceStatus(icpEv, () => icpDoc !== undefined && hasAgentClasses(icpDoc)),
      openapi: surfaceStatus(openapiEv, () => openapi.valid),
    },
    claims,
    evidenceDigest: await digestBundle(bundle),
  }
}

function extractIcpAttestation(icpDoc: unknown): unknown {
  if (!icpDoc || typeof icpDoc !== 'object') return undefined
  const d = icpDoc as Record<string, unknown>
  return d.ladder ?? d.attestation ?? d.attestationLadder
}

export async function digestBundle(bundle: EvidenceBundle): Promise<string> {
  // elapsedMs and fetchedAt are wall-clock — excluded so identical target
  // state yields an identical digest.
  const stable = bundle.items.map(({ elapsedMs: _elapsed, ...rest }) => rest)
  return sha256Hex(canonicalJson({ target: bundle.target, seed: bundle.seed, items: stable }))
}

function surfaceStatus(ev: Evidence | undefined, valid: () => boolean): SurfaceStatus {
  if (!ev || ev.status === null) return { present: false, status: null, note: ev?.error }
  if (ev.status < 200 || ev.status >= 300) return { present: false, status: ev.status }
  return { present: true, status: ev.status, valid: valid() }
}

export function looksLikeLlmsTxt(body: string | null | undefined): boolean {
  if (!body) return false
  // llms.txt convention: markdown, H1 title, non-trivial content.
  return /^#\s+\S/m.test(body) && body.trim().length >= 80 && !/^\s*</.test(body)
}

export function hasAgentClasses(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false
  const d = doc as Record<string, unknown>
  return Array.isArray(d.agent_classes) || Array.isArray(d.agentClasses) || Array.isArray(d.classes)
}

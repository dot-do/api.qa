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
} as const

export function findEvidence(bundle: EvidenceBundle, role: string): Evidence | undefined {
  return bundle.items.find((e) => e.role === role)
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

export async function observeTarget(origin: string, observer: Observer, seed: number): Promise<EvidenceBundle> {
  // 1. The fixed surface plan — identical for every target (no fingerprint).
  await observer.observe(ROLE.rootAgent, `${origin}/`, { accept: '*/*' })
  await observer.observe(ROLE.rootBrowser, `${origin}/`, {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  })
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

  // 2b. Contract-diff probing (ax-e6b.28.4): for a FULL OpenAPI<->live diff,
  //     fetch EVERY GET-safe candidate path once — not just the seeded keyless
  //     sample above — so the diff enumerates every declared operation, not a
  //     random three. A path the keyless sample ALREADY fetched is reused (the
  //     contract judge falls back to its `probe:endpoint:` evidence), so the
  //     observer never double-fetches it. Same SSRF posture as every other
  //     card-derived probe: same-origin + publicly-routable, via the gated
  //     Observer.observe (which also structurally refuses private/metadata
  //     hosts and off-origin redirects). No new un-gated fetch surface. The
  //     politeness budget bounds the total; determinism holds — the candidate
  //     set is sorted and seed-independent.
  const alreadyProbed = new Set(
    observer.items
      .filter((e) => e.role.startsWith('probe:endpoint:GET '))
      .map((e) => e.role.slice('probe:endpoint:GET '.length)),
  )
  for (const path of candidatePaths) {
    if (alreadyProbed.has(path)) continue
    const url = `${origin}${path}`
    if (!isPubliclyRoutableSameOrigin(url, origin)) continue
    await observer.observe(ROLE.contract('GET', path), url, { accept: 'application/json' })
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
    await observer.observe(ROLE.mcpUnauth, mcpUrl, { accept: 'application/json' })
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

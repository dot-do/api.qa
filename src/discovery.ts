/**
 * Discovery — the observe phase, then a pure derivation.
 *
 * `observeTarget` performs the (polite, read-only) fetch plan and returns an
 * EvidenceBundle. `deriveDiscovery` is a PURE function bundle → DiscoveryReport:
 * everything api.qa says a target claims is re-derivable by anyone from the
 * evidence in the published report. Checks (checks.ts) are pure over the same
 * bundle — the verifier never judges anything it didn't record.
 */

import { Observer } from './http.js'
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
  offer: 'probe:402-offer',
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
    out.mcp = {
      transport: str(mcp.transport),
      command: str(mcp.command),
      url: str(mcp.url),
      tools: Array.isArray(mcp.tools) ? mcp.tools.filter((t): t is string => typeof t === 'string') : undefined,
    }
  }

  const monetization = d.monetization as Record<string, unknown> | undefined
  if (monetization && Array.isArray(monetization.offers)) {
    out.offers = monetization.offers as AgentsClaims['offers']
  }
  const probe = monetization?.probe as Record<string, unknown> | undefined
  if (probe && typeof probe.url === 'string') {
    out.offerProbe = { method: str(probe.method) ?? 'GET', url: absolutize(probe.url, origin) }
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

function absolutize(url: string, origin: string): string {
  try {
    return new URL(url, origin).toString()
  } catch {
    return url
  }
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

  const agents = parseAgentsJson(parseJsonBody(agentsEv), origin)
  const openapiUrl = agents.openapiUrl ?? `${origin}/openapi.json`
  const openapiEv = await observer.observe(ROLE.openapi, openapiUrl, { accept: 'application/json' })
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
    await observer.observe(ROLE.keyless('GET', path), `${origin}${path}`, { accept: 'application/json' })
  }

  // 3. The 402 boundary probe, if the target declares one.
  if (agents.offerProbe) {
    await observer.observe(ROLE.offer, agents.offerProbe.url, {
      method: agents.offerProbe.method,
      accept: 'application/json',
    })
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

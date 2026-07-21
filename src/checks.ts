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
} from './discovery.js'
import { validateSchema } from './schema.js'
import type { CheckResult, Evidence, EvidenceBundle, Verdict } from './types.js'

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
  {
    const asAgent = findEvidence(bundle, ROLE.rootAgent)
    const asBrowser = findEvidence(bundle, ROLE.rootBrowser)
    const agentGotText = ok(asAgent) && asAgent?.body != null && !looksLikeHtml(asAgent.body)
    const browserGotHtml = ok(asBrowser) && asBrowser?.body != null && looksLikeHtml(asBrowser.body)
    checks.push(check('content-negotiation', 'root content-negotiates (curl → markdown, browser → HTML)', 4,
      [ROLE.rootAgent, ROLE.rootBrowser],
      agentGotText && browserGotHtml
        ? pass('Accept: */* got non-HTML text; Accept: text/html got HTML')
        : fail(asAgent, agentGotText
            ? 'browser Accept did not receive HTML'
            : 'agent Accept received HTML (or nothing) — curl gets a wall of markup')))
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
    let result: { verdict: Verdict; detail: string }
    if (!declared) {
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
          if (!u || u.origin !== origin) { problems.push(`probes.${ch} url ${e.url} is not same-origin with ${origin}`); continue }
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

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

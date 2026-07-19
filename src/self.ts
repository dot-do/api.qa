/**
 * api.qa's own machine surfaces — the reference implementation half of the
 * product. api.qa must score 10/10 on its own checklist (test/self.test.ts
 * enforces it): the verifier discovers and grades itself through exactly the
 * same B2A protocols it grades everyone else on. R-k serving doctrine: the
 * response IS the pitch — every surface leaves an agent one command from a
 * verdict.
 */

export const SELF_ORIGIN = 'https://api.qa'

export function selfLlmsTxt(): string {
  return `# api.qa

> The external third-party verifier for agent-first APIs. Contract-derived
> deterministic checks, public grade pages, attested replayable reports.
> The fitness function your own fleet cannot edit.

## Grade any API (no key, no account)

\`\`\`sh
curl https://api.qa/example.com
\`\`\`

Returns the public report as markdown: letter grade + the 10-point AX score
+ per-check verdicts. \`accept: application/json\` returns the full report
including the evidence bundle (replayable) and the Ed25519 attestation.

## Verify against a pinned spec (the hill-climb harness)

\`\`\`sh
curl -X POST https://api.qa/verify \\
  -H 'content-type: application/json' \\
  -d '{"target":"https://your.dev","spec":<PinnedSpec JSON>,"expectedDigest":"<sha256>"}'
\`\`\`

If the spec text does not hash to \`expectedDigest\`, nothing runs — the
verdict is bound to the pinned contract, not to any file a fleet can edit.
Local mode: \`npx autonomous-qa verify http://localhost:8787 --spec spec.json\`
(advisory; never attested).

## Other surfaces

- \`GET /llms.txt\` — this document
- \`GET /.well-known/agents.json\` — capability card
- \`GET /icp.json\` — who this is for; self-classify
- \`GET /openapi.json\` — the API contract (we are verified against it too)
- \`GET /health\` — keyless liveness
- \`GET /self\` — api.qa's own verdict on api.qa, run live
- \`npx autonomous-qa <domain>\` — CLI; \`npx autonomous-qa mcp\` — MCP server (stdio)

## 402s are offers, not errors

Free verification is rate-limited and public. Boundaries (bulk runs, CI
webhooks, private report retention) answer HTTP 402 with a structured offer:
\`GET /offers/attested-run\` shows the shape. Relay the checkout link; keep
building.

## Attestation

Remote reports are Ed25519-signed over the canonical report digest; the
evidence bundle is embedded, so any third party can re-judge the verdict
from the report alone. Local-mode reports are advisory and never attested —
only the held-out verifier signs.
`
}

export function selfAgentsJson(): object {
  return {
    name: 'api.qa',
    description:
      'External third-party verifier for agent-first APIs: discovery from published machine surfaces, contract-derived deterministic checks, attested public grade reports.',
    url: SELF_ORIGIN,
    provider: { organization: 'api.qa', url: SELF_ORIGIN },
    identity: {
      line: 'The fitness function held outside your fleet.',
      gap: 'Agent fleets hill-climb against tests; a fleet that can edit its tests Goodharts them. api.qa derives verification from contracts the fleet publishes but cannot silently change the judgment of: its own OpenAPI/llms.txt/agents.json, and pinned spec documents bound by digest.',
      negativeCapabilities:
        'Read-only probing (GET/HEAD) on discovery; write probes only in pinned-spec consent mode. No load testing, no fuzzing, no auth bypass attempts. Local-mode verdicts are advisory and never attested.',
    },
    interfaces: {
      http: {
        report: { method: 'GET', url: `${SELF_ORIGIN}/{domain}`, auth: 'none' },
        verify: { method: 'POST', url: `${SELF_ORIGIN}/verify`, auth: 'none' },
        health: { method: 'GET', url: `${SELF_ORIGIN}/health`, auth: 'none' },
        usage: { method: 'GET', url: `${SELF_ORIGIN}/llms.txt`, auth: 'none' },
      },
      cli: { install: 'npx autonomous-qa', commands: ['<domain>', 'verify <target> --spec <file>', 'rejudge', 'mcp'] },
      mcp: {
        transport: 'stdio',
        command: 'npx autonomous-qa mcp',
        tools: ['verify_domain', 'discover_domain', 'verify_pinned_spec'],
      },
    },
    openapi: `${SELF_ORIGIN}/openapi.json`,
    attestationLadder: [
      {
        rung: 'advisory-local',
        description: 'CLI/local-mode run. Deterministic, replayable, unsigned. For hill-climb loops.',
      },
      {
        rung: 'attested-remote',
        description: 'Run by the deployed verifier; Ed25519-signed over the canonical report digest; evidence embedded for third-party re-judging.',
      },
      {
        rung: 'grant-bound',
        description: 'SEAM: attestation bound to an id.org.ai agent/organization grant, feeding fixation-gate and R19 counters.',
      },
    ],
    monetization: {
      model: '402 offers at boundaries; keyless public verification stays free',
      offers: [
        { id: 'attested-run', title: 'On-demand attested verification run', price: { amount: 5, currency: 'USD', interval: 'one-time' } },
        { id: 'ci-webhook', title: 'CI webhook: verify on every deploy', price: { amount: 20, currency: 'USD', interval: 'month' } },
      ],
      probe: { method: 'GET', url: `${SELF_ORIGIN}/offers/attested-run` },
    },
    surfaces: {
      llmsTxt: `${SELF_ORIGIN}/llms.txt`,
      icp: `${SELF_ORIGIN}/icp.json`,
      openapi: `${SELF_ORIGIN}/openapi.json`,
      self: `${SELF_ORIGIN}/self`,
    },
  }
}

export function selfIcpJson(): object {
  return {
    contract: 'api-qa/icp',
    version: 1,
    description:
      'Agent self-classification for the verifier surface. Read your class to know which flow fits.',
    agent_classes: [
      {
        id: 'builder',
        fit: 'You just built or changed an API and need to know it works.',
        flow: `GET https://api.qa/<your-domain> — read the grade, fix the FAILs, re-run. For dev URLs: npx autonomous-qa <http://localhost:port> (advisory).`,
      },
      {
        id: 'fleet-orchestrator',
        fit: 'You run a hill-climbing loop and need an acceptance gate the workers cannot edit.',
        flow: 'POST /verify with the pinned spec + expectedDigest. Definition of done = passed:true from the deployed verifier, not from any local test file.',
      },
      {
        id: 'evaluator',
        fit: 'You are deciding whether to integrate with a third-party API.',
        flow: 'GET https://api.qa/<their-domain> — the AX score tells you what an agent can actually do there keylessly; the evidence bundle shows receipts.',
      },
      {
        id: 'procurement',
        fit: 'You settle 402 offers on behalf of a principal.',
        flow: 'Hit a boundary → structured offer with checkout link → settle or relay. GET /offers/attested-run shows the shape.',
      },
    ],
    ladder: [
      { rung: 'advisory-local', durability: 'unsigned' },
      { rung: 'attested-remote', durability: 'Ed25519-signed, replayable' },
      { rung: 'grant-bound', durability: 'SEAM: id.org.ai-bound attestations' },
    ],
    not_for: [
      'load testing or fuzzing a target',
      'penetration testing or auth bypass',
      'verifying targets you intend to game — the evidence bundle is public',
    ],
  }
}

export function selfOpenapi(): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'api.qa',
      version: '0.1.0',
      description: 'External third-party verifier for agent-first APIs.',
    },
    servers: [{ url: SELF_ORIGIN }],
    paths: {
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Keyless liveness probe',
          responses: {
            '200': {
              description: 'alive',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok', 'verifier', 'version'],
                    properties: {
                      ok: { type: 'boolean', const: true },
                      verifier: { type: 'string', const: 'api.qa' },
                      version: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'openapi',
          summary: 'This contract',
          responses: {
            '200': {
              description: 'the OpenAPI document',
              content: {
                'application/json': {
                  schema: { type: 'object', required: ['openapi', 'paths'] },
                },
              },
            },
          },
        },
      },
      '/{domain}': {
        get: {
          operationId: 'report',
          summary: 'Public grade report for a target domain (content-negotiated)',
          parameters: [
            { name: 'domain', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'markdown | html | json report' } },
        },
      },
      '/verify': {
        post: {
          operationId: 'verify',
          summary: 'Run a verification (optionally against a pinned spec)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['target'],
                  properties: {
                    target: { type: 'string' },
                    spec: { type: 'object' },
                    expectedDigest: { type: 'string' },
                    seed: { type: 'integer' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'VerificationReport | PinnedVerificationReport' } },
        },
      },
    },
  }
}

export function selfOffer(): object {
  return {
    id: 'attested-run',
    title: 'On-demand attested verification run',
    description:
      'A fresh, Ed25519-attested verification of your target, run now, with the evidence bundle retained for replay. The free tier stays free: public keyless verification is rate-limited, not paywalled.',
    price: { amount: 5, currency: 'USD', interval: 'one-time' },
    checkoutUrl: 'https://api.qa/checkout/attested-run', // SEAM: x402 / Stripe — not wired in the spike
    alternatives: [
      { id: 'free-tier', how: 'GET /{domain} — free rate-limited public verification, no key needed' },
      { id: 'local-mode', how: 'npx autonomous-qa <target> — run the same verifier core locally (advisory, unsigned)' },
    ],
  }
}

export function selfLandingHtml(): string {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: 'api.qa',
        url: SELF_ORIGIN,
        description: 'External third-party verifier for agent-first APIs.',
      },
      {
        '@type': 'DefinedTerm',
        name: 'Agent Experience (AX)',
        description:
          'The quality of a service as experienced by AI agents: discoverable machine surfaces, keyless trial flows, structured payment offers, and attestable behavior. Successor term to Developer Experience (DX).',
        inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'api.qa AX score', url: SELF_ORIGIN },
      },
    ],
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>api.qa — the verifier your fleet can't edit</title>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#111}
  pre{background:#0b0b0d;color:#e4e4e7;padding:1rem;border-radius:8px;overflow-x:auto}
  h1{font-size:2.2rem}
</style>
</head>
<body>
<h1>api.qa</h1>
<p><strong>The external third-party verifier for agent-first APIs.</strong>
Agent fleets hill-climb against tests. If the fleet can edit the tests, the
tests stop meaning anything. api.qa is the fitness function held outside the
fleet's write access: verification derived from your published contracts,
deterministic, attested, replayable.</p>
<pre>curl https://api.qa/example.com</pre>
<p>Letter grade + the 10-point <strong>AX score</strong> (Agent Experience) +
per-check verdicts, with the evidence bundle embedded so anyone can re-judge
the verdict. api.qa grades itself with the same checks: <a href="/self">/self</a>.</p>
<p>Agents: this page content-negotiates — <code>curl</code> gets
<a href="/llms.txt">llms.txt</a>. See <a href="/.well-known/agents.json">agents.json</a>,
<a href="/icp.json">icp.json</a>, <a href="/openapi.json">openapi.json</a>.</p>
</body>
</html>`
}

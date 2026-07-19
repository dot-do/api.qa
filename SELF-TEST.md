# SELF-TEST — api.qa's verdict on api.qa

The self-referential gate, run locally on 2026-07-19. The verifier was pointed
at its own Worker handler through a loopback fetcher — the same
`verifyTarget()` core, the same discovery plan, the same checks it applies to
any target, discovering api.qa purely through api.qa's own published machine
surfaces. Enforced permanently by `test/self.test.ts` (`npm run self-test`).

Reproduce:

```sh
npm run build
node --input-type=module -e "
import { createApp } from './dist/src/worker.js'
import { verifyTarget } from './dist/src/verify.js'
import { generateSigningKey, verifyAttestation } from './dist/src/attest.js'
import { reportMarkdown } from './dist/src/render.js'
const app = createApp()
const fetcher = (u, init) => app.fetch(new Request(u, init))
const report = await verifyTarget('https://api.qa', { mode: 'remote', fetcher, delayMs: 0, seed: 42, signingKeys: await generateSigningKey() })
console.log(reportMarkdown(report))
console.log('ATTESTATION-VALID: ' + await verifyAttestation(report))
"
```

(Seed pinned to 42 so the probe plan — and therefore the evidence digest —
reproduces exactly. The ephemeral key means the *signature* differs per run;
the report body digest does not. Deployed, the held-out `SIGNING_KEY` signs.)

## Output

```
# api.qa report — api.qa

> **Grade A+** · AX score **10/10** · remote mode · attested

- verified: 2026-07-19T10:54:05.854Z
- verifier: api.qa v0.1.0 · seed 42 (replayable)
- evidence digest: `b1b4d72b9287fbe0fbc0e8ec7d2685c3ad07d26ad9a452af689b53ada0ca8094`
- report digest: `5d6e000f20eb95146d34a5d24017f5e3d70a385cd3baf0d090fb59a69839007f` (Ed25519-signed)

## AX score (the 10-point checklist)

| # | check | verdict |
| --- | --- | --- |
| 1 | llms.txt is served and agent-actionable | PASS |
| 2 | /.well-known/agents.json capability card parses | PASS |
| 3 | /icp.json self-classification surface | PASS |
| 4 | root content-negotiates (curl → markdown, browser → HTML) | PASS |
| 5 | machine-readable API contract (OpenAPI) is published | PASS |
| 6 | MCP interface declared with transport + tools | PASS |
| 7 | at least one declared endpoint answers 2xx with no key | PASS |
| 8 | payment boundaries answer as structured 402 offers | PASS |
| 9 | surfaces cross-reference each other (linkset) | PASS |
| 10 | attestation/identity ladder is declared | PASS |

## Check details

### PASS — llms.txt is served and agent-actionable (`llms-txt`)

markdown with an H1 and substantive content

### PASS — /.well-known/agents.json capability card parses (`agents-json`)

valid JSON; name="api.qa", 4 http endpoint(s) declared

### PASS — /icp.json self-classification surface (`icp-json`)

valid JSON with agent_classes — an agent can self-classify

### PASS — root content-negotiates (curl → markdown, browser → HTML) (`content-negotiation`)

Accept: */* got non-HTML text; Accept: text/html got HTML

### PASS — machine-readable API contract (OpenAPI) is published (`openapi`)

OpenAPI parses; 4 path(s), 2 keyless GET candidate(s)

### PASS — MCP interface declared with transport + tools (`mcp-declared`)

mcp: stdio with tools [verify_domain, discover_domain, verify_pinned_spec] (presence-grade; stdio not spawned)

### PASS — at least one declared endpoint answers 2xx with no key (`keyless-flow`)

3/3 sampled endpoint(s) answered 2xx keyless (seed 42)

### PASS — payment boundaries answer as structured 402 offers (`offers-402`)

declared boundary answered HTTP 402 with a structured offer (id/title + price|checkoutUrl|alternatives)

### PASS — surfaces cross-reference each other (linkset) (`linkset`)

Link header present on root

### PASS — attestation/identity ladder is declared (`attestation`)

attestation ladder declared (agents.json attestationLadder / icp.json ladder)

### PASS — sampled responses conform to their published schemas (`schema-conformance`)

2 sampled response(s) conform to their OpenAPI schemas

### PASS — claimed endpoints actually exist (no ghost surface) (`claims-honesty`)

every probed claimed endpoint exists (no 404/5xx)

## Replay this verdict

The full evidence bundle is embedded in the JSON report. Judging is a pure
function of the bundle — re-run the checks over it and you MUST get this
same grade, or the report is forged / the verifier version changed:

```sh
curl -H 'accept: application/json' https://api.qa/api.qa | npx api.qa rejudge
```

ATTESTATION-VALID: true
```

## What this proves (and what it doesn't)

- **Proves:** every convention api.qa grades others on, it serves itself —
  discovered through the same B2A protocols, judged by the same pure checks,
  including both honesty checks (its sampled responses conform to its own
  published OpenAPI schemas; every endpoint it claims exists). The 12/12
  verdict is the R-k "estate surfaces as 10/10 reference implementations"
  tactic, made a CI gate.
- **Doesn't prove:** that a *deployed* api.qa is honest — a local run trusts
  the local binary (DESIGN.md attack #6/#8). The deployed `/self` route plus
  third-party replay of the published evidence bundle is the version of this
  that counts once the SIGNING_KEY seam is wired.

# autonomous-qa — the external verifier for agent-first APIs

**AX = Agent eXperience** — what DX was to developers, AX is to agents.

An AI agent won't integrate an API it can't trust, and a principal can't *prove*
their API works for agents by asserting it — assertions are exactly what
Goodharted fleets produce. **api.qa is the proof mechanism of the agent-first
arc**: the external, third-party verifier that grades a surface from its
*published contracts*, held **outside the building fleet's write access** so the
fleet it grades can't edit its own test. Verification is deterministic,
Ed25519-attested, and replayable — and it's self-referential: **api.qa grades
itself with its own checks, 10/10** (see [SELF-TEST.md](./SELF-TEST.md)). Full
program framing: the
[agent-first StoryBrand](https://apis.ax/axp) and the `.ax` messaging spine.

`autonomous-qa` is the npm name for the concept and reference client; the hosted
service lives at **[api.qa](https://api.qa)**.

```sh
curl https://api.qa/example.com        # public grade page, as markdown
npx autonomous-qa example.com          # same verifier core, locally (advisory)
npx autonomous-qa mcp                  # MCP server: verify_domain, discover_domain, verify_pinned_spec
```

## Free vs. paid — the value line

The verifier keeps first value **free and gate-free**, and charges only for
ongoing assurance (product model recorded on `.ax` issue `ax-e6b.30`):

- **FREE — "be discoverable + integrable."** The **AEO conformance grade**
  (agent-legibility) + **MCP-auth tests** run unauthenticated, keyless, no
  signup — because a gate on the free grade would contradict the whole thesis.
  This is what `curl https://api.qa/<domain>` and `npx autonomous-qa <domain>`
  return today.
- **PAID — "prove you work + stay working."** *(roadmap.)* **Functional
  testing** (real CRUD round-trips + workflow execution) and **monitoring**
  (scheduled recurring verification, time-series history, alerting on grade
  regression, status dashboards) — gated behind a machine-settleable **AXP 402
  offer + hard-ceiling metered price**, so api.qa dogfoods AXP's own payment
  clause and the free path never 401/402s.

## The free grade (what a report is)

A report is: letter grade (A+–F) + the 10-point **AX score** (llms.txt ·
agents.json · icp.json · content negotiation · OpenAPI · MCP · keyless flow ·
402 offers · linkset · attestation) + two honesty checks that cap the grade
at C when a published contract lies. The full evidence bundle is embedded in
every report, and remote reports are Ed25519-signed — anyone can `rejudge`
a verdict offline.

## The hill-climb harness (pinned-spec mode)

Agent fleets hill-climb against tests; a fleet that can edit its tests
Goodharts them. The pinned spec is the fitness function the fleet can implement
against but cannot redefine:

```sh
npx autonomous-qa spec-digest examples/golden-scenario.spec.json   # mint the pin once
npx autonomous-qa verify http://localhost:8787 \
  --spec examples/golden-scenario.spec.json \
  --expect-digest <pin>                                     # loop until exit 0
```

If the spec text doesn't hash to the pin, nothing runs. Acceptance =
`passed: true` from the *deployed* verifier; local runs never sign.

## CI gate (Newman parity)

A pinned reusable suite gates a pipeline the way Newman does: **non-zero exit on
any failure** plus machine-readable **JUnit XML + JSON** reports. A gate that
exits `0` on a failure is a silent green — so `verify` / `suite` /
`suite --iteration-data` all exit non-zero when any requirement, probe, or
iteration fails (or the digest pin mismatches, or the target is
unreachable/refused), and exit `0` only when everything passed.

```sh
npx autonomous-qa suite examples/golden-scenario.suite.json --env prod \
  --target https://your.api --expect-digest <pin> \
  --reporter cli \
  --reporter junit --reporter-junit-out reports/api-qa.junit.xml \
  --reporter json  --reporter-json-out  reports/api-qa.json
```

A working GitHub Action is at
[`.github/workflows/api-qa-example.yml`](./.github/workflows/api-qa-example.yml);
full recipe (GitHub + GitLab) in [docs/ci.md](./docs/ci.md).

## Development

```sh
npm install
npm test          # 50 tests, fully hermetic (in-memory targets, loopback self-test)
npm run build     # tsc → dist (CLI bin + module)
npm run dev       # wrangler dev (the Worker mount)
```

Design + threat model: [DESIGN.md](./DESIGN.md). Layout: `src/` verifier core
(observe: `http.ts`/`discovery.ts` · judge: `checks.ts`/`grade.ts` · attest:
`attest.ts` · mounts: `worker.ts`/`mcp.ts`) · `cli/` · `test/` ·
`examples/` pinned specs.

# autonomous-qa — the external verifier for agent-first APIs

**The external third-party verifier for agent-first APIs** — the npm name
for the concept and reference client; the hosted service lives at
**[api.qa](https://api.qa)**. Agent fleets
hill-climb against tests; a fleet that can edit its tests Goodharts them.
api.qa is the fitness function held outside the fleet's write access:
verification derived from *published contracts*, deterministic, attested,
replayable — and self-referential (api.qa grades itself with its own checks,
10/10; see [SELF-TEST.md](./SELF-TEST.md)).

```sh
curl https://api.qa/example.com        # public grade page, as markdown
npx autonomous-qa example.com                 # same verifier core, locally (advisory)
npx autonomous-qa mcp                         # MCP server: verify_domain, discover_domain, verify_pinned_spec
```

A report is: letter grade (A+–F) + the 10-point **AX score** (llms.txt ·
agents.json · icp.json · content negotiation · OpenAPI · MCP · keyless flow ·
402 offers · linkset · attestation) + two honesty checks that cap the grade
at C when a published contract lies. The full evidence bundle is embedded in
every report, and remote reports are Ed25519-signed — anyone can `rejudge`
a verdict offline.

## The hill-climb harness (pinned-spec mode)

```sh
npx autonomous-qa spec-digest examples/golden-scenario.spec.json   # mint the pin once
npx autonomous-qa verify http://localhost:8787 \
  --spec examples/golden-scenario.spec.json \
  --expect-digest <pin>                                     # loop until exit 0
```

If the spec text doesn't hash to the pin, nothing runs. Acceptance =
`passed: true` from the *deployed* verifier; local runs never sign.

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

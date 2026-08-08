---
name: axp
description: Build and verify AXP-conformant API surfaces (the agent-experience standard at axp.org.ai, verified by api.qa). Use when creating or reviewing any API property, machine face, agents.json card, openapi/pricing surface, npm package with an API, or when publishing/verifying a public test suite for an API. Triggers on "AXP", "machine face", "agents.json", "conformance", "publish the test suite", "make this agent-ready".
---

# AXP — the agent-experience standard

Every API property ships a machine face that agents can discover, price, call, and **verify without asking anyone**. The standard is AXP (https://axp.org.ai, pinned spec `apis-ax-axp@2.4.0`); the verifier is api.qa (`autonomous-qa` on npm). This skill encodes how to build to it.

## The doctrine (why, in one paragraph)

A published test suite converts **"trust us" into "run this."** It is the executable form of three laws: proof-artifacts-not-adjectives, verifiable-without-joining, and the claim-the-vision discipline — **a claim with a published failing test is a P0; a claim with a published passing test is proven.** Backends may be closed source; the suite discloses only the public contract, which is documentation, not leakage. Never argue a claim in copy that could instead be proven by a test.

## The quartet (every property MUST serve)

1. **`/.well-known/agents.json`** — the normative capability card + probe manifest (Appendix A.3 shape), with `links.conformance` → its `https://api.qa/<domain>` verdict and `links.verify` → its published suite.
2. **`/openapi.json`** — OpenAPI 3.1, **live endpoints only** (presence-when-true: unbuilt surface never appears; roadmap lives in your P0 ledger, never in the reference).
3. **`/pricing`** — the machine-readable pricing document. `{"model":"free"}` where true — an agent must never have to ask a human what something costs; metered surfaces declare hard ceilings, offers, and the 402 boundary.
4. **`llms.txt`** — cross-linking the rest of your API family.

**Optional declared interfaces — additive only, and only where already true (AXP 0.6.0, Appendix A.8):** beside `http` and `mcp`, a card MAY declare further `interfaces.<name>` members. **Presence is the declaration**, and the rule is two-sided: omitting the key is *fully conformant* and the armed check `skip`s, while declaring it is judged **strictly** — a defective declaration **fails**, it does not skip. There is no value meaning "no"; a card that means no omits the key. Optional interfaces are **additive capabilities only**: none of them can ever relieve you of Clauses 1–7.

- `interfaces.digitalLink` — this origin's GS1 **Resolver Description File** at `/.well-known/gs1resolver`, so an agent which has never heard of GS1 learns from the card it already reads that this origin resolves GS1 keys. Declared, that file MUST answer 200, MUST validate against GS1's published description-file schema, and its `resolverRoot` MUST be this origin. **Since `apis-ax-axp@2.3.0` this is admission-pinned in declaration-armed form** (`check-digital-link-resolver`, `appliesWhen: { cardDeclares: "interfaces.digitalLink" }`) — so declare it only where the well-known already answers; a card that omits it passes as *not applicable*. AXP restates none of GS1's vocabulary and verifies none of GS1's resolution behaviour (linkType, RFC 9264 linksets, redirects) — that is GS1's standard and GS1's test suite.
- `interfaces.testSuite` — this origin's own digest-pinned conformance suite. Card seam `{ url?, package?, version?, export?, digest, environment?, runner? }`: at least one address, one `sha256:` digest as the **sole byte authority**. Two ratified dialects (AXP 0.7.0): `api.qa/suite@1` — declarative rows the verifier *interprets*, GET/HEAD-only with writes disabled, same-origin — and `api.qa/vitest@1` (Appendix A.8.6) — executable tests as a digest-pinned module, addressed by any of the three collapsed channels (A.8.6.6): string members inside the pinned suite document (`tests` + optional `module`), a natively served ES module at a versioned URL (e.g. `https://pkg.do/apis.vin@1.2.0/index.mjs` — the SDK case; an AXP package property MUST serve `.mjs` + `.d.ts` natively at immutable versioned URLs with `{package, version, digest}` provenance), or an npm `package@version` **identity assertion** over the served bytes (npm a verifiable mirror, never in the loop). A guaranteed vitest subset (`describe`/`it`/`expect` + async; imports closed to `vitest` / `suite:env` / `suite:module`; no node built-ins, snapshots, or mocking) the verifier *executes* in a fresh zero-authority isolate above a network floor (no metadata/link-local/private/verifier-internal destinations; **full external egress otherwise**), under a metered circuit-breaker deadline (default 300s wall / 60s CPU, billed; suite@1 keeps its fixed 20s), with seeded randomness and mutating verbs only against an environment the suite declares `sandbox: true`. The runner is a paid-tier capability — the paid tier, never scarcity, is its gate — so the remaining caps are abuse circuit-breakers, not rations: 1000 rows+tests combined, 1 MiB document, 4 MiB module artifact, 4 MiB output. Same file runs under local vitest and hosted api.qa — one shared harness, parity by construction. **Since `apis-ax-axp@2.4.0` this is admission-pinned in declaration-armed form** (`check-published-test-suite`) — declare it only where the artifact already answers at the declared pin; a card that omits it passes as *not applicable*.

Plus: **typed envelopes** (`OK / EMPTY / BLOCKED / OFFER` — three emptinesses never blend) and **the conneg law** on every dereferenceable address: extension forces (`.html/.json/.md`) → Accept infers (q-values, header-order ties) → client-class defaults on `*/*` (browser via Sec-Fetch-*, never UA sniffing → HTML; known agent UAs → markdown; everything else incl. bare curl → JSON). JSON faces are JSON-LD with resolvable `$context`. `Link rel="alternate"` advertises siblings. Never 406. HEAD mirrors GET.

## How to build (never hand-roll)

Generate the quartet from one manifest — never hand-roll the faces one by one. One site manifest should emit the entire quartet + envelope helper + conneg middleware, pinned to the spec digest, so adding a capability is adding a manifest row and all faces update together. The reference generator is `axp-faces` in the axp.org.ai repository; the spec's examples at https://axp.org.ai show the target shapes. If your generator lacks something the spec requires, fix the generator — never patch one site.

## How to verify (one suite, two runners)

- **Local**: `autonomous-qa/vitest` exports `toConform` / `assertConforms` (and `describeConformance({ baseUrl })` expanding every pinned requirement into individual vitest cases). Wire into your build as a fail-closed digest-pinned gate (`--expect-digest`).
- **Hosted**: the deployed api.qa runs the **same digest-locked requirement implementations** — local green and hosted verdict cannot diverge by construction. The public verdict page at `https://api.qa/<domain>` is the receipt; the card links it.
- Every property also publishes its own **`verify` export** (e.g. `https://your-api.example/verify`): the public-contract unit/integration/e2e suites, runnable by anyone against the live doors, documented on a "Run our tests" page.

## Lint rules (the doctrine's guardrails)

- Tests target **public contracts only** — a published test for an unshipped endpoint leaks roadmap (presence-when-true applies to tests).
- Fixtures are secret-scanned like all published artifacts; synthetic identifiers use designated demo ranges (e.g. GS1 demo prefix 952, valid check digits) and never real company names.
- e2e-against-prod inherits each door's rate-limit posture; suites must be polite by default.
- Spec edits happen upstream at axp.org.ai; verifier checks land in the same change; version + digest bump together. The pinned digest is the only authority — "roughly conformant" does not exist (fail-closed).

## Procedure (checklist)

1. Write/extend the site's manifest → run the generator → quartet + middleware emitted.
2. `vitest` local: `describeConformance` green at the pinned digest.
3. Build gate wired (fail-closed) → deploy → curl the four faces + one conneg matrix spot-check.
4. Hosted verdict: run api.qa against the domain → link `links.conformance` from the card.
5. Publish/refresh the property's `verify` export; update the "Run our tests" page.
6. Any gap that can't ship now → a P0 entry in your ledger, never softened copy, never a hidden face.

## References

- Spec: https://axp.org.ai (PROTOCOL, pinned conformance spec + digest)
- Verifier: `autonomous-qa` on npm — CLI, `autonomous-qa/vitest` matchers, MCP server; hosted verdicts at `https://api.qa/<domain>`
- Reference implementation: see the spec's examples at https://axp.org.ai
- Install/refresh this skill: `npx axp.org.ai skill install` — the standard's own package (drift check: `npx axp.org.ai skill --check`; print: `npx axp.org.ai skill --print`). Verifier-side mirror, same bytes: `npx autonomous-qa skill install`

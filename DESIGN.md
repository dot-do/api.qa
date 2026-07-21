# api.qa — design

**The external third-party verifier for agent-first APIs.** Studio ruling R-r +
addendum: agent fleets can hill-climb forever *if the tests are deterministic* —
and the tests only stay meaningful if the fleet cannot edit them. api.qa is the
fitness function held outside the fleet's write access.

The product grammar is the SSL Labs precedent: `api.qa/{domain}` is a public
grade page — letter grade + the 10-point **AX score** + per-check verdicts —
derived from the target's own published contracts, executed deterministically,
and attested so the verdict is portable evidence.

---

## The threat model (front and center)

The design problem is not "test an API." It's: **a fleet whose reward is
"api.qa green" will attack the verifier before it fixes the product.**
Goodhart's law is the adversary. Every mechanism below exists because of a
specific attack.

### The core invariant

> A verdict is a pure function of (published contracts, observed behavior,
> pinned spec digest, seed, verifier version). None of those five inputs is
> writable by the fleet being verified — the fleet can change its *behavior*
> and its *published contracts*, but changing either changes the evidence
> digest, visibly, in the attested report.

### Attacks and mitigations

| # | Attack | Mitigation | Status |
|---|--------|-----------|--------|
| 1 | **Edit the tests** (the classic): fleet rewrites repo-local test files until green | There are no repo-local test files in the loop. Checks are *derived at run time* from the target's published surfaces (llms.txt, agents.json, icp.json, OpenAPI) and from pinned spec documents named by digest. The fleet's repo contains zero inputs to the verdict. | built |
| 2 | **Edit the spec** it's verified against (pin a friendlier golden scenario) | Pinned-spec mode refuses to run when supplied spec text doesn't hash to `expectedDigest` (`pinned.ts`). The acceptance command names the digest, not a file path: `npx api.qa verify <target> --spec spec.json --expect-digest <sha256>`. The digest is minted when the spec is ratified and lives with the orchestrator/vault — outside the workers' write access. | built |
| 3 | **Shrink the claims** (publish a tiny OpenAPI so there's almost nothing to check) | Grading rewards verified richness: fewer surfaces/endpoints → lower AX score, and pinned specs pin the *required* surface area regardless of what the target chooses to claim. A fleet minimizing claims minimizes its own grade. | built |
| 4 | **Overfit to probe patterns** (hardcode responses for the endpoints the verifier is known to sample) | Endpoint sampling is seeded: the seed is chosen fresh per run (unpredictable beforehand) and recorded in the report (replayable afterward). Same target state + same seed → same verdict; a *new* attested run uses a new seed and lands on different samples. Overfitting to one run's probe set fails the next. | built |
| 5 | **Cloak for the verifier** (detect probes, serve golden responses to api.qa and garbage to real agents) | Probes are indistinguishable from ordinary agent traffic: standard `Accept` headers, no distinctive User-Agent, no fixed IP contract in the design. And the evidence bundle is embedded in the public report — any third party can replay the same requests from their own vantage point and compare against the recorded evidence. Cloaking is detectable by anyone, which is what deters it. | built (IP diversity is a deploy seam) |
| 6 | **Tamper with the local verifier** (wrap `npx api.qa`, patch the binary, or fake its output in the hill-climb loop) | Local mode is *advisory by construction*: local reports carry `attested: false` and no signature, and nothing downstream should accept them as evidence. The only signing key lives as a deploy secret on the held-out service. The weekend build's definition of done is "the deployed api.qa says green," not "my local api.qa says green." | built |
| 7 | **Forge or cherry-pick reports** (doctor a JSON report, or re-run until a flaky pass) | Reports are Ed25519-signed over the canonical report digest; `verifyAttestation` + `rejudge` let anyone (a) check the signature, (b) re-run the pure judge over the embedded evidence and confirm the grade reproduces. Determinism removes the flake-mining channel: same evidence cannot re-judge to a different verdict. | built |
| 8 | **Compromise the verifier itself** (the fleet gains write access to api.qa's repo) | Two layers. (a) The signing key is never in the repo — a fleet that owns the code still can't mint attested history, and key rotation invalidates the window. (b) The self-referential gate: api.qa's test suite verifies api.qa through its own public protocols (`test/self.test.ts`); a corrupted judge that grades dishonestly must also fool the judge's own published contract. Honest residual: a fully compromised verifier + key is game over — that's why the repo/key governance sits with the studio, not with any build fleet (seam: grant/attestation core). | partially built |
| 9 | **Use api.qa as a weapon** (SSRF into internal networks, probe-cannon DoS against third parties) | `normalizeTarget` refuses private hosts, IP literals, single-label names, `.local`/`.internal` (deployed mode). The Observer is read-only (GET/HEAD) outside pinned-consent mode, budgeted (24 req/run), spaced (150ms), body-capped (256KB), timeout-bounded. Write probes exist only in pinned-spec mode, where the target is by definition the caller's own. **Per-domain global cooldown is now wired** (`src/cooldown.ts`, `DomainCooldown` DO): one DO instance per domain (`idFromName(host)`) enforces a minimum inter-probe interval across every isolate, so fanning a probe-cannon across the edge is denied globally, not per-isolate. A domain in cooldown is served a stale cached verdict (`src/cache.ts` KV) or a `429` with `Retry-After` — the third party is never re-probed. | built (SSRF guards + Observer budget + cross-isolate cooldown DO + KV cache) |
| 10 | **Time-shift the state** (present good state to the verifier at T0, degrade at T1, keep waving the T0 report) | A report attests *a target state at a time*: evidence digest + timestamp are in the signed body. Consumers of the evidence (fixation gate, R19 counters, CI gates) must demand freshness — the reverify-policy machinery in services-as-software v3 is exactly this consumer, and the CI-webhook offer productizes it. | designed (reverify wiring is a seam) |
| 11 | **Goodhart the AX score itself** (surfaces that exist but lie) | The two non-scoring honesty checks: `schema-conformance` (sampled responses must match the published schemas) and `claims-honesty` (claimed endpoints must exist). Either failing **caps the grade at C** no matter the score — a lying surface is worse than a missing one. Honest residual: `mcp-declared` and 402 `declared-only` are presence-grade in the MVP (noted in their own verdict text); behavioral MCP spawn and paid-boundary probes are seams. | built, with named residuals |

### What the design does *not* claim

- It cannot stop a target from being *narrowly excellent*: a fleet that
  hardcodes exactly the pinned contract's scenarios passes the pinned
  contract. That is not a defeat — passing the ratified contract is the
  definition of done — but contract *coverage* is the real quality bound.
  Richer coverage (property-based scenario synthesis, EvaluatorPanel
  personas from services-as-software v3) is the productized next layer.
- Determinism is scoped to (target state, seed, verifier version). A target
  that answers nondeterministically will judge nondeterministically — and
  that itself shows up in evidence across replays.

---

## Architecture: observe / judge

```
verifyTarget(target)
  ├─ observe (impure, polite, budgeted)          src/http.ts, src/discovery.ts
  │    fixed surface plan: /, /llms.txt, /.well-known/agents.json,
  │    /icp.json, OpenAPI (declared or /openapi.json)
  │    + seeded endpoint samples + declared 402 boundary probe
  │        → EvidenceBundle (every exchange recorded)
  ├─ judge (pure functions of the bundle)
  │    deriveDiscovery(bundle) → DiscoveryReport   src/discovery.ts
  │    runChecks(bundle)       → CheckResult[]     src/checks.ts
  │    axScoreOf + gradeOf     → 10-pt score, A+–F src/grade.ts
  └─ attest (remote mode only)                     src/attest.ts
       Ed25519 over sha256(canonicalJson(report sans attestation))
       evidence embedded → anyone can rejudge()    src/verify.ts
```

One core, three mounts: the Worker (`src/worker.ts`, `api.qa/{domain}` grade
pages + `/self`), the CLI (`cli/index.ts`, `npx api.qa`), the MCP server
(`src/mcp.ts`, `verify_domain` / `discover_domain` / `verify_pinned_spec`).
All three call `verifyTarget` / `verifyPinnedSpec` with an injectable fetcher —
which is also how api.qa verifies itself with zero network (loopback into its
own handler) and how tests run hermetically.

### The AX score (R-k's 10 points, made executable)

1. llms.txt served and agent-actionable
2. `/.well-known/agents.json` capability card parses
3. `/icp.json` self-classification
4. root content-negotiation (curl → markdown, browser → HTML)
5. machine-readable contract (OpenAPI) published
6. MCP interface declared (transport + tools)
7. keyless flow: a declared endpoint answers 2xx with no key
8. payment boundaries are structured 402 offers
9. linkset: surfaces cross-reference (or `Link` header)
10. attestation/identity ladder declared

Plus the two grade-capping honesty checks (§ attack 11). Grade bands:
10 → A+ (only with zero honesty failures) · 9 → A · 7–8 → B · 5–6 → C ·
3–4 → D · ≤2 → F.

---

## The X1 harness (pinned-spec mode)

The completion-ladder's golden scenario becomes an acceptance contract the
weekend fleet optimizes against but cannot touch:

1. **Ratify + pin.** The golden-scenario contract is written as a `PinnedSpec`
   (see `examples/golden-scenario.spec.json`: dealer slice — lead → prequal →
   deal → escalate → approve → deliver → ledger settles, plus clean 4xx on
   garbage). Mint the pin once: `npx api.qa spec-digest examples/golden-scenario.spec.json`.
   The digest goes in the orchestrator's prompt / the vault — not in the
   workers' repos.
2. **Hill-climb against local mode.** Each worker exposes the scenario on its
   dev URL and loops:
   `npx api.qa verify http://localhost:8787 --spec specs/golden-scenario.spec.json --expect-digest <pin>`
   — exit code 0 = green. Same verifier core as production; advisory and
   unsigned, which is fine *inside* the loop.
3. **Accept on the held-out verifier.** The orchestrator's definition of done:
   `POST https://api.qa/verify {"target": "<deployed-target>", "specText": …, "expectedDigest": "<pin>"}`
   returns `passed: true` — from the deployed service the fleet has no write
   access to. A worker that edited its local spec copy fails here with
   `spec digest mismatch` before a single probe fires.

Pinned mode is **consent mode**: the target is the caller's own, so POST
probes with bodies are allowed (`allowWrites`); discovery probing of third
parties stays read-only.

---

## The auto.dev harness case

R-r addendum: *"https://api.qa/auto.dev can BE the X1 weekend's acceptance
harness."* What `api.qa/auto.dev` checks today, given auto.dev's known shape
(a production vehicle-data API — VIN decode, listings — with the agent-first
playbook applied to it):

- **Surface presence (AX 1–3, 5):** does auto.dev serve `llms.txt`,
  `/.well-known/agents.json`, `/icp.json`, and a discoverable OpenAPI? The
  agent-first work gives it a head start most incumbent APIs lack; whatever
  is missing shows up as named FAILs — which is the punch list, not a
  judgment.
- **Content negotiation (AX 4):** `curl https://auto.dev` should return
  agent-actionable markdown, not the marketing page's markup.
- **Keyless flow (AX 7) — the R15 asymmetry test:** the classic API-key
  signup wall is precisely what the checklist penalizes. A keyless
  rate-limited VIN decode (`GET /api/vin/{vin}` without a key, politely
  throttled) is the single highest-leverage fix an agent-first auto.dev can
  ship, and this check is the regression gate that keeps it live.
- **402 offers (AX 8):** when the free tier runs out mid-decode, does the
  agent get a structured offer (checkout link + alternatives) or a dead 429/401?
- **Honesty caps:** sampled listings/VIN responses judged against auto.dev's
  own published schemas — the data-product assurance angle (R-j: contract =
  schema/coverage/freshness) in miniature.
- **As the sale-era harness:** an attested `api.qa/auto.dev` report is
  portable evidence of "the agent-first experience works" that survives the
  handover — the acquirer can rejudge it without trusting us, because the
  evidence bundle and signature verify offline.

Run it today (advisory, from this repo): `npx api.qa auto.dev`.

---

## Seams (what the MVP deliberately leaves open)

1. **Grant/attestation core (id.org.ai).** Reports are key-attested, not
   identity-attested. The `grant-bound` rung declared in api.qa's own ladder
   is the seam: bind the signing key to an id.org.ai organization grant, so
   verdicts become fixation-gate / R19-counter evidence with a grantor chain.
   Shares the one grant core with page.ax / builder.domains (R-n).
2. **x402 / payment settlement.** `/offers/attested-run` returns the correct
   402 shape with a placeholder `checkoutUrl`. Wiring: x402 agent-wallet
   settlement + Stripe checkout for the B2H2A path.
3. **Deploy.** *Reconciled 2026-07-21.* The historical contradiction: the old
   `wrangler.jsonc` header said "Nothing deploys from this spike," yet commit
   9ad59bb ("deploy: supersede legacy api-qa worker…") turned `workers_dev`
   on, bound the custom domain `api.qa`, set the `SIGNING_KEY` secret, and
   applied migration `v2-verifier` to delete the legacy 2022–2024 worker's DOs.
   The truth per git is that a real supersede deploy happened; the "nothing
   deploys" line predated it and was stale. `wrangler.jsonc` now pins the
   coherent production shape:
   - `routes: [{ pattern: "api.qa", custom_domain: true }]`, `workers_dev: true`
   - **Secret** `SIGNING_KEY` (base64 pkcs8 Ed25519 — `wrangler secret put`,
     never in repo; a single held-out key the fleet cannot read).
   - **KV** `REPORTS` — the report cache (per-target cooldown horizon +
     content-addressed replay store: `report:{host}:{evidenceDigest}` with a
     `head:{host}` pointer; pinned runs `pinned:{host}:{specDigest}`).
     `src/cache.ts`. Provision: `wrangler kv namespace create REPORTS`, paste
     the id (the placeholder in `wrangler.jsonc` must be replaced before deploy).
   - **DO** `COOLDOWN` (class `DomainCooldown`, migration tag `v3-cooldown`,
     `new_sqlite_classes`) — the per-domain politeness budget across isolates.
     `src/cooldown.ts`.
   - Optional vars `CACHE_TTL_SECONDS` (default 300), `COOLDOWN_MIN_INTERVAL_MS`
     (default 60000). Both cache and cooldown are **absent-safe**: with no
     binding the Worker behaves exactly as the pre-wiring spike (every isolate
     probes fresh) — which is why the hermetic test suite still runs unchanged.
   Still open on this seam: minting/rotating the signing key (key-rotation
   story), and provisioning the two real resource IDs. **Nothing here deploys
   automatically** — this repo makes the config coherent; the operator runs
   `wrangler deploy`. .qa DNS sits at Netim — cutover rides the #9 evacuation
   like the .ax roots. The purity boundary is intact: the KV cache and the DO
   only decide *whether to mint a fresh verdict or serve a stored one*; the
   judge is still a pure function of the EvidenceBundle (same bundle →
   byte-identical verdict), and `rejudge()` still reproduces any cached report.
4. **Reverify policy.** services-as-software v3's `reverify-policy` +
   `EvaluatorPanel` are the abstract layer this productizes; the CI-webhook
   offer is reverify-as-a-subscription. Panel personas would upgrade pinned
   specs from structural assertions to judged outcomes.
5. **Deeper contract engines.** YAML OpenAPI, full JSON Schema (beyond the
   mini validator), multi-level `$ref`, MCP behavioral probing (spawn/HTTP
   transport handshake, `tools/list` conformance), A2A agent cards,
   property-based fixture synthesis from schemas.
6. **Probe-vantage diversity.** Anti-cloaking is currently "replayable by
   anyone"; a deployed tier can add multi-PoP probing (Workers already give
   this almost free) and verifier-key transparency (publish the key at a
   well-known URL + in DNS).
7. **The grade-page network effects.** Badges (`api.qa/{domain}/badge.svg`),
   historical grade timelines, the linkset index over graded targets — the
   apis.ax pairing.

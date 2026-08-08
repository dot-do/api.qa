# Executable published test suites on Cloudflare Worker Loaders

**Status:** DESIGN — no production code changes. Branch `design/executable-suites`.
**Date:** 2026-08-08
**Scope:** an AXP spec amendment (axp.org.ai `PROTOCOL.md` A.8.5) plus a phased
api.qa implementation plan. Additive to the existing declarative
`api.qa/suite@1` path — nothing here rewrites `test-suite.ts`, `suite-doc.ts`,
or `pinned.ts`; the executable tier is a new path beside them.

---

## 1. The ruling

Founder ruling (2026-08-08), which this document executes rather than debates:

> api.qa MUST be able to execute service-published vitest-style test suites,
> using Cloudflare's dynamic Worker Loader for secure arbitrary code execution.
> The current A.8.5 sentence "The suite is data, never code… a verifier MUST
> NOT execute code a target publishes" is the wrong framing: **the suite IS
> data, but code is data, and can be executed.**

The old prose bound two distinct things into one prohibition: (a) the suite
artifact must be pinnable, replayable bytes — which stays true and is
strengthened below — and (b) executing those bytes forfeits verdict
independence — which was an implementation limitation stated as a principle.
Verdict independence never rested on non-execution. It rests on the artifact
pin, the recorded evidence, and the held-out signing key. Section 5 satisfies
the concern the old sentence was protecting; it does not dismiss it.

Why now, concretely: the declarative dialect can only probe endpoints
(`kind:'endpoint'`, GET/HEAD, 25 requirements). The fi.vin / buy.vin sprint
surfaces need to *prove workflows* — capture-chained multi-step flows
(create → read-back → assert invariants → clean up) that a declarative probe
list cannot express and a vitest suite expresses natively.

---

## 2. The Cloudflare primitive — facts, with sources

Researched 2026-08-08; the training-cutoff picture is stale, these are current.

**Product.** "Dynamic Workers" — the Worker Loader binding lets a deployed
Worker spawn additional isolates that load **arbitrary code at runtime**, in a
sandbox whose bindings, egress, and resource limits the parent controls.
**Status: open beta since April 2026, available to all paid Workers plans**
(the InfoQ launch coverage; note the older `worker-loader.mdx` page in the
docs repo still carries stale closed-beta wording). Local development works
today in Wrangler / workerd with no beta gate.

- Overview: <https://developers.cloudflare.com/dynamic-workers/>
- Binding reference: <https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/>
- API reference: <https://developers.cloudflare.com/dynamic-workers/api-reference/>
- Egress control: <https://developers.cloudflare.com/dynamic-workers/usage/egress-control/>
- Custom limits: <https://developers.cloudflare.com/dynamic-workers/usage/limits/>
- Open-beta status/pricing: <https://www.infoq.com/news/2026/04/cloudflare-dynamic-workers-beta/>

**Binding config** (wrangler):

```jsonc
{ "worker_loaders": [ { "binding": "SUITE_LOADER" } ] }
```

**API shape.**

```ts
env.SUITE_LOADER.get(id: string, getCode: () => Promise<WorkerCode>): WorkerStub
env.SUITE_LOADER.load(code: WorkerCode): WorkerStub   // one-shot, uncached
const stub = worker.getEntrypoint()                    // then stub.fetch(...) / RPC
```

`get()` caches the isolate by `id` (warm reuse is possible but **never
guaranteed** — two requests may land in different isolates, so nothing may
depend on isolate-local state). Cloudflare's own recommendation is to derive
the id from **a hash of the code and config** — which composes perfectly with
our digest pinning (§4).

**`WorkerCode` fields:** `compatibilityDate` (required), `compatibilityFlags`,
`mainModule` (required), `modules` (required — a record of module name →
source: `{js}`, `{cjs}`, `{py}`, `{text}`, `{data}`, `{json}`), `env`
(required — the loaded worker sees ONLY what the parent puts here; structured
clonables and service-binding stubs), `globalOutbound`, `tails`
(Tail Workers for log capture), and a `limits` object.

**Egress is fully brokerable.** `globalOutbound` has three modes:
`null` — every `fetch()` **and** `connect()` in the isolate throws;
unspecified — inherits the parent's network access; or a `ServiceStub` /
`WorkerEntrypoint` — **every `fetch()` and `connect()` the dynamic worker
makes is delivered to that gateway instead of the network**. The gateway runs
in the parent's trust domain, can inspect/modify/refuse each request, and can
inject credentials the child never sees. This is exactly the interposition
point api.qa's SSRF/origin/budget gates need.

**Resource limits.** `limits: { cpuMs, subRequests }` per invocation; a breach
throws immediately in the isolate. Limits can also be passed at
`getEntrypoint()` and the lower value wins. Wall-clock deadlines are the
parent's job (race the stub call against a timer — same pattern as
`SUITE_DEADLINE_MS` today).

**Isolation.** V8 isolates (the same primitive all Workers run on), plus
Cloudflare's layered hardening: fast V8 patch deployment, a second-layer
sandbox with risk-based tenant cordoning, hardware Memory Protection Keys,
and Spectre defenses. Cloudflare is explicit that isolates are a sharper
attack surface than hardware VMs; §6 treats the loaded suite as fully
hostile anyway and relies on the binding/egress model, not on V8 alone.

**Pricing.** $0.002 per unique dynamic Worker loaded per day (waived during
beta) + standard Workers CPU/invocation charges. Content-hash ids mean an
unchanged suite is one "unique worker" per day regardless of run count.

**Modules / npm reality.** The loader takes **source strings**, not packages:
there is no npm install, no `node_modules` resolution, and no bundler inside
the isolate. `nodejs_compat` can be requested via `compatibilityFlags`, but
that provides Node built-ins, not package resolution. Consequence: **an
executable suite must be a pre-bundled, self-contained ES module** whose only
unresolved imports are the ones api.qa itself injects (§3).

**Vitest itself does not run in the isolate — and does not need to.**
`@cloudflare/vitest-pool-workers` (the prior art:
<https://developers.cloudflare.com/workers/testing/vitest-integration/>,
<https://www.npmjs.com/package/@cloudflare/vitest-pool-workers>) runs vitest
test code *inside workerd*, but only by pairing it with a Node-side vitest
orchestrator (a custom pool) and force-injecting `nodejs_compat` /
`no_nodejs_compat_v2` / `export_commonjs_default` — an architecture that
requires a Node host process api.qa does not have in production. **Decision:
a minimal vitest-compatible harness (`describe` / `it` / `test` / `expect` /
`beforeAll` / `afterAll` / `beforeEach` / `afterEach`), authored by api.qa and
made available two ways at once: injected as **globals by default** (the vitest
`globals: true` posture, Jest's default), so a suite that just calls
`describe`/`it`/`expect` runs with no import line at all; and exported from a
module aliased to the bare specifier `'vitest'`, so `import { expect, it,
describe, … } from 'vitest'` resolves to the very same implementation for
authors who prefer imports.** Both paths are the one api.qa-owned harness — a
suite may use either or both, and opts out of the globals by declaring
`export const globals = false` (§3). The intent is "publish the tests you
already have": vitest's API is deliberately Jest-compatible, so an existing
Jest **or** vitest suite should port with zero or near-zero changes. The same
suite file then runs unmodified in two places: under real vitest (via
vitest-pool-workers, where `globals: true` or explicit imports both work) on
the author's machine, and under the shim inside api.qa's sandbox. Authoring
ergonomics are real vitest; execution is a ~300-line harness we fully control
and version.

---

## 3. The runner dialect: `axp-exec@1`

A second suite dialect beside `api.qa/suite@1`.

**The artifact.** One self-contained ES module (`.mjs` semantics, ESM only).
The test API is present as **globals by default** — `describe` / `it` / `test`
/ `expect` / `beforeEach` / `afterEach` / `beforeAll` / `afterAll` are injected
into the isolate's global scope before the module evaluates, so an existing
Jest or vitest file needs no import line to find them. Bare imports are still
permitted for the import style: exactly `'vitest'` (the injected harness, same
implementation as the globals) and `'axp:suite'` (the injected run context).
Everything else must be bundled in by the author (esbuild/rollup — their
choice, their build; api.qa resolves nothing). A suite opts out of the globals
with `export const globals = false` — because globals must be installed before
the module evaluates, the runner reads this marker from the pinned suite bytes
while assembling the module set (a cheap static check on the verbatim source it
already holds, §4) and generates the entry without the global-install step, so
the isolate's global scope stays clean and the suite must `import … from
'vitest'`. Shape (globals form — no test-API import needed):

```js
import { target, vars, http } from 'axp:suite'   // http = the brokered fetch
// describe / it / expect are globals — no import required (globals: true default)

describe('quote → checkout flow', () => {
  let quoteId
  it('creates a quote', async () => {
    const r = await http(`${target}/quotes`, { method: 'POST', body: JSON.stringify({ vin: vars.vin }) })
    expect(r.status).toBe(201)
    quoteId = (await r.json()).id
  })
  it('reads it back', async () => {
    const r = await http(`${target}/quotes/${quoteId}`)
    expect(r.status).toBe(200)
  })
})
```

The same file with `import { describe, it, expect } from 'vitest'` at the top
runs identically — the import resolves to the injected harness, the globals and
the module export are one implementation. (`globalThis.fetch` inside the
isolate is the same brokered channel — `axp:suite`'s `http` is a convenience,
not a second privilege level.)

**Jest/vitest compatibility.** The shim implements the common jest/vitest
surface so a suite written for either runs unmodified — "publish your existing
tests," not "port them." In scope:

- **Structure & hooks** — `describe`, `it`, `test` (alias of `it`), `it.only` /
  `it.skip` / `describe.only` / `describe.skip`, and the four hooks
  (`beforeEach` / `afterEach` / `beforeAll` / `afterAll`), all async-aware.
- **`expect` core** — `toBe`, `toEqual`, `toStrictEqual`, `toMatchObject`,
  `toContain` / `toContainEqual`, `toHaveLength`, `toHaveProperty`,
  `toBeTruthy` / `toBeFalsy` / `toBeNull` / `toBeUndefined` / `toBeDefined`,
  `toBeGreaterThan` / `toBeGreaterThanOrEqual` / `toBeLessThan` /
  `toBeLessThanOrEqual`, `toBeCloseTo`, `toMatch` (string/RegExp), `toThrow`
  (message/RegExp/constructor forms), and the `.not` modifier over all of them.
- **Async assertions** — `await expect(promise).resolves.<matcher>` and
  `.rejects.<matcher>`.
- **`expect.*` helpers, as feasible** — `expect.any`, `expect.anything`,
  `expect.objectContaining`, `expect.arrayContaining`,
  `expect.stringContaining`, `expect.stringMatching`, as asymmetric matchers
  inside `toEqual` / `toMatchObject`.

Out of scope, and honest about why — this is untrusted code in a constrained
isolate with a brokered fetch, not a full test runner on a Node host:

- **No snapshot matchers** (`toMatchSnapshot` / `toMatchInlineSnapshot`) — there
  is no snapshot file store in the isolate and nothing to write one to; the
  matcher is unimplemented and fails with the matcher named (never a silent
  pass), same as any unknown matcher.
- **No module mocking** — `vi.mock` / `jest.mock` / `vi.fn` / `jest.fn` /
  `vi.spyOn` and friends are absent. The isolate resolves no modules to mock
  (§2: only the four injected modules exist), and mock-based tests generally
  test the author's own bundled code, not the target's observable HTTP
  behavior, which is the only thing `axp-exec@1` is scoped to assert (§7).
- **No fake timers** (`vi.useFakeTimers` / `jest.useFakeTimers`) — absent in v1
  unless a later version finds a trivially-supportable subset; `Date` is not
  frozen (§5.5) and time-dependent assertions are not evidenceable from the
  transcript anyway.
- **No global test config side-channels** — `vi.setConfig`, custom reporters,
  `expect.extend` with author matchers (an author matcher would be code
  computing its own verdict — see §5.3), and environment/setup-file hooks are
  not honored. The only recognized suite-level export is `globals` (opt-out)
  and `environments` (§3).

The boundary is enforced, not merely documented: any unrecognized matcher,
`expect.extend`, or `vi`/`jest` mock call reaches a shim stub that **fails the
run with the symbol named** rather than passing silently. A suite leaning on an
out-of-scope feature learns exactly which one at the first call, in the
evidence.

**Card declaration.** `interfaces.testSuite` gains nothing mandatory; the
`runner` member takes the new value, and the artifact is named one of two ways:

*Form A — same-origin URL (symmetric with the declarative dialect):*

```json
{
  "interfaces": {
    "testSuite": {
      "url": "/.well-known/axp/suite.mjs",
      "digest": "sha256:<64 hex of the module's exact bytes>",
      "runner": "axp-exec@1",
      "environment": "public"
    }
  }
}
```

*Form B — npm distribution (the founder's requirement):*

```json
{
  "interfaces": {
    "testSuite": {
      "runner": "axp-exec@1",
      "npm": {
        "package": "@fi-vin/axp-suite",
        "version": "1.4.2",
        "integrity": "sha512-<SRI of the published tarball bytes>",
        "digest": "sha256:<64 hex of the extracted suite module's exact bytes>"
      },
      "environment": "public"
    }
  }
}
```

**How an npm package is pinned immutably.** Version ranges are refused —
`version` MUST be an exact semver. The registry is fixed: the tarball is
fetched from `https://registry.npmjs.org/<pkg>/-/<name>-<version>.tgz` (no
card-supplied registry URL — that would be an SSRF/steering vector).
Three locks, each independently sufficient to detect substitution:

1. **npm immutability** — a published `name@version` tarball cannot be
   replaced on the public registry (unpublish leaves a hole, never a swap).
2. **`integrity`** — the SRI sha512 over the tarball's exact bytes, verified
   by api.qa after download and cross-checkable against the registry's own
   `dist.integrity`. This is the same value in any consumer's lockfile.
3. **`digest`** — sha256 over the exact bytes of the **suite module inside
   the tarball** (the file named by the package's `exports["./axp-suite"]`
   entry, falling back to `axp.suite.mjs` at the package root). This digest —
   not the tarball hash — is THE suite digest: it is what the verdict cites,
   what keys the verdict cache, and what Form A would have pinned. Forms A
   and B publishing the same bytes produce the same suite identity.

A run is therefore reproducible from the card alone: fetch tarball → verify
`integrity` → extract entry → verify `digest` → execute those exact bytes.
Any mismatch fails the check by a named reason; nothing partial runs.

**Card-gate rules carried over from `api.qa/suite@1` unchanged:** absent
`digest` fails without fetching; malformed digest fails; Form A `url`
off-origin or non-routable fails without fetching; unknown `runner` still
fails, never skips; `environment` defaults to `"public"` and selects from the
environments the module exports (`export const environments = { public: { vars: {…} } }`,
read via the harness before the run body executes).

---

## 4. Execution model in api.qa

```
POST /suite  (runner: axp-exec@1)          card path: published-test-suite check
        │                                            │
        ▼                                            ▼
  resolve artifact (inline / stored / npm / same-origin URL)
        │  verify integrity + digest — refuse before anything executes
        ▼
  env.SUITE_LOADER.get(`exec:${suiteDigest}:${HARNESS_VERSION}`, () => ({
    compatibilityDate: PINNED_COMPAT_DATE,        // api.qa's constant, not the card's
    mainModule: 'entry.mjs',                      // api.qa's wrapper, not the suite
    modules: {
      'entry.mjs':  { js: HARNESS_ENTRY },        // installs globals (unless opted out) → import suite → collect → run → report
      'vitest':     { js: VITEST_SHIM },          // describe/it/expect harness — same impl as the globals
      'axp:suite':  { js: CONTEXT_MODULE },       // target, vars, http
      'suite.mjs':  { js: suiteSource },          // THE published code, verbatim
    },
    env: { REPORTER: ctx.exports.SuiteReporter({ props: { runId } }) },   // the ONLY binding
    globalOutbound: ctx.exports.SuiteEgressGateway({ props: { origin, methods, budget, runId } }),
    limits: { cpuMs: EXEC_CPU_MS, subRequests: MAX_EXEC_REQUESTS },
  }))
        │
        ▼
  stub.getEntrypoint().fetch('https://run/')  raced against EXEC_DEADLINE_MS
        │
        ▼
  verdict = judge(assertion log + egress transcript)   → evidence bundle → attest
```

The isolate id is the content hash Cloudflare recommends: suite digest +
harness version. Same bytes → same id → warm reuse is a pure optimization;
different bytes → new isolate by construction. No state may live in the
isolate between runs (Cloudflare guarantees nothing about reuse), and none
does: the reporter binding streams events out as they happen.

`compatibilityDate` is **api.qa's pinned constant**, recorded in the evidence
bundle — the card does not choose runtime semantics. Bumping it is a verifier
release, exactly like bumping the harness.

---

## 5. Replay and verdict independence — the old concern, satisfied

The retired sentence protected a real property: *a verdict must be a function
of recorded evidence, not of whatever the judged party's code felt like doing
at run time; and replay must be possible.* The executable tier keeps that
property by construction rather than by prohibition. Note what "replay" has
always meant here: the declarative judge (`checks.ts`) re-derives verdicts
from the stored bundle without re-fetching. The executable tier meets the
same bar.

1. **The artifact pin.** The verdict names `suiteDigest` — sha256 of the
   exact module bytes executed (and, for npm, the tarball `integrity`
   alongside). "Passes suite `sha256:1f0c…`" stays durable and citable;
   the anti-Goodhart argument of A.8.5 is unchanged. The `attested` posture
   of `verifySuite` carries over verbatim: an attested executable run refuses
   to start without an **externally supplied** `expectedDigest` — the pin is
   held outside the building fleet, same as today (ax-7x3).

2. **The brokered transcript IS the evidence.** Every request the suite
   causes exists only because the egress gateway delivered it, so the
   gateway records all of it: method, URL, request headers/body digest,
   response status/headers/body (bodies capped and digest-addressed, same
   discipline as existing evidence items), ordinal, wall-clock. Code cannot
   make an unrecorded observation of the target — there is no unbrokered
   channel. The transcript slots into the existing evidence-bundle shape
   under `exec:<ordinal>` roles.

3. **The assertion log is structured evidence, not stdout.** The `expect`
   shim reports every assertion through the `REPORTER` service binding as a
   typed event: `{ suite: [...describe path], test, assertion: { matcher,
   expectedJson, actualJson, pass }, ordinal }`, plus test begin/end and
   uncaught errors. The verdict — pass iff every test passed and none were
   skipped-by-crash and at least one test ran (the vacuous-pass guard,
   ported) — is computed by the **parent** from this log. The loaded code
   never returns "I passed"; it returns raw assertion events the parent
   judges. That is the same observe/judge split the declarative path enforces.
   **The globals default changes nothing here.** The `expect` reachable as a
   global is the identical shim instance reachable via `import … from
   'vitest'` — the same `describe`/`it` collector and the same reporter
   channel back it. Whichever way the suite reaches the API, every assertion
   still emits a typed event to the `REPORTER` binding and the parent still
   computes the verdict from that log; there is no globals-only path that
   returns a boolean, sets a "passed" flag, or bypasses the reporter. A suite
   cannot vote on its own outcome by any route, imported or global, because
   the only thing either route exposes is assertion *events* — the pass/fail
   arithmetic lives in the parent, outside the isolate.

4. **Re-judgeable without re-execution.** verdict = pure function of
   (suiteDigest, harnessVersion, compatibilityDate, assertion log, transcript,
   caps). All inputs are in the bundle, so any holder of the report re-derives
   the verdict — the same replay property `attest.ts` documents ("the evidence
   bundle inside the report lets anyone re-judge the verdicts"). `verdictDigest`
   folds in the per-test verdicts and stays timing/seed-independent.

5. **Deterministic re-execution (secondary, best-effort).** A replay harness
   MAY re-run the isolate with the gateway serving responses FROM the
   recorded transcript (keyed by method+URL+ordinal) instead of the network —
   the module bytes are pinned, so drift can only come from ambient
   nondeterminism. The harness seeds `Math.random` from the run `seed` and
   the run records start time; `Date` is not frozen. Re-execution is a
   diagnostic, not the attestation basis — the attestation basis is (4).
   The spec text promises re-judgeability (MUST) and leaves re-execution
   as MAY, so the guarantee stated is the guarantee delivered.

6. **The signing posture is untouched.** Ed25519 `SIGNING_KEY` remains a
   Worker secret outside every fleet's write access; the loaded isolate has
   **no** path to it (its `env` contains only the reporter stub — §6), so a
   suite cannot sign, cannot see the key, and cannot influence anything but
   the evidence it legitimately generates.

---

## 6. The sandbox security model

The loaded suite is **hostile third-party code**, full stop — treated as such
even when the publisher is friendly. Layers, innermost first:

**Binding starvation.** `env` contains exactly one entry: the reporter
service stub. No KV, no DOs, no `SIGNING_KEY`, no vars, no loader binding
(so no recursive loading), no Cache API access to api.qa's namespace. The
isolate can compute, call `fetch` (brokered), and report assertions. Nothing
else exists in its world.

**Egress: everything brokered, nothing ambient.** `globalOutbound` is set to
the `SuiteEgressGateway` entrypoint — never left unspecified (unspecified
would inherit api.qa's own network access, which is the one catastrophic
misconfiguration this design forbids; a unit test pins that the field is
always present). The gateway re-applies, per request, the same gates
`test-suite.ts` applies today plus the new ones the boundary needs:

| Gate | Declarative today | Executable tier |
| --- | --- | --- |
| Publicly-routable target | `isPubliclyRoutableSameOrigin` | same function, same refusal set (private ranges, metadata IPs, etc.) |
| Target-origin pinning | resolved URLs re-gated same-origin | every brokered request must be same-origin with the card; off-origin → gateway throws, run fails with the URL named |
| No recursion / self-grading | `kind:'check'` refused | requests to api.qa's own origin refused by the gateway; suite has no loader binding |
| Methods | GET/HEAD only | GET/HEAD by default; card MAY declare `"methods": ["GET","HEAD","POST","PUT","PATCH","DELETE"]` ⊆ that set to enable write flows. Consent argument: the declarative gate refused writes because a card-declared suite is "a stranger's document" aimed at api.qa; here every write is origin-pinned to the publisher's **own** surface, and the publisher declared the method set in its own card — self-consent, the same consent that lets `verifyPinnedSpec` write in pinned mode. Writes against anyone *else* remain impossible (origin pin). |
| Request budget | 25 requirements, fail-not-truncate | `MAX_EXEC_REQUESTS = 50` brokered requests, enforced twice: `limits.subRequests` (throws in-isolate) and a gateway counter (authoritative). Budget breach FAILS the run — never silently stops. |
| Wall clock | `SUITE_DEADLINE_MS = 20s` | `EXEC_DEADLINE_MS = 30s`, parent-side race; breach fails, never passes partial results |
| CPU | n/a (no code ran) | `limits.cpuMs = EXEC_CPU_MS` (5 000 initial) — the isolate throws on breach |
| Cooldown / politeness | `DomainCooldown` DO | unchanged — the run still enters through the same cooldown gate before the isolate is created |
| `connect()` raw sockets | n/a | delivered to the gateway, which refuses them categorically in v1 |

**Response filtering.** The gateway strips `Set-Cookie` and never forwards
api.qa-internal headers in either direction; the suite sees the target's
responses and nothing of api.qa's own traffic.

**Module surface.** Only the four modules of §4 exist; the suite cannot
import anything api.qa did not put in `modules`. `compatibilityFlags` is
api.qa's choice (empty in v1 — no `nodejs_compat`, so no Node built-in
surface to reason about).

**Observability.** `tails` MAY attach a Tail Worker for `console.log`
capture into the run record (diagnostics only, never judged).

**Blast radius if V8 isolation itself fails:** the isolate's reachable world
is the reporter stub and the gateway — both narrow, parent-owned RPC
surfaces that treat their caller as untrusted. That is the posture Cloudflare
itself recommends given their "sharper than a hardware VM" candor.

---

## 7. What an executable suite may assert

The declarative dialect stays scoped to endpoint probes. `axp-exec@1` is
scoped to **the target's own observable HTTP behavior**, now including:

- multi-step capture-chained workflows (create → poll → assert → delete),
  with real control flow, retries, and derived values — the fi.vin / buy.vin
  sprint shapes;
- write-inclusive e2e flows where the card declares the methods (§6);
- content assertions beyond the declarative matcher set (schema checks the
  author bundles in, invariants across responses, ordering/pagination laws);
- negative-path assertions (a 402 offer flow, a 404 contract, idempotency).

Out of scope, enforced by the sandbox rather than by prose: anything
off-origin, anything against api.qa itself, self-grading (there is no check
API in the isolate to invoke), and any assertion about time/infrastructure
the transcript cannot evidence. The honest-limit clause of A.8.5 carries
over: passing your own suite proves you keep your own promise, and the
verdict states counts (tests, assertions, requests, distinct pathnames,
methods used) so a decorative suite is visible for what it is.

---

## 8. Spec amendment (axp.org.ai)

Fits the estate discipline: **spec + verifier land together; version and
digest move only where a pinned artifact changes.** `published-test-suite`
is *registered, not pinned* (A.8's own standing example), so
`apis-ax-axp@2.3.0` — 22 requirements, digest `9063cb3e…` — **does not move**.
The `axp:optional-interfaces` registry row is unchanged (`interfaces.testSuite`
→ `published-test-suite` → A.8.5). What moves: `PROTOCOL.md` **0.6.0 → 0.7.0**
with a changelog entry recording this ruling, and api.qa's check ships the
executable path in the same landing.

### Proposed A.8.5 revision

*The card table gains two rows and one edit:*

| member | required | rule |
| --- | --- | --- |
| `runner` | no | the suite dialect; defaults to `"api.qa/suite@1"` (declarative JSON, interpreted). This version also defines `"axp-exec@1"` (an executable ECMAScript module, run under A.8.5.1). Any other value **MUST** fail, never skip. |
| `npm` | no | (`axp-exec@1` only) `{ "package", "version", "integrity", "digest" }` — an exact published version on the public npm registry, pinned by the tarball's SRI `integrity` **and** the extracted suite module's `digest`. Exactly one of `url` / `npm` **MUST** be present for `axp-exec@1`. |
| `methods` | no | (`axp-exec@1` only) the HTTP methods the suite may cause, a subset of GET, HEAD, POST, PUT, PATCH, DELETE; defaults to GET/HEAD. Every request remains origin-pinned to this card's origin. |

*The paragraph "**The suite is data, never code**" is replaced by:*

> **The suite is data — and code is data.** A suite is always identified,
> pinned, and cited as exact bytes; what varies by `runner` is whether a
> verifier *interprets* those bytes (`api.qa/suite@1`, declarative JSON) or
> *executes* them (`axp-exec@1`, an ES module) inside a fully isolated,
> egress-brokered sandbox (A.8.5.1). Executing a target-published suite does
> not surrender verdict independence, because independence never rested on
> non-execution. It rests on four properties, each a **MUST** for a verifier
> that implements `axp-exec@1`:
>
> 1. **the artifact pin** — the verdict names the digest of the exact code
>    executed (and, for npm distribution, the tarball integrity beside it);
> 2. **the brokered transcript** — the executed code has no network path
>    except a verifier-owned gateway, and every request it causes and every
>    response the target returned is recorded in the evidence bundle;
> 3. **the assertion log** — each assertion outcome is recorded as typed
>    evidence by the verifier's own harness, and the verdict is computed by
>    the verifier from that log, never accepted from the executed code;
> 4. **re-judgeability** — the verdict is a pure function of the pinned
>    digest, the harness version, the transcript, and the assertion log, all
>    carried in the bundle, so any holder of the report re-derives the
>    verdict without re-executing anything. Deterministic re-execution
>    against the recorded transcript is a **MAY**, a diagnostic, and is not
>    what attestation rests on.
>
> A verifier **MUST NOT** execute a published suite outside such a sandbox:
> no ambient credentials or verifier-internal bindings reachable from the
> suite, all egress brokered and re-gated (public-routability, card-origin
> pinning, the declared method set, a request budget, CPU and wall-clock
> limits), and refusal — never truncation — on any breach.

*New subsection A.8.5.1 (normative, sketch):* the sandbox obligations of §6
of this document — binding starvation, mandatory brokered egress, the gate
table, budget/deadline semantics (breach fails, never truncates), the
vacuous-pass guard (a suite in which no test ran **MUST** fail), and the
verdict-statement duty (digest, runner, environment, test/assertion/request
counts, distinct pathnames, methods used).

*Changelog 0.7.0:* records the ruling verbatim ("the suite is data — and code
is data, and can be executed"), that `apis-ax-axp` stays at 2.3.0 / digest
`9063cb3e…` (registered-not-pinned means no admission movement), and that the
declarative dialect is unchanged and remains the default.

### Migration / dual publication

- `api.qa/suite@1` remains fully supported, the default, and untouched — a
  card published yesterday verifies identically tomorrow.
- The `runner` member is the discriminator; one `interfaces.testSuite` object
  declares one primary suite.
- A property publishing **both** tiers adds the optional `suites` member — an
  array of objects each shaped like the top-level declaration. A.8 already
  rules that unknown members inside an interface object are ignored, so an
  older verifier sees only the top-level (declarative) suite and stays
  correct; a current verifier runs all entries and reports each under its own
  digest. Recommended posture for estate properties: top-level declarative
  (maximum verifier compatibility), executable in `suites`.

**Authoring ergonomics — the existing-suite path.** Because the harness is
jest/vitest-global-compatible, the executable suite is not new code a property
has to write from scratch: it is the vitest suite the property **already has**.
The published-verification law already wants every estate property to carry a
vitest suite; that suite — globals or imports, whichever style it was written
in — becomes the published `axp-exec@1` artifact with little to no change. Two
properties matter for this to hold:

- **No source edits to adopt.** A Jest- or vitest-shaped file needs no import
  rewrite (globals are the default) and no matcher rewrite (the in-scope set
  above covers the common surface). The author's remaining work is the build,
  not the tests: bundle to one self-contained ESM (§3), and swap network calls
  for the injected brokered `http` / `axp:suite` target so the run is
  origin-pinned and recorded.
- **Still runs under real vitest locally.** The same file keeps passing under
  the author's own `vitest` — `globals: true` and explicit `import … from
  'vitest'` both resolve there exactly as they do in the shim — so the
  published executable suite and the property's local test run are one artifact,
  not two that can drift. "Publish the tests you already have" is the whole
  adoption cost.

---

## 9. Phased implementation scope (api.qa)

Verdict-affecting phases land behind the AXP 0.7.0 spec release; Phases 1–2
are inert until Phase 3 wires them to a verdict.

**Phase 0 — spec amendment (S).** The A.8.5 revision + A.8.5.1 + changelog in
`axp.org.ai/spec/PROTOCOL.md`; regenerate `public/protocol.md`. No digest
movement (§8). Files: `spec/PROTOCOL.md`, build output.

**Phase 1 — the vitest shim + assertion protocol (M).** New
`src/exec-harness/` in api.qa: the harness (describe/it/test + hooks,
async-aware, fail-on-zero-tests), exposed **both** as globals (installed by
the entry before the suite evaluates — the default) and as the `vitest`-aliased
module export, one implementation behind both; the `axp:suite` context module;
the harness entry (install globals unless opted out → import suite → collect →
run → drain reporter); and the typed assertion-event schema shared with the
judge. Pure code, unit-testable under real vitest without any loader. The shim's
matcher surface is the jest/vitest-compatibility set of §3 (structure/hooks,
`expect` core matchers with `.not`, `resolves`/`rejects`, and the feasible
`expect.*` asymmetric helpers); out-of-scope symbols (snapshots, `vi`/`jest`
mocks, fake timers, `expect.extend`) resolve to a stub that fails the run with
the symbol named — never a silent pass. Tests cover globals-form and
import-form suites producing identical assertion events, and a jest-shaped
fixture running unmodified. Files: `src/exec-harness/*` (new),
`test/exec-harness.test.ts` (new).

**Phase 2 — the Worker Loader runtime (M).** `wrangler.jsonc` gains
`"worker_loaders": [{ "binding": "SUITE_LOADER" }]` (types via
`wrangler types`; local dev works in workerd today; production needs the
open-beta flag on the account — a deploy prerequisite to note in the file
header). New `src/exec-runner.ts`: builds `WorkerCode`, the
`SuiteEgressGateway` and `SuiteReporter` `WorkerEntrypoint` classes
(exported from `worker.ts`), limits, deadline race, transcript/assertion
collection into evidence items. Reuses `http.ts` (`isPubliclyRoutableSameOrigin`),
`digest.ts`. Vitest-pool-workers-based integration tests exercising the gates
(off-origin refused, budget breach fails, deadline fails, zero-test fails).
Files: `wrangler.jsonc`, `src/exec-runner.ts` (new), `src/worker.ts`
(export the two entrypoints), `test/exec-runner.test.ts` (new).

**Phase 3 — POST /suite executable path + evidence/attestation (M).**
`POST /suite` accepts `runner: "axp-exec@1"` with inline `suiteText` (module
source) or stored digest — same registry (`cache.putSuiteText` is
content-addressed bytes; nothing cares that they are JS), same attested
`expectedDigest` refusal, same verdict cache keyed by (target, digest, env,
seed). New `ExecSuiteReport` type beside `SuiteReport`; `attest.ts`
`verdictDigest` folds in per-test verdicts; `render.ts` markdown face.
Files: `src/worker.ts`, `src/types.ts`, `src/attest.ts`, `src/render.ts`,
`src/exec-runner.ts`.

**Phase 4 — the card path (M).** `discovery.ts` `TestSuiteClaim` learns
`runner`/`npm`/`methods`; `test-suite.ts` gate widens: `gateTestSuiteCard`
accepts the new runner (Form A same-origin URL reuses the existing
fetch+digest gates byte-for-byte), a new `gateExecSuiteModule` replaces
`gateTestSuiteDocument` for the exec branch; `checks.ts`
`published-test-suite` runs the exec path and judges from the recorded
assertion log + transcript (observe/judge split preserved — the judge never
re-executes). The declarative branch is untouched — additive dispatch on
`runner`. Files: `src/discovery.ts`, `src/test-suite.ts`, `src/checks.ts`,
`test/test-suite.test.ts`.

**Phase 5 — npm artifact resolution (S/M).** `src/npm-artifact.ts` (new):
registry-fixed tarball URL construction, fetch, SRI sha512 verification,
tar+gzip extraction of the single entry file (DecompressionStream + a
minimal tar reader — no dependency), sha256 digest check, size cap
(1 MB module / 5 MB tarball, refusal not truncation). Registry fetches are
verifier-owned (not suite egress) but still routability-gated and budgeted.
Files: `src/npm-artifact.ts` (new), `src/test-suite.ts`, tests.

**Phase 6 — monitors + surfaces (S).** Stored exec suites schedulable by the
existing monitor registry (`suiteDigest` already flows through
`MonitorSchedulerDO`); `render.ts`/`views.ts` show runner + counts; README /
SELF-TEST / skill docs. Files: `src/monitors.ts`, `src/render.ts`,
`src/views.ts`, docs.

**Dependencies:** 0 ∥ 1 → 2 → 3 → 4 → 6, with 5 joining before 4's Form B.
**Total: 1 S (spec) + 2 S + 4 M — no L phases; nothing rewrites the
declarative path.**

**Open items to resolve at implementation time (flagged, not blocking):**
account enrollment status for the Dynamic Workers open beta on the api.qa
zone; final `EXEC_CPU_MS` after measuring real fi.vin flows; whether
`connect()` stays categorically refused past v1 (v1: yes); tarball extraction
edge-cases (pax headers) in the minimal tar reader.

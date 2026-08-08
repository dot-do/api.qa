/**
 * The card-declared PUBLISHED TEST SUITE — the gates, shared by the observe
 * side and the judge side.
 *
 * `interfaces.testSuite` lets a surface publish the workflows it holds itself
 * to. The owner's case for it: *"the service COULD publish tests for more
 * complex workflows/functionality, but it isn't required because simple crud
 * apis and/or lookups don't need that much complexity."* So it is OPTIONAL, and
 * a CRUD API that omits the key stays fully conformant — omission is
 * conformance, and nothing here can make a surface that passes today fail.
 *
 * ─── WHY THE GATES LIVE HERE AND NOT IN THE TWO CALLERS ────────────────────
 * The observe side (`discovery.ts`) decides what to FETCH; the judge side
 * (`checks.ts`) decides what the fetches MEAN. If those two derived the
 * eligibility rules separately they could disagree, and a disagreement between
 * observe and judge is the exact incoherence `validateRequirements` throws to
 * prevent. So every rule is decided ONCE, here, purely, and both sides call it.
 *
 * ─── ⚠ THE EXECUTION BOUNDARY, STATED PLAINLY ──────────────────────────────
 * A card-declared suite is A STRANGER'S DOCUMENT. It is not the api.qa
 * operator's pinned spec, and it carries none of the consent that one does.
 * There is NO third-party CODE EXECUTION: `verifySuite` interprets JSON — it
 * does not `eval`, `import`, or spawn — so the sandbox question has a concrete
 * answer, which is that the existing gates ARE the sandbox. But three of those
 * gates are calibrated for consented self-verification and are NOT sufficient
 * for a stranger's document, so this module tightens them rather than reusing
 * `verifySuite` as-is:
 *
 *   1. WRITES. `verifyPinnedSpec` sets `allowWrites: true` — "pinned mode is
 *      consent mode: the target is yours". THAT CONSENT DOES NOT EXIST HERE.
 *      The sub-run gets its own Observer with `allowWrites: false`, AND any
 *      requirement whose method is not GET/HEAD fails the check outright. Two
 *      independent layers, because reusing `verifySuite` naively re-opens this.
 *   2. TARGET STEERING. `verifySuite` takes `env.vars.baseUrl` as the target.
 *      A suite must never redirect the run: the target is pinned to the CARD'S
 *      OWN ORIGIN and `resolveEndpoint` re-gates every resolved URL same-origin,
 *      so a `baseUrl` naming another host fails closed instead of being fetched.
 *   3. BUDGET. A dedicated cap (`MAX_SUITE_REQUIREMENTS`) and a wall-clock
 *      deadline, on a private budget so a long suite cannot starve the parent
 *      run's fixed high-value probes. An over-long suite FAILS — it is NEVER
 *      truncated, because truncating would let a target hide a failing
 *      requirement past the cutoff.
 *
 * And two structural refusals:
 *   4. NO SELF-GRADING / NO RECURSION. `kind:'check'` is refused (a target must
 *      not make api.qa's own verdicts part of its self-test, and
 *      `published-test-suite` would recurse into itself); `kind:'ax-floor'` is
 *      refused (a target grading itself); `kind:'surface'` is refused
 *      (redundant with admission, which already judges those).
 *   5. SSRF is unchanged and sufficient: `isPubliclyRoutableSameOrigin` re-gates
 *      every resolved URL including post-interpolation, so `capture` chaining
 *      and `{{var}}` interpolation stay enabled — the workflow mechanism is the
 *      whole point — without opening a new fetch surface.
 *
 * ─── ⚠ DEVIATION FROM THE DESIGN, DELIBERATE AND REPORTED ──────────────────
 * The design permits `kind:'endpoint'` AND `kind:'probe'` in a card-declared
 * suite. This implementation permits `endpoint` ONLY and refuses `probe` with
 * its own named reason. A `probe` requirement resolves against the target's own
 * AXP probe MANIFEST and drags in two-phase ordering, `paramValue.fromProbe`
 * derivation, seeded over-ceiling randomization, `minDeclared` and the
 * anti-decoy query-flip — machinery that exists to interrogate AXP Clause 4/5
 * ceilings, and that has no meaning in a suite a target writes about its own
 * workflows. Refusing MORE than the design refuses cannot create an evasion:
 * the failure direction is a target being told its suite is unsupported, never
 * a requirement silently skipped. Widening to `probe` is a later, additive
 * change and does not alter any verdict reached today.
 */

import { isPubliclyRoutableSameOrigin } from './http.js'
import { sha256HexSync } from './sha256-sync.js'
import { parseSuite, parseExecSuiteDocument } from './suite-doc.js'
import {
  EXEC_MAX_DOC_BYTES,
  EXEC_MAX_MODULE_BYTES,
  VITEST_RUNNER,
  isFloorBlockedHost,
} from './exec/dialect.js'
import type { EndpointReq } from './expect.js'
import type { Suite } from './types.js'
import type { TestSuiteClaim } from './discovery.js'

/** The declarative suite dialect. */
export const SUITE_RUNNER = 'api.qa/suite@1'

/** The executable dialect (A.8.6) — re-exported so callers dispatch on one constant. */
export { VITEST_RUNNER }

/**
 * Hard cap on requirements in a CARD-DECLARED suite. Deliberately far below the
 * parent run's budget: a stranger's document gets a small, fixed allowance.
 * Exceeding it FAILS the check — never truncates (see the header).
 */
export const MAX_SUITE_REQUIREMENTS = 25

/** Wall-clock deadline for the whole sub-run, ms. A breach FAILS, never passes what it got. */
export const SUITE_DEADLINE_MS = 20_000

/** `sha256:` + exactly 64 lowercase hex. */
const DIGEST_FORMAT = /^sha256:[0-9a-f]{64}$/

/** The methods a stranger's document may cause api.qa to issue. */
const SAFE_METHODS = new Set(['GET', 'HEAD'])

export type CardGate =
  | { ok: true; url: string; digest: string }
  | { ok: false; problem: string }

export type DocumentGate =
  | { ok: true; suite: Suite; requirements: EndpointReq[]; vars: Record<string, unknown>; digest: string }
  | { ok: false; problems: string[] }

/**
 * GATE 1 — decided from the CARD ALONE, before anything is fetched.
 *
 * Everything decidable without the document is decided here so a defective
 * declaration costs no request: an off-origin url, a missing or malformed
 * digest, and an unknown runner are all refused WITHOUT fetching.
 */
export function gateTestSuiteCard(claim: TestSuiteClaim, origin: string): CardGate {
  if (claim.malformed) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite is present but is not a JSON object (got ${claim.malformedAs}) — the card claims a published test suite ` +
        'in a shape no verifier can check. Declare an object (`{ "url": …, "digest": "sha256:…" }`), or OMIT the key entirely to ' +
        'declare no test suite — omitting it is fully conforming.',
    }
  }
  if (claim.urlRaw === undefined || claim.url === '') {
    return {
      ok: false,
      problem:
        'interfaces.testSuite declares no `url` — a published suite must say where it is published. ' +
        'Omit the whole key to declare no test suite.',
    }
  }
  // The runner is a DIALECT, not a hint. An unknown one FAILS rather than
  // skipping: a card that claims a suite api.qa cannot interpret has made a
  // claim that cannot be verified, which is a defective claim, not an absence.
  // (The executable dialect never reaches this gate — callers dispatch
  // `runner: "api.qa/vitest@1"` to `gateVitestSuiteCard` first.)
  if (claim.runner !== SUITE_RUNNER) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares runner ${JSON.stringify(claim.runner)}, which api.qa does not implement — the defined ` +
        `suite dialects are ${JSON.stringify(SUITE_RUNNER)} (declarative, interpreted) and ${JSON.stringify(VITEST_RUNNER)} ` +
        '(executable, A.8.6). This is a FAILURE, not a skip: ' +
        'the card claims a suite this verifier cannot interpret. Omit the key to declare no test suite.',
    }
  }
  // The npm identity assertion belongs to the executable dialect (A.8.6.6):
  // under a declarative runner it asserts provenance about bytes that are
  // never instantiated as a module, which is a claim in a shape this dialect
  // cannot carry — refused, per A.8.5.2 ("a `package` under a declarative
  // runner MUST fail").
  if (claim.packageName !== undefined) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares package ${JSON.stringify(claim.packageName)} under the declarative runner ` +
        `${JSON.stringify(SUITE_RUNNER)} — the npm identity assertion is meaningful only under ${JSON.stringify(VITEST_RUNNER)}. ` +
        'A defective declaration fails; omit the key to declare no test suite.',
    }
  }
  // The pin is REQUIRED — see judgeTestSuiteDocument for why a suite needs one
  // where a Digital Link description file does not.
  if (claim.digest === undefined) {
    return {
      ok: false,
      problem:
        'interfaces.testSuite declares no `digest` — a published suite MUST be digest-pinned ("sha256:<64 hex>" over the document\'s ' +
        'exact bytes). Unpinned, the target can rewrite its assertions between advertising them and being held to them, so the ' +
        'artifact a report cites would not be the artifact that was judged. Refused without fetching.',
    }
  }
  if (!DIGEST_FORMAT.test(claim.digest)) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares digest ${JSON.stringify(claim.digest)}, which is not of the form "sha256:<64 lowercase hex>" — ` +
        'refused without fetching.',
    }
  }
  const declaredOrigin = urlOriginOrUndefined(claim.url)
  if (declaredOrigin === undefined) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares url ${JSON.stringify(claim.urlRaw ?? claim.url)}, which does not resolve to a URL — ` +
        'refused without fetching.',
    }
  }
  if (declaredOrigin !== origin) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares its suite at ${claim.url} (origin ${declaredOrigin}), which is NOT the target origin ${origin} — ` +
        "a card must not publish another origin's suite; api.qa refused to fetch it",
    }
  }
  if (!isPubliclyRoutableSameOrigin(claim.url, origin)) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares its suite at ${claim.url}, which is not a publicly-routable target for ${origin} — ` +
        'refused without fetching (SSRF guard)',
    }
  }
  return { ok: true, url: claim.url, digest: claim.digest }
}

/**
 * GATE 2 — decided from the fetched DOCUMENT plus the card.
 *
 * PURE and synchronous, over the exact bytes the target served. The digest is
 * RE-COMPUTED here (never trusted from an observe-phase scalar) so a replayed
 * bundle re-derives the pin match from the stored text — which is what keeps
 * the anti-Goodhart pin meaningful after serialization.
 */
export function gateTestSuiteDocument(
  claim: TestSuiteClaim,
  suiteText: string,
  cardDigest: string,
): DocumentGate {
  const problems: string[] = []

  // ── The pin, before anything in the document is believed ────────────────
  // WHY A SUITE MUST BE PINNED although a Digital Link description file need
  // not be: a description file is a DESCRIPTION, and a verdict citing the
  // observed bytes is complete. A test suite is THE TARGET'S OWN ASSERTIONS
  // ABOUT ITSELF. Unpinned, the target can rewrite it between advertising and
  // running, so the artifact a report cites is not the artifact that was
  // judged. The pin is also what makes the claim durable and citable —
  // "passes suite sha256:1f0c…" survives; "passes its current suite" does not.
  // Same anti-Goodhart argument `verifySuite`'s own `expectedDigest` makes.
  const actual = sha256HexSync(suiteText)
  const expected = cardDigest.slice('sha256:'.length)
  if (actual !== expected) {
    return {
      ok: false,
      problems: [
        `suite digest mismatch: the card pins sha256:${expected} but the document served at ${claim.url} hashes to sha256:${actual} — ` +
          'the published suite is not the one the card claims. Refusing to run it.',
      ],
    }
  }

  let suite: Suite
  try {
    suite = parseSuite(suiteText)
  } catch (e) {
    return {
      ok: false,
      problems: [`suite document did not parse as an api.qa Suite: ${(e as Error).message}`],
    }
  }

  // ── Environment selection ───────────────────────────────────────────────
  if (!Object.hasOwn(suite.environments, claim.environment)) {
    const defined = Object.keys(suite.environments)
    problems.push(
      `the card selects environment ${JSON.stringify(claim.environment)}, which suite "${suite.name}" does not define ` +
        `(it defines ${defined.length ? defined.map((n) => JSON.stringify(n)).join(', ') : 'none'})`,
    )
  }

  // ── The cap. FAIL, never truncate ───────────────────────────────────────
  if (suite.requirements.length > MAX_SUITE_REQUIREMENTS) {
    problems.push(
      `suite declares ${suite.requirements.length} requirements, over the ${MAX_SUITE_REQUIREMENTS} api.qa runs for a ` +
        'card-declared suite. This FAILS rather than running the first ' +
        `${MAX_SUITE_REQUIREMENTS}: truncating would let a target hide a failing requirement past the cutoff.`,
    )
  }

  // ── Kind eligibility: no self-grading, no recursion ──────────────────────
  const requirements: EndpointReq[] = []
  for (const req of suite.requirements) {
    if (req.kind === 'endpoint') {
      requirements.push(req)
      continue
    }
    if (req.kind === 'check') {
      problems.push(
        `requirement "${req.id}" is kind:'check' — a card-declared suite must not make api.qa's own verdicts part of a target's ` +
          'self-test (and published-test-suite would recurse into itself). Refused.',
      )
    } else if (req.kind === 'ax-floor') {
      problems.push(
        `requirement "${req.id}" is kind:'ax-floor' — a card-declared suite must not assert the target's own AX grade. Refused.`,
      )
    } else if (req.kind === 'surface') {
      problems.push(
        `requirement "${req.id}" is kind:'surface' — the admission spec already judges the surfaces; a self-published suite ` +
          'restating them verifies nothing. Refused.',
      )
    } else if (req.kind === 'probe') {
      problems.push(
        `requirement "${req.id}" is kind:'probe' — api.qa does not run probe-manifest requirements from a card-declared suite in ` +
          `${SUITE_RUNNER}. A probe resolves against the target's own AXP probe manifest and carries the Clause 4/5 ceiling ` +
          'machinery (paramValue derivation, seeded over-ceiling amounts, the anti-decoy query flip), which has no meaning in a ' +
          "suite a target writes about its own workflows. Express the workflow as kind:'endpoint' requirements.",
      )
    }
  }

  // ── Writes. A stranger's document gets GET/HEAD only ────────────────────
  // Checked on the DECLARED method (pre-interpolation) as well as at the fetch
  // site: a `{{var}}` in `method` cannot be resolved without running, so a
  // method that is not a literal safe verb is refused up front rather than
  // being allowed to resolve into one.
  for (const req of requirements) {
    const method = req.method.toUpperCase()
    if (!SAFE_METHODS.has(method)) {
      problems.push(
        `requirement "${req.id}" declares method ${JSON.stringify(req.method)} — a card-declared suite runs GET/HEAD ONLY. ` +
          'Pinned-spec mode allows writes because the target is the operator\'s own; a suite named by a stranger\'s card carries ' +
          'no such consent, so api.qa will not be directed to issue a write against it.',
      )
    }
  }

  if (problems.length > 0) return { ok: false, problems }
  if (requirements.length === 0) {
    // Unreachable via parseSuite (its non-vacuity guard rejects an empty list),
    // but a suite of entirely-refused kinds would have been caught above; keep
    // the guard so a future kind widening cannot introduce a vacuous pass.
    return { ok: false, problems: ['suite declares no runnable requirements — refusing to vacuously pass'] }
  }

  return {
    ok: true,
    suite,
    requirements,
    vars: { ...(suite.environments[claim.environment]?.vars ?? {}) },
    digest: cardDigest,
  }
}

/** The origin of a URL, or undefined if it does not parse. */
function urlOriginOrUndefined(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The EXECUTABLE dialect gates — `api.qa/vitest@1` (A.8.5 seam + A.8.6)
// ---------------------------------------------------------------------------

/** Exact published semver — never a range (A.8.5: `version` conditional rule). */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** An npm package name (scoped or unscoped). */
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

/** A JS identifier — the only legal `export` member shape. */
const EXPORT_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The reference module CDN the native-serving obligation (A.8.6.6) derives url-less coordinates from. */
export const NATIVE_SERVING_BASE = 'https://pkg.do'

export type VitestCardGate =
  | {
      ok: true
      /** The resolved artifact address (declared url, or derived from the coordinate). */
      url: string
      digest: string
      /** Discriminated by the CARD: `package` present or pathname ends `.mjs` ⇒ module. */
      kind: 'document' | 'module'
      environment: string
      exportName?: string
      /** The npm identity assertion — RECORDED in the verdict, never adjudicated. */
      npm?: { package: string; version: string }
    }
  | { ok: false; problem: string }

/**
 * GATE 1 for the executable dialect — decided from the CARD ALONE, before
 * anything is fetched. The A.8.5 seam:
 *
 *   { url?, package?, version?, export?, digest, environment?, runner }
 *
 * - at least one of `url` / `package`; `package` requires an EXACT `version`;
 * - `digest` required, `"sha256:" + 64 lowhex`, the SOLE byte authority;
 * - the address MAY be off-origin (a versioned module-CDN URL is the SDK
 *   norm — the digest, never the host, is the provenance); a non-routable or
 *   floor-blocked address is refused WITHOUT being fetched;
 * - url-less coordinates resolve via the A.8.6.6 native-serving scheme
 *   (`https://pkg.do/<package>@<version>/index.mjs`);
 * - artifact KIND is decided BY THE CARD (package present or pathname ends
 *   `.mjs` ⇒ module), never by sniffing bytes;
 * - `export` is an identifier and module-kind-only; a module artifact defines
 *   no environments, so only the implicit `"public"` selects there.
 */
export function gateVitestSuiteCard(claim: TestSuiteClaim, _origin: string): VitestCardGate {
  if (claim.malformed) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite is present but is not a JSON object (got ${claim.malformedAs}) — the card claims a published test suite ` +
        'in a shape no verifier can check. Declare an object, or OMIT the key entirely — omitting it is fully conforming.',
    }
  }
  // The pin, before anything else: the digest is the SOLE byte authority in
  // every addressing (A.8.6.6) — absent or malformed refuses unfetched.
  if (claim.digest === undefined) {
    return {
      ok: false,
      problem:
        'interfaces.testSuite declares no `digest` — a published suite MUST be digest-pinned ("sha256:<64 hex>" over the artifact\'s ' +
        'exact bytes). The digest is the sole byte authority in every addressing (A.8.6.6). Refused without fetching.',
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(claim.digest)) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares digest ${JSON.stringify(claim.digest)}, which is not of the form "sha256:<64 lowercase hex>" — ` +
        'refused without fetching.',
    }
  }

  // The npm coordinate — an IDENTITY ASSERTION, never a delivery channel.
  let npm: { package: string; version: string } | undefined
  if (claim.packageName !== undefined) {
    if (!NPM_NAME.test(claim.packageName)) {
      return {
        ok: false,
        problem: `interfaces.testSuite declares package ${JSON.stringify(claim.packageName)}, which is not an npm package name — refused.`,
      }
    }
    if (claim.version === undefined) {
      return {
        ok: false,
        problem:
          `interfaces.testSuite declares package ${JSON.stringify(claim.packageName)} with no \`version\` — the identity assertion ` +
          'requires the EXACT published version (A.8.5). Refused.',
      }
    }
    if (!EXACT_SEMVER.test(claim.version)) {
      return {
        ok: false,
        problem:
          `interfaces.testSuite declares version ${JSON.stringify(claim.version)} — the identity assertion requires an EXACT ` +
          'published semver, never a range (A.8.5). Refused.',
      }
    }
    npm = { package: claim.packageName, version: claim.version }
  }

  // The address: declared url, or derived from the coordinate under the
  // native-serving obligation. Neither ⇒ nothing is published.
  let url = claim.urlRaw !== undefined && claim.url !== '' ? claim.url : undefined
  if (url === undefined) {
    if (npm === undefined) {
      return {
        ok: false,
        problem:
          'interfaces.testSuite declares neither `url` nor `package` — a suite that names no location is not a published suite ' +
          '(at least one address is required, A.8.5). Omit the whole key to declare no test suite.',
      }
    }
    url = `${NATIVE_SERVING_BASE}/${npm.package}@${npm.version}/index.mjs`
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares url ${JSON.stringify(claim.urlRaw ?? url)}, which does not resolve to a URL — refused without fetching.`,
    }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      problem: `interfaces.testSuite declares url ${url}, which is not an http(s) address — refused without fetching.`,
    }
  }
  // The network floor applies to the VERIFIER's artifact fetch exactly as it
  // applies to the isolate's egress: a metadata/private/internal address is
  // refused unfetched. An OFF-ORIGIN public address is fine — the A.8.5
  // same-origin restriction is RETIRED for this dialect (revision note 0.7.0);
  // the digest, never the host, is the authority over the bytes.
  if (isFloorBlockedHost(parsed.hostname)) {
    return {
      ok: false,
      problem:
        `interfaces.testSuite declares its artifact at ${url}, which the network floor bars (metadata, link-local, loopback, ` +
        'private-range, CGNAT, ULA, or estate-internal) — refused without fetching (A.8.6.3).',
    }
  }

  // Artifact kind — decided by the CARD, never by sniffing (A.8.5).
  const kind: 'document' | 'module' = npm !== undefined || parsed.pathname.endsWith('.mjs') ? 'module' : 'document'

  if (claim.exportName !== undefined) {
    if (kind !== 'module') {
      return {
        ok: false,
        problem:
          `interfaces.testSuite declares export ${JSON.stringify(claim.exportName)} on a suite DOCUMENT — \`export\` names a ` +
          'module export and is meaningful only for a module artifact (A.8.5). A defective declaration fails.',
      }
    }
    if (!EXPORT_IDENTIFIER.test(claim.exportName)) {
      return {
        ok: false,
        problem: `interfaces.testSuite declares export ${JSON.stringify(claim.exportName)}, which is not a legal identifier — refused.`,
      }
    }
  }

  // A module artifact defines no environments: exactly the implicit
  // non-sandbox "public" exists there (A.8.6.4). Selecting any other name is
  // selecting an environment that does not exist ⇒ fail, at the card.
  if (kind === 'module' && claim.environment !== 'public') {
    return {
      ok: false,
      problem:
        `interfaces.testSuite selects environment ${JSON.stringify(claim.environment)} on a MODULE artifact — a pinned module ` +
        'defines no environments and carries exactly the implicit "public" (sandbox: false, A.8.6.4). Refused.',
    }
  }

  return {
    ok: true,
    url,
    digest: claim.digest,
    kind,
    environment: claim.environment,
    ...(claim.exportName !== undefined && { exportName: claim.exportName }),
    ...(npm !== undefined && { npm }),
  }
}

export type VitestDocumentGate =
  | {
      ok: true
      suite: Suite
      /** Declarative rows, eligible under UNCHANGED suite@1 engine semantics. */
      rows: EndpointReq[]
      testsSource: string
      moduleSource?: string
      vars: Record<string, unknown>
      sandbox: boolean
      digest: string
    }
  | { ok: false; problems: string[] }

/**
 * GATE 2 for the executable DOCUMENT addressing — pure over the exact bytes
 * served. HASH-THEN-INSTANTIATE (A.8.6.3): the digest is re-computed over the
 * one fetched buffer BEFORE anything in it is believed, the code strings are
 * extracted from that same buffer, and a mismatch means nothing is ever
 * instantiated — there is no execute-then-check ordering under any
 * circumstance.
 *
 * Declarative rows keep the UNCHANGED suite@1 rules (endpoint-only, GET/HEAD
 * only, same-origin re-gated at resolve time by the engine) — A.8.5.2:
 * "declarative rows stay home; executable tests roam above the floor."
 */
export function gateVitestSuiteDocument(
  claim: TestSuiteClaim,
  suiteText: string,
  cardDigest: string,
): VitestDocumentGate {
  const problems: string[] = []

  const docBytes = new TextEncoder().encode(suiteText).byteLength
  if (docBytes > EXEC_MAX_DOC_BYTES) {
    return {
      ok: false,
      problems: [
        `the served suite document is ${docBytes} bytes, over the ${EXEC_MAX_DOC_BYTES}-byte (1 MiB) cap of A.8.6.1 — ` +
          'an abuse circuit-breaker, not a ration; failed, never truncated.',
      ],
    }
  }

  const actual = sha256HexSync(suiteText)
  const expected = cardDigest.slice('sha256:'.length)
  if (actual !== expected) {
    return {
      ok: false,
      problems: [
        `suite digest mismatch: the card pins sha256:${expected} but the document served at ${claim.url} hashes to sha256:${actual} — ` +
          'the published suite is not the one the card claims. NOTHING was instantiated (digest fail-closed, A.8.6.3).',
      ],
    }
  }

  let suite: Suite
  try {
    suite = parseExecSuiteDocument(suiteText)
  } catch (e) {
    return {
      ok: false,
      problems: [`suite document did not parse as an api.qa/vitest@1 Suite document: ${(e as Error).message}`],
    }
  }

  if (!Object.hasOwn(suite.environments, claim.environment)) {
    const defined = Object.keys(suite.environments)
    problems.push(
      `the card selects environment ${JSON.stringify(claim.environment)}, which suite "${suite.name}" does not define ` +
        `(it defines ${defined.length ? defined.map((n) => JSON.stringify(n)).join(', ') : 'none'})`,
    )
  }

  // Declarative rows: the same kind-eligibility and write refusals the
  // suite@1 gate applies — this dialect widens NOTHING about rows.
  const rows: EndpointReq[] = []
  for (const req of suite.requirements) {
    if (req.kind === 'endpoint') {
      rows.push(req)
      continue
    }
    problems.push(
      `requirement "${(req as { id?: string }).id ?? '?'}" is kind:'${(req as { kind?: string }).kind}' — the declarative rows of an ` +
        `api.qa/vitest@1 document keep unchanged suite@1 semantics: kind:'endpoint' only. Refused.`,
    )
  }
  for (const req of rows) {
    const method = req.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      problems.push(
        `requirement "${req.id}" declares method ${JSON.stringify(req.method)} — declarative rows run GET/HEAD ONLY in both dialects ` +
          '(A.8.5.2). Mutating flows belong in the executable tests, against an environment the suite declares "sandbox": true.',
      )
    }
  }

  if (problems.length > 0) return { ok: false, problems }

  const env = suite.environments[claim.environment]!
  return {
    ok: true,
    suite,
    rows,
    testsSource: suite.tests!,
    ...(suite.module !== undefined && { moduleSource: suite.module }),
    vars: { ...env.vars },
    sandbox: env.sandbox === true,
    digest: cardDigest,
  }
}

export type VitestModuleGate =
  | { ok: true; digest: string }
  | { ok: false; problems: string[] }

/**
 * GATE 2 for the MODULE addressing (A.8.6.6 channels 2 and 3): the pinned,
 * natively served ES module. Digest fail-closed over the one fetched buffer;
 * the 4 MiB module cap (an SDK entry is a bundle). The npm coordinate, where
 * asserted, was already validated at the card gate and is RECORDED — never
 * adjudicated: no registry is contacted, and registry state cannot influence
 * the verdict.
 */
export function gateVitestModuleArtifact(
  claim: TestSuiteClaim,
  moduleText: string,
  cardDigest: string,
): VitestModuleGate {
  const bytes = new TextEncoder().encode(moduleText).byteLength
  if (bytes > EXEC_MAX_MODULE_BYTES) {
    return {
      ok: false,
      problems: [
        `the served module artifact is ${bytes} bytes, over the ${EXEC_MAX_MODULE_BYTES}-byte (4 MiB) cap of A.8.6.3 — ` +
          'failed, never truncated.',
      ],
    }
  }
  const actual = sha256HexSync(moduleText)
  const expected = cardDigest.slice('sha256:'.length)
  if (actual !== expected) {
    return {
      ok: false,
      problems: [
        `module digest mismatch: the card pins sha256:${expected} but the module served at ${claim.url} hashes to sha256:${actual} — ` +
          'the published module is not the one the card claims. NOTHING was instantiated (digest fail-closed, A.8.6.3).',
      ],
    }
  }
  return { ok: true, digest: cardDigest }
}

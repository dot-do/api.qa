/**
 * Pinned-spec mode — the X1 harness.
 *
 * A PinnedSpec is a contract document held OUTSIDE the implementing fleet's
 * write access (in the vault, in a gist, wherever — what matters is the
 * hash). The caller supplies the spec TEXT plus the digest they expect; if
 * the text doesn't hash to the pin, verification refuses before a single
 * probe fires. A fleet can therefore edit its local copy of the spec all it
 * wants — the verdict is bound to the pinned digest, and the acceptance
 * command names the digest, not the file.
 *
 * How the weekend build points its hill-climb here (local mode):
 *
 *   npx autonomous-qa verify http://localhost:8787 \
 *     --spec specs/golden-scenario.spec.json \
 *     --expect-digest <sha256 printed when the spec was ratified>
 *
 * Local runs are advisory (never attested). Definition of done = the SAME
 * spec digest passing on the deployed api.qa against the deployed target.
 */

import {
  Observer,
  normalizeTarget,
  isPubliclyRoutableSameOrigin,
  type ObserverOpts,
} from './http.js'
import { observeTarget, ROLE, parseAgentsJson, parseJsonBody, parseOpenapi } from './discovery.js'
import { runChecks } from './checks.js'
import { axScoreOf } from './grade.js'
import { sha256Hex } from './digest.js'
import { readPath } from './schema.js'
import { VERIFIER_VERSION } from './verify.js'
// The expectation engine (interpolation, endpoint resolution, capture, the
// expectation judge) lives in ./expect.js so the `published-test-suite` check
// judges a card-declared suite with the IDENTICAL code path this module uses.
// Extracted, never forked — two expectation judges that can drift is exactly
// the failure that would make conformance depend on which door asked.
import {
  captureInto,
  interpolateDeep,
  judgeExpect,
  resolveEndpoint,
  type Bindings,
} from './expect.js'
// The pure document layer (requirement-list validation + Suite parsing) lives
// in ./suite-doc.js: the observe and judge sides of the `published-test-suite`
// check both need it, and both live in modules THIS one imports, so keeping it
// here would close an import cycle. Re-exported so this module's public API is
// unchanged for `dataset.ts`, `worker.ts`, `index.ts` and the tests.
// The EVASION GUARD (`validateAppliesWhen`) travels WITH `validateRequirements`
// into that module: it is a document-layer rule, and it must run for a
// card-declared Suite exactly as it runs for a ratified PinnedSpec. Splitting
// them would leave the suite door unguarded.
import { parseSuite, validateRequirements } from './suite-doc.js'
import { SUITE_ROW_MAX_BODY_BYTES } from './test-suite.js'
export { parseSuite, validateRequirements }
import type {
  AppliesWhen,
  CheckResult,
  EndpointExpect,
  Evidence,
  EvidenceBundle,
  PinnedRequirement,
  PinnedSpec,
  Suite,
  SuiteEnvironment,
  Verdict,
} from './types.js'

export interface PinnedReport {
  $type: 'PinnedVerificationReport'
  verifier: 'api.qa'
  verifierVersion: string
  mode: 'remote' | 'local'
  target: string
  spec: { name: string; version: string; digest: string }
  verifiedAt: string
  seed: number
  passed: boolean
  requirements: CheckResult[]
  evidence: EvidenceBundle
  attested: false
}

export interface VerifyPinnedOpts extends ObserverOpts {
  mode?: 'remote' | 'local'
  seed?: number
  /** The pin. When present, spec text MUST hash to this or nothing runs. */
  expectedDigest?: string
  /**
   * Attested (production/catalog admission) verification. When true, the
   * verifier REFUSES to run without an externally-supplied `expectedDigest`:
   * the pinned contract must be pinned by a digest held OUTSIDE the building
   * fleet's write access, never read from the target repo. This makes verifier
   * independence an ENFORCED property, not an assertion — a spec silently
   * weakened in-tree cannot be re-ratified into a passing verdict because the
   * fleet does not hold the digest the attested verifier checks against.
   * Local/hermetic runs may omit it (default false).
   */
  attested?: boolean
  allowPrivateTargets?: boolean
  /**
   * Bindings pre-seeded into the capture scope BEFORE the first requirement
   * runs. This is how a reusable SUITE injects a selected ENVIRONMENT's vars
   * (baseUrl, token, seedId, …): an env var is just an author-supplied binding
   * that `{{var}}` interpolation reads EXACTLY as it reads a target-captured
   * value — the same interpolation engine, typed-whole-value + embedded-string
   * rules, and the same fail-closed on an undefined reference. Author-controlled
   * (lower risk than a target-captured value), but every resolved URL is STILL
   * re-gated same-origin + publicly-routable + non-private — no bypass. Seeded
   * into BOTH the observe scope and the judge scope so the two agree.
   */
  initialBindings?: Record<string, unknown>
  /** The `api.qa/vitest@1` execution seam — see VerifyTargetOpts.execRunner. */
  execRunner?: import('./exec/dialect.js').ExecSuiteRunner
}

/**
 * THE RATIFIED ADMISSION CONTRACT — `apis-ax-axp@2.4.0`.
 *
 * The coordinated 2.3.0 → 2.4.0 bump (AXP 0.7.0, 2026-08-08): 22 → 23
 * requirements, retiring digest 9063cb3e… . The ONE added row is
 * `check-published-test-suite` (kind: check, must: pass,
 * appliesWhen: { cardDeclares: "interfaces.testSuite" }) — declaration-armed,
 * so a card that omits the interface gains one not-applicable result and no
 * new way to fail, and a card that declares a suite and does not keep it
 * loses admission. The same release ratifies the executable dialect
 * `api.qa/vitest@1` (Appendix A.8.6) this verifier implements in src/exec/.
 *
 * The digest is sha256 over the exact bytes of the spec's
 * `apis-ax-standard.spec.json` (axp.org.ai `spec/conformance/`), and it is
 * the ONLY authority: a run pinned to this contract supplies the spec TEXT
 * plus this digest, and a text that does not hash to it never runs.
 */
export const AXP_PINNED_SPEC = {
  name: 'apis-ax-axp',
  version: '2.4.0',
  digest: 'dd3e59417e2acacd0946e14c845c2e156a437ef55724ff06a52c053885e321bf',
} as const

export function parsePinnedSpec(text: string): PinnedSpec {
  const doc = JSON.parse(text) as PinnedSpec
  if (doc.$type !== 'PinnedSpec' || !Array.isArray(doc.requirements)) {
    throw new Error('not a PinnedSpec: expected {"$type":"PinnedSpec","requirements":[...]}')
  }
  validateRequirements(doc.requirements)
  return doc
}

export async function verifyPinnedSpec(
  target: string,
  specText: string,
  opts: VerifyPinnedOpts = {},
): Promise<PinnedReport> {
  const mode = opts.mode ?? 'remote'
  // Verifier independence, enforced (ax-7x3): attested admission refuses to run
  // unless the pin is supplied from OUTSIDE the building fleet's write access.
  // Gate on the explicit `attested` flag, NOT on mode — default (non-attested)
  // callers, including every hermetic/local run, keep the in-tree convenience.
  if (opts.attested && !opts.expectedDigest) {
    throw new Error(
      'attested verification refuses to run without an externally-supplied expectedDigest: ' +
        'the pinned contract must be pinned by a digest held outside the building fleet, ' +
        'not read from the target repo. (Local/hermetic runs may omit it.)',
    )
  }
  const digest = await sha256Hex(specText)

  if (opts.expectedDigest && opts.expectedDigest !== digest) {
    // The anti-Goodhart gate: a locally edited spec fails before any probe.
    throw new Error(
      `spec digest mismatch: expected ${opts.expectedDigest}, supplied text hashes to ${digest}. ` +
        'The pinned contract is not the one this text represents — refusing to verify.',
    )
  }

  const spec = parsePinnedSpec(specText)
  const normalized = normalizeTarget(target, opts.allowPrivateTargets ?? mode === 'local')
  if ('error' in normalized) throw new Error(normalized.error)
  const origin = normalized.origin

  const seed = opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)
  // Pinned mode is consent mode: the target is yours, POST probes allowed. The
  // same consent gates the structural SSRF backstop for a private/local target.
  const observer = new Observer({
    ...opts,
    allowWrites: true,
    allowPrivate: opts.allowPrivateTargets ?? mode === 'local',
    // Pinned endpoint requirements probe REAL API endpoints, not discovery
    // surfaces: raise the body cap to the same suite-row ceiling the
    // card-declared path uses (a legitimate large JSON response must not be
    // severed mid-token and misjudged "not JSON"). An explicit caller cap
    // still wins.
    maxBodyBytes: opts.maxBodyBytes ?? SUITE_ROW_MAX_BODY_BYTES,
    // Headroom (ax-fsg/ax-0v2): the Clause-3 typed-body sampling and the
    // Clause-4 query-flip probes add a handful of fetches on top of the surface
    // + keyless + contract-diff plan; keep the budget above the worst case so a
    // budget-exhausted (status:null) observation never silently fails a
    // compliant target.
    budget: opts.budget ?? 64,
  })
  const bundle = await observeTarget(origin, observer, seed, { execRunner: opts.execRunner })

  // Extra observations demanded by the spec's endpoint requirements.
  //
  // Endpoint requirements run in requirement-array order and share a per-run
  // BINDING SCOPE: a requirement may `capture` values out of its response, and a
  // LATER requirement may interpolate them with `{{var}}` tokens into its
  // method/path/body/expect. Interpolation happens HERE, at observe time, after
  // the producing requirement has already run — the loop is sequential, so the
  // scope is populated in dependency order.
  // Pre-seed the observe scope with any environment vars (a Suite's selected
  // environment). They are ordinary bindings from the first probe's point of
  // view: {{baseUrl}}, {{token}}, {{seedId}} interpolate through the very same
  // engine capture-chaining uses.
  const bindings: Bindings = { ...(opts.initialBindings ?? {}) }
  for (const req of spec.requirements) {
    if (req.kind !== 'endpoint') continue
    const resolved = resolveEndpoint(req, origin, bindings)
    // Fail-closed: an undefined-var reference, an unparseable resolved path, or
    // a resolved URL that is off-origin/private is NEVER fetched. No evidence is
    // recorded; the judge re-derives the identical resolution failure purely
    // from the bundle and reports the same detail. This is the SSRF gate for a
    // TARGET-CONTROLLED captured value: it cannot smuggle an off-origin request.
    if (!resolved.ok) continue
    // Defense-in-depth re-gate at the fetch site: resolveEndpoint already refused
    // an off-origin/private resolved URL, but re-assert the SAME shared gate
    // immediately before observe() so a future edit between resolution and fetch
    // cannot reopen a hole (mirrors the probe-path re-gate below and the redirect
    // hop re-gate). Consented-private-same-origin still passes, exactly as
    // resolveEndpoint allowed it.
    if (!isPubliclyRoutableSameOrigin(resolved.url, origin)) continue
    const ev = await observer.observe(`pinned:${req.id}`, resolved.url, {
      method: resolved.method,
      accept: 'application/json',
      body: resolved.body,
    })
    // Capture AFTER assertions pass (judgeExpect is pure — safe to call here to
    // gate the capture). A capture path that does not resolve simply leaves the
    // var unbound, so a downstream reference fails closed, never silently skips.
    if (req.capture && judgeExpect(ev, resolved.expect).length === 0) {
      captureInto(bindings, req.capture, ev)
    }
  }

  // Probe requirements resolve against the TARGET's own card-declared probe
  // manifest (`probes.<channel>`), never against spec-hardcoded routes. The
  // manifest is adversarial input: entries that are not same-origin GETs are
  // refused WITHOUT fetching, and any unresolvable requirement fails closed —
  // never skips. Two phases, so a derived amount (paramValue.fromProbe) can
  // read a number out of a phase-1 observation: the verifier, not the
  // manifest, owns the over-ceiling amount.
  const card = parseAgentsJson(
    parseJsonBody(observer.items.find((e) => e.role === ROLE.agentsJson)),
    origin,
  )
  const probePlans = new Map<string, ProbePlan>()
  const probeReqs = spec.requirements.filter(
    (r): r is Extract<PinnedRequirement, { kind: 'probe' }> => r.kind === 'probe',
  )
  const phase1 = probeReqs.filter((r) => r.paramValue === undefined || typeof r.paramValue === 'number')
  const phase2 = probeReqs.filter((r) => typeof r.paramValue === 'object' && r.paramValue !== null)
  for (const req of [...phase1, ...phase2]) {
    // `appliesWhen` gating (AXP: the metering obligations apply IFF the
    // OBSERVED pricing model is "metered"): a non-applicable requirement is
    // never fetched and later PASSES as not applicable. Applicability is read
    // from the SOURCE probe's entry-0 evidence, which the sequential
    // [...phase1, ...phase2] order has already recorded for a spec that
    // declares the source (e.g. pricing-declared) ahead of its dependents —
    // an unobserved source APPLIES the requirement (fail closed).
    const applicability = evaluateAppliesWhen(req.appliesWhen, probeReqs, observer.items)
    if (!applicability.applies) {
      probePlans.set(req.id, {
        declared: [], entryProblems: new Map(), finalUrls: new Map(),
        notApplicable: applicability.reason,
        notApplicableMark: applicability.notApplicable,
      })
      continue
    }
    const plan: ProbePlan = {
      declared: dedupeByUrl(card.probes?.[req.probe] ?? []),
      entryProblems: new Map(),
      finalUrls: new Map(),
    }
    probePlans.set(req.id, plan)
    const min = req.minDeclared ?? 1
    if (plan.declared.length < min) {
      plan.unresolved =
        `probe manifest declares ${plan.declared.length} distinct probe(s) under "probes.${req.probe}"; ` +
        `the pinned contract requires at least ${min} — failing closed`
      continue
    }
    for (let i = 0; i < plan.declared.length; i++) {
      const entry = plan.declared[i]!
      // SHARED same-origin + publicly-routable gate (same helper as
      // monetization.probe and the probe-manifest check — no drift). Refused
      // WITHOUT fetching: a manifest cannot steer the verifier off-origin or
      // at a private/metadata address.
      if (!isPubliclyRoutableSameOrigin(entry.url, origin) || entry.method !== 'GET') {
        plan.entryProblems.set(i, `probe url ${entry.url} is not a same-origin GET — refused, fail closed`)
        continue
      }
      let url = entry.url
      if (req.paramValue !== undefined) {
        let amount: number
        if (typeof req.paramValue === 'number') {
          amount = req.paramValue
        } else {
          const { fromProbe, path, multiply, multiplyRange } = req.paramValue
          const srcReq = phase1.find((r) => r.probe === fromProbe)
          const srcEv = srcReq
            ? observer.items.find((e) => e.role === `pinned:${srcReq.id}:0`)
            : undefined
          let srcBody: unknown
          try { srcBody = JSON.parse(srcEv?.body ?? '') } catch { /* non-JSON → unresolved below */ }
          const r = readPath(srcBody, path)
          if (!r.found || typeof r.value !== 'number') {
            plan.unresolved = `probes.${fromProbe} yielded no numeric ${path} — cannot derive amount, failing closed`
            break
          }
          // Factor precedence: a fixed `multiply` pin wins; else `multiplyRange`
          // draws a SEED-RANDOMIZED factor within [lo, hi] — deterministic in
          // (seed, requirement id), so the probed amount is replayable from the
          // report yet not precomputable from the declared ceiling (AXP
          // Clause 5). A malformed range fails closed, never silently ×1.
          let factor = 1
          if (multiply !== undefined) {
            factor = multiply
          } else if (multiplyRange !== undefined) {
            const [lo, hi] = Array.isArray(multiplyRange) ? multiplyRange : [undefined, undefined]
            if (typeof lo !== 'number' || typeof hi !== 'number' || !(lo <= hi)) {
              plan.unresolved = `requirement ${req.id} carries a malformed paramValue.multiplyRange ${JSON.stringify(multiplyRange)} — expected [lo, hi] with lo <= hi, failing closed`
              break
            }
            factor = lo + seededUnit(seed, req.id) * (hi - lo)
          }
          amount = r.value * factor
        }
        if (typeof entry.param !== 'string' || entry.param.length === 0) {
          plan.unresolved =
            `probes.${req.probe} entry ${entry.url} declares no "param" member — ` +
            'cannot set the verifier-owned amount, failing closed'
          break
        }
        const u = new URL(url)
        u.searchParams.set(entry.param, String(amount))
        url = u.toString()
      }
      // Re-gate the FINAL url AFTER param injection, mirroring resolveEndpoint's
      // post-interpolation same-origin re-gate. searchParams.set can only mutate
      // the query today, so this never fires for a legit entry — but if a future
      // edit ever lets `param`/`amount` affect more than the query (a new URL
      // form, a decoded reserved char, an alternate injection site), the mutated
      // url is re-checked here and REFUSED before it is observed, instead of
      // silently going off-origin/private. The judge reports it via entryProblems.
      if (!isPubliclyRoutableSameOrigin(url, origin)) {
        plan.entryProblems.set(i, `probe url ${url} is not a same-origin GET after param injection — refused, fail closed`)
        continue
      }
      plan.finalUrls.set(i, url)
      await observer.observe(`pinned:${req.id}:${i}`, url, { accept: 'application/json' })
      // Query-flip branch proof (ax-0v2): the SAME pathname with its
      // discriminating query removed must serve 200 OK, proving the path
      // branches on its query — kills co-located decoys and the
      // pathMustServeOk pathname-granularity gap. Judge-side over already-
      // fetched evidence; the flip URL is same-origin gated here at observe.
      if (req.pathMustServeOk === true) {
        const flip = new URL(entry.url)
        flip.search = ''
        if (isPubliclyRoutableSameOrigin(flip.toString(), origin)) {
          await observer.observe(`pinned:${req.id}:${i}:flip`, flip.toString(), { accept: 'application/json' })
        }
      }
    }
  }
  const fullBundle: EvidenceBundle = { ...bundle, items: observer.items, bindings }

  // Judge (pure over the bundle).
  const surfaceChecks = runChecks(fullBundle)
  const axScore = axScoreOf(surfaceChecks)
  const results: CheckResult[] = []

  // The judge rebuilds the capture scope INCREMENTALLY, in the same requirement
  // order, reading response bodies straight out of the bundle. This is what
  // makes judging pure over the bundle AND order-respecting: a `{{var}}`
  // referenced before it is produced fails closed with the same undefined-var
  // detail the observe phase saw, and a replay of a stored bundle re-judges
  // identically without any re-fetch. Pre-seeded with the SAME environment vars
  // as the observe scope so the two scopes are identical by construction (an
  // env var, like a capture, is data in the run — not a fetch).
  const judgeBindings: Bindings = { ...(opts.initialBindings ?? {}) }

  for (const req of spec.requirements) {
    if (req.kind === 'surface') {
      const idMap = { 'llms.txt': 'llms-txt', 'agents.json': 'agents-json', 'icp.json': 'icp-json', openapi: 'openapi' } as const
      const base = surfaceChecks.find((c) => c.id === idMap[req.surface])
      // Pinned tightening for the openapi surface: the spec may pin the
      // declared version prefix (e.g. "3.1") and a minimum operation count —
      // a generic "parses" verdict is not the same as "is the pinned contract".
      const extras: string[] = []
      if (req.surface === 'openapi' && base?.verdict === 'pass' &&
          (req.versionPrefix !== undefined || req.minOperations !== undefined)) {
        const summary = parseOpenapi(parseJsonBody(fullBundle.items.find((e) => e.role === ROLE.openapi)))
        if (req.versionPrefix !== undefined && !(summary.version ?? '').startsWith(req.versionPrefix)) {
          extras.push(`declared spec version ${summary.version === undefined ? '(none)' : `"${summary.version}"`} does not begin with "${req.versionPrefix}"`)
        }
        if (req.minOperations !== undefined && summary.operationCount < req.minOperations) {
          extras.push(`declares ${summary.operationCount} operation(s); the pinned contract requires at least ${req.minOperations}`)
        }
      }
      const verdict: Verdict = base?.verdict === 'pass' && extras.length === 0 ? 'pass' : 'fail'
      results.push({
        id: req.id, title: `surface ${req.surface} must be ${req.must}`,
        verdict,
        detail: extras.length > 0 ? extras.join('; ') : base?.detail ?? 'surface not judged',
        evidence: base?.evidence ?? [],
      })
    } else if (req.kind === 'ax-floor') {
      results.push({
        id: req.id, title: `AX score ≥ ${req.minScore}`,
        verdict: axScore.points >= req.minScore ? 'pass' : 'fail',
        detail: `AX ${axScore.points}/10 (floor ${req.minScore})`, evidence: [],
      })
    } else if (req.kind === 'check') {
      // `appliesWhen` gating, judged PURELY from the bundle (the same
      // derivation the observe phase ran): a non-applicable pinned check
      // passes as not applicable — this is how a free-model target passes
      // check-offers-402 instead of being wrongly failed on it.
      const applicability = evaluateAppliesWhen(req.appliesWhen, probeReqs, fullBundle.items)
      if (!applicability.applies) {
        // `verdict` STAYS 'pass' — `passed` is every(v === 'pass'), and a fourth
        // Verdict member would flip every free-model target passing today. The
        // STRUCTURED `notApplicable` marker is how an agent tells "passed
        // because verified" from "passed because never applicable" without
        // string-matching prose. The CI reporters map it to a JUnit <skipped/>.
        results.push({
          id: req.id, title: `check ${req.check} must ${req.must}`, verdict: 'pass',
          detail: applicability.detail ?? `${applicability.reason} — passes as not applicable`,
          evidence: applicability.notApplicable?.reason === 'not-declared' ? [ROLE.agentsJson] : [],
          ...(applicability.notApplicable && { notApplicable: applicability.notApplicable }),
        })
        continue
      }
      // Bind a MUST clause to a SPECIFIC api.qa check, not the coarse floor.
      const c = surfaceChecks.find((sc) => sc.id === req.check)
      const verdict: Verdict = c?.verdict === 'pass' ? 'pass' : 'fail'
      // A card-declaration gate that could not READ the card applied this
      // requirement by fail-closed rule, not because the interface was declared.
      // Say so: the armed check's own skip line would otherwise report the key
      // as "absent" when the truth is the card was unreadable.
      const failClosedNote = applicability.failClosed ? ` — NOTE: ${applicability.reason}` : ''
      results.push({
        id: req.id, title: `check ${req.check} must ${req.must}`,
        verdict,
        detail:
          (c === undefined
            ? `unknown check "${req.check}" — not produced by api.qa runChecks; cannot pass`
            : c.verdict === 'pass'
              ? `check ${req.check} passed: ${c.detail}`
              : `check ${req.check} verdict '${c.verdict}' (must be 'pass'): ${c.detail}`) + failClosedNote,
        evidence: c?.evidence ?? [],
      })
    } else if (req.kind === 'endpoint') {
      // Re-resolve interpolation/capture-chaining PURELY from the judge scope
      // (rebuilt from the bundle). A resolution failure — undefined `{{var}}`,
      // unparseable path, or an off-origin/private resolved URL — is a hard fail
      // that was NEVER fetched.
      const resolved = resolveEndpoint(req, origin, judgeBindings)
      if (!resolved.ok) {
        results.push({
          id: req.id, title: `${req.method} ${req.path}`, verdict: 'fail',
          detail: resolved.detail, evidence: [],
        })
        continue
      }
      const ev = fullBundle.items.find((e) => e.role === `pinned:${req.id}`)
      const problems = judgeExpect(ev, resolved.expect)
      const verdict: Verdict = problems.length === 0 ? 'pass' : 'fail'
      // Bind captures for downstream requirements — mirrors the observe phase
      // exactly (same bodies, same capture-on-pass gate), so the two scopes are
      // identical by construction.
      if (verdict === 'pass' && req.capture) captureInto(judgeBindings, req.capture, ev)
      results.push({
        id: req.id, title: `${req.method} ${resolved.url}`, verdict,
        detail: verdict === 'pass' ? 'behaved as pinned' : problems.join('; '),
        evidence: [`pinned:${req.id}`],
      })
    } else if (req.kind === 'probe') {
      const plan = probePlans.get(req.id)!
      if (plan.notApplicable !== undefined) {
        results.push({
          id: req.id, title: `probe ${req.probe}`, verdict: 'pass',
          detail: `${plan.notApplicable} — passes as not applicable`,
          evidence: [],
          ...(plan.notApplicableMark && { notApplicable: plan.notApplicableMark }),
        })
        continue
      }
      if (plan.unresolved !== undefined) {
        results.push({
          id: req.id, title: `probe ${req.probe}`, verdict: 'fail',
          detail: plan.unresolved, evidence: [ROLE.agentsJson],
        })
        continue
      }
      // Interpolate this probe's `expect` through the SAME judge-scope binding
      // path an `endpoint` requirement uses (env-seeded vars AND captures
      // chained from an earlier requirement), so a {{var}} inside e.g.
      // expect.paths[].equals resolves instead of being compared as the
      // LITERAL string '{{var}}' (a silent, misleading FAIL with no hint the
      // token was never resolved). An undefined reference fails CLOSED with
      // the same clear detail resolveEndpoint gives the endpoint path — never
      // a spurious literal-string mismatch. This is judge-side only (the
      // already-fetched probe evidence is just re-compared) — no new fetch, so
      // no new SSRF surface; the probe URL itself was already gated in phase
      // 1/2 above, unaffected by this.
      const expectResolved = interpolateDeep(req.expect, judgeBindings)
      if ('error' in expectResolved) {
        results.push({
          id: req.id, title: `probe ${req.probe}`, verdict: 'fail',
          detail: `requirement ${req.id} references ${expectResolved.error}`,
          evidence: [ROLE.agentsJson],
        })
      } else {
        const expect = expectResolved.value as EndpointExpect
        const problems: string[] = []
        const evidence: string[] = []
        plan.declared.forEach((entry, i) => {
          const refused = plan.entryProblems.get(i)
          if (refused !== undefined) {
            problems.push(`#${i} ${entry.url}: ${refused}`)
            return
          }
          const role = `pinned:${req.id}:${i}`
          evidence.push(role)
          const ev = fullBundle.items.find((e) => e.role === role)
          const ps = judgeExpect(ev, expect)
          // Anti-decoy rule: the probed pathname must also have answered a
          // 200 `OK` envelope somewhere in this same run — a path that can
          // only ever say EMPTY/BLOCKED is a dedicated decoy, not a branch.
          if (req.pathMustServeOk === true) {
            const finalUrl = plan.finalUrls.get(i) ?? entry.url
            let pathname: string | undefined
            try { pathname = new URL(finalUrl).pathname } catch { /* unparseable → fails below */ }
            if (pathname === undefined || !okPathnamesOf(fullBundle).has(pathname)) {
              ps.push(`pathname ${pathname ?? finalUrl} was never observed answering 200 with an "OK" envelope in this run — the probe path does not demonstrably branch on its query (decoy endpoint)`)
            }
            // Query-flip branch proof (ax-0v2): the same path with its query
            // STRIPPED must answer 200 OK — a path that returns the same
            // EMPTY/BLOCKED with no query does not branch on its query.
            const flipEv = fullBundle.items.find((e) => e.role === `pinned:${req.id}:${i}:flip`)
            const flipProblems = judgeExpect(flipEv, { status: 200, paths: [{ path: 'type', equals: 'OK' }] })
            if (flipProblems.length > 0) {
              ps.push(`query-flip: the same path without its query did not answer 200 OK (${flipProblems.join('; ')}) — the probe path does not branch on its query`)
            }
          }
          if (ps.length > 0) problems.push(`#${i} ${plan.finalUrls.get(i) ?? entry.url}: ${ps.join('; ')}`)
        })
        const verdict: Verdict = problems.length === 0 ? 'pass' : 'fail'
        results.push({
          id: req.id,
          title: `probe ${req.probe} (${plan.declared.length} declared)`,
          verdict,
          detail: verdict === 'pass' ? 'every declared probe behaved as pinned' : problems.join('; '),
          evidence,
        })
      }
    } else {
      // A spec kind this verifier does not implement must fail LOUDLY: a
      // silent pass (or skip) would let a newer contract vacuously clear.
      results.push({
        id: (req as { id: string }).id ?? 'unknown',
        title: 'unknown requirement kind',
        verdict: 'fail',
        detail: `unknown requirement kind "${(req as { kind?: string }).kind}" — verifier too old for this spec`,
        evidence: [],
      })
    }
  }

  return {
    $type: 'PinnedVerificationReport',
    verifier: 'api.qa',
    verifierVersion: VERIFIER_VERSION,
    mode,
    target: origin,
    spec: { name: spec.name, version: spec.version, digest },
    verifiedAt: fullBundle.fetchedAt,
    seed,
    passed: results.every((r) => r.verdict === 'pass'),
    requirements: results,
    evidence: fullBundle,
    attested: false,
  }
}

// ---------------------------------------------------------------------------
// Reusable suite / collection mode (Postman collections + environments)
// ---------------------------------------------------------------------------

export interface SuiteReport {
  $type: 'SuiteVerificationReport'
  verifier: 'api.qa'
  verifierVersion: string
  mode: 'remote' | 'local'
  target: string
  suite: { name: string; version: string; digest: string; environment: string }
  verifiedAt: string
  seed: number
  passed: boolean
  requirements: CheckResult[]
  evidence: EvidenceBundle
  attested: false
}

export interface VerifySuiteOpts extends ObserverOpts {
  mode?: 'remote' | 'local'
  seed?: number
  /** The pin. When present, SUITE text MUST hash to this or nothing runs. */
  expectedDigest?: string
  /**
   * Attested (production/catalog admission) verification — same enforced
   * independence as VerifyPinnedOpts.attested: refuse to run without an
   * externally-supplied `expectedDigest` (ax-7x3). Default false.
   */
  attested?: boolean
  allowPrivateTargets?: boolean
  /**
   * Explicit target override. When omitted, the selected environment's string
   * `baseUrl` var IS the target — that is what makes "same suite, different
   * environment → different target" work by environment selection alone.
   */
  target?: string
  /**
   * DATA-DRIVEN iteration bindings: one dataset row's fields, layered ON TOP of
   * the selected environment's vars for THIS run only (row fields override /
   * extend env vars). This is Newman's `--iteration-data`: the same ratified
   * suite runs once per row, each row's `{fieldName: value}` map pre-seeding the
   * binding scope so `{{field}}` interpolates into paths/bodies/headers. A row is
   * AUTHOR-provided but UNTRUSTED for SSRF: if a row sets `baseUrl` it becomes
   * this iteration's target and STILL re-passes `normalizeTarget`; interpolated
   * probe URLs stay gated by `resolveEndpoint`. Iterations are independent — each
   * call rebuilds bindings from env+row, so a capture in one row never leaks into
   * the next.
   */
  rowBindings?: Record<string, unknown>
}

/**
 * Run a reusable Suite against a selected ENVIRONMENT. A Suite is a PinnedSpec
 * parameterized by the environment's vars, so this DELEGATES to
 * `verifyPinnedSpec` — the env vars pre-seed the binding scope (`initialBindings`)
 * and every downstream mechanism (interpolation, capture-chaining, the SSRF
 * re-gate on resolved URLs, the requirement loop) is reused unchanged.
 *
 * The anti-Goodhart digest pin is on the SUITE text and is checked HERE, before
 * parse and before any probe. The re-expressed inner PinnedSpec has a different
 * digest, so the delegated call is told NOT to re-gate on it.
 *
 * Fail-closed environment selection: an unknown environment name, or an
 * environment that supplies neither an explicit target nor a string `baseUrl`,
 * throws before anything runs. A referenced-but-undefined env VAR is caught
 * downstream by the same undefined-`{{var}}` fail-closed path a capture uses.
 */
export async function verifySuite(
  suiteText: string,
  envName: string,
  opts: VerifySuiteOpts = {},
): Promise<SuiteReport> {
  const mode = opts.mode ?? 'remote'
  // Attested independence (ax-7x3): refuse to run without an out-of-band pin.
  if (opts.attested && !opts.expectedDigest) {
    throw new Error(
      'attested suite verification refuses to run without an externally-supplied expectedDigest: ' +
        'the pinned suite must be pinned by a digest held outside the building fleet, ' +
        'not read from the target repo. (Local/hermetic runs may omit it.)',
    )
  }
  const digest = await sha256Hex(suiteText)

  // Anti-Goodhart gate: content-address the SUITE and refuse before parsing or
  // probing if the supplied text is not the ratified suite.
  if (opts.expectedDigest && opts.expectedDigest !== digest) {
    throw new Error(
      `suite digest mismatch: expected ${opts.expectedDigest}, supplied text hashes to ${digest}. ` +
        'The pinned suite is not the one this text represents — refusing to verify.',
    )
  }

  const suite = parseSuite(suiteText)
  if (!Object.hasOwn(suite.environments, envName)) {
    const defined = Object.keys(suite.environments)
    throw new Error(
      `unknown environment "${envName}" — suite "${suite.name}" defines ` +
        `${defined.length ? defined.map((n) => `"${n}"`).join(', ') : '(no environments)'}`,
    )
  }
  const env: SuiteEnvironment = suite.environments[envName]!
  // Row fields (data-driven iteration) layer ON TOP of the environment's vars:
  // a dataset row overrides / extends env vars for this iteration only. With no
  // rowBindings this is exactly `{ ...env.vars }`, so a plain suite run is
  // unchanged. A row-supplied `baseUrl` therefore becomes THIS iteration's
  // target and is re-gated by normalizeTarget below (inside verifyPinnedSpec) —
  // author-provided but never trusted to steer the request off-origin/private.
  const vars: Record<string, unknown> = { ...env.vars, ...(opts.rowBindings ?? {}) }
  const target =
    opts.target ?? (typeof vars.baseUrl === 'string' ? (vars.baseUrl as string) : undefined)
  if (target === undefined) {
    throw new Error(
      `environment "${envName}" supplies no string "baseUrl" var and no explicit target was given — ` +
        'cannot resolve a target to run the suite against',
    )
  }

  // Re-express the suite as a PinnedSpec parameterized by the selected env.
  const specText = JSON.stringify({
    $type: 'PinnedSpec',
    name: suite.name,
    version: suite.version,
    requirements: suite.requirements,
  })
  const report = await verifyPinnedSpec(target, specText, {
    ...opts,
    mode,
    // The SUITE digest is the pin; it was checked above (including the attested
    // out-of-band requirement). The re-expressed inner PinnedSpec has a
    // DIFFERENT digest, so do NOT re-gate on it — clear both the expected digest
    // and the attested flag so the inner call does not refuse the (intentionally
    // absent) inner pin.
    expectedDigest: undefined,
    attested: false,
    // The selected environment's vars (plus any data-driven row fields layered
    // on top) pre-seed the capture scope. The SSRF gates (normalizeTarget on the
    // baseUrl/target inside verifyPinnedSpec, resolveEndpoint's same-origin
    // re-gate on interpolated URLs) still apply.
    initialBindings: vars,
  })

  return {
    $type: 'SuiteVerificationReport',
    verifier: 'api.qa',
    verifierVersion: report.verifierVersion,
    mode: report.mode,
    target: report.target,
    suite: { name: suite.name, version: suite.version, digest, environment: envName },
    verifiedAt: report.verifiedAt,
    seed: report.seed,
    passed: report.passed,
    requirements: report.requirements,
    evidence: report.evidence,
    attested: false,
  }
}

// ---------------------------------------------------------------------------
// Probe-requirement plumbing
// ---------------------------------------------------------------------------

interface ProbeEntry {
  method: string
  url: string
  param?: string
}

/** Per-requirement resolution of the card-declared probe manifest. */
interface ProbePlan {
  /** Declared entries for the channel, deduped by full URL. */
  declared: ProbeEntry[]
  /** Fail-closed reason that dooms the whole requirement (never a skip). */
  unresolved?: string
  /** Per-entry refusals (non-same-origin / non-GET) — never fetched. */
  entryProblems: Map<number, string>
  /** Final URLs actually observed (after verifier-owned param injection). */
  finalUrls: Map<number, string>
  /**
   * `appliesWhen` said this requirement does not apply to the observed target
   * (e.g. a metering probe against a free-model API). Nothing was fetched;
   * the judge reports a PASS with this reason.
   */
  notApplicable?: string
  /**
   * The STRUCTURED form of the same fact, carried into the requirement result
   * so an agent does not have to string-match `notApplicable` prose. Always the
   * `observed-value` arm here: `cardDeclares` is refused on kind:'probe' at
   * parse (see validateAppliesWhen).
   */
  notApplicableMark?: CheckResult['notApplicable']
}

/**
 * Three-way result of reading an optional-interface declaration off the card.
 *
 * THREE, not two, and that is the point: `readPath` (schema.ts) collapses "the
 * key is absent" and "an intermediate is not an object" into the same
 * `{ found: false }`, and those two states have OPPOSITE verdicts here. A
 * well-formed card that omits the key means NOT APPLICABLE; a card whose
 * `interfaces` member is the string "none" means the card is malformed and the
 * requirement APPLIES. Reusing `readPath` would silently hand an evasion the
 * same verdict as a conformance.
 */
export type CardDeclarationState =
  | { state: 'declared'; value: unknown }
  /** The card was read and well-formed; the final key is not present. */
  | { state: 'absent' }
  /** Card missing / non-2xx / non-JSON / not an object / bad intermediate. */
  | { state: 'unreadable'; why: string }

/**
 * Read an optional-interface declaration (`interfaces.<key>`) out of the
 * recorded capability card.
 *
 * PURE over the recorded evidence. It reads `ROLE.agentsJson` from the bundle —
 * the same evidence item every other card-reading check judges from — so the
 * observe phase and the judge phase agree by construction, and a replay of a
 * stored bundle re-judges identically without re-fetching.
 *
 * The verdict table this implements, and the argument for it:
 *
 *   card not fetched / non-2xx / network error / body not JSON  → unreadable
 *   body parses but is not a plain JSON object                  → unreadable
 *   an INTERMEDIATE segment exists but is not a plain object     → unreadable
 *   card well-formed, final key ABSENT                          → absent
 *   final key PRESENT with ANY value ({}, null, false, 0, "", []) → declared
 *
 * Every `unreadable` row collapses back to the fail-closed posture at the call
 * site, because in those rows THERE IS NO STATEMENT TO READ: absence IN a
 * retrieved document is a datum, absence OF the document is not. Only the
 * `absent` row is a deliberate statement of "I do not offer this", and only it
 * earns a skip.
 *
 * Presence uses `hasOwnProperty`, not truthiness — matching how the card parser
 * already arms `interfaces.digitalLink`. In JSON there is no `undefined`, so a
 * `null` value is DECLARED (and a defective declaration, which the armed check
 * then fails). That is what stops "declare it as false and get a free skip".
 *
 * An ABSENT intermediate (a card with no `interfaces` member at all) is treated
 * as `absent`, not `unreadable`: the final key is not present in a document that
 * WAS read, which is the same statement as omitting the key. A card with no
 * `interfaces` at all already fails the always-required card checks on its own.
 */
export function readCardDeclaration(items: Evidence[], path: string): CardDeclarationState {
  const ev = items.find((e) => e.role === ROLE.agentsJson)
  if (!ev) return { state: 'unreadable', why: 'the capability card was never fetched in this run' }
  if (ev.status === null) {
    return { state: 'unreadable', why: `fetching the capability card failed (${ev.error ?? 'unknown error'})` }
  }
  if (ev.status < 200 || ev.status >= 300) {
    return { state: 'unreadable', why: `GET ${ev.url} answered ${ev.status}` }
  }
  const doc = parseJsonBody(ev)
  if (doc === undefined) {
    return { state: 'unreadable', why: `${ev.url} answered ${ev.status} but its body did not parse as JSON` }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      state: 'unreadable',
      why: `${ev.url} parsed as ${doc === null ? 'null' : Array.isArray(doc) ? 'a JSON array' : `a JSON ${typeof doc}`}, not a JSON object`,
    }
  }
  const segments = path.split('.')
  let cursor: Record<string, unknown> = doc as Record<string, unknown>
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!
    if (!Object.prototype.hasOwnProperty.call(cursor, seg)) return { state: 'absent' }
    const next = cursor[seg]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return {
        state: 'unreadable',
        why: `the card's \`${segments.slice(0, i + 1).join('.')}\` is ${next === null ? 'null' : Array.isArray(next) ? 'an array' : `a ${typeof next}`}, not an object — the declaration cannot be read from a malformed card`,
      }
    }
    cursor = next as Record<string, unknown>
  }
  const last = segments[segments.length - 1]!
  if (!Object.prototype.hasOwnProperty.call(cursor, last)) return { state: 'absent' }
  return { state: 'declared', value: cursor[last] }
}

/**
 * Evaluate an `appliesWhen` condition against the recorded evidence. Two arms,
 * and they are asymmetric ON PURPOSE — see the block comment on AppliesWhen and
 * optional-interfaces.ts.
 *
 *   fromProbe    — the value at `path` inside the FIRST spec requirement
 *                  probing channel `fromProbe` (entry-0 evidence) must
 *                  deep-equal `equals` for the requirement to apply.
 *                  FAIL-CLOSED: an unobserved source, a non-JSON body, or an
 *                  unresolvable path means the requirement APPLIES —
 *                  not-applicable must be PROVEN by the observed value. A
 *                  missing probe response is an OBSERVATION FAILURE: the
 *                  verifier asked and got no answer, so it cannot distinguish
 *                  "does not apply to me" from "I am broken" or "I am evading".
 *                  Absence of evidence is not evidence.
 *
 *   cardDeclares — the requirement applies iff the capability card DECLARES the
 *                  named optional interface. Here THE CARD IS THE ANSWER: a
 *                  card that was fetched, parsed and found well-formed and that
 *                  omits the key has affirmatively said "I do not offer this",
 *                  and that statement is a datum the verifier is entitled to
 *                  believe. Every case where the card itself could not be read
 *                  collapses back into the fromProbe posture — applies, fail
 *                  closed — because in those cases there is no statement to
 *                  read. A present-but-empty value is a CLAIM, not an absence:
 *                  it ARMS the requirement, and the armed check judges (and
 *                  fails) the defective declaration.
 *
 * Pure over (requirements, items): the observe phase and the judge run the
 * identical derivation and agree by construction.
 */
function evaluateAppliesWhen(
  aw: AppliesWhen | undefined,
  probeReqs: Array<Extract<PinnedRequirement, { kind: 'probe' }>>,
  items: Evidence[],
): {
  applies: boolean
  reason: string
  detail?: string
  notApplicable?: CheckResult['notApplicable']
  /** The requirement applies only because its source could not be read. */
  failClosed?: boolean
} {
  if (aw === undefined) return { applies: true, reason: '' }

  if (aw.cardDeclares !== undefined) {
    const cardPath = aw.cardDeclares
    const st = readCardDeclaration(items, cardPath)
    if (st.state === 'unreadable') {
      return {
        applies: true,
        // `failClosed` is surfaced in the requirement detail. Without it the
        // reader sees only the armed check's own skip line — "interfaces.
        // digitalLink absent" — which is FALSE and misleading when the truth is
        // that the card could not be read at all. The verdict is the same
        // either way; the diagnosis is not.
        failClosed: true,
        reason:
          `appliesWhen source \`${cardPath}\` could not be read from the capability card ` +
          `(${st.why}) — requirement APPLIES (fail closed). A card that cannot be read has made no ` +
          'statement about what it offers; only an omission INSIDE a readable card is one.',
      }
    }
    if (st.state === 'absent') {
      return {
        applies: false,
        reason: `not applicable: the capability card declares no \`${cardPath}\``,
        detail:
          `not applicable: the capability card declares no \`${cardPath}\` — the optional interface ` +
          'is not claimed, so this requirement is not judged (omission is conformance)',
        notApplicable: { reason: 'not-declared', source: cardPath },
      }
    }
    return {
      applies: true,
      reason: `the capability card declares \`${cardPath}\` (${JSON.stringify(st.value) ?? 'undefined'})`,
    }
  }

  const srcReq = probeReqs.find((r) => r.probe === aw.fromProbe)
  const ev = srcReq ? items.find((e) => e.role === `pinned:${srcReq.id}:0`) : undefined
  let body: unknown
  try { body = JSON.parse(ev?.body ?? '') } catch { /* unresolved → applies (fail closed) */ }
  const r = readPath(body, aw.path)
  if (!srcReq || !ev || !r.found) {
    return {
      applies: true,
      reason: `appliesWhen source probes.${aw.fromProbe} ${aw.path} was not observed — requirement applies (fail closed)`,
    }
  }
  if (JSON.stringify(r.value) === JSON.stringify(aw.equals)) {
    return { applies: true, reason: `probes.${aw.fromProbe} ${aw.path} = ${JSON.stringify(aw.equals)}` }
  }
  return {
    applies: false,
    reason: `not applicable: probes.${aw.fromProbe} ${aw.path} = ${JSON.stringify(r.value)} (requirement applies only when it equals ${JSON.stringify(aw.equals)})`,
    notApplicable: { reason: 'observed-value', source: `probes.${aw.fromProbe} ${aw.path}` },
  }
}

/**
 * Deterministic unit-interval draw from (seed, key) — backs
 * `paramValue.multiplyRange`'s seed-randomized factor. Same (seed, key) →
 * same value, always; the report's seed replays the exact probed amount.
 */
function seededUnit(seed: number, key: string): number {
  let h = seed >>> 0
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 2654435761)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function dedupeByUrl(entries: ProbeEntry[]): ProbeEntry[] {
  // Distinctness keys on the FETCHED identity: fragments never reach the
  // wire, so `/e?a=1` and `/e?a=1#dup` are the same probe, not two.
  const key = (raw: string) => {
    try { const u = new URL(raw); u.hash = ''; return u.toString() } catch { return raw }
  }
  return [...new Map(entries.map((p) => [key(p.url), p])).values()]
}

/**
 * Pathnames observed answering HTTP 200 with a top-level `type: "OK"` JSON
 * envelope anywhere in the run. Memoized per bundle — the set backs the
 * `pathMustServeOk` anti-decoy rule.
 */
const okPathnamesCache = new WeakMap<EvidenceBundle, Set<string>>()
function okPathnamesOf(bundle: EvidenceBundle): Set<string> {
  const cached = okPathnamesCache.get(bundle)
  if (cached) return cached
  const out = new Set<string>()
  for (const ev of bundle.items) {
    if (ev.status !== 200) continue
    let body: unknown
    try { body = JSON.parse(ev.body ?? '') } catch { continue }
    if (!body || typeof body !== 'object' || (body as Record<string, unknown>).type !== 'OK') continue
    try { out.add(new URL(ev.url).pathname) } catch { /* unparseable url contributes nothing */ }
  }
  okPathnamesCache.set(bundle, out)
  return out
}


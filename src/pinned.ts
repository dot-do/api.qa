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
import { validateSchema, readPath } from './schema.js'
import { VERIFIER_VERSION } from './verify.js'
import {
  OPTIONAL_DECLARED_INTERFACES,
  OPTIONAL_INTERFACE_PATH_RE,
  eligibleOptionalChecks,
} from './optional-interfaces.js'
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
}

export function parsePinnedSpec(text: string): PinnedSpec {
  const doc = JSON.parse(text) as PinnedSpec
  if (doc.$type !== 'PinnedSpec' || !Array.isArray(doc.requirements)) {
    throw new Error('not a PinnedSpec: expected {"$type":"PinnedSpec","requirements":[...]}')
  }
  validateRequirements(doc.requirements)
  return doc
}

/**
 * Validate an ordered requirement list — the id-uniqueness, derived-role-key
 * collision-freeness, and colon-in-id guards. Extracted so BOTH a PinnedSpec
 * and a reusable Suite (which is a PinnedSpec parameterized by an environment)
 * run the SAME checks over the SAME requirement shape — the suite format does
 * not fork the requirement contract, it reuses it.
 */
export function validateRequirements(requirements: PinnedRequirement[]): void {
  const doc = { requirements }
  // VACUOUS-PASS GUARD. `passed: results.every(r => r.verdict === 'pass')` is
  // `true` for an EMPTY array — an all() over nothing is vacuously true. A
  // PinnedSpec (or Suite) with zero requirements would therefore ALWAYS report
  // `passed: true` regardless of what the target does, including a totally
  // broken worker: `expect(anyWorker).toConform({spec: emptySpec})` would pass
  // every time. That is the exact class of silent-faked-success this verifier
  // exists to catch, so refuse it categorically, LOUDLY, at parse — before any
  // probe fires — rather than let an empty spec verify nothing while looking
  // like a green report.
  if (doc.requirements.length === 0) {
    throw new Error(
      'a PinnedSpec with no requirements verifies nothing; refusing to vacuously pass. ' +
        'Add at least one requirement (or delete this spec/suite rather than pin an empty one).',
    )
  }
  // Every requirement id MUST be a UNIQUE, NON-EMPTY STRING. The role key
  // (`pinned:<id>`) is what observe records evidence under and what the judge
  // looks up by `find(role === 'pinned:<id>')` (FIRST match). A PinnedSpec is
  // EXTERNAL JSON parsed at runtime, so the `id: string` TS type is a
  // compile-time fiction: a runtime id can be a number, boolean, null, missing,
  // or the empty string. Any of those, or a duplicate, would let two
  // requirements share one role — observe records under it by loop POSITION,
  // the judge resolves BOTH to the first match — a self-contradictory report
  // that re-opens the observe/judge divergence. Two numeric `1`s collapse to
  // `pinned:1`; two missing ids to `pinned:undefined`. So reject any id that is
  // not a unique non-empty string LOUDLY at parse, naming the offender — never
  // `continue`-skip it. (Numeric `1` and string `"1"` both become the same
  // role, so rejecting every non-string id also stops that cross-type
  // collision.)
  const seen = new Set<string>()
  for (const req of doc.requirements) {
    const id = (req as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `invalid requirement id ${JSON.stringify(id)} in PinnedSpec — every requirement id must be ` +
          'a unique NON-EMPTY STRING. This spec is external JSON: a numeric/boolean/null/missing/empty ' +
          'id collapses to a shared role (pinned:<id>), making observe and the judge resolve different ' +
          'requirements — refusing to verify something incoherent',
      )
    }
    if (seen.has(id)) {
      throw new Error(
        `duplicate requirement id "${id}" in PinnedSpec — requirement ids must be unique ` +
          '(observe indexes evidence by position, the judge by id; a repeat makes them disagree)',
      )
    }
    seen.add(id)
  }

  // DERIVED-ROLE COLLISION GUARD. Raw-id uniqueness (above) is NOT enough: the
  // role key a requirement records/is-judged under is DERIVED, not the raw id,
  // and it is NON-INJECTIVE ACROSS KINDS:
  //   endpoint id X → the single role key  `pinned:X`              (observe/judge
  //                   both use `pinned:${id}`)
  //   probe    id Y → the role-key NAMESPACE `pinned:Y:<i>` (one per manifest
  //                   entry i), modeled here as the PREFIX `pinned:Y:`
  //   surface / ax-floor / check → record NO `pinned:` role at all, so they can
  //                   never collide on a derived role key.
  // So endpoint "x:0" derives `pinned:x:0`, which is ALSO probe "x"'s entry-0
  // role: both raw ids are distinct strings, the dup guard accepts the spec,
  // then the judge's find(role === 'pinned:x:0') resolves BOTH requirements to
  // the FIRST-recorded item — a probe judged against an endpoint's body (a
  // false-FAIL, or a vacuous false-PASS: a conformance requirement that never
  // judges the thing it names). Reject at parse if any two requirements' derived
  // role keys can collide — an endpoint's point key falling inside a probe's
  // namespace, or one probe namespace nested inside another.
  const reservations: RoleReservation[] = []
  for (const req of doc.requirements) {
    const kind = (req as { kind?: unknown }).kind
    const id = (req as { id: string }).id
    if (kind === 'endpoint') reservations.push({ id, kind: 'endpoint', point: `pinned:${id}` })
    else if (kind === 'probe') reservations.push({ id, kind: 'probe', prefix: `pinned:${id}:` })
  }
  for (let i = 0; i < reservations.length; i++) {
    for (let j = i + 1; j < reservations.length; j++) {
      const a = reservations[i]!
      const b = reservations[j]!
      const shared = roleKeysCollide(a, b)
      if (shared !== undefined) {
        throw new Error(
          `derived role-key collision in PinnedSpec: requirement "${a.id}" (${a.kind}) and ` +
            `requirement "${b.id}" (${b.kind}) both derive role key(s) under "${shared}". The role ` +
            'key is DERIVED (endpoint → pinned:<id>, probe → pinned:<id>:<i>), not the raw id, so ' +
            'two distinct raw ids can still share a role and make observe and the judge resolve ' +
            'different requirements — refusing to verify something incoherent',
        )
      }
    }
  }

  // Belt-and-suspenders: ':' is the role-key separator (`pinned:<id>[:<i>]`), so
  // a colon INSIDE a raw id is the only way a derived role key can ever be
  // ambiguous. The collision guard above already rejects the concrete colliding
  // cases; this closes the whole class categorically — including ids like "a:b"
  // that happen to collide with nothing yet still muddy role parsing.
  for (const req of doc.requirements) {
    const id = (req as { id: string }).id
    if (id.includes(':')) {
      throw new Error(
        `requirement id "${id}" in PinnedSpec contains the ':' role-key separator — a requirement ` +
          'id must not contain ":" (the derived role key is pinned:<id>[:<i>]; a colon in the raw ' +
          'id makes that key ambiguous). Rename the requirement.',
      )
    }
  }

  // THE EVASION GUARD. See optional-interfaces.ts for why it exists.
  for (const req of doc.requirements) validateAppliesWhen(req)
}

/**
 * THE EVASION GUARD — five rules, all THROWN at parse.
 *
 * `appliesWhen` is the one place in a PinnedSpec where a requirement can decide
 * NOT to judge the target. The `cardDeclares` arm makes that decision from a
 * key the TARGET writes. So it is only safe if the set of requirements that can
 * reach it is fixed by the VERIFIER, not by the spec — otherwise any MUST
 * clause becomes optional by omission and the standard quietly stops being one.
 *
 * This runs inside `validateRequirements`, which runs inside BOTH
 * `parsePinnedSpec` and `parseSuite` — i.e. before `verifyPinnedSpec` fires a
 * single probe. A spec that tries to gate an always-required check does not get
 * a lenient verdict; it gets NO verdict, loudly, with the offending requirement
 * named. There is no reviewer in the loop, which is what makes this ENFORCED
 * rather than documented.
 *
 * The rules also give FORWARD protection the pre-union verifier could not have:
 * an `appliesWhen` in a shape this verifier does not understand throws instead
 * of silently degrading into "unobservable → applies → armed check skips →
 * requirement fails", which would fail every conforming target for the wrong
 * reason.
 */
function validateAppliesWhen(req: PinnedRequirement): void {
  const raw = (req as { appliesWhen?: unknown }).appliesWhen
  if (raw === undefined) return
  const id = (req as { id: string }).id
  const kind = (req as { kind?: unknown }).kind
  const where = `requirement "${id}"`

  // Rule 2a: only `probe` and `check` requirements have ever consulted
  // `appliesWhen`. On `surface` / `ax-floor` / `endpoint` it was silently
  // ignored — a conditional-looking clause that conditions nothing is a
  // false statement in a contract document. Make it explicit and throw.
  if (kind !== 'probe' && kind !== 'check') {
    throw new Error(
      `${where} (kind:'${String(kind)}') carries an \`appliesWhen\`, which only kind:'probe' and ` +
        "kind:'check' requirements evaluate. On this kind it would be silently ignored — a " +
        'conditional-looking clause that conditions nothing. Remove it, or change the kind.',
    )
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${where} carries an \`appliesWhen\` that is not a JSON object (got ` +
        `${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}). It must be exactly ` +
        'one of { fromProbe, path, equals } or { cardDeclares }.',
    )
  }
  const aw = raw as Record<string, unknown>
  const has = (k: string) => Object.prototype.hasOwnProperty.call(aw, k)

  // Rule 1: SHAPE TOTALITY. Exactly one arm. Both, neither, or a mixed shape is
  // a spec this verifier cannot evaluate — and the union discriminates on key
  // PRESENCE (no `source:` tag, so the standard's verbatim probe block stays
  // byte-identical), which is only total because this rule rejects everything
  // else at parse.
  const fromProbeArm = has('fromProbe')
  const cardArm = has('cardDeclares')
  if (fromProbeArm === cardArm) {
    throw new Error(
      `${where} carries an \`appliesWhen\` with ${fromProbeArm ? 'BOTH' : 'NEITHER'} \`fromProbe\` ` +
        'and `cardDeclares`. Exactly one arm is legal: { fromProbe, path, equals } judges an ' +
        'OBSERVED VALUE and fails closed when it cannot be observed; { cardDeclares } judges a ' +
        'CARD DECLARATION and is not applicable when the key is absent. They are different in kind, ' +
        'so a requirement must say which one it means.',
    )
  }

  if (cardArm) {
    // Rule 2b: KIND RESTRICTION. `cardDeclares` is legal only on kind:'check'.
    // This is what makes behavioural probe requirements — the ones that pin
    // wire behaviour for always-required clauses — categorically un-gatable by
    // any card key, with no registry lookup involved at all.
    if (kind !== 'check') {
      throw new Error(
        `${where} is a kind:'probe' requirement carrying \`appliesWhen.cardDeclares\`. The ` +
          "card-declaration arm is legal ONLY on kind:'check'. A behavioural probe requirement " +
          'pins what the wire must do for an always-required clause; letting a card key switch one ' +
          'off would let a target opt out of that clause by omission. An OPTIONAL capability that ' +
          'needs behavioural probing gets a CHECK that does the probing.',
      )
    }
    if (has('path') || has('equals')) {
      throw new Error(
        `${where} mixes \`cardDeclares\` with \`${has('path') ? 'path' : 'equals'}\`. The ` +
          'card-declaration arm tests PRESENCE only — there is deliberately no value test, because ' +
          'a present-but-unexpected value would have to mean either "not applicable" or "malformed" ' +
          'and two independent implementations would resolve that differently.',
      )
    }
    const cardDeclares = aw.cardDeclares
    // Rule 5: PATH GRAMMAR. Deliberately redundant with rule 4 — it holds even
    // if the registry is later mis-edited, and it forbids `cardDeclares:
    // 'probes'`, which would gate an optional check on the AXP opt-in signal
    // itself rather than on its own interface key.
    if (typeof cardDeclares !== 'string' || !OPTIONAL_INTERFACE_PATH_RE.test(cardDeclares)) {
      throw new Error(
        `${where} carries \`appliesWhen.cardDeclares\` = ${JSON.stringify(cardDeclares)}, which is ` +
          `not a legal optional-interface card path. It must match ${String(OPTIONAL_INTERFACE_PATH_RE)} ` +
          '— exactly two segments, the first literally "interfaces", e.g. "interfaces.digitalLink". ' +
          'An optional interface is declared as a member of `interfaces`, nowhere else.',
      )
    }
    const check = (req as { check?: unknown }).check
    // Rule 3: ALLOWLIST MEMBERSHIP. The registry is keyed by CHECK id — a
    // string api.qa owns and a spec author cannot mint — not by requirement id,
    // which the author chooses freely.
    if (typeof check !== 'string' || !Object.prototype.hasOwnProperty.call(OPTIONAL_DECLARED_INTERFACES, check)) {
      throw new Error(
        `${where} tries to make check ${JSON.stringify(check)} conditional on the card declaration ` +
          `${JSON.stringify(cardDeclares)}, but that check is NOT an api.qa optional-declared ` +
          'interface. A requirement can only be skipped by omission when the capability it verifies ' +
          'is ADDITIVE — otherwise the clause it binds stops being a MUST the moment a target leaves ' +
          `a key out. Eligible checks: ${eligibleOptionalChecks().map((c) => `"${c}"`).join(', ')}. ` +
          `Pin ${JSON.stringify(check)} WITHOUT \`appliesWhen\` if you mean to demand it of everyone.`,
      )
    }
    // Rule 4: PATH BINDING. Blocks cross-wiring — arming one optional check
    // with a DIFFERENT optional interface's key, which would let a card skip a
    // check by declaring something unrelated.
    const bound = OPTIONAL_DECLARED_INTERFACES[check]!
    if (cardDeclares !== bound) {
      throw new Error(
        `${where} arms check "${check}" with \`cardDeclares\` = ${JSON.stringify(cardDeclares)}, but ` +
          `api.qa binds that check to ${JSON.stringify(bound)}. A check is armed by ITS OWN ` +
          'interface declaration; cross-wiring would let a card skip one capability by declaring ' +
          'another.',
      )
    }
    return
  }

  // The OBSERVED-VALUE arm. Behaviour is unchanged; this only rejects shapes
  // the evaluator could not have judged coherently anyway (a non-string source
  // or path silently resolves to "unobservable → applies", which reads as a
  // target failure when it is really a spec defect).
  if (typeof aw.fromProbe !== 'string' || aw.fromProbe.length === 0) {
    throw new Error(
      `${where} carries \`appliesWhen.fromProbe\` = ${JSON.stringify(aw.fromProbe)} — it must be a ` +
        'non-empty string naming a probe channel this spec also declares a requirement for.',
    )
  }
  if (typeof aw.path !== 'string' || aw.path.length === 0) {
    throw new Error(
      `${where} carries \`appliesWhen.path\` = ${JSON.stringify(aw.path)} — the observed-value arm ` +
        'needs a non-empty dot-path into the source probe body.',
    )
  }
  if (!has('equals')) {
    throw new Error(
      `${where} carries \`appliesWhen.fromProbe\`/\`path\` with no \`equals\`. The observed-value arm ` +
        'applies the requirement only when the observed value deep-equals a PINNED value; without ' +
        'one there is nothing to compare against.',
    )
  }
}

/**
 * One requirement's reservation in the DERIVED role-key space. An `endpoint`
 * reserves a single POINT (`pinned:<id>`); a `probe` reserves a whole NAMESPACE
 * (`pinned:<id>:<i>` for every manifest entry i), modeled as the PREFIX
 * `pinned:<id>:`.
 */
interface RoleReservation {
  id: string
  kind: 'endpoint' | 'probe'
  point?: string
  prefix?: string
}

/**
 * Return the shared role key (a descriptive string) if two reservations' derived
 * role-key spaces intersect, else undefined. A point falls inside a namespace
 * when it starts with the namespace prefix; two namespaces collide when one
 * prefix is a prefix of the other (nested). Two points can only match on an
 * identical raw id, which the dup guard already rejects.
 */
function roleKeysCollide(a: RoleReservation, b: RoleReservation): string | undefined {
  if (a.point !== undefined && b.point !== undefined) {
    return a.point === b.point ? a.point : undefined
  }
  if (a.point !== undefined && b.prefix !== undefined) {
    return a.point.startsWith(b.prefix) ? a.point : undefined
  }
  if (b.point !== undefined && a.prefix !== undefined) {
    return b.point.startsWith(a.prefix) ? b.point : undefined
  }
  if (a.prefix !== undefined && b.prefix !== undefined) {
    if (a.prefix.startsWith(b.prefix)) return `${a.prefix}<i>`
    if (b.prefix.startsWith(a.prefix)) return `${b.prefix}<i>`
  }
  return undefined
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
    // Headroom (ax-fsg/ax-0v2): the Clause-3 typed-body sampling and the
    // Clause-4 query-flip probes add a handful of fetches on top of the surface
    // + keyless + contract-diff plan; keep the budget above the worst case so a
    // budget-exhausted (status:null) observation never silently fails a
    // compliant target.
    budget: opts.budget ?? 64,
  })
  const bundle = await observeTarget(origin, observer, seed)

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
 * Parse + validate a reusable Suite. Reuses `validateRequirements` (the SAME
 * id-uniqueness / derived-role-collision / colon guards a PinnedSpec runs) so
 * the suite format does not fork the requirement contract. Additionally checks
 * the `environments` map shape: each entry must be `{ vars: { ... } }`.
 */
export function parseSuite(text: string): Suite {
  const doc = JSON.parse(text) as Suite
  if (doc.$type !== 'Suite' || !Array.isArray(doc.requirements)) {
    throw new Error('not a Suite: expected {"$type":"Suite","environments":{...},"requirements":[...]}')
  }
  const envs = doc.environments as unknown
  if (envs === null || typeof envs !== 'object' || Array.isArray(envs)) {
    throw new Error('Suite.environments must be an object mapping env name -> { vars: { <k>: <v> } }')
  }
  for (const [name, env] of Object.entries(envs as Record<string, unknown>)) {
    const vars = (env as { vars?: unknown } | null)?.vars
    if (env === null || typeof env !== 'object' || Array.isArray(env) ||
        vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
      throw new Error(`Suite environment "${name}" must be an object of the form { "vars": { <k>: <v> } }`)
    }
  }
  validateRequirements(doc.requirements)
  return doc
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

// ---------------------------------------------------------------------------
// Variable-capture + chaining (endpoint requirements)
// ---------------------------------------------------------------------------

/** Per-run capture scope: `varName -> value` extracted from a response body. */
type Bindings = Record<string, unknown>

type EndpointReq = Extract<PinnedRequirement, { kind: 'endpoint' }>

/** `{{var}}` token — dot/word chars only (matches a capture var name). */
const VAR_TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/** A string that is EXACTLY one `{{var}}` token, edge to edge (no surrounding text). */
const WHOLE_VALUE_TOKEN = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/

/**
 * Interpolate every `{{var}}` in a string from the binding scope. A reference
 * to an unbound var is an ERROR (fail-closed) — the literal token is never
 * emitted onto the wire. Bound values render as their primitive text; a bound
 * object/array renders as compact JSON.
 *
 * This is the STRING-coercing path, used unconditionally for the URL path and
 * method (both are always strings on the wire) and for any partial/embedded
 * token (a token surrounded by other text, e.g. `/things/{{id}}`).
 */
function interpolateString(s: string, bindings: Bindings): { value: string } | { error: string } {
  let undef: string | undefined
  const value = s.replace(VAR_TOKEN, (_m, name: string) => {
    if (!Object.hasOwn(bindings, name)) {
      undef ??= name
      return ''
    }
    const v = bindings[name]
    if (v === null || v === undefined) return ''
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
  if (undef !== undefined) return { error: `undefined capture var {{${undef}}}` }
  return { value }
}

/**
 * Interpolate a string leaf in a TYPED context (a JSON value inside `body` or
 * `expect` — e.g. `expect.paths[].equals`, an expected scalar, a body field).
 * When the ENTIRE string is a single whole-value `{{var}}` token, the RAW bound
 * value is substituted PRESERVING ITS TYPE (number / boolean / object / null),
 * so a captured numeric/boolean id chained into a typed compare or a JSON body
 * value is judged/serialized as the value it is — not falsely stringified to
 * `"1"` where `judgeExpect` would then mismatch `1`. Any other string (a
 * partial/embedded token, or plain text) falls through to string coercion.
 *
 * Surrounding whitespace is incidental ONLY for a NON-STRING binding: `'{{n}} '`
 * or `' {{n}} '` bound to a number/boolean/object/null is still a lone
 * whole-value token meant AS that value — whitespace cannot be part of the
 * intended literal — so it is TRIMMED before classification and the RAW typed
 * value is substituted (otherwise the trailing space would push it onto the
 * string-coercing path and silently false-FAIL a compliant numeric target,
 * `"1 "` vs `1`). But for a STRING binding the surrounding whitespace MAY be an
 * intended literal (`' {{tid}} '` with tid = 'hello' meaning the literal
 * ' hello '), so a string value keeps the string-coercing in-place path, which
 * substitutes the token where it sits and PRESERVES the surrounding whitespace.
 * (An edge-to-edge string token `'{{tid}}'` coerces to the identical raw string,
 * so it is unaffected either way.) A token adjacent to NON-whitespace text
 * (`'v{{n}}'`, `'{{a}}{{b}}'`) is genuine embedded interpolation and coerces.
 */
function interpolateTypedString(s: string, bindings: Bindings): { value: unknown } | { error: string } {
  const whole = WHOLE_VALUE_TOKEN.exec(s.trim())
  if (whole) {
    const name = whole[1]!
    if (!Object.hasOwn(bindings, name)) return { error: `undefined capture var {{${name}}}` }
    const v = bindings[name]
    // Preserve TYPE (trimming incidental whitespace) only when whitespace cannot
    // be part of an intended literal — i.e. the bound value is NON-STRING. A
    // STRING binding falls through to the string-coercing path below, which
    // preserves any surrounding whitespace in `s`.
    if (typeof v !== 'string') return { value: v }
  }
  return interpolateString(s, bindings)
}

/** Deep-interpolate strings inside an arbitrary JSON value (body / expect). */
function interpolateDeep(value: unknown, bindings: Bindings): { value: unknown } | { error: string } {
  if (typeof value === 'string') return interpolateTypedString(value, bindings)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      const r = interpolateDeep(item, bindings)
      if ('error' in r) return r
      out.push(r.value)
    }
    return { value: out }
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const r = interpolateDeep(v, bindings)
      if ('error' in r) return r
      out[k] = r.value
    }
    return { value: out }
  }
  return { value }
}

type ResolvedEndpoint =
  | { ok: true; method: string; url: string; body: unknown; expect: EndpointExpect }
  | { ok: false; detail: string }

/**
 * Resolve an endpoint requirement against the current binding scope: interpolate
 * method/path/body/expect, build the concrete URL, and RE-GATE it through the
 * SAME same-origin + publicly-routable + non-private check every pinned fetch
 * uses. Because a captured value is target-controlled, this gate is what stops a
 * malicious target from steering an interpolated path off-origin or at a
 * private/metadata address — such a resolution fails closed and is never
 * fetched. Deterministic in `bindings`, so observe and judge agree.
 */
function resolveEndpoint(req: EndpointReq, origin: string, bindings: Bindings): ResolvedEndpoint {
  const under = (detail: string): ResolvedEndpoint => ({
    ok: false,
    detail: `requirement ${req.id} references ${detail}`,
  })
  const m = interpolateString(req.method, bindings)
  if ('error' in m) return under(m.error)
  const p = interpolateString(req.path, bindings)
  if ('error' in p) return under(p.error)
  const b = interpolateDeep(req.body, bindings)
  if ('error' in b) return under(b.error)
  const e = interpolateDeep(req.expect, bindings)
  if ('error' in e) return under(e.error)

  let url: URL
  try {
    url = new URL(p.value, `${origin}/`)
  } catch {
    return { ok: false, detail: `requirement ${req.id} resolved to an unparseable url from path "${p.value}"` }
  }
  const resolvedUrl = url.toString()
  if (!isPubliclyRoutableSameOrigin(resolvedUrl, origin)) {
    return {
      ok: false,
      detail:
        `requirement ${req.id} resolved to off-origin/private url ${resolvedUrl} ` +
        '(a captured value must not steer the request off-origin) — refused, fail closed',
    }
  }
  return { ok: true, method: m.value.toUpperCase(), url: resolvedUrl, body: b.value, expect: e.value as EndpointExpect }
}

/**
 * Extract each `capture` dot-path from an observed response body and bind it.
 * A path that does not resolve (or a non-JSON body) leaves the var UNBOUND, so a
 * downstream `{{var}}` reference fails closed rather than silently skipping.
 */
function captureInto(bindings: Bindings, capture: Record<string, string>, ev: Evidence | undefined): void {
  let body: unknown
  try {
    body = JSON.parse(ev?.body ?? '')
  } catch {
    return
  }
  for (const [varName, path] of Object.entries(capture)) {
    const r = readPath(body, path)
    if (r.found) bindings[varName] = r.value
  }
}

/**
 * Judge one observed exchange against an expectation block. Pure; returns the
 * list of problems (empty = conforms). Shared by `endpoint` and `probe`
 * requirement kinds.
 */
function judgeExpect(ev: Evidence | undefined, expect: EndpointExpect): string[] {
  const problems: string[] = []
  if (!ev || ev.status === null) {
    problems.push(`fetch failed (${ev?.error ?? 'not observed'})`)
    return problems
  }
  const wanted = expect.status === undefined ? [200] : Array.isArray(expect.status) ? expect.status : [expect.status]
  if (!wanted.includes(ev.status)) problems.push(`status ${ev.status}, wanted ${wanted.join('|')}`)
  if (expect.contentTypeIncludes && !(ev.contentType ?? '').includes(expect.contentTypeIncludes)) {
    problems.push(`content-type ${ev.contentType}, wanted *${expect.contentTypeIncludes}*`)
  }
  if (expect.schema || expect.paths) {
    let body: unknown
    try { body = JSON.parse(ev.body ?? '') } catch { problems.push('body is not JSON') }
    if (body !== undefined) {
      if (expect.schema) {
        for (const v of validateSchema(body, expect.schema)) problems.push(`${v.path} ${v.message}`)
      }
      for (const p of expect.paths ?? []) {
        const r = readPath(body, p.path)
        if (p.exists !== undefined && r.found !== p.exists) problems.push(`path ${p.path} ${p.exists ? 'missing' : 'unexpectedly present'}`)
        if (p.equals !== undefined && (!r.found || JSON.stringify(r.value) !== JSON.stringify(p.equals))) {
          problems.push(`path ${p.path} = ${JSON.stringify(r.found ? r.value : undefined)}, wanted ${JSON.stringify(p.equals)}`)
        }
        // Closed-vocabulary membership (e.g. AXP pricing model ∈ [free, metered]).
        if (p.oneOf !== undefined &&
            (!r.found || !p.oneOf.some((v) => JSON.stringify(v) === JSON.stringify(r.value)))) {
          problems.push(`path ${p.path} = ${JSON.stringify(r.found ? r.value : undefined)}, wanted one of ${JSON.stringify(p.oneOf)}`)
        }
        // Numeric comparators — the pinned floor/ceiling. A comparator on a
        // path that is absent or non-numeric is itself a failure (the target
        // did not report the number the contract measures).
        const comparators: Array<[keyof typeof p, string, (a: number, b: number) => boolean]> = [
          ['gte', '>=', (a, b) => a >= b],
          ['lte', '<=', (a, b) => a <= b],
          ['gt', '>', (a, b) => a > b],
          ['lt', '<', (a, b) => a < b],
        ]
        for (const [key, sym, cmp] of comparators) {
          const bound = p[key] as number | undefined
          if (bound === undefined) continue
          if (!r.found || typeof r.value !== 'number') {
            problems.push(`path ${p.path} = ${JSON.stringify(r.found ? r.value : undefined)}, wanted a number ${sym} ${bound}`)
          } else if (!cmp(r.value, bound)) {
            problems.push(`path ${p.path} = ${r.value}, wanted ${sym} ${bound}`)
          }
        }
      }
    }
  }
  return problems
}

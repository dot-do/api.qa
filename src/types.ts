/**
 * api.qa core types.
 *
 * The load-bearing split: **observe** (network, impure, produces an
 * EvidenceBundle) vs **judge** (pure functions over the bundle). Same bundle
 * → same verdict, always. Replay = re-judge a stored bundle. That is the
 * whole determinism story, and it is why a hill-climbing fleet cannot argue
 * with a verdict: the evidence is in the report, digested and signed.
 */

// ---------------------------------------------------------------------------
// Evidence — what the verifier observed
// ---------------------------------------------------------------------------

/** One observed HTTP exchange. Everything a check may read lives here. */
export interface Evidence {
  /** Why this fetch happened, e.g. 'surface:llms.txt', 'probe:keyless'. */
  role: string
  url: string
  method: string
  /** Request Accept header (content-negotiation probes vary it). */
  accept?: string
  /** null when the fetch itself failed (network error, timeout). */
  status: number | null
  contentType: string | null
  /** Small allowlisted subset (link, retry-after, www-authenticate…). */
  headers: Record<string, string>
  /** Body text, truncated to the politeness byte cap. null on error. */
  body: string | null
  error?: string
  /** Wall-clock ms; excluded from the evidence digest (non-deterministic). */
  elapsedMs: number
}

export interface EvidenceBundle {
  /** Target origin, e.g. 'https://example.com'. */
  target: string
  fetchedAt: string
  /** Seed used for any sampled probes; recorded so replays reproduce. */
  seed: number
  items: Evidence[]
  /**
   * Pinned-mode variable-capture scope: `varName -> value` bound by `endpoint`
   * requirements whose `capture` map extracted a value AFTER their assertions
   * passed. Recorded as DATA in the bundle so replay re-judges identically
   * WITHOUT re-fetching — the determinism contract holds because captured
   * values, the resolved (post-interpolation) URLs (Evidence.url), and the
   * response bodies are all in the bundle. The judge rebuilds this same scope
   * purely from the stored evidence; this field is the transparent record.
   */
  bindings?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Discovery — what the target claims to be
// ---------------------------------------------------------------------------

export interface ClaimedEndpoint {
  method: string
  /** Absolute or origin-relative. */
  url: string
  auth?: string
  source: 'agents.json' | 'openapi' | 'llms.txt'
}

export interface DiscoveryReport {
  $type: 'DiscoveryReport'
  target: string
  fetchedAt: string
  /** Per-surface presence + parse status. */
  surfaces: {
    root: SurfaceStatus
    llmsTxt: SurfaceStatus
    agentsJson: SurfaceStatus
    icpJson: SurfaceStatus
    openapi: SurfaceStatus
  }
  /** Parsed claims, straight from the target's own published surfaces. */
  claims: {
    name?: string
    description?: string
    endpoints: ClaimedEndpoint[]
    mcp?: { transport?: string; command?: string; url?: string; tools?: string[] }
    offers?: Array<{ id?: string; title?: string; price?: unknown }>
    /** URL that should answer 402 with a structured offer (behavioral probe). */
    offerProbe?: { method: string; url: string }
    /**
     * Self-declared probe manifest (agents.json top-level `probes`): named
     * channels of probe URLs the target invites a pinned verifier to fire.
     */
    probes?: Record<string, Array<{ method: string; url: string; param?: string }>>
    attestation?: unknown
    openapiUrl?: string
  }
  /** sha256 of the canonicalised evidence bundle. */
  evidenceDigest: string
}

export type SurfaceStatus =
  | { present: false; status: number | null; note?: string }
  | { present: true; status: number; valid: boolean; note?: string }

// ---------------------------------------------------------------------------
// Checks + verdicts
// ---------------------------------------------------------------------------

export type Verdict = 'pass' | 'fail' | 'skip'

export interface CheckResult {
  id: string
  title: string
  verdict: Verdict
  /** Which AX-score item this check scores, if any (1-10). */
  axItem?: number
  /** Human/agent-readable reason, always references evidence. */
  detail: string
  /** roles of the Evidence items this verdict was judged from. */
  evidence: string[]
  /**
   * Structured payload for the `contract-diff` check (ax-e6b.28.4): the full
   * OpenAPI-3.1<->live diff report. Present only on that check; carried in the
   * VerificationReport so the diff is a monitorable signal, not just a verdict.
   */
  contractDiff?: ContractDiffReport
  /**
   * STRUCTURED not-applicable marker, set on a pinned REQUIREMENT result whose
   * `appliesWhen` decided the requirement does not apply to this target.
   *
   * `verdict` deliberately STAYS `'pass'`. A PinnedSpec passes iff every
   * requirement's verdict is `'pass'`; introducing a fourth `Verdict` member
   * would flip every free-model target passing today to `passed: false`. This
   * field is instead how an agent tells "passed because it was VERIFIED" from
   * "passed because it was never APPLICABLE" — without parsing prose, which is
   * not a contract. Absent on every ordinary verdict.
   *
   * The CI reporters map a marked requirement to a JUnit `<skipped/>`, which is
   * the correct JUnit semantic for a test that did not run.
   */
  notApplicable?: {
    /** Which `appliesWhen` arm decided it. */
    reason: 'not-declared' | 'observed-value'
    /** What was read: 'interfaces.digitalLink' | 'probes.pricing model'. */
    source: string
  }
}

// ---------------------------------------------------------------------------
// Contract diff (ax-e6b.28.4) — the full OpenAPI 3.1 <-> live diff report
// ---------------------------------------------------------------------------

/** breaking = a declared thing the live API violates; additive = live has MORE. */
export type DeviationClass = 'breaking' | 'additive'

/**
 * One classified deviation between the declared OpenAPI contract and the live
 * response. `location` is the JSON path into the body ($.foo.bar) for a body
 * deviation, or `(endpoint)` / `(status)` / `(content-type)` for an operation-
 * level one. `expected`/`actual` carry the contract-vs-observed values.
 */
export interface ContractDeviation {
  path: string
  method: string
  /** The declared status this deviation is judged under, or the live status. */
  status?: string
  location: string
  kind: string
  classification: DeviationClass
  expected?: string
  actual?: string
  detail: string
}

/** Per (path, method) diff of the live response against the declared contract. */
export interface ContractOperationDiff {
  path: string
  method: string
  /** Whether this operation was live-probed (GET-safe) or declaration-only. */
  probed: boolean
  liveStatus: number | null
  declaredStatuses: string[]
  deviations: ContractDeviation[]
}

/**
 * The full OpenAPI 3.1 <-> live contract diff (pure over an EvidenceBundle).
 * Same bundle → same report, byte for byte.
 */
export interface ContractDiffReport {
  $type: 'ContractDiffReport'
  target: string
  openapiValid: boolean
  /** Total declared HTTP operations across all paths. */
  operationsDeclared: number
  /** GET-safe operations that were live-probed. */
  operationsProbed: number
  perOperation: ContractOperationDiff[]
  /** Declared GET-safe operations that 404 or are unreachable (breaking). */
  declaredButAbsent: ContractDeviation[]
  /** Discovered endpoints answering 2xx that the contract never declares (additive). */
  undeclaredButPresent: ContractDeviation[]
  /** Every deviation, flattened, in a stable order. */
  deviations: ContractDeviation[]
  breaking: number
  additive: number
  clean: boolean
}

export interface AxScore {
  points: number
  max: 10
  items: Array<{ item: number; id: string; title: string; verdict: Verdict }>
}

export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'

// ---------------------------------------------------------------------------
// The verification report — the product artifact
// ---------------------------------------------------------------------------

export interface Attestation {
  alg: 'Ed25519'
  /** base64 raw public key. */
  publicKey: string
  /** base64 signature over the canonicalised report body digest. */
  signature: string
  /** sha256 hex of the canonicalised report body (sans attestation). */
  reportDigest: string
}

export interface VerificationReport {
  $type: 'VerificationReport'
  verifier: 'api.qa'
  verifierVersion: string
  /** 'remote' = held-out third-party run. 'local' = advisory, never attested. */
  mode: 'remote' | 'local'
  target: string
  verifiedAt: string
  seed: number
  discovery: DiscoveryReport
  checks: CheckResult[]
  axScore: AxScore
  grade: Grade
  /** Grade caps applied (e.g. claims-vs-behavior mismatch caps at C). */
  gradeNotes: string[]
  evidence: EvidenceBundle
  /** Digest of any pinned spec this run verified against. */
  pinnedSpecDigest?: string
  attested: boolean
  attestation?: Attestation
}

// ---------------------------------------------------------------------------
// Pinned-spec mode (the X1 harness)
// ---------------------------------------------------------------------------

/** The JSON-Schema primitive type names MiniSchema understands. */
export type MiniSchemaPrimitiveType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** Minimal structural schema — see schema.ts. */
export interface MiniSchema {
  /**
   * OpenAPI 3.0 uses a single scalar (`type: 'string'`). OpenAPI 3.1 /
   * JSON-Schema-2020-12 expresses nullability as a TUPLE (`type: ['string',
   * 'null']`) — validateSchema must accept either shape and treat an array as
   * "any of these types is acceptable" (see the 3.1-nullable fix, contract-diff
   * false-positive #1).
   */
  type?: MiniSchemaPrimitiveType | MiniSchemaPrimitiveType[]
  /**
   * OpenAPI 3.0 nullable idiom: `{ type: 'string', nullable: true }` accepts a
   * live `null` in addition to the declared `type`. Pairs with the 3.1
   * `type: [T, 'null']` array idiom above — both must fail OPEN on a
   * conformant nullable field (contract-diff false-positive #2).
   */
  nullable?: boolean
  properties?: Record<string, MiniSchema>
  required?: string[]
  items?: MiniSchema
  enum?: unknown[]
  const?: unknown
  /**
   * Closed-object flag (contract-diff, ax-e6b.28.4). Absent/`true` = the object
   * may carry undeclared fields (extra fields are ADDITIVE); `false` = the
   * contract promises these are ALL the fields (an extra field is BREAKING); an
   * object = extra fields are allowed but must match that subschema.
   */
  additionalProperties?: boolean | MiniSchema
  /**
   * `$ref` into components.schemas. Resolved RECURSIVELY (every level —
   * properties/items/additionalProperties/oneOf/anyOf/allOf, not just the
   * top-level media-type schema) by the contract enumerator's `resolveSchema`,
   * with a visited-set cycle guard AND a total-node/depth expansion budget
   * (a non-cyclic fan-out $ref DAG still expands exponentially without one).
   */
  $ref?: string
  /**
   * Composition keywords. Branches are fully resolved (no surviving `$ref`) by
   * `resolveSchema`, same as any other nested position. `allOf` is evaluated
   * conjunctively — mock generation deep-merges all branches into one value,
   * and `validateSchema` requires the value satisfy EVERY branch (previously
   * unread by both, so an `allOf` never actually constrained anything).
   */
  oneOf?: MiniSchema[]
  anyOf?: MiniSchema[]
  allOf?: MiniSchema[]
  /** String length / pattern constraints (previously unread by generator + validator). */
  minLength?: number
  maxLength?: number
  pattern?: string
  /** Array constraints (previously unread by generator + validator). */
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  /** Numeric constraints beyond minimum/maximum (previously unread). */
  multipleOf?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  /** Object constraint (previously unread). */
  minProperties?: number
}

/**
 * Expectation block shared by `endpoint` and `probe` requirements: what an
 * observed response must look like for the requirement to pass.
 */
export interface EndpointExpect {
  status?: number | number[]
  contentTypeIncludes?: string
  schema?: MiniSchema
  /**
   * dot-path assertions into the JSON body. Beyond `equals`/`exists`,
   * numeric comparators (`gte`/`lte`/`gt`/`lt`) express FLOORS and CEILINGS
   * that live in the pinned spec, not in the target — the Goodhart-correct
   * home for a ratchet threshold (e.g. `passed >= floor`): the target
   * reports the number, the PINNED contract owns the bar it must clear.
   * A comparator requires the path to resolve to a JSON number.
   */
  paths?: Array<{
    path: string
    equals?: unknown
    exists?: boolean
    /**
     * Closed-vocabulary membership: the value at `path` must deep-equal ONE of
     * these values (e.g. AXP's pricing `model` ∈ ["free","metered"]). A missing
     * path or a value outside the set is a failure.
     */
    oneOf?: unknown[]
    gte?: number
    lte?: number
    gt?: number
    lt?: number
  }>
}

/**
 * Conditional applicability for `probe` / `check` requirements. EXACTLY ONE
 * arm. The two arms differ in KIND, not degree, and the difference is the whole
 * design:
 *
 *   `fromProbe`     — the requirement applies only when an OBSERVED VALUE says
 *                     so. An unobservable source APPLIES the requirement
 *                     (fail closed), because a missing probe response is an
 *                     OBSERVATION FAILURE: the verifier asked and got no
 *                     answer, so it cannot tell "does not apply to me" from
 *                     "I am broken" or "I am evading".
 *
 *   `cardDeclares`  — the requirement applies only when the capability card
 *                     DECLARES a named optional interface. An absent key means
 *                     NOT APPLICABLE, because there the card IS the answer: a
 *                     card that was fetched, parsed and found well-formed and
 *                     that omits the key has affirmatively said "I do not offer
 *                     this". Absence IN a retrieved document is a datum;
 *                     absence OF the document is not — so every case where the
 *                     card could not be read collapses back to fail-closed.
 *
 * A non-applicable requirement passes as "not applicable" and carries a
 * STRUCTURED `CheckResult.notApplicable` marker, so an agent never has to
 * string-match prose to tell a verified pass from an unjudged one.
 */
export type AppliesWhen = AppliesWhenFromProbe | AppliesWhenCardDeclares

/**
 * OBSERVED-VALUE arm. The requirement applies only when the value at `path`
 * inside the FIRST declared probe of channel `fromProbe` (as OBSERVED in this
 * run — entry index 0) deep-equals `equals`. This is how a free-model API
 * passes AXP's metering requirements.
 *
 * FAIL-CLOSED: when the source probe was not observed, is not JSON, or the path
 * does not resolve, the requirement APPLIES — applicability can only be PROVEN
 * by the observed value, never by its absence.
 *
 * Legal on `kind: 'probe'` AND `kind: 'check'`. Semantics are byte-identical to
 * the pre-union behaviour; nothing here changed.
 */
export interface AppliesWhenFromProbe {
  fromProbe: string
  path: string
  equals: unknown
  cardDeclares?: never
}

/**
 * CARD-DECLARATION arm. The requirement applies only when the capability card
 * DECLARES the named optional interface — i.e. the dot-path resolves to a
 * PRESENT member of a reachable, well-formed card.
 *
 * PRESENCE is the whole test. There is deliberately no `equals`: a
 * present-but-unexpected value would have to mean either "not applicable" or
 * "malformed", and two independent implementers would resolve that differently.
 * A present-but-empty value (`{}`, `null`, `false`, `""`, `[]`) is a CLAIM, not
 * an absence — it ARMS the requirement, and the armed check judges it (and
 * fails it, if the declaration is defective). A card meaning "no" OMITS the key.
 *
 * There is also deliberately no `declared: false`. A negated form is an evasion
 * primitive by construction — a MUST that switches off when you ADD a card key.
 * Making it unrepresentable in the type is cheaper than forbidding it in prose.
 *
 * CONSTRAINTS, all enforced by THROWING in `validateRequirements` before any
 * probe fires:
 *   - legal ONLY on `kind: 'check'` (never on `kind: 'probe'`, which is what
 *     makes behavioural probe requirements categorically un-gatable);
 *   - `check` MUST be a key of the verifier's own
 *     `OPTIONAL_DECLARED_INTERFACES` registry;
 *   - `cardDeclares` MUST equal the exact path that registry binds to `check`;
 *   - `cardDeclares` MUST match `/^interfaces\.[A-Za-z][A-Za-z0-9]*$/`.
 */
export interface AppliesWhenCardDeclares {
  cardDeclares: string
  fromProbe?: never
  path?: never
  equals?: never
}

export type PinnedRequirement =
  | {
      id: string
      kind: 'surface'
      surface: 'llms.txt' | 'agents.json' | 'icp.json' | 'openapi'
      must: 'present' | 'valid'
      /**
       * openapi surface only: the declared spec version (`openapi:`/`swagger:`)
       * must begin with this prefix (e.g. "3.1"). A Swagger 2.0 document, or
       * one with no version member, fails.
       */
      versionPrefix?: string
      /** openapi surface only: minimum count of declared operations. */
      minOperations?: number
    }
  | {
      id: string
      kind: 'endpoint'
      method: string
      path: string
      /** JSON body for POST/PUT probes (pinned mode is consent mode). */
      body?: unknown
      expect: EndpointExpect
      /**
       * Response variable-capture. `varName -> dot-path` into the parsed JSON
       * response body (e.g. `{ id: 'id' }` or `{ id: 'data.0.id' }`). AFTER this
       * requirement's assertions pass, each dot-path is extracted and bound into
       * the per-run capture scope. A later requirement chains on the value with a
       * `{{varName}}` token in its `method` / `path` / `body` / `expect` (paths
       * and expected values) — e.g. POST /listings capturing `id`, then
       * GET /listings/{{id}}. Interpolation is resolved at OBSERVE time, in
       * requirement-array order, AFTER the producing requirement has run.
       *
       * Fail-closed contract: a `{{var}}` reference to an undefined / not-yet-
       * produced var FAILS the referencing requirement with a clear detail — the
       * literal token is NEVER sent on the wire. And the resolved (post-
       * interpolation) URL is re-gated same-origin + publicly-routable + non-
       * private, so a TARGET-CONTROLLED captured value cannot smuggle an
       * off-origin / private-IP request: it fails closed WITHOUT being fetched.
       */
      capture?: Record<string, string>
    }
  | {
      id: string
      kind: 'probe'
      /**
       * Member name under the target card's top-level `probes` manifest.
       * Open string: the closed vocabulary is the pinned standard's business,
       * not the verifier's — api.qa resolves whatever channel the spec names
       * against whatever the target's own capability card declares.
       */
      probe: string
      /** Minimum count of DISTINCT declared probe URLs. Default 1. */
      minDeclared?: number
      /**
       * When present, every declared entry for this channel must carry a
       * `param` member; the verifier sets that query parameter to this value.
       * Object form derives the value from another channel's observed JSON
       * body — the VERIFIER, never the manifest, owns the amount. `multiply`
       * scales by a fixed factor; `multiplyRange: [lo, hi]` scales by a
       * SEED-RANDOMIZED factor drawn deterministically from the run seed within
       * [lo, hi] — so the exact probed amount is not precomputable from the
       * declared ceiling (AXP Clause 5), yet fully replayable from the report's
       * seed. When both are present, `multiply` wins (the fixed pin is
       * stricter).
       */
      paramValue?: number | { fromProbe: string; path: string; multiply?: number; multiplyRange?: [number, number] }
      /**
       * Conditional applicability, OBSERVED-VALUE arm ONLY (see AppliesWhen).
       * Absent = always applies.
       *
       * A `probe` requirement may NEVER carry the `cardDeclares` arm — it is
       * excluded here at compile time and thrown on at parse time. A behavioural
       * probe requirement is how an always-required clause is verified against
       * the wire; letting a card key switch one off would let a target opt out
       * of that clause by omission. An optional capability that needs
       * behavioural probing gets a CHECK that does the probing instead.
       */
      appliesWhen?: AppliesWhenFromProbe
      /**
       * When true, every declared entry's pathname must ALSO be observed
       * answering `200` with a top-level `type: "OK"` JSON envelope somewhere
       * in the same verification run (e.g. the keyless probe or the amount-0
       * over-ceiling control). This is the anti-decoy rule: a probed path must
       * demonstrably branch on its query — a dedicated endpoint that can only
       * ever answer EMPTY/BLOCKED cannot satisfy the requirement.
       */
      pathMustServeOk?: boolean
      /** Applied to EVERY declared probe under the channel. */
      expect: EndpointExpect
    }
  | { id: string; kind: 'ax-floor'; minScore: number }
  /**
   * Require a SPECIFIC api.qa check to pass — not just the aggregate AX floor.
   * `check` is a check id produced by runChecks (checks.ts), e.g.
   * 'content-negotiation', 'offers-402', 'keyless-flow', 'agents-json'. This is
   * how a pinned contract binds a single RFC-2119 MUST to its OWN discriminating
   * verification instead of letting it ride a coarse floor that tolerates its
   * violation. A `skip` or unknown check id is a failure under `must: 'pass'`.
   */
  | {
      id: string
      kind: 'check'
      check: string
      must: 'pass'
      /**
       * Conditional applicability (see AppliesWhen): e.g. AXP pins
       * `check-offers-402` with `appliesWhen {fromProbe:'pricing', path:'model',
       * equals:'metered'}` so a free-model target passes it as not applicable
       * instead of being wrongly failed. Absent = always applies.
       */
      appliesWhen?: AppliesWhen
    }

export interface PinnedSpec {
  $type: 'PinnedSpec'
  name: string
  version: string
  requirements: PinnedRequirement[]
}

// ---------------------------------------------------------------------------
// Reusable test-suite / collection format (Postman collections + environments)
// ---------------------------------------------------------------------------

/**
 * A named ENVIRONMENT: a bag of author-supplied variables (base URL, tokens,
 * resource ids) that seed the capture scope BEFORE the first probe. Selecting a
 * different environment points the SAME suite at a different target/tokens/ids.
 * This is Postman's environment/variable concept, minus the mutable-runtime
 * globals — a suite run is deterministic in (suite text, selected environment).
 */
export interface SuiteEnvironment {
  /** `varName -> value`. A value keeps its JSON type: a number seeds a number
   * (typed whole-value interpolation preserves it), a string seeds a string. */
  vars: Record<string, unknown>
}

/**
 * A reusable test-suite / collection: an ordered list of probes (the SAME
 * `PinnedRequirement` shape a PinnedSpec uses — assertions, capture, `{{var}}`
 * chaining, all reused, not forked) plus a set of NAMED environments. A Suite is
 * a PinnedSpec parameterized by an environment: the selected environment's vars
 * pre-seed the binding scope so `{{baseUrl}}`, `{{token}}`, `{{seedId}}`
 * interpolate into paths/headers/bodies via the one interpolation engine.
 *
 * Content-addressed exactly like a PinnedSpec: the suite TEXT hashes to a digest
 * and `expectedDigest` gates BEFORE any probe runs. The environments live INSIDE
 * the suite text, so switching environments does not change the pin — the same
 * ratified suite is what runs against staging AND prod.
 */
export interface Suite {
  $type: 'Suite'
  name: string
  version: string
  /** Named environments; run selects one by name. */
  environments: Record<string, SuiteEnvironment>
  requirements: PinnedRequirement[]
}

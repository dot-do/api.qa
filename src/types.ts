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

/** Minimal structural schema — see schema.ts. */
export interface MiniSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
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
  /** One-level $ref into components.schemas, resolved by the contract enumerator. */
  $ref?: string
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
    /** The resolved value must be strictly equal to one of these (closed enum). */
    oneOf?: unknown[]
    exists?: boolean
    gte?: number
    lte?: number
    gt?: number
    lt?: number
  }>
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
       * body — the VERIFIER, never the manifest, owns the amount.
       */
      paramValue?: number | { fromProbe: string; path: string; multiply?: number }
      /**
       * Conditional applicability. When present, this requirement is judged
       * ONLY if another channel's observed body reports `path === equals`;
       * otherwise the requirement is NOT APPLICABLE and passes without a
       * probe being declared or fetched (e.g. hard-ceiling metering probes
       * apply only when `probes.pricing` reports `model: "metered"`, so a
       * free API is admissible without declaring an over-ceiling operation).
       * Fail-closed: if applicability cannot be resolved (source unreadable /
       * path absent), the requirement APPLIES.
       */
      appliesWhen?: { fromProbe: string; path: string; equals: unknown }
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
       * Conditional applicability (same contract as the probe variant): judge
       * this check ONLY when another channel's observed body reports
       * `path === equals`; otherwise NOT APPLICABLE and passes (e.g. offers-402
       * applies only when probes.pricing reports model:"metered"). Fail-closed:
       * unresolvable applicability means the check APPLIES.
       */
      appliesWhen?: { fromProbe: string; path: string; equals: unknown }
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

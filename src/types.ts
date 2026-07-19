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
}

export type PinnedRequirement =
  | {
      id: string
      kind: 'surface'
      surface: 'llms.txt' | 'agents.json' | 'icp.json' | 'openapi'
      must: 'present' | 'valid'
    }
  | {
      id: string
      kind: 'endpoint'
      method: string
      path: string
      /** JSON body for POST/PUT probes (pinned mode is consent mode). */
      body?: unknown
      expect: {
        status?: number | number[]
        contentTypeIncludes?: string
        schema?: MiniSchema
        /** dot-path assertions into the JSON body. */
        paths?: Array<{ path: string; equals?: unknown; exists?: boolean }>
      }
    }
  | { id: string; kind: 'ax-floor'; minScore: number }

export interface PinnedSpec {
  $type: 'PinnedSpec'
  name: string
  version: string
  requirements: PinnedRequirement[]
}

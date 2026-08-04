/**
 * contract-diff CLI engine (ax-gyh).
 *
 * Exposes the already-built full OpenAPI 3.1 <-> live CONTRACT DIFF (contract.ts)
 * as a first-class CLI verb with the SAME exit-code contract as verify/suite:
 * a BREAKING operation diff is a CI-gate failure. This answers the single
 * highest-value CI question — "did this deploy break the published contract?" —
 * which today only runs buried inside the advisory grade's honesty checks.
 *
 * The PUBLISHED OpenAPI spec is supplied LOCALLY (a file) and injected into the
 * evidence bundle as the `surface:openapi` role; the LIVE target is FETCHED for
 * every declared GET-safe path. Every live fetch is routed through the SAME
 * SSRF-gated Observer.observe the discovery phase uses (same-origin + publicly-
 * routable, private/metadata backstop, no off-origin/redirect hops) — this
 * module adds NO new un-gated fetch surface. The diff itself (contractDiff) is
 * a PURE judge over the resulting bundle.
 */

import { Observer, isPubliclyRoutableSameOrigin, normalizeTarget, type Fetcher } from './http.js'
import { ROLE } from './discovery.js'
import { contractDiff, enumerateOperations } from './contract.js'
import { MAX_CONTRACT_PROBES } from './discovery.js'
import type { ContractDiffReport, Evidence, EvidenceBundle } from './types.js'

export interface ContractDiffRunOptions {
  /** Injected fetch seam (tests). Defaults to global fetch via the Observer. */
  fetcher?: Fetcher
  /** Recorded in the bundle for replay parity (the diff itself is seed-free). */
  seed?: number
  /** Delay between requests, ms. Default 150 (0 for local/consented targets). */
  delayMs?: number
  /** Consented private/local target (CLI `--allow-private` / a localhost URL). */
  allowPrivate?: boolean
  /** Politeness budget (max live requests). Default: the Observer default. */
  budget?: number
}

/**
 * Run a full contract diff of a PUBLISHED OpenAPI spec against a LIVE target.
 * Returns the pure `ContractDiffReport`; the caller decides the exit code
 * (`exitCodeFor` → non-zero iff `breaking > 0`). Throws only on unusable input
 * (unparseable spec, invalid/refused target) — a reachable-but-broken contract
 * is reported, never thrown.
 */
export async function runContractDiff(
  specText: string,
  target: string,
  opts: ContractDiffRunOptions = {},
): Promise<ContractDiffReport> {
  let doc: unknown
  try {
    doc = JSON.parse(specText)
  } catch (err) {
    throw new Error(`contract-diff: --spec is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  const normalized = normalizeTarget(target, opts.allowPrivate === true)
  if ('error' in normalized) throw new Error(`contract-diff: ${normalized.error}`)
  const origin = normalized.origin

  const observer = new Observer({
    ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    delayMs: opts.delayMs ?? (opts.allowPrivate ? 0 : 150),
    allowPrivate: opts.allowPrivate === true,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  })

  // Inject the PUBLISHED spec as the openapi surface evidence — it came from a
  // local file, not the target, so it is never fetched. contractDiff() reads
  // ROLE.openapi and parses this body.
  const specEvidence: Evidence = {
    role: ROLE.openapi,
    url: `${origin}/openapi.json`,
    method: 'GET',
    accept: 'application/json',
    status: 200,
    contentType: 'application/json',
    headers: {},
    body: specText,
    elapsedMs: 0,
  }
  observer.items.push(specEvidence)

  // Live-probe every declared GET-safe operation (bounded, deterministic sorted
  // order). Same SSRF posture as discovery.observeTarget's contract pass.
  let probed = 0
  for (const op of enumerateOperations(doc)) {
    if (!op.probeable) continue
    if (probed >= MAX_CONTRACT_PROBES) break
    const url = `${origin}${op.path}`
    if (!isPubliclyRoutableSameOrigin(url, origin)) continue
    await observer.observe(ROLE.contract('GET', op.path), url, { accept: 'application/json' })
    probed++
  }

  const bundle: EvidenceBundle = {
    target: origin,
    fetchedAt: new Date().toISOString(),
    seed: opts.seed ?? 0,
    items: observer.items,
  }
  return contractDiff(bundle)
}

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

import { Observer, normalizeTarget, type ObserverOpts } from './http.js'
import { observeTarget } from './discovery.js'
import { runChecks } from './checks.js'
import { axScoreOf } from './grade.js'
import { sha256Hex } from './digest.js'
import { validateSchema, readPath } from './schema.js'
import { VERIFIER_VERSION } from './verify.js'
import type { CheckResult, EvidenceBundle, PinnedSpec, Verdict } from './types.js'

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
  allowPrivateTargets?: boolean
}

export function parsePinnedSpec(text: string): PinnedSpec {
  const doc = JSON.parse(text) as PinnedSpec
  if (doc.$type !== 'PinnedSpec' || !Array.isArray(doc.requirements)) {
    throw new Error('not a PinnedSpec: expected {"$type":"PinnedSpec","requirements":[...]}')
  }
  return doc
}

export async function verifyPinnedSpec(
  target: string,
  specText: string,
  opts: VerifyPinnedOpts = {},
): Promise<PinnedReport> {
  const mode = opts.mode ?? 'remote'
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
  // Pinned mode is consent mode: the target is yours, POST probes allowed.
  const observer = new Observer({ ...opts, allowWrites: true, budget: opts.budget ?? 48 })
  const bundle = await observeTarget(origin, observer, seed)

  // Extra observations demanded by the spec's endpoint requirements.
  for (const req of spec.requirements) {
    if (req.kind === 'endpoint') {
      await observer.observe(`pinned:${req.id}`, `${origin}${req.path}`, {
        method: req.method,
        accept: 'application/json',
        body: req.body,
      })
    }
  }
  const fullBundle: EvidenceBundle = { ...bundle, items: observer.items }

  // Judge (pure over the bundle).
  const surfaceChecks = runChecks(fullBundle)
  const axScore = axScoreOf(surfaceChecks)
  const results: CheckResult[] = []

  for (const req of spec.requirements) {
    if (req.kind === 'surface') {
      const idMap = { 'llms.txt': 'llms-txt', 'agents.json': 'agents-json', 'icp.json': 'icp-json', openapi: 'openapi' } as const
      const base = surfaceChecks.find((c) => c.id === idMap[req.surface])
      results.push({
        id: req.id, title: `surface ${req.surface} must be ${req.must}`,
        verdict: base?.verdict === 'pass' ? 'pass' : 'fail',
        detail: base?.detail ?? 'surface not judged', evidence: base?.evidence ?? [],
      })
    } else if (req.kind === 'ax-floor') {
      results.push({
        id: req.id, title: `AX score ≥ ${req.minScore}`,
        verdict: axScore.points >= req.minScore ? 'pass' : 'fail',
        detail: `AX ${axScore.points}/10 (floor ${req.minScore})`, evidence: [],
      })
    } else {
      const ev = fullBundle.items.find((e) => e.role === `pinned:${req.id}`)
      const problems: string[] = []
      if (!ev || ev.status === null) problems.push(`fetch failed (${ev?.error ?? 'not observed'})`)
      else {
        const wanted = req.expect.status === undefined ? [200] : Array.isArray(req.expect.status) ? req.expect.status : [req.expect.status]
        if (!wanted.includes(ev.status)) problems.push(`status ${ev.status}, wanted ${wanted.join('|')}`)
        if (req.expect.contentTypeIncludes && !(ev.contentType ?? '').includes(req.expect.contentTypeIncludes)) {
          problems.push(`content-type ${ev.contentType}, wanted *${req.expect.contentTypeIncludes}*`)
        }
        if (req.expect.schema || req.expect.paths) {
          let body: unknown
          try { body = JSON.parse(ev.body ?? '') } catch { problems.push('body is not JSON') }
          if (body !== undefined) {
            if (req.expect.schema) {
              for (const v of validateSchema(body, req.expect.schema)) problems.push(`${v.path} ${v.message}`)
            }
            for (const p of req.expect.paths ?? []) {
              const r = readPath(body, p.path)
              if (p.exists !== undefined && r.found !== p.exists) problems.push(`path ${p.path} ${p.exists ? 'missing' : 'unexpectedly present'}`)
              if (p.equals !== undefined && (!r.found || JSON.stringify(r.value) !== JSON.stringify(p.equals))) {
                problems.push(`path ${p.path} = ${JSON.stringify(r.found ? r.value : undefined)}, wanted ${JSON.stringify(p.equals)}`)
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
      }
      const verdict: Verdict = problems.length === 0 ? 'pass' : 'fail'
      results.push({
        id: req.id, title: `${req.method} ${req.path}`, verdict,
        detail: verdict === 'pass' ? 'behaved as pinned' : problems.join('; '),
        evidence: [`pinned:${req.id}`],
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

/**
 * The verifier core — one function, three mounts (Worker route, CLI, MCP).
 *
 * observe (network) → derive discovery (pure) → run checks (pure) → grade
 * (pure) → attest (signed only in remote mode with a held-out key).
 */

import { Observer, normalizeTarget, type ObserverOpts } from './http.js'
import { observeTarget, deriveDiscovery } from './discovery.js'
import { runChecks } from './checks.js'
import { axScoreOf, gradeOf } from './grade.js'
import { attestReport } from './attest.js'
import type { VerificationReport } from './types.js'

export const VERIFIER_VERSION = '0.1.0'

export interface VerifyTargetOpts extends ObserverOpts {
  /**
   * 'local' = advisory run against a dev URL (the hill-climb harness);
   * NEVER attested — only the held-out service signs (DESIGN.md attack #6).
   */
  mode?: 'remote' | 'local'
  /** Fresh per run by default; pass to replay a recorded run's probe plan. */
  seed?: number
  /** Held-out signing key. Only honored in remote mode. */
  signingKeys?: CryptoKeyPair
  allowPrivateTargets?: boolean
}

export async function verifyTarget(target: string, opts: VerifyTargetOpts = {}): Promise<VerificationReport> {
  const mode = opts.mode ?? 'remote'
  const allowPrivate = opts.allowPrivateTargets ?? mode === 'local'
  const normalized = normalizeTarget(target, allowPrivate)
  if ('error' in normalized) throw new Error(normalized.error)

  const seed = opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)
  const observer = new Observer(opts)
  const bundle = await observeTarget(normalized.origin, observer, seed)
  const discovery = await deriveDiscovery(bundle)
  const checks = runChecks(bundle)
  const axScore = axScoreOf(checks)
  const { grade, notes } = gradeOf(axScore, checks)

  const report: VerificationReport = {
    $type: 'VerificationReport',
    verifier: 'api.qa',
    verifierVersion: VERIFIER_VERSION,
    mode,
    target: normalized.origin,
    verifiedAt: bundle.fetchedAt,
    seed,
    discovery,
    checks,
    axScore,
    grade,
    gradeNotes: notes,
    evidence: bundle,
    attested: false,
  }

  if (mode === 'remote' && opts.signingKeys) {
    return attestReport(report, opts.signingKeys)
  }
  return report
}

/**
 * Replay: re-judge a report's own evidence bundle. Anyone can do this from
 * the published report — if re-judged verdicts differ from the report's,
 * the report is forged or the verifier version changed.
 */
export async function rejudge(report: VerificationReport): Promise<{ consistent: boolean; grade: string }> {
  const checks = runChecks(report.evidence)
  const axScore = axScoreOf(checks)
  const { grade } = gradeOf(axScore, checks)
  const consistent =
    grade === report.grade &&
    axScore.points === report.axScore.points &&
    JSON.stringify(checks.map((c) => [c.id, c.verdict])) ===
      JSON.stringify(report.checks.map((c) => [c.id, c.verdict]))
  return { consistent, grade }
}

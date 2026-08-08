/**
 * The verifier core — one function, three mounts (Worker route, CLI, MCP).
 *
 * observe (network) → derive discovery (pure) → run checks (pure) → grade
 * (pure) → attest (signed only in remote mode with a held-out key).
 */

import { Observer, normalizeTarget, type ObserverOpts } from './http.js'
import { observeTarget, deriveDiscovery } from './discovery.js'
import type { ExecSuiteRunner } from './exec/dialect.js'
import { runChecks } from './checks.js'
import { axScoreOf, gradeOf } from './grade.js'
import { attestReport } from './attest.js'
import type { VerificationReport } from './types.js'

// 0.2.0: full pinned apis-ax-axp@2.2.0 coverage — machine-legible-home +
// card-interfaces-linked + the four AXP A.7 conneg checks (conneg-accept /
// conneg-client-class / conneg-alternates / conneg-forced-face), appliesWhen
// gating on kind:check AND kind:probe, paramValue.multiplyRange,
// expect.paths[].oneOf, metered-gated probe-manifest demands.
//
// 0.3.0: THE OPTIONAL-DECLARED-INTERFACE MECHANISM. `appliesWhen` becomes a
// two-arm union — the existing observed-value arm plus `cardDeclares`, which
// arms a requirement on the PRESENCE of a named `interfaces.<key>` member of
// the capability card. Skipping is restricted to a frozen, verifier-owned
// registry of ADDITIVE capabilities (optional-interfaces.ts), enforced by
// throwing in validateRequirements before any probe fires, so no
// always-required clause can be opted out of by omission. Not-applicable
// requirement results carry a structured `notApplicable` marker and report as a
// JUnit `<skipped/>`. `digital-link-resolver` is registered, which is what makes
// it pinnable.
//
// ⚠ VERSION ORDERING: a spec carrying `appliesWhen.cardDeclares` reaching a
// verifier OLDER than 0.3.0 sees `aw.fromProbe === undefined`, finds no source
// probe, applies the requirement fail-closed, and therefore fails EVERY
// non-declaring target. That is the correct direction of failure — loud, never
// a silent pass — but it is an outage, and it is why a spec must not pin a
// declaration-armed requirement until 0.3.0 is deployed.
export const VERIFIER_VERSION = '0.3.0'

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
  /**
   * The `api.qa/vitest@1` execution seam (A.8.6). Deployed Worker: the Worker
   * Loader runner, when provisioned. CLI: the shared-harness local runner.
   * Absent: the typed `runner-unavailable` runner — a card declaring the
   * executable dialect fails with the reason named, never a crash or a
   * silent pass.
   */
  execRunner?: ExecSuiteRunner
}

export async function verifyTarget(target: string, opts: VerifyTargetOpts = {}): Promise<VerificationReport> {
  const mode = opts.mode ?? 'remote'
  const allowPrivate = opts.allowPrivateTargets ?? mode === 'local'
  const normalized = normalizeTarget(target, allowPrivate)
  if ('error' in normalized) throw new Error(normalized.error)

  const seed = opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)
  // Consent flows to the observer: only a consented private/local target may be
  // fetched at a private address (the structural SSRF backstop). Same signal
  // normalizeTarget used above — the deployed Worker leaves it false.
  const observer = new Observer({ ...opts, allowPrivate })
  const bundle = await observeTarget(normalized.origin, observer, seed, { execRunner: opts.execRunner })
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

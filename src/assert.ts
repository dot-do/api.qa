/**
 * Runtime-agnostic conformance assertions — no vitest import.
 *
 * `autonomous-qa/assert` runs the same digest-pinned gate as the
 * `autonomous-qa/vitest` matchers, but as plain async functions that THROW on
 * failure. It loads anywhere the verifier core loads: Node, workerd (the
 * Cloudflare Vitest pool externalizes node_modules, so a package that imports
 * `expect` from 'vitest' at module top level fails to link there — this module
 * never does), Deno, Bun, browsers.
 *
 *   import { assertConforms } from 'autonomous-qa/assert'
 *   await assertConforms(worker, spec, { expectedDigest })   // throws on failure
 */
import { grade, gradePinned, type GradeTarget, type GradeOpts, type GradePinnedOpts } from './local.js'
import { gradeRank } from './grade.js'
import type { PinnedReport } from './pinned.js'
import type { Grade, VerificationReport } from './types.js'

/** A spec argument: the pinned-spec TEXT, or `{ spec, expectedDigest }`. */
export type ConformSpec = string | { spec: string; expectedDigest?: string }

export interface ConformanceOutcome {
  pass: boolean
  /** Failure (or negated-success) detail; stable wording shared with the matcher. */
  message: () => string
  /** The pinned report (spec given) or the free-grade report (no spec). */
  report: PinnedReport | VerificationReport
}

export const specText = (spec: ConformSpec): string => (typeof spec === 'string' ? spec : spec.spec)
export const specDigest = (spec: ConformSpec): string | undefined =>
  typeof spec === 'string' ? undefined : spec.expectedDigest

/**
 * Grade `target` and judge conformance.
 *   - WITH a pinned spec → gradePinned(); passes iff every requirement passed.
 *   - WITHOUT a spec     → grade(); passes iff no check actively FAILED.
 */
export async function conformance(
  target: GradeTarget,
  spec?: ConformSpec,
  opts: GradePinnedOpts = {},
): Promise<ConformanceOutcome> {
  if (spec !== undefined) {
    const report = await gradePinned(target, specText(spec), {
      ...opts,
      expectedDigest: specDigest(spec) ?? opts.expectedDigest,
    })
    const failed = report.requirements.filter((r) => r.verdict === 'fail')
    return {
      pass: report.passed,
      report,
      message: () =>
        report.passed
          ? `expected target NOT to conform to pinned spec "${report.spec.name}@${report.spec.version}", but it did`
          : `expected target to conform to pinned spec "${report.spec.name}@${report.spec.version}", but ${failed.length} requirement(s) failed:\n` +
            failed.map((r) => `  ✗ ${r.id}: ${r.detail}`).join('\n'),
    }
  }
  const report = await grade(target, opts)
  const failed = report.checks.filter((c) => c.verdict === 'fail')
  return {
    pass: failed.length === 0,
    report,
    message: () =>
      failed.length === 0
        ? `expected target NOT to conform, but no check failed (grade ${report.grade}, ${report.axScore.points}/${report.axScore.max})`
        : `expected target to conform, but ${failed.length} check(s) failed (grade ${report.grade}):\n` +
          failed.map((c) => `  ✗ ${c.id}: ${c.detail}`).join('\n'),
  }
}

/** Grade `target` and judge it against a minimum grade. */
export async function gradeAtLeast(
  target: GradeTarget,
  minimum: Grade,
  opts: GradeOpts = {},
): Promise<ConformanceOutcome> {
  const report = await grade(target, opts)
  const pass = gradeRank(report.grade) >= gradeRank(minimum)
  return {
    pass,
    report,
    message: () =>
      pass
        ? `expected target NOT to grade at least ${minimum}, but it graded ${report.grade} (${report.axScore.points}/${report.axScore.max})`
        : `expected target to grade at least ${minimum}, but it graded ${report.grade} (${report.axScore.points}/${report.axScore.max})`,
  }
}

/**
 * `await assertConforms(target, spec?, opts?)` — resolves to void, THROWS on a
 * failing conformance check with the full per-requirement detail. Useless
 * un-awaited, which is the point: a missing `await` is visible.
 */
export async function assertConforms(
  target: GradeTarget,
  spec?: ConformSpec,
  opts: GradePinnedOpts = {},
): Promise<void> {
  const result = await conformance(target, spec, opts)
  if (!result.pass) throw new Error(result.message())
}

/** `await assertGradeAtLeast(target, 'B')` — throws when the grade is below the minimum. */
export async function assertGradeAtLeast(
  target: GradeTarget,
  minimum: Grade,
  opts: GradeOpts = {},
): Promise<void> {
  const result = await gradeAtLeast(target, minimum, opts)
  if (!result.pass) throw new Error(result.message())
}

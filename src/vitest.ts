/**
 * The vitest matcher — run api.qa's conformance gate INSIDE a vitest suite,
 * in-process, against a Worker-style handler or a URL:
 *
 *   import 'autonomous-qa/vitest'            // registers the matchers (side-effect)
 *   import worker from '../src/worker.js'
 *   import spec from '../spec/pinned.json?raw'
 *
 *   it('conforms to the pinned contract', async () => {
 *     await expect(worker).toConform(spec)   // gradePinned() must pass
 *   })
 *   it('grades at least B', async () => {
 *     await expect(worker).toGradeAtLeast('B')
 *   })
 *
 * Both matchers are ASYNC — `await` the assertion. They dispatch every probe to
 * the handler IN MEMORY (no socket), so the gate the deployed api.qa runs
 * against your PUBLIC origin also runs against your worker pre-deploy.
 *
 * SSRF: these matchers grade a handler in-memory (`allowPrivate` stays false) or
 * a URL you explicitly pass with `{ allowPrivate: true }` for a local dev
 * server. A remote URL target is graded exactly as the deployed grader would —
 * private/metadata hosts stay blocked. See src/local.ts.
 */

import { expect } from 'vitest'
import { grade, gradePinned, type GradeTarget, type GradeOpts, type GradePinnedOpts } from './local.js'
import { gradeRank } from './grade.js'
import type { Grade } from './types.js'

/** A spec argument: the pinned-spec TEXT, or `{ spec, expectedDigest }`. */
export type ConformSpec = string | { spec: string; expectedDigest?: string }

interface MatcherResult {
  pass: boolean
  message: () => string
}

function specText(spec: ConformSpec): string {
  return typeof spec === 'string' ? spec : spec.spec
}

function specDigest(spec: ConformSpec): string | undefined {
  return typeof spec === 'string' ? undefined : spec.expectedDigest
}

/**
 * `expect(target).toConform(spec?)`.
 *   - WITH a pinned spec → gradePinned(); passes iff every requirement passed.
 *   - WITHOUT a spec     → grade(); passes iff no check actively FAILED (the
 *     surface never lies/violates). Use `toGradeAtLeast` for a threshold.
 */
async function toConform(
  received: GradeTarget,
  spec?: ConformSpec,
  opts: GradePinnedOpts = {},
): Promise<MatcherResult> {
  if (spec !== undefined) {
    const report = await gradePinned(received, specText(spec), {
      ...opts,
      expectedDigest: specDigest(spec) ?? opts.expectedDigest,
    })
    const failed = report.requirements.filter((r) => r.verdict === 'fail')
    return {
      pass: report.passed,
      message: () =>
        report.passed
          ? `expected target NOT to conform to pinned spec "${report.spec.name}@${report.spec.version}", but it did`
          : `expected target to conform to pinned spec "${report.spec.name}@${report.spec.version}", but ${failed.length} requirement(s) failed:\n` +
            failed.map((r) => `  ✗ ${r.id}: ${r.detail}`).join('\n'),
    }
  }
  const report = await grade(received, opts)
  const failed = report.checks.filter((c) => c.verdict === 'fail')
  return {
    pass: failed.length === 0,
    message: () =>
      failed.length === 0
        ? `expected target NOT to conform, but no check failed (grade ${report.grade}, ${report.axScore.points}/${report.axScore.max})`
        : `expected target to conform, but ${failed.length} check(s) failed (grade ${report.grade}):\n` +
          failed.map((c) => `  ✗ ${c.id}: ${c.detail}`).join('\n'),
  }
}

/** `expect(target).toGradeAtLeast('B')` — passes iff grade >= the given grade. */
async function toGradeAtLeast(
  received: GradeTarget,
  minimum: Grade,
  opts: GradeOpts = {},
): Promise<MatcherResult> {
  const report = await grade(received, opts)
  const got = gradeRank(report.grade)
  const want = gradeRank(minimum)
  const pass = got >= want
  return {
    pass,
    message: () =>
      pass
        ? `expected target NOT to grade at least ${minimum}, but it graded ${report.grade} (${report.axScore.points}/${report.axScore.max})`
        : `expected target to grade at least ${minimum}, but it graded ${report.grade} (${report.axScore.points}/${report.axScore.max})`,
  }
}

expect.extend({ toConform, toGradeAtLeast })

// --- TS augmentation so `.toConform` / `.toGradeAtLeast` type-check ----------
interface ApiQaMatchers<R = unknown> {
  toConform(spec?: ConformSpec, opts?: GradePinnedOpts): Promise<R>
  toGradeAtLeast(minimum: Grade, opts?: GradeOpts): Promise<R>
}

declare module 'vitest' {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
  interface Assertion<T = any> extends ApiQaMatchers<T> {}
  interface AsymmetricMatchersContaining extends ApiQaMatchers {}
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
}

export {}
